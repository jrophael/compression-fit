/*
 * 3D scan viewer: shows an uploaded scan (with its colour texture where the export has one)
 * in the measurement frame — metres, y up, floor at y = 0, measured leg on the y axis —
 * and reports the height of a tapped point. Tapping the cuff point gives floor-to-cuff length.
 */
import * as THREE from 'three';
import {OrbitControls} from './vendor/three/jsm/controls/OrbitControls.js';
import {GLTFLoader} from './vendor/three/jsm/loaders/GLTFLoader.js';
import {OBJLoader} from './vendor/three/jsm/loaders/OBJLoader.js';
import {MTLLoader} from './vendor/three/jsm/loaders/MTLLoader.js';
import {PLYLoader} from './vendor/three/jsm/loaders/PLYLoader.js';
import {STLLoader} from './vendor/three/jsm/loaders/STLLoader.js';

const extension = name => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const baseName = name => decodeURIComponent(String(name).split(/[\\/]/).pop().split('?')[0]);

let current = null;

function dispose() {
  if (!current) return;
  current.stop();
  current = null;
}

async function loadObject(uploaded, model) {
  let files = [];
  for (const f of uploaded) {
    if (extension(f.name) === 'zip') files = files.concat(await window.CompressionModels.unzip(f.buffer));
    else files.push(f);
  }
  const urls = new Map();
  for (const f of files) urls.set(baseName(f.name), URL.createObjectURL(new Blob([f.buffer])));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => urls.get(baseName(url)) || url);
  const pick = ['glb', 'gltf', 'obj', 'ply', 'stl'].map(ext => files.find(f => extension(f.name) === ext)).find(Boolean);
  const text = f => new TextDecoder().decode(f.buffer);
  const grey = new THREE.MeshStandardMaterial({color: 0xc9b6a6, roughness: 0.8, side: THREE.DoubleSide});
  const done = object => ({object, revoke: () => urls.forEach(u => URL.revokeObjectURL(u))});
  if (!pick) return done(pointCloud(model));
  const ext = extension(pick.name);
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new Promise((resolve, reject) =>
      new GLTFLoader(manager).parse(ext === 'glb' ? pick.buffer : text(pick), '', resolve, reject));
    return done(gltf.scene);
  }
  if (ext === 'obj') {
    const loader = new OBJLoader(manager);
    const mtl = files.find(f => extension(f.name) === 'mtl');
    if (mtl) {
      const materials = new MTLLoader(manager).parse(text(mtl), '');
      materials.preload();
      loader.setMaterials(materials);
    }
    return done(loader.parse(text(pick)));
  }
  if (ext === 'ply') {
    const geometry = new PLYLoader().parse(pick.buffer);
    const colours = geometry.hasAttribute('color');
    if (!geometry.index && !model.triangles) {
      return done(new THREE.Points(geometry, new THREE.PointsMaterial({size: 0.004, vertexColors: colours, color: colours ? 0xffffff : 0xc9b6a6})));
    }
    geometry.computeVertexNormals();
    return done(new THREE.Mesh(geometry, colours ? new THREE.MeshStandardMaterial({vertexColors: true, side: THREE.DoubleSide}) : grey));
  }
  const geometry = new STLLoader().parse(pick.buffer);
  geometry.computeVertexNormals();
  return done(new THREE.Mesh(geometry, grey));
}

function pointCloud(model) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(model.positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({size: 0.004, color: 0xc9b6a6}));
}

function frameMatrix(frame) {
  const rows = [
    [frame.others[0], frame.units, -frame.centre[0]],
    [frame.axis, frame.sign * frame.units, -frame.floor],
    [frame.others[1], frame.sign * frame.units, -frame.centre[1]]
  ];
  const e = rows.map(([axis, factor, offset]) => {
    const row = [0, 0, 0, offset];
    row[axis] = factor;
    return row;
  });
  return new THREE.Matrix4().set(...e[0], ...e[1], ...e[2], 0, 0, 0, 1);
}

