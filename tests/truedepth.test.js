'use strict';
const assert = require('assert');
const {measureTrueDepth, ellipseCircumference, encodeDepthPoints} = require('../dist/truedepth.js');

// Deterministic random numbers.
let seed = 42;
const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gaussian = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());

// Synthetic leg: elliptical cross-sections. a = half side-to-side, b = half front-to-back (metres),
// as functions of height above the floor. Narrowest at 10 cm (ankle), widest at 32 cm (calf).
const smooth = (x0, x1, y0, y1, x) => {
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  return y0 + (y1 - y0) * (1 - Math.cos(Math.PI * t)) / 2;
};
const legShape = h => h < 0.10
  ? {a: smooth(0.04, 0.10, 0.044, 0.036, h), b: smooth(0.04, 0.10, 0.040, 0.032, h)}
  : h < 0.32
    ? {a: smooth(0.10, 0.32, 0.036, 0.062, h), b: smooth(0.10, 0.32, 0.032, 0.060, h)}
    : {a: smooth(0.32, 0.46, 0.062, 0.052, h), b: smooth(0.32, 0.46, 0.060, 0.054, h)};
const trueAnkle = ellipseCircumference(0.072, 0.064) * 100;   // ≈ 21.4 cm
const trueCalf = ellipseCircumference(0.124, 0.120) * 100;    // ≈ 38.3 cm

/*
 * One capture as the front camera sees it. Camera frame: x right, y down, z away from the
 * camera. The leg axis passes `distance` in front of the camera, with the camera at
 * `cameraHeight` above the floor. `view` 'front' sees a as the width; 'side' sees b.
 */
function capture(view, {distance = 0.40, cameraHeight = 0.24, tilt = 0, noise = 0.001, flying = 0, floor = false} = {}) {
  const points = [];
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  for (let h = 0.03; h <= 0.48; h += 0.0025) {
    const {a, b} = legShape(h);
    const [wx, wz] = view === 'front' ? [a, b] : [b, a];
    for (let k = 0; k < 360; k++) {
      const theta = k / 360 * 2 * Math.PI;
      const px = wx * Math.cos(theta), pz = -wz * Math.sin(theta);  // pz < 0 faces the camera
      const nx = Math.cos(theta) / wx, nz = -Math.sin(theta) / wz;
      const vx = -px, vz = -distance - pz;                           // towards the camera
      const cosAngle = (nx * vx + nz * vz) / (Math.hypot(nx, nz) * Math.hypot(vx, vz));
      if (cosAngle < Math.cos(80 * Math.PI / 180)) continue;         // too steep or behind
      // Leg tilted sideways by `tilt` in the image plane.
      const up = h - cameraHeight;
      const x = px * cosT - up * sinT, y = -(px * sinT + up * cosT);
      const z = distance + pz + noise * gaussian();
      points.push([x, y, z]);
      // Flying pixels: at depth edges the sensor mixes leg and background, so a share of edge
      // points land further along the same camera ray (wider in the image only by perspective).
      if (flying && random() < flying && cosAngle < 0.35) {
        const scale = (z + 0.02 + 0.13 * random()) / z;
        points.push([x * scale, y * scale, z * scale]);
      }
    }
  }
  if (floor) {
    // Floor in the bottom of the view, from 25 to 70 cm away.
    for (let i = 0; i < 6000; i++) {
      points.push([(random() - 0.5) * 0.5, cameraHeight, 0.25 + 0.45 * random()]);
    }
  }
  // A wall far behind (filtered by range).
  for (let i = 0; i < 2000; i++) points.push([(random() - 0.5), (random() - 0.5), 1.5]);
  return {name: view, points: encodeDepthPoints(points)};
}

function check(label, options, tolerance = 0.5, sideOptions = options) {
  const result = measureTrueDepth([capture('front', options), capture('side', sideOptions)]);
  const ankleError = result.ankle - trueAnkle, calfError = result.calf - trueCalf;
  console.log(label.padEnd(28), 'ankle', result.ankle, '(true', trueAnkle.toFixed(1) + ')',
    ' calf', result.calf, '(true', trueCalf.toFixed(1) + ')', ' plausible', result.plausible);
  assert(Math.abs(ankleError) <= tolerance, label + ': ankle error ' + ankleError.toFixed(2) + ' cm');
  assert(Math.abs(calfError) <= tolerance, label + ': calf error ' + calfError.toFixed(2) + ' cm');
  assert(result.plausible, label + ': plausible');
  assert(result.calfAboveAnkle > 15 && result.calfAboveAnkle < 30, label + ': calf above ankle ' + result.calfAboveAnkle);
}

check('clean', {noise: 0});
check('1 mm noise', {});
check('2 mm noise, flying pixels', {noise: 0.002, flying: 0.5});
check('leg tilted 6°', {tilt: 6 * Math.PI / 180});
check('closer (30 cm)', {distance: 0.30});
check('floor in view', {floor: true});
check('views 4 cm apart in height', {cameraHeight: 0.22}, 0.5, {cameraHeight: 0.26, distance: 0.36});

// Upside-down hold (camera rotated 180°): same result.
{
  const flip = c => {
    const pts = require('../dist/truedepth.js').decodeDepthPoints(c.points).map(([x, y, z]) => [-x, -y, z]);
    return {name: c.name, points: encodeDepthPoints(pts)};
  };
  const r = measureTrueDepth([flip(capture('front')), flip(capture('side'))]);
  assert(Math.abs(r.ankle - trueAnkle) <= 0.6 && Math.abs(r.calf - trueCalf) <= 0.6, 'flipped');
}

// Errors.
assert.throws(() => measureTrueDepth([capture('front')]), /Both captures/);
assert.throws(() => measureTrueDepth([{name: 'front', points: []}, {name: 'side', points: []}]), /Too few depth points/);

console.log('truedepth ok');
