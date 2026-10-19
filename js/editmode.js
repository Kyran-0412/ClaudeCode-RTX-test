// Mesh edit mode: vertex / edge / face selection on one mesh object.
// Transforms reuse the G / R / S tool through a VertexTarget.

import { objectFrame, convertToMesh } from './scene.js';
import {
  meshEdges, edgeKey, faceCenter, localAccel, raycastBVH, deleteFaces, touchMesh,
  newell, extrudeFaces, extrudeEdges, insetFaces, edgeRing, loopCut,
} from './mesh.js';
import { add, sub, mulMatVec, normalize, length } from './math.js';

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

  // Plain-data copy of the selection (for undo and for cancelling extrudes).
  saveSelection() {
    return { mode: this.mode, verts: [...this.verts], edges: [...this.edges], faces: [...this.faces] };
  }

  restoreSelection(sel) {
    this.mode = sel.mode;
    this.verts = new Set(sel.verts);
    this.edges = new Set(sel.edges);
    this.faces = new Set(sel.faces);
  }

  // Faces covered by the selection (every vertex selected).
  coveredFaces() {
    if (this.mode === 'face') return new Set(this.faces);
    const vs = this.selectedVerts();
    const out = new Set();
    this.mesh.faces.forEach((f, i) => { if (f.every((v) => vs.has(v))) out.add(i); });
    return out;
  }

  // Selects `verts` in the current mode (edges / faces they fully cover).
  selectVerts(verts, faces = null) {
    this.clear();
    if (this.mode === 'vert') this.verts = new Set(verts);
    else if (this.mode === 'edge') {
      for (const [a, b] of meshEdges(this.mesh)) if (verts.has(a) && verts.has(b)) this.edges.add(edgeKey(a, b));
    } else if (faces) this.faces = new Set(faces);
    else this.mesh.faces.forEach((f, i) => { if (f.every((v) => verts.has(v))) this.faces.add(i); });
  }

  setMesh(mesh) {
    mesh.version = this.mesh.version || 0;
    this.entity.mesh = mesh;
    touchMesh(mesh);
  }

  // ---------------------------------------------------------------- modelling
  // Extrudes covered faces (or, failing that, selected edges). Returns the
  // vertices that should move, the direction to move them (face region
  // normal, or null), and the state to go back to if the move is cancelled.
  extrude() {
    const saved = { mesh: JSON.parse(JSON.stringify(this.mesh)), sel: this.saveSelection() };
    const faces = this.coveredFaces();
    if (faces.size) {
      const { toWorld } = this.frame();
      const world = this.mesh.vertices.map(toWorld);
      const n = [0, 0, 0];
      for (const fi of faces) {
        const fn = newell(world, this.mesh.faces[fi]);
        for (let k = 0; k < 3; k++) n[k] += fn[k];
      }
      const { mesh, moved } = extrudeFaces(this.mesh, faces);
      this.setMesh(mesh);
      this.selectVerts(moved, faces);
      return { moved, axis: length(n) > 1e-9 ? normalize(n) : null, saved };
    }
    let edges = [];
    if (this.mode === 'edge') edges = [...this.edges].map((k) => k.split('-').map(Number));
    else if (this.mode === 'vert') edges = meshEdges(this.mesh).filter(([a, b]) => this.verts.has(a) && this.verts.has(b));
    if (!edges.length) return null;
    const { mesh, moved } = extrudeEdges(this.mesh, edges);
    this.setMesh(mesh);
    this.selectVerts(moved);
    return { moved, axis: null, saved };
  }

  // Splits covered faces into an inner face and a border ring.
  inset() {
    const faces = this.coveredFaces();
    if (!faces.size) return null;
    const saved = { mesh: JSON.parse(JSON.stringify(this.mesh)), sel: this.saveSelection() };
    const { mesh, corners } = insetFaces(this.mesh, faces);
    this.setMesh(mesh);
    this.selectVerts(new Set(corners.map((c) => c.w)), faces);
    return { corners, saved };
  }

  // Edges a bevel should act on: selected edges, edges between selected
  // vertices, or every edge of the selected faces.
  bevelEdgeKeys() {
    const keys = new Set();
    if (this.mode === 'edge') this.edges.forEach((k) => keys.add(k));
    else if (this.mode === 'vert') {
      for (const [a, b] of meshEdges(this.mesh)) if (this.verts.has(a) && this.verts.has(b)) keys.add(edgeKey(a, b));
    } else {
      for (const fi of this.faces) {
        const f = this.mesh.faces[fi];
        for (let i = 0; i < f.length; i++) keys.add(edgeKey(f[i], f[(i + 1) % f.length]));
      }
    }
    return keys;
  }

  // ---------------------------------------------------------------- loop cut
  // Ring of quads a loop cut through `key` would cross (or null).
  ringFor(key) {
    if (!key) return null;
    const [a, b] = key.split('-').map(Number);
    return edgeRing(this.mesh, a, b);
  }

  // World-space line segments showing where the cuts would go.
  ringPreview(ring, ts) {
    const { toWorld } = this.frame();
    const at = (k, t) => {
      const [p, q] = ring.edges.get(k);
      const P = this.mesh.vertices[p], Q = this.mesh.vertices[q];
      return toWorld(P.map((c, i) => c + (Q[i] - c) * t));
    };
    const lines = [];
    for (const { k1, k2 } of ring.faces) for (const t of ts) lines.push([at(k1, t), at(k2, t)]);
    return lines;
  }

  // Applies the cut and selects the new loop(s). Returns the cut vertices.
  applyLoopCut(ring, ts) {
    const { mesh, cuts } = loopCut(this.mesh, ring, ts);
    this.setMesh(mesh);
    const verts = new Set();
    for (const c of cuts.values()) c.list.forEach((v) => verts.add(v));
    const mode = this.mode;
    if (mode === 'face') this.mode = 'edge';
    this.selectVerts(verts);
    return cuts;
  }

  // Slides a single loop cut: each new vertex sits at fraction t along its edge.
  slideLoop(cuts, t) {
    const verts = this.mesh.vertices.slice();
    for (const c of cuts.values()) {
      const P = verts[c.p], Q = verts[c.q];
      verts[c.list[0]] = P.map((x, i) => x + (Q[i] - x) * t);
    }
    this.mesh.vertices = verts;
    touchMesh(this.mesh);
  }

  restoreState(saved) {
    this.setMesh(saved.mesh);
    this.restoreSelection(saved.sel);
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
      hit = this.edgeUnder({ ray, project, basis, xray });
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

  // Nearest visible edge to the cursor (within `radius` pixels), as a key.
  edgeUnder({ ray, project, basis, xray, radius = 10 }) {
    const mesh = this.mesh;
    const { toWorld } = this.frame();
    const visible = xray ? () => true : this.visibilityTester(basis);
    const [mx, my] = ray.screen;
    let best = radius, hit = null;
    for (const [a, b] of meshEdges(mesh)) {
      const sa = project(toWorld(mesh.vertices[a])), sb = project(toWorld(mesh.vertices[b]));
      if (!sa || !sb) continue;
      const d = segDist(mx, my, sa, sb);
      if (d < best) {
        const mid = mesh.vertices[a].map((c, k) => (c + mesh.vertices[b][k]) / 2);
        if (visible(mid)) { best = d; hit = edgeKey(a, b); }
      }
    }
    return hit;
  }

  // The edge of the face under the cursor that is closest to the cursor
  // (used when the cursor isn't right on an edge).
  nearestEdgeOfFaceUnder({ ray, project }) {
    const mesh = this.mesh;
    const { toWorld, toLocal, dirToLocal } = this.frame();
    const acc = localAccel(mesh);
    const h = raycastBVH(acc.bvh, acc.tv, toLocal(ray.ro), dirToLocal(ray.rd));
    if (!h) return null;
    const f = mesh.faces[acc.tris[h.tri][3]];
    const [mx, my] = ray.screen;
    let best = Infinity, hit = null;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const sa = project(toWorld(mesh.vertices[a])), sb = project(toWorld(mesh.vertices[b]));
      if (!sa || !sb) continue;
      const d = segDist(mx, my, sa, sb);
      if (d < best) { best = d; hit = edgeKey(a, b); }
    }
    return hit;
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
