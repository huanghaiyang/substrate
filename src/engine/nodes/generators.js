/**
 * 生成器节点定义：噪声、图案、形状、渐变，以及常量 / 图片 / 绘画等无输入源节点。
 *
 * 每个节点定义的结构：
 *  - type：节点类型 id；
 *  - name / category / desc：显示名、分类与说明（desc 会经 i18n 查找翻译）；
 *  - space：'data'（线性数据流）或 'color'（sRGB 颜色流），决定引擎读写纹理时的编码；
 *  - inputs：输入端口（生成器一般没有输入）；
 *  - params：参数描述，min / max / step / def 同时驱动检查器 UI 与求值引擎；
 *  - body / prelude：GLSL 片段，nodeColor(uv) 返回该像素的颜色；
 *  - imageInput / paintInput：标记需要额外绑定图片纹理 / 绘画画布的特殊节点。
 *
 * 注意：GLSL 源码内部的注释保持英文（着色器工具链兼容），节点定义的 JS 侧
 * 用中文说明参数含义、取值范围与算法来源。
 */
import { SHAPE_GLSL } from '../glsl.js'

/**
 * 可平铺标量值噪声格（线性插值），供频谱噪声节点（白/粉/棕/蓝/紫）共用。
 * 与 Perlin 的梯度噪声不同，这里插值的是格点上的随机标量，频谱更容易按倍频权重塑形。
 */
const COLOR_LATTICE_GLSL = /* glsl */ `
float cnFade(float t) { return t * t * (3.0 - 2.0 * t); }
float cnValue(vec2 uv, float freq, float seed) {
  vec2 p = uv * freq;
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = vec2(cnFade(f.x), cnFade(f.y));
  float a = hash1(mod(i, vec2(freq)), seed);
  float b = hash1(mod(i + vec2(1.0, 0.0), vec2(freq)), seed);
  float c = hash1(mod(i + vec2(0.0, 1.0), vec2(freq)), seed);
  float d = hash1(mod(i + vec2(1.0, 1.0), vec2(freq)), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}`

