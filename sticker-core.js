(function () {
// Pure, DOM-free image/geometry processing for the die-cut sticker generator.
// Works in the browser and in plain Node (used by test scripts).

/** Build a binary (0/1) inside/outside mask from RGBA pixel data. */
function alphaMaskFromRGBA(data, w, h, threshold = 16) {
  const mask = new Uint8Array(w * h);
  let allOpaque = true;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a !== 255) allOpaque = false;
  }
  if (allOpaque) {
    mask.fill(1);
    return { mask, fallbackRect: true };
  }
  for (let i = 0; i < w * h; i++) {
    mask[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
  }
  return { mask, fallbackRect: false };
}

/**
 * Zero out connected components of `1`s smaller than `minPixels`.
 * Filters stray single/few-pixel noise (compression halos, stray opaque pixels)
 * from a raw alpha mask before it gets inflated by the border dilation.
 */
function removeSmallComponents(mask, w, h, minPixels) {
  if (minPixels <= 1) return mask.slice();
  const visited = new Uint8Array(w * h);
  const out = mask.slice();
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (mask[start] !== 1 || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const component = [start];
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w, y = (idx / w) | 0;
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < w - 1 ? idx + 1 : -1,
        y > 0 ? idx - w : -1,
        y < h - 1 ? idx + w : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && mask[n] === 1 && !visited[n]) {
          visited[n] = 1;
          stack[sp++] = n;
          component.push(n);
        }
      }
    }
    if (component.length < minPixels) {
      for (const idx of component) out[idx] = 0;
    }
  }
  return out;
}

const EDT_INF = 1e20;

// Exact 1D squared-distance transform (Felzenszwalt & Huttenlocher lower-envelope-of-parabolas algorithm).
function dt1d(f, n, out, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      const fq = f[q] + q * q;
      const fv = f[v[k]] + v[k] * v[k];
      s = (fq - fv) / (2 * q - 2 * v[k]);
      if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    out[q] = dx * dx + f[v[k]];
  }
}

/** Exact squared-Euclidean-distance transform to the nearest `1` pixel in a binary mask. */
function edt(mask, w, h) {
  const g = new Float64Array(w * h);
  const maxDim = Math.max(w, h);
  const col = new Float64Array(maxDim);
  const colOut = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = mask[y * w + x] ? 0 : EDT_INF;
    dt1d(col, h, colOut, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = colOut[y];
  }

  const out = new Float64Array(w * h);
  const row = new Float64Array(maxDim);
  const rowOut = new Float64Array(maxDim);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = g[y * w + x];
    dt1d(row, w, rowOut, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = rowOut[x];
  }
  return out;
}

/** Exact circular dilation (grows the `1` region outward by `radius` px, Euclidean). */
function dilate(mask, w, h, radius) {
  if (radius <= 0) return mask.slice();
  const sq = edt(mask, w, h);
  const r2 = radius * radius;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = sq[i] <= r2 ? 1 : 0;
  return out;
}

/** Separable box blur (averaged `passes` times to approximate a Gaussian). Returns Float32Array 0..255. */
function boxBlur(mask01, w, h, radius, passes = 3) {
  const r = Math.max(0, Math.round(radius));
  let src = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) src[i] = mask01[i] * 255;
  if (r <= 0) return src;
  for (let p = 0; p < passes; p++) {
    src = boxBlurPass(src, w, h, r);
  }
  return src;
}

function boxBlurPass(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  boxBlur1D(src, w, h, r, tmp, true);
  boxBlur1D(tmp, w, h, r, out, false);
  return out;
}

