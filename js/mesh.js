// Polygon meshes: building them from primitives, normals, triangulation,
// editing helpers, and a bounding volume hierarchy (BVH) used both on the GPU
// (path tracing) and on the CPU (picking).
//
// A mesh is { vertices: [[x,y,z], ...], faces: [[i, j, k, ...], ...], smooth }
// in the object's local space. Faces are polygons wound counter-clockwise
// when seen from outside.

import { sub, dot, cross, normalize, length } from './math.js';

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

// ---------------------------------------------------------------- loop cut
function edgeFaceMap(mesh) {
  const map = new Map();
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const k = edgeKey(f[i], f[(i + 1) % f.length]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(fi);
    }
  });
  return map;
}

// In quad f, the edge across from p-q, oriented so its first vertex is the
// one joined to p.
function oppositeEdge(f, p, q) {
  const other = (v, not) => {
    const i = f.indexOf(v);
    const a = f[(i + 1) % 4], b = f[(i + 3) % 4];
    return a === not ? b : a;
  };
  return [other(p, q), other(q, p)];
}

// The ring of edges a loop cut through edge a-b would cross: walks from quad
// to quad through opposite edges until it hits a non-quad, an open edge, or
// comes back round. Edges keep a consistent direction so a fraction t means
// the same side all the way round.
export function edgeRing(mesh, a, b) {
  const ef = edgeFaceMap(mesh);
  const startKey = edgeKey(a, b);
  const start = ef.get(startKey);
  if (!start) return null;
  const edges = new Map([[startKey, [a, b]]]);
  const faces = [];
  const used = new Set();
  let closed = false;
  const walk = (firstFace) => {
    let p = a, q = b, k = startKey, fi = firstFace;
    while (fi !== undefined && !used.has(fi) && mesh.faces[fi].length === 4) {
      used.add(fi);
      const [p2, q2] = oppositeEdge(mesh.faces[fi], p, q);
      const k2 = edgeKey(p2, q2);
      faces.push({ fi, k1: k, k2 });
      if (k2 === startKey) { closed = true; return; }
      if (edges.has(k2)) return;
      edges.set(k2, [p2, q2]);
      fi = ef.get(k2).find((x) => x !== fi);
      p = p2; q = q2; k = k2;
    }
  };
  walk(start[0]);
  if (!closed && start[1] !== undefined) walk(start[1]);
  return faces.length ? { edges, faces } : null;
}

// Cuts every ring edge at fractions `ts` and splits the crossed quads.
// Faces that only touch a ring edge get the new vertices added to that edge
// so the mesh stays watertight. Returns the mesh and, per ring edge key,
// { p, q, list } with the new vertex indices from p to q.
export function loopCut(mesh, ring, ts) {
  const out = cloneMesh(mesh);
  const cuts = new Map();
  for (const [k, [p, q]] of ring.edges) {
    const P = mesh.vertices[p], Q = mesh.vertices[q];
    const list = ts.map((t) => {
      out.vertices.push(P.map((c, i) => c + (Q[i] - c) * t));
      return out.vertices.length - 1;
    });
    cuts.set(k, { p, q, list });
  }
  const crossed = new Set();
  for (const { fi, k1, k2 } of ring.faces) {
    crossed.add(fi);
    const E1 = cuts.get(k1), E2 = cuts.get(k2);
    const r1 = [E1.p, ...E1.list, E1.q], r2 = [E2.p, ...E2.list, E2.q];
    const n0 = newell(mesh.vertices, mesh.faces[fi]);
    const pieces = [];
    for (let j = 0; j + 1 < r1.length; j++) {
      const quad = [r1[j], r1[j + 1], r2[j + 1], r2[j]];
      if (dot(newell(out.vertices, quad), n0) < 0) quad.reverse();
      pieces.push(quad);
    }
    out.faces[fi] = pieces[0];
    out.faces.push(...pieces.slice(1));
  }
  mesh.faces.forEach((f, fi) => {
    if (crossed.has(fi)) return;
    const nf = [];
    let changed = false;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      nf.push(a);
      const c = cuts.get(edgeKey(a, b));
      if (c) { changed = true; nf.push(...(c.p === a ? c.list : [...c.list].reverse())); }
    }
    if (changed) out.faces[fi] = nf;
  });
  return { mesh: out, cuts };
}

