'use strict';
// Synthetic-leg tests for dist/scan.js. Run: node tests/scan.test.js
// Each case builds a leg of known shape, simulates an imperfect LiDAR scan and checks
// that ankle, calf and length are recovered within the 1 cm target.

const assert = require('assert');
const path = require('path');
const Scan = require(path.join(__dirname, '..', 'dist', 'scan.js'));

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function gauss(random) {
  return Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
}

const {legRadius, truthProfile} = require('./synthetic-leg.js');

function simulate(leg, opts) {
  const random = rng(opts.seed);
  const tilt = opts.tilt * Math.PI / 180;
  const axis = [Math.sin(tilt), Math.cos(tilt), 0];
  const e1 = [Math.cos(tilt), -Math.sin(tilt), 0], e2 = [0, 0, 1];
  const raw = [];
  // Axial sampling of the leg surface; points arrive in rings like a walk-around scan.
  for (let i = 0; i < opts.samples; i++) {
    const h = 0.02 + random() * (leg.cuffH / Math.cos(tilt) + 0.06);
    const th = random() * 2 * Math.PI;
    if (opts.gap && th > opts.gap[0] && th < opts.gap[1] && h > opts.gapH[0] && h < opts.gapH[1]) continue;
    const r = legRadius(h, th, leg) + gauss(random) * opts.noise;
    const u = r * Math.cos(th), v = r * Math.sin(th);
    let x = leg.x0 + h * axis[0] + u * e1[0] + v * e2[0];
    let y = h * axis[1] + u * e1[1] + v * e2[1];
    let z = leg.z0 + h * axis[2] + u * e1[2] + v * e2[2];
    if (opts.drift) { x += opts.drift * Math.sin(th); z += opts.drift * Math.cos(th * 2); }
    if (y < 0.01) continue;
    raw.push([x, y, z]);
  }
  // Foot: a block in front of the ankle, below 6 cm.
  for (let i = 0; i < opts.samples / 20; i++) {
    raw.push([leg.x0 + (random() - 0.5) * 0.09, 0.01 + random() * 0.05, leg.z0 + 0.03 + random() * 0.15]);
  }
  // The other leg, a tapered cylinder beside this one.
  if (opts.otherLeg) {
    for (let i = 0; i < opts.samples / 2; i++) {
      const h = 0.01 + random() * 0.5, th = random() * 2 * Math.PI, r = 0.035 + 0.03 * Math.min(1, h / 0.3);
      raw.push([leg.x0 + opts.otherLeg + r * Math.cos(th), h, leg.z0 + r * Math.sin(th)]);
    }
  }
  // Stray points.
  for (let i = 0; i < raw.length * opts.outliers; i++) {
    raw.push([leg.x0 + (random() - 0.5) * 0.5, 0.01 + random() * 0.5, leg.z0 + (random() - 0.5) * 0.5]);
  }
  // 4 mm voxel averaging, as the app does.
  const vox = new Map();
  for (const p of raw) {
    const key = p.map(c => Math.floor(c / 0.004)).join(',');
    const acc = vox.get(key) || [0, 0, 0, 0];
    acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; acc[3]++;
    vox.set(key, acc);
  }
  // Re-express relative to the cuff point (back of the leg at cuff height).
  const cuffT = leg.cuffH / Math.cos(tilt);
  const backR = legRadius(cuffT, -Math.PI / 2, leg);
  const cuff = [leg.x0 + cuffT * axis[0], leg.cuffH, leg.z0 - backR];
  const flat = [];
  for (const [sx, sy, sz, n] of vox.values()) flat.push(sx / n - cuff[0], sy / n, sz / n - cuff[2]);
  return {version: 1, cuffHeight: leg.cuffH, points: Scan.encodeScanPoints(flat)};
}

const baseLeg = {scale: 1, ax: 1.08, ay: 0.93, calfH: 0.30, cuffH: 0.40, x0: 0, z0: 0};
const cases = [
  {name: 'clean scan', leg: baseLeg, opts: {seed: 1, samples: 120000, noise: 0.001, tilt: 0, outliers: 0}},
  {name: 'LiDAR noise 3 mm + 2% strays', leg: baseLeg, opts: {seed: 2, samples: 120000, noise: 0.003, tilt: 0, outliers: 0.02}},
  {name: 'tilted 8° with other leg 22 cm away', leg: baseLeg, opts: {seed: 3, samples: 120000, noise: 0.002, tilt: 8, outliers: 0.01, otherLeg: 0.22}},
  {name: '25° unscanned strip on inner calf', leg: baseLeg, opts: {seed: 4, samples: 120000, noise: 0.002, tilt: 3, outliers: 0.01, gap: [0.2, 0.64], gapH: [0.2, 0.35]}},
  {name: 'large leg, 3 mm tracking drift', leg: {...baseLeg, scale: 1.3, calfH: 0.32, cuffH: 0.44}, opts: {seed: 5, samples: 140000, noise: 0.002, tilt: 2, outliers: 0.01, drift: 0.003}},
  {name: 'small leg, sparse scan', leg: {...baseLeg, scale: 0.85, calfH: 0.27, cuffH: 0.35}, opts: {seed: 6, samples: 45000, noise: 0.003, tilt: 4, outliers: 0.01, otherLeg: 0.18}}
];

