// 2D overlay drawn on top of the render: selection outline and a drop line
// to the ground so you can judge an object's height.

import { add, mulMatVec } from './math.js';
import { objectFrame } from './scene.js';
import { project } from './camera.js';

const ACCENT = '#ffb547';

function ring(center, a, b, segments = 48) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push(add(center, add(a.map((v) => v * Math.cos(t)), b.map((v) => v * Math.sin(t)))));
  }
  return pts;
}

// Returns a list of world-space polylines outlining the entity.
function outline(e) {
  if (e.kind === 'light') {
    const r = e.radius * 1.4;
    return [
      ring(e.position, [r, 0, 0], [0, 0, r]),
      ring(e.position, [r, 0, 0], [0, r, 0]),
      ring(e.position, [0, 0, r], [0, r, 0]),
    ];
  }
  const { M } = objectFrame(e);
  const toWorld = (l) => add(e.position, mulMatVec(M, l));
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
  const c = (x, y, z) => [x, y, z];
  const edges = [];
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      edges.push([c(-1, s, t), c(1, s, t)], [c(s, -1, t), c(s, 1, t)], [c(s, t, -1), c(s, t, 1)]);
    }
  }
  return edges.map((r) => r.map(toWorld));
}

export function drawOverlay(canvas, basis, entity, { showDropLine = true, guides = null } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!entity) return;

  if (guides) drawGuides(ctx, basis, guides, w, h);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ACCENT;
  ctx.globalAlpha = 0.9;
  for (const line of outline(entity)) {
    ctx.beginPath();
    let pen = false;
    for (const p of line) {
      const s = project(basis, p, w, h);
      if (!s) { pen = false; continue; }
      if (pen) ctx.lineTo(s[0], s[1]);
      else { ctx.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.stroke();
  }

  if (showDropLine) {
    const top = project(basis, entity.position, w, h);
    const ground = project(basis, [entity.position[0], 0, entity.position[2]], w, h);
    if (top && ground) {
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(top[0], top[1]);
      ctx.lineTo(ground[0], ground[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(ground[0], ground[1], 3, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// Constraint axes through the object, plus a dashed line from the object to
// the cursor while rotating or scaling.
function drawGuides(ctx, basis, guides, w, h) {
  ctx.lineWidth = 1.5;
  for (const { dir, color } of guides.axes) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pen = false;
    for (let i = -200; i <= 200; i++) {
      const t = Math.sign(i) * (i * i) / 400; // denser near the object
      const s = project(basis, add(guides.origin, dir.map((v) => v * t)), w, h);
      if (!s) { pen = false; continue; }
      if (pen) ctx.lineTo(s[0], s[1]);
      else { ctx.moveTo(s[0], s[1]); pen = true; }
    }
    ctx.stroke();
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
