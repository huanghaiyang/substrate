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
   * 在 3×3 邻域内寻找最近（F1）与次近（F2）特征点。平铺通过 9 次周期平移实现。
   *
   * 参数：
   *  - cells：网格数量（2~64），越大细胞越小；
   *  - jitter：特征点在格内的随机偏移幅度（0~1）；
   *  - mode：F1 距离 / F2 距离 / F2-F1 边界 / 反相 F1；
   *  - invert：结果取反；
   *  - contrast：对比度（0.1~4）；
   *  - seed：随机种子。
   */
  {
    type: 'cellular',
    name: 'Cellular Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable Worley / Voronoi noise with F1, F2 and border modes.',
    inputs: [],
    params: [
      { key: 'cells', label: 'Cells', type: 'float', min: 2, max: 64, step: 1, def: 8 },
      { key: 'jitter', label: 'Jitter', type: 'float', min: 0, max: 1, step: 0.01, def: 0.9 },
      { key: 'mode', label: 'Mode', type: 'select', options: ['F1 (cells)', 'F2', 'Borders (F2-F1)', 'Inverted F1'], def: 0 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 3 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 d = worleyTiled(uv, u_cells, u_jitter, u_seed);
        float v;
        if (u_mode == 0) v = sat(d.x * 1.7);
        else if (u_mode == 1) v = sat(d.y * 1.6);
        else if (u_mode == 2) v = sat((d.y - d.x) * 3.2);
        else v = 1.0 - sat(d.x * 1.7);
        if (u_invert) v = 1.0 - v;
        v = sat((v - 0.5) * u_contrast + 0.5);
        return vec4(vec3(v), 1.0);
      }`
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
