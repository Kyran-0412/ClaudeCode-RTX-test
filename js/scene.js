// Scene model: entities (objects + lights), render settings, camera, presets.

import { rotationMatrix, DEG } from './math.js';
import { primitiveToMesh } from './mesh.js';

// Order must match the M_* defines in the trace shader.
export const MATERIAL_TYPES = ['diffuse', 'plastic', 'metal', 'glass'];
// 'mesh' objects are polygon meshes (made in edit mode or added as a plane).
export const SHAPES = ['sphere', 'box', 'cylinder', 'mesh'];

export const MATERIAL_PRESETS = {
  'Matte white': { type: 'diffuse', color: '#d9d9d9', roughness: 1, ior: 1.5 },
  'Clay': { type: 'diffuse', color: '#c9a27c', roughness: 1, ior: 1.5 },
  'Red plastic': { type: 'plastic', color: '#c4231b', roughness: 0.25, ior: 1.5 },
  'Blue plastic': { type: 'plastic', color: '#2257c9', roughness: 0.3, ior: 1.5 },
  'Glossy black': { type: 'plastic', color: '#121212', roughness: 0.06, ior: 1.5 },
  'Gold': { type: 'metal', color: '#ffe39e', roughness: 0.15, ior: 1.5 },
  'Copper': { type: 'metal', color: '#fad0c2', roughness: 0.25, ior: 1.5 },
  'Chrome': { type: 'metal', color: '#d0d1d2', roughness: 0.03, ior: 1.5 },
  'Brushed steel': { type: 'metal', color: '#c4c5c5', roughness: 0.38, ior: 1.5 },
  'Glass': { type: 'glass', color: '#ffffff', roughness: 0, ior: 1.5 },
  'Frosted glass': { type: 'glass', color: '#ffffff', roughness: 0.3, ior: 1.5 },
  'Tinted glass': { type: 'glass', color: '#c3ecdc', roughness: 0, ior: 1.52 },
  'Water': { type: 'glass', color: '#e6f4ff', roughness: 0, ior: 1.33 },
  'Diamond': { type: 'glass', color: '#ffffff', roughness: 0, ior: 2.42 },
};

let nextId = 1;
const newId = () => nextId++;

const defaultMaterial = () => ({
  type: 'diffuse',
  color: '#cccccc',
  roughness: 0.5,
  ior: 1.5,
  emission: 0,
  emissionColor: '#ffffff',
});

const SHAPE_NAMES = { sphere: 'Sphere', box: 'Box', cylinder: 'Cylinder', mesh: 'Mesh' };

export function makeObject(shape = 'sphere', props = {}) {
  const { material, ...rest } = props;
  return {
    id: newId(),
    kind: 'object',
    name: SHAPE_NAMES[shape],
    shape,
    position: [0, 1, 0],
    rotation: [0, 0, 0],
    radius: 1,
    size: [2, 2, 2],
    height: 2,
    scale: [1, 1, 1],
    ...rest,
    material: { ...defaultMaterial(), ...material },
  };
}

export function makeLight(props = {}) {
  return {
    id: newId(),
    kind: 'light',
    name: 'Light',
    position: [0, 4, 0],
    radius: 0.3,
    color: '#fff1de',
    intensity: 30,
    ...props,
  };
}

// A ready-made object of each kind, resting on the surface point `at`.
export const ADDABLE = [
  { kind: 'sphere', label: 'Sphere', key: 'S' },
  { kind: 'box', label: 'Box', key: 'B' },
  { kind: 'cylinder', label: 'Cylinder', key: 'C' },
  { kind: 'plane', label: 'Plane', key: 'P' },
  { kind: 'light', label: 'Light', key: 'L' },
];

export function makeDefault(kind, at = [0, 0, 0]) {
  const [x, y, z] = at;
  if (kind === 'sphere') {
    return makeObject('sphere', { position: [x, y + 0.75, z], radius: 0.75, material: { ...MATERIAL_PRESETS['Blue plastic'] } });
  }
  if (kind === 'box') {
    return makeObject('box', { position: [x, y + 0.6, z], size: [1.2, 1.2, 1.2], material: { ...MATERIAL_PRESETS['Matte white'] } });
  }
  if (kind === 'cylinder') {
    return makeObject('cylinder', { position: [x, y + 0.75, z], radius: 0.5, height: 1.5, material: { ...MATERIAL_PRESETS['Copper'] } });
  }
  if (kind === 'plane') {
    return makeObject('mesh', { name: 'Plane', position: [x, y + 0.01, z], mesh: primitiveToMesh({ shape: 'plane' }), material: { ...MATERIAL_PRESETS['Matte white'] } });
  }
  return makeLight({ position: [x, y + 2.5, z] });
}

