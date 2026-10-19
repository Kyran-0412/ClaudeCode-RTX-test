// 2D overlay drawn on top of the viewport: the whole scene in wireframe
// mode, the selection outline, transform guides, and a drop line to the
// ground so you can judge an object's height.

import { add, sub, dot, mulMatVec } from './math.js';
import { objectFrame } from './scene.js';
import { meshEdges, newell, faceCenter, edgeKey } from './mesh.js';

const ACCENT = '#ffb547';
const WIRE = '#c3c8d2';
const EDGE = '#e4e8ef';
const WIRE_LIGHT = '#d9cf8f';
const GRID = '#343944';
const GRID_X = '#a8484c'; // the line along X (z = 0)
const GRID_Z = '#4a6eb0'; // the line along Z (x = 0)
const NEAR = 0.05;

// ---------------------------------------------------------------- projection
// Lines are clipped against the camera's near plane in camera space, so edges
// that pass behind the camera (big floors, walls) still draw correctly.
function makeProjector(basis, w, h) {
  const aspect = w / h;
  const toCam = (p) => {
    const d = sub(p, basis.pos);
    return [dot(d, basis.right), dot(d, basis.up), dot(d, basis.fwd)];
  };
  const toScreen = ([x, y, z]) => [
    ((x / (z * basis.tanHalf * aspect) + 1) / 2) * w,
    ((1 - y / (z * basis.tanHalf)) / 2) * h,
  ];
  return { toCam, toScreen };
}

function strokePolyline(ctx, proj, points) {
  ctx.beginPath();
  let last = null; // last screen point drawn
  for (let i = 0; i + 1 < points.length; i++) {
    let a = proj.toCam(points[i]);
    let b = proj.toCam(points[i + 1]);
    if (a[2] < NEAR && b[2] < NEAR) { last = null; continue; }
    if (a[2] < NEAR) a = lerpToNear(a, b);
    else if (b[2] < NEAR) b = lerpToNear(b, a);
    const sa = proj.toScreen(a), sb = proj.toScreen(b);
    if (!last || Math.abs(last[0] - sa[0]) > 0.01 || Math.abs(last[1] - sa[1]) > 0.01) ctx.moveTo(sa[0], sa[1]);
    ctx.lineTo(sb[0], sb[1]);
    last = sb;
  }
  ctx.stroke();
}

// Moves camera-space point `p` (behind the near plane) toward `q` until z = NEAR.
function lerpToNear(p, q) {
  const t = (NEAR - p[2]) / (q[2] - p[2]);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, NEAR];
}

// ---------------------------------------------------------------- shapes
function ring(center, a, b, segments = 48) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push(add(center, add(a.map((v) => v * Math.cos(t)), b.map((v) => v * Math.sin(t)))));
  }
  return pts;
}

function boxEdges() {
  const edges = [];
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      edges.push([[-1, s, t], [1, s, t]], [[s, -1, t], [s, 1, t]], [[s, t, -1], [s, t, 1]]);
    }
  }
  return edges;
}

function lightRings(e, scaleBy = 1) {
  const r = e.radius * scaleBy;
  return [
    ring(e.position, [r, 0, 0], [0, 0, r]),
    ring(e.position, [r, 0, 0], [0, r, 0]),
    ring(e.position, [0, 0, r], [0, r, 0]),
  ];
}

function meshLines(e, toWorld) {
  const w = e.mesh.vertices.map(toWorld);
  return meshEdges(e.mesh).map(([a, b]) => [w[a], w[b]]);
}

