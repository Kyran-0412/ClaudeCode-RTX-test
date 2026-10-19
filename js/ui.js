// Side panel: add buttons, scene list, inspector and render settings.

import { MATERIAL_PRESETS, MATERIAL_TYPES, PRESETS, makeDefault } from './scene.js';
import { SELECT_MODES, SELECT_MODE_NAMES } from './editmode.js';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const fmt = (v, step) => {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return Number(v).toFixed(decimals);
};

function numberInput(value, step, onChange, opts = {}) {
  const input = h('input', { type: 'number', step, min: opts.min, max: opts.max, value: fmt(value, step) });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(opts.min !== undefined ? Math.max(opts.min, v) : v);
  });
  return input;
}

function row(label, ...controls) {
  return h('div', { class: 'row' }, h('label', { text: label }), h('div', { class: 'controls' }, ...controls));
}

function vec3Row(label, arr, step, onChange, refs) {
  const inputs = ['x', 'y', 'z'].map((axis, i) => {
    const input = numberInput(arr[i], step, (v) => { arr[i] = v; onChange(); });
    return h('span', { class: `axis axis-${axis}` }, h('i', { text: axis }), input);
  });
  if (refs) refs.push(...inputs.map((s) => s.querySelector('input')));
  return row(label, h('div', { class: 'vec3' }, inputs));
}

function sliderRow(label, value, { min, max, step }, onChange) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = numberInput(value, step, (v) => { range.value = v; onChange(v); }, { min });
  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    num.value = fmt(v, step);
    onChange(v);
  });
  return row(label, h('div', { class: 'slider' }, range, num));
}

function colorRow(label, value, onChange) {
  const input = h('input', { type: 'color', value });
  input.addEventListener('input', () => onChange(input.value));
  return row(label, input);
}

function selectRow(label, options, value, onChange) {
  const sel = h('select', {}, options.map(([v, text]) => h('option', { value: v, text, selected: v === value })));
  sel.addEventListener('change', () => onChange(sel.value));
  return row(label, sel);
}

function checkRow(label, value, onChange) {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return row(label, input);
}

const TYPE_LABELS = { diffuse: 'Diffuse', plastic: 'Plastic (glossy)', metal: 'Metal', glass: 'Glass' };

export class UI {
  constructor(app) {
    this.app = app;
    this.listEl = document.getElementById('entity-list');
    this.inspectorEl = document.getElementById('inspector');
    this.settingsEl = document.getElementById('settings');
    this.positionInputs = [];
    this.bindToolbar();
  }

