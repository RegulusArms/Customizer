(function () {
// Layer editor for the keychain customizer: image / text / shape layers on a 2D artboard,
// with move / resize / stretch / rotate handles, undo history, background removal and
// project (de)serialization. It knows nothing about 3D — app.js asks it for a flattened
// composite (renderComposite) and feeds that to the die-cut sticker pipeline.
const { showInfo } = window.KCModal;

const $ = id => document.getElementById(id);

const BASE_FONT_SIZE = 80;
const LINE_HEIGHT = 1.2;
const MIN_SCALE_FACTOR = 0.03;
const HANDLE_HIT_PX = 11;
const ROTATE_HANDLE_OFFSET_PX = 32;

// Built-in fonts come from Google Fonts (see <link> in keychain.html) so they render the
// same everywhere, unlike named OS fonts which silently fall back when not installed.
const BUILTIN_FONTS = [
  { value: `"Roboto", Arial, sans-serif`, label: 'Roboto' },
  { value: `"Montserrat", Arial, sans-serif`, label: 'Montserrat' },
  { value: `"Oswald", Impact, sans-serif`, label: 'Oswald (Condensed)' },
  { value: `"Bebas Neue", Impact, sans-serif`, label: 'Bebas Neue (Bold Display)' },
  { value: `"Anton", Impact, sans-serif`, label: 'Anton (Heavy Display)' },
  { value: `"Playfair Display", Georgia, serif`, label: 'Playfair Display' },
  { value: `"Merriweather", Georgia, serif`, label: 'Merriweather' },
  { value: `"Cinzel", Georgia, serif`, label: 'Cinzel (Engraved)' },
  { value: `"Roboto Mono", "Courier New", monospace`, label: 'Roboto Mono' },
  { value: `"Dancing Script", cursive`, label: 'Dancing Script (Script)' },
  { value: `"Pacifico", cursive`, label: 'Pacifico (Casual Script)' },
];

// default local (unscaled) bounding box for a freshly-added shape of each kind
const SHAPE_DEFAULTS = {
  star: { w: 200, h: 200 },
  rectangle: { w: 240, h: 160 },
  square: { w: 180, h: 180 },
  ellipse: { w: 240, h: 160 },
  circle: { w: 180, h: 180 },
  line: { w: 240, h: 24 },
};
const IMAGE_FIT_SIZE = 500; // longest edge (world units) of a newly added image
const TEXT_FIT = 2.5;
const SHAPE_FIT = 1.5;

const DEFAULT_HISTORY_LIMIT = 50;
const HISTORY_LIMIT_KEY = 'gripCustomizerHistoryLimit';

// --- color helpers ---------------------------------------------------------
function cmykToHex(c, m, y, k) {
  c /= 100; m /= 100; y /= 100; k /= 100;
  const ch = v => Math.max(0, Math.min(255, Math.round(255 * v * (1 - k)))).toString(16).padStart(2, '0');
  return '#' + ch(1 - c) + ch(1 - m) + ch(1 - y);
}

function hexToCmyk(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const pct = v => Math.round(v * 100);
  return { c: pct((1 - r - k) / (1 - k)), m: pct((1 - g - k) / (1 - k)), y: pct((1 - b - k) / (1 - k)), k: pct(k) };
}

const layerHex = l => cmykToHex(l.color.c, l.color.m, l.color.y, l.color.k);
const isColorable = l => !!l && (l.type === 'text' || l.type === 'shape');
const cloneLayer = l => ({ ...l, color: l.color ? { ...l.color } : undefined });

// --- state ------------------------------------------------------------------
let layers = [];
let selectedId = null;
let idCounter = 0;
let assetCounter = 0;
let customFontCounter = 0;
let showGuide = true;
let onChange = () => {};
let onImagesDropped = () => {};

const assets = new Map();   // key -> { key, dataURL, img, name }
const customFonts = [];     // { family, value, label, dataURL, fileName }
const pendingFonts = new Set();

const view = { zoom: 1, tx: 0, ty: 0 };
const MIN_VIEW_ZOOM = 0.05, MAX_VIEW_ZOOM = 12;

// --- DOM ---------------------------------------------------------------------
const stageContainer = $('stageContainer');
const canvas = $('stage');
const ctx = canvas.getContext('2d', { willReadFrequently: false });

const layerListEl = $('layerList');
const removeLayerBtn = $('removeLayerBtn');
const imageFieldsGroup = $('imageFieldsGroup');
const removeBgBtn = $('removeBgBtn');
const restoreOriginalBtn = $('restoreOriginalBtn');
const removeBgStatus = $('removeBgStatus');
const zoomRange = $('zoomRange'), zoomLabel = $('zoomLabel');
const rotRange = $('rotRange'), rotLabel = $('rotLabel');
const opacityRange = $('opacityRange'), opacityLabel = $('opacityLabel');
const shapeFieldsGroup = $('shapeFieldsGroup');
const shapeKindSelect = $('shapeKindSelect');
const shapeFilledRow = $('shapeFilledRow');
const shapeFilledCheckbox = $('shapeFilledCheckbox');
const shapeStrokeWidthField = $('shapeStrokeWidthField');
const shapeStrokeWidthRange = $('shapeStrokeWidthRange');
const shapeStrokeWidthLabel = $('shapeStrokeWidthLabel');
const colorFieldsGroup = $('colorFieldsGroup');
const colorPicker = $('colorPicker');
const colorSwatch = $('colorSwatch');
const cmykReadout = $('cmykReadout');
const cmykInputs = { c: $('cmykCInput'), m: $('cmykMInput'), y: $('cmykYInput'), k: $('cmykKInput') };
const colorDropperBtn = $('colorDropperBtn');
const textFieldsGroup = $('textFieldsGroup');
const textContentInput = $('textContentInput');
const fontSelect = $('fontSelect');
const builtinFontGroup = $('builtinFontGroup');
const customFontGroup = $('customFontGroup');
const fontFileInput = $('fontFileInput');
const historyListEl = $('historyList');
const historyLimitInput = $('historyLimitInput');

const getSelected = () => layers.find(l => l.id === selectedId) || null;
const layerLabel = l => {
  if (!l) return 'layer';
  if (l.type === 'text') return `"${(l.text || 'Text').split('\n')[0].slice(0, 20)}"`;
  if (l.type === 'shape') return l.shapeKind;
  return l.name || 'image';
};

// --- assets (image data kept out of layer objects so history snapshots stay tiny) ------
function loadImageElement(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode that image.'));
    img.src = dataURL;
  });
}

async function registerAsset(dataURL, name) {
  const img = await loadImageElement(dataURL);
  const key = `a${++assetCounter}`;
  const asset = { key, dataURL, img, name };
  assets.set(key, asset);
  return asset;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Couldn't read ${file.name || 'that file'}.`));
    r.readAsDataURL(file);
  });
}

// --- fonts -------------------------------------------------------------------
function ensureFont(family) {
  const p = document.fonts.load(`${BASE_FONT_SIZE}px ${family}`).then(() => {
    let changed = false;
    for (const l of layers) {
      if (l.type === 'text' && l.fontFamily === family) { measureText(l); changed = true; }
    }
    if (changed) { requestDraw(); onChange(); }
  }).catch(() => {}).finally(() => pendingFonts.delete(p));
  pendingFonts.add(p);
  return p;
}

