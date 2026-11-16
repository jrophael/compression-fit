'use strict';

/*
 * LiDAR leg scan measurement.
 *
 * Input comes from the Compression Fit iPhone app (see ios/). The app captures a
 * point cloud of one lower leg with the iPhone LiDAR sensor and sends it here.
 * All measurement maths lives in this file so it can be tested in Node and
 * updated without an app release.
 *
 * Coordinate frame (metres): origin on the floor directly below the tapped cuff
 * point, y up (gravity aligned), x and z horizontal. The cuff point is (0, cuffHeight, 0).
 *
 * Method
 *  1. Track the leg up from the floor in horizontal slices, choosing the cluster
 *     of points nearest the previous slice so the other leg and the floor are ignored.
 *  2. Fit a straight leg axis through the slice centres.
 *  3. Cut thin slices perpendicular to that axis. In each slice, fit a smooth
 *     closed outline (radius as a Fourier series in angle, refitted without
 *     strays) and measure its convex hull perimeter. A tape bridges hollows in
 *     the same way, so the convex hull perimeter is the tape-equivalent
 *     circumference. Slices with less than 75% coverage or a gap over 45° are skipped.
 *  4. Ankle = smallest circumference 5–22 cm above the floor. Calf = largest
 *     circumference between the ankle and the cuff. Each value comes from a
 *     parabola fitted to the nearby slices. Length = cuff point height.
 */

const SCAN_FORMAT_VERSION = 1;
const SCAN_UNITS_PER_METRE = 4000; // Int16 values are in 0.25 mm units
const MIN_COVERAGE = 0.75;         // share of sectors that must contain surface points

function decodeScan(scan) {
  if (!scan || scan.version !== SCAN_FORMAT_VERSION) throw new Error('Unsupported scan file version.');
  if (!scan.autoLength && !(scan.cuffHeight > 0.15 && scan.cuffHeight < 0.8)) throw new Error('The cuff point height is outside 15–80 cm.');
  let ints;
  if (typeof scan.points === 'string') {
    const binary = typeof atob === 'function' ? atob(scan.points) : Buffer.from(scan.points, 'base64').toString('binary');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ints = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  } else {
    ints = Int16Array.from(scan.points);
  }
  const count = Math.floor(ints.length / 3);
  if (count < 2000) throw new Error('Too few surface points. Scan slowly all the way around the leg.');
  const points = new Float64Array(count * 3);
  for (let i = 0; i < count * 3; i++) points[i] = ints[i] / SCAN_UNITS_PER_METRE;
  return {points, count, cuffHeight: scan.cuffHeight};
}

function encodeScanPoints(points) {
  // Test helper: Float64Array of metres -> base64 Int16 in 0.25 mm units.
  const ints = new Int16Array(points.length);
  for (let i = 0; i < points.length; i++) ints[i] = Math.round(points[i] * SCAN_UNITS_PER_METRE);
  const bytes = new Uint8Array(ints.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

// Group 2D points into clusters on a 1 cm grid (8-connected cells).
function clusters2D(us, vs, cell = 0.01) {
  const cells = new Map();
  for (let i = 0; i < us.length; i++) {
    const key = Math.floor(us[i] / cell) + ',' + Math.floor(vs[i] / cell);
    let list = cells.get(key);
    if (!list) cells.set(key, list = []);
    list.push(i);
  }
  const seen = new Set();
  const groups = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    const members = [];
    while (stack.length) {
      const key = stack.pop();
      members.push(...cells.get(key));
      const [cu, cv] = key.split(',').map(Number);
      for (let du = -1; du <= 1; du++) {
        for (let dv = -1; dv <= 1; dv++) {
          const next = (cu + du) + ',' + (cv + dv);
          if (cells.has(next) && !seen.has(next)) { seen.add(next); stack.push(next); }
        }
      }
    }
    let su = 0, sv = 0;
    for (const i of members) { su += us[i]; sv += vs[i]; }
    groups.push({members, u: su / members.length, v: sv / members.length});
  }
  return groups;
}

function nearestCluster(groups, u, v, minPoints) {
  let best = null, bestDistance = Infinity;
  for (const group of groups) {
    if (group.members.length < minPoints) continue;
    const distance = Math.hypot(group.u - u, group.v - v);
    if (distance < bestDistance) { best = group; bestDistance = distance; }
  }
  return best && {group: best, distance: bestDistance};
}

function convexHullPerimeter(pts) {
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let perimeter = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    perimeter += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return perimeter;
}

const median = values => {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Solve a small symmetric linear system (Gaussian elimination with partial pivoting).
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]];
    const d = M[i][i];
    if (Math.abs(d) < 1e-14) return null;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = M[k][i] / d;
      for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