// Turns a sphere / box / cylinder into an editable polygon mesh in place.
export function convertToMesh(o) {
  if (o.kind !== 'object' || o.shape === 'mesh') return false;
  o.mesh = primitiveToMesh(o);
  o.shape = 'mesh';
  o.scale = [1, 1, 1];
  return true;
}

export function cloneEntity(e) {
  const copy = JSON.parse(JSON.stringify(e));
  copy.id = newId();
  copy.name = e.name.replace(/( copy)?( \d+)?$/, '') + ' copy';
  return copy;
}

// Half-extents of the shape's unit primitive.
export function localScale(o) {
  if (o.shape === 'mesh') return o.scale;
  if (o.shape === 'sphere') return [o.radius, o.radius, o.radius];
  if (o.shape === 'box') return o.size.map((s) => s / 2);
  return [o.radius, o.height / 2, o.radius];
}

// World transform = translate(position) * R * S.
// `inv` holds the rows of (R*S)^-1 used to move rays into local space;
// `M` holds R*S for drawing outlines.
export function objectFrame(o) {
  const R = rotationMatrix(o.rotation);
  const s = localScale(o).map((v) => Math.max(v, 1e-4));
  const inv = [0, 1, 2].map((i) => [R[0][i] / s[i], R[1][i] / s[i], R[2][i] / s[i]]);
  const M = R.map((row) => row.map((v, j) => v * s[j]));
  return { R, s, inv, M };
}

