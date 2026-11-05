/**
 * 滤镜 / 调整 / 合成节点定义。
 *
 * 分类：
 *  - Blend：多模式混合两个数据流；
 *  - Filter：模糊、锐化、浮雕、形变、边缘、形态学；
 *  - Adjust：色阶、直方图扫描、反相、去色、阈值、色阶简化；
 *  - Color：HSL、渐变映射、通道合并；
 *  - Normal：高度图 → 法线 / AO / 曲率。
 *
 * 节点定义字段约定：inputs 为输入端口，params 驱动检查器与着色器 uniform，
 * body / passes 给出 GLSL 片元逻辑（passes 为多遍可分离滤镜，uPrev 表示上一遍结果）。
 * GLSL 源码内的注释保持英文；节点定义的 JS 侧用中文说明算法与参数。
 */

// HSV 与 RGB 互转的 GLSL 工具函数（HSL 节点使用）。
// 采用标准的 RGB→HSV 折线算法（基于通道大小关系的分段计算），无分支且数值稳定。
const HSV_GLSL = /* glsl */ `
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
`

// 一维高斯模糊采样函数（Blur 节点使用）。
// 以 radius 决定 sigma（radius * 0.5）与 taps 数量（ceil(radius * 1.7)）；
// 采样点权重取 exp(-x²/2σ²)，并同时采样正负两侧，因此调用两次（水平 + 垂直）即可
// 得到二维可分离高斯模糊。taps 上限 64，防止大半径时循环次数过高拖慢 GPU。
const BLUR_GLSL = /* glsl */ `
vec4 blurDir(sampler2D src, vec2 uv, vec2 dir, float radius) {
  float sigma = max(radius * 0.5, 1e-3);
  int taps = int(clamp(ceil(radius * 1.7), 1.0, 64.0));
  vec4 sum = texture(src, uv);
  float wsum = 1.0;
  for (int i = 1; i <= 64; i++) {
    if (i > taps) break;
    float x = float(i);
    float w = exp(-0.5 * x * x / (sigma * sigma));
    sum += w * (texture(src, uv + dir * x * uPx) + texture(src, uv - dir * x * uPx));
    wsum += 2.0 * w;
  }
  return sum / wsum;
}
`

