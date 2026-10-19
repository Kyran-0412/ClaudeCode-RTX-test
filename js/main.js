import { Renderer } from './renderer.js';
import { UI } from './ui.js';
import { PRESETS, ADDABLE, makeDefault, cloneEntity, serialize, deserialize } from './scene.js';
import { TransformTool } from './transform.js';
import { cameraBasis, screenRay } from './camera.js';
import { pick } from './picking.js';
import { drawOverlay } from './overlay.js';
import { add, sub, scale, dot, clamp } from './math.js';

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
    if (this.tool?.active && this.tool.state.entity.id !== id) this.tool.confirm();
    this.selectedId = id;
    this.overlayDirty = true;
    ui.renderList();
    ui.renderInspector();
    updateHint();
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

  duplicateSelected({ offset = true } = {}) {
    const e = this.selected;
    if (!e) return;
    const copy = cloneEntity(e);
    if (offset) copy.position = add(copy.position, [0.6, 0, 0.6]);
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
    if (this.tool?.active) this.tool.cancel();
    this.scene = scene;
    this.selectedId = null;
    this.markDirty();
    this.displayDirty = true;
    ui.refresh();
  },

  exportScene() {
    const text = serialize(this.scene);
    const area = document.createElement('textarea');
    area.id = 'export-text';
    area.readOnly = true;
    area.value = text;
    const copy = document.createElement('button');
    copy.textContent = 'Copy to clipboard';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copied';
      } catch {
        area.select();
        copy.textContent = 'Press Ctrl/⌘+C to copy';
      }
    };
    showModal('Scene file', 'Copy this text and save it as a .json file. Use Import scene to load it again.', area, copy);
  },

  importScene(text) {
    try {
      this.setScene(deserialize(text));
    } catch (err) {
      showModal('Could not load scene', `That file isn't a Lumen scene (${err.message}). Pick a .json file made with Export scene.`);
    }
  },

  savePNG() {
    glCanvas.toBlob((blob) => {
      if (!blob) return;
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.alt = `Render at ${renderer.frame} samples per pixel`;
      showModal(`Render · ${renderer.frame} spp`, 'Right-click the image (or long-press on a phone) and choose Save Image.', img);
    }, 'image/png');
  },
};

const ui = new UI(app);
ui.refresh();

// Simple in-page dialog (browser alerts and downloads are blocked when the
// app is embedded, so results are shown here instead).
const modal = document.getElementById('modal');
function showModal(title, message, ...content) {
  modal.querySelector('h2').textContent = title;
  modal.querySelector('p').textContent = message;
  const body = modal.querySelector('.modal-body');
  for (const img of body.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  body.replaceChildren(...content);
  modal.hidden = false;
}
function closeModal() {
  modal.hidden = true;
}
modal.addEventListener('click', (ev) => { if (ev.target === modal) closeModal(); });
document.getElementById('modal-close').onclick = closeModal;

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, serialize(app.scene)); } catch { /* storage unavailable */ }
  }, 400);
}

// ---------------------------------------------------------------- interaction
// Clicking selects; dragging the view orbits/pans. Objects are moved, rotated
// and scaled with the G / R / S keyboard transforms (see transform.js).
const pointers = new Map();
let drag = null; // { mode: 'orbit'|'pan'|'pinch', ... }
let mouse = [0, 0]; // last cursor position relative to the canvas

function localXY(ev) {
  const r = glCanvas.getBoundingClientRect();
  return [ev.clientX - r.left, ev.clientY - r.top];
}

function rayAt(x, y) {
  const b = cameraBasis(app.scene.camera);
  return screenRay(b, x, y, glCanvas.clientWidth, glCanvas.clientHeight);
}

const tool = new TransformTool({
  basis: () => cameraBasis(app.scene.camera),
  size: () => [glCanvas.clientWidth, glCanvas.clientHeight],
  rayAt,
  onChange: () => {
    app.markDirty();
    ui.syncPosition();
    updateHint();
  },
  onEnd: () => {
    app.overlayDirty = true;
    ui.renderInspector();
    updateHint();
  },
});
app.tool = tool;

// ---------------------------------------------------------------- hint bar
const hint = document.getElementById('hint');
const k = (key) => `<kbd>${key}</kbd>`;
function updateHint() {
  if (tool.active) {
    hint.classList.add('transforming');
    hint.innerHTML =
      `${tool.state.status}<br><span class="keys">${k('X')} ${k('Y')} ${k('Z')} axis · ` +
      `${k('Shift')}+axis: lock axis · type a number · ${k('Ctrl')} snap · ` +
      `click/${k('Enter')} confirm · right-click/${k('Esc')} cancel</span>`;
    return;
  }
  hint.classList.remove('transforming');
  hint.innerHTML = app.selected
    ? `${k('G')} move · ${k('R')} rotate · ${k('S')} scale · ${k('.')} center view · ${k('Shift')}+${k('D')} duplicate · ${k('Del')} delete · ${k('Shift')}+${k('A')} add`
    : `Click: select · ${k('Shift')}+${k('A')} add · ${k('1')} ${k('2')} ${k('3')} view · Drag: orbit · Right-drag: pan · Wheel: zoom`;
}