// Silhouette, open and sharp edges of a mesh: the lines that read as its shape.
function meshOutline(e, toWorld, camPos) {
  const w = e.mesh.vertices.map(toWorld);
  const facing = e.mesh.faces.map((f) => dot(newell(w, f), sub(faceCenter(w, f), camPos)) < 0);
  const normals = e.mesh.faces.map((f) => {
    const n = newell(w, f);
    const l = Math.hypot(...n) || 1;
    return n.map((v) => v / l);
  });
  const edgeFaces = new Map();
  e.mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const key = edgeKey(f[i], f[(i + 1) % f.length]);
      if (!edgeFaces.has(key)) edgeFaces.set(key, []);
      edgeFaces.get(key).push(fi);
    }
  });
  const lines = [];
  for (const [key, fs] of edgeFaces) {
    const [a, b] = key.split('-').map(Number);
    const keep = fs.length !== 2 || facing[fs[0]] !== facing[fs[1]] || dot(normals[fs[0]], normals[fs[1]]) < 0.77;
    if (keep) lines.push([w[a], w[b]]);
  }
  return lines;
}

// Minimal outline used to highlight the selection.
function outline(e, camPos) {
  if (e.kind === 'light') return lightRings(e, 1.4);
  const { M } = objectFrame(e);
  const toWorld = (l) => add(e.position, mulMatVec(M, l));
  if (e.shape === 'mesh') return meshOutline(e, toWorld, camPos);
  if (e.shape === 'sphere') {
    return [
      ring([0, 0, 0], [1, 0, 0], [0, 1, 0]),
      ring([0, 0, 0], [1, 0, 0], [0, 0, 1]),
      ring([0, 0, 0], [0, 1, 0], [0, 0, 1]),
    ].map((r) => r.map(toWorld));
  }
  if (e.shape === 'cylinder') {
    const lines = [ring([0, 1, 0], [1, 0, 0], [0, 0, 1]), ring([0, -1, 0], [1, 0, 0], [0, 0, 1])];
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) lines.push([[x, -1, z], [x, 1, z]]);
    return lines.map((r) => r.map(toWorld));
  }
  return boxEdges().map((r) => r.map(toWorld));
}

// Denser mesh-like wireframe used in wireframe view.
function wire(e) {
  if (e.kind === 'light') {
    const lines = lightRings(e);
    const r = e.radius;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      lines.push([add(e.position, d.map((v) => v * r * 1.3)), add(e.position, d.map((v) => v * r * 2.2))]);
    }
    return lines;
  }
  const { M } = objectFrame(e);
  const toWorld = (l) => add(e.position, mulMatVec(M, l));
  if (e.shape === 'mesh') return meshLines(e, toWorld);
  const lines = [];
  if (e.shape === 'sphere') {
    for (const lat of [-60, -30, 0, 30, 60]) {
      const a = (lat * Math.PI) / 180, r = Math.cos(a), y = Math.sin(a);
      lines.push(ring([0, y, 0], [r, 0, 0], [0, 0, r], 40));
    }
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI;
      lines.push(ring([0, 0, 0], [Math.cos(t), 0, Math.sin(t)], [0, 1, 0], 40));
    }
  } else if (e.shape === 'cylinder') {
    lines.push(ring([0, 1, 0], [1, 0, 0], [0, 0, 1]), ring([0, -1, 0], [1, 0, 0], [0, 0, 1]));
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2;
      lines.push([[Math.cos(t), -1, Math.sin(t)], [Math.cos(t), 1, Math.sin(t)]]);
    }
  } else {
    lines.push(...boxEdges());
  }
  return lines.map((r) => r.map(toWorld));
}