let failures = 0;
for (const c of cases) {
  const truth = truthProfile(c.leg);
  const ankleTrue = Math.min(...truth.filter(p => p.h >= 0.05 && p.h <= 0.22).map(p => p.c)) * 100;
  const calfTrue = Math.max(...truth.filter(p => p.h >= 0.1 && p.h <= c.leg.cuffH - 0.02).map(p => p.c)) * 100;
  const r = Scan.measureScan(simulate(c.leg, c.opts));
  const errors = {ankle: r.ankle - ankleTrue, calf: r.calf - calfTrue, length: r.length - c.leg.cuffH * 100};
  const ok = Object.values(errors).every(e => Math.abs(e) <= 0.5); // half the 1 cm budget, leaving room for real-world error
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + c.name.padEnd(42) +
    ` ankle ${r.ankle.toFixed(2)} (true ${ankleTrue.toFixed(2)}, err ${errors.ankle.toFixed(2)})` +
    `  calf ${r.calf.toFixed(2)} (true ${calfTrue.toFixed(2)}, err ${errors.calf.toFixed(2)})` +
    `  length err ${errors.length.toFixed(2)} cm  tilt ${r.tilt.toFixed(1)}°` + (r.warnings.length ? '  warnings: ' + r.warnings.join(' ') : ''));
}

// A one-sided scan (leg flattened to a thin shell) and a seated, tilted leg are refused.
assert.throws(() => Scan.measureScan(simulate({...baseLeg, ax: 1.6, ay: 0.25}, {seed: 31, samples: 90000, noise: 0.001, tilt: 0, outliers: 0})), /only one side/);
assert.throws(() => Scan.measureScan(simulate(baseLeg, {seed: 32, samples: 90000, noise: 0.001, tilt: 27, outliers: 0})), /tilted by/);

// Length from the scan: the leg narrows below the knee and widens at the knee.
{
  const kneeLeg = {...baseLeg, cuffH: 0.52, kneeH: 0.45};
  const truth = truthProfile(kneeLeg).filter(p => p.h >= 0.3 && p.h <= 0.48);
  const expected = truth.reduce((a, b) => (b.c < a.c ? b : a)).h * 100;
  const scan = simulate(kneeLeg, {seed: 41, samples: 140000, noise: 0.002, tilt: 2, outliers: 0.01});
  const r = Scan.measureScan({...scan, autoLength: true});
  console.log(`Length from scan ${r.length.toFixed(1)} cm (narrowest below knee in the true shape ${expected.toFixed(1)} cm)`);
  assert.ok(Math.abs(r.length - expected) <= 1.0, 'length from scan within 1 cm');
  assert.strictEqual(r.lengthSource, 'scan');
  // A scan that stops below the knee cannot give a length.
  assert.throws(() => Scan.measureScan({...simulate(baseLeg, {seed: 42, samples: 90000, noise: 0.002, tilt: 0, outliers: 0}), autoLength: true}), /length could not be found/);
}

// Agreement gate.
const a = {ankle: 21.0, calf: 38.0, length: 40.0};
assert.strictEqual(Scan.compareScans(a, {ankle: 21.8, calf: 38.9, length: 40.5}).agree, true);
assert.strictEqual(Scan.compareScans(a, {ankle: 22.2, calf: 38.0, length: 40.0}).agree, false);
// Bad input is rejected clearly.
assert.throws(() => Scan.measureScan({version: 1, cuffHeight: 0.4, points: Scan.encodeScanPoints([0, 0, 0])}), /Too few/);
assert.throws(() => Scan.measureScan({version: 2, cuffHeight: 0.4, points: ''}), /version/);

if (failures) { console.error(failures + ' case(s) outside 0.5 cm'); process.exit(1); }
console.log('All scan tests passed.');

// Write sample scan files for manual testing in the browser ("Or load a scan file").
if (process.env.WRITE_FIXTURES) {
  const fs = require('fs');
  const dir = path.join(__dirname, 'fixtures');
  fs.mkdirSync(dir, {recursive: true});
  [21, 22].forEach((seed, i) => {
    const scan = simulate(baseLeg, {seed, samples: 110000, noise: 0.003, tilt: 4, outliers: 0.01, otherLeg: 0.22});
    Object.assign(scan, {leg: 'left', source: 'synthetic-test-leg', capturedAt: '2026-11-16T00:00:00Z'});
    fs.writeFileSync(path.join(dir, `synthetic-left-scan-${i + 1}.json`), JSON.stringify(scan));
  });
  console.log('Wrote fixtures to tests/fixtures/ (true ankle 22.01 cm, calf 40.41 cm, length 40.0 cm).');
}