/**
 * Show a scan. options: {length (cm, optional marker), onPick(heightCm, point)}.
 * Returns {project(x, y, z) -> client {x, y}} for testing.
 */
async function show(container, files, model, frame, options = {}) {
  dispose();
  container.replaceChildren();
  const width = container.clientWidth || 340;
  const height = Math.round(Math.min(460, Math.max(320, width * 1.15)));

  const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.localClippingEnabled = true;
  // Show only the measured leg and the floor around it.
  renderer.clippingPlanes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.28), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.28),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.28), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.28),
    new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.75)
  ];
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.setAttribute('aria-label', '3D scan of the leg. Drag to turn, pinch or scroll to zoom, tap to mark the cuff point.');
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f7f1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(0.6, 1.2, 0.8);
  scene.add(sun);

  const {object, revoke} = await loadObject(files, model);
  object.traverse(o => {
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.side = THREE.DoubleSide; });
  });
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(frameMatrix(frame));
  holder.add(object);
  scene.add(holder);
  holder.updateMatrixWorld(true);

  // Height guides every 10 cm on a pole beside the leg.
  const guides = new THREE.Group();
  const lineMaterial = new THREE.LineBasicMaterial({color: 0x175b49, transparent: true, opacity: 0.35});
  for (let h = 0.1; h <= 0.6; h += 0.1) {
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      Array.from({length: 48}, (_, k) => new THREE.Vector3(0.13 * Math.cos(k / 48 * 2 * Math.PI), h, 0.13 * Math.sin(k / 48 * 2 * Math.PI)))), lineMaterial);
    guides.add(ring);
  }
  scene.add(guides);

  const marker = new THREE.Group();
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), new THREE.MeshBasicMaterial({color: 0xd23c2a, depthTest: false}));
  dot.renderOrder = 2;
  const level = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    Array.from({length: 64}, (_, k) => new THREE.Vector3(0.11 * Math.cos(k / 64 * 2 * Math.PI), 0, 0.11 * Math.sin(k / 64 * 2 * Math.PI)))),
    new THREE.LineBasicMaterial({color: 0xd23c2a, depthTest: false}));
  level.renderOrder = 2;
  marker.add(dot, level);
  marker.visible = false;
  scene.add(marker);
  const setMarker = (point, h) => {
    marker.visible = true;
    dot.visible = Boolean(point);
    if (point) dot.position.copy(point).setY(0);
    marker.position.set(0, h, 0);
    level.position.set(point ? -0 : 0, 0, 0);
  };
  if (options.length) setMarker(null, options.length / 100);

  const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 10);
  camera.position.set(0.55, 0.45, 0.75);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.3, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.2;
  controls.maxDistance = 2;
  controls.update();

  // Tap (not drag) marks a point.
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.006;
  let down = null;
  renderer.domElement.addEventListener('pointerdown', event => { down = {x: event.clientX, y: event.clientY, t: performance.now()}; });
  renderer.domElement.addEventListener('pointerup', event => {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6 || performance.now() - down.t > 600) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(holder, true).find(h => {
      const p = h.point;
      return Math.abs(p.x) < 0.28 && Math.abs(p.z) < 0.28 && p.y > 0.12 && p.y < 0.75;
    });
    if (!hit) return;
    setMarker(hit.point.clone(), hit.point.y);
    options.onPick?.(hit.point.y * 100, hit.point);
  });

  let running = true;
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();

  current = {
    stop() {
      running = false;
      controls.dispose();
      renderer.dispose();
      revoke();
    }
  };
  return {
    project(x, y, z) {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return {x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height};
    },
    view(position, target) {
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
    },
    setMarkerHeight(h) { setMarker(null, h / 100); }
  };
}

window.CompressionViewer = {show, dispose};
window.dispatchEvent(new Event('compression-viewer-ready'));
