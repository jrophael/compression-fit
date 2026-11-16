'use strict';
// 3D model upload tests. Run: node tests/models.test.js
// Builds a synthetic scene (leg, floor, other leg, chair leg, box), exports it the way the
// scanning apps do, and checks ankle and calf are recovered within 0.5 cm from every format.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const Models = require(path.join(__dirname, '..', 'dist', 'models.js'));
const {legRadius, truthProfile} = require('./synthetic-leg.js');

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Scene in metres, y up. Returns {positions, triangles}.
function buildScene(leg, {tilt = 3, noise = 0.0015, ring = 0.01, around = 48} = {}) {
  const random = rng(42);
  const P = [], T = [];
  const add = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  const t = tilt * Math.PI / 180;
  // Leg surface: rings ~1 cm apart along a tilted axis, LiDAR-like vertex noise.
  const rings = [];
  for (let h = 0.0; h <= leg.cuffH / Math.cos(t) + 0.12; h += ring) {
    const ids = [];
    for (let k = 0; k < around; k++) {
      const th = k / around * 2 * Math.PI;
      const r = legRadius(h, th, leg) + (random() - 0.5) * 2 * noise;
      const u = r * Math.cos(th), v = r * Math.sin(th);
      ids.push(add(h * Math.sin(t) + u * Math.cos(t), h * Math.cos(t) - u * Math.sin(t), v));
    }
    rings.push(ids);
  }
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < around; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % around], c = rings[i + 1][k], d = rings[i + 1][(k + 1) % around];
      T.push(a, b, d, a, d, c);
    }
  }
  // Generic cylinder (other leg, chair leg).
  const cylinder = (cx, cz, r, height) => {
    const n = 24, base = P.length / 3;
    for (const y of [0, height]) for (let k = 0; k < n; k++) add(cx + r * Math.cos(k / n * 2 * Math.PI), y, cz + r * Math.sin(k / n * 2 * Math.PI));
    for (let k = 0; k < n; k++) T.push(base + k, base + (k + 1) % n, base + n + (k + 1) % n, base + k, base + n + (k + 1) % n, base + n + k);
  };
  cylinder(0.24, 0.02, 0.055, 0.6);   // the other leg
  cylinder(-0.45, 0.35, 0.018, 0.45); // chair leg
  // Floor: 1.6 m square in a 16 x 16 grid.
  const grid = 16, size = 1.6, base = P.length / 3;
  for (let i = 0; i <= grid; i++) for (let j = 0; j <= grid; j++) add(-0.8 + size * i / grid, (random() - 0.5) * 0.002, -0.8 + size * j / grid);
  for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
    const a = base + i * (grid + 1) + j;
    T.push(a, a + 1, a + grid + 2, a, a + grid + 2, a + grid + 1);
  }
  return {positions: P, triangles: T};
}