const scratch = document.createElement('canvas').getContext('2d');
function textLines(l) { return (l.text || '').split('\n'); }
function measureText(l) {
  scratch.font = `${BASE_FONT_SIZE}px ${l.fontFamily}`;
  let w = 0;
  const lines = textLines(l);
  for (const line of lines) w = Math.max(w, scratch.measureText(line).width);
  l.nw = Math.max(8, w);
  l.nh = Math.max(BASE_FONT_SIZE * LINE_HEIGHT, lines.length * BASE_FONT_SIZE * LINE_HEIGHT);
}

function addFontOption(family, label) {
  const opt = document.createElement('option');
  opt.value = family;
  opt.textContent = label;
  customFontGroup.appendChild(opt);
}

async function registerCustomFont(fileName, dataURL, familyOverride, labelOverride) {
  const baseName = (fileName || 'CustomFont').replace(/\.[^.]+$/, '');
  const family = familyOverride || `UserFont${++customFontCounter}-${baseName.replace(/[^a-z0-9]+/gi, '').slice(0, 24)}`;
  const face = new FontFace(family, `url(${dataURL})`);
  await face.load();
  document.fonts.add(face);
  const value = `"${family}", sans-serif`;
  const label = labelOverride || `${baseName} (custom)`;
  customFonts.push({ family, value, label, dataURL, fileName });
  addFontOption(value, label);
  return value;
}

// --- layer factories -----------------------------------------------------------------
function newBase(type, fit) {
  return {
    id: ++idCounter, type, visible: true, opacity: 100,
    cx: 0, cy: 0, sx: fit, sy: fit, rot: 0, flipX: false, flipY: false, fit,
  };
}

function addLayer(layer, desc) {
  layers.push(layer);
  selectedId = layer.id;
  refreshAll();
  record(desc || `Added layer ${layerLabel(layer)}`);
}

async function addImageFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => f.type && f.type.startsWith('image/'));
  for (const file of files) {
    try {
      const dataURL = await readFileAsDataURL(file);
      const asset = await registerAsset(dataURL, file.name);
      const nw = asset.img.naturalWidth, nh = asset.img.naturalHeight;
      if (!nw || !nh) throw new Error('That image has no dimensions.');
      const fit = IMAGE_FIT_SIZE / Math.max(nw, nh);
      const layer = { ...newBase('image', fit), name: file.name, assetKey: asset.key, nw, nh };
      addLayer(layer);
      if (layers.length === 1) fitView();
    } catch (err) {
      showInfo(err.message || 'Could not add that image.');
    }
  }
}

function addTextLayer() {
  const layer = {
    ...newBase('text', TEXT_FIT),
    text: 'Your Text', fontFamily: BUILTIN_FONTS[0].value, color: { c: 0, m: 0, y: 0, k: 100 },
  };
  measureText(layer);
  ensureFont(layer.fontFamily);
  addLayer(layer);
  if (layers.length === 1) fitView();
  textContentInput.focus();
  textContentInput.select();
}

function addShapeLayer(kind) {
  const dims = SHAPE_DEFAULTS[kind] || SHAPE_DEFAULTS.rectangle;
  const layer = {
    ...newBase('shape', SHAPE_FIT),
    shapeKind: kind, filled: true, strokeWidth: 6, color: { c: 0, m: 0, y: 0, k: 100 },
    nw: dims.w, nh: kind === 'line' ? 6 : dims.h,
  };
  addLayer(layer);
  if (layers.length === 1) fitView();
}

function removeLayer(id) {
  const idx = layers.findIndex(l => l.id === id);
  if (idx === -1) return;
  const removed = layers[idx];
  layers.splice(idx, 1);
  if (selectedId === id) selectedId = layers.length ? layers[Math.min(idx, layers.length - 1)].id : null;
  refreshAll();
  record(`Removed layer ${layerLabel(removed)}`);
}

// --- geometry ------------------------------------------------------------------------
function layerCorners(l) {
  const hw = l.nw * l.sx / 2, hh = l.nh * l.sy / 2;
  const r = l.rot * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: l.cx + x * cos - y * sin, y: l.cy + x * sin + y * cos,
  }));
}

function isDrawable(l) {
  if (l.visible === false) return false;
  if (l.type === 'image') { const a = assets.get(l.assetKey); return !!(a && a.img); }
  if (l.type === 'text') return (l.text || '').trim().length > 0;
  return true;
}

function layersBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of layers) {
    if (!isDrawable(l)) continue;
    for (const p of layerCorners(l)) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function hitTest(wx, wy, pad) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!isDrawable(l)) continue;
    const r = l.rot * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    const dx = wx - l.cx, dy = wy - l.cy;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    if (Math.abs(lx) <= l.nw * l.sx / 2 + pad && Math.abs(ly) <= l.nh * l.sy / 2 + pad) return l;
  }
  return null;
}

// --- drawing ---------------------------------------------------------------------------
function starPoints(hw, hh) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const rad = i % 2 === 0 ? 1 : 0.4;
    pts.push([Math.cos(a) * rad, Math.sin(a) * rad]);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return pts.map(([x, y]) => [
    ((x - minX) / (maxX - minX) - 0.5) * 2 * hw,
    ((y - minY) / (maxY - minY) - 0.5) * 2 * hh,
  ]);
}

function drawLayer(c, l) {
  if (!isDrawable(l)) return;
  c.save();
  c.globalAlpha = Math.max(0, Math.min(1, l.opacity / 100));
  c.translate(l.cx, l.cy);
  c.rotate(l.rot * Math.PI / 180);
  c.scale(l.sx * (l.flipX ? -1 : 1), l.sy * (l.flipY ? -1 : 1));
  const hw = l.nw / 2, hh = l.nh / 2;

  if (l.type === 'image') {
    c.drawImage(assets.get(l.assetKey).img, -hw, -hh, l.nw, l.nh);
  } else if (l.type === 'text') {
    c.font = `${BASE_FONT_SIZE}px ${l.fontFamily}`;
    c.fillStyle = layerHex(l);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const lh = BASE_FONT_SIZE * LINE_HEIGHT;
    textLines(l).forEach((line, i) => c.fillText(line, 0, -hh + (i + 0.5) * lh));
  } else if (l.type === 'shape') {
    const color = layerHex(l);
    const kind = l.shapeKind;
    const filled = kind === 'line' || l.filled;
    const sw = l.strokeWidth;
    c.fillStyle = color;
    c.strokeStyle = color;
    c.lineWidth = sw;
    c.lineJoin = 'round';
    const inset = filled ? 0 : sw / 2;
    if (kind === 'line') {
      c.fillRect(-hw, -hh, l.nw, l.nh);
    } else if (kind === 'ellipse' || kind === 'circle') {
      c.beginPath();
      c.ellipse(0, 0, Math.max(0.1, hw - inset), Math.max(0.1, hh - inset), 0, 0, Math.PI * 2);
      filled ? c.fill() : c.stroke();
    } else if (kind === 'star') {
      const pts = starPoints(Math.max(0.1, hw - inset), Math.max(0.1, hh - inset));
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      filled ? c.fill() : c.stroke();
    } else {
      const w = Math.max(0.1, l.nw - inset * 2), h = Math.max(0.1, l.nh - inset * 2);
      filled ? c.fillRect(-hw, -hh, l.nw, l.nh) : c.strokeRect(-w / 2, -h / 2, w, h);
    }
  }
  c.restore();
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

const toScreen = (x, y) => ({ x: x * view.zoom + view.tx, y: y * view.zoom + view.ty });
const toWorld = (sx, sy) => ({ x: (sx - view.tx) / view.zoom, y: (sy - view.ty) / view.zoom });

let dpr = 1;
function draw() {
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.tx, dpr * view.ty);
  for (const l of layers) drawLayer(ctx, l);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const b = layersBounds();
  if (showGuide && b) {
    const a = toScreen(b.minX, b.minY), z = toScreen(b.maxX, b.maxY);
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
    ctx.strokeRect(a.x, a.y, z.x - a.x, z.y - a.y);
    ctx.restore();
  }
  if (!layers.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#888';
    ctx.font = '14px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Drop an image here or use "+ Add image", "+ Add text", or a shape.', w / 2, h / 2);
  }
  drawHandles();
}