export function sunDirection(sun) {
  const el = sun.elevation * DEG, az = sun.azimuth * DEG;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

export function defaultSettings() {
  return {
    maxBounces: 6,
    exposure: 1,
    aperture: 0,
    focusDist: 8,
    skyIntensity: 0.8,
    skyZenith: '#4a78c2',
    skyHorizon: '#d6e2f0',
    skyGround: '#5a5148',
    sun: { enabled: true, elevation: 38, azimuth: -35, size: 1.5, intensity: 2.2, color: '#fff1dc' },
    clampLum: 30,
    sppPerFrame: 1,
    sampleLimit: 4096,
    resolutionScale: 1,
  };
}

export function defaultCamera() {
  return { target: [0, 0.9, 0], distance: 8.5, yaw: 20, pitch: 18, fov: 45 };
}

// ---------------------------------------------------------------- presets
const mat = (name, extra = {}) => ({ ...MATERIAL_PRESETS[name], ...extra });

function studio() {
  const settings = defaultSettings();
  settings.exposure = 0.8;
  return {
    settings,
    camera: defaultCamera(),
    entities: [
      makeObject('box', { name: 'Ground', position: [0, -0.5, 0], size: [60, 1, 60], material: mat('Matte white', { color: '#bfbcb6' }) }),
      makeObject('sphere', { name: 'Glass ball', position: [-2.3, 1, 0.4], radius: 1, material: mat('Glass') }),
      makeObject('sphere', { name: 'Gold ball', position: [0, 1, -1.3], radius: 1, material: mat('Gold') }),
      makeObject('sphere', { name: 'Red ball', position: [2.1, 0.7, 0.7], radius: 0.7, material: mat('Red plastic') }),
      makeObject('box', { name: 'Clay cube', position: [-0.2, 0.6, 1.9], size: [1.2, 1.2, 1.2], rotation: [0, 32, 0], material: mat('Clay') }),
      makeObject('cylinder', { name: 'Chrome pillar', position: [2.7, 1.2, -1.9], radius: 0.5, height: 2.4, material: mat('Chrome') }),
      makeLight({ name: 'Warm light', position: [-3.4, 2.2, -1.6], radius: 0.3, color: '#ffc58a', intensity: 20 }),
    ],
  };
}

function cornell() {
  const settings = defaultSettings();
  settings.skyIntensity = 0;
  settings.sun.enabled = false;
  settings.maxBounces = 8;
  const white = mat('Matte white', { color: '#d4d1cb' });
  return {
    settings,
    camera: { target: [0, 2.5, 0], distance: 11.2, yaw: 0, pitch: 0, fov: 37 },
    entities: [
      makeObject('box', { name: 'Floor', position: [0, -0.1, 0], size: [5.4, 0.2, 5.2], material: white }),
      makeObject('box', { name: 'Ceiling', position: [0, 5.1, 0], size: [5.4, 0.2, 5.2], material: white }),
      makeObject('box', { name: 'Back wall', position: [0, 2.5, -2.7], size: [5.4, 5.4, 0.2], material: white }),
      makeObject('box', { name: 'Red wall', position: [-2.6, 2.5, 0], size: [0.2, 5.4, 5.2], material: mat('Matte white', { color: '#b82418' }) }),
      makeObject('box', { name: 'Green wall', position: [2.6, 2.5, 0], size: [0.2, 5.4, 5.2], material: mat('Matte white', { color: '#2f9a3a' }) }),
      makeObject('box', { name: 'Tall block', position: [-0.9, 1.5, -0.8], size: [1.4, 3, 1.4], rotation: [0, 22, 0], material: white }),
      makeObject('sphere', { name: 'Glass ball', position: [1.1, 0.9, 0.8], radius: 0.9, material: mat('Glass') }),
      makeLight({ name: 'Ceiling light', position: [0, 4.45, 0], radius: 0.45, color: '#fff4e5', intensity: 45 }),
    ],
  };
}

function neon() {
  const settings = defaultSettings();
  settings.skyIntensity = 0.015;
  settings.sun.enabled = false;
  settings.exposure = 1.3;
  return {
    settings,
    camera: { target: [0, 1, 0], distance: 8, yaw: -12, pitch: 14, fov: 45 },
    entities: [
      makeObject('box', { name: 'Floor', position: [0, -0.5, 0], size: [40, 1, 40], material: mat('Glossy black', { color: '#1c1c22', roughness: 0.12 }) }),
      makeObject('box', { name: 'Back wall', position: [0, 3, -4], size: [40, 8, 0.5], material: mat('Matte white', { color: '#3a3a40' }) }),
      makeObject('sphere', { name: 'Chrome ball', position: [0, 1.1, 0], radius: 1.1, material: mat('Chrome') }),
      makeObject('sphere', { name: 'Glass ball', position: [-1.8, 0.6, 1.4], radius: 0.6, material: mat('Glass') }),
      makeObject('box', { name: 'Block', position: [2, 0.5, 1.2], size: [1, 1, 1], rotation: [0, 40, 0], material: mat('Matte white') }),
      makeObject('cylinder', { name: 'Glow tube', position: [-3, 1.5, -2.5], radius: 0.08, height: 3, material: mat('Matte white', { emission: 6, emissionColor: '#ffb347' }) }),
      makeLight({ name: 'Magenta', position: [-2.6, 1.4, -1], radius: 0.25, color: '#ff2f6d', intensity: 18 }),
      makeLight({ name: 'Cyan', position: [2.6, 1.6, -1.2], radius: 0.25, color: '#2fc3ff', intensity: 18 }),
      makeLight({ name: 'Violet', position: [0.9, 3.1, -1.8], radius: 0.3, color: '#a070ff', intensity: 14 }),
    ],
  };
}

export const PRESETS = { Studio: studio, 'Cornell box': cornell, 'Neon night': neon };

// ---------------------------------------------------------------- (de)serialisation
export function serialize(scene) {
  return JSON.stringify(
    { version: 1, settings: scene.settings, camera: scene.camera, entities: scene.entities },
    null,
    2,
  );
}

export function deserialize(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.entities)) throw new Error('Not a scene file');
  const base = defaultSettings();
  const settings = { ...base, ...data.settings, sun: { ...base.sun, ...(data.settings?.sun || {}) } };
  const entities = data.entities.map((e) => {
    if (e.kind === 'light') return makeLight({ ...e, id: undefined });
    const shape = SHAPES.includes(e.shape) && (e.shape !== 'mesh' || e.mesh) ? e.shape : 'sphere';
    return makeObject(shape, { ...e, id: undefined });
  });
  // makeObject/makeLight spread `id: undefined` over the fresh id, so reassign.
  for (const e of entities) e.id = newId();
  return { settings, camera: { ...defaultCamera(), ...data.camera }, entities };
}
