/**
 * 节点编译器共享的 GLSL 代码块。
 *
 * 整体约定：所有处理都在线性光空间完成，中间纹理为 RGBA16F；
 * 只有导出颜色贴图或显示时才转换成 sRGB。
 *
 * 导出内容：
 * - VERTEX_SRC   —— 全屏 quad 的顶点着色器；
 * - COMMON_GLSL  —— 所有节点共用的工具函数（噪声、哈希、混合模式、色彩空间转换）；
 * - SMOOTH_MIN_GLSL / SHAPE_GLSL —— 特定节点类别使用的小型工具库；
 * - PREVIEW_GLSL —— 材质球预览着色函数。
 *
 * 注意：着色器字符串内部只允许 ASCII 英文注释，中文说明写在这段字符串之外。
 */

/**
 * 全屏四边形顶点着色器。
 * 顶点位置直接写入裁剪空间（xy 已是 -1..1），因此不需要任何矩阵 uniform；
 * 同时把 uv 原样传给片元着色器。
 */
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

/**
 * 所有节点共用的 GLSL 工具库，内容依次为：
 * - 常量 PI/TAU 与引擎传入的 uRes（分辨率）、uPx（单像素步长）；
 * - sat / sat3：把值截断到 0..1；
 * - hash1/hash2/hash3：基于正弦的确定性哈希，把二维坐标映射为随机数（相同输入永远得到相同结果）；
 * - rot2：二维旋转；
 * - luma：Rec.709 亮度权重；
 * - linearToSRGB / srgbToLinear：精确的分段幂函数色彩空间转换；
 * - gnoise / fbmTiled / fbmBillowTiled / worleyTiled / worleyCell：可平铺噪声族；
 * - blendMode：与 UI 下拉选项序号一一对应的混合模式实现。
 *
 * 所有噪声都以「周期哈希」实现，因此输出天然无缝，可平铺贴图不会出现接缝。
 */
export const COMMON_GLSL = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586
uniform vec2 uRes;
uniform vec2 uPx;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }

// Deterministic sin-based hashes: same input always yields the same value on the same driver.
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

// Standard 2D rotation (a in radians).
vec2 rot2(vec2 p, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Rec.709 luminance weights.
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
// Tileable gradient noise: periodic lattice hash + quintic interpolation.
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

// Plain tileable fBm: octaves are summed and normalized back to 0..1.
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
// frequency - this is the primitive organic granular surfaces (moss, lichen, bark, rock) are made of.
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
// Mode index must match the "mode" option list of the blend node definition.
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

/**
 * 多项式平滑最小值（smooth min）：k 越大过渡越柔和。
 * 供「合并形状 / 距离场」类节点使用，避免 min() 产生硬边。
 */
export const SMOOTH_MIN_GLSL = /* glsl */ `
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-4), 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
`

// Regular polygon / star SDF helpers used by the shape node
/**
 * 形状节点使用的二维有符号距离场（SDF）工具：
 * - sdRoundBox：圆角矩形；
 * - sdPolygon：正多边形；
 * - sdStar：星形（inner 控制内半径，sharpness 控制锐度）。
 * 返回值为「点到边界的最短距离」，负值表示在形状内部。
 */
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

/**
 * 「材质球」预览着色函数：把 7 张 PBR 贴图合成为一个带两个方向光 + 简易环境光的球体，
 * 用于输出节点的缩略图和各通道预览。
 *
 * 关键做法：
 * - 由缩略图 UV 推导球面法线，并把贴图法线以 0.55 的强度叠加，使凹凸可见但不夸张；
 * - 金属度决定漫反射衰减与 F0（菲涅尔反射率）；
 * - 粗糙度同时控制高光指数与高光强度；
 * - 最后统一做 linearToSRGB，输出可直接显示的颜色。
 */
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