// ---------------------------------------------------------------- add menu
const addMenu = document.getElementById('add-menu');
let menuIndex = 0;
let menuPoint = [0, 0, 0];

for (const item of ADDABLE) {
  const btn = document.createElement('button');
  btn.setAttribute('role', 'menuitem');
  btn.innerHTML = `${item.label}<span class="key">${item.key}</span>`;
  btn.addEventListener('click', () => addFromMenu(item.kind));
  btn.addEventListener('pointerenter', () => setMenuIndex(ADDABLE.indexOf(item)));
  addMenu.append(btn);
}

function setMenuIndex(i) {
  menuIndex = (i + ADDABLE.length) % ADDABLE.length;
  addMenu.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === menuIndex));
}

// Opens the menu at the cursor. New objects land on the surface under it.
function openAddMenu() {
  const [x, y] = mouse;
  const { ro, rd } = rayAt(x, y);
  const hit = pick(app.scene.entities.filter((e) => e.kind === 'object'), ro, rd);
  if (hit) {
    menuPoint = add(ro, scale(rd, hit.t));
  } else if (rd[1] < -1e-3) {
    menuPoint = add(ro, scale(rd, -ro[1] / rd[1])); // ground plane y = 0
  } else {
    menuPoint = [app.scene.camera.target[0], 0, app.scene.camera.target[2]];
  }
  addMenu.hidden = false;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  addMenu.style.left = `${clamp(x, 8, Math.max(8, vw - addMenu.offsetWidth - 8))}px`;
  addMenu.style.top = `${clamp(y, 8, Math.max(8, vh - addMenu.offsetHeight - 8))}px`;
  setMenuIndex(0);
}

function closeAddMenu() {
  addMenu.hidden = true;
}

function addFromMenu(kind) {
  closeAddMenu();
  app.addEntity(makeDefault(kind, menuPoint));
}

function handleMenuKey(ev) {
  const key = ev.key.toLowerCase();
  ev.preventDefault();
  if (ev.key === 'Escape') closeAddMenu();
  else if (ev.key === 'ArrowDown') setMenuIndex(menuIndex + 1);
  else if (ev.key === 'ArrowUp') setMenuIndex(menuIndex - 1);
  else if (ev.key === 'Enter') addFromMenu(ADDABLE[menuIndex].kind);
  else {
    const item = ADDABLE.find((i) => i.key.toLowerCase() === key);
    if (item) addFromMenu(item.kind);
  }
}

window.addEventListener('pointerdown', (ev) => {
  if (!addMenu.hidden && !addMenu.contains(ev.target)) closeAddMenu();
}, true);

// ---------------------------------------------------------------- pointer
window.addEventListener('pointermove', (ev) => {
  mouse = localXY(ev);
  if (tool.active) tool.setMouse(mouse, ev.ctrlKey || ev.metaKey);
});

glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Any click while transforming finishes it: left confirms, right cancels.
window.addEventListener('pointerdown', (ev) => {
  if (!tool.active) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.button === 2) tool.cancel();
  else tool.confirm();
}, true);

glCanvas.addEventListener('pointerdown', (ev) => {
  // Let keyboard shortcuts reach the app instead of a focused panel field.
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  glCanvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, localXY(ev));

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { mode: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), distance: app.scene.camera.distance };
    return;
  }

  const [x, y] = localXY(ev);
  const pan = ev.button === 2 || ev.button === 1 || (ev.button === 0 && (ev.ctrlKey || ev.metaKey));
  drag = { x, y, moved: false, mode: pan ? 'pan' : 'orbit', button: ev.button };
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
  } else {
    const b = cameraBasis(cam);
    const kpx = (cam.distance * b.tanHalf * 2) / glCanvas.clientHeight;
    cam.target = add(cam.target, add(scale(b.right, -dx * kpx), scale(b.up, dy * kpx)));
    app.markDirty();
  }
});

