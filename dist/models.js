'use strict';

/*
 * 3D model upload for LiDAR scans made in third-party apps
 * (3d Scanner App, Scaniverse, Polycam and similar).
 *
 * Reads OBJ, PLY (ASCII or binary), STL (ASCII or binary), GLB, glTF (with .bin files
 * or zipped), XYZ/PTS point clouds and ZIP archives containing any of these. It then:
 *  1. samples the surface evenly by area,
 *  2. detects the units (metres or millimetres) and which axis is up, from the floor plane,
 *  3. finds the floor height and the leg standing on it,
 *  4. hands a Compression Fit scan object to scan.js for measurement.
 *
 * The scan has no cuff point, so the floor-to-cuff length comes from a tape measurement.
 */

(function (root) {
  const Scan = root.CompressionScan || (typeof require === 'function' ? require('./scan.js') : null);

  // ---------- File handling ----------

  const extension = name => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const baseName = name => decodeURIComponent(name.split(/[\\/]/).pop());

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open ZIP files. Unzip the export first.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('This ZIP file could not be read.');
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const files = [];
    for (let k = 0; k < count; k++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      offset += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
      const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      let content;
      if (method === 0) content = data.slice();
      else if (method === 8) content = await inflateRaw(data);
      else continue;
      files.push({name, buffer: content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength)});
    }
    return files;
  }

  // ---------- Parsers. Each returns {positions: number[], triangles: number[] | null} ----------

  function parseOBJ(text) {
    const positions = [], triangles = [];
    for (const line of text.split('\n')) {
      if (line.startsWith('v ')) {
        const p = line.trim().split(/\s+/);
        positions.push(+p[1], +p[2], +p[3]);
      } else if (line.startsWith('f ')) {
        const count = positions.length / 3;
        const ids = line.trim().split(/\s+/).slice(1).map(token => {
          const i = parseInt(token, 10);
          return i < 0 ? count + i : i - 1;
        });
        for (let k = 1; k + 1 < ids.length; k++) triangles.push(ids[0], ids[k], ids[k + 1]);
      }
    }
    return {positions, triangles: triangles.length ? triangles : null};
  }

  const PLY_TYPES = {
    char: ['Int8', 1], int8: ['Int8', 1], uchar: ['Uint8', 1], uint8: ['Uint8', 1],
    short: ['Int16', 2], int16: ['Int16', 2], ushort: ['Uint16', 2], uint16: ['Uint16', 2],
    int: ['Int32', 4], int32: ['Int32', 4], uint: ['Uint32', 4], uint32: ['Uint32', 4],
    float: ['Float32', 4], float32: ['Float32', 4], double: ['Float64', 8], float64: ['Float64', 8]
  };

  function parsePLY(buffer) {
    const bytes = new Uint8Array(buffer);
    const headerProbe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    const headerEnd = headerProbe.indexOf('end_header');
    if (!headerProbe.startsWith('ply') || headerEnd < 0) throw new Error('This PLY file has no valid header.');
    const bodyStart = headerProbe.indexOf('\n', headerEnd) + 1;
    const elements = [];
    let format = 'ascii';
    for (const raw of headerProbe.slice(0, headerEnd).split('\n')) {
      const p = raw.trim().split(/\s+/);
      if (p[0] === 'format') format = p[1];
      else if (p[0] === 'element') elements.push({name: p[1], count: +p[2], props: []});
      else if (p[0] === 'property') {
        const element = elements[elements.length - 1];
        if (p[1] === 'list') element.props.push({name: p[4], list: true, countType: p[2], itemType: p[3]});
        else element.props.push({name: p[2], type: p[1]});
      }
    }
    const positions = [], triangles = [];
    if (format === 'ascii') {
      const tokens = new TextDecoder().decode(bytes.subarray(bodyStart)).trim().split(/\s+/);
      let t = 0;
      for (const element of elements) {
        for (let i = 0; i < element.count; i++) {
          const values = {};
          for (const prop of element.props) {
            if (prop.list) {
              const n = +tokens[t++];
              values[prop.name] = tokens.slice(t, t + n).map(Number);
              t += n;
            } else values[prop.name] = +tokens[t++];
          }
          collect(element.name, values);
        }
      }
    } else {
      const little = format === 'binary_little_endian';
      const view = new DataView(buffer);
      let offset = bodyStart;
      const read = type => {
        const [kind, size] = PLY_TYPES[type];
        const value = view['get' + kind](offset, little);
        offset += size;
        return value;
      };
      for (const element of elements) {
        for (let i = 0; i < element.count; i++) {
          const values = {};
          for (const prop of element.props) {
            if (prop.list) {
              const n = read(prop.countType);
              const items = new Array(n);
              for (let k = 0; k < n; k++) items[k] = read(prop.itemType);
              values[prop.name] = items;
            } else values[prop.name] = read(prop.type);
          }
          collect(element.name, values);
        }
      }
    }
    function collect(name, values) {
      if (name === 'vertex') positions.push(values.x, values.y, values.z);
      else if (name === 'face') {
        const ids = values.vertex_indices || values.vertex_index || [];
        for (let k = 1; k + 1 < ids.length; k++) triangles.push(ids[0], ids[k], ids[k + 1]);
      }
    }
    return {positions, triangles: triangles.length ? triangles : null};
  }

  function parseSTL(buffer) {
    const view = new DataView(buffer);
    const positions = [];
    if (buffer.byteLength >= 84 && 84 + 50 * view.getUint32(80, true) === buffer.byteLength) {
      const n = view.getUint32(80, true);
      for (let i = 0; i < n; i++) {
        const base = 84 + 50 * i + 12;
        for (let k = 0; k < 9; k++) positions.push(view.getFloat32(base + 4 * k, true));
      }
    } else {
      const text = new TextDecoder().decode(buffer);
      const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
      let m;
      while ((m = re.exec(text))) positions.push(+m[1], +m[2], +m[3]);
    }
    const triangles = Array.from({length: positions.length / 3}, (_, i) => i);
    return {positions, triangles};
  }

  function parseXYZ(text) {
    const positions = [];
    for (const line of text.split('\n')) {
      const p = line.trim().split(/[\s,;]+/).map(Number);
      if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) positions.push(p[0], p[1], p[2]);
    }
    return {positions, triangles: null};
  }

  // glTF 2.0 (JSON + buffers). Applies node transforms; output is in the glTF frame (y up, metres).
  function parseGLTF(json, buffers) {
    const required = json.extensionsRequired || [];
    if (required.some(e => /draco|meshopt/i.test(e))) {
      throw new Error('This glTF is compressed (' + required.join(', ') + '). Export without compression, or as OBJ.');
    }
    const COMPONENTS = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
    const READERS = {5120: ['Int8', 1], 5121: ['Uint8', 1], 5122: ['Int16', 2], 5123: ['Uint16', 2], 5125: ['Uint32', 4], 5126: ['Float32', 4]};
    function accessor(index) {
      const a = json.accessors[index];
      const bv = json.bufferViews[a.bufferView];
      const buffer = buffers[bv.buffer];
      const view = new DataView(buffer);
      const [kind, size] = READERS[a.componentType];
      const n = COMPONENTS[a.type];
      const stride = bv.byteStride || n * size;
      const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
      const out = new Array(a.count * n);
      for (let i = 0; i < a.count; i++) {
        for (let k = 0; k < n; k++) out[i * n + k] = view['get' + kind](start + i * stride + k * size, true);
      }
      return out;
    }
    const multiply = (a, b) => {
      const out = new Array(16).fill(0);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
      return out;
    };
    const nodeMatrix = node => {
      if (node.matrix) return node.matrix;
      const [tx, ty, tz] = node.translation || [0, 0, 0];
      const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
      const [sx, sy, sz] = node.scale || [1, 1, 1];
      return [
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1
      ];
    };
    const positions = [], triangles = [];
    let pointsOnly = true;
    function visit(nodeIndex, parent) {
      const node = json.nodes[nodeIndex];
      const m = multiply(parent, nodeMatrix(node));
      if (node.mesh !== undefined) {
        for (const primitive of json.meshes[node.mesh].primitives) {
          if (primitive.attributes.POSITION === undefined) continue;
          const base = positions.length / 3;
          const p = accessor(primitive.attributes.POSITION);
          for (let i = 0; i < p.length; i += 3) {
            positions.push(m[0] * p[i] + m[4] * p[i + 1] + m[8] * p[i + 2] + m[12],
              m[1] * p[i] + m[5] * p[i + 1] + m[9] * p[i + 2] + m[13],
              m[2] * p[i] + m[6] * p[i + 1] + m[10] * p[i + 2] + m[14]);
          }
          const mode = primitive.mode === undefined ? 4 : primitive.mode;
          if (mode === 0) continue;
          const ids = primitive.indices !== undefined ? accessor(primitive.indices) : Array.from({length: p.length / 3}, (_, i) => i);
          pointsOnly = false;
          if (mode === 4) for (const i of ids) triangles.push(base + i);
          else if (mode === 5) for (let k = 0; k + 2 < ids.length; k++) triangles.push(base + ids[k], base + ids[k + 1 + (k % 2)], base + ids[k + 2 - (k % 2)]);
          else if (mode === 6) for (let k = 1; k + 1 < ids.length; k++) triangles.push(base + ids[0], base + ids[k], base + ids[k + 1]);
        }
      }
      for (const child of node.children || []) visit(child, m);
    }
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = json.scenes ? json.scenes[json.scene || 0] : {nodes: json.nodes.map((_, i) => i)};
    for (const n of scene.nodes) visit(n, identity);
    return {positions, triangles: pointsOnly ? null : triangles};
  }

  function base64ToBuffer(data) {
    const binary = typeof atob === 'function' ? atob(data) : Buffer.from(data, 'base64').toString('binary');
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
  }

  function parseGLB(buffer, files) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error('This GLB file is not valid.');
    let offset = 12, json = null, bin = null;
    while (offset < buffer.byteLength) {
      const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
      const chunk = buffer.slice(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
      else if (type === 0x004e4942) bin = chunk;
      offset += 8 + length;
    }
    return parseGLTF(json, (json.buffers || []).map(b => b.uri ? resolveUri(b.uri, files) : bin));
  }

  function resolveUri(uri, files) {
    if (uri.startsWith('data:')) return base64ToBuffer(uri.slice(uri.indexOf(',') + 1));
    const wanted = baseName(uri);
    const file = files.find(f => baseName(f.name) === wanted);
    if (!file) throw new Error('The glTF needs "' + wanted + '". Upload it together with the .gltf, or upload the ZIP export.');
    return file.buffer;
  }

  /** files: [{name, buffer: ArrayBuffer}] -> {positions, triangles, format, sourceName} */
  async function readModel(files) {
    let all = [];
    for (const f of files) {
      if (extension(f.name) === 'zip') all = all.concat(await unzip(f.buffer));
      else all.push(f);
    }
    const order = ['glb', 'gltf', 'obj', 'ply', 'stl', 'xyz', 'pts', 'txt'];
    const pick = order.map(ext => all.find(f => extension(f.name) === ext)).find(Boolean);
    if (!pick) {
      const unsupported = all.map(f => extension(f.name)).find(e => ['usdz', 'fbx', 'dae', 'las', 'spz'].includes(e));
      throw new Error(unsupported
        ? 'The .' + unsupported + ' format is not supported. Export as OBJ, GLB, glTF, PLY or STL.'
        : 'No 3D model found. Upload an OBJ, GLB, glTF, PLY, STL or ZIP export.');
    }
    const ext = extension(pick.name);
    const text = () => new TextDecoder().decode(pick.buffer);
    let model;
    if (ext === 'glb') model = parseGLB(pick.buffer, all);
    else if (ext === 'gltf') {
      const json = JSON.parse(text());
      model = parseGLTF(json, (json.buffers || []).map(b => resolveUri(b.uri, all)));
    } else if (ext === 'obj') model = parseOBJ(text());
    else if (ext === 'ply') model = parsePLY(pick.buffer);
    else if (ext === 'stl') model = parseSTL(pick.buffer);
    else model = parseXYZ(text());
    if (model.positions.length < 300) throw new Error('The model has too few points to measure.');
    return {...model, format: ext.toUpperCase(), sourceName: baseName(pick.name)};
  }

  // ---------- Geometry ----------

  function random(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  // Area-uniform surface samples (or the points themselves for point clouds).
  function samplePoints(model, spacing, filter, limit) {
    const P = model.positions, T = model.triangles;
    const out = [];
    if (!T) {
      for (let i = 0; i < P.length; i += 3) if (!filter || filter(P[i], P[i + 1], P[i + 2])) out.push(P[i], P[i + 1], P[i + 2]);
      return out;
    }
    const rand = random(7);
    const perArea = 1 / (spacing * spacing);
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      if (filter && !filter(P[a], P[a + 1], P[a + 2]) && !filter(P[b], P[b + 1], P[b + 2]) && !filter(P[c], P[c + 1], P[c + 2])) continue;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      let n = area * perArea;
      n = Math.floor(n) + (rand() < n - Math.floor(n) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        let r1 = rand(), r2 = rand();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const x = P[a] + r1 * ux + r2 * vx, y = P[a + 1] + r1 * uy + r2 * vy, z = P[a + 2] + r1 * uz + r2 * vz;
        if (!filter || filter(x, y, z)) out.push(x, y, z);
      }
      if (out.length > limit * 3) break;
    }
    return out;
  }

  function surfaceArea(model) {
    const P = model.positions, T = model.triangles;
    if (!T) return 0;
    let total = 0;
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      total += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    return total;
  }

  const percentile = (values, q) => {
    const s = Float64Array.from(values).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  };

  // Floor plane along an up direction: the strongest 1 cm layer near the bottom.
  function floorFor(points, axis, sign) {
    const n = points.length / 3;
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) h[i] = sign * points[3 * i + axis];
    const low = percentile(h, 0.002), high = percentile(h, 0.998);
    const span = high - low;
    if (!(span > 0)) return {score: 0};
    const bins = new Map();
    for (const v of h) {
      if (v > low + 0.25 * span) continue;
      const key = Math.floor((v - low) / 0.005);
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    let bestKey = 0, best = 0;
    for (const [key, count] of bins) {
      const c = count + (bins.get(key - 1) || 0) + (bins.get(key + 1) || 0);
      if (c > best) { best = c; bestKey = key; }
    }
    const centre = low + (bestKey + 0.5) * 0.005;
    const near = Array.from(h).filter(v => Math.abs(v - centre) <= 0.008);
    // Points must rise well above the floor (a leg), or this is a wall or ceiling seen from the wrong side.
    const above = Array.from(h).filter(v => v > centre + 0.15).length / n;
    return {score: (best / n) * (above > 0.05 ? 1 : 0.1), height: near.length ? percentile(near, 0.5) : centre, fraction: best / n};
  }

  /**
   * Convert a model to a Compression Fit scan object and measure it.
   * lengthCm: floor-to-cuff length by tape. Returns scan.js results plus diagnostics.
   */
  function measureModel(model, lengthCm) {
    if (!(lengthCm >= 15 && lengthCm <= 80)) throw new Error('Enter the Length by tape first (floor to two finger widths below the knee crease), then upload the scan.');
    const cuffHeight = lengthCm / 100;
    const warnings = [];

    // 1. Coarse sample for orientation, units and floor.
    const area = surfaceArea(model);
    let units = 1;
    const coarseRaw = samplePoints(model, model.triangles ? Math.max(Math.sqrt(area / 120000), 1e-9) : 1, null, 200000);
    const extent = [0, 1, 2].map(a => {
      const v = []; for (let i = a; i < coarseRaw.length; i += 3) v.push(coarseRaw[i]);
      return percentile(v, 0.99) - percentile(v, 0.01);
    });
    if (Math.max(...extent) > 30) units = 0.001; // millimetres
    const coarse = coarseRaw.map(v => v * units);

    // 2. Up axis: the direction with the strongest floor plane. glTF/OBJ from phone apps are usually y-up.
    const candidates = [];
    for (const axis of [1, 2, 0]) for (const sign of [1, -1]) candidates.push({axis, sign, ...floorFor(coarse, axis, sign)});
    let up = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    const yUp = candidates[0];
    if (yUp.score >= 0.8 * up.score) up = yUp;
    if (up.fraction < 0.02) warnings.push('No clear floor was found. Include the floor around the foot in the scan.');

    // Rotate into a y-up frame with the floor at y = 0.
    const others = [0, 1, 2].filter(a => a !== up.axis);
    const toFrame = (p, i) => [p[i + others[0]] * units, up.sign * p[i + up.axis] * units - up.height, p[i + others[1]] * units * up.sign];

    // 3. Find the leg: a column of points at calf height that also reaches the ankle.
    const frame = [];
    for (let i = 0; i < coarseRaw.length; i += 3) frame.push(toFrame(coarseRaw, i));
    const band = frame.filter(p => p[1] > Math.min(0.2, cuffHeight * 0.5) && p[1] < Math.min(0.34, cuffHeight - 0.03));
    const groups = Scan.clusters2D(band.map(p => p[0]), band.map(p => p[2]), 0.015);
    const legs = [];
    for (const g of groups) {
      if (g.members.length < 30) continue;
      let r = 0;
      for (const i of g.members) r += Math.hypot(band[i][0] - g.u, band[i][2] - g.v);
      const circumference = 2 * Math.PI * r / g.members.length;
      if (circumference < 0.15 || circumference > 0.8) continue;
      const ankle = frame.filter(p => p[1] > 0.06 && p[1] < 0.14 && Math.hypot(p[0] - g.u, p[2] - g.v) < 0.12).length;
      if (ankle < 10) continue;
      legs.push(g);
    }
    if (!legs.length) throw new Error('No leg was found standing on the floor. Scan from the floor up to the knee, all the way around one leg.');
    // Prefer the leg nearest the middle of the scan.
    const mid = frame.filter(p => p[1] > 0.05 && p[1] < 0.6);
    const mx = mid.reduce((s, p) => s + p[0], 0) / mid.length, mz = mid.reduce((s, p) => s + p[2], 0) / mid.length;
    legs.sort((a, b) => Math.hypot(a.u - mx, a.v - mz) - Math.hypot(b.u - mx, b.v - mz));

    // 4. Measure each candidate leg (nearest the middle first) and keep the first one scanned all round.
    const measureLeg = leg => {
      const inRegion = (x, y, z) => {
        const [fx, fy, fz] = toFrame([x, y, z], 0);
        return fy > -0.01 && fy < cuffHeight + 0.1 && Math.hypot(fx - leg.u, fz - leg.v) < 0.3;
      };
      const dense = samplePoints(model, 0.0025 / units, inRegion, 600000);
      const ints = new Int16Array(dense.length);
      let n = 0;
      for (let i = 0; i < dense.length; i += 3) {
        const [x, y, z] = toFrame(dense, i);
        if (y < 0.01) continue;
        ints[n++] = Math.round((x - leg.u) * Scan.SCAN_UNITS_PER_METRE);
        ints[n++] = Math.round(y * Scan.SCAN_UNITS_PER_METRE);
        ints[n++] = Math.round((z - leg.v) * Scan.SCAN_UNITS_PER_METRE);
      }
      return Scan.measureScan({version: Scan.SCAN_FORMAT_VERSION, cuffHeight, points: ints.subarray(0, n)});
    };
    let result = null, firstError = null, chosen = -1, complete = 0;
    for (let k = 0; k < Math.min(legs.length, 4); k++) {
      try {
        const r = measureLeg(legs[k]);
        complete++;
        if (!result) { result = r; chosen = k; }
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (!result) throw firstError;
    if (legs.length > 1) {
      warnings.push(chosen > 0
        ? 'Only one leg was scanned all the way round, and that leg was measured. Make sure it is the leg selected.'
        : complete > 1
          ? 'Both legs were scanned all round; the one nearest the middle of the scan was measured. Crop the scan to one leg to be sure.'
          : 'More than one leg was in the scan; the complete one was measured. Make sure it is the leg selected.');
    }
    result.warnings = warnings.concat(result.warnings);
    result.diagnostics = {format: model.format, source: model.sourceName, units: units === 1 ? 'm' : 'mm',
      up: (up.sign > 0 ? '+' : '-') + 'xyz'[up.axis], legsFound: legs.length, legMeasured: chosen + 1};
    return result;
  }

  const CompressionModels = {readModel, measureModel, parseOBJ, parsePLY, parseSTL, parseGLB, parseGLTF, unzip};
  if (typeof module !== 'undefined') module.exports = CompressionModels;
  if (typeof window !== 'undefined') window.CompressionModels = CompressionModels;
})(typeof window !== 'undefined' ? window : globalThis);