function boxBlur1D(src, w, h, r, dst, horizontal) {
  const count = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const size = r * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const off = horizontal ? line * w : line;
    const stride = horizontal ? 1 : w;
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const idx = clamp(i, 0, count - 1);
      sum += src[off + idx * stride];
    }
    for (let i = 0; i < count; i++) {
      dst[off + i * stride] = sum / size;
      const addIdx = clamp(i + r + 1, 0, count - 1);
      const subIdx = clamp(i - r, 0, count - 1);
      sum += src[off + addIdx * stride] - src[off + subIdx * stride];
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Threshold a grayscale (0..255) buffer into a binary 0/1 mask, forcing a 1px zero border. */
function thresholdMask(gray, w, h, t = 127) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = gray[i] >= t ? 1 : 0;
  // Force outer ring to 0 so marching-squares contours never touch the canvas edge.
  for (let x = 0; x < w; x++) { out[x] = 0; out[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { out[y * w] = 0; out[y * w + w - 1] = 0; }
  return out;
}

// --- Marching squares -------------------------------------------------

const EDGE_TABLE = {
  0: [], 1: [['T', 'L']], 2: [['T', 'R']], 3: [['L', 'R']],
  4: [['R', 'B']], 5: [['T', 'L'], ['R', 'B']], 6: [['T', 'B']],
  7: [['L', 'B']], 8: [['L', 'B']], 9: [['T', 'B']],
  10: [['T', 'R'], ['L', 'B']], 11: [['R', 'B']], 12: [['L', 'R']],
  13: [['T', 'R']], 14: [['T', 'L']], 15: [],
};

function edgePoint(name, i, j) {
  switch (name) {
    case 'T': return [i + 0.5, j];
    case 'B': return [i + 0.5, j + 1];
    case 'L': return [i, j + 0.5];
    case 'R': return [i + 1, j + 0.5];
  }
}

function pointKey(x, y) {
  return Math.round(x * 2) + ',' + Math.round(y * 2);
}

/** Trace closed contours (arrays of {x,y} in pixel/grid coordinates) from a binary mask. */
function marchingSquares(mask, w, h) {
  const segments = []; // { a:[x,y], b:[x,y] }
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const tl = mask[j * w + i];
      const tr = mask[j * w + i + 1];
      const br = mask[(j + 1) * w + i + 1];
      const bl = mask[(j + 1) * w + i];
      const c = tl | (tr << 1) | (br << 2) | (bl << 3);
      const edges = EDGE_TABLE[c];
      for (const [e1, e2] of edges) {
        segments.push({ a: edgePoint(e1, i, j), b: edgePoint(e2, i, j) });
      }
    }
  }

  const pointMap = new Map(); // key -> [{segIdx, end}]
  segments.forEach((seg, idx) => {
    for (const end of ['a', 'b']) {
      const [x, y] = seg[end];
      const k = pointKey(x, y);
      if (!pointMap.has(k)) pointMap.set(k, []);
      pointMap.get(k).push({ segIdx: idx, end });
    }
  });

  const usedSeg = new Uint8Array(segments.length);
  const contours = [];

  for (let s = 0; s < segments.length; s++) {
    if (usedSeg[s]) continue;
    const contour = [];
    let curSeg = s;
    let curEnd = 'a'; // the endpoint we still need to continue *from* is the OTHER end
    let startKey = null;
    let guard = 0;
    while (true) {
      usedSeg[curSeg] = 1;
      const seg = segments[curSeg];
      const fromPt = seg[curEnd];
      const toEnd = curEnd === 'a' ? 'b' : 'a';
      const toPt = seg[toEnd];
      contour.push(fromPt);
      const toKey = pointKey(toPt[0], toPt[1]);
      if (startKey === null) startKey = pointKey(fromPt[0], fromPt[1]);
      if (toKey === startKey) {
        contour.push(toPt);
        break;
      }
      const candidates = pointMap.get(toKey) || [];
      const next = candidates.find(c => !usedSeg[c.segIdx]);
      if (!next) {
        // Shouldn't happen on well-formed data; close it off defensively.
        contour.push(toPt);
        break;
      }
      curSeg = next.segIdx;
      curEnd = next.end;
      if (++guard > segments.length + 5) break; // safety valve
    }
    if (contour.length >= 3) contours.push(contour.map(([x, y]) => ({ x, y })));
  }
  return contours;
}

/** Ramer-Douglas-Peucker polyline simplification (contour is a closed loop, first===last point). */
function simplifyContour(points, epsilon) {
  if (epsilon <= 0 || points.length <= 4) return points;
  // Split the closed loop at its two farthest-apart points to run RDP on two open chains.
  const n = points.length - 1; // last === first
  const open = points.slice(0, n);
  let maxD = -1, splitIdx = Math.floor(n / 2);
  for (let i = 1; i < n; i++) {
    const d = dist2(open[0], open[i]);
    if (d > maxD) { maxD = d; splitIdx = i; }
  }
  const chainA = rdp(open.slice(0, splitIdx + 1), epsilon);
  const chainB = rdp(open.slice(splitIdx), epsilon);
  const result = chainA.slice(0, -1).concat(chainB);
  result.push(result[0]);
  return result;
}

function dist2(p, q) { const dx = p.x - q.x, dy = p.y - q.y; return dx * dx + dy * dy; }

