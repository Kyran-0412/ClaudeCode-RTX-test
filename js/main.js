import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { PRESETS, cloneEntity, serialize, deserialize } from './scene.js';
import { cameraBasis, screenRay } from './camera.js';
import { pick } from './picking.js';
import { drawOverlay } from './overlay.js';
import { add, sub, scale, dot, normalize, clamp } from './math.js';

const STORAGE_KEY = 'lumen-scene-v1';

const glCanvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const viewport = document.getElementById('viewport');
const statSamples = document.getElementById('stat-samples');
const statRate = document.getElementById('stat-rate');

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.hidden = false;
}

let renderer;
try {
  renderer = new Renderer(glCanvas);
} catch (err) {
  showError(err.message);
  throw err;
}

function loadInitialScene() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return deserialize(saved);
  } catch { /* fall through to preset */ }
  return PRESETS.Studio();
}

const app = {
  scene: loadInitialScene(),
  selectedId: null,
  sceneDirty: true,
  displayDirty: true,
  overlayDirty: true,

  get selected() {
    return this.scene.entities.find((e) => e.id === this.selectedId) || null;
  },

  select(id) {
    this.selectedId = id;
    this.overlayDirty = true;
    ui.renderList();
    ui.renderInspector();
  },

  markDirty() {
    this.sceneDirty = true;
    this.overlayDirty = true;
    scheduleSave();
  },
  markDisplayDirty() {
    this.displayDirty = true;
    scheduleSave();
  },

  addEntity(e) {
    this.scene.entities.push(e);
    this.markDirty();
    this.select(e.id);
  },

  deleteSelected() {
    const i = this.scene.entities.findIndex((e) => e.id === this.selectedId);
    if (i < 0) return;
    this.scene.entities.splice(i, 1);
    this.markDirty();
    this.select(null);
  },

  duplicateSelected() {
    const e = this.selected;
    if (!e) return;
    const copy = cloneEntity(e);
    copy.position = add(copy.position, [0.6, 0, 0.6]);
    this.addEntity(copy);
  },

  focusOnSelected() {
    const e = this.selected;
    if (!e) return;
    const b = cameraBasis(this.scene.camera);
    this.scene.settings.focusDist = Math.max(0.2, dot(sub(e.position, b.pos), b.fwd));
    if (this.scene.settings.aperture === 0) this.scene.settings.aperture = 0.08;
    this.markDirty();
    ui.renderSettings();
  },

  loadPreset(name) {
    this.setScene(PRESETS[name]());
  },

  setScene(scene) {
    this.scene = scene;
    this.selectedId = null;
    this.markDirty();
    this.displayDirty = true;
    ui.refresh();
  },

  exportScene() {
    download(new Blob([serialize(this.scene)], { type: 'application/json' }), 'scene.json');
  },

  importScene(text) {
    try {
      this.setScene(deserialize(text));
    } catch (err) {
      alert('Could not load scene: ' + err.message);
    }
  },

  savePNG() {
    glCanvas.toBlob((blob) => blob && download(blob, `render-${renderer.frame}spp.png`), 'image/png');
  },
};

const ui = new UI(app);
ui.refresh();

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, serialize(app.scene)); } catch { /* storage unavailable */ }
  }, 400);
}

// ---------------------------------------------------------------- interaction
const pointers = new Map();
let drag = null; // { mode: 'orbit'|'pan'|'move'|'lift'|'pinch', ... }

function localXY(ev) {
  const r = glCanvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

function rayAt(x, y) {
  const b = cameraBasis(app.scene.camera);
  return screenRay(b, x, y, glCanvas.clientWidth, glCanvas.clientHeight);
}

function intersectPlane(ro, rd, p0, n) {
  const denom = dot(rd, n);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(p0, ro), n) / denom;
  if (t <= 0 || t > 500) return null;
  return add(ro, scale(rd, t));
}

glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

glCanvas.addEventListener('pointerdown', (ev) => {
  glCanvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, localXY(ev));

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { mode: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), distance: app.scene.camera.distance };
    return;
  }

  const [x, y] = localXY(ev);
  const start = { x, y, moved: false };

  if (ev.button === 2 || ev.button === 1 || (ev.button === 0 && (ev.ctrlKey || ev.metaKey))) {
    drag = { ...start, mode: 'pan' };
    return;
  }

  const { ro, rd } = rayAt(x, y);
  const hit = pick(app.scene.entities, ro, rd);
  // Huge objects (ground planes, walls) are selectable from the list but
  // dragging them by accident is annoying, so empty-ish hits on them orbit.
  const big = hit && hit.entity.kind === 'object' && hit.entity.shape === 'box' && Math.max(...hit.entity.size) > 4.5;

  if (hit && !big) {
    const e = hit.entity;
    if (app.selectedId !== e.id) app.select(e.id);
    const hitPoint = add(ro, scale(rd, hit.t));
    if (ev.shiftKey) {
      // Lift: vertical plane facing the camera.
      const b = cameraBasis(app.scene.camera);
      const n = normalize([b.fwd[0], 0, b.fwd[2]]);
      drag = { ...start, mode: 'lift', entity: e, plane: hitPoint, normal: n, offsetY: e.position[1] - hitPoint[1] };
    } else {
      drag = { ...start, mode: 'move', entity: e, plane: hitPoint, normal: [0, 1, 0], offset: sub(e.position, hitPoint) };
    }
  } else {
    drag = { ...start, mode: 'orbit', clickEntity: hit ? hit.entity : null };
  }
});

