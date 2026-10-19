// WebGL2 progressive path tracer.

import { vertexSrc, traceSrc, previewSrc, displaySrc, MAX_LIGHTS, OBJ_TEXELS, TRIS_PER_ROW, NODES_PER_ROW } from './shaders.js';
import { objectFrame, sunDirection, MATERIAL_TYPES, SHAPES } from './scene.js';
import { hexToLinear, DEG, mulMatVec, add, normalize } from './math.js';
import { cornerNormals, triangulate, buildBVH } from './mesh.js';

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser/GPU cannot render to floating-point textures (EXT_color_buffer_float).');
    }
    this.gl = gl;
    this.canvas = canvas;
    this.trace = this.createProgram(vertexSrc, traceSrc);
    this.preview = this.createProgram(vertexSrc, previewSrc);
    this.display = this.createProgram(vertexSrc, displaySrc);
    this.vao = gl.createVertexArray();

    this.objTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.objTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, OBJ_TEXELS, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(OBJ_TEXELS * 4));

    const dataTex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
      return t;
    };
    this.triTex = dataTex();
    this.bvhTex = dataTex();
    this.numTris = 0;

    this.targets = [];
    this.width = 0;
    this.height = 0;
    this.frame = 0;
    this.numObjects = 0;
    this.numLights = 0;
    this.lightA = new Float32Array(MAX_LIGHTS * 4);
    this.lightB = new Float32Array(MAX_LIGHTS * 4);
  }

  createProgram(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('Shader compile error:\n' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Shader link error:\n' + gl.getProgramInfoLog(p));
    }
    const locs = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      locs[name] = gl.getUniformLocation(p, name);
    }
    // Unused uniforms get optimised away; hand back null so gl.uniform* no-ops.
    return { program: p, locs: new Proxy(locs, { get: (t, k) => t[k] ?? null }) };
  }

  resize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.targets = [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.width = w;
    this.height = h;
    this.reset();
  }

  reset() {
    this.frame = 0;
  }

  // Packs objects into a float texture (one row per object) and lights into
  // uniform arrays.
  uploadScene(scene) {
    const gl = this.gl;
    const objects = scene.entities.filter((e) => e.kind === 'object');
    const data = new Float32Array(Math.max(objects.length, 1) * OBJ_TEXELS * 4);
    objects.forEach((o, i) => {
      const { inv } = objectFrame(o);
      const m = o.material;
      const base = i * OBJ_TEXELS * 4;
      const color = hexToLinear(m.color);
      const emit = hexToLinear(m.emissionColor).map((c) => c * m.emission);
      data.set([...inv[0], SHAPES.indexOf(o.shape)], base);
      data.set([...inv[1], 0], base + 4);
      data.set([...inv[2], 0], base + 8);
      data.set([...o.position, m.ior], base + 12);
      data.set([...color, Math.max(0, MATERIAL_TYPES.indexOf(m.type))], base + 16);
      data.set([...emit, m.roughness], base + 20);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.objTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, OBJ_TEXELS, Math.max(objects.length, 1), 0, gl.RGBA, gl.FLOAT, data);
    this.numObjects = objects.length;
    this.uploadMeshes(objects);

    this.lightA.fill(0);
    this.lightB.fill(0);
    let n = 0;
    for (const l of scene.entities) {
      if (l.kind !== 'light' || n >= MAX_LIGHTS) continue;
      const r = Math.max(l.radius, 0.01);
      // Radiance chosen so that irradiance at distance d is ~ intensity / d^2.
      const L = hexToLinear(l.color).map((c) => (c * l.intensity) / (Math.PI * r * r));
      this.lightA.set([...l.position, r], n * 4);
      this.lightB.set([...L, 0], n * 4);
      n++;
    }
    const sun = scene.settings.sun;
    if (sun.enabled && n < MAX_LIGHTS) {
      const half = Math.max(sun.size / 2, 0.05) * DEG;
      const sin2 = Math.sin(half) ** 2;
      const omc = sin2 / (1 + Math.cos(half));
      // Radiance chosen so that `intensity` is the irradiance on a facing surface.
      const L = hexToLinear(sun.color).map((c) => (c * sun.intensity) / (Math.PI * sin2));
      this.lightA.set([...sunDirection(sun), omc], n * 4);
      this.lightB.set([...L, 1], n * 4);
      n++;
    }
    this.numLights = n;
  }

  // World-space triangles of every mesh object, sorted into a BVH.
  uploadMeshes(objects) {
    const gl = this.gl;
    const pos = [], nrm = [], owner = [];
    objects.forEach((o, oi) => {
      if (o.shape !== 'mesh' || !o.mesh) return;
      const { M, inv } = objectFrame(o);
      const toWorld = (v) => add(o.position, mulMatVec(M, v));
      // Normals transform by the inverse transpose of M.
      const nToWorld = (n) => normalize([0, 1, 2].map((k) => inv[0][k] * n[0] + inv[1][k] * n[1] + inv[2][k] * n[2]));
      const cn = cornerNormals(o.mesh);
      for (const [a, b, c, fi, ca, cb, cc] of triangulate(o.mesh)) {
        pos.push(toWorld(o.mesh.vertices[a]), toWorld(o.mesh.vertices[b]), toWorld(o.mesh.vertices[c]));
        nrm.push(nToWorld(cn[fi][ca]), nToWorld(cn[fi][cb]), nToWorld(cn[fi][cc]));
        owner.push(oi);
      }
    });
    const n = owner.length;
    this.numTris = n;
    if (!n) return;

    const tv = new Float32Array(n * 9);
    pos.forEach((p, i) => tv.set(p, i * 3));
    const { nodes, order } = buildBVH(tv, n);

    const triRows = Math.ceil(n / TRIS_PER_ROW);
    const triData = new Float32Array(TRIS_PER_ROW * 6 * 4 * triRows);
    for (let slot = 0; slot < n; slot++) {
      const t = order[slot];
      const base = ((slot % TRIS_PER_ROW) * 6 + Math.floor(slot / TRIS_PER_ROW) * TRIS_PER_ROW * 6) * 4;
      for (let k = 0; k < 3; k++) {
        triData.set([...pos[t * 3 + k], k === 0 ? owner[t] : 0], base + k * 4);
        triData.set([...nrm[t * 3 + k], 0], base + 12 + k * 4);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.triTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TRIS_PER_ROW * 6, triRows, 0, gl.RGBA, gl.FLOAT, triData);

    const nodeRows = Math.ceil(nodes.length / NODES_PER_ROW);
    const nodeData = new Float32Array(NODES_PER_ROW * 2 * 4 * nodeRows);
    nodes.forEach((node, i) => {
      const base = ((i % NODES_PER_ROW) * 2 + Math.floor(i / NODES_PER_ROW) * NODES_PER_ROW * 2) * 4;
      nodeData.set([...node.min, node.a, ...node.max, node.count], base);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.bvhTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, NODES_PER_ROW * 2, nodeRows, 0, gl.RGBA, gl.FLOAT, nodeData);
  }

  // Renders one sample per pixel into the accumulation buffer, either path
  // traced or (preview = true) as the flat solid view.
  renderSample(basis, settings, preview = false) {
    const gl = this.gl;
    const { program, locs } = preview ? this.preview : this.trace;
    const src = this.targets[this.frame % 2];
    const dst = this.targets[(this.frame + 1) % 2];
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, this.width, this.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(locs.uPrev, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.objTex);
    gl.uniform1i(locs.uObjects, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.triTex);
    gl.uniform1i(locs.uTris, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.bvhTex);
    gl.uniform1i(locs.uBVH, 3);
    gl.uniform1i(locs.uNumTris, this.numTris);

    const sky = settings.skyIntensity;
    gl.uniform1i(locs.uNumObjects, this.numObjects);
    gl.uniform1i(locs.uNumLights, this.numLights);
    gl.uniform4fv(locs.uLightA, this.lightA);
    gl.uniform4fv(locs.uLightB, this.lightB);
    gl.uniform2f(locs.uResolution, this.width, this.height);
    gl.uniform1i(locs.uFrame, this.frame);
    gl.uniform1ui(locs.uSeed, (Math.random() * 4294967295) >>> 0);
    gl.uniform3fv(locs.uCamPos, basis.pos);
    gl.uniform3fv(locs.uCamRight, basis.right);
    gl.uniform3fv(locs.uCamUp, basis.up);
    gl.uniform3fv(locs.uCamFwd, basis.fwd);
    gl.uniform1f(locs.uTanHalfFov, basis.tanHalf);
    gl.uniform1f(locs.uAperture, settings.aperture);
    gl.uniform1f(locs.uFocusDist, settings.focusDist);
    gl.uniform1i(locs.uMaxBounces, settings.maxBounces);
    gl.uniform3fv(locs.uSkyZenith, hexToLinear(settings.skyZenith).map((c) => c * sky));
    gl.uniform3fv(locs.uSkyHorizon, hexToLinear(settings.skyHorizon).map((c) => c * sky));
    gl.uniform3fv(locs.uSkyGround, hexToLinear(settings.skyGround).map((c) => c * sky));
    gl.uniform1f(locs.uClamp, settings.clampLum > 0 ? settings.clampLum : 1e20);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frame++;
  }

  present(exposure, raw = false) {
    const gl = this.gl;
    const { program, locs } = this.display;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.frame % 2].tex);
    gl.uniform1i(locs.uAccum, 0);
    gl.uniform1f(locs.uExposure, exposure);
    gl.uniform1i(locs.uRaw, raw ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  clearScreen([r, g, b]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}