function rdp(points, epsilon) {
  if (points.length < 3) return points;
  let maxDist = -1, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > epsilon) {
    const left = rdp(points.slice(0, idx + 1), epsilon);
    const right = rdp(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt(dist2(p, a));
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const projX = a.x + t * dx, projY = a.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length - 1; i++) {
    area += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
  }
  return area / 2;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length - 1; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Classify raw contours into a shape/hole tree.
 * Returns an array of { outer: points, holes: [points,...] } (one entry per even-depth / "solid" contour).
 */
function classifyContours(contours, minArea = 4) {
  const items = contours
    .map(pts => ({ pts, area: Math.abs(polygonArea(pts)) }))
    .filter(it => it.area >= minArea);

  const n = items.length;
  const containsMatrix = Array.from({ length: n }, () => new Array(n).fill(false));
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      if (items[a].area <= items[b].area) continue; // a container must be bigger
      if (pointInPolygon(items[b].pts[0], items[a].pts)) containsMatrix[a][b] = true;
    }
  }
  const depth = items.map((_, b) => {
    let d = 0;
    for (let a = 0; a < n; a++) if (containsMatrix[a][b]) d++;
    return d;
  });

  const shapes = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) continue; // solids only
    shapes.push({ outer: items[i].pts, holes: [], _idx: i });
  }
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) continue; // holes only
    // immediate parent = smallest-area container with depth[i]-1
    let parent = -1, parentArea = Infinity;
    for (let a = 0; a < n; a++) {
      if (containsMatrix[a][i] && depth[a] === depth[i] - 1 && items[a].area < parentArea) {
        parent = a; parentArea = items[a].area;
      }
    }
    if (parent >= 0) {
      const shape = shapes.find(s => s._idx === parent);
      if (shape) shape.holes.push(items[i].pts);
    }
  }
  shapes.forEach(s => delete s._idx);
  return shapes;
}

// --- Corner-preserving curve smoothing -----------------------------------
// A simplified polygon is still a set of straight segments — tracing it at a higher
// raster resolution only samples the same jagged boundary more finely, it never makes
// it curve-smooth. This section fits an actual smooth (Catmull-Rom) curve through runs
// of points that represent a gentle arc, while leaving genuine sharp corners (star tips,
// square edges) untouched as hard vertices instead of rounding them off.

function turnAngleDeg(prev, cur, next) {
  const v1x = cur.x - prev.x, v1y = cur.y - prev.y;
  const v2x = next.x - cur.x, v2y = next.y - cur.y;
  const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y);
  if (len1 < 1e-9 || len2 < 1e-9) return 0;
  const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
}

function catmullRom1D(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function catmullRomPoint(p0, p1, p2, p3, t) {
  return {
    x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
    y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
  };
}

// Open chain (does not wrap): clamps the two end segments so the curve starts and ends
// exactly on points[0] and points[points.length - 1] with a sensible tangent.
function smoothOpenChain(points, samplesPerSegment) {
  const m = points.length;
  if (m < 3) return points.slice();
  const out = [];
  for (let i = 0; i < m - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(m - 1, i + 2)];
    for (let s = 0; s < samplesPerSegment; s++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / samplesPerSegment));
    }
  }
  out.push(points[m - 1]);
  return out;
}

// Fully closed chain (wraps around): used when no hard corners were found at all.
function smoothClosedChain(points, samplesPerSegment) {
  const n = points.length;
  if (n < 3) return points.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < samplesPerSegment; s++) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / samplesPerSegment));
    }
  }
  return out;
}

/**
 * Smooths a closed polygon into curves while preserving genuine sharp corners.
 * `points` is an open point list (no duplicated first/last) representing a closed loop.
 * Points whose local turn angle exceeds `cornerAngleDeg` are kept as hard vertices;
 * runs of points between corners are replaced with a smooth Catmull-Rom curve through
 * the same points (so the curve still follows the traced silhouette, it just stops
 * faceting it).
 */
function smoothPolygon(points, { cornerAngleDeg = 30, samplesPerSegment = 12 } = {}) {
  const n = points.length;
  if (n < 4 || samplesPerSegment <= 1) return points.slice();

  const cornerIdx = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    if (turnAngleDeg(prev, points[i], next) > cornerAngleDeg) cornerIdx.push(i);
  }

  if (cornerIdx.length === 0) {
    return smoothClosedChain(points, samplesPerSegment);
  }

  if (cornerIdx.length === 1) {
    const startIdx = cornerIdx[0];
    const chain = [];
    for (let i = 0; i <= n; i++) chain.push(points[(startIdx + i) % n]);
    const smoothed = smoothOpenChain(chain, samplesPerSegment);
    return smoothed.slice(0, -1);
  }

  const result = [];
  const k = cornerIdx.length;
  for (let c = 0; c < k; c++) {
    const startIdx = cornerIdx[c];
    const endIdx = cornerIdx[(c + 1) % k];
    const chain = [points[startIdx]];
    let idx = startIdx;
    while (idx !== endIdx) {
      idx = (idx + 1) % n;
      chain.push(points[idx]);
    }
    const smoothed = smoothOpenChain(chain, samplesPerSegment);
    for (let i = 0; i < smoothed.length - 1; i++) result.push(smoothed[i]);
  }
  return result;
}

window.StickerCore = { alphaMaskFromRGBA, removeSmallComponents, edt, dilate, boxBlur, thresholdMask, marchingSquares, simplifyContour, polygonArea, classifyContours, smoothPolygon };
})();