// handles: [{ id, hx, hy }] where hx/hy in {-1,0,1} pick a corner/edge of the selection box
const HANDLE_DEFS = [
  { id: 'tl', hx: -1, hy: -1 }, { id: 'tr', hx: 1, hy: -1 }, { id: 'br', hx: 1, hy: 1 }, { id: 'bl', hx: -1, hy: 1 },
  { id: 'top', hx: 0, hy: -1 }, { id: 'bottom', hx: 0, hy: 1 }, { id: 'left', hx: -1, hy: 0 }, { id: 'right', hx: 1, hy: 0 },
];

function handlePositions(l) {
  const hw = l.nw * l.sx / 2, hh = l.nh * l.sy / 2;
  const r = l.rot * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const screenPt = (lx, ly) => toScreen(l.cx + lx * cos - ly * sin, l.cy + lx * sin + ly * cos);
  const out = HANDLE_DEFS.map(d => ({ ...d, s: screenPt(d.hx * hw, d.hy * hh) }));
  // rotate handle sits a fixed screen distance beyond the top edge, along the layer's up axis
  const tc = screenPt(0, -hh);
  out.push({ id: 'rotate', s: { x: tc.x + Math.sin(r) * ROTATE_HANDLE_OFFSET_PX, y: tc.y - Math.cos(r) * ROTATE_HANDLE_OFFSET_PX }, tc });
  return out;
}