// ---------------------------------------------------------------- bevel
// Bevels edges (given as edge keys) to `width`, with `segments` steps across
// the bevel (1 = flat chamfer). Positions are worked out in world space via
// toWorld / toLocal so the width is in world units. Where bevelled edges
// meet, the gap at the corner is filled with a cap. Returns the new mesh and
// the indices of the bevel faces, or null if no edge can be bevelled.
export function bevelEdges(mesh, keys, width, segments, toWorld, toLocal) {
  const world = mesh.vertices.map(toWorld);
  const ef = edgeFaceMap(mesh);
  const sel = new Set([...keys].filter((k) => (ef.get(k) || []).length === 2));
  if (!sel.size) return null;
  const bv = new Set();
  for (const k of sel) for (const v of k.split('-')) bv.add(Number(v));

  // Keep the bevel narrower than the edges it slides along.
  let minLen = Infinity;
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      if (bv.has(a) || bv.has(b)) minLen = Math.min(minLen, length(sub(world[a], world[b])));
    }
  }
  const d = Math.max(0, Math.min(width, minLen * 0.45));

  const outW = world.map((w) => w.slice());
  const addVert = (p) => { outW.push(p); return outW.length - 1; };
  const slides = new Map();
  const slide = (v, w) => {
    const key = `${v}>${w}`;
    if (!slides.has(key)) {
      const dir = normalize(sub(world[w], world[v]));
      slides.set(key, addVert(world[v].map((c, i) => c + dir[i] * d)));
    }
    return slides.get(key);
  };

  // Each face corner at a bevelled vertex becomes a short list of new
  // vertices: an inset point when both of its edges are bevelled, otherwise
  // points slid along its unbevelled edge(s).
  const corner = new Map();
  const faces = mesh.faces.map((f, fi) => {
    const n = normalize(newell(world, f));
    const nf = [];
    f.forEach((v, i) => {
      if (!bv.has(v)) { nf.push(v); return; }
      const prev = f[(i + f.length - 1) % f.length], next = f[(i + 1) % f.length];
      const inSel = sel.has(edgeKey(prev, v)), outSel = sel.has(edgeKey(v, next));
      let L;
      if (inSel && outSel) {
        const e1 = normalize(sub(world[v], world[prev])), e2 = normalize(sub(world[next], world[v]));
        const i1 = normalize(cross(n, e1)), i2 = normalize(cross(n, e2));
        const s = [i1[0] + i2[0], i1[1] + i2[1], i1[2] + i2[2]];
        const dir = length(s) > 1e-6 ? normalize(s) : i1;
        const k = 1 / Math.max(dot(dir, i1), 0.2);
        const maxOff = length(sub(faceCenter(world, f), world[v])) * 0.98;
        const off = Math.min(d * k, maxOff);
        L = [addVert(world[v].map((c, j) => c + dir[j] * off))];
      } else if (inSel) L = [slide(v, next)];
      else if (outSel) L = [slide(v, prev)];
      else L = [slide(v, prev), slide(v, next)];
      corner.set(`${fi}:${v}`, L);
      nf.push(...L);
    });
    return nf;
  });

  // Points across the bevel at vertex v between two corner points, bowed
  // toward the original corner (quadratic curve) for a rounded profile.
  // Strips that meet at the same two points share one curve.
  const curves = new Map();
  const curve = (v, from, to) => {
    const key = `${v}:${Math.min(from, to)}-${Math.max(from, to)}`;
    if (!curves.has(key)) {
      const pts = [];
      for (let j = 1; j < segments; j++) {
        const t = j / segments, u = 1 - t;
        pts.push(addVert([0, 1, 2].map((c) => u * u * outW[from][c] + 2 * u * t * world[v][c] + t * t * outW[to][c])));
      }
      curves.set(key, { from, pts });
    }
    const c = curves.get(key);
    return c.from === from ? c.pts : [...c.pts].reverse();
  };
  // Which curve each bevelled edge uses at each end, and which face it starts from.
  const arcs = new Map();
  const arc = (v, from, to, k, side) => {
    arcs.set(`${k}@${v}`, { from, to, side });
    return curve(v, from, to);
  };

  const runs = (fi, p, q) => {
    const f = mesh.faces[fi];
    return f[(f.indexOf(p) + 1) % f.length] === q;
  };
  const newFaces = [];
  for (const k of sel) {
    const [x, y] = k.split('-').map(Number);
    const [f1, f2] = ef.get(k);
    let F, G, a, b;
    if (runs(f1, x, y)) { F = f1; G = f2; a = x; b = y; }
    else { F = f1; G = f2; a = y; b = x; }
    if (!runs(F, a, b) || !runs(G, b, a)) continue; // inconsistent winding
    const LFa = corner.get(`${F}:${a}`), LFb = corner.get(`${F}:${b}`);
    const LGa = corner.get(`${G}:${a}`), LGb = corner.get(`${G}:${b}`);
    const Fa = LFa[LFa.length - 1], Fb = LFb[0], Ga = LGa[0], Gb = LGb[LGb.length - 1];
    const Ra = [Fa, ...arc(a, Fa, Ga, k, F), Ga];
    const Rb = [Fb, ...arc(b, Fb, Gb, k, F), Gb];
    for (let j = 0; j + 1 < Ra.length; j++) newFaces.push([Rb[j], Ra[j], Ra[j + 1], Rb[j + 1]]);
  }

  // Corner caps: walk the faces around each bevelled vertex and close the gap.
  const vertFaces = new Map();
  mesh.faces.forEach((f, fi) => f.forEach((v) => { if (bv.has(v)) (vertFaces.get(v) || vertFaces.set(v, []).get(v)).push(fi); }));
  for (const v of bv) {
    const around = vertFaces.get(v);
    const after = (fi) => { const f = mesh.faces[fi]; return f[(f.indexOf(v) + 1) % f.length]; };
    const before = (fi) => { const f = mesh.faces[fi]; return f[(f.indexOf(v) + f.length - 1) % f.length]; };
    const order = [around[0]];
    let closedFan = false;
    for (let guard = 0; guard < around.length; guard++) {
      const cur = order[order.length - 1];
      const g = around.find((x) => x !== cur && before(x) === after(cur));
      if (g === undefined) break;
      if (g === order[0]) { closedFan = true; break; }
      if (order.includes(g)) break;
      order.push(g);
    }
    if (!closedFan) continue;
    const cycle = [];
    for (const fi of order) {
      cycle.push(...corner.get(`${fi}:${v}`));
      const k = edgeKey(v, after(fi));
      const A = sel.has(k) && arcs.get(`${k}@${v}`);
      if (A) cycle.push(...(A.side === fi ? curve(v, A.from, A.to) : curve(v, A.to, A.from)));
    }
    const ring = cycle.filter((x, i) => x !== cycle[(i + cycle.length - 1) % cycle.length]);
    if (new Set(ring).size < 3) continue;
    // A gap that just runs out and back along the same points has no area.
    const steps = new Set(ring.map((x, i) => `${x}>${ring[(i + 1) % ring.length]}`));
    if ([...steps].every((st) => steps.has(st.split('>').reverse().join('>')))) continue;
    const vn = [0, 0, 0];
    for (const fi of order) {
      const fn = newell(world, mesh.faces[fi]);
      for (let c = 0; c < 3; c++) vn[c] += fn[c];
    }
    const cap = dot(newell(outW, ring), vn) < 0 ? [...ring].reverse() : ring;
    if (segments > 1 && cap.length > 3) {
      // Rounded corner: fan from a centre point bowed toward the old corner.
      const c = [0, 0, 0];
      for (const i of cap) for (let j = 0; j < 3; j++) c[j] += outW[i][j] / cap.length;
      const centre = addVert(c.map((x, j) => x + (world[v][j] - x) * 0.3));
      for (let i = 0; i < cap.length; i++) newFaces.push([cap[i], cap[(i + 1) % cap.length], centre]);
    } else {
      newFaces.push(cap);
    }
  }

  const merged = { ...mesh, vertices: outW.map(toLocal), faces: [...faces, ...newFaces] };
  const { mesh: compact } = compactVertices(merged);
  const first = faces.length;
  return { mesh: compact, newFaces: new Set(newFaces.map((_, i) => first + i)) };
}
