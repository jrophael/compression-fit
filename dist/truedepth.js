'use strict';

/*
 * Face ID (TrueDepth) depth scan measurement: TEST MODE, Ireland, UK and EU only.
 *
 * The iPhone's front TrueDepth camera (structured light) gives fine depth at 20–50 cm on
 * every Face ID iPhone, not just LiDAR Pro models. It cannot track its own position, so the
 * app takes two still captures with the screen facing the leg, held about 40 cm away:
 * one from the front of the shin and one from the outer side. Each capture is the average
 * of several depth frames, sent as points in that capture's camera frame.
 *
 * Method, per capture
 *  1. Keep the nearest surface (the leg): points within 12 cm behind the nearest 2%.
 *  2. Leg axis = main axis of the points (PCA). Width direction = perpendicular to the
 *     axis and to the viewing direction.
 *  3. Every 1 cm along the axis, the slice's outline is measured as an angle from the
 *     camera (0.5th to 99.5th percentile), which flying pixels cannot widen. The camera
 *     sees less than half the leg: perspective hides the far sides, and surface steeper
 *     than about 80° to the view returns no depth. `sliceWidth` solves that geometry for
 *     a round section at the slice's distance. Profiles are median-smoothed.
 *  4. Ankle = narrowest slice; calf = widest slice at least 8 cm from it. The calf
 *     is above the ankle, which fixes which way is up.
 *
 * Combining the captures: the front capture gives the side-to-side width and the side
 * capture gives the front-to-back depth. Each view's widths are then re-solved as ovals
 * using the other view's depth (two rounds). Profiles are aligned at the ankle, and at each
 * height the circumference is that of an ellipse with those two diameters (Ramanujan).
 * Ankle = smallest circumference within 6 cm of the aligned ankle; calf = largest
 * circumference 8 cm or more above it.
 *
 * The camera never measures length: use tape or the AR length ruler.
 */

const DEPTH_UNITS_PER_METRE = 4000;     // Int16 values in 0.25 mm units, as for LiDAR scans
const EDGE_ANGLE = 80 * Math.PI / 180;  // surface steeper than this to the view is not captured
const SLICE_STEP = 0.01;

function decodeDepthPoints(encoded) {
  let ints;
  if (typeof encoded === 'string') {
    const binary = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ints = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  } else if (Array.isArray(encoded)) {
    ints = encoded;
  } else {
    throw new Error('The depth capture has no points.');
  }
  const points = [];
  for (let i = 0; i + 2 < ints.length; i += 3) {
    points.push([ints[i] / DEPTH_UNITS_PER_METRE, ints[i + 1] / DEPTH_UNITS_PER_METRE, ints[i + 2] / DEPTH_UNITS_PER_METRE]);
  }
  return points;
}

