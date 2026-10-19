// Orbit camera helpers: basis vectors, screen rays and projection.

import { add, sub, scale, cross, normalize, dot, DEG } from './math.js';

export function cameraBasis(cam) {
  const yaw = cam.yaw * DEG, pitch = cam.pitch * DEG;
  const offset = [
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ];
  const pos = add(cam.target, scale(offset, cam.distance));
  const fwd = normalize(sub(cam.target, pos));
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { pos, fwd, right, up, tanHalf: Math.tan((cam.fov * DEG) / 2) };
}

// Ray through pixel (x, y) of a w x h viewport (y down, CSS pixels).
export function screenRay(basis, x, y, w, h) {
  const nx = (x / w) * 2 - 1;
  const ny = 1 - (y / h) * 2;
  const aspect = w / h;
  const dir = normalize(
    add(basis.fwd, add(scale(basis.right, nx * basis.tanHalf * aspect), scale(basis.up, ny * basis.tanHalf))),
  );
  return { ro: basis.pos, rd: dir };
}

// World point -> screen pixel, or null if behind the camera.
export function project(basis, p, w, h) {
  const d = sub(p, basis.pos);
  const z = dot(d, basis.fwd);
  if (z <= 0.01) return null;
  const x = dot(d, basis.right) / (z * basis.tanHalf * (w / h));
  const y = dot(d, basis.up) / (z * basis.tanHalf);
  return [((x + 1) / 2) * w, ((1 - y) / 2) * h];
}
