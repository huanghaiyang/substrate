// Shared GLSL chunks for the node compiler.
// All processing happens in linear light, textures are RGBA16F render targets.

export const VERTEX_SRC = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const COMMON_GLSL = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586
uniform vec2 uRes;
uniform vec2 uPx;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }

float hash1(vec2 p, float seed) {
  p = mod(p, 4096.0);
  return fract(sin(dot(p, vec2(127.1, 311.7)) + seed * 71.13) * 43758.5453123);
}
vec2 hash2(vec2 p, float seed) {
  p = mod(p, 4096.0);
  float n = sin(dot(p, vec2(127.1, 311.7)) + seed * 71.13);
  float m = sin(dot(p, vec2(269.5, 183.3)) + seed * 31.71);
  return fract(vec2(n, m) * 43758.5453123);
}
vec3 hash3(vec2 p, float seed) {
  p = mod(p, 4096.0);
  float a = sin(dot(p, vec2(127.1, 311.7)) + seed * 71.13);
  float b = sin(dot(p, vec2(269.5, 183.3)) + seed * 31.71);
  float c = sin(dot(p, vec2(419.2, 371.9)) + seed * 13.37);
  return fract(vec3(a, b, c) * 43758.5453123);
}

vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgbToLinear(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// ---- tileable gradient noise -------------------------------------------------
float gnoise(vec2 p, vec2 period, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash2(mod(i, period), seed) * 2.0 - 1.0;
  vec2 g10 = hash2(mod(i + vec2(1.0, 0.0), period), seed) * 2.0 - 1.0;
  vec2 g01 = hash2(mod(i + vec2(0.0, 1.0), period), seed) * 2.0 - 1.0;
  vec2 g11 = hash2(mod(i + vec2(1.0, 1.0), period), seed) * 2.0 - 1.0;
  float v00 = dot(g00, f);
  float v10 = dot(g10, f - vec2(1.0, 0.0));
  float v01 = dot(g01, f - vec2(0.0, 1.0));
  float v11 = dot(g11, f - vec2(1.0, 1.0));
  return mix(mix(v00, v10, u.x), mix(v01, v11, u.x), u.y);
}

float fbmTiled(vec2 uv, float baseFreq, int octaves, float persistence, float lacunarity, float seed) {
  float freq = max(1.0, floor(baseFreq + 0.5));
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 10; o++) {
    if (o >= octaves) break;
    sum += amp * gnoise(uv * freq, vec2(freq), seed + float(o) * 17.0);
    norm += amp;
    amp *= persistence;
    freq = max(1.0, floor(freq * lacunarity + 0.5));
  }
  return clamp(sum / max(norm, 1e-5) * 0.78 + 0.5, 0.0, 1.0);
}

// Per-octave folded fBm ("billow"/ridged family). Folding |noise| at *every* octave keeps granular
// detail alive at all scales, instead of producing smooth clouds that only carry one dominant
// frequency — this is the primitive organic granular surfaces (moss, lichen, bark, rock) are made of.
// The result is re-shaped so that, like fbmTiled, it is centred on 0.5 and safe to feed into any
// blend mode (raw |fBm| has a mean near 0.15, which would quietly darken every Overlay it touches).
// Tileability is inherited from gnoise (periodic hash), so billow output stays seamless.
float fbmBillowTiled(vec2 uv, float baseFreq, int octaves, float persistence, float lacunarity, float seed) {
  float freq = max(1.0, floor(baseFreq + 0.5));
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 10; o++) {
    if (o >= octaves) break;
    float g = gnoise(uv * freq, vec2(freq), seed + float(o) * 17.0);
    sum += amp * abs(g);
    norm += amp;
    amp *= persistence;
    freq = max(1.0, floor(freq * lacunarity + 0.5));
  }
  float b = clamp(sum / max(norm, 1e-5) * 2.0, 0.0, 1.0);
  return clamp(pow(b, 0.55), 0.0, 1.0);
}

// returns (F1, F2) in cell units, tileable
vec2 worleyTiled(vec2 uv, float cells, float jitter, float seed) {
  float freq = max(1.0, floor(cells + 0.5));
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash2(mod(i + g, vec2(freq)), seed);
      vec2 r = g + 0.5 + (o - 0.5) * jitter - f;
      float d = length(r);
      if (d < f1) { f2 = f1; f1 = d; }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2);
}

// nearest cell id (for per-cell randomization)
vec2 worleyCell(vec2 uv, float cells, float jitter, float seed) {
  float freq = max(1.0, floor(cells + 0.5));
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  vec2 id = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash2(mod(i + g, vec2(freq)), seed);
      vec2 r = g + 0.5 + (o - 0.5) * jitter - f;
      float d = length(r);
      if (d < f1) { f1 = d; id = mod(i + g, vec2(freq)); }
    }
  }
  return id;
}