function endPointer(ev) {
  if (!pointers.has(ev.pointerId)) return;
  pointers.delete(ev.pointerId);
  if (drag && drag.mode === 'orbit' && drag.button === 0 && !drag.moved) {
    // A plain click: select what is under the cursor, or clear the selection.
    const { ro, rd } = rayAt(drag.x, drag.y);
    const hit = pick(app.scene.entities, ro, rd);
    app.select(hit ? hit.entity.id : null);
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

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (ev) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if (!modal.hidden) {
    if (ev.key === 'Escape') closeModal();
    return;
  }
  if (!addMenu.hidden) {
    handleMenuKey(ev);
    return;
  }

  const key = ev.key.toLowerCase();
  const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;

  if (tool.active) {
    // G / R / S switch to another transform, keeping what was done so far.
    if (plain && !ev.shiftKey && TRANSFORM_KEYS[key]) {
      ev.preventDefault();
      tool.start(TRANSFORM_KEYS[key], tool.state.entity, mouse);
    } else if (tool.handleKey(ev)) {
      ev.preventDefault();
    }
    return;
  }

  if (ev.shiftKey && plain && key === 'a') {
    ev.preventDefault();
    openAddMenu();
  } else if (ev.shiftKey && plain && key === 'd') {
    ev.preventDefault();
    if (app.selected) {
      app.duplicateSelected({ offset: false });
      tool.start('grab', app.selected, mouse);
    }
  } else if (plain && !ev.shiftKey && TRANSFORM_KEYS[key]) {
    ev.preventDefault();
    if (app.selected) tool.start(TRANSFORM_KEYS[key], app.selected, mouse);
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    app.deleteSelected();
  } else if ((ev.ctrlKey || ev.metaKey) && key === 'd') {
    ev.preventDefault();
    app.duplicateSelected();
  } else if (ev.key === 'Escape') {
    app.select(null);
  } else if (plain && key === 'f') {
    app.focusOnSelected();
  } else if (plain && !ev.shiftKey && ['1', '2', '3'].includes(ev.key)) {
    setViewMode(VIEW_MODES[Number(ev.key) - 1]);
  } else if (plain && (ev.key === '.' || ev.code === 'NumpadDecimal')) {
    ev.preventDefault();
    centerViewOnSelected();
  }
});

// Moves the camera's orbit pivot to the selected object, gliding over ~0.3 s.
// The camera keeps its angle and distance, so the view slides across.
let pivotAnim = 0;
function centerViewOnSelected() {
  const e = app.selected;
  if (!e) return;
  const cam = app.scene.camera;
  const from = cam.target.slice();
  const to = e.position.slice();
  const t0 = performance.now();
  cancelAnimationFrame(pivotAnim);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / 300);
    const ease = 1 - Math.pow(1 - t, 3);
    cam.target = from.map((v, i) => v + (to[i] - v) * ease);
    app.markDirty();
    if (t < 1) pivotAnim = requestAnimationFrame(step);
  };
  pivotAnim = requestAnimationFrame(step);
}

window.addEventListener('keyup', (ev) => {
  if (tool.active && (ev.key === 'Control' || ev.key === 'Meta')) tool.setSnap(false);
});

const TRANSFORM_KEYS = { g: 'grab', r: 'rotate', s: 'scale' };

updateHint();

// ---------------------------------------------------------------- view modes
// 'wire' (lines only), 'solid' (grey shapes, instant) or 'render' (path traced).
const VIEW_KEY = 'lumen-view-mode';
const VIEW_MODES = ['wire', 'solid', 'render'];
const WIRE_BG = [0.075, 0.08, 0.095];
const viewButtons = document.querySelectorAll('#view-modes button');
let viewMode = 'render';
try {
  const saved = localStorage.getItem(VIEW_KEY);
  if (VIEW_MODES.includes(saved)) viewMode = saved;
} catch { /* storage unavailable */ }

function setViewMode(mode) {
  viewMode = mode;
  try { localStorage.setItem(VIEW_KEY, mode); } catch { /* storage unavailable */ }
  viewButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  renderer.reset();
  app.displayDirty = true;
  app.overlayDirty = true;
}
viewButtons.forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode)));
setViewMode(viewMode);

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

  if (viewMode === 'render') {
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
  } else if (viewMode === 'solid') {
    // A handful of jittered samples is enough to anti-alias the edges.
    if (renderer.frame < 8) {
      renderer.renderSample(basis, settings, true);
      app.displayDirty = true;
    }
    if (app.displayDirty) {
      renderer.present(1, true);
      app.displayDirty = false;
    }
  } else if (app.displayDirty) {
    renderer.clearScreen(WIRE_BG);
    app.displayDirty = false;
  }

  if (app.overlayDirty) {
    drawOverlay(overlay, basis, app.selected, {
      guides: tool.guides(),
      wireframe: viewMode === 'wire' ? { entities: app.scene.entities } : null,
    });
    app.overlayDirty = false;
  }

  if (viewMode !== 'render') {
    statRate.textContent = '';
    statSamples.textContent = viewMode === 'solid' ? 'Solid preview' : `Wireframe · ${app.scene.entities.length} items`;
    return;
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