function encodeDepthPoints(points) {
  const ints = new Int16Array(points.length * 3);
  points.forEach((p, i) => p.forEach((v, j) => { ints[i * 3 + j] = Math.round(v * DEPTH_UNITS_PER_METRE); }));
  const bytes = new Uint8Array(ints.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

const quantile = (sorted, q) => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, low = Math.floor(pos), high = Math.ceil(pos);
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

// Largest-eigenvalue eigenvector of a 3×3 symmetric matrix (power iteration).
function principalAxis(points) {
  const n = points.length;
  const mean = [0, 1, 2].map(k => points.reduce((s, p) => s + p[k], 0) / n);
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of points) {
    const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += d[i] * d[j] / n;
  }
  let v = [0.3, 1, 0.2];
  for (let k = 0; k < 60; k++) {
    v = norm([dot(c[0], v), dot(c[1], v), dot(c[2], v)]);
  }
  return {mean, axis: v};
}

/*
 * Edge of the visible surface of a round section of radius r whose centre is d from the
 * camera, when surface steeper than EDGE_ANGLE to the line of sight returns no depth.
 * A point at angle φ from the camera-facing side is seen if
 * (d·cos φ − r) / |camera − point| ≥ cos EDGE_ANGLE. Returns the edge point's sideways
 * offset and its distance from the camera.
 */
function visibleEdge(r, d, depthRadius = r) {
  // Oval section: sideways semi-axis r, front-to-back semi-axis depthRadius, centre d away.
  const a = r, b = depthRadius, limit = Math.cos(EDGE_ANGLE);
  let low = 0, high = Math.PI;
  for (let k = 0; k < 40; k++) {
    const phi = (low + high) / 2;
    const px = a * Math.sin(phi), pz = d - b * Math.cos(phi);         // surface point
    const nx = Math.sin(phi) / a, nz = -Math.cos(phi) / b;             // outward normal
    const vx = -px, vz = -pz;                                          // towards the camera
    const seen = (nx * vx + nz * vz) / (Math.hypot(nx, nz) * Math.hypot(vx, vz)) >= limit;
    if (seen) low = phi; else high = phi;
  }
  return {sideways: a * Math.sin(low), depth: d - b * Math.cos(low)};
}

/*
 * Width of one slice, measured as an angle seen from the camera.
 *
 * Flying pixels (depth readings at the leg's edges that land too far back) lie along the
 * camera ray behind the true edge, so in angle they never reach past the true outline.
 * The angular half-extent β of the slice and its nearest surface distance f fix the
 * radius of a round section: solve atan(sideways / depth) = β with d = f + r.
 */
function solveWidth(beta, nearest, depthRadius = null) {
  let low = 0.003, high = 0.2;
  for (let k = 0; k < 50; k++) {
    const r = (low + high) / 2;
    const b = depthRadius ?? r;
    const edge = visibleEdge(r, nearest + b, b);
    if (Math.atan2(edge.sideways, edge.depth) < beta) low = r; else high = r;
  }
  return low + high;   // 2r
}

function sliceExtent(angles) {
  const sorted = [...angles].sort((a, b) => a - b);
  return (quantile(sorted, 0.995) - quantile(sorted, 0.005)) / 2;
}

const median3 = values => values.map((v, i) => {
  const window = [values[i - 1], v, values[i + 1]].filter(Number.isFinite);
  return window.sort((a, b) => a - b)[Math.floor(window.length / 2)];
});

/*
 * One capture → width profile along the leg.
 * Returns {heights (m, 0 at the ankle, up positive), widths (m), ankleIndex, calfIndex, pointCount}.
 */
function widthProfile(rawPoints) {
  const inRange = rawPoints.filter(p => p[2] > 0.1 && p[2] < 0.8);
  if (inRange.length < 500) throw new Error('Too few depth points. Hold the phone about 40 cm from the leg.');
  const depths = inRange.map(p => p[2]).sort((a, b) => a - b);
  const nearest = quantile(depths, 0.02);
  const leg = inRange.filter(p => p[2] < nearest + 0.12);
  const {mean, axis} = principalAxis(leg);
  const across = norm(cross(axis, [0, 0, 1]));
  const along = leg.map(p => dot([p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]], axis));
  // Angle across the leg as the camera sees it (pinhole camera at the origin, looking along z).
  // Using the camera's own z, not a direction tilted with the leg, keeps this a true image angle.
  const lateral = leg.map(p => Math.atan2(dot(p, across), p[2]));
  const low = Math.min(...along), high = Math.max(...along);
  if (high - low < 0.2) throw new Error('Less than 20 cm of leg was in view. Hold the phone a little further away, centred on the calf.');
  const bins = Math.floor((high - low) / SLICE_STEP);
  const slices = Array.from({length: bins}, () => ({lateral: [], depth: []}));
  along.forEach((s, i) => {
    const b = Math.min(bins - 1, Math.floor((s - low) / SLICE_STEP));
    slices[b].lateral.push(lateral[i]);
    slices[b].depth.push(leg[i][2]);
  });
  // Per slice: angular half-extent and nearest surface distance (kept for the oval refinement).
  const extents = slices.map(({lateral: angles, depth: zs}) => {
    if (angles.length < 40) return null;
    zs.sort((a, b) => a - b);
    // A floor or other surface in the slice spreads far in depth; half a leg does not.
    if (quantile(zs, 0.98) - quantile(zs, 0.02) > 0.11) return null;
    return {beta: sliceExtent(angles), nearest: quantile(zs, 0.02)};
  });
  let widths = extents.map(e => e ? solveWidth(e.beta, e.nearest) : NaN);
  widths = median3(widths);
  const positions = widths.map((_, i) => low + (i + 0.5) * SLICE_STEP);
  // Ankle: narrowest. Calf: widest at least 8 cm away. Calf is above the ankle.
  const valid = widths.map((w, i) => Number.isFinite(w) ? i : -1).filter(i => i >= 0);
  if (valid.length < 15) throw new Error('The leg outline was too patchy. Keep the phone steady and the leg bare.');
  const ankleIndex = valid.reduce((best, i) => widths[i] < widths[best] ? i : best, valid[0]);
  const far = valid.filter(i => Math.abs(positions[i] - positions[ankleIndex]) >= 0.08);
  if (!far.length) throw new Error('The ankle and calf were not both in view. Centre the phone on the calf.');
  const calfIndex = far.reduce((best, i) => widths[i] > widths[best] ? i : best, far[0]);
  const up = positions[calfIndex] > positions[ankleIndex] ? 1 : -1;
  const heights = positions.map(s => (s - positions[ankleIndex]) * up);
  return {heights, widths, extents, ankleIndex, calfIndex, pointCount: leg.length};
}

