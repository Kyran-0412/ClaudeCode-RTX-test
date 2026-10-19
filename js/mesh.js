// Polygon meshes: building them from primitives, normals, triangulation,
// editing helpers, and a bounding volume hierarchy (BVH) used both on the GPU
// (path tracing) and on the CPU (picking).
//
// A mesh is { vertices: [[x,y,z], ...], faces: [[i, j, k, ...], ...], smooth }
// in the object's local space. Faces are polygons wound counter-clockwise
// when seen from outside.

import { sub, dot, normalize, length } from './math.js';

const SMOOTH_ANGLE = 40; // degrees: sharper edges stay crisp when smooth shading

// ---------------------------------------------------------------- primitives
function orientOutward(mesh, center = [0, 0, 0]) {
  for (const f of mesh.faces) {
    const n = newell(mesh.vertices, f);
    const c = faceCenter(mesh.vertices, f);
    if (dot(n, sub(c, center)) < 0) f.reverse();
  }
  return mesh;
}

export function primitiveToMesh(o) {
  if (o.shape === 'box') {
    const [hx, hy, hz] = o.size.map((s) => s / 2);
    const vertices = [];
    for (let i = 0; i < 8; i++) vertices.push([i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz]);
    const faces = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
    return orientOutward({ vertices, faces, smooth: true });
  }
  if (o.shape === 'cylinder') {
    const segs = 32, r = o.radius, hy = o.height / 2;
    const vertices = [];
    for (const y of [-hy, hy]) {
      for (let j = 0; j < segs; j++) {
        const t = (j / segs) * Math.PI * 2;
        vertices.push([Math.cos(t) * r, y, Math.sin(t) * r]);
      }
    }
    const faces = [];
    for (let j = 0; j < segs; j++) {
      const j2 = (j + 1) % segs;
      faces.push([j, j2, segs + j2, segs + j]);
    }
    faces.push([...Array(segs).keys()]);
    faces.push([...Array(segs).keys()].map((j) => segs + j));
    return orientOutward({ vertices, faces, smooth: true });
  }
  if (o.shape === 'sphere') {
    const rings = 16, segs = 32, r = o.radius;
    const vertices = [[0, r, 0]];
    for (let i = 1; i < rings; i++) {
      const phi = (i / rings) * Math.PI;
      for (let j = 0; j < segs; j++) {
        const t = (j / segs) * Math.PI * 2;
        vertices.push([Math.sin(phi) * Math.cos(t) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(t) * r]);
      }
    }
    vertices.push([0, -r, 0]);
    const ring = (i, j) => 1 + (i - 1) * segs + (j % segs);
    const bottom = vertices.length - 1;
    const faces = [];
    for (let j = 0; j < segs; j++) faces.push([0, ring(1, j), ring(1, j + 1)]);
    for (let i = 1; i < rings - 1; i++) {
      for (let j = 0; j < segs; j++) faces.push([ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j + 1)]);
    }
    for (let j = 0; j < segs; j++) faces.push([bottom, ring(rings - 1, j + 1), ring(rings - 1, j)]);
    return orientOutward({ vertices, faces, smooth: true });
  }
  // Plane: a single 2 x 2 quad facing +Y.
  return { vertices: [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]], faces: [[0, 1, 2, 3]], smooth: true };
}