// ---------- Writers in each app format ----------
const writeOBJ = s => {
  let out = '# synthetic\n';
  for (let i = 0; i < s.positions.length; i += 3) out += `v ${s.positions[i].toFixed(5)} ${s.positions[i + 1].toFixed(5)} ${s.positions[i + 2].toFixed(5)}\n`;
  for (let i = 0; i < s.triangles.length; i += 3) out += `f ${s.triangles[i] + 1}/1 ${s.triangles[i + 1] + 1}/1 ${s.triangles[i + 2] + 1}/1\n`;
  return Buffer.from(out);
};
const writePLY = s => {
  const nv = s.positions.length / 3, nf = s.triangles.length / 3;
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${nv}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face ${nf}\nproperty list uchar int vertex_indices\nend_header\n`;
  const body = Buffer.alloc(nv * 15 + nf * 13);
  let o = 0;
  for (let i = 0; i < nv; i++) { for (let k = 0; k < 3; k++) { body.writeFloatLE(s.positions[3 * i + k], o); o += 4; } body.writeUInt8(200, o++); body.writeUInt8(150, o++); body.writeUInt8(120, o++); }
  for (let i = 0; i < nf; i++) { body.writeUInt8(3, o++); for (let k = 0; k < 3; k++) { body.writeInt32LE(s.triangles[3 * i + k], o); o += 4; } }
  return Buffer.concat([Buffer.from(header), body]);
};
// STL in millimetres, z up (3D-printing convention).
const writeSTL = s => {
  const nf = s.triangles.length / 3, out = Buffer.alloc(84 + 50 * nf);
  out.writeUInt32LE(nf, 80);
  for (let i = 0; i < nf; i++) {
    let o = 84 + 50 * i + 12;
    for (let k = 0; k < 3; k++) {
      const v = 3 * s.triangles[3 * i + k];
      out.writeFloatLE(s.positions[v] * 1000, o); out.writeFloatLE(-s.positions[v + 2] * 1000, o + 4); out.writeFloatLE(s.positions[v + 1] * 1000, o + 8);
      o += 12;
    }
  }
  return out;
};
// glTF with positions stored z-up and a root node rotating them to y-up.
function gltfParts(s) {
  const nv = s.positions.length / 3;
  const pos = Buffer.alloc(nv * 12), idx = Buffer.alloc(s.triangles.length * 4);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) {
    const zUp = [s.positions[3 * i], -s.positions[3 * i + 2], s.positions[3 * i + 1]];
    zUp.forEach((v, k) => { pos.writeFloatLE(v, 12 * i + 4 * k); min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v); });
  }
  s.triangles.forEach((v, i) => idx.writeUInt32LE(v, 4 * i));
  const bin = Buffer.concat([pos, idx]);
  const json = {
    asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}],
    nodes: [{rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], children: [1]}, {mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1}]}],
    buffers: [{byteLength: bin.length}],
    bufferViews: [{buffer: 0, byteOffset: 0, byteLength: pos.length}, {buffer: 0, byteOffset: pos.length, byteLength: idx.length}],
    accessors: [{bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min, max}, {bufferView: 1, componentType: 5125, count: s.triangles.length, type: 'SCALAR'}]
  };
  return {json, bin};
}
const writeGLB = s => {
  const {json, bin} = gltfParts(s);
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - jsonBuf.length % 4) % 4, 0x20)]);
  const binBuf = Buffer.concat([bin, Buffer.alloc((4 - bin.length % 4) % 4)]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]); };
  return Buffer.concat([header, chunk(jsonBuf, 0x4e4f534a), chunk(binBuf, 0x004e4942)]);
};
const writeGLTFZip = s => {
  const {json, bin} = gltfParts(s);
  json.buffers[0].uri = 'scene.bin';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  fs.writeFileSync(path.join(dir, 'scene.gltf'), JSON.stringify(json));
  fs.writeFileSync(path.join(dir, 'scene.bin'), bin);
  const zip = path.join(dir, 'export.zip');
  execFileSync('python3', ['-I', '-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\n[z.write(f, f.split("/")[-1]) for f in sys.argv[2:]]\nz.close()', zip, path.join(dir, 'scene.gltf'), path.join(dir, 'scene.bin')]);
  return fs.readFileSync(zip);
};
const writeXYZ = s => {
  // Point cloud: area-sampled points, as a LiDAR point-cloud export.
  const out = [];
  const random = rng(9);
  for (let t = 0; t < s.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map(k => s.triangles[t + k] * 3);
    const area = 0.5 * Math.hypot(...[0, 1, 2].map(k => {
      const u = [0, 1, 2].map(j => s.positions[b + j] - s.positions[a + j]), v = [0, 1, 2].map(j => s.positions[c + j] - s.positions[a + j]);
      return u[(k + 1) % 3] * v[(k + 2) % 3] - u[(k + 2) % 3] * v[(k + 1) % 3];
    }));
    const n = Math.round(area / 0.003 ** 2);
    for (let i = 0; i < n; i++) {
      let r1 = random(), r2 = random();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      out.push([0, 1, 2].map(j => (s.positions[a + j] + r1 * (s.positions[b + j] - s.positions[a + j]) + r2 * (s.positions[c + j] - s.positions[a + j])).toFixed(5)).join(' '));
    }
  }
  return Buffer.from(out.join('\n'));
};

(async () => {
  const leg = {scale: 1, ax: 1.08, ay: 0.93, calfH: 0.30, cuffH: 0.40, x0: 0, z0: 0};
  const truth = truthProfile(leg);
  const ankleTrue = Math.min(...truth.filter(p => p.h >= 0.05 && p.h <= 0.22).map(p => p.c)) * 100;
  const calfTrue = Math.max(...truth.filter(p => p.h >= 0.1 && p.h <= leg.cuffH - 0.02).map(p => p.c)) * 100;
  const scene = buildScene(leg);
  const toBuffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const cases = [
    ['3d Scanner App / Scaniverse OBJ (m, y-up)', [['scan.obj', writeOBJ(scene)]]],
    ['Binary PLY mesh (m, y-up)', [['scan.ply', writePLY(scene)]]],
    ['STL (mm, z-up)', [['scan.stl', writeSTL(scene)]]],
    ['GLB with rotated node', [['scan.glb', writeGLB(scene)]]],
    ['Polycam free glTF in a ZIP', [['export.zip', writeGLTFZip(scene)]]],
    ['XYZ point cloud', [['scan.xyz', writeXYZ(scene)]]]
  ];
  let failures = 0;
  for (const [name, files] of cases) {
    try {
      const model = await Models.readModel(files.map(([n, b]) => ({name: n, buffer: toBuffer(b)})));
      const r = Models.measureModel(model, leg.cuffH * 100);
      const ea = r.ankle - ankleTrue, ec = r.calf - calfTrue;
      const ok = Math.abs(ea) <= 0.5 && Math.abs(ec) <= 0.5;
      if (!ok) failures++;
      console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(44) + ` ankle ${r.ankle.toFixed(2)} (err ${ea.toFixed(2)})  calf ${r.calf.toFixed(2)} (err ${ec.toFixed(2)})  ` +
        JSON.stringify(r.diagnostics) + (r.warnings.length ? '  ' + r.warnings.join(' ') : ''));
    } catch (error) {
      failures++;
      console.log('FAIL ' + name + ': ' + error.stack);
    }
  }
  // Unsupported and missing inputs give clear messages.
  await assert.rejects(Models.readModel([{name: 'scan.usdz', buffer: new ArrayBuffer(10)}]), /usdz format is not supported/);
  const model = await Models.readModel([{name: 'scan.obj', buffer: toBuffer(writeOBJ(scene))}]);
  assert.throws(() => Models.measureModel(model, NaN), /Enter the Length by tape/);
  console.log(`truth: ankle ${ankleTrue.toFixed(2)}, calf ${calfTrue.toFixed(2)}`);
  if (process.env.WRITE_FIXTURES) {
    const dir = path.join(__dirname, 'fixtures');
    fs.writeFileSync(path.join(dir, 'synthetic-leg-scene.obj'), writeOBJ(scene));
    fs.writeFileSync(path.join(dir, 'synthetic-leg-scene-gltf.zip'), writeGLTFZip(scene));
    console.log('Wrote model fixtures (length 40 cm by tape).');
  }
  if (failures) { console.error(failures + ' format(s) failed'); process.exit(1); }
  console.log('All model upload tests passed.');
})();
