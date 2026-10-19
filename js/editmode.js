// Mesh edit mode: vertex / edge / face selection on one mesh object.
// Transforms reuse the G / R / S tool through a VertexTarget.

import { objectFrame, convertToMesh } from './scene.js';
import { meshEdges, edgeKey, faceCenter, localAccel, raycastBVH, deleteFaces, touchMesh } from './mesh.js';
import { add, sub, mulMatVec } from './math.js';

export const SELECT_MODES = ['vert', 'edge', 'face'];
export const SELECT_MODE_NAMES = { vert: 'Vertex', edge: 'Edge', face: 'Face' };

export class EditMode {
  constructor() {
    this.entity = null;
    this.mode = 'vert';
    this.clear();
  }

  get active() {
    return !!this.entity;
  }

  // Returns 'converted' if a primitive had to be turned into a mesh first,
  // 'ok', or null if the entity can't be edited.
  enter(entity) {
    if (!entity || entity.kind !== 'object') return null;
    const converted = convertToMesh(entity);
    this.entity = entity;
    this.clear();
    return converted ? 'converted' : 'ok';
  }

  exit() {
    this.entity = null;
    this.clear();
  }

  clear() {
    this.verts = new Set();
    this.edges = new Set();
    this.faces = new Set();
  }

  get mesh() {
    return this.entity.mesh;
  }

  // ---------------------------------------------------------------- selection
  selectedVerts() {
    if (this.mode === 'vert') return new Set(this.verts);
    const out = new Set();
    if (this.mode === 'edge') {
      for (const k of this.edges) for (const v of k.split('-')) out.add(Number(v));
    } else {
      for (const f of this.faces) for (const v of this.mesh.faces[f] || []) out.add(v);
    }
    return out;
  }

  count() {
    return this.mode === 'vert' ? this.verts.size : this.mode === 'edge' ? this.edges.size : this.faces.size;
  }

  // Switching mode keeps whatever is fully covered by the current selection.
  setMode(mode) {
    if (mode === this.mode) return;
    const vs = this.selectedVerts();
    this.mode = mode;
    this.clear();
    if (mode === 'vert') this.verts = vs;
    else if (mode === 'edge') {
      for (const [a, b] of meshEdges(this.mesh)) if (vs.has(a) && vs.has(b)) this.edges.add(edgeKey(a, b));
    } else {
      this.mesh.faces.forEach((f, i) => { if (f.every((v) => vs.has(v))) this.faces.add(i); });
    }
  }

  selectAll() {
    this.clear();
    if (this.mode === 'vert') this.mesh.vertices.forEach((_, i) => this.verts.add(i));
    else if (this.mode === 'edge') for (const [a, b] of meshEdges(this.mesh)) this.edges.add(edgeKey(a, b));
    else this.mesh.faces.forEach((_, i) => this.faces.add(i));
  }

  // ---------------------------------------------------------------- geometry
  frame() {
    const e = this.entity;
    const { M, inv } = objectFrame(e);
    return {
      toWorld: (v) => add(e.position, mulMatVec(M, v)),
      toLocal: (w) => mulMatVec(inv, sub(w, e.position)),
      dirToLocal: (d) => mulMatVec(inv, d),
    };
  }

  // Visibility of local-space points from the camera, ignoring other objects.
  visibilityTester(basis) {
    const acc = localAccel(this.mesh);
    const camL = this.frame().toLocal(basis.pos);
    return (pL) => !raycastBVH(acc.bvh, acc.tv, camL, sub(pL, camL), 1 - 1e-3, 1e-4);
  }

  median() {
    const vs = [...this.selectedVerts()];
    if (!vs.length) return null;
    const { toWorld } = this.frame();
    const c = [0, 0, 0];
    for (const i of vs) {
      const w = toWorld(this.mesh.vertices[i]);
      for (let k = 0; k < 3; k++) c[k] += w[k] / vs.length;
    }
    return c;
  }

  // Moves the selection so its median lands on `target` (world space).
  setMedian(target) {
    const m = this.median();
    if (!m) return;
    const { dirToLocal } = this.frame();
    const d = dirToLocal(sub(target, m));
    for (const i of this.selectedVerts()) this.mesh.vertices[i] = add(this.mesh.vertices[i], d);
    touchMesh(this.mesh);
  }