export const filterDefs = [
  /**
   * 混合两个数据流（含可选遮罩）。
   *
   * 算法：按 mode 用预置的 blendMode() 计算混合结果，再用 opacity * mask 作为权重
   * 与 base 插值；透明度同样按该权重在 base / blend 之间插值。
   *
   * 参数：
   *  - mode：15 种混合模式（Copy / Add / Subtract / Multiply / Screen / Darken /
   *    Lighten / Difference / Divide / Linear Burn / Linear Dodge / Overlay /
   *    Soft Light / Exclusion 等）；
   *  - opacity：混合强度（0~1）。
   * 输入：base 底色、blend 混合层、mask 遮罩（默认 1）。
   */
  {
    type: 'blend',
    name: 'Blend',
    category: 'Blend',
    space: 'color',
    desc: 'Composite two streams with 15 industry blend modes and a mask.',
    inputs: [
      { name: 'base', label: 'Base', def: 0 },
      { name: 'blend', label: 'Blend', def: 1 },
      { name: 'mask', label: 'Mask', def: 1 }
    ],
    params: [
      { key: 'mode', label: 'Mode', type: 'select', def: 0, options: [
        'Copy', 'Add (Linear Dodge)', 'Subtract', 'Reverse Subtract', 'Multiply', 'Screen', 'Darken (Min)',
        'Lighten (Max)', 'Difference', 'Divide', 'Linear Burn', 'Linear Dodge', 'Overlay', 'Soft Light', 'Exclusion'
      ] },
      { key: 'opacity', label: 'Opacity', type: 'float', min: 0, max: 1, step: 0.01, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 a = texture(uIn_base, uv);
        vec4 b = texture(uIn_blend, uv);
        float m = texture(uIn_mask, uv).r;
        float op = sat(u_opacity * m);
        vec3 c = blendMode(u_mode, a.rgb, b.rgb);
        return vec4(mix(a.rgb, sat3(c), op), mix(a.a, b.a, op));
      }`
  },
  /**
   * 高斯模糊（可分离两遍实现）。
   *
   * 算法：第 1 遍沿 X 轴做一维高斯卷积，第 2 遍沿 Y 轴对上一遍结果卷积，
   * 两遍结果等价于二维高斯核，但采样次数从 O(n²) 降到 O(2n)。
   * radius 以「1K 分辨率下的像素数」为单位，实际半径按 uRes.x / 1024 等比缩放，
   * 因此更换输出分辨率时模糊的视觉强度保持一致。
   *
   * 参数：radius 模糊半径（0~96 px @1K）。
   */
  {
    type: 'blur',
    name: 'Blur',
    category: 'Filter',
    space: 'data',
    desc: 'Separable gaussian blur, resolution independent radius.',
    prelude: BLUR_GLSL,
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'radius', label: 'Radius (px @1K)', type: 'float', min: 0, max: 96, step: 0.5, def: 6 }
    ],
    passes: [
      { body: /* glsl */ `
        vec4 nodeColor(vec2 uv) {
          float rad = max(u_radius * uRes.x / 1024.0, 0.0);
          return blurDir(uIn_input, uv, vec2(1.0, 0.0), rad);
        }` },
      { body: /* glsl */ `
        vec4 nodeColor(vec2 uv) {
          float rad = max(u_radius * uRes.x / 1024.0, 0.0);
          return blurDir(uPrev, uv, vec2(0.0, 1.0), rad);
        }` }
    ]
  },
  /**
   * 方向模糊（运动 / 拉丝效果）。
   *
   * 算法：沿 angle 方向在 ±length/2 的范围内均匀取 samples 个样本，用中间高、
   * 两端低的三角权重叠加，得到带方向性的拖影。length 同样按 1K 分辨率归一化。
   *
   * 参数：
   *  - angle：模糊方向（0~360°）；
   *  - length：拖影长度（0~128 px @1K）；
   *  - samples：采样数量（2~32），越多越平滑但越慢。
   */
  {
    type: 'directional_blur',
    name: 'Directional Blur',
    category: 'Filter',
    space: 'data',
    desc: 'Streaked blur along an angle (motion / brushed looks).',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'angle', label: 'Angle', type: 'angle', min: 0, max: 360, step: 1, def: 0 },
      { key: 'length', label: 'Length (px @1K)', type: 'float', min: 0, max: 128, step: 1, def: 16 },
      { key: 'samples', label: 'Samples', type: 'int', min: 2, max: 32, def: 12 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float len = u_length * uRes.x / 1024.0;
        vec2 dir = vec2(cos(u_angle), sin(u_angle));
        vec4 sum = vec4(0.0);
        float wsum = 0.0;
        for (int i = 0; i < 32; i++) {
          if (i >= u_samples) break;
          float t = (float(i) / max(float(u_samples - 1), 1.0) - 0.5) * len;
          float w = 1.0 - abs(float(i) / max(float(u_samples - 1), 1.0) * 2.0 - 1.0) * 0.6;
          sum += texture(uIn_input, uv + dir * t * uPx) * w;
          wsum += w;
        }
        return sum / max(wsum, 1e-5);
      }`
  },
  /**
   * 锐化（反锐化掩模，Unsharp Mask）。
   *
   * 算法：用上下左右四个邻居的平均值作为模糊版本 b，再按
   * c + (c - b) * amount 增强高频，即「原图减去模糊图」得到细节并加回原图。
   *
   * 参数：
   *  - amount：锐化强度（0~4）；
   *  - radius：采样偏移半径（0.5~8 px）。
   */
  {
    type: 'sharpen',
    name: 'Sharpen',
    category: 'Filter',
    space: 'data',
    desc: 'Unsharp-mask sharpening.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'amount', label: 'Amount', type: 'float', min: 0, max: 4, step: 0.01, def: 1 },
      { key: 'radius', label: 'Radius (px)', type: 'float', min: 0.5, max: 8, step: 0.5, def: 1.5 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 r = uPx * u_radius;
        vec4 c = texture(uIn_input, uv);
        vec4 b = (texture(uIn_input, uv + vec2(r.x, 0.0)) + texture(uIn_input, uv - vec2(r.x, 0.0)) +
                  texture(uIn_input, uv + vec2(0.0, r.y)) + texture(uIn_input, uv - vec2(0.0, r.y))) * 0.25;
        return vec4(sat3(c.rgb + (c.rgb - b.rgb) * u_amount), c.a);
      }`
  },
  /**
   * 高反差保留（High Pass）。
   *
   * 算法：与锐化相同的四邻域模糊，但输出的是以 0.5 灰为中心的高频残差
   * (c - b) * amount，可作为叠加图层或后续混合的高频细节源。
   *
   * 参数：
   *  - amount：细节增益（0.1~6）；
   *  - radius：采样偏移半径（0.5~16 px）。
   */
  {
    type: 'highpass',
    name: 'High Pass',
    category: 'Filter',
    space: 'data',
    desc: 'Extract high frequency detail around 0.5 grey.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'amount', label: 'Amount', type: 'float', min: 0.1, max: 6, step: 0.01, def: 2 },
      { key: 'radius', label: 'Radius (px)', type: 'float', min: 0.5, max: 16, step: 0.5, def: 2 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 r = uPx * u_radius;
        vec4 c = texture(uIn_input, uv);
        vec4 b = (texture(uIn_input, uv + vec2(r.x, 0.0)) + texture(uIn_input, uv - vec2(r.x, 0.0)) +
                  texture(uIn_input, uv + vec2(0.0, r.y)) + texture(uIn_input, uv - vec2(0.0, r.y))) * 0.25;
        return vec4(sat3(0.5 + (c.rgb - b.rgb) * u_amount), 1.0);
      }`
  },
  /**
   * 浮雕（方向导数）。
   *
   * 算法：沿 angle 方向取前后两个采样点的亮度差，乘以 strength 后以 0.5 为中心输出，
   * 得到类似斜向光照下的凸起 / 凹陷效果，常用于倒角与划痕。
   *
   * 参数：
   *  - angle：光照 / 导数方向（0~360°）；
   *  - radius：采样距离（0.5~16 px）；
   *  - strength：浮雕强度（0~4）。
   */
  {
    type: 'emboss',
    name: 'Emboss',
    category: 'Filter',
    space: 'data',
    desc: 'Directional derivative emboss used for bevels and scratches.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'angle', label: 'Angle', type: 'angle', min: 0, max: 360, step: 1, def: 45 },
      { key: 'radius', label: 'Radius (px)', type: 'float', min: 0.5, max: 16, step: 0.5, def: 1.5 },
      { key: 'strength', label: 'Strength', type: 'float', min: 0, max: 4, step: 0.01, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 dir = vec2(cos(u_angle), sin(u_angle));
        vec2 r = uPx * u_radius;
        float a = luma(texture(uIn_input, uv + dir * r).rgb);
        float b = luma(texture(uIn_input, uv - dir * r).rgb);
        float v = sat(0.5 + (a - b) * u_strength * 4.0);
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 形变 / 置换（Warp）。
   *
   * 算法：读取 warper 输入的 R/G 通道，映射到 [-1, 1] 后乘以 intensity 与 0.12
   * 作为 UV 偏移量，再去采样 input。0.12 是一个经验缩放，保证最大强度下形变不至于
   * 采样到完全无关的区域。
   *
   * 参数：
   *  - intensity：形变强度（-4~4，负值反向）；
   *  - offset：采样结果的亮度偏移（-1~1）。
   * 输入：input 被形变的图像、warper 偏移场（RG 编码）。
   */
  {
    type: 'warp',
    name: 'Warp',
    category: 'Filter',
    space: 'data',
    desc: 'Displace a stream using the RG vector of a warper input.',
    inputs: [
      { name: 'input', label: 'Input', def: 0.5 },
      { name: 'warper', label: 'Warper', def: 0.5 }
    ],
    params: [
      { key: 'intensity', label: 'Intensity', type: 'float', min: -4, max: 4, step: 0.01, def: 1 },
      { key: 'offset', label: 'Offset', type: 'float', min: -1, max: 1, step: 0.01, def: 0 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 w = texture(uIn_warper, uv);
        vec2 off = (w.rg * 2.0 - 1.0) * u_intensity * 0.12;
        vec4 c = texture(uIn_input, uv + off);
        c.rgb = sat3(c.rgb + u_offset);
        return c;
      }`
  },
  /**
   * 色阶（Levels）。
   *
   * 算法：先按 inLow / inHigh 拉伸输入范围并钳到 0~1，再施加 gamma（pow 1/gamma），
   * 最后映射到 outLow / outHigh。等价于 Photoshop 的「输入色阶 / 灰度系数 / 输出色阶」。
   *
   * 参数：
   *  - inLow / inHigh：输入黑场 / 白场（-0.5~1.5，允许超出正常范围做裁切）；
   *  - gamma：中间调亮度（0.1~4，>1 变亮）；
   *  - outLow / outHigh：输出黑场 / 白场（0~1）。
   */
  {
    type: 'levels',
    name: 'Levels',
    category: 'Adjust',
    space: 'data',
    desc: 'Remap input/output levels with gamma.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'inLow', label: 'In Low', type: 'float', min: -0.5, max: 1.5, step: 0.005, def: 0 },
      { key: 'inHigh', label: 'In High', type: 'float', min: -0.5, max: 1.5, step: 0.005, def: 1 },
      { key: 'gamma', label: 'Gamma', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'outLow', label: 'Out Low', type: 'float', min: 0, max: 1, step: 0.005, def: 0 },
      { key: 'outHigh', label: 'Out High', type: 'float', min: 0, max: 1, step: 0.005, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 c = texture(uIn_input, uv);
        vec3 x = sat3((c.rgb - u_inLow) / max(u_inHigh - u_inLow, 1e-4));
        x = pow(x, vec3(1.0 / max(u_gamma, 1e-3)));
        x = u_outLow + x * (u_outHigh - u_outLow);
        return vec4(sat3(x), c.a);
      }`
  },
  /**
   * 直方图扫描（Histogram Scan）。
   *
   * 算法：对输入取亮度后，在 position ± width 区间内做 smoothstep 得到平滑的
   * 黑白过渡。可把它理解为「可调软硬度的阈值」。width 下限还取 uPx.x，
   * 保证在低分辨率下不会出现锯齿。
   *
   * 参数：
   *  - position：阈值位置（0~1）；
   *  - width：过渡宽度 / 对比度（0.004~0.5，越小越硬）；
   *  - invert：反相。
   */
  {
    type: 'histogram_scan',
    name: 'Histogram Scan',
    category: 'Adjust',
    space: 'data',
    desc: 'Smooth threshold / contrast control around a position.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'position', label: 'Position', type: 'float', min: 0, max: 1, step: 0.005, def: 0.5 },
      { key: 'width', label: 'Contrast', type: 'float', min: 0.004, max: 0.5, step: 0.002, def: 0.08 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float v = luma(texture(uIn_input, uv).rgb);
        float w = max(u_width, uPx.x);
        float t = smoothstep(u_position - w, u_position + w, v);
        if (u_invert) t = 1.0 - t;
        return vec4(vec3(t), 1.0);
      }`
  },
  /**
   * 通道反相。
   * 每个布尔参数单独控制 R / G / B / A 是否取反（默认只反 RGB，不反透明度）。
   */
  {
    type: 'invert',
    name: 'Invert',
    category: 'Adjust',
    space: 'data',
    desc: 'Invert selected channels.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'r', label: 'Invert R', type: 'bool', def: true },
      { key: 'g', label: 'Invert G', type: 'bool', def: true },
      { key: 'b', label: 'Invert B', type: 'bool', def: true },
      { key: 'a', label: 'Invert Alpha', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 c = texture(uIn_input, uv);
        if (u_r) c.r = 1.0 - c.r;
        if (u_g) c.g = 1.0 - c.g;
        if (u_b) c.b = 1.0 - c.b;
        if (u_a) c.a = 1.0 - c.a;
        return c;
      }`
  },
  /**
   * HSL 调整。
   *
   * 算法：把 RGB 转成 HSV 后，色相按 hue 旋转（以 TAU 归一化并取小数），
   * 饱和度乘以 saturation，明度加减 lightness，最后转回 RGB。
   * 使用 space: 'color'，因此颜色按 sRGB 语义处理。
   *
   * 参数：
   *  - hue：色相偏移（-180~180°）；
   *  - saturation：饱和度倍数（0~3，0 = 灰度，>1 更艳）；
   *  - lightness：明度偏移（-0.6~0.6）。
   */
  {
    type: 'hsl',
    name: 'HSL',
    category: 'Adjust',
    space: 'color',
    desc: 'Hue rotate, saturation and lightness shift.',
    prelude: HSV_GLSL,
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'hue', label: 'Hue Shift', type: 'angle', min: -180, max: 180, step: 1, def: 0 },
      { key: 'saturation', label: 'Saturation', type: 'float', min: 0, max: 3, step: 0.01, def: 1 },
      { key: 'lightness', label: 'Lightness', type: 'float', min: -0.6, max: 0.6, step: 0.005, def: 0 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 c = texture(uIn_input, uv);
        vec3 hsv = rgb2hsv(c.rgb);
        hsv.x = fract(hsv.x + u_hue / TAU);
        hsv.y = sat(hsv.y * u_saturation);
        hsv.z = sat(hsv.z + u_lightness);
        return vec4(hsv2rgb(hsv), c.a);
      }`
  },
  /**
   * 渐变映射（Gradient Map）。
   *
   * 算法：取输入亮度作为渐变参数 t，经 contrast（以 0.5 为中心）与 offset 调整后，
   * 用 sampleGradient(t) 在用户编辑的多色标渐变中取色，实现「黑白 → 彩色」的重着色。
   *
   * 参数：
   *  - gradient：色标数组（{ p: 0~1, c: 颜色 }）；
   *  - contrast：对比度（0.1~4）；
   *  - offset：亮度偏移（-1~1）；
   *  - invert：反相。
   */
  {
    type: 'gradient_map',
    name: 'Gradient Map',
    category: 'Color',
    space: 'color',
    desc: 'Map luminance through an editable gradient ramp.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'gradient', label: 'Colors', type: 'gradient', def: [
        { p: 0, c: '#0c0e12' }, { p: 0.45, c: '#6b5747' }, { p: 0.8, c: '#c9b79a' }, { p: 1, c: '#ffffff' }
      ] },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 },
      { key: 'offset', label: 'Offset', type: 'float', min: -1, max: 1, step: 0.01, def: 0 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float t = luma(texture(uIn_input, uv).rgb);
        t = sat((t - 0.5) * u_contrast + 0.5 + u_offset);
        if (u_invert) t = 1.0 - t;
        return sampleGradient(t);
      }`
  },
  /**
   * 高度图 → 切线空间法线。
   *
   * 算法：用中心差分计算高度梯度 (hL-hR, hD-hU)，按采样半径与强度归一化后
   * 组成向量 (dx, dy, 1) 并归一化；输出编码为 n * 0.5 + 0.5（即 RGB 贴图格式）。
   * directx 选项翻转 Y 分量，以适配 DirectX 的 -Y 法线约定（OpenGL 默认 +Y）。
   *
   * 参数：
   *  - intensity：法线强度（0.01~8）；
   *  - radius：采样半径（0.5~8 px）；
   *  - directx：DirectX (-Y) 模式。
   */
  {
    type: 'normal',
    name: 'Normal',
    category: 'Normal',
    space: 'data',
    desc: 'Height to tangent-space normal map (OpenGL / DirectX).',
    inputs: [{ name: 'height', label: 'Height', def: 0.5 }],
    params: [
      { key: 'intensity', label: 'Intensity', type: 'float', min: 0.01, max: 8, step: 0.01, def: 1 },
      { key: 'radius', label: 'Sample Radius (px)', type: 'float', min: 0.5, max: 8, step: 0.5, def: 1 },
      { key: 'directx', label: 'DirectX (-Y)', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 r = uPx * u_radius;
        float hL = texture(uIn_height, uv - vec2(r.x, 0.0)).r;
        float hR = texture(uIn_height, uv + vec2(r.x, 0.0)).r;
        float hD = texture(uIn_height, uv - vec2(0.0, r.y)).r;
        float hU = texture(uIn_height, uv + vec2(0.0, r.y)).r;
        float k = 0.5 * u_intensity / max(u_radius, 0.5);
        vec3 n = normalize(vec3((hL - hR) * uRes.x * k, (hD - hU) * uRes.y * k, 1.0));
        if (u_directx) n.y = -n.y;
        return vec4(n * 0.5 + 0.5, 1.0);
      }`
  },
  /**
   * 环境光遮蔽（AO）。
   *
   * 算法：以当前像素为基准，用「黄金角螺旋」（fi * 2.39996323）在半径内均匀取
   * samples 个点；若邻域高度高于当前点则累计遮蔽量，并用随距离衰减的权重加权。
   * 最终 ao = 1 - 遮蔽量 * intensity * 4，数值越低越暗。
   *
   * 参数：
   *  - radius：采样半径（0.005~0.5，UV 比例）；
   *  - intensity：遮蔽强度（0~6）；
   *  - samples：采样数（4~24）；
   *  - heightScale：高度缩放（0.1~4）。
   */
  {
    type: 'ao',
    name: 'Ambient Occlusion',
    category: 'Normal',
    space: 'data',
    desc: 'Height based AO with poisson spiral sampling.',
    inputs: [{ name: 'height', label: 'Height', def: 0.5 }],
    params: [
      { key: 'radius', label: 'Radius', type: 'float', min: 0.005, max: 0.5, step: 0.005, def: 0.08 },
      { key: 'intensity', label: 'Intensity', type: 'float', min: 0, max: 6, step: 0.01, def: 1.6 },
      { key: 'samples', label: 'Samples', type: 'int', min: 4, max: 24, def: 12 },
      { key: 'heightScale', label: 'Height Scale', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float h0 = texture(uIn_height, uv).r * u_heightScale;
        float occ = 0.0, wsum = 0.0;
        for (int i = 0; i < 24; i++) {
          if (i >= u_samples) break;
          float fi = float(i) + 0.5;
          float ang = fi * 2.39996323;
          float rad = sqrt(fi / float(u_samples)) * u_radius;
          float w = exp(-rad / max(u_radius, 1e-3) * 2.0);
          float h = texture(uIn_height, uv + vec2(cos(ang), sin(ang)) * rad).r * u_heightScale;
          occ += max(0.0, h - h0) * w;
          wsum += w;
        }
        float ao = sat(1.0 - (occ / max(wsum, 1e-5)) * u_intensity * 4.0);
        return vec4(vec3(ao), 1.0);
      }`
  },
  /**
   * 曲率（基于拉普拉斯算子）。
   *
   * 算法：用上下左右四邻域计算离散拉普拉斯 lap = (l + r + d + u - 4h) * intensity * 40；
   * 凸起处 lap 为正、凹陷处为负。Both 模式输出以 0.5 为中心的正负曲率，
   * Convex / Concave 模式则只保留正 / 负部分。
   *
   * 参数：
   *  - radius：采样半径（0.5~24 px）；
   *  - intensity：曲率放大倍数（0.05~6）；
   *  - mode：Both / Convex Only / Concave Only；
   *  - invert：反相。
   */
  {
    type: 'curvature',
    name: 'Curvature',
    category: 'Normal',
    space: 'data',
    desc: 'Convex / concave curvature from height (laplacian).',
    inputs: [{ name: 'height', label: 'Height', def: 0.5 }],
    params: [
      { key: 'radius', label: 'Radius (px)', type: 'float', min: 0.5, max: 24, step: 0.5, def: 2 },
      { key: 'intensity', label: 'Intensity', type: 'float', min: 0.05, max: 6, step: 0.01, def: 1 },
      { key: 'mode', label: 'Mode', type: 'select', options: ['Both', 'Convex Only', 'Concave Only'], def: 0 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 r = uPx * u_radius;
        float h = texture(uIn_height, uv).r;
        float l = texture(uIn_height, uv - vec2(r.x, 0.0)).r;
        float rr = texture(uIn_height, uv + vec2(r.x, 0.0)).r;
        float d = texture(uIn_height, uv - vec2(0.0, r.y)).r;
        float u = texture(uIn_height, uv + vec2(0.0, r.y)).r;
        float lap = (l + rr + d + u - 4.0 * h) * u_intensity * 40.0;
        float v = sat(0.5 + lap);
        if (u_mode == 1) v = sat(lap * 2.0);
        else if (u_mode == 2) v = sat(-lap * 2.0);
        if (u_invert) v = 1.0 - v;
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 边缘检测（Sobel 算子）。
   *
   * 算法：对 3×3 邻域的亮度采样，分别计算水平梯度 gx 与垂直梯度 gy，
   * 再取梯度幅值 length(gx, gy) * strength 作为边缘强度。
   *
   * 参数：
   *  - strength：边缘增益（0.1~8）；
   *  - radius：采样偏移（0.5~4 px）；
   *  - invert：反相（白底黑线 / 黑底白线互换）。
   */
  {
    type: 'edges',
    name: 'Edge Detect',
    category: 'Filter',
    space: 'data',
    desc: 'Sobel edge / crease extraction.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'strength', label: 'Strength', type: 'float', min: 0.1, max: 8, step: 0.01, def: 2 },
      { key: 'radius', label: 'Radius (px)', type: 'float', min: 0.5, max: 4, step: 0.5, def: 1 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 r = uPx * u_radius;
        float lu = luma(texture(uIn_input, uv + vec2(-r.x, r.y)).rgb);
        float u  = luma(texture(uIn_input, uv + vec2(0.0, r.y)).rgb);
        float ru = luma(texture(uIn_input, uv + vec2( r.x, r.y)).rgb);
        float l  = luma(texture(uIn_input, uv + vec2(-r.x, 0.0)).rgb);
        float rr = luma(texture(uIn_input, uv + vec2( r.x, 0.0)).rgb);
        float ld = luma(texture(uIn_input, uv + vec2(-r.x, -r.y)).rgb);
        float d  = luma(texture(uIn_input, uv + vec2(0.0, -r.y)).rgb);
        float rd = luma(texture(uIn_input, uv + vec2( r.x, -r.y)).rgb);
        float gx = (ru + 2.0 * rr + rd) - (lu + 2.0 * l + ld);
        float gy = (lu + 2.0 * u + ru) - (ld + 2.0 * d + rd);
        float g = sat(length(vec2(gx, gy)) * u_strength);
        if (u_invert) g = 1.0 - g;
        return vec4(vec3(g), 1.0);
      }`
  },
  /**
   * 形态学膨胀 / 腐蚀。
   *
   * 算法：两遍可分离实现——先在 X 方向沿线取 max（膨胀）或 min（腐蚀），
   * 再在 Y 方向对上一遍结果做同样操作。等价于半径为 radius 的方形结构元素。
   * radius 以 1K 分辨率为基准缩放。
   *
   * 参数：
   *  - radius：结构元素半径（0.5~48 px @1K）；
   *  - mode：Dilate (Grow) 膨胀 / Erode (Shrink) 腐蚀。
   */
  {
    type: 'morphology',
    name: 'Morphology',
    category: 'Filter',
    space: 'data',
    desc: 'Separable dilate / erode (grow or shrink shapes).',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'radius', label: 'Radius (px @1K)', type: 'float', min: 0.5, max: 48, step: 0.5, def: 3 },
      { key: 'mode', label: 'Mode', type: 'select', options: ['Dilate (Grow)', 'Erode (Shrink)'], def: 0 }
    ],
    passes: [
      { body: /* glsl */ `
        vec4 nodeColor(vec2 uv) {
          float rad = max(u_radius * uRes.x / 1024.0, 0.5);
          int taps = int(clamp(ceil(rad), 1.0, 48.0));
          float v = luma(texture(uIn_input, uv).rgb);
          for (int i = 1; i <= 48; i++) {
            if (i > taps) break;
            float a = luma(texture(uIn_input, uv + vec2(uPx.x * float(i), 0.0)).rgb);
            float b = luma(texture(uIn_input, uv - vec2(uPx.x * float(i), 0.0)).rgb);
            v = (u_mode == 0) ? max(v, max(a, b)) : min(v, min(a, b));
          }
          return vec4(vec3(v), 1.0);
        }` },
      { body: /* glsl */ `
        vec4 nodeColor(vec2 uv) {
          float rad = max(u_radius * uRes.y / 1024.0, 0.5);
          int taps = int(clamp(ceil(rad), 1.0, 48.0));
          float v = luma(texture(uPrev, uv).rgb);
          for (int i = 1; i <= 48; i++) {
            if (i > taps) break;
            float a = luma(texture(uPrev, uv + vec2(0.0, uPx.y * float(i))).rgb);
            float b = luma(texture(uPrev, uv - vec2(0.0, uPx.y * float(i))).rgb);
            v = (u_mode == 0) ? max(v, max(a, b)) : min(v, min(a, b));
          }
          return vec4(vec3(v), 1.0);
        }` }
    ]
  },
  /**
   * 去色（转灰度数据流）。
   *
   * 参数 mode 决定权重算法：
   *  - Luminance (Rec.709)：按人眼感知亮度加权（默认，最自然）；
   *  - Average：RGB 算术平均；
   *  - Max / Min：取三通道最大 / 最小值。
   */
  {
    type: 'grayscale',
    name: 'Desaturate',
    category: 'Adjust',
    space: 'data',
    desc: 'Convert color to a single luminance data stream.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'mode', label: 'Weights', type: 'select', options: ['Luminance (Rec.709)', 'Average', 'Max', 'Min'], def: 0 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec3 c = texture(uIn_input, uv).rgb;
        float v;
        if (u_mode == 0) v = luma(c);
        else if (u_mode == 1) v = (c.r + c.g + c.b) / 3.0;
        else if (u_mode == 2) v = max(c.r, max(c.g, c.b));
        else v = min(c.r, min(c.g, c.b));
        return vec4(vec3(v), 1.0);
      }`
  },
  /**
   * 阈值（硬 / 软二值化蒙版）。
   *
   * 算法：对亮度在 threshold ± softness 区间做 smoothstep；softness 最低取一个像素
   * 宽度，避免低分辨率下出现阶梯锯齿。
   *
   * 参数：
   *  - threshold：阈值（0~1）；
   *  - softness：过渡宽度（0~0.5）；
   *  - invert：反相。
   */
  {
    type: 'threshold',
    name: 'Threshold',
    category: 'Adjust',
    space: 'data',
    desc: 'Hard or soft threshold mask.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'threshold', label: 'Threshold', type: 'float', min: 0, max: 1, step: 0.005, def: 0.5 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0, max: 0.5, step: 0.002, def: 0.02 },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float v = luma(texture(uIn_input, uv).rgb);
        float w = max(u_softness, uPx.x);
        float t = smoothstep(u_threshold - w, u_threshold + w, v);
        if (u_invert) t = 1.0 - t;
        return vec4(vec3(t), 1.0);
      }`
  },
  /**
   * 色阶简化（Posterize）。
   *
   * 算法：把 0~1 的通道值量化到 steps 个等级：
   * floor(c * (steps - 1) + 0.5) / (steps - 1)，即四舍五入到最近的等级。
   *
   * 参数：steps 等级数（2~32）。
   */
  {
    type: 'posterize',
    name: 'Posterize',
    category: 'Adjust',
    space: 'data',
    desc: 'Quantize values into bands.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'steps', label: 'Steps', type: 'int', min: 2, max: 32, def: 6 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec4 c = texture(uIn_input, uv);
        float n = max(2.0, float(u_steps));
        vec3 q = floor(c.rgb * (n - 1.0) + 0.5) / (n - 1.0);
        return vec4(sat3(q), c.a);
      }`
  },
  /**
   * 2D 变换（平移 / 旋转 / 缩放）。
   *
   * 算法：以 UV 中心为原点，先减去 offset，再旋转 rotation，最后按 scale 缩放并
   * 移回中心；采样直接使用纹理的 repeat 包裹，因此平铺图变换后仍无缝。
   *
   * 参数：
   *  - offset：平移量（vec2，-1~1）；
   *  - rotation：旋转角（-180~180°）；
   *  - scale：缩放（vec2，0.1~8）。
   */
  {
    type: 'transform',
    name: 'Transform 2D',
    category: 'Filter',
    space: 'data',
    desc: 'Offset / rotate / scale a stream (tiled wrap sampling).',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'offset', label: 'Offset', type: 'vec2', min: -1, max: 1, step: 0.005, def: [0, 0] },
      { key: 'rotation', label: 'Rotation', type: 'angle', min: -180, max: 180, step: 1, def: 0 },
      { key: 'scale', label: 'Scale', type: 'vec2', min: 0.1, max: 8, step: 0.01, def: [1, 1] }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 p = uv - 0.5 - u_offset;
        p = rot2(p, u_rotation);
        p = p / max(u_scale, vec2(1e-3)) + 0.5;
        return texture(uIn_input, p);
      }`
  },
  /**
   * 通道合并。
   *
   * 用途：把不同数据流的通道打包成一张图，例如 R=AO、G=Roughness、B=Metallic。
   * 算法：分别从三个输入中按 chR / chG / chB 指定的通道（R/G/B/A）取值，组成新 RGB，
   * 透明度固定为 1。
   *
   * 参数：
   *  - chR / chG / chB：每个输入要取用的通道（默认 R/G/B）。
   * 输入：r / g / b 三个数据源（同一条流可重复接入）。
   */
  {
    type: 'channels',
    name: 'Channel Combine',
    category: 'Color',
    space: 'data',
    desc: 'Build a stream by picking R/G/B/A from three inputs.',
    inputs: [
      { name: 'r', label: 'R Source', def: 0 },
      { name: 'g', label: 'G Source', def: 0 },
      { name: 'b', label: 'B Source', def: 0 }
    ],
    params: [
      { key: 'chR', label: 'R Channel', type: 'select', options: ['R', 'G', 'B', 'A'], def: 0 },
      { key: 'chG', label: 'G Channel', type: 'select', options: ['R', 'G', 'B', 'A'], def: 1 },
      { key: 'chB', label: 'B Channel', type: 'select', options: ['R', 'G', 'B', 'A'], def: 2 }
    ],
    body: /* glsl */ `
      float pick(vec4 c, int ch) {
        if (ch == 0) return c.r;
        if (ch == 1) return c.g;
        if (ch == 2) return c.b;
        return c.a;
      }
      vec4 nodeColor(vec2 uv) {
        vec4 a = texture(uIn_r, uv);
        vec4 b = texture(uIn_g, uv);
        vec4 c = texture(uIn_b, uv);
        return vec4(pick(a, u_chR), pick(b, u_chG), pick(c, u_chB), 1.0);
      }`
  },
  {
    type: 'seamless_tile',
    name: 'Seamless Tile',
    category: 'Filter',
    space: 'color',
    desc: 'Feather, wrap-blend or mirror the borders so a photo repeats without a visible seam.',
    inputs: [{ name: 'input', label: 'Input', def: 0.5 }],
    params: [
      { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
      // mode：接缝处理算法（0 边缘羽化 / 1 镜像 / 2 偏移交叉融合）
      { key: 'mode', label: 'Mode', type: 'select', options: ['Edge Blend', 'Mirror', 'Wrap Blend (Offset)'], def: 0 },
      // curve：羽化曲线（0 余弦 / 1 smoothstep / 2 线性），仅对模式 0、2 生效
      { key: 'curve', label: 'Feather Curve', type: 'select', options: ['Cosine (Hann)', 'Smoothstep', 'Linear'], def: 0 },
      // band：羽化带宽度，取归一化 UV 比例（0.005 = 0.5%，0.25 = 25%）
      { key: 'band', label: 'Blend Width', type: 'float', min: 0.005, max: 0.25, step: 0.001, def: 0.08 }
    ],
    // 三种主流的接缝处理方案，全部做成可分离的两遍运算，所以一个 Pass 就能算完：
    //
    //  • 0 边缘羽化（Edge Blend）：把左右两侧的贴边像素按羽化曲线向“两者的平均值”靠拢，
    //    再把上下两侧同理处理。这是 GIMP「Make Seamless」等无缝插件使用的经典做法；
    //    边界被压成同一颜色，绝对无缝，代价是羽化带内的高频细节会被均值抹平。
    //
    //  • 2 偏移交叉融合（Wrap Blend / Offset）：把画面与“水平和垂直各偏移半幅”的副本
    //    按羽化曲线交叉淡化，等价于 Photoshop 的 Offset 修复接缝流程。它混合的是真实纹理
    //    而不是均值，因此细节保留更好；但过渡带内两段不同的内容叠加，可能出现轻微重影。
    //    边界处权重为 1、完全取偏移副本，由于偏移副本在两端取值相同，平铺时依然无缝。
    //
    //  • 1 镜像（Mirror）：以画面中心镜像铺满，不羽化。边界天然重复、绝对无缝，
    //    但能明显看出对称重复（类似万花筒）。
    //
    // 羽化曲线（curve）是对“到边界距离”的权重映射：余弦（Hann 窗）两端导数为 0、最柔和；
    // Hermite smoothstep 同为 S 形但中段更陡；线性过渡带边缘会留下轻微折痕。
    //
    // 说明：论文中的重量级合成算法（Efros & Freeman 图像拼贴 2001、Kwatra 等 Graphcut
    // Textures 2003、Pérez 等泊松图像编辑 2003）需要多遍 CPU 搜索/求解，无法在片元着色器
    // 里逐像素完成，因此本节点只提供上面三种实时可调的方案。
    //
    // 注意：这里的公式必须与 src/engine/seamless.js 的 CPU 预览实现保持一致。
    prelude: /* glsl */ `
      // weight curve: 1 at the border, 0 once the band is reached
      float featherCurve(float t) {
        float e = clamp(t / max(u_band, 1e-4), 0.0, 1.0);
        if (u_curve == 1) {
          float x = 1.0 - e;
          return x * x * (3.0 - 2.0 * x);
        }
        if (u_curve == 2) return 1.0 - e;
        return 0.5 + 0.5 * cos(PI * e);
      }

      // edgeW(t)：拿到边界距离 t（0..1）对应的羽化权重；中间区域返回 0（完全不处理）
      float edgeW(float t) {
        float b = max(u_band, 1e-4);
        if (t < b) return featherCurve(t);
        if (t > 1.0 - b) return featherCurve(1.0 - t);
        return 0.0;
      }

      // horizontal pass, mode 0: blend each row towards the average of its two border pixels.
      // Half-texel offsets keep the sampled edge pixel inside the texture instead of wrapping.
      vec4 seamH(vec2 uv) {
        vec4 c = texture(uIn_input, uv);
        vec4 mid = (
          texture(uIn_input, vec2(0.5 * uPx.x, uv.y)) +
          texture(uIn_input, vec2(1.0 - 0.5 * uPx.x, uv.y))
        ) * 0.5;
        return mix(c, mid, edgeW(uv.x));
      }

      // horizontal pass, mode 2: cross-fade into the copy shifted by half a tile in x.
      vec4 wrapH(vec2 uv) {
        return mix(
          texture(uIn_input, uv),
          texture(uIn_input, vec2(uv.x + 0.5, uv.y)),
          edgeW(uv.x)
        );
      }`,
    // 逐像素求值：关闭时直接采样原图；镜像模式折叠坐标；
    // 其余模式先算水平羽化 seamH/wrapH，再用“上下边界行”的同一函数结果做垂直羽化，
    // 与 CPU 版的两遍可分离处理一一对应（先横后纵）。
    // 注意：uCurve 只影响权重曲线，不改变“向哪个目标混合”。
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        if (!u_enabled) return texture(uIn_input, uv);
        // mode 1: mirror around the tile centre. Both tile edges sample the same
        // source line, so the repeat is continuous by construction.
        if (u_mode == 1) {
          vec2 p = vec2(
            uv.x < 0.5 ? uv.x + 0.5 : 1.5 - uv.x,
            uv.y < 0.5 ? uv.y + 0.5 : 1.5 - uv.y
          );
          return texture(uIn_input, p);
        }
        // vertical feather weight (0 in the middle of the tile)
        float wy = edgeW(uv.y);
        // mode 2: cross-fade with the half-shifted copy on both axes.
        if (u_mode == 2) {
          return mix(
            wrapH(uv),
            wrapH(vec2(uv.x, uv.y + 0.5)),
            wy
          );
        }
        // mode 0: vertical average of the already horizontally feathered top/bottom rows.
        vec4 h = seamH(uv);
        vec4 vmid = (
          seamH(vec2(uv.x, 0.5 * uPx.y)) +
          seamH(vec2(uv.x, 1.0 - 0.5 * uPx.y))
        ) * 0.5;
        return mix(h, vmid, wy);
      }`
  }
]