function drawHandles() {
  const l = getSelected();
  if (!l || !isDrawable(l) || samplingColor) return;
  const hs = handlePositions(l);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  const corners = layerCorners(l).map(p => toScreen(p.x, p.y));
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  const rot = hs.find(h => h.id === 'rotate');
  ctx.beginPath();
  ctx.moveTo(rot.tc.x, rot.tc.y);
  ctx.lineTo(rot.s.x, rot.s.y);
  ctx.stroke();
  for (const h of hs) {
    ctx.beginPath();
    const corner = h.id.length === 2;
    ctx.arc(h.s.x, h.s.y, h.id === 'rotate' ? 8 : 7, 0, Math.PI * 2);
    ctx.fillStyle = corner ? '#fff' : accent;
    ctx.strokeStyle = corner ? accent : '#fff';
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function hitHandle(sx, sy) {
  const l = getSelected();
  if (!l || !isDrawable(l)) return null;
  const hs = handlePositions(l);
  // rotate handle first so it wins when it overlaps a small layer's edge handles
  hs.sort((a, b) => (a.id === 'rotate' ? -1 : b.id === 'rotate' ? 1 : 0));
  for (const h of hs) {
    if (Math.hypot(sx - h.s.x, sy - h.s.y) <= HANDLE_HIT_PX) return h;
  }
  return null;
}

const CURSORS = {
  tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize',
  top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize', rotate: 'grab',
};

// --- pointer interaction ---------------------------------------------------------------
let drag = null;
let samplingColor = false;

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function resizeDrag(l, start, p, hx, hy) {
  const rad = start.rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = p.x - start.cx, dy = p.y - start.cy;
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
  const hw = start.nw * start.sx / 2, hh = start.nh * start.sy / 2;
  const ax = -hx * hw, ay = -hy * hh; // the opposite corner/edge stays pinned
  let kx = 1, ky = 1;
  if (hx !== 0 && hy !== 0) {
    const vx = hx * hw - ax, vy = hy * hh - ay;
    const den = vx * vx + vy * vy;
    if (den < 1e-9) return;
    kx = ky = ((lx - ax) * vx + (ly - ay) * vy) / den;
  } else if (hx !== 0) {
    const den = hx * hw - ax;
    if (Math.abs(den) < 1e-9) return;
    kx = (lx - ax) / den;
  } else {
    const den = hy * hh - ay;
    if (Math.abs(den) < 1e-9) return;
    ky = (ly - ay) / den;
  }
  kx = Math.max(MIN_SCALE_FACTOR, kx);
  ky = Math.max(MIN_SCALE_FACTOR, ky);
  const ox = ax * (1 - kx), oy = ay * (1 - ky);
  l.sx = start.sx * kx;
  l.sy = start.sy * ky;
  l.cx = start.cx + ox * cos - oy * sin;
  l.cy = start.cy + ox * sin + oy * cos;
}

canvas.addEventListener('pointerdown', e => {
  const sp = canvasPoint(e);
  if (samplingColor) {
    if (e.button === 0) { e.preventDefault(); commitSample(sp); }
    return;
  }
  canvas.setPointerCapture(e.pointerId);

  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    drag = { kind: 'pan', lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;

  const handle = hitHandle(sp.x, sp.y);
  const l = getSelected();
  if (handle && l) {
    drag = {
      kind: handle.id === 'rotate' ? 'rotate' : 'resize', handle, pointerId: e.pointerId, moved: false,
      start: { cx: l.cx, cy: l.cy, sx: l.sx, sy: l.sy, rot: l.rot, nw: l.nw, nh: l.nh },
      desc: handle.id === 'rotate' ? 'Rotated' : 'Resized',
    };
    return;
  }

  const wp = toWorld(sp.x, sp.y);
  const hit = hitTest(wp.x, wp.y, 4 / view.zoom);
  if (hit) {
    if (hit.id !== selectedId) { selectedId = hit.id; syncAll(); }
    drag = { kind: 'move', pointerId: e.pointerId, wp, start: { cx: hit.cx, cy: hit.cy }, moved: false };
  } else {
    // empty space: deselect, and let a drag pan the workspace
    if (selectedId !== null) { selectedId = null; syncAll(); }
    drag = { kind: 'pan', lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId };
    canvas.style.cursor = 'grabbing';
  }
});

canvas.addEventListener('pointermove', e => {
  const sp = canvasPoint(e);
  if (samplingColor) { previewSample(sp); return; }

  if (!drag) {
    const h = hitHandle(sp.x, sp.y);
    if (h) canvas.style.cursor = CURSORS[h.id];
    else {
      const wp = toWorld(sp.x, sp.y);
      canvas.style.cursor = hitTest(wp.x, wp.y, 4 / view.zoom) ? 'move' : 'default';
    }
    return;
  }
  if (e.pointerId !== drag.pointerId) return;

  if (drag.kind === 'pan') {
    view.tx += e.clientX - drag.lastX;
    view.ty += e.clientY - drag.lastY;
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    requestDraw();
    return;
  }

  const l = getSelected();
  if (!l) return;
  const wp = toWorld(sp.x, sp.y);
  drag.moved = true;
  if (drag.kind === 'move') {
    l.cx = drag.start.cx + (wp.x - drag.wp.x);
    l.cy = drag.start.cy + (wp.y - drag.wp.y);
    drag.desc = 'Moved';
  } else if (drag.kind === 'rotate') {
    let deg = Math.atan2(wp.y - l.cy, wp.x - l.cx) * 180 / Math.PI + 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    l.rot = normalizeDeg(deg);
  } else if (drag.kind === 'resize') {
    resizeDrag(l, drag.start, wp, drag.handle.hx, drag.handle.hy);
  }
  syncTransformControls();
  requestDraw();
  onChange(true);
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const finished = drag;
  drag = null;
  canvas.style.cursor = 'default';
  if (finished.kind !== 'pan' && finished.moved) {
    const l = getSelected();
    record(`${finished.desc || 'Moved'} layer ${layerLabel(l)}`);
    renderLayerList();
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const l = getSelected();
  if (e.shiftKey && l) {
    l.rot = normalizeDeg(l.rot + (e.deltaY > 0 ? 5 : -5));
    syncTransformControls();
    requestDraw();
    onChange(true);
    debouncedRecord(`Rotated layer ${layerLabel(l)}`);
    return;
  }
  const sp = canvasPoint(e);
  zoomViewAt(sp.x, sp.y, e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

function zoomViewAt(px, py, factor) {
  const next = Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, view.zoom * factor));
  const f = next / view.zoom;
  view.tx = px - (px - view.tx) * f;
  view.ty = py - (py - view.ty) * f;
  view.zoom = next;
  requestDraw();
}

function normalizeDeg(d) {
  d = ((d + 180) % 360 + 360) % 360 - 180;
  return d === -180 ? 180 : d;
}

let recordTimer = null;
function debouncedRecord(desc) {
  clearTimeout(recordTimer);
  recordTimer = setTimeout(() => record(desc), 400);
}

// drop images anywhere over the center area (either tab). Handles real files, and images
// dragged out of a web page (which arrive as a URL / <img> markup rather than a file).
const dropZone = document.querySelector('.stage-wrap');
let dragDepth = 0;
const hasDroppable = dt => !!dt && Array.from(dt.types || []).some(t => ['Files', 'text/uri-list', 'text/html'].includes(t));
const setDropHighlight = on => dropZone.querySelectorAll('.stage-container').forEach(c => c.classList.toggle('dragover', on));

dropZone.addEventListener('dragenter', e => {
  if (!hasDroppable(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth++;
  setDropHighlight(true);
});
dropZone.addEventListener('dragover', e => {
  if (!hasDroppable(e.dataTransfer)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDropHighlight(false);
});
dropZone.addEventListener('drop', async e => {
  if (!hasDroppable(e.dataTransfer)) return;
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  setDropHighlight(false);
  onImagesDropped();
  const dt = e.dataTransfer;
  const files = Array.from(dt.files || []).filter(f => (f.type && f.type.startsWith('image/')) || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.name));
  if (files.length) { addImageFiles(files); return; }
  // dragged from another page: pull an image URL out of the drag data
  let url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find(l => l && !l.startsWith('#'));
  if (!url) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(dt.getData('text/html') || '');
    if (m) url = m[1];
  }
  if (!url) { showInfo("That drop didn't contain an image file."); return; }
  try {
    const blob = await (await fetch(url)).blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    addImageFiles([new File([blob], decodeURIComponent(url.split('/').pop().split('?')[0]) || 'image', { type: blob.type })]);
  } catch (err) {
    showInfo("Couldn't read that image from the other page (the site may block it). Save the image to your computer and drop the file instead.");
  }
});

// --- view fitting / canvas sizing ------------------------------------------------------------
function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stageContainer.clientWidth, h = stageContainer.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  requestDraw();
}
new ResizeObserver(resizeCanvas).observe(stageContainer);

function fitView() {
  const w = stageContainer.clientWidth || 800, h = stageContainer.clientHeight || 600;
  const b = layersBounds() || { minX: -300, maxX: 300, minY: -300, maxY: 300 };
  const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
  const pad = 70;
  view.zoom = Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
  view.tx = w / 2 - ((b.minX + b.maxX) / 2) * view.zoom;
  view.ty = h / 2 - ((b.minY + b.maxY) / 2) * view.zoom;
  requestDraw();
}

// --- color dropper -------------------------------------------------------------------------------
const sampleCtx = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.getContext('2d', { willReadFrequently: true });
})();

function sampleWorldPoint(wx, wy) {
  sampleCtx.setTransform(1, 0, 0, 1, 0, 0);
  sampleCtx.clearRect(0, 0, 1, 1);
  sampleCtx.setTransform(1, 0, 0, 1, -wx, -wy);
  for (const l of layers) drawLayer(sampleCtx, l);
  const d = sampleCtx.getImageData(0, 0, 1, 1).data;
  return d[3] < 8 ? null : '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
}

let samplingBackup = null;
function startSampling() {
  const l = getSelected();
  if (!isColorable(l)) return;
  samplingColor = true;
  samplingBackup = { ...l.color };
  colorDropperBtn.classList.add('active');
  canvas.style.cursor = 'crosshair';
  requestDraw();
}
function exitSampling(restore) {
  samplingColor = false;
  colorDropperBtn.classList.remove('active');
  canvas.style.cursor = 'default';
  const l = getSelected();
  if (restore && l && samplingBackup) l.color = samplingBackup;
  samplingBackup = null;
  syncColorControls();
  requestDraw();
}
function previewSample(sp) {
  const l = getSelected();
  const wp = toWorld(sp.x, sp.y);
  const hex = sampleWorldPoint(wp.x, wp.y);
  if (hex && l) {
    colorSwatch.style.background = hex;
  }
}
function commitSample(sp) {
  const l = getSelected();
  const wp = toWorld(sp.x, sp.y);
  const hex = sampleWorldPoint(wp.x, wp.y);
  if (hex && l) {
    l.color = hexToCmyk(hex);
    samplingBackup = null;
    exitSampling(false);
    requestDraw();
    onChange();
    record(`Changed color of layer ${layerLabel(l)}`);
  } else {
    exitSampling(true);
  }
}
colorDropperBtn.addEventListener('click', () => (samplingColor ? exitSampling(true) : startSampling()));

// --- history --------------------------------------------------------------------------------------
let history = [];
let historyIndex = -1;
let historyLimit = DEFAULT_HISTORY_LIMIT;
try {
  const saved = parseInt(localStorage.getItem(HISTORY_LIMIT_KEY), 10);
  if (Number.isFinite(saved) && saved >= -1) historyLimit = saved;
} catch (e) { /* ignore */ }
historyLimitInput.value = historyLimit;

const snapshot = () => ({ layers: layers.map(cloneLayer), selectedId });
const stateKey = s => JSON.stringify(s.layers);

function record(desc) {
  const s = snapshot();
  const key = stateKey(s);
  if (historyIndex >= 0 && history[historyIndex].key === key) return;
  history = history.slice(0, historyIndex + 1);
  history.push({ desc, state: s, key });
  historyIndex = history.length - 1;
  applyHistoryLimit();
  renderHistory();
  onChange();
}

function applyHistoryLimit() {
  if (historyLimit < 0) return;
  const maxEntries = historyLimit + 1; // N undo steps = N+1 states
  if (history.length > maxEntries) {
    const drop = history.length - maxEntries;
    history = history.slice(drop);
    historyIndex = Math.max(0, historyIndex - drop);
  }
}

function restoreHistory(i) {
  if (i < 0 || i >= history.length) return;
  historyIndex = i;
  layers = history[i].state.layers.map(cloneLayer);
  selectedId = layers.some(l => l.id === history[i].state.selectedId) ? history[i].state.selectedId : null;
  for (const l of layers) if (l.type === 'text') ensureFont(l.fontFamily);
  refreshAll();
  renderHistory();
  onChange();
}

function undo() {
  if (historyIndex > 0) restoreHistory(historyIndex - 1);
}

function resetHistory(desc) {
  history = [];
  historyIndex = -1;
  record(desc);
}

function renderHistory() {
  historyListEl.innerHTML = '';
  history.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'history-item' + (i === historyIndex ? ' current' : i > historyIndex ? ' future' : '');
    li.textContent = entry.desc;
    li.title = entry.desc;
    li.addEventListener('click', () => restoreHistory(i));
    historyListEl.appendChild(li);
  });
  // scroll only the list itself (scrollIntoView would also scroll the whole side panel)
  const current = historyListEl.querySelector('.current');
  if (current) {
    const top = current.offsetTop, bottom = top + current.offsetHeight;
    if (top < historyListEl.scrollTop) historyListEl.scrollTop = top;
    else if (bottom > historyListEl.scrollTop + historyListEl.clientHeight) historyListEl.scrollTop = bottom - historyListEl.clientHeight;
  }
}

historyLimitInput.addEventListener('change', () => {
  let v = parseInt(historyLimitInput.value, 10);
  if (!Number.isFinite(v) || v < -1) v = DEFAULT_HISTORY_LIMIT;
  historyLimit = v;
  historyLimitInput.value = v;
  try { localStorage.setItem(HISTORY_LIMIT_KEY, String(v)); } catch (e) { /* ignore */ }
  applyHistoryLimit();
  renderHistory();
});

// --- layer list ---------------------------------------------------------------------------------------
let dragSrcLi = null;
function renderLayerList() {
  layerListEl.innerHTML = '';
  if (!layers.length) {
    const empty = document.createElement('div');
    empty.className = 'layer-empty';
    empty.textContent = 'No layers yet — add an image, text or shape.';
    layerListEl.appendChild(empty);
    return;
  }
  layers.slice().reverse().forEach(layer => {
    const li = document.createElement('li');
    li.className = 'layer-item' + (layer.id === selectedId ? ' active' : '') + (layer.visible === false ? ' hidden-layer' : '');
    li.draggable = true;
    li.dataset.id = String(layer.id);

    const grip = document.createElement('span');
    grip.className = 'layer-drag-handle';
    grip.textContent = '⠿';
    li.appendChild(grip);

    const name = document.createElement('span');
    name.className = 'layer-name';
    const icon = layer.type === 'text' ? '🔤 ' : layer.type === 'shape' ? '🔷 ' : '';
    name.textContent = icon + (layer.type === 'shape' ? layer.shapeKind.charAt(0).toUpperCase() + layer.shapeKind.slice(1) : layerLabel(layer).replace(/^"|"$/g, ''));
    li.appendChild(name);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'layer-icon-btn';
    eye.title = layer.visible === false ? 'Show layer' : 'Hide layer';
    eye.textContent = layer.visible === false ? '🚫' : '👁';
    eye.addEventListener('click', e => {
      e.stopPropagation();
      layer.visible = layer.visible === false;
      renderLayerList();
      requestDraw();
      record(`${layer.visible ? 'Showed' : 'Hid'} layer ${layerLabel(layer)}`);
    });
    li.appendChild(eye);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'layer-icon-btn remove';
    rm.title = 'Remove layer';
    rm.textContent = '×';
    rm.addEventListener('click', e => { e.stopPropagation(); removeLayer(layer.id); });
    li.appendChild(rm);

    li.addEventListener('click', () => selectLayer(layer.id));
    li.addEventListener('dragstart', e => {
      dragSrcLi = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch (err) { /* ignore */ }
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      if (!dragSrcLi || dragSrcLi === li) return;
      const rect = li.getBoundingClientRect();
      li.parentNode.insertBefore(dragSrcLi, (e.clientY - rect.top) > rect.height / 2 ? li.nextSibling : li);
    });
    li.addEventListener('drop', e => e.preventDefault());
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragSrcLi = null;
      const topToBottom = Array.from(layerListEl.children).filter(el => el.dataset && el.dataset.id).map(el => el.dataset.id);
      layers = topToBottom.slice().reverse().map(id => layers.find(l => String(l.id) === id)).filter(Boolean);
      requestDraw();
      record('Reordered layers');
    });
    layerListEl.appendChild(li);
  });
}

