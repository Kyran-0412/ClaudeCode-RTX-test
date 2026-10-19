// GLSL sources for the path tracer.
//
// The trace pass renders one sample per pixel and blends it into a running
// average stored in a float texture. The display pass tone-maps that average.

export const MAX_LIGHTS = 16;
// Texels per object row in the object data texture (see Renderer.uploadScene).
export const OBJ_TEXELS = 6;

export const vertexSrc = `#version 300 es
void main() {
  // Full-screen triangle, no vertex buffers needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Shared by the path tracer and the solid preview: uniforms, RNG, scene
// data access and ray intersection.
const commonSrc = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

#define PI 3.14159265359
#define TWO_PI 6.28318530718
#define INF 1e20
#define EPS 1e-3
#define MAX_LIGHTS ${MAX_LIGHTS}
#define PLASTIC_SPEC 0.35

// Material types
#define M_DIFFUSE 0
#define M_PLASTIC 1
#define M_METAL 2
#define M_GLASS 3

uniform sampler2D uPrev;
uniform sampler2D uObjects;
uniform int uNumObjects;
uniform int uNumLights;
// Sphere light: A = (center, radius),       B = (radiance, 0)
// Sun light:    A = (direction, 1-cos(max)), B = (radiance, 1)
uniform vec4 uLightA[MAX_LIGHTS];
uniform vec4 uLightB[MAX_LIGHTS];

uniform vec2 uResolution;
uniform int uFrame;
uniform uint uSeed;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uAperture;
uniform float uFocusDist;
uniform int uMaxBounces;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform float uClamp;

out vec4 outColor;

// ---------------------------------------------------------------- random
uint gRng;
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rand() {
  gRng = pcgHash(gRng);
  return float(gRng >> 8u) * (1.0 / 16777216.0);
}

// Orthonormal basis around n (Duff et al. 2017).
void onb(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 cosineSample(vec3 n) {
  float u1 = rand(), u2 = rand();
  float r = sqrt(u1), phi = TWO_PI * u2;
  vec3 t, b; onb(n, t, b);
  return normalize(t * (r * cos(phi)) + b * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u1)));
}

// ---------------------------------------------------------------- scene data
struct Obj { vec3 r0; vec3 r1; vec3 r2; vec3 pos; int shape; };
struct Mat { vec3 color; int type; float rough; float ior; vec3 emit; };

Obj getObj(int i) {
  vec4 a = texelFetch(uObjects, ivec2(0, i), 0);
  vec4 b = texelFetch(uObjects, ivec2(1, i), 0);
  vec4 c = texelFetch(uObjects, ivec2(2, i), 0);
  vec4 d = texelFetch(uObjects, ivec2(3, i), 0);
  Obj o;
  o.r0 = a.xyz; o.r1 = b.xyz; o.r2 = c.xyz; o.pos = d.xyz;
  o.shape = int(a.w + 0.5);
  return o;
}

Mat getMat(int i) {
  vec4 d = texelFetch(uObjects, ivec2(3, i), 0);
  vec4 e = texelFetch(uObjects, ivec2(4, i), 0);
  vec4 f = texelFetch(uObjects, ivec2(5, i), 0);
  Mat m;
  m.color = e.rgb; m.type = int(e.w + 0.5);
  m.emit = f.rgb; m.rough = f.w;
  m.ior = d.w;
  return m;
}

// ---------------------------------------------------------------- intersection
// Shapes are intersected in their local space (unit sphere / box / cylinder).
// The ray direction is not renormalised, so t stays a world-space distance.

float hitSphere(vec3 o, vec3 d, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc < 0.0) return INF;
  float s = sqrt(disc);
  float t = (-b - s) / a;
  if (t <= EPS) t = (-b + s) / a;
  if (t <= EPS) return INF;
  n = o + d * t;
  return t;
}

float hitBox(vec3 o, vec3 d, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  vec3 dd = vec3(abs(d.x) < 1e-9 ? 1e-9 : d.x,
                 abs(d.y) < 1e-9 ? 1e-9 : d.y,
                 abs(d.z) < 1e-9 ? 1e-9 : d.z);
  vec3 inv = 1.0 / dd;
  vec3 t0 = (-1.0 - o) * inv, t1 = (1.0 - o) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tn > tf || tf <= EPS) return INF;
  if (tn > EPS) {
    n = -sign(dd) * step(tmin.yzx, tmin) * step(tmin.zxy, tmin);
    return tn;
  }
  n = sign(dd) * step(tmax, tmax.yzx) * step(tmax, tmax.zxy);
  return tf;
}

float hitCylinder(vec3 o, vec3 d, out vec3 n) {
  n = vec3(0.0, 1.0, 0.0);
  float best = INF;
  float a = d.x * d.x + d.z * d.z;
  if (a > 1e-12) {
    float b = o.x * d.x + o.z * d.z;
    float c = o.x * o.x + o.z * o.z - 1.0;
    float disc = b * b - a * c;
    if (disc >= 0.0) {
      float s = sqrt(disc);
      float t0 = (-b - s) / a;
      if (t0 > EPS && abs(o.y + d.y * t0) <= 1.0) { best = t0; n = vec3(o.x + d.x * t0, 0.0, o.z + d.z * t0); }
      float t1 = (-b + s) / a;
      if (t1 > EPS && t1 < best && abs(o.y + d.y * t1) <= 1.0) { best = t1; n = vec3(o.x + d.x * t1, 0.0, o.z + d.z * t1); }
    }
  }
  if (abs(d.y) > 1e-12) {
    for (int k = 0; k < 2; k++) {
      float cy = k == 0 ? 1.0 : -1.0;
      float tc = (cy - o.y) / d.y;
      vec3 p = o + d * tc;
      if (tc > EPS && tc < best && p.x * p.x + p.z * p.z <= 1.0) { best = tc; n = vec3(0.0, cy, 0.0); }
    }
  }
  return best;
}

float intersectObj(Obj ob, vec3 ro, vec3 rd, out vec3 nW) {
  vec3 p = ro - ob.pos;
  vec3 o = vec3(dot(ob.r0, p), dot(ob.r1, p), dot(ob.r2, p));
  vec3 d = vec3(dot(ob.r0, rd), dot(ob.r1, rd), dot(ob.r2, rd));
  vec3 nl;
  float t;
  if (ob.shape == 0) t = hitSphere(o, d, nl);
  else if (ob.shape == 1) t = hitBox(o, d, nl);
  else t = hitCylinder(o, d, nl);
  // Normal transform: transpose(inverse(M)) * n_local.
  nW = ob.r0 * nl.x + ob.r1 * nl.y + ob.r2 * nl.z;
  float l = length(nW);
  nW = l > 0.0 ? nW / l : vec3(0.0, 1.0, 0.0);
  return t;
}

float hitSphereWorld(vec3 c, float r, vec3 ro, vec3 rd) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float cc = dot(oc, oc) - r * r;
  float disc = b * b - cc;
  if (disc < 0.0) return INF;
  float s = sqrt(disc);
  float t = -b - s;
  if (t <= EPS) t = -b + s;
  return t > EPS ? t : INF;
}

float traceScene(vec3 ro, vec3 rd, out vec3 n, out int objId, out int lightId) {
  float tBest = INF;
  n = vec3(0.0, 1.0, 0.0);
  objId = -1; lightId = -1;
  for (int i = 0; i < uNumObjects; i++) {
    vec3 nn;
    float t = intersectObj(getObj(i), ro, rd, nn);
    if (t < tBest) { tBest = t; n = nn; objId = i; }
  }
  for (int k = 0; k < uNumLights; k++) {
    if (uLightB[k].w > 0.5) continue;
    float t = hitSphereWorld(uLightA[k].xyz, uLightA[k].w, ro, rd);
    if (t < tBest) {
      tBest = t; n = normalize(ro + rd * t - uLightA[k].xyz);
      lightId = k; objId = -1;
    }
  }
  return tBest;
}

bool occluded(vec3 ro, vec3 rd, float tMax) {
  for (int i = 0; i < uNumObjects; i++) {
    vec3 nn;
    if (intersectObj(getObj(i), ro, rd, nn) < tMax) return true;
  }
  return false;
}

`;