const HARMONICS = 8;
const SECTOR_COUNT = 36; // 10° sectors for the coverage check

// Least-squares fit of radius r(θ) = c0 + Σ ak cos kθ + bk sin kθ, robust to strays.
function fitOutline(us, vs, cu, cv) {
  const n = us.length;
  const angles = new Float64Array(n), radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    angles[i] = Math.atan2(vs[i] - cv, us[i] - cu);
    radii[i] = Math.hypot(us[i] - cu, vs[i] - cv);
  }
  const m = 2 * HARMONICS + 1;
  let weights = new Float64Array(n).fill(1);
  let coef = null;
  for (let pass = 0; pass < 4; pass++) {
    const A = Array.from({length: m}, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    const row = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      if (!weights[i]) continue;
      row[0] = 1;
      for (let k = 1; k <= HARMONICS; k++) { row[2 * k - 1] = Math.cos(k * angles[i]); row[2 * k] = Math.sin(k * angles[i]); }
      for (let a = 0; a < m; a++) {
        b[a] += weights[i] * row[a] * radii[i];
        for (let c = a; c < m; c++) A[a][c] += weights[i] * row[a] * row[c];
      }
    }
    // Mild smoothing penalty on higher harmonics keeps gaps from oscillating.
    const total = weights.reduce((s, w) => s + w, 0);
    for (let a = 0; a < m; a++) {
      for (let c = 0; c < a; c++) A[a][c] = A[c][a];
      const k = Math.ceil(a / 2);
      A[a][a] += total * 1e-5 * k ** 4;
    }
    coef = solve(A, b);
    if (!coef) return null;
    // Re-weight: drop points more than 3 robust SDs from the curve.
    const residuals = new Float64Array(n);
    for (let i = 0; i < n; i++) residuals[i] = radii[i] - radiusAt(coef, angles[i]);
    const absolute = Array.from(residuals, Math.abs);
    const mad = median(absolute) * 1.4826 || 0.001;
    weights = weights.map((_, i) => absolute[i] <= Math.max(3 * mad, 0.002) ? 1 : 0);
  }
  return coef;
}

function radiusAt(coef, angle) {
  let r = coef[0];
  for (let k = 1; k <= HARMONICS; k++) r += coef[2 * k - 1] * Math.cos(k * angle) + coef[2 * k] * Math.sin(k * angle);
  return r;
}

// Tape-equivalent circumference of one cross-section from surface points (u, v).
function sectionCircumference(us, vs) {
  let cu = 0, cv = 0;
  for (let i = 0; i < us.length; i++) { cu += us[i]; cv += vs[i]; }
  cu /= us.length; cv /= us.length;
  let coef = null, outline = null;
  // Re-centre on the fitted outline, since a partial scan biases the plain centroid.
  for (let pass = 0; pass < 3; pass++) {
    coef = fitOutline(us, vs, cu, cv);
    if (!coef) return {circumference: null, coverage: 0};
    outline = [];
    for (let k = 0; k < 360; k++) {
      const angle = k / 360 * 2 * Math.PI - Math.PI, r = radiusAt(coef, angle);
      outline.push([cu + r * Math.cos(angle), cv + r * Math.sin(angle)]);
    }
    let area = 0, sx = 0, sy = 0;
    for (let k = 0; k < outline.length; k++) {
      const [x0, y0] = outline[k], [x1, y1] = outline[(k + 1) % outline.length];
      const cross = x0 * y1 - x1 * y0;
      area += cross; sx += (x0 + x1) * cross; sy += (y0 + y1) * cross;
    }
    if (Math.abs(area) < 1e-9) return {circumference: null, coverage: 0};
    cu = sx / (3 * area); cv = sy / (3 * area);
  }
  // Coverage: share of 10° sectors around the centre that contain surface points.
  const hits = new Array(SECTOR_COUNT).fill(0);
  for (let i = 0; i < us.length; i++) {
    const angle = Math.atan2(vs[i] - cv, us[i] - cu) + Math.PI;
    hits[Math.min(SECTOR_COUNT - 1, Math.floor(angle / (2 * Math.PI) * SECTOR_COUNT))]++;
  }
  const coverage = hits.filter(h => h > 0).length / SECTOR_COUNT;
  let longestGap = 0, run = 0;
  for (let k = 0; k < 2 * SECTOR_COUNT; k++) {
    run = hits[k % SECTOR_COUNT] ? 0 : run + 1;
    longestGap = Math.max(longestGap, Math.min(run, SECTOR_COUNT));
  }
  if (coverage < MIN_COVERAGE || longestGap * 360 / SECTOR_COUNT > 45) return {circumference: null, coverage};
  if (outline.some(([x, y]) => !Number.isFinite(x + y))) return {circumference: null, coverage};
  // Shape check: a leg section is roughly round (width up to about 1.6 x depth).
  // A much flatter outline means only one side of the leg was captured.
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of outline) { sxx += (x - cu) ** 2; syy += (y - cv) ** 2; sxy += (x - cu) * (y - cv); }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const aspect = l2 > 0 ? Math.sqrt(l1 / l2) : Infinity;
  if (aspect > 2.2) return {circumference: null, coverage, flat: true};
  return {circumference: convexHullPerimeter(outline), coverage};
}