// Re-solve one view's widths as ovals, taking the front-to-back size from the other view.
function refineWidths(profile, other) {
  const widths = profile.extents.map((e, i) => {
    if (!e) return NaN;
    const depthWidth = widthAt(other, profile.heights[i]);
    return Number.isFinite(depthWidth) ? solveWidth(e.beta, e.nearest, depthWidth / 2) : profile.widths[i];
  });
  return {...profile, widths: median3(widths)};
}

// Ramanujan's ellipse perimeter from two diameters.
function ellipseCircumference(widthA, widthB) {
  const a = widthA / 2, b = widthB / 2;
  const h = ((a - b) ** 2) / ((a + b) ** 2);
  return Math.PI * (a + b) * (1 + 3 * h / (10 + Math.sqrt(4 - 3 * h)));
}

// Width at a height (linear interpolation), NaN outside the profile.
function widthAt(profile, height) {
  const {heights, widths} = profile;
  const order = heights.map((h, i) => i).sort((i, j) => heights[i] - heights[j]);
  for (let k = 0; k + 1 < order.length; k++) {
    const i = order[k], j = order[k + 1];
    if (height >= heights[i] && height <= heights[j] && Number.isFinite(widths[i]) && Number.isFinite(widths[j])) {
      const t = heights[j] === heights[i] ? 0 : (height - heights[i]) / (heights[j] - heights[i]);
      return widths[i] + (widths[j] - widths[i]) * t;
    }
  }
  return NaN;
}

/*
 * Two captures → circumferences in centimetres.
 * capture = {name: 'front'|'side', points: base64 Int16 or flat array}.
 */
function measureTrueDepth(captures) {
  const front = captures.find(c => c.name === 'front');
  const side = captures.find(c => c.name === 'side');
  if (!front || !side) throw new Error('Both captures are needed: front and side.');
  let f = widthProfile(decodeDepthPoints(front.points));
  let s = widthProfile(decodeDepthPoints(side.points));
  // Real sections are oval: each view's depth comes from the other view. Two rounds settle it.
  for (let round = 0; round < 2; round++) {
    const nextF = refineWidths(f, s), nextS = refineWidths(s, f);
    f = nextF; s = nextS;
  }
  const circumferenceAt = h => {
    const wf = widthAt(f, h), ws = widthAt(s, h);
    return Number.isFinite(wf) && Number.isFinite(ws) ? ellipseCircumference(wf, ws) : NaN;
  };
  const sample = (from, to) => {
    const values = [];
    for (let h = from; h <= to + 1e-9; h += 0.005) {
      const c = circumferenceAt(h);
      if (Number.isFinite(c)) values.push([h, c]);
    }
    return values;
  };
  const ankleWindow = sample(-0.06, 0.06);
  const calfWindow = sample(0.08, 0.40);
  if (ankleWindow.length < 5 || calfWindow.length < 5) {
    throw new Error('The two captures did not overlap enough. Keep the same distance and height for both.');
  }
  const [ankleHeight, ankle] = ankleWindow.reduce((best, v) => v[1] < best[1] ? v : best);
  const [calfHeight, calf] = calfWindow.reduce((best, v) => v[1] > best[1] ? v : best);
  // Agreement check: the side-to-side and front-to-back widths of a lower leg differ by
  // well under 35%; more suggests the captures were misaligned or a capture caught the other leg.
  const ratio = (h) => widthAt(f, h) / widthAt(s, h);
  const ratios = [ratio(ankleHeight), ratio(calfHeight)];
  const plausible = ratios.every(r => r > 0.65 && r < 1.55);
  return {
    ankle: Math.round(ankle * 1000) / 10,
    calf: Math.round(calf * 1000) / 10,
    calfAboveAnkle: Math.round((calfHeight - ankleHeight) * 1000) / 10,
    widths: {
      ankle: [widthAt(f, ankleHeight), widthAt(s, ankleHeight)].map(w => Math.round(w * 1000) / 10),
      calf: [widthAt(f, calfHeight), widthAt(s, calfHeight)].map(w => Math.round(w * 1000) / 10)
    },
    plausible,
    pointCounts: [f.pointCount, s.pointCount]
  };
}

if (typeof module !== 'undefined') {
  module.exports = {measureTrueDepth, widthProfile, ellipseCircumference, decodeDepthPoints, encodeDepthPoints, principalAxis, solveWidth};
}