// ---- blend modes -------------------------------------------------------------
vec3 blendMode(int m, vec3 a, vec3 b) {
  if (m == 0) return b;
  if (m == 1) return a + b;
  if (m == 2) return a - b;
  if (m == 3) return b - a;
  if (m == 4) return a * b;
  if (m == 5) return 1.0 - (1.0 - a) * (1.0 - b);
  if (m == 6) return min(a, b);
  if (m == 7) return max(a, b);
  if (m == 8) return abs(a - b);
  if (m == 9) return a / max(b, vec3(1e-4));
  if (m == 10) return 2.0 * a * b;
  if (m == 11) {
    vec3 lo = 2.0 * a * b;
    vec3 hi = 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
    return mix(lo, hi, step(0.5, a));
  }
  if (m == 12) { // overlay
    vec3 lo = 2.0 * a * b;
    vec3 hi = 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
    return mix(lo, hi, step(0.5, b));
  }
  if (m == 13) { // soft light
    vec3 lo = a - (1.0 - 2.0 * b) * a * (1.0 - a);
    return mix(lo, 1.0 - (1.0 - a) * (1.0 - b), step(0.5, b));
  }
  if (m == 14) return a + b - 2.0 * a * b; // linear light-ish / exclusion
  return b;
}
`

// Smooth minimum (polynomial)
export const SMOOTH_MIN_GLSL = /* glsl */ `
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-4), 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
`

// Regular polygon / star SDF helpers used by the shape node
export const SHAPE_GLSL = /* glsl */ `
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
float sdPolygon(vec2 p, float radius, float sides, float rotation) {
  float a = atan(p.y, p.x) + rotation;
  float seg = TAU / max(sides, 3.0);
  float aa = mod(a + seg * 0.5, seg) - seg * 0.5;
  float rr = radius * cos(seg * 0.5) / max(cos(aa), 1e-3);
  return length(p) - rr;
}
float sdStar(vec2 p, float radius, float sides, float inner, float sharpness, float rotation) {
  float a = atan(p.y, p.x) + rotation;
  float seg = TAU / max(sides, 3.0);
  float ang = mod(a + seg * 0.5, seg) - seg * 0.5;
  float rr = radius * (inner + (1.0 - inner) * pow(abs(cos(ang * sides * 0.5)), max(sharpness, 0.1)));
  return length(p) - rr;
}
`

// Shaded material-ball preview used for the output node thumbnail / map previews.
export const PREVIEW_GLSL = /* glsl */ `
uniform sampler2D uBaseColor;
uniform sampler2D uNormal;
uniform sampler2D uRoughness;
uniform sampler2D uMetallic;
uniform sampler2D uAO;
uniform sampler2D uHeight;
uniform sampler2D uEmissive;
uniform float uFlipY;

vec3 shadePreview(vec2 uv, vec2 p, float radius) {
  vec3 base = texture(uBaseColor, uv).rgb;
  vec4 nrm = texture(uNormal, uv);
  vec3 n = normalize(nrm.xyz * 2.0 - 1.0);
  if (uFlipY > 0.5) n.y = -n.y;
  float rough = texture(uRoughness, uv).g;
  float metal = texture(uMetallic, uv).b;
  float ao = texture(uAO, uv).r;
  vec3 emis = texture(uEmissive, uv).rgb;

  // derive a sphere normal from the thumbnail UV so the ball reads as a material
  vec3 sph = vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))));
  vec3 tangentX = normalize(vec3(1.0, 0.0, 0.0));
  vec3 tangentY = normalize(vec3(0.0, 1.0, 0.0));
  vec3 worldN = normalize(sph + tangentX * (n.x * 0.55) + tangentY * (n.y * 0.55));

  vec3 L1 = normalize(vec3(-0.55, 0.75, 0.9));
  vec3 L2 = normalize(vec3(0.85, -0.35, 0.45));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 albedo = base * (1.0 - metal);
  vec3 f0 = mix(vec3(0.04), base, metal);
  float ndl1 = max(dot(worldN, L1), 0.0);
  float ndl2 = max(dot(worldN, L2), 0.0);
  float specPow = mix(120.0, 6.0, clamp(rough, 0.0, 1.0));
  float sp1 = pow(max(dot(reflect(-L1, worldN), V), 0.0), specPow) * (1.0 - rough * 0.75);
  float sp2 = pow(max(dot(reflect(-L2, worldN), V), 0.0), specPow) * (1.0 - rough * 0.75);
  // cheap analytic environment
  float fres = pow(1.0 - max(dot(worldN, V), 0.0), 4.0);
  vec3 env = mix(vec3(0.05, 0.06, 0.075), vec3(0.55, 0.62, 0.72), sat(worldN.y * 0.5 + 0.5));
  env = mix(env, vec3(0.16, 0.13, 0.11), sat(-worldN.y * 0.5 + 0.5));
  vec3 col = albedo * (ndl1 * 1.15 + ndl2 * 0.35 + env * 0.55) * ao;
  col += f0 * (sp1 * 2.2 + sp2 * 0.7) * mix(0.35, 1.0, 1.0 - rough);
  col += f0 * env * fres * (1.0 - rough) * 1.4;
  col = mix(col, base, metal * 0.25);
  col += emis;
  return linearToSRGB(max(col, vec3(0.0)));
}
`