// Value at a profile minimum or maximum, from a parabola fitted to nearby sections.
function landmarkValue(profile, centre, halfWidth) {
  const near = profile.filter(p => p.circumference !== null && Math.abs(p.height - centre) <= halfWidth);
  if (near.length < 5) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of near) {
    const x = p.height - centre, y = p.circumference;
    s0++; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4; t0 += y; t1 += x * y; t2 += x * x * y;
  }
  const c = solve([[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]], [t2, t1, t0]);
  if (!c) return null;
  const [a, b, k] = c;
  const vertex = Math.abs(a) > 1e-9 ? -b / (2 * a) : 0;
  const x = Math.max(-halfWidth, Math.min(halfWidth, vertex));
  return a * x * x + b * x + k;
}

/*
 * Length from the scan (no cuff point): follow the leg upward in horizontal slices
 * until it can no longer be separated, then find the narrowing just below the knee,
 * the smallest circumference above the calf that is followed by the knee widening
 * (at least 0.8 cm within 6 cm). Its height is the cuff height.
 * Returns {height, profile} or null when the scan does not reach above the knee.
 */
function findCuffHeight(xs, ys, zs, count) {
  const byHeight = new Map();
  for (let i = 0; i < count; i++) {
    const key = Math.round(ys[i] / 0.01);
    if (Math.abs(ys[i] - key * 0.01) > 0.003) continue;
    let list = byHeight.get(key);
    if (!list) byHeight.set(key, list = []);
    list.push(i);
  }
  const rows = [];
  let previous = {u: 0, v: 0};
  for (let key = 8; key <= 75; key++) {
    const ids = byHeight.get(key) || [];
    if (ids.length < 30) { if (rows.length) break; continue; }
    const found = nearestCluster(clusters2D(ids.map(i => xs[i]), ids.map(i => zs[i])), previous.u, previous.v, 20);
    // Stop where the leg merges with the other leg or the scan ends.
    if (!found || (rows.length && found.distance > 0.03)) break;
    const section = sectionCircumference(found.group.members.map(k => xs[ids[k]]), found.group.members.map(k => zs[ids[k]]));
    if (section.circumference === null) break;
    if (rows.length && Math.abs(section.circumference - rows[rows.length - 1].c) > 0.025) break;
    previous = {u: found.group.u, v: found.group.v};
    rows.push({h: key * 0.01, c: section.circumference});
  }
  if (rows.length < 20) return null;
  const c = rows.map((r, i) => median(rows.slice(Math.max(0, i - 1), i + 2).map(x => x.c)));
  for (let i = 1; i < rows.length - 1; i++) {
    if (rows[i].h < 0.25) continue;
    if (!(c[i] <= c[i - 1] && c[i] <= c[i + 1])) continue;
    const below = Math.max(...c.slice(0, i).filter((_, k) => rows[k].h >= 0.15));
    const above = c.slice(i + 1).filter((_, k) => rows[i + 1 + k].h <= rows[i].h + 0.06);
    if (below - c[i] >= 0.01 && above.length && Math.max(...above) - c[i] >= 0.008) {
      // Sub-centimetre position from a parabola through the neighbouring slices.
      const curvature = c[i - 1] - 2 * c[i] + c[i + 1];
      const offset = curvature > 1e-6 ? Math.max(-0.5, Math.min(0.5, (c[i - 1] - c[i + 1]) / (2 * curvature))) : 0;
      return {height: rows[i].h + offset * 0.01, profile: rows.map((r, k) => ({height: r.h * 100, circumference: c[k] * 100}))};
    }
  }
  return null;
}