  // Deletes the selection and any faces that use it. Returns faces removed.
  deleteSelected() {
    const faces = new Set();
    if (this.mode === 'face') this.faces.forEach((f) => faces.add(f));
    else if (this.mode === 'vert') {
      this.mesh.faces.forEach((f, i) => { if (f.some((v) => this.verts.has(v))) faces.add(i); });
    } else {
      this.mesh.faces.forEach((f, i) => {
        for (let k = 0; k < f.length; k++) {
          if (this.edges.has(edgeKey(f[k], f[(k + 1) % f.length]))) { faces.add(i); break; }
        }
      });
    }
    if (!faces.size) return 0;
    const version = this.mesh.version || 0;
    this.entity.mesh = deleteFaces(this.mesh, faces);
    this.entity.mesh.version = version;
    touchMesh(this.entity.mesh);
    this.clear();
    return faces.size;
  }

  // ---------------------------------------------------------------- picking
  // Click at screen (x, y). `ray` is the camera ray there; `project` maps
  // world points to screen. With `add`, toggles instead of replacing.
  pick({ ray, project, basis, xray, add: additive }) {
    const mesh = this.mesh;
    const { toWorld, toLocal, dirToLocal } = this.frame();
    const visible = xray ? () => true : this.visibilityTester(basis);
    const [mx, my] = ray.screen;
    let hit = null;

    if (this.mode === 'vert') {
      let best = 14 * 14;
      mesh.vertices.forEach((v, i) => {
        const s = project(toWorld(v));
        if (!s) return;
        const d2 = (s[0] - mx) ** 2 + (s[1] - my) ** 2;
        if (d2 < best && visible(v)) { best = d2; hit = i; }
      });
    } else if (this.mode === 'edge') {
      let best = 10;
      for (const [a, b] of meshEdges(mesh)) {
        const sa = project(toWorld(mesh.vertices[a])), sb = project(toWorld(mesh.vertices[b]));
        if (!sa || !sb) continue;
        const d = segDist(mx, my, sa, sb);
        if (d < best) {
          const mid = mesh.vertices[a].map((c, k) => (c + mesh.vertices[b][k]) / 2);
          if (visible(mid)) { best = d; hit = edgeKey(a, b); }
        }
      }
    } else {
      const acc = localAccel(mesh);
      const h = raycastBVH(acc.bvh, acc.tv, toLocal(ray.ro), dirToLocal(ray.rd));
      if (h) hit = acc.tris[h.tri][3];
    }

    const set = this.mode === 'vert' ? this.verts : this.mode === 'edge' ? this.edges : this.faces;
    if (hit === null) {
      if (!additive) set.clear();
      return;
    }
    if (additive) {
      if (set.has(hit)) set.delete(hit);
      else set.add(hit);
    } else {
      set.clear();
      set.add(hit);
    }
  }

  // ---------------------------------------------------------------- drawing
  // World-space data for the overlay. Hidden elements are dropped unless xray.
  drawData(basis, xray) {
    const mesh = this.mesh;
    const { toWorld } = this.frame();
    const visible = xray ? () => true : this.visibilityTester(basis);
    const world = mesh.vertices.map(toWorld);
    const sel = this.selectedVerts();

    const edges = [];
    for (const [a, b] of meshEdges(mesh)) {
      const mid = mesh.vertices[a].map((c, k) => (c + mesh.vertices[b][k]) / 2);
      if (!visible(mid)) continue;
      const selected = this.mode === 'edge' ? this.edges.has(edgeKey(a, b)) : sel.has(a) && sel.has(b);
      edges.push({ a: world[a], b: world[b], selected });
    }

    const faces = [];
    mesh.faces.forEach((f, i) => {
      const selected = this.mode === 'face' ? this.faces.has(i) : f.every((v) => sel.has(v));
      if (!selected && this.mode !== 'face') return;
      const c = faceCenter(mesh.vertices, f);
      if (!visible(c)) return;
      faces.push({ points: f.map((v) => world[v]), center: toWorld(c), selected });
    });

    const verts = [];
    if (this.mode === 'vert') {
      mesh.vertices.forEach((v, i) => { if (visible(v)) verts.push({ p: world[i], selected: sel.has(i) }); });
    }
    return { mode: this.mode, edges, faces, verts };
  }
}

function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}
