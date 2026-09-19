// Classic (non-module) script so the page also works when opened straight from disk
// (file://), where browsers refuse to load ES modules. three.js is pulled from the CDN
// via dynamic import(), resolved through the import map in keychain.html.
(async function () {
const THREE = await import('three');
const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
const { toCreasedNormals } = await import('three/addons/utils/BufferGeometryUtils.js');
const {
  alphaMaskFromRGBA, removeSmallComponents, dilate, boxBlur, thresholdMask,
  marchingSquares, simplifyContour, classifyContours, smoothPolygon,
} = window.StickerCore;
const { editor } = window.KCEditor;
const { showInfo, showConfirm, showImage, showProgress } = window.KCModal;

// --- Design constants (all physical sizes in mm) ---------------------
const LOOP_OUTER_R = 6; // fixed outer radius of the keychain loop
const LOOP_OVERLAP = 3;
const ALPHA_THRESHOLD = 16;
const MIN_IMAGE_AREA_HEIGHT_MM = 8;
const MIN_SPECK_AREA_MM2 = 0.5; // stray-pixel noise smaller than this is discarded before border/smoothing
const COMPOSITE_MAX_DIM = 2200; // px, longest edge of the flattened artwork handed to the tracer

// "Edge detail" slider levels: working raster resolution (px, tall dimension) the artwork
// is (up- or down-scaled to) traced at — higher catches finer artwork features — plus how
// densely the loop's circles and the smoothed die-cut curve get sampled. Edges are always
// rendered as true smooth curves (see smoothPolygon / CORNER_ANGLE_DEG below); this slider
// mostly trades fine-detail fidelity and sampling density for generate time.
const DETAIL_LEVELS = [
  { label: 'Draft', workingDim: 400, loopSegments: 28, curveSamples: 8 },
  { label: 'Standard', workingDim: 700, loopSegments: 40, curveSamples: 12 },
  { label: 'Fine', workingDim: 1100, loopSegments: 56, curveSamples: 18 },
  { label: 'Ultra', workingDim: 1600, loopSegments: 72, curveSamples: 26 },
  { label: 'Max', workingDim: 2200, loopSegments: 96, curveSamples: 36 },
];
// Turn angle (degrees) above which a traced vertex is treated as a genuine sharp corner
// (kept as a hard vertex) rather than a point along a gentle arc (which gets curve-fit).
const CORNER_ANGLE_DEG = 30;

// --- DOM ----------------------------------------------------------------
const $ = id => document.getElementById(id);
const stageContainer = $('stageContainer');
const viewerContainer = $('viewerContainer');
const viewerEl = $('viewer');
const viewerPlaceholder = $('viewerPlaceholder');
const viewerHint = $('viewerHint');
const stageHint = $('stageHint');
const tabDesign = $('tabDesign');
const tabPreview = $('tabPreview');
const statusEl = $('status');
const dimsEl = $('dims');
const downloadBtn = $('downloadBtn');
const saveZipMenuBtn = $('saveZipMenuBtn');

const sliders = {
  border: { input: $('borderSlider'), label: $('borderVal'), fmt: v => `${v.toFixed(1)} mm` },
  smooth: { input: $('smoothSlider'), label: $('smoothVal'), fmt: v => `${v.toFixed(1)} mm` },
  thickness: { input: $('thicknessSlider'), label: $('thicknessVal'), fmt: v => `${v.toFixed(1)} mm` },
  height: { input: $('heightSlider'), label: $('heightVal'), fmt: v => `${Math.round(v)} mm` },
  loopThickness: { input: $('loopThicknessSlider'), label: $('loopThicknessVal'), fmt: v => `${v.toFixed(1)} mm` },
  loopPosition: { input: $('loopPositionSlider'), label: $('loopPositionVal'), fmt: v => `${v > 0 ? '+' : ''}${v.toFixed(1)} mm` },
  detail: { input: $('detailSlider'), label: $('detailVal'), fmt: v => DETAIL_LEVELS[v].label },
};
const loopCheckbox = $('loopCheckbox');
const loopFields = $('loopFields');

function readSettings() {
  return {
    borderMM: parseFloat(sliders.border.input.value),
    smoothMM: parseFloat(sliders.smooth.input.value),
    thicknessMM: parseFloat(sliders.thickness.input.value),
    maxHeightMM: parseFloat(sliders.height.input.value),
    loop: loopCheckbox.checked,
    loopThicknessMM: parseFloat(sliders.loopThickness.input.value),
    loopOffsetMM: parseFloat(sliders.loopPosition.input.value),
    detail: Number(sliders.detail.input.value),
  };
}

const SETTING_TO_SLIDER = {
  borderMM: 'border', smoothMM: 'smooth', thicknessMM: 'thickness', maxHeightMM: 'height',
  loopThicknessMM: 'loopThickness', loopOffsetMM: 'loopPosition', detail: 'detail',
};

function syncSliderLabels() {
  for (const s of Object.values(sliders)) s.label.textContent = s.fmt(parseFloat(s.input.value));
  loopFields.style.display = loopCheckbox.checked ? '' : 'none';
}

function applySettings(saved) {
  for (const [key, name] of Object.entries(SETTING_TO_SLIDER)) {
    if (saved[key] == null) continue;
    const v = parseFloat(saved[key]);
    if (Number.isFinite(v)) sliders[name].input.value = v;
  }
  if (saved.loop != null) loopCheckbox.checked = saved.loop === 'true' || saved.loop === '1';
  syncSliderLabels();
}

// --- state ----------------------------------------------------------------------
let viewMode = 'design';
let dirty = true;          // artwork/settings changed since the 3D model was last built
let hasFramedOnce = false;
let previousResult = null;
let generateTimer = null;
let generateToken = 0;

// --- Three.js scene setup -----------------------------------------------
const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.position.set(0, 0, 220);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, 2);
renderer.setPixelRatio(BASE_PIXEL_RATIO);
viewerEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 20;
controls.maxDistance = 2000;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(80, 120, 160);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
fillLight.position.set(-120, -60, -100);
scene.add(fillLight);

function resizeRenderer() {
  const w = viewerEl.clientWidth || 1;
  const h = viewerEl.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(viewerEl);
resizeRenderer();

(function animate() {
  requestAnimationFrame(animate);
  if (viewMode !== 'preview') return; // nothing to draw while the design tab is showing
  controls.update();
  renderer.render(scene, camera);
})();

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.classList.remove('busy');
}
function setBusy(msg) {
  statusEl.textContent = msg;
  statusEl.classList.remove('error');
  statusEl.classList.add('busy');
}

function updateButtons() {
  const has = editor.hasContent();
  downloadBtn.disabled = !has;
  saveZipMenuBtn.disabled = !has;
}

// --- tabs -------------------------------------------------------------------------
function showTab(name) {
  viewMode = name;
  const design = name === 'design';
  stageContainer.style.display = design ? '' : 'none';
  viewerContainer.style.display = design ? 'none' : 'block';
  stageHint.style.display = design ? '' : 'none';
  tabDesign.classList.toggle('active', design);
  tabPreview.classList.toggle('active', !design);
  if (design) {
    editor.resize();
    editor.redraw();
  } else {
    resizeRenderer();
    if (dirty || !previousResult) scheduleGenerate(0);
  }
}
tabDesign.addEventListener('click', () => showTab('design'));
tabPreview.addEventListener('click', () => showTab('preview'));

// --- wiring: editor + settings ---------------------------------------------------------
editor.setOnChange(live => {
  dirty = true;
  updateButtons();
  if (viewMode === 'preview') scheduleGenerate(live ? 400 : 150);
});

// a drop while on the 3D tab goes back to the artboard so the new layer is visible
editor.setOnImagesDropped(() => { if (viewMode !== 'design') showTab('design'); });

for (const s of Object.values(sliders)) {
  s.input.addEventListener('input', () => {
    s.label.textContent = s.fmt(parseFloat(s.input.value));
    dirty = true;
    if (viewMode !== 'preview') showTab('preview');
    scheduleGenerate(150);
  });
}
loopCheckbox.addEventListener('change', () => {
  syncSliderLabels();
  dirty = true;
  if (viewMode !== 'preview') showTab('preview');
  scheduleGenerate(150);
});
syncSliderLabels();

function scheduleGenerate(delay = 150) {
  clearTimeout(generateTimer);
  generateTimer = setTimeout(generate, delay);
}

// --- Generation pipeline --------------------------------------------------
async function generate() {
  clearTimeout(generateTimer);
  const token = ++generateToken;
  if (!editor.hasContent()) {
    clearResult();
    setStatus('');
    dirty = false;
    updateButtons();
    return;
  }
  setBusy('Generating…');
  await editor.ready();
  // Yield a frame so the "busy" status paints before the synchronous work below.
  await new Promise(r => requestAnimationFrame(r));
  if (token !== generateToken) return; // a newer request superseded this one
  try {
    const composite = editor.renderComposite(COMPOSITE_MAX_DIM);
    if (!composite) throw new Error('Nothing visible to turn into a keychain.');
    const settings = readSettings();
    const result = buildStickerGroup(composite, settings, DETAIL_LEVELS[settings.detail]);
    showResult(result);
    dirty = false;
    setStatus('Ready.');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.', true);
  }
  updateButtons();
}

function buildStickerGroup(source, settings, detail) {
  const { borderMM, smoothMM, thicknessMM, maxHeightMM, loop, loopThicknessMM, loopOffsetMM } = settings;
  const iw = source.naturalWidth || source.width, ih = source.naturalHeight || source.height;
  if (!iw || !ih) throw new Error('Artwork has no dimensions.');

  const scale = detail.workingDim / Math.max(iw, ih);
  const imgPxW = Math.max(2, Math.round(iw * scale));
  const imgPxH = Math.max(2, Math.round(ih * scale));

  const loopProtrusion = loop ? LOOP_OUTER_R * 2 - LOOP_OVERLAP : 0;
  const imageAreaHeightMM = Math.max(
    MIN_IMAGE_AREA_HEIGHT_MM,
    maxHeightMM - 2 * borderMM - loopProtrusion
  );
  const mmPerPx = imageAreaHeightMM / imgPxH;

  const borderPx = borderMM / mmPerPx;
  const smoothPx = smoothMM / mmPerPx;
  const paddingPx = Math.ceil(borderPx + smoothPx * 3 + 6);

  const cw = imgPxW + paddingPx * 2;
  const ch = imgPxH + paddingPx * 2;

  // Mask canvas: transparent background so alpha reflects only the artwork.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = cw;
  maskCanvas.height = ch;
  const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  mctx.clearRect(0, 0, cw, ch);
  mctx.drawImage(source, paddingPx, paddingPx, imgPxW, imgPxH);
  const imgData = mctx.getImageData(0, 0, cw, ch);

  const { mask: alphaMask } = alphaMaskFromRGBA(imgData.data, cw, ch, ALPHA_THRESHOLD);
  const minSpeckPixels = MIN_SPECK_AREA_MM2 / (mmPerPx * mmPerPx);
  const cleanedMask = removeSmallComponents(alphaMask, cw, ch, minSpeckPixels);
  const dilated = dilate(cleanedMask, cw, ch, borderPx);
  const blurred = boxBlur(dilated, cw, ch, smoothPx, 3);
  const finalMask = thresholdMask(blurred, cw, ch, 127);

  const rawContours = marchingSquares(finalMask, cw, ch);
  const simplified = rawContours.map(c => simplifyContour(c, 0.75));
  const shapesData = classifyContours(simplified, 4);
  if (shapesData.length === 0) {
    throw new Error('No visible shape detected — try different artwork or less border.');
  }

  // Composite texture: white backing + original artwork, same pixel grid as the mask.
  const texCanvas = document.createElement('canvas');
  texCanvas.width = cw;
  texCanvas.height = ch;
  const tctx = texCanvas.getContext('2d');
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(0, 0, cw, ch);
  tctx.drawImage(source, paddingPx, paddingPx, imgPxW, imgPxH);

  const pxToMM = (px, py) => ({ x: (px - cw / 2) * mmPerPx, y: (ch / 2 - py) * mmPerPx });
  const mmToUV = (x, y) => {
    const px = x / mmPerPx + cw / 2;
    const py = ch / 2 - y / mmPerPx;
    return new THREE.Vector2(px / cw, 1 - py / ch);
  };
  // Marching-squares contours are closed loops (first === last); drop the duplicate and
  // convert to mm before curve-fitting so smoothPolygon works in physical units.
  const toOpenMM = points => points.slice(0, -1).map(p => pxToMM(p.x, p.y));
  const smoothOpts = { cornerAngleDeg: CORNER_ANGLE_DEG, samplesPerSegment: detail.curveSamples };
  const toVec2 = pts => pts.map(p => new THREE.Vector2(p.x, p.y));

  const smoothedShapes = shapesData.map(s => ({
    outer: smoothPolygon(toOpenMM(s.outer), smoothOpts),
    holes: s.holes.map(h => smoothPolygon(toOpenMM(h), smoothOpts)),
  }));

  const threeShapes = smoothedShapes.map(s => {
    const shape = new THREE.Shape(toVec2(s.outer));
    for (const h of s.holes) shape.holes.push(new THREE.Path(toVec2(h)));
    return shape;
  });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, topX = 0;
  for (const s of smoothedShapes) {
    for (const p of s.outer) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) { maxY = p.y; topX = p.x; }
    }
  }

  const uvGenerator = {
    generateTopUV(geometry, vertices, a, b, c) {
      return [a, b, c].map(i => mmToUV(vertices[i * 3], vertices[i * 3 + 1]));
    },
    generateSideWallUV(geometry, vertices, a, b, c, d) {
      return [a, b, c, d].map(i => mmToUV(vertices[i * 3], vertices[i * 3 + 1]));
    },
  };

  let mainGeom = new THREE.ExtrudeGeometry(threeShapes, {
    depth: thicknessMM,
    bevelEnabled: false,
    steps: 1,
    UVGenerator: uvGenerator,
  });

  // Keychain loop: an annulus straddling the top edge of the sticker body. The outer
  // radius is fixed; "loop thickness" is the band width, so it shrinks/grows the inner
  // cutout (bigger thickness = more material = smaller hole) rather than the Z depth.
  //
  // The loop must land squarely on material that actually reaches this height. Centering
  // it on the overall bounding box (as opposed to the peak that defines maxY) breaks for
  // asymmetric artwork — e.g. off-center horns/ears — where the box's horizontal midpoint
  // falls in a valley between two peaks, leaving the loop floating with no connection to
  // the body. Anchor on the highest peak (topX, maxY) instead, which is guaranteed to sit
  // on the silhouette, then average in nearby points (within the loop's own footprint) to
  // smooth out vertex-level jitter without drifting toward a separate, unconnected peak.
  let loopGeom = null;
  let loopCenterX = 0;
  let loopTop = -Infinity;
  if (loop) {
    const loopInnerR = Math.max(1, LOOP_OUTER_R - loopThicknessMM);
    let topSumX = 0, topCount = 0;
    for (const s of smoothedShapes) {
      for (const p of s.outer) {
        if (Math.abs(p.x - topX) <= LOOP_OUTER_R && p.y >= maxY - LOOP_OUTER_R) {
          topSumX += p.x;
          topCount++;
        }
      }
    }
    // loopOffsetMM is a manual nudge from the "Loop position" slider, applied on top of the
    // auto-anchored position above. Sliding the loop away from the peak means it's no longer
    // sitting above the tallest point of the silhouette, so the fixed peak height can no
    // longer be trusted — re-measure how tall the body actually is at the new X (topYAtX)
    // and rest the loop on that, the same way the auto-anchor rests on the global peak. This
    // keeps the loop attached wherever the slider puts it, instead of just at the default spot.
    const EPS = 0.01;
    const clampedX = Math.min(maxX - EPS, Math.max(minX + EPS, (topCount > 0 ? topSumX / topCount : topX) + loopOffsetMM));
    const topYAtX = x => {
      let best = -Infinity;
      for (const s of smoothedShapes) {
        const pts = s.outer;
        const n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          if (a.x === b.x) continue;
          if ((a.x <= x && b.x >= x) || (a.x >= x && b.x <= x)) {
            const t = (x - a.x) / (b.x - a.x);
            const y = a.y + t * (b.y - a.y);
            if (y > best) best = y;
          }
        }
      }
      return best;
    };
    loopCenterX = clampedX;
    const surfaceY = topYAtX(loopCenterX);
    const loopCenterY = (Number.isFinite(surfaceY) ? surfaceY : maxY) + LOOP_OUTER_R - LOOP_OVERLAP;
    const loopShape = new THREE.Shape();
    loopShape.absarc(loopCenterX, loopCenterY, LOOP_OUTER_R, 0, Math.PI * 2, false);
    const loopHole = new THREE.Path();
    loopHole.absarc(loopCenterX, loopCenterY, loopInnerR, 0, Math.PI * 2, true);
    loopShape.holes.push(loopHole);
    loopGeom = new THREE.ExtrudeGeometry(loopShape, {
      depth: thicknessMM,
      bevelEnabled: false,
      steps: 1,
      curveSegments: detail.loopSegments,
    });
    loopTop = loopCenterY + LOOP_OUTER_R;
  }

  const overallMinX = loop ? Math.min(minX, loopCenterX - LOOP_OUTER_R) : minX;
  const overallMaxX = loop ? Math.max(maxX, loopCenterX + LOOP_OUTER_R) : maxX;
  const overallMinY = minY;
  const overallMaxY = loop ? Math.max(maxY, loopTop) : maxY;
  const centerX = (overallMinX + overallMaxX) / 2;
  const centerY = (overallMinY + overallMaxY) / 2;

  mainGeom.translate(-centerX, -centerY, -thicknessMM / 2);
  if (loopGeom) loopGeom.translate(-centerX, -centerY, -thicknessMM / 2);

  // The curve fit interpolates through the traced points and can overshoot their bounding
  // box slightly (Catmull-Rom is not confined to its control polygon). The border/loop
  // budget above targets the max height analytically, but only this measured footprint is
  // the ground truth — clamp it down (never up) so the height limit is a hard guarantee.
  const rawWidthMM = overallMaxX - overallMinX;
  const rawHeightMM = overallMaxY - overallMinY;
  const fitScale = Math.min(1, maxHeightMM / rawHeightMM);
  if (fitScale < 1) {
    mainGeom.scale(fitScale, fitScale, 1);
    if (loopGeom) loopGeom.scale(fitScale, fitScale, 1);
  }

  // ExtrudeGeometry emits non-indexed triangle soup, so plain computeVertexNormals() gives
  // every tiny wall segment its own flat facet — the curve is smooth but the shading looks
  // faceted. toCreasedNormals welds coincident vertices and averages normals across faces
  // below the crease angle, so the smoothed curve reads as a genuinely smooth surface while
  // real sharp corners (and the flat-top/wall edge) still shade as hard creases.
  const creaseAngle = (CORNER_ANGLE_DEG * Math.PI) / 180;
  mainGeom = toCreasedNormals(mainGeom, creaseAngle);
  if (loopGeom) loopGeom = toCreasedNormals(loopGeom, creaseAngle);

  const texture = new THREE.CanvasTexture(texCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const mainMaterial = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.65 });
  const loopMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65 });

  const group = new THREE.Group();
  group.add(new THREE.Mesh(mainGeom, mainMaterial));
  const geometries = [mainGeom];
  const materials = [mainMaterial];
  if (loopGeom) {
    group.add(new THREE.Mesh(loopGeom, loopMaterial));
    geometries.push(loopGeom);
    materials.push(loopMaterial);
  }

  return {
    group,
    geometries,
    materials,
    texture,
    widthMM: rawWidthMM * fitScale,
    heightMM: rawHeightMM * fitScale,
    thicknessMM,
  };
}