export const traceSrc = commonSrc + `
// ---------------------------------------------------------------- environment
vec3 skyColor(vec3 d) {
  if (d.y >= 0.0) return mix(uSkyHorizon, uSkyZenith, pow(d.y, 0.6));
  return mix(uSkyHorizon, uSkyGround, pow(min(-d.y * 4.0, 1.0), 0.5));
}

// ---------------------------------------------------------------- lights
// 1 - cos(half angle) of the cone a light subtends from P. Written to avoid
// catastrophic cancellation for small/distant lights.
float lightOneMinusCos(int k, vec3 P) {
  vec4 A = uLightA[k];
  if (uLightB[k].w > 0.5) return A.w;
  vec3 dv = A.xyz - P;
  float s2 = min(A.w * A.w / max(dot(dv, dv), 1e-12), 1.0);
  return s2 / (1.0 + sqrt(1.0 - s2));
}

float lightPdf(int k, vec3 P) {
  return 1.0 / (float(uNumLights) * TWO_PI * max(lightOneMinusCos(k, P), 1e-12));
}

// Uniformly picks a light, then samples a direction in the cone it subtends.
bool sampleLight(vec3 P, out vec3 L, out float pdf, out float dist, out vec3 Le) {
  int k = min(int(rand() * float(uNumLights)), uNumLights - 1);
  vec4 A = uLightA[k];
  vec4 B = uLightB[k];
  L = vec3(0.0); pdf = 0.0; dist = INF; Le = B.rgb;
  vec3 axis;
  bool isSun = B.w > 0.5;
  if (isSun) {
    axis = A.xyz;
  } else {
    vec3 dv = A.xyz - P;
    float d2 = dot(dv, dv);
    if (d2 <= A.w * A.w) return false;
    axis = dv / sqrt(d2);
  }
  float omc = lightOneMinusCos(k, P);
  float u1 = rand(), u2 = rand();
  float cosT = 1.0 - u1 * omc;
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  float phi = TWO_PI * u2;
  vec3 t, b; onb(axis, t, b);
  L = normalize(t * (cos(phi) * sinT) + b * (sin(phi) * sinT) + axis * cosT);
  pdf = 1.0 / (float(uNumLights) * TWO_PI * max(omc, 1e-12));
  if (!isSun) {
    vec3 oc = P - A.xyz;
    float bb = dot(oc, L);
    float disc = bb * bb - (dot(oc, oc) - A.w * A.w);
    dist = -bb - sqrt(max(disc, 0.0));
  }
  return true;
}

float powerHeuristic(float a, float b) {
  float a2 = a * a, b2 = b * b;
  return a2 / max(a2 + b2, 1e-20);
}

// ---------------------------------------------------------------- BSDFs
float alphaOf(float rough) { return max(rough * rough, 0.002); }

float ggxD(float NdH, float a) {
  float a2 = a * a;
  float d = NdH * NdH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

float ggxG1(float NdX, float a) {
  float a2 = a * a;
  return 2.0 * NdX / (NdX + sqrt(a2 + (1.0 - a2) * NdX * NdX));
}

vec3 sampleGGX(vec3 n, float a) {
  float u1 = rand(), u2 = rand();
  float phi = TWO_PI * u1;
  float cosT = sqrt((1.0 - u2) / (1.0 + (a * a - 1.0) * u2));
  float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  vec3 t, b; onb(n, t, b);
  return normalize(t * (cos(phi) * sinT) + b * (sin(phi) * sinT) + n * cosT);
}

float schlick(float f0, float c) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }

// Exact Fresnel reflectance for a dielectric. eta = n_transmitted / n_incident.
float fresnelDielectric(float cosI, float eta) {
  float sin2T = (1.0 - cosI * cosI) / (eta * eta);
  if (sin2T >= 1.0) return 1.0;
  float cosT = sqrt(1.0 - sin2T);
  float rs = (cosI - eta * cosT) / (cosI + eta * cosT);
  float rp = (eta * cosI - cosT) / (eta * cosI + cosT);
  return 0.5 * (rs * rs + rp * rp);
}

// Returns f * cos(theta_L) for non-delta materials, and the sampling pdf.
vec3 evalBSDF(Mat m, vec3 N, vec3 V, vec3 L, out float pdf) {
  pdf = 0.0;
  float NdL = dot(N, L), NdV = dot(N, V);
  if (NdL <= 0.0 || NdV <= 0.0) return vec3(0.0);
  if (m.type == M_DIFFUSE) {
    pdf = NdL / PI;
    return m.color * (NdL / PI);
  }
  vec3 H = normalize(V + L);
  float NdH = max(dot(N, H), 0.0);
  float VdH = max(dot(V, H), 1e-6);
  float a = alphaOf(m.rough);
  float D = ggxD(NdH, a);
  float G = ggxG1(NdV, a) * ggxG1(NdL, a);
  float specPdf = D * NdH / (4.0 * VdH);
  if (m.type == M_METAL) {
    vec3 F = m.color + (1.0 - m.color) * pow(1.0 - VdH, 5.0);
    pdf = specPdf;
    return F * (D * G / (4.0 * NdV));
  }
  // Plastic: GGX clear coat over a Lambertian base.
  float f0 = pow((m.ior - 1.0) / (m.ior + 1.0), 2.0);
  float F = schlick(f0, VdH);
  vec3 spec = vec3(F * D * G / (4.0 * NdV));
  vec3 diff = m.color * (NdL / PI) * (1.0 - schlick(f0, NdV)) * (1.0 - schlick(f0, NdL));
  pdf = PLASTIC_SPEC * specPdf + (1.0 - PLASTIC_SPEC) * NdL / PI;
  return spec + diff;
}

vec3 sampleBSDFDir(Mat m, vec3 N, vec3 V) {
  bool spec = m.type == M_METAL || (m.type == M_PLASTIC && rand() < PLASTIC_SPEC);
  if (spec) return reflect(-V, sampleGGX(N, alphaOf(m.rough)));
  return cosineSample(N);
}

// Glass: Fresnel-weighted choice between reflection and refraction about a
// (possibly rough) microfacet normal. Treated as a delta lobe.
vec3 sampleGlass(Mat m, vec3 N, vec3 V, bool front) {
  float eta = front ? m.ior : 1.0 / m.ior;
  vec3 H = N;
  if (m.rough > 0.02) {
    H = sampleGGX(N, alphaOf(m.rough));
    if (dot(H, V) <= 0.0) H = N;
  }
  float cosI = dot(V, H);
  float F = fresnelDielectric(cosI, eta);
  if (rand() < F) {
    vec3 R = reflect(-V, H);
    return dot(R, N) > 0.0 ? R : reflect(-V, N);
  }
  vec3 T = refract(-V, H, 1.0 / eta);
  if (dot(T, T) < 1e-8) return reflect(-V, H);
  if (dot(T, N) >= 0.0) {
    T = refract(-V, N, 1.0 / eta);
    if (dot(T, T) < 1e-8) return reflect(-V, N);
  }
  return T;
}

// ---------------------------------------------------------------- integrator
vec3 trace(vec3 ro, vec3 rd) {
  vec3 radiance = vec3(0.0);
  vec3 thr = vec3(1.0);
  bool lastDelta = true;
  float lastPdf = 1.0;
  vec3 lastP = ro;

  for (int depth = 0; depth < 64; depth++) {
    vec3 n; int oid, lid;
    float t = traceScene(ro, rd, n, oid, lid);

    if (oid < 0 && lid < 0) {
      radiance += thr * skyColor(rd);
      for (int k = 0; k < uNumLights; k++) {
        if (uLightB[k].w < 0.5) continue;
        if (dot(rd, uLightA[k].xyz) >= 1.0 - uLightA[k].w) {
          float w = lastDelta ? 1.0 : powerHeuristic(lastPdf, lightPdf(k, lastP));
          radiance += thr * uLightB[k].rgb * w;
        }
      }
      break;
    }

    if (lid >= 0) {
      float w = lastDelta ? 1.0 : powerHeuristic(lastPdf, lightPdf(lid, lastP));
      radiance += thr * uLightB[lid].rgb * w;
      break;
    }

    vec3 P = ro + rd * t;
    Mat m = getMat(oid);
    bool front = dot(rd, n) < 0.0;
    vec3 Ns = front ? n : -n;
    vec3 V = -rd;

    // Beer-Lambert absorption while travelling inside tinted glass.
    if (m.type == M_GLASS && !front) thr *= pow(max(m.color, vec3(1e-4)), vec3(t));

    radiance += thr * m.emit;
    if (depth >= uMaxBounces) break;

    bool delta = m.type == M_GLASS;

    // Next-event estimation with multiple importance sampling.
    if (!delta && uNumLights > 0) {
      vec3 Ld, Le; float lpdf, dist;
      if (sampleLight(P, Ld, lpdf, dist, Le) && dot(Ld, Ns) > 0.0) {
        float bpdf;
        vec3 f = evalBSDF(m, Ns, V, Ld, bpdf);
        if (bpdf > 0.0 && !occluded(P + Ns * EPS, Ld, dist - 2.0 * EPS)) {
          radiance += thr * f * Le * (powerHeuristic(lpdf, bpdf) / lpdf);
        }
      }
    }

    vec3 L;
    float pdf;
    if (delta) {
      L = sampleGlass(m, Ns, V, front);
      pdf = 1.0;
    } else {
      L = sampleBSDFDir(m, Ns, V);
      if (dot(L, Ns) <= 0.0) break;
      vec3 f = evalBSDF(m, Ns, V, L, pdf);
      if (pdf <= 1e-8) break;
      thr *= f / pdf;
    }

    lastDelta = delta;
    lastPdf = pdf;
    lastP = P;
    ro = P + Ns * (dot(L, Ns) > 0.0 ? EPS : -EPS);
    rd = L;

    // Russian roulette.
    if (depth >= 2) {
      float p = clamp(max(thr.r, max(thr.g, thr.b)), 0.05, 0.95);
      if (rand() > p) break;
      thr /= p;
    }
  }
  return radiance;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  gRng = pcgHash(uint(px.x) + pcgHash(uint(px.y) + pcgHash(uSeed)));

  vec2 jitter = vec2(rand(), rand());
  vec2 ndc = ((gl_FragCoord.xy - 0.5 + jitter) / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 dir = normalize(uCamFwd + ndc.x * uTanHalfFov * aspect * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 ro = uCamPos, rd = dir;
  if (uAperture > 0.0) {
    // Thin-lens depth of field.
    vec3 focusPoint = uCamPos + dir * (uFocusDist / dot(dir, uCamFwd));
    float r = sqrt(rand()) * uAperture;
    float a = TWO_PI * rand();
    ro = uCamPos + uCamRight * (r * cos(a)) + uCamUp * (r * sin(a));
    rd = normalize(focusPoint - ro);
  }

  vec3 col = trace(ro, rd);
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
  float mx = max(col.r, max(col.g, col.b));
  if (mx > uClamp) col *= uClamp / mx;

  vec3 prev = texelFetch(uPrev, px, 0).rgb;
  outColor = vec4(uFrame == 0 ? col : mix(prev, col, 1.0 / float(uFrame + 1)), 1.0);
}`;