// ---------------------------------------------------------------- geometry
// Newell's method: robust (area-weighted) normal of a possibly non-planar polygon.
export function newell(vs, f) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < f.length; i++) {
    const a = vs[f[i]], b = vs[f[(i + 1) % f.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx / 2, ny / 2, nz / 2];
}

export function faceCenter(vs, f) {
  const c = [0, 0, 0];
  for (const i of f) for (let k = 0; k < 3; k++) c[k] += vs[i][k];
  return c.map((v) => v / f.length);
}

const safeNormal = (n) => (length(n) > 1e-12 ? normalize(n) : [0, 1, 0]);

// Normal for every face corner. With smooth shading, a corner averages the
// faces around its vertex that meet at less than SMOOTH_ANGLE.
export function cornerNormals(mesh) {
  const { vertices, faces } = mesh;
  const fn = faces.map((f) => newell(vertices, f));
  const fu = fn.map(safeNormal);
  if (!mesh.smooth) return faces.map((f, i) => f.map(() => fu[i]));
  const vertFaces = vertices.map(() => []);
  faces.forEach((f, i) => f.forEach((v) => vertFaces[v].push(i)));
  const cosT = Math.cos((SMOOTH_ANGLE * Math.PI) / 180);
  return faces.map((f, fi) =>
    f.map((v) => {
      const s = [0, 0, 0];
      for (const g of vertFaces[v]) {
        if (dot(fu[g], fu[fi]) < cosT) continue;
        s[0] += fn[g][0]; s[1] += fn[g][1]; s[2] += fn[g][2];
      }
      return length(s) > 1e-12 ? normalize(s) : fu[fi];
    }),
  );
}

// Fan triangulation: [a, b, c, faceIndex, cornerA, cornerB, cornerC].
export function triangulate(mesh) {
  const tris = [];
  mesh.faces.forEach((f, fi) => {
    for (let k = 1; k + 1 < f.length; k++) tris.push([f[0], f[k], f[k + 1], fi, 0, k, k + 1]);
  });
  return tris;
}

export function meshEdges(mesh) {
  const seen = new Map();
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!seen.has(key)) seen.set(key, a < b ? [a, b] : [b, a]);
    }
  }
  return [...seen.values()];
}

export const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Removes faces, then any vertices no face uses. Returns the new mesh.
export function deleteFaces(mesh, faceSet) {
  const faces = mesh.faces.filter((_, i) => !faceSet.has(i));
  const used = new Map();
  for (const f of faces) for (const v of f) if (!used.has(v)) used.set(v, 0);
  const remap = new Map();
  const vertices = [];
  mesh.vertices.forEach((v, i) => {
    if (used.has(i)) { remap.set(i, vertices.length); vertices.push(v); }
  });
  return { ...mesh, vertices, faces: faces.map((f) => f.map((v) => remap.get(v))) };
}

// ---------------------------------------------------------------- BVH
// Binned surface-area-heuristic BVH over triangles given as a flat array of
// 9 floats each. Nodes are laid out depth-first: an internal node's left
// child is the next node, `a` holds the right child; a leaf holds `count`
// triangles starting at `a` in the returned `order`.
export function buildBVH(tv, n) {
  const order = new Uint32Array(n);
  const cen = new Float32Array(n * 3);
  const tmin = new Float32Array(n * 3), tmax = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let k = 0; k < 3; k++) {
      const a = tv[i * 9 + k], b = tv[i * 9 + 3 + k], c = tv[i * 9 + 6 + k];
      tmin[i * 3 + k] = Math.min(a, b, c);
      tmax[i * 3 + k] = Math.max(a, b, c);
      cen[i * 3 + k] = (a + b + c) / 3;
    }
  }
  const nodes = [];
  if (n === 0) return { nodes, order };

  const BINS = 12;
  const area = (mn, mx) => {
    const dx = mx[0] - mn[0], dy = mx[1] - mn[1], dz = mx[2] - mn[2];
    return dx < 0 ? 0 : dx * dy + dy * dz + dz * dx;
  };

  const build = (start, end) => {
    const node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], a: 0, count: 0 };
    const index = nodes.length;
    nodes.push(node);
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        node.min[k] = Math.min(node.min[k], tmin[t * 3 + k]);
        node.max[k] = Math.max(node.max[k], tmax[t * 3 + k]);
        cmin[k] = Math.min(cmin[k], cen[t * 3 + k]);
        cmax[k] = Math.max(cmax[k], cen[t * 3 + k]);
      }
    }
    const count = end - start;
    const leaf = () => { node.a = start; node.count = count; return index; };
    if (count <= 2) return leaf();

    let axis = 0;
    for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
    const extent = cmax[axis] - cmin[axis];
    if (extent < 1e-9) return count <= 8 ? leaf() : splitMiddle(start, end, node, index);

    const binCount = new Array(BINS).fill(0);
    const binMin = Array.from({ length: BINS }, () => [Infinity, Infinity, Infinity]);
    const binMax = Array.from({ length: BINS }, () => [-Infinity, -Infinity, -Infinity]);
    const binOf = (t) => Math.min(BINS - 1, Math.floor(((cen[t * 3 + axis] - cmin[axis]) / extent) * BINS));
    for (let i = start; i < end; i++) {
      const t = order[i], b = binOf(t);
      binCount[b]++;
      for (let k = 0; k < 3; k++) {
        binMin[b][k] = Math.min(binMin[b][k], tmin[t * 3 + k]);
        binMax[b][k] = Math.max(binMax[b][k], tmax[t * 3 + k]);
      }
    }
    let bestCost = Infinity, bestSplit = -1;
    for (let s = 1; s < BINS; s++) {
      const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
      const rmin = [Infinity, Infinity, Infinity], rmax = [-Infinity, -Infinity, -Infinity];
      let lc = 0, rc = 0;
      for (let b = 0; b < BINS; b++) {
        if (!binCount[b]) continue;
        const [mn, mx] = b < s ? [lmin, lmax] : [rmin, rmax];
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], binMin[b][k]); mx[k] = Math.max(mx[k], binMax[b][k]); }
        if (b < s) lc += binCount[b]; else rc += binCount[b];
      }
      if (!lc || !rc) continue;
      const cost = lc * area(lmin, lmax) + rc * area(rmin, rmax);
      if (cost < bestCost) { bestCost = cost; bestSplit = s; }
    }
    if (bestSplit < 0) return count <= 8 ? leaf() : splitMiddle(start, end, node, index);
    if (count <= 4 && bestCost >= count * area(node.min, node.max)) return leaf();

    // Partition the range in place.
    let i = start, j = end - 1;
    while (i <= j) {
      if (binOf(order[i]) < bestSplit) i++;
      else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; }
    }
    build(start, i);
    node.a = build(i, end);
    return index;
  };

  const splitMiddle = (start, end, node, index) => {
    const mid = (start + end) >> 1;
    build(start, mid);
    node.a = build(mid, end);
    return index;
  };

  build(0, n);
  return { nodes, order };
}