function selectLayer(id) {
  if (samplingColor) exitSampling(true);
  selectedId = id;
  syncAll();
}

// --- control syncing ---------------------------------------------------------------------------------------
function syncAll() {
  renderLayerList();
  syncTransformControls();
  syncColorControls();
  syncTypeControls();
  requestDraw();
}

function refreshAll() {
  syncAll();
}

function syncTransformControls() {
  const l = getSelected();
  const on = !!l;
  removeLayerBtn.disabled = !on;
  zoomRange.disabled = rotRange.disabled = opacityRange.disabled = !on;
  $('rotLeftBtn').disabled = $('rotRightBtn').disabled = !on;
  if (!l) return;
  const z = Math.round(100 * l.sx / l.fit);
  zoomRange.value = Math.max(+zoomRange.min, Math.min(+zoomRange.max, z));
  zoomLabel.textContent = `${z}%`;
  rotRange.value = Math.round(l.rot);
  rotLabel.textContent = `${Math.round(l.rot)}°`;
  opacityRange.value = l.opacity;
  opacityLabel.textContent = `${Math.round(l.opacity)}%`;
}

function syncColorControls() {
  const l = getSelected();
  if (!isColorable(l)) return;
  const hex = layerHex(l);
  colorPicker.value = hex;
  colorSwatch.style.background = hex;
  cmykReadout.textContent = `C${Math.round(l.color.c)} M${Math.round(l.color.m)} Y${Math.round(l.color.y)} K${Math.round(l.color.k)}`;
  for (const k of ['c', 'm', 'y', 'k']) {
    if (document.activeElement !== cmykInputs[k]) cmykInputs[k].value = Math.round(l.color[k]);
  }
}

function syncTypeControls() {
  const l = getSelected();
  imageFieldsGroup.style.display = l && l.type === 'image' ? '' : 'none';
  shapeFieldsGroup.style.display = l && l.type === 'shape' ? '' : 'none';
  colorFieldsGroup.style.display = isColorable(l) ? '' : 'none';
  textFieldsGroup.style.display = l && l.type === 'text' ? '' : 'none';
  if (!l) return;
  if (l.type === 'image') {
    const hasOriginal = !!l.origAssetKey;
    restoreOriginalBtn.style.display = hasOriginal ? '' : 'none';
    removeBgBtn.style.display = hasOriginal ? 'none' : '';
    removeBgBtn.disabled = false;
    removeBgBtn.textContent = 'Remove background';
    if (!bgBusy) removeBgStatus.textContent = '';
  } else if (l.type === 'shape') {
    shapeKindSelect.value = l.shapeKind;
    const isLine = l.shapeKind === 'line';
    shapeFilledRow.style.display = isLine ? 'none' : '';
    shapeFilledCheckbox.checked = l.filled;
    shapeStrokeWidthField.style.display = isLine || !l.filled ? '' : 'none';
    shapeStrokeWidthRange.value = l.strokeWidth;
    shapeStrokeWidthLabel.textContent = l.strokeWidth;
  } else if (l.type === 'text') {
    if (document.activeElement !== textContentInput) textContentInput.value = l.text;
    fontSelect.value = l.fontFamily;
  }
}

// --- control events ---------------------------------------------------------------------------------------------
function mutateSelected(fn, { live = false, desc } = {}) {
  const l = getSelected();
  if (!l) return;
  fn(l);
  requestDraw();
  if (live) onChange(true);
  else record(desc ? desc(l) : `Edited layer ${layerLabel(l)}`);
}

