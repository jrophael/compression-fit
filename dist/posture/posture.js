// Sleep Posture Scan (prototype). Measures side-lying spinal alignment on the user's own bed
// from either tapped photo landmarks or a depth point cloud, and turns it into pillow and
// mattress-zone suggestions. Comfort guidance only; thresholds are provisional.
(function (root) {
  'use strict';

  const DEG = 180 / Math.PI;
  // Provisional thresholds (not validated): head angle in degrees, waist deviation in % of
  // trunk length, trunk tilt in degrees.
  const THRESHOLDS = {head: 5, waist: 2, tilt: 4};

  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const scale = (a, k) => a.map(v => v * k);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const len = a => Math.sqrt(dot(a, a));
  const unit = a => scale(a, 1 / len(a));
  const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  // ---------- Core measures from four spine points in (s, h) coordinates ----------
  // s runs along the bed from the head towards the feet; h is height above the mattress.
  // units: 'cm' when real-world scale is known, otherwise 'px'.
  function measures(P, units) {
    const trunk = sub(P.sacrum, P.c7);
    const trunkLen = len(trunk);
    if (!(trunkLen > 0)) throw new Error('Base of neck and sacrum must be different points');
    const t = scale(trunk, 1 / trunkLen);       // C7 -> sacrum
    const up = [-t[1], t[0]];                  // perpendicular to the trunk line, towards the ceiling
    const back = scale(t, -1);                  // trunk line continued beyond C7 towards the head
    const neck = sub(P.occiput, P.c7);
    const neckLen = len(neck);
    const cross = back[0] * neck[1] - back[1] * neck[0];
    // Positive = head raised above the trunk line (pillow too high); negative = head drops.
    const headAngle = -Math.atan2(cross, dot(back, neck)) * DEG;
    const waistDev = dot(sub(P.waist, P.c7), up);   // positive = waist above the shoulder-hip line
    const tilt = Math.atan2(P.c7[1] - P.sacrum[1], P.sacrum[0] - P.c7[0]) * DEG; // positive = hips lower
    const res = {
      units,
      headAngle,
      waistPct: 100 * waistDev / trunkLen,
      tilt,
      neckLength: neckLen,
      trunkLength: trunkLen
    };
    if (units === 'cm') {
      res.waistCm = waistDev;
      res.pillowChangeCm = -neckLen * Math.sin(headAngle / DEG);
    }
    return res;
  }

  // ---------- Photo mode: tapped landmarks in image pixels ----------
  // L: {occiput, c7, waist, sacrum, mattressA, mattressB, refA?, refB?, refCm?}
  function analyseLandmarks(L) {
    for (const k of ['occiput', 'c7', 'waist', 'sacrum', 'mattressA', 'mattressB']) {
      if (!L[k]) throw new Error('Missing point: ' + k);
    }
    const along = sub(L.mattressB, L.mattressA);
    if (len(along) < 1) throw new Error('The two mattress points must be apart');
    const m = unit(along);
    let up = [-m[1], m[0]];
    const middle = scale(add(L.c7, L.sacrum), 0.5);
    if (dot(sub(middle, L.mattressA), up) < 0) up = scale(up, -1);
    const cmPerPx = L.refA && L.refB && L.refCm ? L.refCm / len(sub(L.refB, L.refA)) : null;
    const k = cmPerPx || 1;
    const toSH = p => { const d = sub(p, L.mattressA); return [dot(d, m) * k, dot(d, up) * k]; };
    const P = {occiput: toSH(L.occiput), c7: toSH(L.c7), waist: toSH(L.waist), sacrum: toSH(L.sacrum)};
    if (P.occiput[0] > P.sacrum[0]) for (const key in P) P[key][0] = -P[key][0];
    const res = measures(P, cmPerPx ? 'cm' : 'px');
    res.points = P;
    res.source = 'photo';
    return res;
  }

  // ---------- Depth mode: point cloud in metres, world y up ----------
  // opts: {camera: [x, y, z], headSide: 'left' | 'right', slice: metres}
  function mattressHeight(points) {
    const bins = new Map();
    for (const p of points) { const b = Math.round(p[1] * 100); bins.set(b, (bins.get(b) || 0) + 1); }
    let best = null, count = -1;
    for (const [b, c] of bins) if (c > count || (c === count && b < best)) { best = b; count = c; }
    return median(points.filter(p => Math.abs(p[1] * 100 - best) <= 1.5).map(p => p[1]));
  }

  function median3(xs) {
    return xs.map((v, i) => (i === 0 || i === xs.length - 1) ? v : median([xs[i - 1], v, xs[i + 1]]));
  }

  function spineProfile(points, opts) {
    const o = Object.assign({slice: 0.02, headSide: 'left'}, opts);
    if (!o.camera) throw new Error('Camera position is needed');
    const floor = mattressHeight(points);
    const body = points.filter(p => p[1] > floor + 0.02);
    if (body.length < 200) throw new Error('Not enough of the body is visible');
    const c = scale(body.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / body.length);
    // Body axis: principal direction in the horizontal plane.
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of body) { const dx = p[0] - c[0], dz = p[2] - c[2]; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let a = [Math.cos(theta), 0, Math.sin(theta)];
    const view = unit([c[0] - o.camera[0], 0, c[2] - o.camera[2]]);
    const right = [-view[2], 0, view[0]];          // view x up (0,1,0)
    if (dot(a, right) < 0) a = scale(a, -1);
    if (o.headSide === 'right') a = scale(a, -1);
    let d = scale(view, -1);                         // towards the camera = towards the back
    d = unit(sub(d, scale(a, dot(d, a))));
    const rows = body.map(p => { const r = sub(p, c); return {s: dot(r, a), q: dot(r, d), h: p[1] - floor}; });
    const s0 = Math.min(...rows.map(r => r.s)), s1 = Math.max(...rows.map(r => r.s));
    const n = Math.ceil((s1 - s0) / o.slice);
    const slices = Array.from({length: n}, () => []);
    for (const r of rows) slices[Math.min(n - 1, Math.floor((r.s - s0) / o.slice))].push(r);
    const prof = [];
    slices.forEach((sl, i) => {
      if (sl.length < 8) return;
      const hs = sl.map(r => r.h).sort((x, y) => x - y);
      const extent = hs[Math.floor(0.98 * (hs.length - 1))];
      const qs = sl.map(r => r.q).sort((x, y) => x - y);
      const qtop = qs[Math.floor(0.95 * (qs.length - 1))];   // robust to noisy outliers
      const backPts = sl.filter(r => r.q >= qtop - 0.012);
      prof.push({s: s0 + (i + 0.5) * o.slice - s0, extent, spine: median(backPts.map(r => r.h))});
    });
    const ext = median3(prof.map(p => p.extent)), sp = median3(prof.map(p => p.spine));
    prof.forEach((p, i) => { p.extent = ext[i]; p.spine = sp[i]; });
    return {floor, profile: prof};
  }

  function landmarksFromProfile(prof) {
    const within = (lo, hi) => prof.filter(p => p.s >= lo && p.s <= hi);
    const argmax = arr => arr.reduce((b, p) => (p.extent > b.extent ? p : b));
    const argmin = arr => arr.reduce((b, p) => (p.extent < b.extent ? p : b));
    const head = argmax(within(0, 0.22));
    const neck = argmin(within(head.s, head.s + 0.25));
    const shoulderZone = within(neck.s, neck.s + 0.25);
    const shoulderTop = Math.max(...shoulderZone.map(p => p.extent));
    const cut = neck.extent + 0.25 * (shoulderTop - neck.extent);
    const c7 = shoulderZone.find(p => p.extent >= cut) || neck;
    const hip = argmax(within(c7.s + 0.3, c7.s + 0.75));
    const shoulder = argmax(within(c7.s, c7.s + 0.15));
    const waist = argmin(within(shoulder.s, hip.s));
    return {head, neck, c7, waist, hip};
  }

  function analyseDepth(points, opts) {
    const {floor, profile} = spineProfile(points, opts);
    const lm = landmarksFromProfile(profile);
    // Average the spine height over neighbouring slices to steady each landmark.
    const near = (p, w) => [p.s * 100, median(profile.filter(q => Math.abs(q.s - p.s) <= w).map(q => q.spine)) * 100];
    const P = {occiput: near(lm.head, 0.04), c7: near(lm.c7, 0.02), waist: near(lm.waist, 0.03), sacrum: near(lm.hip, 0.03)};
    const res = measures(P, 'cm');
    res.points = P;
    res.profile = profile.map(p => ({s: p.s * 100, spine: p.spine * 100, extent: p.extent * 100}));
    res.floor = floor;
    res.source = 'depth';
    return res;
  }

  // ---------- Interpretation ----------
  function interpret(r) {
    const out = [];
    const T = THRESHOLDS;
    const cm = r.units === 'cm';
    if (r.headAngle < -T.head) {
      out.push({area: 'Pillow', level: 'change', text: 'Your head drops towards the mattress, so the pillow looks too low' +
        (cm ? '. Try raising it by about ' + Math.abs(r.pillowChangeCm).toFixed(1) + ' cm' : '. Try a slightly higher pillow') + ', then scan again.'});
    } else if (r.headAngle > T.head) {
      out.push({area: 'Pillow', level: 'change', text: 'Your head is pushed up above the line of your spine, so the pillow looks too high' +
        (cm ? '. Try lowering it by about ' + Math.abs(r.pillowChangeCm).toFixed(1) + ' cm' : '. Try a slightly lower pillow') + ', then scan again.'});
    } else {
      out.push({area: 'Pillow', level: 'ok', text: 'Your head and neck line up with your spine. The pillow height looks right.'});
    }
    if (r.waistPct < -T.waist) {
      out.push({area: 'Mattress', level: 'change', text: 'Your waist dips towards the mattress between shoulder and hip. The mattress may be too firm at the shoulder or hip, leaving the waist unsupported. A softer topper or softer shoulder zone can help.'});
    } else if (r.waistPct > T.waist) {
      out.push({area: 'Mattress', level: 'change', text: 'Your waist sits above the line from shoulder to hip, which usually means the shoulder and hip are sinking too far. A firmer mattress or firmer shoulder and hip zones can help.'});
    } else {
      out.push({area: 'Mattress', level: 'ok', text: 'Your spine is close to straight between shoulder and hip.'});
    }
    if (r.tilt > T.tilt) {
      out.push({area: 'Zones', level: 'change', text: 'Your hips sit lower than your shoulders. If your mattress has zones, a firmer hip zone may help.'});
    } else if (r.tilt < -T.tilt) {
      out.push({area: 'Zones', level: 'change', text: 'Your shoulders sit lower than your hips. A firmer shoulder zone, or a less firm hip zone, may help.'});
    } else {
      out.push({area: 'Zones', level: 'ok', text: 'Shoulders and hips sit at a similar level.'});
    }
    return out;
  }

  // ---------- Synthetic side-lying body (for the demo and tests) ----------
  // params: {headDropDeg, waistSagCm, hipSinkCm, noiseMm, seed}
  function syntheticScan(params) {
    const p = Object.assign({headDropDeg: 0, waistSagCm: 0, hipSinkCm: 0, noiseMm: 2, seed: 7}, params);
    let seed = p.seed;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const xC7 = 0.20, xS = 0.70, hC7 = 0.19;
    const hS = hC7 - p.hipSinkCm / 100;
    const line = x => hC7 + (hS - hC7) * (x - xC7) / (xS - xC7);
    const sag = x => (x > xC7 && x < xS) ? -(p.waistSagCm / 100) * Math.sin(Math.PI * (x - xC7) / (xS - xC7)) : 0;
    const headCentre = line(0) - xC7 * Math.tan(p.headDropDeg / DEG); // angle at C7; positive = head lower
    const spineH = x => {
      if (x <= 0) return headCentre;
      if (x < xC7) return headCentre + (line(xC7) - headCentre) * x / xC7;
      return line(x) + sag(x);
    };
    const lerp = (pts, x) => { for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return pts[pts.length - 1][1]; };
    const bAt = x => lerp([[0.09, 0.055], [0.19, 0.055], [0.26, 0.21], [0.34, 0.20], [0.45, 0.15], [0.60, 0.17], [0.68, 0.19], [0.78, 0.17], [0.86, 0.09], [1.3, 0.08]], x);
    const cAt = x => lerp([[0.09, 0.055], [0.19, 0.055], [0.26, 0.11], [0.45, 0.10], [0.68, 0.11], [0.86, 0.07], [1.3, 0.06]], x);
    const pts = [];
    const noise = () => gauss() * p.noiseMm / 1000;
    for (let x = -0.09; x <= 1.2; x += 0.005) {
      let b, c;
      if (x < 0.09) { b = c = Math.sqrt(Math.max(0, 0.09 * 0.09 - x * x)); } else { b = bAt(x); c = cAt(x); }
      if (b < 0.005) continue;
      const h = spineH(Math.max(x, -0.01));
      for (let phi = -Math.PI / 2; phi <= Math.PI / 2; phi += Math.PI / 60) {
        const y = h + b * Math.sin(phi), z = c * Math.cos(phi);
        if (y < 0) continue;
        pts.push([x + noise(), y + noise(), z + noise()]);
      }
    }
    for (let x = -0.3; x <= 1.4; x += 0.02) for (let z = -0.35; z <= 0.45; z += 0.02) pts.push([x + noise(), noise(), z]);
    return {points: pts, camera: [0.45, 0.30, 1.4], headSide: 'left'};
  }

  const api = {THRESHOLDS, measures, analyseLandmarks, analyseDepth, spineProfile, landmarksFromProfile, interpret, syntheticScan, mattressHeight};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Posture = api;
})(typeof window !== 'undefined' ? window : globalThis);
