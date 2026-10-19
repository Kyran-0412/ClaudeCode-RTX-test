// CPU ray casting used for selecting objects. Mirrors the shader's math.

import { sub, dot, mulMatVec } from './math.js';
import { objectFrame } from './scene.js';
import { localAccel, raycastBVH } from './mesh.js';

function hitSphere(o, d) {
  const a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1;
  const disc = b * b - a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  let t = (-b - s) / a;
  if (t <= 0) t = (-b + s) / a;
  return t > 0 ? t : Infinity;
}

function hitBox(o, d) {
  let tn = -Infinity, tf = Infinity;
  for (let i = 0; i < 3; i++) {
    const dd = Math.abs(d[i]) < 1e-12 ? 1e-12 : d[i];
    const t0 = (-1 - o[i]) / dd, t1 = (1 - o[i]) / dd;
    tn = Math.max(tn, Math.min(t0, t1));
    tf = Math.min(tf, Math.max(t0, t1));
  }
  if (tn > tf || tf <= 0) return Infinity;
  return tn > 0 ? tn : tf;
}

function hitCylinder(o, d) {
  let best = Infinity;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a > 1e-12) {
    const b = o[0] * d[0] + o[2] * d[2];
    const c = o[0] * o[0] + o[2] * o[2] - 1;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      for (const t of [(-b - s) / a, (-b + s) / a]) {
        if (t > 0 && t < best && Math.abs(o[1] + d[1] * t) <= 1) best = t;
      }
    }
  }
  if (Math.abs(d[1]) > 1e-12) {
    for (const cy of [1, -1]) {
      const t = (cy - o[1]) / d[1];
      const x = o[0] + d[0] * t, z = o[2] + d[2] * t;
      if (t > 0 && t < best && x * x + z * z <= 1) best = t;
    }
  }
  return best;
}

export function intersectEntity(e, ro, rd) {
  if (e.kind === 'light') {
    const oc = sub(ro, e.position);
    const r = Math.max(e.radius, 0.12); // make tiny lights easier to grab
    const b = dot(oc, rd), c = dot(oc, oc) - r * r;
    const disc = b * b - c;
    if (disc < 0) return Infinity;
    const s = Math.sqrt(disc);
    const t = -b - s > 0 ? -b - s : -b + s;
    return t > 0 ? t : Infinity;
  }
  const { inv } = objectFrame(e);
  const p = sub(ro, e.position);
  const o = mulMatVec(inv, p);
  const d = mulMatVec(inv, rd);
  if (e.shape === 'sphere') return hitSphere(o, d);
  if (e.shape === 'box') return hitBox(o, d);
  if (e.shape === 'mesh') {
    const acc = localAccel(e.mesh);
    const hit = raycastBVH(acc.bvh, acc.tv, o, d);
    return hit ? hit.t : Infinity;
  }
  return hitCylinder(o, d);
}

export function pick(entities, ro, rd) {
  let best = null, bestT = Infinity;
  for (const e of entities) {
    const t = intersectEntity(e, ro, rd);
    if (t < bestT) { bestT = t; best = e; }
  }
  return best ? { entity: best, t: bestT } : null;
}