$('addImageBtn').addEventListener('click', () => $('imageInput').click());
$('imageInput').addEventListener('change', e => {
  addImageFiles(e.target.files);
  e.target.value = '';
});
$('fitViewBtn').addEventListener('click', fitView);
removeLayerBtn.addEventListener('click', () => { const l = getSelected(); if (l) removeLayer(l.id); });
$('addTextBtn').addEventListener('click', addTextLayer);
document.querySelectorAll('[data-shape-kind]').forEach(btn => {
  btn.addEventListener('click', () => addShapeLayer(btn.dataset.shapeKind));
});

// size (uniform) — scales about the layer center, keeping any stretch ratio
zoomRange.addEventListener('input', () => {
  mutateSelected(l => {
    const k = (parseFloat(zoomRange.value) / 100) / (l.sx / l.fit);
    l.sx *= k; l.sy *= k;
    zoomLabel.textContent = `${zoomRange.value}%`;
  }, { live: true });
});
zoomRange.addEventListener('change', () => record(`Resized layer ${layerLabel(getSelected())}`));

rotRange.addEventListener('input', () => {
  mutateSelected(l => { l.rot = parseFloat(rotRange.value); rotLabel.textContent = `${Math.round(l.rot)}°`; }, { live: true });
});
rotRange.addEventListener('change', () => record(`Rotated layer ${layerLabel(getSelected())}`));
$('rotLeftBtn').addEventListener('click', () => mutateSelected(l => { l.rot = normalizeDeg(l.rot - 15); syncTransformControls(); }, { desc: l => `Rotated layer ${layerLabel(l)}` }));
$('rotRightBtn').addEventListener('click', () => mutateSelected(l => { l.rot = normalizeDeg(l.rot + 15); syncTransformControls(); }, { desc: l => `Rotated layer ${layerLabel(l)}` }));

opacityRange.addEventListener('input', () => {
  mutateSelected(l => { l.opacity = parseFloat(opacityRange.value); opacityLabel.textContent = `${Math.round(l.opacity)}%`; }, { live: true });
});
opacityRange.addEventListener('change', () => record(`Changed opacity of layer ${layerLabel(getSelected())}`));

$('guideCheckbox').addEventListener('change', e => { showGuide = e.target.checked; requestDraw(); });

// image tools
$('resetSizeBtn').addEventListener('click', () => mutateSelected(l => {
  if (l.type !== 'image') return;
  l.sx = l.sy = l.fit;
  syncTransformControls();
}, { desc: l => `Resized layer ${layerLabel(l)}` }));
$('flipHBtn').addEventListener('click', () => mutateSelected(l => { if (l.type === 'image') l.flipX = !l.flipX; }, { desc: l => `Flipped layer ${layerLabel(l)}` }));
$('flipVBtn').addEventListener('click', () => mutateSelected(l => { if (l.type === 'image') l.flipY = !l.flipY; }, { desc: l => `Flipped layer ${layerLabel(l)}` }));

// text tools
textContentInput.addEventListener('input', () => {
  const l = getSelected();
  if (!l || l.type !== 'text') return;
  l.text = textContentInput.value;
  measureText(l);
  requestDraw();
  renderLayerList();
  onChange(true);
});
textContentInput.addEventListener('change', () => record(`Edited text of layer ${layerLabel(getSelected())}`));

fontSelect.addEventListener('change', () => {
  if (fontSelect.value === '__upload__') {
    syncTypeControls();
    fontFileInput.click();
    return;
  }
  const l = getSelected();
  if (!l || l.type !== 'text') return;
  l.fontFamily = fontSelect.value;
  measureText(l);
  ensureFont(l.fontFamily);
  requestDraw();
  onChange();
  record(`Changed font of layer ${layerLabel(l)}`);
});

fontFileInput.addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  fontFileInput.value = '';
  if (!file) return;
  try {
    const dataURL = await readFileAsDataURL(file);
    const value = await registerCustomFont(file.name, dataURL);
    const l = getSelected();
    if (l && l.type === 'text') {
      l.fontFamily = value;
      measureText(l);
      fontSelect.value = value;
      requestDraw();
      onChange();
      record(`Changed font of layer ${layerLabel(l)}`);
    }
  } catch (err) {
    showInfo("Couldn't load that font file.");
  }
});

// shape tools
shapeKindSelect.addEventListener('change', () => mutateSelected(l => {
  if (l.type !== 'shape') return;
  const prevKind = l.shapeKind;
  l.shapeKind = shapeKindSelect.value;
  if (l.shapeKind === 'line') l.nh = l.strokeWidth;
  else if (prevKind === 'line') { const d = SHAPE_DEFAULTS[l.shapeKind]; l.nw = d.w; l.nh = d.h; }
  syncTypeControls();
}, { desc: l => `Changed style of layer ${layerLabel(l)}` }));
shapeFilledCheckbox.addEventListener('change', () => mutateSelected(l => {
  if (l.type !== 'shape') return;
  l.filled = shapeFilledCheckbox.checked;
  syncTypeControls();
}, { desc: l => `Changed style of layer ${layerLabel(l)}` }));
shapeStrokeWidthRange.addEventListener('input', () => mutateSelected(l => {
  if (l.type !== 'shape') return;
  l.strokeWidth = parseFloat(shapeStrokeWidthRange.value);
  if (l.shapeKind === 'line') l.nh = l.strokeWidth;
  shapeStrokeWidthLabel.textContent = shapeStrokeWidthRange.value;
}, { live: true }));
shapeStrokeWidthRange.addEventListener('change', () => record(`Changed style of layer ${layerLabel(getSelected())}`));

// color
colorPicker.addEventListener('input', () => {
  const l = getSelected();
  if (!isColorable(l)) return;
  l.color = hexToCmyk(colorPicker.value);
  colorSwatch.style.background = colorPicker.value;
  syncColorControls();
  requestDraw();
  onChange(true);
});
colorPicker.addEventListener('change', () => record(`Changed color of layer ${layerLabel(getSelected())}`));
function applyCmykInputs() {
  const l = getSelected();
  if (!isColorable(l)) return;
  const cl = v => Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
  l.color = {
    c: cl(parseFloat(cmykInputs.c.value)), m: cl(parseFloat(cmykInputs.m.value)),
    y: cl(parseFloat(cmykInputs.y.value)), k: cl(parseFloat(cmykInputs.k.value)),
  };
  syncColorControls();
  requestDraw();
  onChange(true);
}
for (const k of ['c', 'm', 'y', 'k']) {
  cmykInputs[k].addEventListener('input', applyCmykInputs);
  cmykInputs[k].addEventListener('change', () => { applyCmykInputs(); record(`Changed color of layer ${layerLabel(getSelected())}`); });
}

// keyboard
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && samplingColor) { e.preventDefault(); exitSampling(true); return; }
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && ['text', 'number'].includes(document.activeElement.type));
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
    if (typing) return;
    e.preventDefault();
    undo();
    return;
  }
  const l = getSelected();
  if (!l || typing || tag === 'INPUT' || $('stageContainer').offsetParent === null) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLayer(l.id); return; }
  if (e.key === '[' || e.key === ']') {
    e.preventDefault();
    const step = e.shiftKey ? 15 : 1;
    l.rot = normalizeDeg(l.rot + (e.key === ']' ? step : -step));
    syncTransformControls();
    requestDraw();
    onChange(true);
    debouncedRecord(`Rotated layer ${layerLabel(l)}`);
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    l.cx += arrows[e.key][0] * step;
    l.cy += arrows[e.key][1] * step;
    requestDraw();
    onChange(true);
    debouncedRecord(`Moved layer ${layerLabel(l)}`);
  }
});