glCanvas.addEventListener('pointermove', (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  const prev = pointers.get(ev.pointerId);
  const [x, y] = localXY(ev);
  pointers.set(ev.pointerId, [x, y]);
  if (!drag) return;

  const cam = app.scene.camera;
  if (drag.mode === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    cam.distance = clamp(drag.distance * (drag.dist / Math.max(d, 1)), 0.5, 200);
    app.markDirty();
    return;
  }

  const dx = x - prev[0], dy = y - prev[1];
  if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true;
  if (!drag.moved) return;

  if (drag.mode === 'orbit') {
    cam.yaw -= dx * 0.3;
    cam.pitch = clamp(cam.pitch + dy * 0.3, -89, 89);
    app.markDirty();
  } else if (drag.mode === 'pan') {
    const b = cameraBasis(cam);
    const k = (cam.distance * b.tanHalf * 2) / glCanvas.clientHeight;
    cam.target = add(cam.target, add(scale(b.right, -dx * k), scale(b.up, dy * k)));
    app.markDirty();
  } else if (drag.mode === 'move' || drag.mode === 'lift') {
    const { ro, rd } = rayAt(x, y);
    const p = intersectPlane(ro, rd, drag.plane, drag.normal);
    if (!p) return;
    const e = drag.entity;
    if (drag.mode === 'move') {
      e.position = [p[0] + drag.offset[0], e.position[1], p[2] + drag.offset[2]];
    } else {
      e.position = [e.position[0], p[1] + drag.offsetY, e.position[2]];
    }
    app.markDirty();
    ui.syncPosition();
  }
});

function endPointer(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  if (drag && drag.mode === 'orbit' && !drag.moved) {
    // A plain click: select what was under the cursor (or clear selection).
    app.select(drag.clickEntity ? drag.clickEntity.id : null);
  }
  drag = null;
}
glCanvas.addEventListener('pointerup', endPointer);
glCanvas.addEventListener('pointercancel', endPointer);

glCanvas.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const cam = app.scene.camera;
    cam.distance = clamp(cam.distance * Math.exp(ev.deltaY * 0.001), 0.5, 200);
    app.markDirty();
  },
  { passive: false },
);

window.addEventListener('keydown', (ev) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    app.deleteSelected();
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    app.duplicateSelected();
  } else if (ev.key === 'Escape') {
    app.select(null);
  } else if (ev.key.toLowerCase() === 'f' && !ev.ctrlKey && !ev.metaKey) {
    app.focusOnSelected();
  }
});

// ---------------------------------------------------------------- render loop
let rateSamples = 0;
let rateTime = performance.now();

function targetSize() {
  const s = app.scene.settings.resolutionScale;
  const k = s === 'dpr' ? window.devicePixelRatio || 1 : s;
  return [viewport.clientWidth * k, viewport.clientHeight * k];
}

function frame(now) {
  requestAnimationFrame(frame);

  const [w, h] = targetSize();
  if (Math.floor(w) !== renderer.width || Math.floor(h) !== renderer.height) {
    renderer.resize(w, h);
    app.overlayDirty = true;
  }

  const settings = app.scene.settings;
  const basis = cameraBasis(app.scene.camera);

  if (app.sceneDirty) {
    renderer.uploadScene(app.scene);
    renderer.reset();
    app.sceneDirty = false;
  }

  if (renderer.frame < settings.sampleLimit) {
    // While interacting, render a single sample per frame to stay responsive.
    const spp = drag ? 1 : Math.min(settings.sppPerFrame, settings.sampleLimit - renderer.frame);
    for (let i = 0; i < spp; i++) renderer.renderSample(basis, settings);
    rateSamples += spp;
    app.displayDirty = true;
  }

  if (app.displayDirty) {
    renderer.present(settings.exposure);
    app.displayDirty = false;
  }

  if (app.overlayDirty) {
    drawOverlay(overlay, basis, app.selected);
    app.overlayDirty = false;
  }

  if (now - rateTime > 500) {
    const rate = (rateSamples * 1000) / (now - rateTime);
    statRate.textContent = renderer.frame >= settings.sampleLimit ? 'done' : `${rate.toFixed(1)} spp/s`;
    rateSamples = 0;
    rateTime = now;
  }
  statSamples.textContent = `${renderer.frame} spp · ${renderer.width}×${renderer.height}`;
}

requestAnimationFrame(frame);

// For debugging from the console.
window.lumen = { app, renderer };