// Closest hit of ray (ro + t * rd, rd need not be unit length) against a BVH.
// Returns { t, tri } with `tri` an index into the original triangle list.
export function raycastBVH(bvh, tv, ro, rd, tMax = Infinity, tMin = 1e-6) {
  const { nodes, order } = bvh;
  if (!nodes.length) return null;
  const inv = rd.map((v) => 1 / (Math.abs(v) < 1e-12 ? 1e-12 : v));
  const boxHit = (n, best) => {
    let t0 = 0, t1 = best;
    for (let k = 0; k < 3; k++) {
      let a = (n.min[k] - ro[k]) * inv[k], b = (n.max[k] - ro[k]) * inv[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    return true;
  };
  let best = tMax, hit = -1;
  const stack = [0];
  while (stack.length) {
    const idx = stack.pop();
    const n = nodes[idx];
    if (!boxHit(n, best)) continue;
    if (n.count) {
      for (let i = n.a; i < n.a + n.count; i++) {
        const t = triHit(tv, order[i], ro, rd);
        if (t > tMin && t < best) { best = t; hit = order[i]; }
      }
    } else {
      stack.push(n.a, idx + 1);
    }
  }
  return hit >= 0 ? { t: best, tri: hit } : null;
}

// Möller–Trumbore, double-sided.
function triHit(tv, i, ro, rd) {
  const o = i * 9;
  const e1 = [tv[o + 3] - tv[o], tv[o + 4] - tv[o + 1], tv[o + 5] - tv[o + 2]];
  const e2 = [tv[o + 6] - tv[o], tv[o + 7] - tv[o + 1], tv[o + 8] - tv[o + 2]];
  const p = [rd[1] * e2[2] - rd[2] * e2[1], rd[2] * e2[0] - rd[0] * e2[2], rd[0] * e2[1] - rd[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-14) return Infinity;
  const id = 1 / det;
  const s = [ro[0] - tv[o], ro[1] - tv[o + 1], ro[2] - tv[o + 2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * id;
  if (u < 0 || u > 1) return Infinity;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (rd[0] * q[0] + rd[1] * q[1] + rd[2] * q[2]) * id;
  if (v < 0 || u + v > 1) return Infinity;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * id;
}

// ---------------------------------------------------------------- CPU cache
// Local-space triangles + BVH per mesh, rebuilt when mesh.version changes.
const cache = new WeakMap();
export function localAccel(mesh) {
  const c = cache.get(mesh);
  if (c && c.version === mesh.version) return c;
  const tris = triangulate(mesh);
  const tv = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) tv.set(mesh.vertices[t[k]], i * 9 + k * 3);
  });
  const entry = { version: mesh.version, tris, tv, bvh: buildBVH(tv, tris.length) };
  cache.set(mesh, entry);
  return entry;
}

// Call after changing a mesh so cached data is rebuilt.
export function touchMesh(mesh) {
  mesh.version = (mesh.version || 0) + 1;
}

// ---------------------------------------------------------------- editing ops
const cloneMesh = (mesh) => ({ ...mesh, vertices: mesh.vertices.map((v) => v.slice()), faces: mesh.faces.map((f) => f.slice()) });

// Drops vertices no face uses. Returns the new mesh and an old -> new index map.
export function compactVertices(mesh) {
  const used = new Set();
  for (const f of mesh.faces) for (const v of f) used.add(v);
  const remap = new Map();
  const vertices = [];
  mesh.vertices.forEach((v, i) => {
    if (used.has(i)) { remap.set(i, vertices.length); vertices.push(v); }
  });
  return { mesh: { ...mesh, vertices, faces: mesh.faces.map((f) => f.map((v) => remap.get(v))) }, remap };
}

// Extrudes a region of faces: the faces move onto copies of their vertices and
// side walls join the region's outline to the copies. Face indices of the
// region are unchanged. Returns the new mesh and the copied (moving) vertices.
export function extrudeFaces(mesh, faceSet) {
  const out = cloneMesh(mesh);
  const uses = new Map();
  for (const fi of faceSet) {
    const f = mesh.faces[fi];
    for (let i = 0; i < f.length; i++) {
      const key = edgeKey(f[i], f[(i + 1) % f.length]);
      uses.set(key, (uses.get(key) || 0) + 1);
    }
  }
  const dup = new Map();
  const copyOf = (v) => {
    if (!dup.has(v)) { dup.set(v, out.vertices.length); out.vertices.push(mesh.vertices[v].slice()); }
    return dup.get(v);
  };
  const sides = [];
  for (const fi of faceSet) {
    const f = mesh.faces[fi];
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      // Outline edge a->b: the wall runs a->b on the old ring, b'->a' on the new.
      if (uses.get(edgeKey(a, b)) === 1) sides.push([a, b, copyOf(b), copyOf(a)]);
    }
  }
  for (const fi of faceSet) out.faces[fi] = mesh.faces[fi].map(copyOf);
  out.faces.push(...sides);
  const { mesh: compact, remap } = compactVertices(out);
  return { mesh: compact, moved: new Set([...dup.values()].map((v) => remap.get(v))) };
}

// Extrudes edges into new quads. Returns the new mesh and the copied vertices.
export function extrudeEdges(mesh, edges) {
  const out = cloneMesh(mesh);
  const directed = new Map();
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      if (!directed.has(edgeKey(a, b))) directed.set(edgeKey(a, b), [a, b]);
    }
  }
  const dup = new Map();
  const copyOf = (v) => {
    if (!dup.has(v)) { dup.set(v, out.vertices.length); out.vertices.push(mesh.vertices[v].slice()); }
    return dup.get(v);
  };
  for (const [a, b] of edges) {
    const [p, q] = directed.get(edgeKey(a, b)) || [a, b];
    // A face already runs p->q along this edge, so the new one runs q->p.
    out.faces.push([q, p, copyOf(p), copyOf(q)]);
  }
  return { mesh: out, moved: new Set(dup.values()) };
}

// Insets each face on its own: the face is replaced by a smaller copy (same
// index) plus a ring of quads. New vertices start on top of the originals;
// `corners` says where each one is so the caller can slide it inward.
export function insetFaces(mesh, faceSet) {
  const out = cloneMesh(mesh);
  const corners = [];
  for (const fi of faceSet) {
    const f = mesh.faces[fi];
    const inner = f.map((v, i) => {
      const w = out.vertices.length;
      out.vertices.push(mesh.vertices[v].slice());
      corners.push({ v, w, prev: f[(i + f.length - 1) % f.length], next: f[(i + 1) % f.length], face: f });
      return w;
    });
    for (let i = 0; i < f.length; i++) {
      const j = (i + 1) % f.length;
      out.faces.push([f[i], f[j], inner[j], inner[i]]);
    }
    out.faces[fi] = inner;
  }
  return { mesh: out, corners };
}