// --- background removal (client-side U2NETP ONNX model via onnxruntime-web wasm) -----------------------------------
const BG_REMOVAL_MODEL_URL = 'assets/models/u2netp.onnx';
const ORT_CDN_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
let ortLoadPromise = null;
let bgSessionPromise = null;
let bgBusy = false;

function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortLoadPromise) {
    ortLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ORT_CDN_BASE + 'ort.min.js';
      script.onload = () => { window.ort.env.wasm.wasmPaths = ORT_CDN_BASE; resolve(window.ort); };
      script.onerror = () => { ortLoadPromise = null; reject(new Error("Couldn't load the background removal engine.")); };
      document.head.appendChild(script);
    });
  }
  return ortLoadPromise;
}

function getBgSession() {
  if (!bgSessionPromise) {
    bgSessionPromise = loadOrt()
      .then(ort => ort.InferenceSession.create(BG_REMOVAL_MODEL_URL))
      .catch(err => { bgSessionPromise = null; throw err; });
  }
  return bgSessionPromise;
}

// Mirrors the "rembg" U2NETP pre/post-processing: 320x320 input scaled by the image's own
// peak channel value then ImageNet-normalised; the mask output is min-max stretched and
// resized back to the source size to become the alpha channel.
async function removeBackground(img) {
  const session = await getBgSession();
  const SIZE = 320;
  const inCanvas = document.createElement('canvas');
  inCanvas.width = inCanvas.height = SIZE;
  const inCtx = inCanvas.getContext('2d');
  inCtx.imageSmoothingQuality = 'high';
  inCtx.drawImage(img, 0, 0, SIZE, SIZE);
  const inData = inCtx.getImageData(0, 0, SIZE, SIZE).data;

  let maxVal = 1e-6;
  for (let i = 0; i < inData.length; i += 4) {
    maxVal = Math.max(maxVal, inData[i], inData[i + 1], inData[i + 2]);
  }
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const plane = SIZE * SIZE;
  const chw = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) chw[c * plane + p] = ((inData[p * 4 + c] / maxVal) - mean[c]) / std[c];
  }
  const tensor = new window.ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]);
  const results = await session.run({ [session.inputNames[0]]: tensor });
  const out = results[session.outputNames[0]].data;
  let mi = Infinity, ma = -Infinity;
  for (let i = 0; i < out.length; i++) { if (out[i] < mi) mi = out[i]; if (out[i] > ma) ma = out[i]; }
  const range = (ma - mi) || 1e-6;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = SIZE;
  const maskCtx = maskCanvas.getContext('2d');
  const maskImage = maskCtx.createImageData(SIZE, SIZE);
  for (let i = 0; i < out.length; i++) {
    const v = Math.round(((out[i] - mi) / range) * 255);
    maskImage.data[i * 4] = maskImage.data[i * 4 + 1] = maskImage.data[i * 4 + 2] = v;
    maskImage.data[i * 4 + 3] = 255;
  }
  maskCtx.putImageData(maskImage, 0, 0);

  const w = img.naturalWidth, h = img.naturalHeight;
  const fullMask = document.createElement('canvas');
  fullMask.width = w; fullMask.height = h;
  const fmCtx = fullMask.getContext('2d');
  fmCtx.imageSmoothingQuality = 'high';
  fmCtx.drawImage(maskCanvas, 0, 0, w, h);
  const maskData = fmCtx.getImageData(0, 0, w, h).data;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w; outCanvas.height = h;
  const oCtx = outCanvas.getContext('2d');
  oCtx.drawImage(img, 0, 0, w, h);
  const outImage = oCtx.getImageData(0, 0, w, h);
  for (let i = 0; i < outImage.data.length; i += 4) outImage.data[i + 3] = maskData[i];
  oCtx.putImageData(outImage, 0, 0);
  return outCanvas.toDataURL('image/png');
}

removeBgBtn.addEventListener('click', async () => {
  const l = getSelected();
  if (!l || l.type !== 'image' || bgBusy) return;
  bgBusy = true;
  removeBgBtn.disabled = true;
  removeBgBtn.textContent = 'Removing background…';
  removeBgStatus.textContent = 'First run downloads a small AI model (a few MB) — this can take a moment.';
  try {
    const src = assets.get(l.assetKey);
    const dataURL = await removeBackground(src.img);
    const asset = await registerAsset(dataURL, src.name);
    if (!layers.includes(l)) return; // removed while processing
    l.origAssetKey = l.assetKey;
    l.assetKey = asset.key;
    bgBusy = false;
    syncTypeControls();
    removeBgStatus.textContent = 'Background removed.';
    requestDraw();
    onChange();
    record(`Removed background of layer ${layerLabel(l)}`);
  } catch (err) {
    console.error(err);
    removeBgStatus.textContent = '';
    showInfo("Couldn't remove the background from this image. " + (err && err.message ? err.message : ''));
  } finally {
    bgBusy = false;
    syncTypeControls();
  }
});

restoreOriginalBtn.addEventListener('click', () => mutateSelected(l => {
  if (!l.origAssetKey) return;
  l.assetKey = l.origAssetKey;
  delete l.origAssetKey;
  syncTypeControls();
}, { desc: l => `Restored original of layer ${layerLabel(l)}` }));

// --- public: composite for the 3D pipeline ---------------------------------------------------------------------------------
/**
 * Flattens every visible layer onto a transparent canvas (longest edge = maxDim px) and
 * crops it to the tight bounds of visible pixels, so the sticker is sized to the artwork
 * rather than to whatever empty space the layer boxes happen to enclose.
 */