  bindToolbar() {
    const app = this.app;
    const presetSel = document.getElementById('preset');
    for (const name of Object.keys(PRESETS)) presetSel.append(h('option', { value: name, text: name }));
    presetSel.addEventListener('change', () => {
      if (presetSel.value) app.loadPreset(presetSel.value);
      presetSel.value = '';
    });

    const spawnPoint = () => {
      const t = app.scene.camera.target;
      return [t[0] + (Math.random() - 0.5), 0, t[2] + (Math.random() - 0.5)];
    };
    for (const kind of ['sphere', 'box', 'cylinder', 'light']) {
      document.getElementById(`add-${kind}`).onclick = () => app.addEntity(makeDefault(kind, spawnPoint()));
    }

    document.getElementById('undo').onclick = () => app.undo();
    document.getElementById('redo').onclick = () => app.redo();
    document.getElementById('export').onclick = () => app.exportScene();
    document.getElementById('save-png').onclick = () => app.savePNG();
    const file = document.getElementById('import-file');
    document.getElementById('import').onclick = () => file.click();
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (f) app.importScene(await f.text());
      file.value = '';
    });
  }

  refresh() {
    this.renderList();
    this.renderInspector();
    this.renderSettings();
  }

  renderList() {
    const app = this.app;
    this.listEl.replaceChildren(
      ...app.scene.entities.map((e) => {
        const swatch = e.kind === 'light' ? e.color : e.material.color;
        const kind = e.kind === 'light' ? 'light' : e.shape;
        return h(
          'li',
          {
            class: e.id === app.selectedId ? 'selected' : '',
            onclick: () => app.select(e.id),
          },
          h('span', { class: `swatch ${e.kind === 'light' ? 'is-light' : ''}`, style: `--c:${swatch}` }),
          h('span', { class: 'name', text: e.name }),
          h('span', { class: 'kind', text: kind }),
        );
      }),
    );
    if (!app.scene.entities.length) this.listEl.append(h('li', { class: 'empty', text: 'Scene is empty — add something above.' }));
  }

  renderInspector() {
    const app = this.app;
    const e = app.selected;
    this.positionInputs = [];
    if (!e) {
      this.inspectorEl.replaceChildren(h('p', { class: 'muted', text: 'Click an object in the view or the list to edit it.' }));
      return;
    }
    if (app.edit.active) {
      this.renderEditPanel();
      return;
    }
    const changed = () => app.markDirty();
    const changedList = () => { app.markDirty(); this.renderList(); };
    const rows = [];

    const nameInput = h('input', { type: 'text', value: e.name });
    nameInput.addEventListener('input', () => { e.name = nameInput.value; this.renderList(); });
    rows.push(row('Name', nameInput));
    rows.push(vec3Row('Position', e.position, 0.1, changed, this.positionInputs));

    if (e.kind === 'light') {
      rows.push(sliderRow('Radius', e.radius, { min: 0.02, max: 2, step: 0.01 }, (v) => { e.radius = v; changed(); }));
      rows.push(colorRow('Color', e.color, (v) => { e.color = v; changedList(); }));
      rows.push(sliderRow('Intensity', e.intensity, { min: 0, max: 200, step: 0.5 }, (v) => { e.intensity = v; changed(); }));
    } else {
      rows.push(vec3Row('Rotation°', e.rotation, 5, changed));
      if (e.shape === 'sphere') {
        rows.push(sliderRow('Radius', e.radius, { min: 0.05, max: 5, step: 0.05 }, (v) => { e.radius = v; changed(); }));
      } else if (e.shape === 'box') {
        rows.push(vec3Row('Size', e.size, 0.1, () => { e.size = e.size.map((s) => Math.max(0.01, s)); changed(); }));
      } else if (e.shape === 'mesh') {
        rows.push(vec3Row('Scale', e.scale, 0.1, () => { e.scale = e.scale.map((s) => (Math.abs(s) < 0.001 ? 0.001 : s)); changed(); }));
        rows.push(h('p', { class: 'muted small', text: `Mesh · ${e.mesh.vertices.length} vertices · ${e.mesh.faces.length} faces` }));
      } else {
        rows.push(sliderRow('Radius', e.radius, { min: 0.05, max: 5, step: 0.05 }, (v) => { e.radius = v; changed(); }));
        rows.push(sliderRow('Height', e.height, { min: 0.05, max: 10, step: 0.05 }, (v) => { e.height = v; changed(); }));
      }

      const m = e.material;
      rows.push(h('h3', { text: 'Material' }));
      rows.push(
        selectRow(
          'Preset',
          [['', 'Apply preset…'], ...Object.keys(MATERIAL_PRESETS).map((k) => [k, k])],
          '',
          (v) => {
            if (!v) return;
            Object.assign(m, MATERIAL_PRESETS[v]);
            changedList();
            this.renderInspector();
          },
        ),
      );
      rows.push(
        selectRow('Type', MATERIAL_TYPES.map((t) => [t, TYPE_LABELS[t]]), m.type, (v) => {
          m.type = v;
          changed();
          this.renderInspector();
        }),
      );
      rows.push(colorRow(m.type === 'glass' ? 'Tint' : 'Color', m.color, (v) => { m.color = v; changedList(); }));
      if (m.type !== 'diffuse') {
        rows.push(sliderRow('Roughness', m.roughness, { min: 0, max: 1, step: 0.01 }, (v) => { m.roughness = v; changed(); }));
      }
      if (m.type === 'glass' || m.type === 'plastic') {
        rows.push(sliderRow('IOR', m.ior, { min: 1, max: 2.6, step: 0.01 }, (v) => { m.ior = v; changed(); }));
      }
      rows.push(sliderRow('Glow', m.emission, { min: 0, max: 50, step: 0.1 }, (v) => { m.emission = v; changed(); }));
      rows.push(colorRow('Glow color', m.emissionColor, (v) => { m.emissionColor = v; changed(); }));
    }

    rows.push(
      h(
        'div',
        { class: 'button-row' },
        e.kind === 'object' &&
          h('button', {
            text: 'Edit mesh',
            title: e.shape === 'mesh' ? 'Edit vertices and faces (Tab)' : 'Turns this shape into an editable mesh (Tab)',
            onclick: () => app.enterEdit(),
          }),
        h('button', { text: 'Focus', title: 'Set depth-of-field focus to this object (F)', onclick: () => app.focusOnSelected() }),
        h('button', { text: 'Duplicate', title: 'Ctrl/Cmd + D', onclick: () => app.duplicateSelected() }),
        h('button', { class: 'danger', text: 'Delete', title: 'Delete / Backspace', onclick: () => app.deleteSelected() }),
      ),
    );
    this.inspectorEl.replaceChildren(...rows);
  }

  // Inspector while editing a mesh: select mode, selection centre, actions.
  renderEditPanel() {
    const app = this.app;
    const edit = app.edit;
    const e = edit.entity;
    this.positionInputs = [];
    const rows = [h('p', { class: 'edit-title' }, h('strong', { text: e.name }), ' · edit mode')];

    rows.push(
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Select mode' },
        SELECT_MODES.map((m, i) =>
          h('button', {
            text: SELECT_MODE_NAMES[m],
            title: `${SELECT_MODE_NAMES[m]} select (${i + 1})`,
            'aria-pressed': String(edit.mode === m),
            onclick: () => app.setSelectMode(m),
          }),
        ),
      ),
    );

    const n = edit.count();
    const noun = { vert: 'vertex', edge: 'edge', face: 'face' }[edit.mode];
    const plural = { vert: 'vertices', edge: 'edges', face: 'faces' }[edit.mode];
    rows.push(h('p', { class: 'muted small', text: `${n} ${n === 1 ? noun : plural} selected · mesh has ${e.mesh.vertices.length} vertices, ${e.mesh.faces.length} faces` }));

    const median = edit.median();
    if (median) {
      const values = median.slice();
      rows.push(vec3Row('Median', values, 0.1, () => { edit.setMedian(values); app.markDirty(); }, this.positionInputs));
    }

    rows.push(
      checkRow('Smooth shading', e.mesh.smooth !== false, (v) => { e.mesh.smooth = v; app.markDirty(); }),
    );
    rows.push(
      h(
        'div',
        { class: 'button-row' },
        h('button', { text: 'Extrude', title: 'E', disabled: !n, onclick: () => app.startExtrude() }),
        h('button', { text: 'Inset', title: 'I', disabled: !n, onclick: () => app.startInset() }),
        h('button', { text: 'Select all', title: 'A', onclick: () => { edit.selectAll(); app.editSelectionChanged(); } }),
        h('button', { class: 'danger', text: 'Delete', title: 'Delete / X', disabled: !n, onclick: () => app.deleteSelected() }),
        h('button', { text: 'Done', title: 'Tab', onclick: () => app.exitEdit() }),
      ),
    );
    this.inspectorEl.replaceChildren(...rows);
  }

  // Called while dragging so the numbers follow the object.
  syncPosition() {
    if (this.app.edit.active) {
      const m = this.app.edit.median();
      if (m) this.positionInputs.forEach((input, i) => { if (document.activeElement !== input) input.value = fmt(m[i], 0.1); });
      return;
    }
    const e = this.app.selected;
    if (!e) return;
    this.positionInputs.forEach((input, i) => {
      if (document.activeElement !== input) input.value = fmt(e.position[i], 0.1);
    });
  }

  renderSettings() {
    const app = this.app;
    const s = app.scene.settings;
    const cam = app.scene.camera;
    const changed = () => app.markDirty();
    const display = () => app.markDisplayDirty();

    const group = (title, open, ...rows) => h('details', { open }, h('summary', { text: title }), ...rows);

    this.settingsEl.replaceChildren(
      group(
        'Camera & lens',
        true,
        sliderRow('Exposure', s.exposure, { min: 0.05, max: 5, step: 0.05 }, (v) => { s.exposure = v; display(); }),
        sliderRow('Field of view', cam.fov, { min: 10, max: 110, step: 1 }, (v) => { cam.fov = v; changed(); }),
        sliderRow('Aperture', s.aperture, { min: 0, max: 0.5, step: 0.005 }, (v) => { s.aperture = v; changed(); }),
        sliderRow('Focus distance', s.focusDist, { min: 0.2, max: 40, step: 0.05 }, (v) => { s.focusDist = v; changed(); }),
      ),
      group(
        'Sky',
        false,
        sliderRow('Brightness', s.skyIntensity, { min: 0, max: 4, step: 0.01 }, (v) => { s.skyIntensity = v; changed(); }),
        colorRow('Zenith', s.skyZenith, (v) => { s.skyZenith = v; changed(); }),
        colorRow('Horizon', s.skyHorizon, (v) => { s.skyHorizon = v; changed(); }),
        colorRow('Below horizon', s.skyGround, (v) => { s.skyGround = v; changed(); }),
      ),
      group(
        'Sun',
        false,
        checkRow('Enabled', s.sun.enabled, (v) => { s.sun.enabled = v; changed(); }),
        sliderRow('Elevation°', s.sun.elevation, { min: -10, max: 90, step: 1 }, (v) => { s.sun.elevation = v; changed(); }),
        sliderRow('Azimuth°', s.sun.azimuth, { min: -180, max: 180, step: 1 }, (v) => { s.sun.azimuth = v; changed(); }),
        sliderRow('Intensity', s.sun.intensity, { min: 0, max: 20, step: 0.1 }, (v) => { s.sun.intensity = v; changed(); }),
        sliderRow('Size° (softness)', s.sun.size, { min: 0.1, max: 15, step: 0.1 }, (v) => { s.sun.size = v; changed(); }),
        colorRow('Color', s.sun.color, (v) => { s.sun.color = v; changed(); }),
      ),
      group(
        'Quality',
        false,
        sliderRow('Max bounces', s.maxBounces, { min: 1, max: 24, step: 1 }, (v) => { s.maxBounces = Math.round(v); changed(); }),
        sliderRow('Samples / frame', s.sppPerFrame, { min: 1, max: 16, step: 1 }, (v) => { s.sppPerFrame = Math.round(v); }),
        sliderRow('Sample limit', s.sampleLimit, { min: 16, max: 20000, step: 16 }, (v) => { s.sampleLimit = Math.round(v); }),
        selectRow(
          'Resolution',
          [['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['dpr', 'Native (HiDPI)']],
          String(s.resolutionScale),
          (v) => { s.resolutionScale = v === 'dpr' ? 'dpr' : parseFloat(v); app.markDirty(); },
        ),
        sliderRow('Firefly clamp', s.clampLum, { min: 0, max: 200, step: 1 }, (v) => { s.clampLum = v; changed(); }),
      ),
    );
  }
}