export const generatorDefs = [
  /**
   * Perlin 分形噪声（fBm）。
   *
   * 算法：以 gradient noise 为基础，叠加 octaves 层，每层频率乘 lacunarity、
   * 振幅乘 persistence；坐标按整数周期取模，因此可在 UV 0~1 边界无缝平铺。
   *
   * 参数：
   *  - scale：基础频率（1~96），越大纹理越细碎；
   *  - octaves：叠加层数（1~8），越多细节越丰富但开销越高；
   *  - persistence：每层振幅衰减系数（0.15~0.9），越大高频越强；
   *  - lacunarity：每层频率倍增系数（1.2~3）；
   *  - contrast：以 0.5 为中心的对比度（0.1~4）；
   *  - billow：取每层噪声绝对值，形成「翻涌」的云絮感；
   *  - seed：随机种子，用于偏移采样坐标。
   */
  {
    type: 'perlin',
    name: 'Perlin Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable fractal gradient noise. The workhorse of every material.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'billow', label: 'Billow', type: 'bool', def: false },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        // Billow folds |noise| at every octave (see fbmBillowTiled) instead of post-folding the
        // finished fBm, so the granular detail survives at all scales.
        float n = u_billow
          ? fbmBillowTiled(uv, max(1.0, u_scale), u_octaves, u_persistence, u_lacunarity, u_seed)
          : fbmTiled(uv, max(1.0, u_scale), u_octaves, u_persistence, u_lacunarity, u_seed);
        n = sat((n - 0.5) * max(u_contrast, 0.01) + 0.5);
        return vec4(vec3(n), 1.0);
      }`
  },
  /**
   * 细胞 / Voronoi（Worley）噪声。
   *
   * 算法：把 UV 按 cells 划分网格，每个格子放一个随机偏移的「特征点」；对每个像素
   * 在 3×3 邻域内记录最近四个特征点的距离（F1~F4）。平铺通过 9 次周期平移实现。
   *
   * 参数：
   *  - cells：网格数量（2~64），越大细胞越小；
   *  - jitter：特征点在格内的随机偏移幅度（0~1）；
   *  - mode：F1 / F2 / F2-F1 边界 / 反相 F1，以及 F3、F4、Crackle（薄而亮的裂纹壁）；
   *  - invert：结果取反；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'cellular',
    name: 'Cellular Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable Worley / Voronoi noise with F1–F4, border and crackle modes.',
    inputs: [],
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 2, max: 64, step: 1, def: 8 },
      { key: 'jitter', label: 'Jitter', type: 'float', min: 0, max: 1, step: 0.01, def: 0.9 },
      { key: 'mode', label: 'Mode', type: 'select', options: ['F1 (cells)', 'F2', 'Borders (F2-F1)', 'Inverted F1', 'F3', 'F4', 'Crackle'], def: 0 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 3 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 d = worleyTiled4(uv, u_cells, u_jitter, u_seed);
        float v;
        if (u_mode == 0) v = sat(d.x * 1.7);
        else if (u_mode == 1) v = sat(d.y * 1.6);
        else if (u_mode == 2) v = sat((d.y - d.x) * 3.2);
        else if (u_mode == 3) v = 1.0 - sat(d.x * 1.7);
        else if (u_mode == 4) v = sat(d.z * 0.75);
        else if (u_mode == 5) v = sat(d.w * 0.62);
        else v = sat(1.0 - abs(d.y - d.x) * 6.0); // crackle: bright thin walls on the F2-F1 border
        if (u_invert) v = 1.0 - v;
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 值噪声（Value Noise）。
   *
   * 算法：在每个网格顶点放一个随机标量，按插值核在格内混合。
   *  - Linear：双线性 + smoothstep 权重，最快，但一阶导数在格线处不连续，
   *    低频时会出现轻微的「枕状」感；
   *  - Cubic：Catmull-Rom 三次核（4×4 采样），波峰波谷更饱满，适合高度图 / 凹凸，
   *    能明显压掉线性插值的块状伪影。
   * 与 Perlin 的区别：Perlin 插值的是梯度投影值，值噪声插值的是标量本身，因此
   * 值噪声更「团块化」，Perlin 更「起伏流动」。
   *
   * 周期性：顶点哈希按整数周期取模，所有倍频同样取整，因此 UV 0~1 无缝。
   *
   * 参数：
   *  - scale：基础频率（1~96）；
   *  - octaves：叠加层数（1~8）；
   *  - persistence / lacunarity：振幅衰减与频率倍增；
   *  - interpolation：Linear 线性 / Cubic 三次；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'value_noise',
    name: 'Value Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable scalar lattice noise. Linear for speed, Cubic for smooth height / bump maps.',
    inputs: [],
    prelude: /* glsl */ `
      float vnFade(float t) { return t * t * (3.0 - 2.0 * t); }
      // Uniform cubic B-spline weights. Unlike Catmull-Rom they are all positive, so the
      // interpolated field never overshoots / rings around lattice vertices (which would
      // show up as a cross-hatch grid on low-frequency height maps).
      vec4 vnCubicWeights(float t) {
        float t2 = t * t;
        float t3 = t2 * t;
        return vec4(
          (1.0 - 3.0 * t + 3.0 * t2 - t3) / 6.0,
          (4.0 - 6.0 * t2 + 3.0 * t3) / 6.0,
          (1.0 + 3.0 * t + 3.0 * t2 - 3.0 * t3) / 6.0,
          t3 / 6.0
        );
      }
      float vnValueLinear(vec2 uv, float freq, float seed) {
        vec2 p = uv * freq;
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = vec2(vnFade(f.x), vnFade(f.y));
        vec2 period = vec2(freq);
        float a = hash1(mod(i, period), seed);
        float b = hash1(mod(i + vec2(1.0, 0.0), period), seed);
        float c = hash1(mod(i + vec2(0.0, 1.0), period), seed);
        float d = hash1(mod(i + vec2(1.0, 1.0), period), seed);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      float vnValueCubic(vec2 uv, float freq, float seed) {
        vec2 p = uv * freq;
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec4 wx = vnCubicWeights(f.x);
        vec4 wy = vnCubicWeights(f.y);
        vec2 period = vec2(freq);
        float sum = 0.0;
        for (int y = -1; y <= 2; y++) {
          for (int x = -1; x <= 2; x++) {
            float h = hash1(mod(i + vec2(float(x), float(y)), period), seed);
            sum += h * wx[x + 1] * wy[y + 1];
          }
        }
        return sum;
      }`,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          float n = u_interpolation == 0
            ? vnValueLinear(uv, freq, u_seed + float(o) * 17.0)
            : vnValueCubic(uv, freq, u_seed + float(o) * 17.0);
          sum += amp * (n - 0.5);
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        // Value noise only spans part of 0..1; the B-spline smooths it further, so it needs more gain.
        float gain = u_interpolation == 0 ? 1.0 : 1.35;
        float v = sat(sum / max(norm, 1e-5) * gain + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 1 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'interpolation', label: 'Interpolation', type: 'select', options: ['Linear', 'Cubic'], def: 0 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 5 }
    ]
  },
  /**
   * 单纯形风格噪声（Simplex Noise）。
   *
   * 说明：标准 Simplex 的三角点阵无法在方形 UV 上做轴向平铺（三角格的两个周期向量
   * 无法同时对齐 x / y 轴），因此这里用「方形格 + 对角线切分三角形」的等价做法：
   * 每个格子按 x+y=1 分成两个三角形，取三角形三个顶点的随机梯度，用紧支撑径向核
   * 加权求和。与经典 Simplex 一样避免了 Perlin 的方向性伪影，同时严格可平铺。
   * 径向核在半对角线处归零，所以跨三角形边界连续，不会出现明显的对角接缝。
   *
   * 参数：
   *  - scale：基础频率（1~96）；
   *  - octaves：叠加层数（1~8）；
   *  - persistence / lacunarity：振幅衰减与频率倍增；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'simplex',
    name: 'Simplex Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable simplex-style gradient noise on a split-triangle lattice.',
    inputs: [],
    prelude: /* glsl */ `
      vec2 sxGrad(vec2 cell, vec2 period, float seed) {
        float a = hash1(mod(cell, period), seed) * TAU;
        return vec2(cos(a), sin(a));
      }
      // Compact radial kernel: zero on the cell half-diagonal, so the fourth (excluded)
      // corner contributes nothing exactly on the split line.
      float sxKernel(vec2 d) {
        float t = max(0.0, 0.5 - dot(d, d));
        return t * t * t;
      }
      float sxSimplex(vec2 uv, float freq, float seed) {
        vec2 p = uv * freq;
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 period = vec2(freq);
        vec2 c0, c1, c2;
        if (f.x + f.y <= 1.0) {
          c0 = vec2(0.0); c1 = vec2(1.0, 0.0); c2 = vec2(0.0, 1.0);
        } else {
          c0 = vec2(1.0); c1 = vec2(0.0, 1.0); c2 = vec2(1.0, 0.0);
        }
        float n = 0.0, ws = 0.0;
        for (int k = 0; k < 3; k++) {
          vec2 c = k == 0 ? c0 : (k == 1 ? c1 : c2);
          vec2 d = f - c;
          float w = sxKernel(d);
          n += w * dot(sxGrad(i + c, period, seed), d);
          ws += w;
        }
        return n / max(ws, 1e-4);
      }`,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * sxSimplex(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        float v = sat(sum / max(norm, 1e-5) * 1.15 + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 9 }
    ]
  },
  /**
   * 素数梯度噪声（Prime Gradient Noise）。
   *
   * 算法：与 Perlin 相同的格点梯度插值，但梯度方向不直接取随机向量，而是用
   * 黄金角（≈137.5°）步进生成：角度 = fract(hash × 137.50776 + seed × 0.618) × 2π。
   * 黄金角保证相邻格子的梯度方向尽量分散，不会出现经典梯度表里偶发的同向聚簇，
   * 因此方向性伪影更弱。该做法对应 2021 年前后提出的 prime / golden-ratio
   * 梯度表噪声思路，不依赖真正的素数运算，便于在 GPU 上稳定复现。
   *
   * 参数：
   *  - scale：基础频率（1~96）；
   *  - octaves：叠加层数（1~8）；
   *  - persistence / lacunarity：振幅衰减与频率倍增；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'prime_gradient',
    name: 'Prime Gradient Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Perlin-style lattice noise with a golden-angle (prime) gradient table and less directional bias.',
    inputs: [],
    prelude: /* glsl */ `
      vec2 pnGrad(vec2 cell, vec2 period, float seed) {
        float h = hash1(mod(cell, period), seed);
        float a = fract(h * 137.50776405 + seed * 0.61803398875) * TAU;
        return vec2(cos(a), sin(a));
      }
      float pnNoise(vec2 uv, float freq, float seed) {
        vec2 p = uv * freq;
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        vec2 period = vec2(freq);
        vec2 g00 = pnGrad(i, period, seed);
        vec2 g10 = pnGrad(i + vec2(1.0, 0.0), period, seed);
        vec2 g01 = pnGrad(i + vec2(0.0, 1.0), period, seed);
        vec2 g11 = pnGrad(i + vec2(1.0, 1.0), period, seed);
        float v00 = dot(g00, f);
        float v10 = dot(g10, f - vec2(1.0, 0.0));
        float v01 = dot(g01, f - vec2(0.0, 1.0));
        float v11 = dot(g11, f - vec2(1.0, 1.0));
        return mix(mix(v00, v10, u.x), mix(v01, v11, u.x), u.y);
      }`,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * pnNoise(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        float v = sat(sum / max(norm, 1e-5) * 1.15 + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 13 }
    ]
  },
  /**
   * 湍流噪声（Turbulence）。
   *
   * 算法：每个倍频取 |梯度噪声| 后再叠加，把负半周也翻成正值，于是所有细节都变成
   * 「尖峰向下、谷底尖锐」的形态，边缘更硬、对比更强，适合火焰、烟雾、腐蚀。
   * 每个倍频频率取整并走周期哈希，因此 UV 0~1 无缝。
   *
   * 参数：
   *  - scale：基础频率（1~96）；
   *  - octaves：叠加层数（1~8）；
   *  - persistence / lacunarity：振幅衰减与频率倍增；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'turbulence',
    name: 'Turbulence Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Fractal sum of absolute gradient noise: sharp, high-contrast wisps for fire, smoke and erosion.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          float g = gnoise(uv * freq, vec2(freq), u_seed + float(o) * 17.0);
          sum += amp * abs(g);
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        float v = sat(sum / max(norm, 1e-5) * 3.3);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 5 }
    ]
  },
  /**
   * 脊状噪声（Ridged Noise）。
   *
   * 算法：每层先做 1 - |n| 的「脊化」变换，再平方强调脊线，最后按 fBm 方式叠加。
   * 结果是尖锐的山脊 / 裂纹 / 岩壁状结构，是山脉、岩石、破损表面的常用基底。
   *
   * 参数：scale / octaves / persistence / lacunarity / contrast / seed，含义同湍流噪声。
   */
  {
    type: 'ridged',
    name: 'Ridged Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Fractal ridged noise: creased mountain ridges and cracked rock surfaces.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          float g = gnoise(uv * freq, vec2(freq), u_seed + float(o) * 17.0);
          float r = 1.0 - abs(g);
          r *= r;
          sum += amp * r;
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        float v = sat(sum / max(norm, 1e-5) * 0.9);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 7 }
    ]
  },
  /**
   * Musgrave 分形族。
   *
   * 同一套参数下的五种经典地形分形（F. Kenton Musgrave 1994）：
   *  - Multifractal：每层振幅由当前噪声值调制，细节分布不均匀，适合粗糙地形；
   *  - Ridged Multifractal：在脊化基础上用上一层的脊高控制下一层的权重；
   *  - Hybrid Multifractal：首个倍频作为基底，后续层按权重叠加，控制力最强；
   *  - Hetero Terrain：给每层加偏移并随高度衰减权重，专为地形起伏设计；
   *  - fBm：标准分形布朗运动。
   * 所有层频率取整并走周期哈希，UV 0~1 无缝。
   *
   * 参数：
   *  - type：上列五种分形类型；
   *  - scale / octaves / persistence / lacunarity：基础分形参数；
   *  - gain：脊线 / 混合倍频的反馈强度（0.2~2）；
   *  - offset：高度偏移 / 混合偏置（-0.5~0.5）；
   *  - contrast：输出对比度；
   *  - seed：随机种子。
   */
  {
    type: 'musgrave',
    name: 'Musgrave Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Musgrave terrain fractal family: multifractal, ridged, hybrid, hetero terrain and fBm.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float v = 0.5;
        if (u_type == 4) {
          // classic fBm
          float sum = 0.0, amp = 1.0, norm = 0.0, f = freq;
          for (int o = 0; o < 8; o++) {
            if (o >= u_octaves) break;
            sum += amp * gnoise(uv * f, vec2(f), u_seed + float(o) * 17.0);
            norm += amp;
            amp *= u_persistence;
            f = max(1.0, floor(f * u_lacunarity + 0.5));
          }
          v = sat(sum / max(norm, 1e-5) * 0.78 + 0.5);
        } else if (u_type == 0) {
          // multifractal: detail amplitude follows the local value, while the
          // normalisation stays on the plain fBm weights so bright areas keep
          // extra detail instead of cancelling out.
          float sum = 0.0, amp = 1.0, norm = 0.0, f = freq;
          for (int o = 0; o < 8; o++) {
            if (o >= u_octaves) break;
            float n = gnoise(uv * f, vec2(f), u_seed + float(o) * 17.0) * 0.5 + 0.5;
            sum += amp * n * (0.35 + n * 1.3);
            norm += amp;
            amp *= u_persistence;
            f = max(1.0, floor(f * u_lacunarity + 0.5));
          }
          v = sum / max(norm, 1e-5);
        } else if (u_type == 1) {
          // ridged multifractal: the previous ridge height weights the next octave
          float sum = 0.0, amp = 0.5, norm = 0.0, f = freq, weight = 1.0;
          for (int o = 0; o < 8; o++) {
            if (o >= u_octaves) break;
            float n = 1.0 - abs(gnoise(uv * f, vec2(f), u_seed + float(o) * 17.0));
            n *= n;
            n *= weight;
            weight = sat(n * 2.0 * u_gain);
            sum += amp * n;
            norm += amp;
            amp *= u_persistence;
            f = max(1.0, floor(f * u_lacunarity + 0.5));
          }
          v = sum / max(norm, 1e-5);
        } else if (u_type == 2) {
          // hybrid multifractal
          float f = freq;
          float n0 = gnoise(uv * f, vec2(f), u_seed) * 0.5 + 0.5;
          float sum = n0, norm = 1.0, amp = 1.0, weight = sat(n0 * 2.0);
          f = max(1.0, floor(f * u_lacunarity + 0.5));
          for (int o = 1; o < 8; o++) {
            if (o >= u_octaves) break;
            float d = gnoise(uv * f, vec2(f), u_seed + float(o) * 17.0) * 0.5 + 0.5;
            float sig = d * weight;
            sum += sig * amp * 0.6;
            norm += amp * 0.6;
            weight = sat(sig * 2.0 * u_gain + u_offset);
            amp *= u_persistence;
            f = max(1.0, floor(f * u_lacunarity + 0.5));
          }
          v = sat(sum / max(norm, 1e-5) * 1.15);
        } else {
          // hetero terrain: per-octave offset with height-driven weight decay
          float sum = 0.0, amp = 1.0, norm = 0.0, f = freq, weight = 1.0;
          for (int o = 0; o < 8; o++) {
            if (o >= u_octaves) break;
            float n = gnoise(uv * f, vec2(f), u_seed + float(o) * 17.0) * 0.5 + 0.5;
            n = sat(n + u_offset);
            float sig = n * weight;
            sum += sig * amp;
            norm += amp;
            weight = sat(n * u_gain);
            amp *= u_persistence;
            f = max(1.0, floor(f * u_lacunarity + 0.5));
          }
          v = sat(sum / max(norm, 1e-5) * 1.5);
        }
        v = sat((sat(v) - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'type', label: 'Type', type: 'select', options: ['Multifractal', 'Ridged Multifractal', 'Hybrid Multifractal', 'Hetero Terrain', 'fBm'], def: 0 },
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'gain', label: 'Gain', type: 'float', min: 0.2, max: 2, step: 0.01, def: 1 },
      { key: 'offset', label: 'Offset', type: 'float', min: -0.5, max: 0.5, step: 0.01, def: 0 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 11 }
    ]
  },
  /**
   * 乒乓分形（Ping-Pong Fractal）。
   *
   * 算法：每个倍频对 0~1 的噪声值做三角波折叠（0→1 再折回 0），再按 fBm 叠加。
   * 折叠让中间层次大量增加，得到比普通 fBm 更丰富的明暗变化和「揉皱」结构。
   *
   * 参数：scale / octaves / persistence / lacunarity / contrast / seed。
   */
  {
    type: 'ping_pong',
    name: 'Ping-Pong Fractal',
    category: 'Noise',
    space: 'data',
    desc: 'Fractal with triangle-wave folding per octave: dense mid-tones and crumpled structure.',
    inputs: [],
    prelude: /* glsl */ `
      // Triangle-wave fold over one unit: 0 -> 1 -> 0, used by the ping-pong fractal.
      float pingPong(float x) {
        float n = fract(x);
        return n < 0.5 ? n * 2.0 : 2.0 - n * 2.0;
      }`,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          float g = gnoise(uv * freq, vec2(freq), u_seed + float(o) * 17.0) * 0.5 + 0.5;
          // The +0.25 phase shift keeps typical fBm values (crowded around 0.5)
          // in the middle of the fold instead of mapping them onto the dark crease.
          sum += amp * pingPong(g + 0.25);
          norm += amp;
          amp *= u_persistence;
          freq = max(1.0, floor(freq * u_lacunarity + 0.5));
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 19 }
    ]
  },
  /**
   * 扭曲噪声（Distorted Noise）。
   *
   * 算法：先用两路独立的 fBm 生成二维位移场，把采样坐标推移后再采样基础 fBm，
   * 形成被「揉皱 / 搅拌」的纹理。位移场与基础噪声都按整数周期平铺，因此结果无缝。
   *
   * 参数：
   *  - scale：基础频率；
   *  - octaves / persistence / lacunarity：基础分形参数；
   *  - warp scale：位移场频率（1~32），越大皱褶越细；
   *  - amount：位移强度（0~1），0 时退化为普通 fBm；
   *  - contrast：输出对比度；
   *  - seed：随机种子。
   */
  {
    type: 'distorted',
    name: 'Distorted Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Domain-warped fBm: two noise fields displace the sampling coordinates for a crumpled look.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float wf = max(1.0, floor(u_warp_scale + 0.5));
        vec2 o1 = vec2(0.37, 0.11);
        vec2 o2 = vec2(0.73, 0.52);
        float wx = fbmTiled(uv + o1, wf, u_octaves, u_persistence, u_lacunarity, u_seed + 31.0);
        float wy = fbmTiled(uv + o2, wf, u_octaves, u_persistence, u_lacunarity, u_seed + 47.0);
        vec2 warp = (vec2(wx, wy) - 0.5) * 2.0 * u_amount * 0.5;
        float n = fbmTiled(uv + warp, freq, u_octaves, u_persistence, u_lacunarity, u_seed);
        float v = sat((n - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 96, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'warp_scale', label: 'Warp Scale', type: 'float', min: 1, max: 32, step: 1, def: 4 },
      { key: 'amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, def: 0.3 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 23 }
    ]
  },
  /**
   * 白噪声（White Noise）。
   *
   * 算法：把 UV 划分成 scale×scale 的格子，每个格子取一个独立随机值，不做任何插值，
   * 因此相邻像素完全不相关，功率谱平坦。格点哈希按整数周期取模，UV 0~1 无缝。
   *
   * 参数：
   *  - scale：每边的格子数（8~1024），越大颗粒越细；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'white_noise',
    name: 'White Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Per-pixel random noise: uncorrelated grain for fine speckle, masks and dithering.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float size = max(1.0, floor(u_scale + 0.5));
        vec2 c = mod(floor(uv * size), vec2(size));
        float v = hash1(c, u_seed);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 8, max: 1024, step: 1, def: 256 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 29 }
    ]
  },
  /**
   * 粉噪声 / 1/f 噪声（Pink Noise）。
   *
   * 算法：在标量值噪声格上叠加 octaves 层，每层频率翻倍、振幅乘 1/√2，
   * 使每个倍频携带的能量相等（约 -3 dB/oct），得到 1/f 功率谱。
   * 这是模拟地形、云、水流等自然纹理的频谱基础。
   *
   * 参数：scale（基准频率）/ octaves / contrast / seed。
   */
  {
    type: 'pink_noise',
    name: 'Pink Noise',
    category: 'Noise',
    space: 'data',
    desc: '1/f spectrum: equal energy per octave, the natural base for terrain, clouds and water.',
    inputs: [],
    prelude: COLOR_LATTICE_GLSL,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * cnValue(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= 0.70710678;
          freq *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 4 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 31 }
    ]
  },
  /**
   * 布朗噪声 / 红噪声（Brown Noise）。
   *
   * 算法：同粉噪声，但每层振幅乘 0.5，得到 1/f² 功率谱：低频能量更强、
   * 变化平缓「粘滞」，适合大尺度柔和起伏与长波地形。
   *
   * 参数：scale / octaves / contrast / seed。
   */
  {
    type: 'brown_noise',
    name: 'Brown Noise',
    category: 'Noise',
    space: 'data',
    desc: '1/f² spectrum: soft low-frequency drift for large-scale undulation and rolling terrain.',
    inputs: [],
    prelude: COLOR_LATTICE_GLSL,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * cnValue(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= 0.5;
          freq *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 4 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 37 }
    ]
  },
  /**
   * 蓝噪声（Blue Noise）。
   *
   * 算法：每层振幅乘 √2（约 +3 dB/oct），能量向高频倾斜，低频聚集被压制。
   * 空间分布均匀、没有大块团簇，适合抖动（dithering）、抗带状伪影和均匀采样图案。
   *
   * 参数：scale / octaves / contrast / seed。
   */
  {
    type: 'blue_noise',
    name: 'Blue Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Rising spectrum (+3 dB/oct): evenly distributed detail with suppressed low frequencies.',
    inputs: [],
    prelude: COLOR_LATTICE_GLSL,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * cnValue(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= 1.41421356;
          freq *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 4 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 41 }
    ]
  },
  /**
   * 紫噪声（Violet Noise）。
   *
   * 算法：每层振幅乘 2（+6 dB/oct），比蓝噪声更极端地偏向高频，
   * 纹理上表现为极细密、近乎刺点的颗粒，适合极细颗粒与高频抖动。
   *
   * 参数：scale / octaves / contrast / seed。
   */
  {
    type: 'violet_noise',
    name: 'Violet Noise',
    category: 'Noise',
    space: 'data',
    desc: 'f² spectrum (+6 dB/oct): extremely fine, almost stippled high-frequency grain.',
    inputs: [],
    prelude: COLOR_LATTICE_GLSL,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          sum += amp * cnValue(uv, freq, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= 2.0;
          freq *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 4 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 43 }
    ]
  },
  /**
   * 方向噪声（Directional Noise）。
   *
   * 算法：沿指定角度对 fBm 做多次偏移采样并求平均，相当于在节点内部做方向性拖影，
   * 产生沿角度拉伸的丝状 / 条状纹理。偏移只在周期噪声内部平移，因此仍然无缝。
   *
   * 参数：
   *  - angle：拉伸方向（0~180 度）；
   *  - length：拖影长度（px @1K，1~64）；
   *  - scale / octaves / contrast / seed：基础 fBm 参数。
   */
  {
    type: 'directional',
    name: 'Directional Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Directional streaked fBm: average samples along an angle for cloth, wood, water and hair.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float a = radians(u_angle);
        vec2 dir = vec2(cos(a), sin(a));
        float amount = u_length / 256.0;
        float sum = 0.0;
        for (int i = 0; i < 6; i++) {
          float t = (float(i) / 5.0 - 0.5) * amount;
          sum += fbmTiled(uv + dir * t, u_scale, u_octaves, 0.5, 2.0, u_seed);
        }
        float v = sat(sum / 6.0);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'angle', label: 'Angle', type: 'float', min: 0, max: 180, step: 1, def: 0 },
      { key: 'length', label: 'Length', type: 'float', min: 1, max: 96, step: 1, def: 32 },
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 6 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 6, def: 3 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 47 }
    ]
  },
  /**
   * 各向异性噪声（Anisotropic Noise）。
   *
   * 算法：底层是值噪声，但 X / Y 两个方向的网格数量可以相差悬殊。
   * 例如 Scale X=4、Scale Y=32 时，横向变化慢、纵向变化快，得到横向拉长的条带。
   *  - interpolation：Linear（线性）或 Smooth（smoothstep 平滑），Smooth 时由 smoothness 控制平滑强度。
   * 格点哈希按各自方向的整数周期取模，因此 UV 0~1 无缝。
   *
   * 参数：scale_x / scale_y / interpolation / smoothness / octaves / contrast / seed。
   */
  {
    type: 'anisotropic',
    name: 'Anisotropic Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Value noise with independent X/Y grid counts: stretched bands for brushed and fibrous surfaces.',
    inputs: [],
    prelude: /* glsl */ `
      float anValue(vec2 uv, float fx, float fy, float smoothness, float seed) {
        vec2 p = vec2(uv.x * fx, uv.y * fy);
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 sm = f * f * (3.0 - 2.0 * f);
        vec2 u = mix(f, sm, smoothness);
        vec2 period = vec2(fx, fy);
        float a = hash1(mod(i, period), seed);
        float b = hash1(mod(i + vec2(1.0, 0.0), period), seed);
        float c = hash1(mod(i + vec2(0.0, 1.0), period), seed);
        float d = hash1(mod(i + vec2(1.0, 1.0), period), seed);
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }`,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float fx = max(1.0, floor(u_scale_x + 0.5));
        float fy = max(1.0, floor(u_scale_y + 0.5));
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 6; o++) {
          if (o >= u_octaves) break;
          sum += amp * anValue(uv, fx, fy, u_interpolation == 0 ? u_smoothness : 0.0, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= 0.5;
          fx *= 2.0;
          fy *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale_x', label: 'Scale X', type: 'float', min: 1, max: 64, step: 1, def: 4 },
      { key: 'scale_y', label: 'Scale Y', type: 'float', min: 1, max: 64, step: 1, def: 32 },
      { key: 'interpolation', label: 'Interpolation', type: 'select', options: ['Smooth', 'Linear'], def: 0 },
      { key: 'smoothness', label: 'Smoothness', type: 'float', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 6, def: 3 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 53 }
    ]
  },
  /**
   * 各向异性柏林噪声（Anisotropic Perlin）。
   *
   * 算法：与 Perlin 相同的梯度插值，但格子周期是 vec2(fx, fy)，X/Y 方向频率独立可调；
   * 每个倍频两个方向同时翻倍。适合拉丝金属、木纹、纤维等带方向的真实表面。
   * 周期哈希保证 UV 0~1 无缝。
   *
   * 参数：scale_x / scale_y / octaves / persistence / lacunarity / contrast / seed。
   */
  {
    type: 'anisotropic_perlin',
    name: 'Anisotropic Perlin',
    category: 'Noise',
    space: 'data',
    desc: 'Perlin with independent X/Y lattice periods: brushed metal, wood grain and fibre.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 period = vec2(
          max(1.0, floor(u_scale_x + 0.5)),
          max(1.0, floor(u_scale_y + 0.5))
        );
        float sum = 0.0, amp = 1.0, norm = 0.0;
        for (int o = 0; o < 6; o++) {
          if (o >= u_octaves) break;
          sum += amp * gnoise(uv * period, period, u_seed + float(o) * 17.0);
          norm += amp;
          amp *= u_persistence;
          period *= 2.0;
        }
        float v = sat(sum / max(norm, 1e-5) * 0.9 + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale_x', label: 'Scale X', type: 'float', min: 1, max: 64, step: 1, def: 4 },
      { key: 'scale_y', label: 'Scale Y', type: 'float', min: 1, max: 64, step: 1, def: 24 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 6, def: 4 },
      { key: 'persistence', label: 'Persistence', type: 'float', min: 0.15, max: 0.9, step: 0.01, def: 0.5 },
      { key: 'lacunarity', label: 'Lacunarity', type: 'float', min: 1.2, max: 3, step: 0.01, def: 2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 59 }
    ]
  },
  /**
   * 圆柱场（Cylinders）。
   *
   * 算法：以「到最近圆柱轴的距离」作为半径，用正弦波生成同心环，是木纹年轮的来源。
   * 圆柱轴在每个格子里随机抖动，距离场来自周期 Worley，因此整张贴图无缝；
   * 再用一层 fBm 轻微扰动半径，让年轮产生自然弯曲。
   *
   * 参数：
   *  - cells：每边圆柱数（1~16）；
   *  - rings：每个圆柱内的环数（1~32）；
   *  - jitter：圆柱轴在格内的随机偏移（0~1）；
   *  - warp：半径扰动强度（0~1）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'cylinders',
    name: 'Cylinders',
    category: 'Noise',
    space: 'data',
    desc: 'Concentric ring field around jittered cylinder axes: wood growth rings and turned surfaces.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float d = worleyTiled(uv, u_cells, u_jitter, u_seed).x;
        float warp = fbmTiled(uv, 3.0, 3, 0.5, 2.0, u_seed + 7.0);
        d += (warp - 0.5) * u_warp * 0.35;
        float v = 0.5 + 0.5 * sin((d - 0.12) * u_rings * TAU);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 1, max: 16, step: 1, def: 3 },
      { key: 'rings', label: 'Rings', type: 'float', min: 1, max: 32, step: 1, def: 8 },
      { key: 'jitter', label: 'Jitter', type: 'float', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.25 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 61 }
    ]
  },
  /**
   * 云噪声（Clouds）。
   *
   * 算法：把普通 fBm 与每层取绝对值的 billow fBm 按 billowness 混合，
   * 得到蓬松、柔软的云团；softness 再用 smoothstep 收拢亮部，形成云朵边缘。
   * 两层噪声都按整数周期平铺，因此无缝。
   *
   * 参数：
   *  - scale：基础频率（1~48）；
   *  - octaves：叠加层数（1~8）；
   *  - billowness：billow 占比（0~1），越大越蓬松；
   *  - softness：云边柔化程度（0~1）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'clouds',
    name: 'Clouds',
    category: 'Noise',
    space: 'data',
    desc: 'Soft billow / fBm clouds for smoke, stains, mist and large-scale rolling shapes.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float soft = sat(u_softness);
        float a = fbmTiled(uv, u_scale, u_octaves, 0.5, 2.0, u_seed);
        float b = fbmBillowTiled(uv, u_scale, u_octaves, 0.5, 2.0, u_seed + 23.0);
        float n = mix(a, b, sat(u_billowness));
        n = mix(n, smoothstep(0.16, 0.84, n), soft);
        float v = sat((n - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 5 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'billowness', label: 'Billow', type: 'float', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 67 }
    ]
  },
  /**
   * 大理石（Marble）。
   *
   * 算法：以 sin 带状纹为基础，用 fBm 沿 U 方向扭曲相位，产生被挤弯的脉络；
   * sharpness 控制脉络的粗细（越大越细）。带状频率取整，扭曲噪声周期平铺，
   * 因此整张贴图无缝。
   *
   * 参数：
   *  - scale：带状频率（1~24）；
   *  - turbulence：扭曲强度（0~1）；
   *  - octaves：扭曲噪声层数；
   *  - sharpness：脉络锐度（0.5~6）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'marble',
    name: 'Marble',
    category: 'Noise',
    space: 'data',
    desc: 'Sine veins warped by fBm turbulence: marble, agate and layered stone.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float n = fbmTiled(uv, 4.0, u_octaves, 0.5, 2.0, u_seed);
        float t = uv.x + (n - 0.5) * u_turbulence * 1.6;
        float s = 0.5 + 0.5 * sin(t * u_scale * TAU);
        float v = sat(pow(sat(s), u_sharpness));
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 24, step: 1, def: 5 },
      { key: 'turbulence', label: 'Turbulence', type: 'float', min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'sharpness', label: 'Sharpness', type: 'float', min: 0.5, max: 6, step: 0.01, def: 1.6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 71 }
    ]
  },
  /**
   * 木纹（Wood）。
   *
   * 算法：用周期 Worley 距离场生成年轮（与圆柱场同源），再叠加沿 Y 方向高度拉伸的
   * 梯度噪声作为纤维。warp 让年轮弯曲，grain 控制纤维的可见度。
   * 距离场与拉伸噪声都按周期平铺，因此整张贴图无缝。
   *
   * 参数：
   *  - cells：年轮中心数量（1~8）；
   *  - rings：每个中心的年轮数（2~24）；
   *  - stretch：年轮纵向拉伸倍数（1~4），越大越像木板切面；
   *  - warp：年轮弯曲程度（0~1）；
   *  - grain：纤维强度（0~1）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'wood',
    name: 'Wood',
    category: 'Noise',
    space: 'data',
    desc: 'Concentric growth rings with stretched fibre grain: wood, plywood and turned timber.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        // Integer stretch keeps the row of growth rings seamless while turning
        // the circles into the long ellipses seen on plank faces.
        float stretch = max(1.0, floor(float(u_stretch) + 0.5));
        float d = worleyTiled(vec2(uv.x, uv.y * stretch), u_cells, 0.7, u_seed).x;
        float warp = fbmTiled(uv, 3.0, 3, 0.5, 2.0, u_seed + 5.0);
        float rings = 0.5 + 0.5 * sin((d + (warp - 0.5) * u_warp * 0.4) * u_rings * TAU);
        float grain = gnoise(uv * vec2(3.0, 48.0), vec2(3.0, 48.0), u_seed + 11.0) * 0.5 + 0.5;
        float fibre = mix(1.0, 0.55 + 0.9 * grain, sat(u_grain));
        float v = rings * fibre;
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 1, max: 8, step: 1, def: 2 },
      { key: 'rings', label: 'Rings', type: 'float', min: 2, max: 24, step: 1, def: 8 },
      { key: 'stretch', label: 'Stretch', type: 'int', min: 1, max: 4, def: 2 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'grain', label: 'Grain', type: 'float', min: 0, max: 1, step: 0.01, def: 0.6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 73 }
    ]
  },
  /**
   * 裂纹（Crack）。
   *
   * 算法：用 Worley 的 F2-F1 边界得到细胞壁，再加 fBm 扰动让裂纹弯曲，
   * 最后用 smoothstep 把边界收成细缝。适合龟裂土地、旧化裂纹、石纹。
   * 周期 Worley 与周期 fBm 保证 UV 0~1 无缝。
   *
   * 参数：
   *  - cells：细胞数量（2~32）；
   *  - jitter：特征点抖动（0~1）；
   *  - width：裂纹宽度（0.005~0.2）；
   *  - warp：裂纹弯曲强度（0~1）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'crack',
    name: 'Crack',
    category: 'Noise',
    space: 'data',
    desc: 'Warped Voronoi borders: thin cracks for dried earth, aged stone and damaged surfaces.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 d = worleyTiled(uv, u_cells, u_jitter, u_seed);
        float e = d.y - d.x;
        float w = fbmTiled(uv, 4.0, 3, 0.5, 2.0, u_seed + 9.0);
        e += (w - 0.5) * u_warp * 0.14;
        float v = 1.0 - smoothstep(0.0, max(u_width, 0.001), e);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 2, max: 32, step: 1, def: 6 },
      { key: 'jitter', label: 'Jitter', type: 'float', min: 0, max: 1, step: 0.01, def: 0.85 },
      { key: 'width', label: 'Crack Width', type: 'float', min: 0.005, max: 0.2, step: 0.001, def: 0.05 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 79 }
    ]
  },
  /**
   * 斑点噪声（Speckle）。
   *
   * 算法：把 UV 分格，每个格子用哈希决定「是否长点」，点本身是格内的圆形平滑遮罩。
   * 用 density 控制点的密度、radius 控制大小，适合表面瑕疵、粗糙度微变化与颗粒。
   * 格点哈希按整数周期取模，UV 0~1 无缝。
   *
   * 参数：
   *  - scale：每边格子数（8~512）；
   *  - density：出现概率（0~1）；
   *  - radius：点的半径（0.02~0.5）；
   *  - softness：边缘柔化（0~0.3）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'speckle',
    name: 'Speckle',
    category: 'Noise',
    space: 'data',
    desc: 'Sparse random dots for surface blemishes, roughness variation and fine grain.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float size = max(1.0, floor(u_scale + 0.5));
        vec2 p = uv * size;
        vec2 i = floor(p);
        vec2 f = fract(p);
        float h = hash1(mod(i, vec2(size)), u_seed);
        float on = step(h, u_density);
        float r = max(u_radius, 0.001);
        float dot0 = 1.0 - smoothstep(r - max(u_softness, 0.001), r, length(f - 0.5));
        float v = on * dot0;
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 8, max: 512, step: 1, def: 96 },
      { key: 'density', label: 'Density', type: 'float', min: 0, max: 1, step: 0.01, def: 0.18 },
      { key: 'radius', label: 'Radius', type: 'float', min: 0.02, max: 0.5, step: 0.01, def: 0.28 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0, max: 0.3, step: 0.001, def: 0.06 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 83 }
    ]
  },
  /**
   * 凹凸纹理（Stucci）。
   *
   * 算法：对 fBm 做屏幕空间梯度（比较当前像素与右/上邻域的差值），
   * 输出梯度模长，形成类似锤打 / 皮革 / 粗糙墙面的凹凸颗粒。
   * 噪声本身周期平铺，因此在 UV 边界同样无缝。
   *
   * 参数：
   *  - scale：基础频率（1~48）；
   *  - octaves：叠加层数（1~8）；
   *  - strength：梯度强度（0.2~6）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'stucci',
    name: 'Stucci',
    category: 'Noise',
    space: 'data',
    desc: 'Gradient of fBm: bumpy hammered, leathery or rough-wall micro relief.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float n = fbmTiled(uv, u_scale, u_octaves, 0.5, 2.0, u_seed);
        float nx = fbmTiled(uv + vec2(uPx.x, 0.0), u_scale, u_octaves, 0.5, 2.0, u_seed);
        float ny = fbmTiled(uv + vec2(0.0, uPx.y), u_scale, u_octaves, 0.5, 2.0, u_seed);
        vec2 g = vec2(nx - n, ny - n) / max(uPx.x, 1e-6);
        float v = sat(length(g) * u_strength * 0.13);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 8 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 4 },
      { key: 'strength', label: 'Strength', type: 'float', min: 0.2, max: 6, step: 0.01, def: 1 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 89 }
    ]
  },
  /**
   * Voivoide / Voronoise。
   *
   * 算法：先用 fBm 位移场扰动采样坐标，再取周期 Worley 的 F1 距离。
   * 这样细胞边界不再规则，得到介于 Voronoi 与噪声之间的有机团块，
   * 适合岩石、鳞片、生物皮肤等不规则细胞结构。
   *
   * 参数：
   *  - cells：细胞数量（2~32）；
   *  - jitter：特征点抖动（0~1）；
   *  - warp：坐标扰动强度（0~1）；
   *  - contrast：对比度；
   *  - seed：随机种子。
   */
  {
    type: 'voivoide',
    name: 'Voivoide',
    category: 'Noise',
    space: 'data',
    desc: 'Voronoi cells with noise-warped boundaries: organic blobs and irregular scales.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float wx = fbmTiled(uv + vec2(0.13, 0.47), 4.0, 3, 0.5, 2.0, u_seed + 3.0);
        float wy = fbmTiled(uv + vec2(0.61, 0.29), 4.0, 3, 0.5, 2.0, u_seed + 19.0);
        vec2 p = uv + (vec2(wx, wy) - 0.5) * u_warp * 0.25;
        float d = worleyTiled(p, u_cells, u_jitter, u_seed).x;
        float v = sat(d * 1.2);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 2, max: 32, step: 1, def: 7 },
      { key: 'jitter', label: 'Jitter', type: 'float', min: 0, max: 1, step: 0.01, def: 0.9 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.6 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 97 }
    ]
  },
  /**
   * Gabor 噪声（Gabor Noise）。
   *
   * 算法：把 UV 分成 cells×cells 的格子，每格随机放一个脉冲，用「高斯包络 × 余弦波」
   * 的 Gabor 核对脉冲做卷积（只累加 3×3 邻域），得到随机交织的条带。
   *  - angle：条带方向；
   *  - anisotropy：1 时所有条带同向（方向性纹理），0 时每格随机方向（全向噪声）；
   *  - bandwidth：高斯包络宽度，控制条带的空间延续长度。
   * 周期哈希保证 UV 0~1 无缝。
   *
   * 参数：cells / frequency / angle / anisotropy / bandwidth / contrast / seed。
   */
  {
    type: 'gabor',
    name: 'Gabor Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Random interwoven stripes from Gabor kernels: wood, fabric, brushed and anisotropic materials.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float cells = max(1.0, floor(u_cells + 0.5));
        vec2 p = uv * cells;
        vec2 i = floor(p);
        vec2 f = fract(p);
        float sigma = 0.3 + u_bandwidth * 0.5;
        float baseAngle = radians(u_angle);
        float acc = 0.0, wsum = 0.0;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 id = mod(i + g, vec2(cells));
            vec2 c = hash2(id, u_seed);
            vec2 d = g + c - f;
            float env = exp(-dot(d, d) / (2.0 * sigma * sigma));
            if (env < 0.002) continue;
            float rndAngle = hash1(id, u_seed + 5.0) * TAU;
            float a = mix(rndAngle, baseAngle, sat(u_anisotropy));
            vec2 dir = vec2(cos(a), sin(a));
            float phase = hash1(id, u_seed + 13.0) * TAU;
            acc += env * cos(dot(d, dir) * u_frequency * TAU + phase);
            wsum += env;
          }
        }
        float v = sat(acc / max(wsum, 1e-5) * 0.5 + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 2, max: 16, step: 1, def: 8 },
      { key: 'frequency', label: 'Frequency', type: 'float', min: 0.5, max: 8, step: 0.01, def: 2.5 },
      { key: 'angle', label: 'Angle', type: 'float', min: 0, max: 180, step: 1, def: 0 },
      { key: 'anisotropy', label: 'Anisotropy', type: 'float', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'bandwidth', label: 'Bandwidth', type: 'float', min: 0.2, max: 1, step: 0.01, def: 0.5 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 87 }
    ]
  },
  /**
   * 相位噪声（Phasor Noise）。
   *
   * 算法：用整数频率的平面波构造相位，再用 fBm 扰动相位并取 sin，
   * 得到频率与相位都可精确控制的条纹，适合频谱精确的位移贴图与纹理合成。
   *  - scale：条纹总密度；angle：方向（相位轴会吸附到整数频率以保证无缝）；
   *  - phase：整体相位偏移；warp：噪声对相位的扰动强度。
   *
   * 参数：scale / angle / phase / warp / contrast / seed。
   */
  {
    type: 'phasor',
    name: 'Phasor Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Phase-controlled waves: integer-frequency bands with fBm phase jitter for displacement.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float a = radians(u_angle);
        float fx = floor(abs(cos(a)) * u_scale + 0.5);
        float fy = floor(abs(sin(a)) * u_scale + 0.5);
        if (fx + fy < 1.0) fx = 1.0;
        float n = fbmTiled(uv, 4.0, 4, 0.5, 2.0, u_seed);
        float phase = (uv.x * fx + uv.y * fy) * TAU + u_phase * TAU + (n - 0.5) * u_warp * TAU;
        float v = 0.5 + 0.5 * sin(phase);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 32, step: 1, def: 8 },
      { key: 'angle', label: 'Angle', type: 'float', min: 0, max: 180, step: 1, def: 0 },
      { key: 'phase', label: 'Phase', type: 'float', min: 0, max: 1, step: 0.01, def: 0 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.2 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 91 }
    ]
  },
  /**
   * 小波噪声（Wavelet Noise）。
   *
   * 算法：用「带通加权」代替 fBm 的低通叠加——每个倍频按距离 detail 频带的远近
   * 取高斯权重，只保留一段频带内的噪声。这样可以在不引入低频块状感的前提下
   * 提取某一尺度的细节，适合位移贴图与多尺度细节叠加。
   * 所有倍频频率取整并走周期哈希，UV 0~1 无缝。
   *
   * 参数：scale / detail（频带中心）/ bandwidth（频带宽度）/ octaves / contrast / seed。
   */
  {
    type: 'wavelet',
    name: 'Wavelet Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Band-pass filtered fractal noise: one selectable detail band without low-frequency blocking.',
    inputs: [],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(1.0, floor(u_scale + 0.5));
        float sum = 0.0, wsum = 0.0;
        for (int o = 0; o < 8; o++) {
          if (o >= u_octaves) break;
          float d = (float(o) - u_detail) / max(u_bandwidth, 0.05);
          float w = exp(-d * d);
          sum += w * gnoise(uv * freq, vec2(freq), u_seed + float(o) * 17.0);
          wsum += w;
          freq *= 2.0;
        }
        float v = sat(sum / max(wsum, 1e-5) * 0.9 + 0.5);
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`,
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 32, step: 1, def: 4 },
      { key: 'detail', label: 'Detail Band', type: 'float', min: 0, max: 7, step: 0.1, def: 2 },
      { key: 'bandwidth', label: 'Bandwidth', type: 'float', min: 0.3, max: 3, step: 0.01, def: 1.1 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 7 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 93 }
    ]
  },
  /**
   * 做旧 / 污渍纹理（Grunge）。
   *
   * 算法：低频 fBm 与高频 fBm 按 0.62 / 0.38 加权混合，再减去 threshold 并乘以 contrast，
   * 得到斑驳的污渍块。两层噪声都按整数周期平铺。
   *
   * 参数：
   *  - scale：基础频率（1~48）；
   *  - octaves：基础层叠加层数（1~8）；
   *  - detail：侵蚀层频率相对基础层的倍率（1~12）；
   *  - threshold：污渍阈值（0~1），越高污渍越少；
   *  - contrast：对比度（1~20，默认偏强以得到硬朗的污渍边缘）；
   *  - invert：取反；
   *  - seed：随机种子。
   */
  {
    type: 'grunge',
    name: 'Grunge',
    category: 'Noise',
    space: 'data',
    desc: 'Layered fractal grunge / dirt mask with threshold control.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 48, step: 1, def: 5 },
      { key: 'octaves', label: 'Octaves', type: 'int', min: 1, max: 8, def: 6 },
      { key: 'detail', label: 'Detail Scale', type: 'float', min: 1, max: 12, step: 0.1, def: 3.6 },
      { key: 'threshold', label: 'Threshold', type: 'float', min: 0, max: 1, step: 0.01, def: 0.52 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 1, max: 20, step: 0.1, def: 6 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 7 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float n = fbmTiled(uv, max(1.0, u_scale), u_octaves, 0.55, 2.0, u_seed);
        float n2 = fbmTiled(uv, max(1.0, floor(u_scale * u_detail)), u_octaves, 0.5, 2.0, u_seed + 31.0);
        float v = sat(((n * 0.62 + n2 * 0.38) - u_threshold) * u_contrast + 0.5);
        if (u_invert) v = 1.0 - v;
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 条纹 / 波形图案。
   *
   * 算法：把 UV 旋转 angle 后，按 mode 计算相位（线性 / 径向 / 角度），
   * 再用 width（占空比）与 softness（边缘过渡宽度）做软方波，得到条纹。
   *
   * 参数：
   *  - mode：Linear 线性 / Radial 同心圆 / Angular 扇形；
   *  - count：条纹周期数（1~64）；
   *  - angle：条纹方向（0~360°，仅线性模式有效）；
   *  - width：亮条占空比（0.05~0.95）；
   *  - softness：边缘柔化宽度（0~0.5）；
   *  - invert：取反。
   */
  {
    type: 'waves',
    name: 'Wave Pattern',
    category: 'Pattern',
    space: 'data',
    desc: 'Linear, radial or angular sine wave bands.',
    inputs: [],
    params: [
      { key: 'mode', label: 'Mode', type: 'select', options: ['Linear', 'Radial', 'Angular'], def: 0 },
      { key: 'count', label: 'Frequency', type: 'int', min: 1, max: 64, def: 6 },
      { key: 'angle', label: 'Angle', type: 'angle', min: 0, max: 360, step: 1, def: 0 },
      { key: 'width', label: 'Duty', type: 'float', min: 0.05, max: 0.95, step: 0.01, def: 0.5 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0, max: 0.5, step: 0.005, def: 0.05 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float t;
        if (u_mode == 0) {
          vec2 p = rot2(uv - 0.5, u_angle);
          t = p.x * float(u_count);
        } else if (u_mode == 1) {
          t = length(uv - 0.5) * float(u_count) * 2.0;
        } else {
          t = atan(uv.y - 0.5, uv.x - 0.5) / TAU * float(u_count);
        }
        float d = abs(fract(t) - 0.5);
        float half_ = u_width * 0.5;
        float v = smoothstep(half_ + u_softness + uPx.x, half_ - u_softness - uPx.x, d);
        if (u_invert) v = 1.0 - v;
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 棋盘格。
   *
   * 算法：UV 旋转后乘以格数并取整，用 (ix + iy) 奇偶决定格子颜色；边缘不抗锯齿
   * 是为了保持像素风的硬边。
   *
   * 参数：scale 每边格数（1~64）、angle 旋转角（0~360°）、colorA / colorB 两种颜色。
   */
  {
    type: 'checker',
    name: 'Checker',
    category: 'Pattern',
    space: 'color',
    desc: 'Tileable two-tone checker grid.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 64, step: 1, def: 8 },
      { key: 'angle', label: 'Angle', type: 'angle', min: 0, max: 360, step: 1, def: 0 },
      { key: 'colorA', label: 'Color A', type: 'color', def: '#e8e8e8' },
      { key: 'colorB', label: 'Color B', type: 'color', def: '#202020' }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float s = max(1.0, floor(u_scale + 0.5));
        vec2 p = rot2(uv - 0.5, u_angle) * s;
        vec2 c = floor(p);
        float v = mod(c.x + c.y, 2.0);
        return mix(u_colorA, u_colorB, v);
      }`
  },
  /**
   * 砖墙。
   *
   * 算法：按 rows / offset 做错缝排列，每块砖用圆角矩形 SDF 求距离，得到砖面、
   * bevel 倒角与 mortar 灰缝；variation 通过按砖块 id 的哈希给每块砖随机亮度差异。
   * mode 决定输出「砖色 + 灰缝」还是「可用于 Height 的凹凸高度」。
   *
   * 参数：
   *  - cols / rows：每行每列砖数（1~24）；
   *  - offset：行间错缝比例（0~1）；
   *  - mortar：灰缝宽度（0~0.3，按 UV 计）；
   *  - round：砖角圆度（0~0.3）；
   *  - bevel：倒角宽度（0.005~0.2）；
   *  - variation：每块砖的明暗随机幅度（0~1）；
   *  - mode：color 颜色 / height 高度；
   *  - colorA / colorB：砖面与灰缝颜色；
   *  - seed：随机种子。
   */
  {
    type: 'bricks',
    name: 'Brick Wall',
    category: 'Pattern',
    space: 'color',
    desc: 'Running-bond brick layout. Color or height (bevel) output.',
    inputs: [],
    params: [
      { key: 'cols', label: 'Columns', type: 'int', min: 1, max: 24, def: 5 },
      { key: 'rows', label: 'Rows', type: 'int', min: 1, max: 24, def: 8 },
      { key: 'offset', label: 'Row Offset', type: 'float', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'mortar', label: 'Mortar', type: 'float', min: 0, max: 0.3, step: 0.005, def: 0.035 },
      { key: 'round', label: 'Corner Round', type: 'float', min: 0, max: 0.3, step: 0.005, def: 0.06 },
      { key: 'bevel', label: 'Bevel (height)', type: 'float', min: 0.005, max: 0.2, step: 0.005, def: 0.06 },
      { key: 'variation', label: 'Color Variation', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Brick', type: 'color', def: '#a8583c' },
      { key: 'colorB', label: 'Mortar', type: 'color', def: '#4a4642' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 5 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 cnt = vec2(max(1.0, float(u_cols)), max(1.0, float(u_rows)));
        vec2 p = uv * cnt;
        p.x += mod(floor(p.y), 2.0) * u_offset;
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        vec2 hs = vec2(0.5 - u_mortar, 0.5 - u_mortar);
        float r = min(u_round, min(hs.x, hs.y) * 0.9);
        vec2 q = abs(f) - hs + r;
        float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
        float aa = uPx.x * 1.5 + 1e-4;
        float mask = smoothstep(aa, -aa, d);
        vec3 tint = hash3(mod(cell, cnt), u_seed);
        if (u_mode == 0) {
          vec3 brick = u_colorA.rgb * (1.0 - u_variation + u_variation * (0.55 + 0.45 * tint.x));
          brick *= 0.92 + 0.16 * tint.y;
          return vec4(mix(u_colorB.rgb, brick, mask), 1.0);
        }
        float edge = sat(-d / max(u_bevel, 1e-3));
        float h = mix(0.12, 1.0, sat(edge)) * (0.7 + 0.3 * tint.y);
        h = mix(0.0, h, mask);
        return vec4(vec3(h), 1.0);
      }`
  },
  /**
   * 程序化瓷砖（随机错位 / 旋转的矩形砖块）。
   *
   * 算法：把 UV 划分成 count × count 网格，并检查 3×3 邻域；每个邻域单元通过哈希
   * 得到随机偏移与旋转角度，把点变换回单元局部坐标后计算圆角矩形 SDF，取最近距离。
   * 这种「邻域搜索」避免了砖块旋转/偏移后被裁切断裂。
   *
   * 参数：
   *  - count：X / Y 方向网格数（vec2，1~24）；
   *  - gap：砖块间缝隙（0~0.25）；
   *  - round：圆角（0~0.3）；
   *  - randomize：位置随机偏移幅度（0~1）；
   *  - rotate：旋转随机幅度（0~1）；
   *  - bevel：倒角宽度（0.005~0.2）；
   *  - variation：逐块明暗差异（0~1）；
   *  - mode：color / height；
   *  - colorA / colorB：砖块与缝隙颜色；
   *  - seed：随机种子。
   */
  {
    type: 'tiles',
    name: 'Tile Generator',
    category: 'Pattern',
    space: 'color',
    desc: 'Procedural tiles with per-tile offset, rotation, scale and height.',
    inputs: [],
    params: [
      { key: 'count', label: 'Count X / Y', type: 'vec2', min: 1, max: 24, step: 1, def: [6, 6] },
      { key: 'gap', label: 'Gap', type: 'float', min: 0, max: 0.25, step: 0.002, def: 0.025 },
      { key: 'round', label: 'Corner Round', type: 'float', min: 0, max: 0.3, step: 0.005, def: 0.03 },
      { key: 'randomize', label: 'Randomness', type: 'float', min: 0, max: 1, step: 0.01, def: 0.3 },
      { key: 'rotate', label: 'Random Rotation', type: 'float', min: 0, max: 1, step: 0.01, def: 0.06 },
      { key: 'bevel', label: 'Bevel (height)', type: 'float', min: 0.005, max: 0.2, step: 0.005, def: 0.05 },
      { key: 'variation', label: 'Color Variation', type: 'float', min: 0, max: 1, step: 0.01, def: 0.25 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Tile', type: 'color', def: '#8b8f96' },
      { key: 'colorB', label: 'Gap', type: 'color', def: '#2b2e33' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 9 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 cnt = max(u_count, vec2(1.0));
        vec2 p = uv * cnt;
        vec2 baseCell = floor(p);
        vec2 bestCell = baseCell;
        float best = 1e9;
        float bestHash = 0.5;
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 cell = mod(baseCell + g, cnt);
            vec3 h = hash3(cell, u_seed);
            vec2 off = (h.xy - 0.5) * u_randomize * 0.35;
            vec2 q = p - (baseCell + g + 0.5 + off);
            q = rot2(q, h.z * TAU * u_rotate);
            float sc = 1.0 - u_randomize * 0.25 * h.x;
            vec2 hs = (vec2(0.5) - u_gap) * sc;
            float r = min(u_round, min(hs.x, hs.y) * 0.85);
            vec2 dq = abs(q) - hs + r;
            float d = min(max(dq.x, dq.y), 0.0) + length(max(dq, 0.0)) - r;
            if (d < best) {
              best = d;
              bestCell = cell;
              bestHash = h.y;
            }
          }
        }
        vec2 aaPx = uPx * cnt;
        float aa = max(aaPx.x, aaPx.y) * 1.5 + 1e-4;
        float mask = smoothstep(aa, -aa, best);
        if (u_mode == 0) {
          vec3 tint = hash3(bestCell, u_seed + 13.0);
          vec3 col = u_colorA.rgb * (1.0 - u_variation + u_variation * (0.6 + 0.4 * tint.y));
          return vec4(mix(u_colorB.rgb, col, mask), 1.0);
        }
        float edge = sat(-best / max(u_bevel, 1e-3));
        float hh = mix(0.15, 1.0, sat(edge)) * (0.78 + 0.22 * bestHash);
        return vec4(vec3(mix(0.0, hh, mask)), 1.0);
      }`
  },
  /**
   * 参数化形状（基于 SDF 距离场）。
   *
   * 算法：prelude 注入 SHAPE_GLSL，按 type 选择圆角矩形 / 椭圆 / 正多边形 / 星形的
   * 有符号距离函数；再经 softness 做抗锯齿、invert 取反。
   * 输出是灰度遮罩，可直接当 alpha / 高度 / 蒙版使用。
   *
   * 参数：
   *  - type：rect / ellipse / polygon / star；
   *  - size：形状尺寸（vec2，0.02~1 的 UV 比例）；
   *  - offset：中心偏移（vec2，-0.5~0.5）；
   *  - rotation：旋转角（0~360°）；
   *  - roundness：圆角半径（0~1，矩形圆角程度）；
   *  - sides：多边形边数（3~12）；
   *  - inner：星形内半径比例（0.1~1）；
   *  - sharpness：星形尖角锐度（0.2~4）；
   *  - softness：边缘柔化（0~0.4）；
   *  - invert：取反。
   */
  {
    type: 'shape',
    name: 'Shape',
    category: 'Shape',
    space: 'data',
    desc: 'Anti-aliased SDF shape: box, ellipse, polygon, star.',
    prelude: SHAPE_GLSL,
    inputs: [],
    params: [
      { key: 'type', label: 'Shape', type: 'select', options: ['Rectangle', 'Ellipse', 'Polygon', 'Star'], def: 0 },
      { key: 'size', label: 'Size', type: 'vec2', min: 0.02, max: 1, step: 0.005, def: [0.8, 0.8] },
      { key: 'offset', label: 'Offset', type: 'vec2', min: -0.5, max: 0.5, step: 0.005, def: [0, 0] },
      { key: 'rotation', label: 'Rotation', type: 'angle', min: 0, max: 360, step: 1, def: 0 },
      { key: 'roundness', label: 'Roundness', type: 'float', min: 0, max: 1, step: 0.01, def: 0.15 },
      { key: 'sides', label: 'Sides', type: 'int', min: 3, max: 12, def: 6 },
      { key: 'inner', label: 'Star Inner', type: 'float', min: 0.1, max: 1, step: 0.01, def: 0.5 },
      { key: 'sharpness', label: 'Star Sharpness', type: 'float', min: 0.2, max: 4, step: 0.01, def: 1 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0, max: 0.4, step: 0.002, def: 0.005 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 size = max(u_size, vec2(1e-3));
        vec2 p = rot2(uv - 0.5 - u_offset, -u_rotation) / size;
        float d;
        if (u_type == 0) {
          float r = u_roundness * 0.49;
          d = sdRoundBox(p, vec2(0.49), r);
        } else if (u_type == 1) {
          d = (length(p) - 0.49) * 0.5;
        } else if (u_type == 2) {
          d = sdPolygon(p, 0.49, float(u_sides), 0.0);
        } else {
          d = sdStar(p, 0.49, float(u_sides), u_inner, u_sharpness, 0.0);
        }
        float aa = u_softness + uPx.x / max(size.x, 1e-3) * 1.6;
        float v = smoothstep(aa, -aa, d);
        if (u_invert) v = 1.0 - v;
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 多色标渐变。
   *
   * 算法：按 type 计算 0~1 的渐变参数 t，再乘以 repeat 并加上 offset 后取小数部分，
   * 最后交给 prelude 的 sampleGradient(t) 在多个色标之间插值。
   *
   * 参数：
   *  - type：Linear 线性 / Radial 径向 / Angular 角度 / Diamond 菱形；
   *  - angle：线性渐变的方向（0~360°）；
   *  - repeat：沿渐变方向重复次数（1~8）；
   *  - offset：渐变偏移量（-1~1），可无缝滚动色带；
   *  - gradient：色标数组，每项为 { p: 位置 0~1, c: 颜色 }，可在检查器里增删。
   */
  {
    type: 'gradient',
    name: 'Gradient',
    category: 'Color',
    space: 'color',
    desc: 'Multi-stop gradient ramp source with editable stops.',
    inputs: [],
    params: [
      { key: 'type', label: 'Type', type: 'select', options: ['Linear', 'Radial', 'Angular', 'Diamond'], def: 0 },
      { key: 'angle', label: 'Angle', type: 'angle', min: 0, max: 360, step: 1, def: 0 },
      { key: 'repeat', label: 'Repeat', type: 'int', min: 1, max: 8, def: 1 },
      { key: 'offset', label: 'Offset', type: 'float', min: -1, max: 1, step: 0.01, def: 0 },
      { key: 'gradient', label: 'Colors', type: 'gradient', def: [
        { p: 0, c: '#1b1e24' }, { p: 0.5, c: '#7a8088' }, { p: 1, c: '#f2f3f5' }
      ] }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float t;
        if (u_type == 0) {
          vec2 p = rot2(uv - 0.5, u_angle);
          t = p.x + 0.5;
        } else if (u_type == 1) {
          t = length(uv - 0.5) * 2.0;
        } else if (u_type == 2) {
          t = atan(uv.y - 0.5, uv.x - 0.5) / TAU + 0.5;
        } else {
          t = abs(uv.x - 0.5) + abs(uv.y - 0.5);
        }
        t = fract(t * float(u_repeat) + u_offset);
        return sampleGradient(t);
      }`
  },
  /**
   * 常量数值（0~1 的原始数据，不走 sRGB 编码）。
   * 常用于给 Roughness / Metallic / 蒙版一个固定值。
   * 参数 value：常量值（0~1）。
   */
  {
    type: 'flat_value',
    name: 'Constant Value',
    category: 'Input',
    space: 'data',
    desc: 'Raw 0–1 data constant (use for roughness / metallic / masks).',
    inputs: [],
    params: [
      { key: 'value', label: 'Value', type: 'float', min: 0, max: 1, step: 0.005, def: 0.5 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        return vec4(vec3(u_value), 1.0);
      }`
  },
  /**
   * 常量颜色（sRGB 颜色流）。
   * 参数：color 颜色值；alpha 不透明度（0~1，可直接作为透明度输出）。
   */
  {
    type: 'flat_color',
    name: 'Flat Color',
    category: 'Color',
    space: 'color',
    desc: 'Constant color source.',
    inputs: [],
    params: [
      { key: 'color', label: 'Color', type: 'color', def: '#b4784a' },
      { key: 'alpha', label: 'Opacity', type: 'float', min: 0, max: 1, step: 0.01, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        return vec4(u_color.rgb, u_alpha);
      }`
  },
  /**
   * 位图输入（图片导入）。
   *
   * 该节点带 imageInput 标记：引擎会为它绑定一张外部图片纹理（uImage）。
   * 图片可能在 sRGB 色彩空间创作，也可能存放法线 / 打包数据，因此 channelMode 很关键。
   *
   * 参数：
   *  - channelMode：Color（按 sRGB 解码为线性光）/ Grayscale（取红通道作灰度）/
   *    Alpha（取透明通道）/ Data (RGB)（保持原始 RGB，法线等数据图不能做 sRGB 解码）；
   *  - scale：纹理平铺倍数（vec2，0.1~8），可做非等比缩放；
   *  - offset：UV 偏移（vec2，-1~1）；
   *  - invert：反相（仅作用于 RGB）。
   */
  {
    type: 'image_input',
    name: 'Texture Input',
    category: 'Input',
    space: 'color',
    desc: 'Load a bitmap (color or mask) into the graph.',
    inputs: [],
    params: [
      { key: 'channelMode', label: 'Channel', type: 'select', options: ['Color', 'Grayscale', 'Alpha', 'Data (RGB)'], def: 0 },
      { key: 'scale', label: 'Tiling', type: 'vec2', min: 0.1, max: 8, step: 0.01, def: [1, 1] },
      { key: 'offset', label: 'Offset', type: 'vec2', min: -1, max: 1, step: 0.005, def: [0, 0] },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    imageInput: true,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 p = uv * u_scale + u_offset;
        vec4 c = texture(uImage, p);
        if (u_channelMode == 0) {
          // Color: authored in sRGB, processed in linear light.
          c.rgb = srgbToLinear(c.rgb);
        } else if (u_channelMode == 1) {
          // Grayscale: raw data from the red channel.
          c = vec4(vec3(c.r), c.a);
        } else if (u_channelMode == 2) {
          // Alpha: raw data from the alpha channel.
          c = vec4(vec3(c.a), c.a);
        }
        // mode 3 (Data (RGB)): keep raw RGB — normals / packed data maps must not be sRGB-decoded.
        if (u_invert) c.rgb = 1.0 - c.rgb;
        return c;
      }`
  },
  /**
   * 手绘图层。
   *
   * 该节点带 paintInput 标记：引擎会绑定由 CPU 笔画栅格化得到的 uPaint 纹理。
   * 合成方式：base 输入作为底色，paint 的 RGBA 按 opacity 与可选 mask 相乘后作为
   * 透明度，再根据 blend 选择混合模式（Normal / Multiply / Screen / Overlay / Add / Max）。
   *
   * 参数：
   *  - opacity：整体不透明度（0~1）；
   *  - blend：与底色的混合模式；
   *  - useMask：是否启用 mask 输入端作为透明度遮罩。
   * 输入端口：input（Base 底色，默认 0.5 灰）、mask（遮罩，默认 1）。
   */
  {
    type: 'paint',
    name: 'Paint Layer',
    category: 'Paint',
    space: 'color',
    desc: 'Hand-painted RGBA layer with brushes, symmetry and blending.',
    inputs: [
      { name: 'input', label: 'Base', def: 0.5 },
      { name: 'mask', label: 'Mask', def: 1 }
    ],
    paintInput: true,
    params: [
      { key: 'opacity', label: 'Opacity', type: 'float', min: 0, max: 1, step: 0.01, def: 1 },
      { key: 'blend', label: 'Blend', type: 'select', options: ['Normal', 'Multiply', 'Screen', 'Overlay', 'Add', 'Max'], def: 0 },
      { key: 'useMask', label: 'Use Mask Input', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 base = texture(uIn_input, uv);
        vec4 p = texture(uPaint, uv);
        float m = u_useMask ? texture(uIn_mask, uv).r : 1.0;
        float a = sat(p.a * u_opacity * m);
        vec3 src = p.rgb;
        if (u_blend == 1) src = base.rgb * p.rgb;
        else if (u_blend == 2) src = 1.0 - (1.0 - base.rgb) * (1.0 - p.rgb);
        else if (u_blend == 3) {
          vec3 lo = 2.0 * base.rgb * p.rgb;
          vec3 hi = 1.0 - 2.0 * (1.0 - base.rgb) * (1.0 - p.rgb);
          src = mix(lo, hi, step(0.5, base.rgb));
        } else if (u_blend == 4) src = base.rgb + p.rgb;
        else if (u_blend == 5) src = max(base.rgb, p.rgb);
        return vec4(mix(base.rgb, src, a), base.a);
      }`
  }
]