function renderComposite(maxDim = 2200) {
  const b = layersBounds();
  if (!b) return null;
  const w = Math.max(1, b.maxX - b.minX), h = Math.max(1, b.maxY - b.minY);
  const scale = maxDim / Math.max(w, h);
  const cw = Math.max(2, Math.ceil(w * scale)), ch = Math.max(2, Math.ceil(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const cctx = c.getContext('2d', { willReadFrequently: true });
  cctx.setTransform(scale, 0, 0, scale, -b.minX * scale, -b.minY * scale);
  for (const l of layers) drawLayer(cctx, l);
  cctx.setTransform(1, 0, 0, 1, 0, 0);

  const data = cctx.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (data[(y * cw + x) * 4 + 3] >= 16) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// --- project (de)serialization -----------------------------------------------------------------------------------------------
const ROOT_TAG = 'keychainCustomizerProject';
const NUM_ATTRS = ['id', 'cx', 'cy', 'sx', 'sy', 'rot', 'opacity', 'nw', 'nh', 'fit', 'strokeWidth'];
const BOOL_ATTRS = ['visible', 'flipX', 'flipY', 'filled'];
const STR_ATTRS = ['type', 'name', 'shapeKind', 'fontFamily'];

function extFromDataURL(dataURL) {
  const m = /^data:([^;,]+)/.exec(dataURL);
  const mime = m ? m[1] : 'image/png';
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' }[mime] || 'png';
}

async function dataURLToBytes(dataURL) {
  const res = await fetch(dataURL);
  return new Uint8Array(await res.arrayBuffer());
}

/** Writes project.xml plus every referenced image/font into `zip`. `settings` is a flat object of keychain options. */
async function exportProject(zip, settings) {
  const doc = document.implementation.createDocument(null, ROOT_TAG, null);
  const root = doc.documentElement;
  root.setAttribute('version', '1');
  for (const [k, v] of Object.entries(settings || {})) root.setAttribute(k, String(v));

  const usedNames = new Set();
  const uniqueName = (folder, base) => {
    let n = base, i = 2;
    while (usedNames.has(folder + n)) n = base.replace(/(\.[^.]+)?$/, `-${i++}$1`);
    usedNames.add(folder + n);
    return folder + n;
  };
  const writtenAssets = new Map(); // assetKey -> zip path
  const writeAsset = async key => {
    if (writtenAssets.has(key)) return writtenAssets.get(key);
    const a = assets.get(key);
    const base = (a.name || 'image').replace(/\.[^.]+$/, '').replace(/[^a-z0-9._-]+/gi, '-') || 'image';
    const path = uniqueName('assets/', `${base}.${extFromDataURL(a.dataURL)}`);
    zip.file(path, await dataURLToBytes(a.dataURL));
    writtenAssets.set(key, path);
    return path;
  };

  const usedFontValues = new Set(layers.filter(l => l.type === 'text').map(l => l.fontFamily));
  const layersEl = doc.createElement('layers');
  root.appendChild(layersEl);
  for (const l of layers) {
    const el = doc.createElement('layer');
    for (const k of NUM_ATTRS) if (l[k] != null) el.setAttribute(k, String(l[k]));
    for (const k of BOOL_ATTRS) if (l[k] != null) el.setAttribute(k, l[k] ? '1' : '0');
    for (const k of STR_ATTRS) if (l[k] != null) el.setAttribute(k, String(l[k]));
    if (l.color) for (const k of ['c', 'm', 'y', 'k']) el.setAttribute('color' + k.toUpperCase(), String(l.color[k]));
    if (l.type === 'image') {
      el.setAttribute('file', await writeAsset(l.assetKey));
      if (l.origAssetKey) el.setAttribute('origFile', await writeAsset(l.origAssetKey));
    } else if (l.type === 'text') {
      el.appendChild(doc.createElement('text')).textContent = l.text;
    }
    layersEl.appendChild(el);
  }

  const fontsEl = doc.createElement('fonts');
  for (const f of customFonts) {
    if (!usedFontValues.has(f.value)) continue;
    const ext = (f.fileName.split('.').pop() || 'ttf').toLowerCase();
    const path = uniqueName('fonts/', `${f.family}.${ext}`);
    zip.file(path, await dataURLToBytes(f.dataURL));
    const el = doc.createElement('font');
    el.setAttribute('family', f.family);
    el.setAttribute('label', f.label);
    el.setAttribute('file', path);
    fontsEl.appendChild(el);
  }
  root.appendChild(fontsEl);

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc);
  zip.file('project.xml', xml);
}

function mimeFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', ttf: 'font/ttf', otf: 'font/otf' }[ext] || 'application/octet-stream';
}
async function zipEntryToDataURL(zip, path) {
  const entry = zip.file(path);
  if (!entry) throw new Error(`The project is missing "${path}".`);
  return `data:${mimeFromPath(path)};base64,${await entry.async('base64')}`;
}

/** Replaces the current design with the one stored in `zip`. Returns the keychain settings as strings. */
async function importProject(zip) {
  const path = Object.keys(zip.files).find(p => !zip.files[p].dir && (p === 'project.xml' || p.endsWith('/project.xml')));
  if (!path) throw new Error("That zip doesn't contain a project.xml.");
  const base = path.slice(0, path.length - 'project.xml'.length);
  const doc = new DOMParser().parseFromString(await zip.file(path).async('string'), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error("Couldn't parse project.xml.");
  const root = doc.documentElement;
  if (root.tagName !== ROOT_TAG) throw new Error("That project file isn't a Keychain Customizer project.");

  const settings = {};
  for (const a of Array.from(root.attributes)) settings[a.name] = a.value;

  // fonts first so text layers measure against the right face
  const fontMap = new Map(); // family attr -> CSS value
  for (const el of Array.from(doc.querySelectorAll('fonts > font'))) {
    const dataURL = await zipEntryToDataURL(zip, base + el.getAttribute('file'));
    const value = await registerCustomFont(el.getAttribute('file'), dataURL, el.getAttribute('family'), el.getAttribute('label'));
    fontMap.set(el.getAttribute('family'), value);
  }

  const newLayers = [];
  let maxId = 0;
  for (const el of Array.from(doc.querySelectorAll('layers > layer'))) {
    const l = {};
    for (const k of NUM_ATTRS) if (el.hasAttribute(k)) l[k] = parseFloat(el.getAttribute(k));
    for (const k of BOOL_ATTRS) if (el.hasAttribute(k)) l[k] = el.getAttribute(k) === '1';
    for (const k of STR_ATTRS) if (el.hasAttribute(k)) l[k] = el.getAttribute(k);
    if (el.hasAttribute('colorC')) {
      l.color = { c: +el.getAttribute('colorC'), m: +el.getAttribute('colorM'), y: +el.getAttribute('colorY'), k: +el.getAttribute('colorK') };
    }
    if (!['image', 'text', 'shape'].includes(l.type)) continue;
    if (!Number.isFinite(l.id)) l.id = maxId + 1;
    maxId = Math.max(maxId, l.id);
    if (l.type === 'image') {
      const a = await registerAsset(await zipEntryToDataURL(zip, base + el.getAttribute('file')), l.name);
      l.assetKey = a.key;
      if (el.hasAttribute('origFile')) {
        l.origAssetKey = (await registerAsset(await zipEntryToDataURL(zip, base + el.getAttribute('origFile')), l.name)).key;
      }
    } else if (l.type === 'text') {
      const t = el.querySelector('text');
      l.text = t ? t.textContent : '';
      if (!l.color) l.color = { c: 0, m: 0, y: 0, k: 100 };
    } else if (!l.color) {
      l.color = { c: 0, m: 0, y: 0, k: 100 };
    }
    newLayers.push(l);
  }

  layers = newLayers;
  idCounter = Math.max(idCounter, maxId);
  selectedId = null;
  for (const l of layers) {
    if (l.type === 'text') { measureText(l); ensureFont(l.fontFamily); }
  }
  resetHistory('Loaded project');
  syncAll();
  fitView();
  onChange();
  return settings;
}

// --- init ------------------------------------------------------------------------------------------------------------------------
BUILTIN_FONTS.forEach(f => {
  const opt = document.createElement('option');
  opt.value = f.value;
  opt.textContent = f.label;
  builtinFontGroup.appendChild(opt);
});

const editor = {
  setOnChange(fn) { onChange = fn; },
  setOnImagesDropped(fn) { onImagesDropped = fn; },
  hasContent: () => layersBounds() !== null,
  renderComposite,
  exportProject,
  importProject,
  addImageFiles,
  /** Resolves once web fonts requested by text layers have loaded (so a composite matches the screen). */
  async ready() {
    await Promise.all(Array.from(pendingFonts));
    await document.fonts.ready;
    for (const l of layers) if (l.type === 'text') measureText(l);
  },
  resize: resizeCanvas,
  redraw: requestDraw,
  fitView,
  layersUsedAssets: () => layers.filter(l => l.type === 'image').map(l => assets.get(l.assetKey)).filter(Boolean),
};

resetHistory('Start');
syncAll();
resizeCanvas();
fitView();

window.KCEditor = { editor };
})();