function measureScan(scan) {
  const decoded = decodeScan(scan);
  const {points, count} = decoded;
  let cuffHeight = decoded.cuffHeight;
  const xs = new Float64Array(count), ys = new Float64Array(count), zs = new Float64Array(count);
  for (let i = 0; i < count; i++) { xs[i] = points[3 * i]; ys[i] = points[3 * i + 1]; zs[i] = points[3 * i + 2]; }
  const warnings = [];
  let lengthSource = 'cuff point';
  if (scan.autoLength) {
    const knee = findCuffHeight(xs, ys, zs, count);
    if (!knee) throw new Error('The length could not be found from this scan. Scan up to just above the knee with the knees apart, or enter the Length by tape.');
    cuffHeight = knee.height;
    lengthSource = 'scan';
  }

  // 1. Horizontal slices from the cuff down, following the leg.
  const byHeight = new Map();
  for (let i = 0; i < count; i++) {
    const key = Math.round(ys[i] / 0.01);
    let list = byHeight.get(key);
    if (!list) byHeight.set(key, list = []);
    list.push(i);
  }
  const centres = [];
  let previous = {u: 0, v: 0};
  for (let key = Math.round((cuffHeight - 0.01) / 0.01); key >= 4; key--) {
    const ids = byHeight.get(key) || [];
    if (ids.length < 30) continue;
    const found = nearestCluster(clusters2D(ids.map(i => xs[i]), ids.map(i => zs[i])), previous.u, previous.v, 20);
    if (!found || (centres.length && found.distance > 0.06)) continue;
    previous = {u: found.group.u, v: found.group.v};
    centres.push({h: key * 0.01, x: found.group.u, z: found.group.v});
  }
  const fitCentres = centres.filter(c => c.h >= 0.10 && c.h <= cuffHeight - 0.03);
  if (fitCentres.length < 8) throw new Error('The leg could not be followed from ankle to cuff. Rescan with the legs apart.');

  // 2. Straight leg axis: x = ax + bx*h, z = az + bz*h.
  const fitLine = key => {
    const n = fitCentres.length;
    const mh = fitCentres.reduce((s, c) => s + c.h, 0) / n;
    const mk = fitCentres.reduce((s, c) => s + c[key], 0) / n;
    let num = 0, den = 0;
    for (const c of fitCentres) { num += (c.h - mh) * (c[key] - mk); den += (c.h - mh) ** 2; }
    const slope = num / den;
    return [mk - slope * mh, slope];
  };
  const [ax, bx] = fitLine('x'), [az, bz] = fitLine('z');
  const norm = Math.hypot(bx, 1, bz);
  const axis = [bx / norm, 1 / norm, bz / norm];
  const tilt = Math.acos(axis[1]) * 180 / Math.PI;
  if (tilt > 20) throw new Error('The leg is tilted by ' + tilt.toFixed(0) + '°. Scan the wearer standing upright with weight on both feet, not sitting.');
  if (tilt > 12) warnings.push('The leg looked tilted by ' + tilt.toFixed(0) + '°. Stand upright with weight on both feet.');
  // Basis perpendicular to the axis.
  let e1 = [axis[1], -axis[0], 0];
  const e1n = Math.hypot(...e1); e1 = e1.map(x => x / e1n);
  const e2 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];

  // Axial coordinate of every point, measured along the axis from the floor point of the axis.
  const t = new Float64Array(count), u = new Float64Array(count), v = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - ax, dy = ys[i], dz = zs[i] - az;
    t[i] = dx * axis[0] + dy * axis[1] + dz * axis[2];
    // Offset from the axis point at this height.
    const px = dx - t[i] * axis[0], py = dy - t[i] * axis[1], pz = dz - t[i] * axis[2];
    u[i] = px * e1[0] + py * e1[1] + pz * e1[2];
    v[i] = px * e2[0] + py * e2[1] + pz * e2[2];
  }
  const step = 0.005, half = 0.003;
  const buckets = new Map();
  for (let i = 0; i < count; i++) {
    const key = Math.round(t[i] / step);
    if (Math.abs(t[i] - key * step) > half) continue;
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(i);
  }

  // 3. Circumference profile along the leg. Heights are vertical heights above the floor.
  const profile = [];
  const top = (cuffHeight - 0.01) / axis[1];
  for (let key = Math.round(0.04 / step); key * step <= top; key++) {
    const ids = buckets.get(key) || [];
    const height = key * step * axis[1];
    if (ids.length < 40) { profile.push({height, circumference: null, coverage: 0}); continue; }
    const found = nearestCluster(clusters2D(ids.map(i => u[i]), ids.map(i => v[i])), 0, 0, 30);
    if (!found || found.distance > 0.05) { profile.push({height, circumference: null, coverage: 0}); continue; }
    const section = sectionCircumference(found.group.members.map(k => u[ids[k]]), found.group.members.map(k => v[ids[k]]));
    profile.push({height, ...section});
  }
  const flatSections = profile.filter(p => p.flat).length;
  const measured = profile.filter(p => p.circumference !== null).length;
  if (flatSections > 0.3 * (flatSections + measured)) {
    throw new Error('The scan caught only one side of the leg (it is flat in cross-section). Walk all the way around the leg, including behind it and between the legs.');
  }
  // Light smoothing: median of 3, then mean of 5 valid neighbours.
  const raw = profile.map(p => p.circumference);
  const med = raw.map((c, i) => {
    if (c === null) return null;
    const near = [raw[i - 1], c, raw[i + 1]].filter(x => x !== null && x !== undefined);
    return median(near);
  });
  profile.forEach((p, i) => {
    if (med[i] === null) { p.smoothed = null; return; }
    const near = med.slice(Math.max(0, i - 2), i + 3).filter(x => x !== null);
    p.smoothed = near.reduce((s, x) => s + x, 0) / near.length;
  });

  // 4. Landmarks.
  const pick = (low, high, better) => {
    let best = null;
    for (const p of profile) {
      if (p.smoothed === null || p.height < low || p.height > high) continue;
      if (!best || better(p.smoothed, best.smoothed)) best = p;
    }
    return best;
  };
  const ankle = pick(0.05, Math.min(0.22, cuffHeight * 0.5), (a, b) => a < b);
  if (!ankle) throw new Error('The ankle was not scanned all the way around. Rescan lower down.');
  if (ankle.height < 0.055 || ankle.height > Math.min(0.22, cuffHeight * 0.5) - 0.005) {
    warnings.push('The narrowest ankle was at the edge of the search range. Check the ankle with tape.');
  }
  const calf = pick(ankle.height + 0.06, cuffHeight - 0.02, (a, b) => a > b);
  if (!calf) throw new Error('The calf was not scanned all the way around. Rescan the upper leg.');
  const valid = profile.filter(p => p.height >= ankle.height && p.height <= calf.height);
  const gaps = valid.filter(p => p.circumference === null).length;
  if (valid.length && gaps / valid.length > 0.3) warnings.push('Parts of the leg between ankle and calf were missed. Consider rescanning.');

  const ankleValue = landmarkValue(profile, ankle.height, 0.02) ?? ankle.smoothed;
  const calfValue = landmarkValue(profile, calf.height, 0.04) ?? calf.smoothed;
  // Below-knee (top band) circumference: where the stocking's top band sits, just under the cuff point.
  const band = profile.filter(p => p.smoothed !== null && p.height >= cuffHeight - 0.025 && p.height <= cuffHeight);
  const belowKnee = band.length >= 2 ? band.reduce((sum, p) => sum + p.smoothed, 0) / band.length : null;
  if (belowKnee === null) warnings.push('The top of the calf, just below the knee, was not fully scanned, so the top-band circumference is missing.');

  return {
    ankle: ankleValue * 100,
    calf: calfValue * 100,
    length: cuffHeight * 100,
    belowKnee: belowKnee === null ? null : belowKnee * 100,
    lengthSource,
    ankleHeight: ankle.height * 100,
    calfHeight: calf.height * 100,
    tilt,
    points: count,
    profile: profile.map(p => ({height: p.height * 100, circumference: p.smoothed === null ? null : p.smoothed * 100, coverage: p.coverage})),
    warnings
  };
}

// Two scans agree when ankle, calf and length are each within this many centimetres.
const SCAN_AGREEMENT_CM = 1;
function compareScans(a, b) {
  const differences = {ankle: Math.abs(a.ankle - b.ankle), calf: Math.abs(a.calf - b.calf), length: Math.abs(a.length - b.length)};
  const agree = Object.values(differences).every(d => d <= SCAN_AGREEMENT_CM);
  return {agree, differences, mean: {ankle: (a.ankle + b.ankle) / 2, calf: (a.calf + b.calf) / 2, length: (a.length + b.length) / 2}};
}

const CompressionScan = {measureScan, compareScans, clusters2D, decodeScan, encodeScanPoints, sectionCircumference, convexHullPerimeter, SCAN_AGREEMENT_CM, SCAN_FORMAT_VERSION, SCAN_UNITS_PER_METRE};
if (typeof module !== 'undefined') module.exports = CompressionScan;
if (typeof window !== 'undefined') window.CompressionScan = CompressionScan;