export const displaySrc = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uAccum;
uniform float uExposure;
uniform bool uRaw; // preview images are already display-ready
out vec4 outColor;

// ACES filmic approximation (Narkowicz 2015).
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb;
  outColor = vec4(toSRGB(uRaw ? clamp(c, 0.0, 1.0) : aces(c * uExposure)), 1.0);
}`;

// Solid preview: one primary ray per pixel, plain grey surfaces lit by a
// headlight and a fixed key light. No materials, shadows or bounces.
export const previewSrc = commonSrc + `
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  gRng = pcgHash(uint(px.x) + pcgHash(uint(px.y) + pcgHash(uSeed)));
  vec2 jitter = uFrame == 0 ? vec2(0.5) : vec2(rand(), rand());
  vec2 ndc = ((gl_FragCoord.xy - 0.5 + jitter) / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;
  vec3 rd = normalize(uCamFwd + ndc.x * uTanHalfFov * aspect * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  vec3 n; int oid, lid;
  traceScene(uCamPos, rd, n, oid, lid);
  vec3 col;
  if (oid < 0 && lid < 0) {
    col = mix(vec3(0.050, 0.052, 0.058), vec3(0.16, 0.165, 0.18), clamp(ndc.y * 0.5 + 0.5, 0.0, 1.0));
  } else if (lid >= 0) {
    col = vec3(1.0, 0.82, 0.45);
  } else {
    vec3 N = dot(n, rd) < 0.0 ? n : -n;
    float head = max(dot(N, -rd), 0.0);
    float key = max(dot(N, normalize(vec3(0.45, 0.8, 0.4))), 0.0);
    float hemi = 0.5 + 0.5 * N.y;
    col = vec3(0.6) * (0.12 + 0.5 * head + 0.28 * key + 0.15 * hemi);
  }
  vec3 prev = texelFetch(uPrev, px, 0).rgb;
  outColor = vec4(uFrame == 0 ? col : mix(prev, col, 1.0 / float(uFrame + 1)), 1.0);
}`;
