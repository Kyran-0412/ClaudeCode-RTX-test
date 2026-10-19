// Blender-style modal transforms: G (grab), R (rotate), S (scale).
//
// While a transform is active the mouse drives it; X / Y / Z constrain it to
// an axis (Shift + axis key excludes that axis instead), typing a number sets
// an exact amount, Ctrl snaps, and click/Enter confirms while right-click/Esc
// cancels.

import { add, sub, scale, dot, normalize, rotationMatrix, DEG } from './math.js';
import { project } from './camera.js';

export const AXIS_DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const AXIS_COLORS = ['#ff5b5b', '#7bd88f', '#5fa4ff'];
const AXIS_NAMES = ['X', 'Y', 'Z'];
const MODE_NAMES = { grab: 'Move', rotate: 'Rotate', scale: 'Scale' };

function snapshot(e) {
  return JSON.parse(JSON.stringify({
    position: e.position, rotation: e.rotation, size: e.size, radius: e.radius, height: e.height,
  }));
}

function restore(e, s) {
  for (const [k, v] of Object.entries(s)) if (v !== undefined) e[k] = JSON.parse(JSON.stringify(v));
}

// Rotation of angle `a` (radians) around unit axis `k` (Rodrigues).
function axisAngle(k, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const [x, y, z] = k;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

function mul(A, B) {
  return A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
}

// Inverse of rotationMatrix(): R = Ry * Rx * Rz -> [x, y, z] degrees.
function toEuler(R) {
  const cx = Math.hypot(R[1][0], R[1][1]);
  const x = Math.atan2(-R[1][2], cx);
  let y, z;
  if (cx > 1e-6) {
    y = Math.atan2(R[0][2], R[2][2]);
    z = Math.atan2(R[1][0], R[1][1]);
  } else {
    y = Math.atan2(-R[2][0], R[0][0]);
    z = 0;
  }
  const clean = (v) => Math.round((v / DEG) * 1000) / 1000 + 0; // +0 drops -0
  return [clean(x), clean(y), clean(z)];
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const snapTo = (v, step) => Math.round(v / step) * step;

export class TransformTool {
  // ctx: { basis(), size() -> [w, h], rayAt(x, y) -> {ro, rd}, onChange(), onEnd() }
  constructor(ctx) {
    this.ctx = ctx;
    this.state = null;
  }

  get active() {
    return !!this.state;
  }

  start(mode, entity, mouse) {
    if (this.state) this.confirm();
    const [w, h] = this.ctx.size();
    const basis = this.ctx.basis();
    const c2d = project(basis, entity.position, w, h) || [w / 2, h / 2];
    this.state = {
      mode,
      entity,
      orig: snapshot(entity),
      origPos: entity.position.slice(),
      mouse0: mouse.slice(),
      mouse: mouse.slice(),
      prevMouse: mouse.slice(),
      c2d,
      axis: -1,
      exclude: false,
      typed: '',
      snap: false,
      angle: 0, // accumulated screen rotation, radians
      display: '',
    };
    this.apply();
  }

  // ---------------------------------------------------------------- input
  setMouse(mouse, snap) {
    const s = this.state;
    if (!s) return;
    if (s.mode === 'rotate') {
      const a0 = Math.atan2(s.prevMouse[1] - s.c2d[1], s.prevMouse[0] - s.c2d[0]);
      const a1 = Math.atan2(mouse[1] - s.c2d[1], mouse[0] - s.c2d[0]);
      s.angle += wrapAngle(a1 - a0);
    }
    s.prevMouse = mouse.slice();
    s.mouse = mouse.slice();
    s.snap = snap;
    this.apply();
  }

  setSnap(snap) {
    if (!this.state || this.state.snap === snap) return;
    this.state.snap = snap;
    this.apply();
  }

  // Returns true if the key was used.
  handleKey(ev) {
    const s = this.state;
    if (!s) return false;
    const k = ev.key;
    const lower = k.toLowerCase();
    if (k === 'Escape') { this.cancel(); return true; }
    if (k === 'Enter') { this.confirm(); return true; }
    if (lower === 'x' || lower === 'y' || lower === 'z') {
      const axis = 'xyz'.indexOf(lower);
      const exclude = ev.shiftKey;
      if (s.axis === axis && s.exclude === exclude) s.axis = -1; // same key again clears
      else { s.axis = axis; s.exclude = exclude; }
      this.apply();
      return true;
    }
    if (/^[0-9]$/.test(k) || k === '.' || k === '-') {
      if (k === '-') s.typed = s.typed.startsWith('-') ? s.typed.slice(1) : '-' + s.typed;
      else if (k !== '.' || !s.typed.includes('.')) s.typed += k;
      this.apply();
      return true;
    }
    if (k === 'Backspace') {
      s.typed = s.typed.slice(0, -1);
      this.apply();
      return true;
    }
    if (k === 'Control' || k === 'Meta') { this.setSnap(true); return true; }
    return false;
  }

  confirm() {
    if (!this.state) return;
    this.state = null;
    this.ctx.onEnd(true);
  }

  cancel() {
    const s = this.state;
    if (!s) return;
    restore(s.entity, s.orig);
    this.state = null;
    this.ctx.onChange();
    this.ctx.onEnd(false);
  }

  // ---------------------------------------------------------------- math
  typedValue() {
    const v = parseFloat(this.state.typed);
    return Number.isFinite(v) ? v : null;
  }

  // World point under the mouse for the current grab constraint.
  grabPoint(mouse) {
    const s = this.state;
    const { ro, rd } = this.ctx.rayAt(mouse[0], mouse[1]);
    const p0 = s.origPos;
    if (s.axis >= 0 && !s.exclude) {
      // Closest point on the axis line to the mouse ray.
      const a = AXIS_DIRS[s.axis];
      const w0 = sub(p0, ro);
      const b = dot(a, rd), d = dot(a, w0), e = dot(rd, w0);
      const denom = 1 - b * b;
      if (denom < 1e-6) return null;
      return add(p0, scale(a, (b * e - d) / denom));
    }
    const n = s.axis >= 0 ? AXIS_DIRS[s.axis] : this.ctx.basis().fwd;
    const denom = dot(rd, n);
    if (Math.abs(denom) < 1e-6) return null;
    const t = dot(sub(p0, ro), n) / denom;
    if (t <= 0 || t > 1000) return null;
    return add(ro, scale(rd, t));
  }

  apply() {
    const s = this.state;
    const e = s.entity;
    restore(e, s.orig);
    const typed = this.typedValue();
    const axisLabel = s.axis < 0 ? '' : (s.exclude ? `${AXIS_NAMES[s.axis]}-plane locked` : `${AXIS_NAMES[s.axis]} axis`);

    if (s.mode === 'grab') {
      let delta;
      if (typed !== null) {
        const ax = s.axis >= 0 && !s.exclude ? s.axis : (s.exclude && s.axis === 0 ? 1 : 0);
        delta = scale(AXIS_DIRS[ax], typed);
      } else {
        const p1 = this.grabPoint(s.mouse0), p2 = this.grabPoint(s.mouse);
        delta = p1 && p2 ? sub(p2, p1) : s.lastDelta || [0, 0, 0];
        if (s.axis >= 0 && s.exclude) delta[s.axis] = 0;
        if (s.snap) delta = delta.map((v) => snapTo(v, 0.25));
      }
      s.lastDelta = delta;
      e.position = add(s.origPos, delta);
      s.display = `Δ ${delta.map((v) => v.toFixed(2)).join('  ')}`;
    } else if (s.mode === 'rotate') {
      const basis = this.ctx.basis();
      let axis, sign;
      if (s.axis >= 0) {
        axis = AXIS_DIRS[s.axis];
        sign = dot(axis, basis.fwd) >= 0 ? 1 : -1;
      } else {
        axis = basis.fwd;
        sign = 1;
      }
      let deg = typed !== null ? typed : (s.angle * sign) / DEG;
      if (typed === null && s.snap) deg = snapTo(deg, 5);
      if (e.kind === 'object') {
        const R = mul(axisAngle(normalize(axis), deg * DEG), rotationMatrix(s.orig.rotation));
        e.rotation = toEuler(R);
      }
      s.display = `${deg.toFixed(1)}°`;
    } else {
      const d0 = Math.max(Math.hypot(s.mouse0[0] - s.c2d[0], s.mouse0[1] - s.c2d[1]), 10);
      const d1 = Math.hypot(s.mouse[0] - s.c2d[0], s.mouse[1] - s.c2d[1]);
      let f = typed !== null ? Math.abs(typed) : d1 / d0;
      if (typed === null && s.snap) f = Math.max(0.1, snapTo(f, 0.1));
      const hits = [0, 1, 2].map((i) => (s.axis < 0 ? true : s.exclude ? i !== s.axis : i === s.axis));
      const clampMin = (v) => Math.max(0.01, v);
      if (e.kind === 'light' || e.shape === 'sphere') {
        e.radius = clampMin(s.orig.radius * f);
      } else if (e.shape === 'box') {
        e.size = s.orig.size.map((v, i) => clampMin(hits[i] ? +(v * f).toFixed(4) : v));
      } else {
        if (hits[0] || hits[2]) e.radius = clampMin(s.orig.radius * f);
        if (hits[1]) e.height = clampMin(s.orig.height * f);
      }
      s.display = `× ${f.toFixed(3)}`;
    }

    s.status = [
      MODE_NAMES[s.mode],
      axisLabel && (s.mode === 'scale' && s.axis >= 0 ? `local ${axisLabel}` : axisLabel),
      s.typed ? `${s.typed}▏` : s.display,
    ].filter(Boolean).join(' · ');
    this.ctx.onChange();
  }

  // What the overlay should draw for the active transform.
  guides() {
    const s = this.state;
    if (!s) return null;
    let axes = [];
    if (s.axis >= 0) {
      const R = s.mode === 'scale' && s.entity.kind === 'object' ? rotationMatrix(s.entity.rotation) : null;
      const dir = (i) => (R ? [R[0][i], R[1][i], R[2][i]] : AXIS_DIRS[i]);
      axes = s.exclude
        ? [0, 1, 2].filter((i) => i !== s.axis).map((i) => ({ dir: dir(i), color: AXIS_COLORS[i] }))
        : [{ dir: dir(s.axis), color: AXIS_COLORS[s.axis] }];
    }
    return {
      origin: s.mode === 'grab' ? s.origPos : s.entity.position,
      axes,
      line: s.mode === 'grab' ? null : [s.c2d, s.mouse],
    };
  }
}

export { toEuler };