function disposeResult(result) {
  scene.remove(result.group);
  for (const g of result.geometries) g.dispose();
  for (const m of result.materials) m.dispose();
  result.texture.dispose();
}

function clearResult() {
  if (previousResult) disposeResult(previousResult);
  previousResult = null;
  hasFramedOnce = false;
  dimsEl.textContent = '';
  viewerPlaceholder.style.display = 'flex';
  viewerHint.style.display = 'none';
}

function showResult(result) {
  if (previousResult) disposeResult(previousResult);
  scene.add(result.group);
  previousResult = result;

  viewerPlaceholder.style.display = 'none';
  viewerHint.style.display = 'block';
  dimsEl.textContent = `${result.widthMM.toFixed(1)} mm × ${result.heightMM.toFixed(1)} mm × ${result.thicknessMM.toFixed(1)} mm`;

  if (!hasFramedOnce) {
    frameCamera(result.widthMM, result.heightMM);
    hasFramedOnce = true;
  }
}

function frameCamera(widthMM, heightMM) {
  const maxDim = Math.max(widthMM, heightMM);
  const dist = maxDim * 1.9 + 40;
  camera.position.set(0, 0, dist);
  camera.near = Math.max(0.1, dist / 100);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// Renders a fixed, straight-on view of the model (independent of however the user has
// orbited the viewer) to hand back alongside the STL, so the download always includes a
// quick visual reference of what was printed. Reuses the live scene/renderer rather than
// building a second one — cheaper, and guarantees the render matches the exported model.
function captureFrontRenderJPEG(result, size = 1024) {
  const maxDim = Math.max(result.widthMM, result.heightMM);
  const dist = maxDim * 1.9 + 40;
  const snapCamera = new THREE.PerspectiveCamera(40, 1, Math.max(0.1, dist / 100), dist * 20);
  snapCamera.position.set(0, 0, dist);
  snapCamera.lookAt(0, 0, 0);

  const prevBackground = scene.background;
  scene.background = new THREE.Color(0xffffff);
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.render(scene, snapCamera);
  const dataURL = renderer.domElement.toDataURL('image/jpeg', 0.9);

  // Restore the on-screen viewer state. No repaint happens between the render() above and
  // this one — both run synchronously in this same call — so the swap is invisible.
  scene.background = prevBackground;
  renderer.setPixelRatio(BASE_PIXEL_RATIO);
  resizeRenderer();
  renderer.render(scene, camera);

  return dataURL;
}

// --- export -----------------------------------------------------------------------------
function buildExportFilename(ext) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${ts}-Keychain.${ext}`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const canvasToBlob = (c, type) => new Promise((resolve, reject) => {
  c.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode the artwork image.'))), type);
});

let exporting = false;
async function exportPackage() {
  if (exporting) return;
  if (!editor.hasContent()) {
    showInfo('Add at least one image, text or shape layer first.');
    return;
  }
  exporting = true;
  downloadBtn.disabled = true;
  saveZipMenuBtn.disabled = true;
  const progress = showProgress('Generating keychain…');
  let mockupURL = null;
  try {
    if (dirty || !previousResult) await generate();
    if (dirty || !previousResult) throw new Error(statusEl.classList.contains('error') ? statusEl.textContent : 'Could not generate the keychain.');

    progress.update(0.3, 'Packaging…');
    const stlData = new STLExporter().parse(previousResult.group, { binary: true });
    // parse() returns a DataView for binary output; normalize to bytes JSZip can embed as-is.
    const stlBytes = ArrayBuffer.isView(stlData)
      ? new Uint8Array(stlData.buffer, stlData.byteOffset, stlData.byteLength)
      : new Uint8Array(stlData);
    const jpegDataURL = captureFrontRenderJPEG(previousResult);
    const jpegBase64 = jpegDataURL.slice(jpegDataURL.indexOf(',') + 1);
    mockupURL = jpegDataURL;

    const zip = new JSZip();
    zip.file('keychain-sticker.stl', stlBytes);
    zip.file('keychain-sticker-front.jpg', jpegBase64, { base64: true });
    const artwork = editor.renderComposite(COMPOSITE_MAX_DIM);
    if (artwork) zip.file('artwork.png', await canvasToBlob(artwork, 'image/png'));
    await editor.exportProject(zip, readSettings());

    progress.update(0.5, 'Compressing zip…');
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      meta => progress.update(0.5 + (meta.percent / 100) * 0.5)
    );
    progress.close();
    triggerDownload(zipBlob, buildExportFilename('zip'));
    await showImage('Export complete! Here is the front render that was packaged with your STL.', mockupURL);
  } catch (err) {
    console.error(err);
    progress.close();
    showInfo(err && err.message ? err.message : 'Export failed.');
  } finally {
    exporting = false;
    updateButtons();
  }
}
downloadBtn.addEventListener('click', exportPackage);
saveZipMenuBtn.addEventListener('click', exportPackage);

// --- project load ---------------------------------------------------------------------------
async function importProjectZip(file) {
  if (!file) return;
  if (editor.hasContent()) {
    const ok = await showConfirm('Loading a project replaces your current design. Continue?', 'Load project');
    if (!ok) return;
  }
  try {
    const zip = await JSZip.loadAsync(file);
    const settings = await editor.importProject(zip);
    applySettings(settings);
    clearResult();
    dirty = true;
    showTab('design');
    updateButtons();
  } catch (err) {
    console.error(err);
    showInfo(err && err.message ? err.message : "Couldn't load that project file.");
  }
}

const projectZipInput = $('projectZipInput');
const projectZipDropzone = $('projectZipDropzone');
projectZipInput.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  importProjectZip(file);
});
projectZipDropzone.addEventListener('click', () => projectZipInput.click());
projectZipDropzone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); projectZipInput.click(); }
});
['dragenter', 'dragover'].forEach(evt => projectZipDropzone.addEventListener(evt, e => {
  e.preventDefault();
  e.stopPropagation();
  projectZipDropzone.classList.add('dragover');
}));
['dragleave', 'dragend'].forEach(evt => projectZipDropzone.addEventListener(evt, e => {
  e.preventDefault();
  e.stopPropagation();
  projectZipDropzone.classList.remove('dragover');
}));
projectZipDropzone.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  projectZipDropzone.classList.remove('dragover');
  importProjectZip(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

// keep a stray file drop outside the drop targets from navigating the tab away
['dragover', 'drop'].forEach(evt => window.addEventListener(evt, e => {
  if (!document.querySelector('.stage-wrap').contains(e.target) && !projectZipDropzone.contains(e.target)) e.preventDefault();
}));

// --- menu bar ---------------------------------------------------------------------------------
const fileMenu = $('fileMenu');
const fileMenuBtn = $('fileMenuBtn');
function closeAllMenus() {
  document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
  fileMenuBtn.setAttribute('aria-expanded', 'false');
}
fileMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  const willOpen = !fileMenu.classList.contains('open');
  closeAllMenus();
  if (willOpen) {
    fileMenu.classList.add('open');
    fileMenuBtn.setAttribute('aria-expanded', 'true');
  }
});
$('addImageMenuItem').addEventListener('click', () => { closeAllMenus(); $('imageInput').click(); });
$('loadProjectZipMenuItem').addEventListener('click', () => { closeAllMenus(); projectZipInput.click(); });
document.addEventListener('click', closeAllMenus);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllMenus(); });

// light/dark theme toggle (defaults to dark; the inline script in <head> applies the
// saved/default theme before first paint)
const themeToggleBtn = $('themeToggleBtn');
function syncThemeIcon() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('themeIconMoon').style.display = isDark ? '' : 'none';
  $('themeIconSun').style.display = isDark ? 'none' : '';
  themeToggleBtn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  themeToggleBtn.setAttribute('aria-label', themeToggleBtn.title);
}
syncThemeIcon();
themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('gripCustomizerTheme', next); } catch (e) { /* ignore */ }
  syncThemeIcon();
  editor.redraw();
});

// --- pick up a project file handed off from the landing page, if any -------------------------------
function openHandoffDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('customizerHandoff', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('files'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function takePendingProjectFile() {
  return openHandoffDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    const getReq = store.get('pending');
    getReq.onsuccess = () => {
      const file = getReq.result;
      store.delete('pending');
      tx.oncomplete = () => resolve(file || null);
    };
    getReq.onerror = () => reject(getReq.error);
  }));
}
takePendingProjectFile().then(file => { if (file) importProjectZip(file); }).catch(err => console.error(err));

updateButtons();

})().catch(err => {
  console.error(err);
  const st = document.getElementById('status');
  if (st) { st.textContent = '3D preview could not load (check your internet connection).'; st.classList.add('error'); }
});
