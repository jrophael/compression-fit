'use strict';
const assert = require('assert');
const P = require('../dist/posture/posture.js');

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: got ${a.toFixed(2)}, expected ${b} ± ${tol}`);
const DEG = 180 / Math.PI;

// ---------- Photo mode: landmarks drawn from a known posture, rotated and scaled ----------
function photo({headDeg = 0, waistCm = 0, tiltDeg = 0, rot = 0, pxPerCm = 6, headLeft = true, noScale = false}) {
  // Body in (s, h) cm: C7 at s=0, sacrum at s=50 (tilted), head 20 cm beyond C7.
  const t = tiltDeg / DEG;
  const c7 = [0, 20];
  const sacrum = [50 * Math.cos(t), 20 - 50 * Math.sin(t)];
  const dir = [(sacrum[0] - c7[0]) / 50, (sacrum[1] - c7[1]) / 50];
  const up = [-dir[1], dir[0]];
  const mid = [(c7[0] + sacrum[0]) / 2 + up[0] * waistCm, (c7[1] + sacrum[1]) / 2 + up[1] * waistCm];
  const h = headDeg / DEG; // positive = head raised
  const back = [-dir[0], -dir[1]];
  const occFixed = [c7[0] + 20 * (back[0] * Math.cos(h) + up[0] * Math.sin(h)), c7[1] + 20 * (back[1] * Math.cos(h) + up[1] * Math.sin(h))];
  const toImg = ([s, hh]) => {
    const x = (headLeft ? s : -s) * pxPerCm, y = -hh * pxPerCm;           // image y points down
    const c = Math.cos(rot / DEG), si = Math.sin(rot / DEG);
    return [400 + x * c - y * si, 600 + x * si + y * c];
  };
  const L = {
    occiput: toImg(occFixed), c7: toImg(c7), waist: toImg(mid), sacrum: toImg(sacrum),
    mattressA: toImg([-40, 0]), mattressB: toImg([90, 0])
  };
  if (!noScale) { L.refA = toImg([0, -10]); L.refB = toImg([29.7, -10]); L.refCm = 29.7; }
  return L;
}

{
  const r = P.analyseLandmarks(photo({}));
  near(r.headAngle, 0, 0.01, 'straight head');
  near(r.waistPct, 0, 0.01, 'straight waist');
  near(r.tilt, 0, 0.01, 'level trunk');
  assert.strictEqual(r.units, 'cm');
  near(r.neckLength, 20, 0.01, 'neck length in cm');
}
for (const rot of [0, 12, -20]) {
  for (const headLeft of [true, false]) {
    const r = P.analyseLandmarks(photo({headDeg: -10, waistCm: -1.5, tiltDeg: 5, rot, headLeft}));
    near(r.headAngle, -10, 0.01, `head drop (rot ${rot}, head ${headLeft ? 'left' : 'right'})`);
    near(r.waistCm, -1.5, 0.01, 'waist dip in cm');
    near(r.tilt, 5, 0.01, 'hips lower');
    near(r.pillowChangeCm, 20 * Math.sin(10 / DEG), 0.01, 'raise pillow by L sin θ');
  }
}
{
  const r = P.analyseLandmarks(photo({headDeg: 8, noScale: true}));
  assert.strictEqual(r.units, 'px');
  near(r.headAngle, 8, 0.01, 'head raised, no scale');
  assert.strictEqual(r.pillowChangeCm, undefined);
  const text = P.interpret(r).map(f => f.text).join(' ');
  assert(/too high/.test(text) && /slightly lower pillow/.test(text));
}
assert.throws(() => P.analyseLandmarks({occiput: [0, 0]}), /Missing point/);

// ---------- Interpretation thresholds ----------
{
  const ok = P.interpret({units: 'cm', headAngle: 2, waistPct: 1, tilt: 1, pillowChangeCm: -0.5});
  assert(ok.every(f => f.level === 'ok'));
  const bad = P.interpret({units: 'cm', headAngle: -9, waistPct: -3, tilt: 6, pillowChangeCm: 3.1});
  assert.deepStrictEqual(bad.map(f => f.level), ['change', 'change', 'change']);
  assert(/raising it by about 3.1 cm/.test(bad[0].text));
  assert(/waist dips/.test(bad[1].text) && /firmer hip zone/.test(bad[2].text));
  const soft = P.interpret({units: 'cm', headAngle: 0, waistPct: 3, tilt: -6});
  assert(/sinking too far/.test(soft[1].text) && /shoulders sit lower/.test(soft[2].text));
}

// ---------- Depth mode: synthetic side-lying body with known posture ----------
const cases = [
  {p: {}, head: 0, waist: 0, tilt: 0},
  {p: {headDropDeg: 10}, head: -10, waist: 0, tilt: 0},
  {p: {headDropDeg: -8}, head: 8, waist: 0, tilt: 0},
  {p: {waistSagCm: 2}, head: 0, waist: -1.75, tilt: 0},
  {p: {hipSinkCm: 4}, head: 0, waist: 0, tilt: Math.atan(4 / 50) * DEG},
  {p: {headDropDeg: 6, waistSagCm: 1.5, hipSinkCm: 3}, head: -6, waist: -1.3, tilt: Math.atan(3 / 50) * DEG},
  {p: {headDropDeg: 10, noiseMm: 4, seed: 3}, head: -10, waist: 0, tilt: 0},
  {p: {waistSagCm: 2, noiseMm: 4, seed: 5}, head: 0, waist: -1.75, tilt: 0}
];
for (const c of cases) {
  const scan = P.syntheticScan(c.p);
  const r = P.analyseDepth(scan.points, scan);
  const label = JSON.stringify(c.p);
  near(r.headAngle, c.head, 2.6, `depth head angle ${label}`);
  near(r.waistCm, c.waist, 0.5, `depth waist ${label}`);
  near(r.tilt, c.tilt, 1.0, `depth tilt ${label}`);
  near(r.floor, 0, 0.01, 'mattress plane');
  assert(r.profile.length > 40 && r.profile.every(x => Number.isFinite(x.spine)));
}
{
  // Head on the right of the camera's view gives the same answer.
  const scan = P.syntheticScan({headDropDeg: 10});
  const mirrored = scan.points.map(([x, y, z]) => [1.1 - x, y, z]);
  const r = P.analyseDepth(mirrored, {camera: [1.1 - scan.camera[0], scan.camera[1], scan.camera[2]], headSide: 'right'});
  near(r.headAngle, -10, 2.6, 'head on the right');
}
assert.throws(() => P.analyseDepth([[0, 0, 0]], {camera: [0, 0, 1]}), /Not enough/);

console.log('posture scan ok');