function drawGrid(ctx, proj) {
  const N = 20;
  ctx.lineWidth = 1;
  for (let i = -N; i <= N; i++) {
    if (i === 0) continue;
    ctx.strokeStyle = GRID;
    ctx.globalAlpha = i % 5 === 0 ? 0.9 : 0.5;
    strokePolyline(ctx, proj, [[i, 0, -N], [i, 0, N]]);
    strokePolyline(ctx, proj, [[-N, 0, i], [N, 0, i]]);
  }
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = GRID_X;
  strokePolyline(ctx, proj, [[-N, 0, 0], [N, 0, 0]]);
  ctx.strokeStyle = GRID_Z;
  strokePolyline(ctx, proj, [[0, 0, -N], [0, 0, N]]);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- main entry
// options.wireframe: { entities } draws the whole scene as lines.
// options.edit: { entity, data } draws mesh edit mode (see EditMode.drawData).
export function drawOverlay(canvas, basis, entity, { showDropLine = true, guides = null, wireframe = null, edit = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const proj = makeProjector(basis, w, h);

  if (wireframe) {
    drawGrid(ctx, proj);
    ctx.lineWidth = 1;
    for (const e of wireframe.entities) {
      if (e === entity || (edit && e === edit.entity)) continue;
      ctx.strokeStyle = e.kind === 'light' ? WIRE_LIGHT : WIRE;
      ctx.globalAlpha = 0.75;
      for (const line of wire(e)) strokePolyline(ctx, proj, line);
    }
    ctx.globalAlpha = 1;
  }
  if (edit) {
    drawEdit(ctx, proj, edit.data);
    if (guides) drawGuides(ctx, proj, guides);
    return;
  }
  if (!entity) return;

  if (guides) drawGuides(ctx, proj, guides);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 0.95;
  for (const line of wireframe ? wire(entity) : outline(entity, basis.pos)) strokePolyline(ctx, proj, line);

  if (showDropLine) {
    const top = proj.toCam(entity.position);
    const ground = proj.toCam([entity.position[0], 0, entity.position[2]]);
    if (top[2] > NEAR && ground[2] > NEAR) {
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.6;
      strokePolyline(ctx, proj, [entity.position, [entity.position[0], 0, entity.position[2]]]);
      ctx.setLineDash([]);
      const g = proj.toScreen(ground);
      ctx.beginPath();
      ctx.arc(g[0], g[1], 3, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// Constraint axes through the object, plus a dashed line from the object to
// the cursor while rotating or scaling.
function drawGuides(ctx, proj, guides) {
  ctx.lineWidth = 1.5;
  for (const { dir, color } of guides.axes) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    const far = 1000;
    strokePolyline(ctx, proj, [
      add(guides.origin, dir.map((v) => -v * far)),
      guides.origin,
      add(guides.origin, dir.map((v) => v * far)),
    ]);
  }
  if (guides.line) {
    const [a, b] = guides.line;
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

// Mesh edit mode: shaded selected faces, edges, vertex dots or face dots.
function drawEdit(ctx, proj, data) {
  ctx.globalAlpha = 1;
  for (const f of data.faces) {
    if (!f.selected) continue;
    const pts = f.points.map((p) => proj.toCam(p));
    if (pts.some((p) => p[2] < NEAR)) continue;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = proj.toScreen(p);
      if (i) ctx.lineTo(s[0], s[1]);
      else ctx.moveTo(s[0], s[1]);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 181, 71, 0.28)';
    ctx.fill();
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = EDGE;
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  for (const e of data.edges) if (!e.selected) segmentPath(ctx, proj, e.a, e.b);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const e of data.edges) if (e.selected) segmentPath(ctx, proj, e.a, e.b);
  ctx.stroke();

  const dot = (p, size, fill) => {
    const c = proj.toCam(p);
    if (c[2] < NEAR) return;
    const s = proj.toScreen(c);
    ctx.fillStyle = fill;
    ctx.fillRect(s[0] - size / 2, s[1] - size / 2, size, size);
  };
  for (const v of data.verts) if (!v.selected) dot(v.p, 5, '#0d0e11');
  for (const v of data.verts) if (!v.selected) dot(v.p, 3, EDGE);
  for (const v of data.verts) if (v.selected) dot(v.p, 6, ACCENT);
  if (data.mode === 'face') {
    for (const f of data.faces) dot(f.center, f.selected ? 6 : 4, f.selected ? ACCENT : EDGE);
  }
}

function segmentPath(ctx, proj, p, q) {
  let a = proj.toCam(p), b = proj.toCam(q);
  if (a[2] < NEAR && b[2] < NEAR) return;
  if (a[2] < NEAR) a = lerpToNear(a, b);
  else if (b[2] < NEAR) b = lerpToNear(b, a);
  const sa = proj.toScreen(a), sb = proj.toScreen(b);
  ctx.moveTo(sa[0], sa[1]);
  ctx.lineTo(sb[0], sb[1]);
}
