/**
 * 材质图案节点定义：面向具体材质的程序化表面（木板、毛皮、草地、塑料、麻布、织物、
 * 皮革、混凝土）。所有图案都用可平铺（periodic）的噪声实现，因此 UV 0~1 边界处
 * 能精确无缝拼接。
 *
 * 这些节点默认输出颜色（space: 'color'）。同一套图案还提供 Height 模式，
 * 可直接作为凹凸 / 高度源使用，无需再额外接一个转换节点。
 *
 * 约定：GLSL 源码保持英文注释，节点定义的 JS 侧用中文说明算法与参数范围。
 */
export const patternDefs = [
  /**
   * 木板（错缝拼接）。
   *
   * 算法：把 UV 按 rows × columns 分成板格并做行间错位；每块板用哈希取颜色差异，
   * 再用两层 fbm 扭曲生成顺纹木纹，叠加正弦环纹与随机节疤；板缝用 SDF 软边留出。
   *
   * 参数：
   *  - rows / columns：纵向板数（2~12）/ 横向板数（1~8）；
   *  - gap：板缝宽度（0~0.08）；
   *  - bevel：板边倒角，仅 Height 模式有意义（0.01~0.25）；
   *  - grain：木纹频率（1~12）；
   *  - rings：环纹强度（0~1）；
   *  - knots：节疤出现概率（0~1）；
   *  - variation：每块板颜色随机差异（0~1）；
   *  - mode：Color 颜色 / Height 高度；
   *  - colorA / colorB / gapColor：浅木色 / 深木色 / 板缝颜色；
   *  - seed：随机种子。
   */
  {
    type: 'wood_planks',
    name: 'Wood Planks',
    category: 'Pattern',
    space: 'color',
    desc: 'Running-bond wood planks with per-board tint, grain, rings and knots.',
    inputs: [],
    params: [
      { key: 'rows', label: 'Rows', type: 'int', min: 2, max: 12, def: 5 },
      { key: 'columns', label: 'Columns', type: 'int', min: 1, max: 8, def: 2 },
      { key: 'gap', label: 'Gap', type: 'float', min: 0, max: 0.08, step: 0.002, def: 0.012 },
      { key: 'bevel', label: 'Bevel (height)', type: 'float', min: 0.01, max: 0.25, step: 0.005, def: 0.07 },
      { key: 'grain', label: 'Grain Scale', type: 'float', min: 1, max: 12, step: 1, def: 4 },
      { key: 'rings', label: 'Rings', type: 'float', min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: 'knots', label: 'Knots', type: 'float', min: 0, max: 1, step: 0.01, def: 0.25 },
      { key: 'variation', label: 'Color Variation', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Wood Light', type: 'color', def: '#b98555' },
      { key: 'colorB', label: 'Wood Dark', type: 'color', def: '#5c361d' },
      { key: 'gapColor', label: 'Gap Color', type: 'color', def: '#21140c' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 11 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float rows = max(1.0, float(u_rows));
        float cols = max(1.0, float(u_columns));
        float grainFreq = max(1.0, floor(u_grain + 0.5));
        vec2 p = vec2(uv.x * cols, uv.y * rows);
        float row = floor(p.y);
        float rowSeed = hash1(vec2(mod(row, rows), 3.0), u_seed);
        p.x += rowSeed * 0.65;
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        vec3 cellHash = hash3(mod(cell, vec2(cols, rows)), u_seed + 2.0);
        vec2 hs = vec2(0.5 - u_gap, 0.5 - u_gap);
        float dx = abs(f.x) - hs.x;
        float dy = abs(f.y) - hs.y;
        float d = max(dx, dy);
        float aa = max(uPx.x, uPx.y) * 2.0 + 1e-4;
        float mask = smoothstep(aa, -aa, d);
        float edge = sat(-d / max(u_bevel, 1e-3));

        float warpA = fbmTiled(vec2(uv.x * 8.0, uv.y * 32.0), 1.0, 3, 0.55, 2.0, u_seed + 4.0) - 0.5;
        float warpB = fbmTiled(vec2(uv.x * 16.0, uv.y * 64.0), 1.0, 3, 0.5, 2.0, u_seed + 5.0) - 0.5;
        float grain = fbmTiled(vec2(uv.x * (16.0 * grainFreq) + warpA * 2.5, uv.y * (96.0 * grainFreq)), 1.0, 5, 0.56, 2.0, u_seed + 6.0);
        float fine = fbmTiled(vec2(uv.x * 128.0, uv.y * 256.0), 1.0, 3, 0.5, 2.0, u_seed + 9.0);
        float gv = sat(smoothstep(0.28, 0.82, grain) * 0.8 + fine * 0.2);
        float ring = sin((uv.y * rows * 7.0 + warpB * 4.0 + grain * 2.0) * TAU);
        ring = smoothstep(0.55, 0.95, ring * 0.5 + 0.5);

        vec2 kc = (hash2(cell, u_seed + 11.0) - 0.5) * 0.45;
        float kd = length((f - kc) * vec2(1.0, 2.4));
        float knotChance = step(1.0 - u_knots, cellHash.y);
        float knot = smoothstep(0.18, 0.015, kd) * knotChance;
        float grainDark = mix(1.0, 0.52, sat(gv * 0.78 + ring * 0.34 * u_rings + knot * 0.65));

        vec3 col = mix(u_colorA.rgb, u_colorB.rgb, sat(0.12 + cellHash.x * u_variation));
        col *= grainDark;
        col *= 0.9 + 0.2 * cellHash.z;
        col *= mix(0.5, 1.08, edge);

        if (u_mode == 1) {
          float h = mask * (0.55 + 0.45 * edge) * (0.82 + 0.18 * grainDark) + gv * 0.08;
          return vec4(vec3(sat(h)), 1.0);
        }
        vec3 gapCol = u_gapColor.rgb * (0.72 + 0.28 * grainDark);
        return vec4(mix(gapCol, col, mask), 1.0);
      }`
  },

  /**
   * 毛皮。
   *
   * 算法：沿指定方向（Vertical / Horizontal）用 fbm 扭曲坐标，生成两套不同宽度的
   * 周期性条纹作为「毛束」与「细毛」；再按纵向渐变混入尖端亮色，形成有方向的毛发。
   *
   * 参数：
   *  - scale：毛束数量（12~96）；
   *  - density：单位面积毛的密度（0.15~1，越大毛束越细越密）；
   *  - length：毛长对颜色/高度的影响强度（0.1~1）；
   *  - clump：毛束成团程度（0~1）；
   *  - direction：毛发生长方向；
   *  - mode：Color / Height；
   *  - colorA / colorB / tipColor：根色 / 中段色 / 毛尖色；
   *  - seed：随机种子。
   */
  {
    type: 'fur',
    name: 'Fur',
    category: 'Pattern',
    space: 'color',
    desc: 'Dense directional fur with clumps, fine strands and lighter tips.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Strands', type: 'int', min: 12, max: 96, def: 40 },
      { key: 'density', label: 'Density', type: 'float', min: 0.15, max: 1, step: 0.01, def: 0.65 },
      { key: 'length', label: 'Strand Length', type: 'float', min: 0.1, max: 1, step: 0.01, def: 0.65 },
      { key: 'clump', label: 'Clump', type: 'float', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'direction', label: 'Direction', type: 'select', options: ['Vertical', 'Horizontal'], def: 0 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Base Color', type: 'color', def: '#2a1a10' },
      { key: 'colorB', label: 'Mid Color', type: 'color', def: '#9b6b42' },
      { key: 'tipColor', label: 'Tip Color', type: 'color', def: '#e2c08d' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 17 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 q = u_direction == 0 ? uv : uv.yx;
        float clumpN = fbmTiled(vec2(q.x * 4.0, q.y * 4.0), 1.0, 4, 0.55, 2.0, u_seed);
        float warp = (clumpN - 0.5) * u_clump * 8.0;
        float fineWarp = fbmTiled(vec2(q.x * 16.0, q.y * 16.0), 1.0, 3, 0.5, 2.0, u_seed + 7.0) - 0.5;
        float across = q.x * float(u_scale) + warp + fineWarp * 2.0;
        float w = mix(0.20, 0.035, u_density);
        float strand1 = smoothstep(w, 0.0, abs(fract(across) - 0.5));
        float strand2 = smoothstep(w * 0.72, 0.0, abs(fract(across * 2.0 + 0.37) - 0.5));
        float strands = sat(strand1 * 0.75 + strand2 * 0.45);

        float lengthN = fbmTiled(vec2(q.x * 8.0, q.y * 24.0), 1.0, 4, 0.55, 2.0, u_seed + 3.0);
        float len = sat(lengthN * 0.65 + u_length * 0.35);
        float tip = smoothstep(0.55, 1.0, q.y * 0.7 + len * 0.45);
        float micro = fbmTiled(vec2(q.x * 96.0, q.y * 32.0), 1.0, 2, 0.5, 2.0, u_seed + 9.0);

        vec3 base = mix(u_colorA.rgb, u_colorB.rgb, sat(clumpN * 0.55 + lengthN * 0.35));
        vec3 col = mix(base, u_tipColor.rgb, sat(strands * (0.35 + 0.65 * tip) * u_length));
        col *= 0.86 + 0.22 * micro;
        col *= 0.92 + 0.16 * clumpN;
        if (u_mode == 1) {
          float h = sat(strands * (0.45 + 0.55 * len) * 0.85 + clumpN * 0.15);
          return vec4(vec3(h), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 草地。
   *
   * 算法：与毛皮类似，用 fbm 扭曲的周期性条纹生成草叶；另叠加大尺度斑块噪声，
   * 按 dryness 混入枯草色，草尖位置提亮，形成自然草地。
   *
   * 参数：
   *  - scale：草叶数量（12~96）；
   *  - density：草叶宽度 / 密度（0.15~1）；
   *  - clump：草丛聚集程度（0~1）；
   *  - dryness：枯草比例（0~1）；
   *  - direction：草叶朝向；
   *  - mode：Color / Height；
   *  - colorA / colorB / dryColor：深绿 / 鲜绿 / 枯草色；
   *  - seed：随机种子。
   */
  {
    type: 'grass',
    name: 'Grass',
    category: 'Pattern',
    space: 'color',
    desc: 'Clumpy grass blades with dry patches and fine directional detail.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Blades', type: 'int', min: 12, max: 96, def: 36 },
      { key: 'density', label: 'Density', type: 'float', min: 0.15, max: 1, step: 0.01, def: 0.6 },
      { key: 'clump', label: 'Clump', type: 'float', min: 0, max: 1, step: 0.01, def: 0.55 },
      { key: 'dryness', label: 'Dryness', type: 'float', min: 0, max: 1, step: 0.01, def: 0.3 },
      { key: 'direction', label: 'Direction', type: 'select', options: ['Vertical', 'Horizontal'], def: 0 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Deep Green', type: 'color', def: '#1d3a12' },
      { key: 'colorB', label: 'Fresh Green', type: 'color', def: '#6f9b38' },
      { key: 'dryColor', label: 'Dry Color', type: 'color', def: '#b39a59' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 23 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 q = u_direction == 0 ? uv : uv.yx;
        float clumpN = fbmTiled(vec2(q.x * 5.0, q.y * 5.0), 1.0, 4, 0.55, 2.0, u_seed);
        float patchN = fbmTiled(vec2(q.x * 2.0, q.y * 2.0), 1.0, 3, 0.5, 2.0, u_seed + 4.0);
        float across = q.x * float(u_scale) + (clumpN - 0.5) * u_clump * 10.0 + (fbmTiled(vec2(q.x * 12.0, q.y * 12.0), 1.0, 3, 0.5, 2.0, u_seed + 8.0) - 0.5) * 2.0;
        float w = mix(0.19, 0.028, u_density);
        float blade1 = smoothstep(w, 0.0, abs(fract(across) - 0.5));
        float blade2 = smoothstep(w * 0.7, 0.0, abs(fract(across * 2.0 + 0.31) - 0.5));
        float blades = sat(blade1 * 0.78 + blade2 * 0.42);
        float lenN = fbmTiled(vec2(q.x * 8.0, q.y * 20.0), 1.0, 4, 0.55, 2.0, u_seed + 2.0);
        float tip = smoothstep(0.5, 0.95, q.y * 0.8 + lenN * 0.4);
        float dryMask = smoothstep(0.48, 0.72, fbmTiled(vec2(q.x * 3.0, q.y * 3.0), 1.0, 4, 0.55, 2.0, u_seed + 6.0) + patchN * 0.18);

        vec3 green = mix(u_colorA.rgb, u_colorB.rgb, sat(clumpN * 0.55 + lenN * 0.4 + blades * 0.1));
        vec3 col = mix(green, u_dryColor.rgb, sat(dryMask * u_dryness));
        col *= 0.72 + 0.42 * blades;
        col = mix(col, col * 1.38 + vec3(0.025, 0.035, 0.012), sat(blades * tip * 0.72));
        col *= 0.86 + 0.24 * fbmTiled(vec2(q.x * 80.0, q.y * 40.0), 1.0, 2, 0.5, 2.0, u_seed + 11.0);
        if (u_mode == 1) {
          float h = sat(blades * (0.5 + 0.5 * lenN) * 0.85 + clumpN * 0.15);
          return vec4(vec3(h), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 塑料表面（注塑件）。
   *
   * 算法：Worley 噪声生成「橘皮」起伏，fbm 生成色斑与细微噪声，再用高频正弦相位
   * 叠加低频噪声生成随机划痕。
   *
   * 参数：
   *  - scale：橘皮单元数量（4~64）；
   *  - peel：橘皮强度（0~1）；
   *  - scratches：划痕强度（0~1）；
   *  - mode：Color / Height；
   *  - colorA / colorB：主色 / 暗部色；
   *  - seed：随机种子。
   */
  {
    type: 'plastic',
    name: 'Plastic Surface',
    category: 'Pattern',
    space: 'color',
    desc: 'Injection-moulded plastic: soft orange-peel, scratches and colour mottling.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Scale', type: 'int', min: 4, max: 64, def: 18 },
      { key: 'peel', label: 'Orange Peel', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'scratches', label: 'Scratches', type: 'float', min: 0, max: 1, step: 0.01, def: 0.18 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Color A', type: 'color', def: '#c8332f' },
      { key: 'colorB', label: 'Color B', type: 'color', def: '#7e1718' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 31 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float cell = max(4.0, float(u_scale));
        float mottle = fbmTiled(vec2(uv.x * 3.0, uv.y * 3.0), 1.0, 4, 0.55, 2.0, u_seed);
        float wave = fbmTiled(vec2(uv.x * 6.0, uv.y * 6.0), 1.0, 3, 0.5, 2.0, u_seed + 4.0);
        vec2 w = worleyTiled(uv, cell, 0.65, u_seed + 2.0);
        float peel = smoothstep(0.0, 0.42, w.x) * (1.0 - smoothstep(0.42, 0.7, w.x));
        float micro = fbmTiled(vec2(uv.x * 64.0, uv.y * 64.0), 1.0, 3, 0.5, 2.0, u_seed + 7.0);
        float scratchPhase = (uv.x * 96.0 + uv.y * 23.0) * TAU;
        float scratch = smoothstep(0.82, 1.0, sin(scratchPhase) * 0.5 + 0.5) * smoothstep(0.35, 0.75, wave);
        float scratches = scratch * u_scratches;

        vec3 col = mix(u_colorA.rgb, u_colorB.rgb, sat(mottle * 0.35 + wave * 0.25));
        col *= 0.95 + 0.1 * peel * u_peel + 0.06 * micro;
        col = mix(col, col * 1.35 + vec3(0.08), sat(scratches));
        if (u_mode == 1) {
          float h = 0.5 + (peel - 0.35) * 0.16 * u_peel + (micro - 0.5) * 0.05 + scratches * 0.18;
          return vec4(vec3(sat(h)), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 麻布（黄麻编织袋）。
   *
   * 算法：UV 乘以编织密度后用 fbm 扰动，得到不规则的经纬线；按格子奇偶交替决定经线
   * 在上还是纬线在上（平纹组织），再叠加纤维噪声与逐格颜色抖动。
   *
   * 参数：
   *  - weave：编织密度（6~64）；
   *  - irregularity：经纬线不规则程度（0~1）；
   *  - fiber：纤维粗糙度（0~1）；
   *  - gap：线间缝隙比例（0~0.6）；
   *  - mode：Color / Height；
   *  - colorA / colorB / gapColor：亮线 / 暗线 / 缝隙颜色；
   *  - seed：随机种子。
   */
  {
    type: 'burlap',
    name: 'Burlap',
    category: 'Pattern',
    space: 'color',
    desc: 'Coarse jute weave with irregular threads, fibre fuzz and dark gaps.',
    inputs: [],
    params: [
      { key: 'weave', label: 'Weave Count', type: 'int', min: 6, max: 64, def: 22 },
      { key: 'irregularity', label: 'Irregularity', type: 'float', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'fiber', label: 'Fiber', type: 'float', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'gap', label: 'Gap', type: 'float', min: 0, max: 0.6, step: 0.01, def: 0.32 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Thread Light', type: 'color', def: '#b7a074' },
      { key: 'colorB', label: 'Thread Dark', type: 'color', def: '#6f5a39' },
      { key: 'gapColor', label: 'Gap Color', type: 'color', def: '#2b2317' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 41 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float weave = max(2.0, float(u_weave));
        float n = fbmTiled(vec2(uv.x * 4.0, uv.y * 4.0), 1.0, 3, 0.55, 2.0, u_seed) - 0.5;
        vec2 p = uv * weave + n * u_irregularity * 1.8;
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float halfW = mix(0.34, 0.16, u_gap);
        float aa = max(uPx.x, uPx.y) * weave * 1.5 + 1e-4;
        float warp = smoothstep(halfW + aa, halfW - aa, abs(f.x));
        float weft = smoothstep(halfW + aa, halfW - aa, abs(f.y));
        float over = mod(cell.x + cell.y, 2.0);
        float top = mix(weft, warp, over);
        float fibre = fbmTiled(vec2(uv.x * 96.0, uv.y * 96.0), 1.0, 3, 0.55, 2.0, u_seed + 6.0);
        float thread = sat(top * (0.72 + 0.28 * fibre) * (0.75 + 0.25 * u_fiber));
        vec3 tint = hash3(mod(cell, vec2(weave)), u_seed + 2.0);
        vec3 col = mix(u_colorB.rgb, u_colorA.rgb, sat(0.35 + 0.65 * tint.x));
        col *= 0.82 + 0.28 * fibre;
        if (u_mode == 1) {
          float h = sat(thread * 0.85 + fibre * 0.15);
          return vec4(vec3(h), 1.0);
        }
        return vec4(mix(u_gapColor.rgb, col, thread), 1.0);
      }`
  },

  /**
   * 织物（平纹 / 斜纹 / 缎纹）。
   *
   * 算法：按 threads 密度建立经纬线，用 fbm 抖动模拟纤维；weave 决定经纬交叠规律：
   *  - Plain：奇偶交替（隔一压一）；
   *  - Twill：每 4 格一个斜向循环；
   *  - Satin：每 5 格循环，浮线更长、更光滑。
   *
   * 参数：
   *  - threads：纱线密度（16~128）；
   *  - weave：Plain / Twill / Satin；
   *  - fuzz：表面绒毛感（0~1）；
   *  - mode：Color / Height；
   *  - colorA / colorB：经线色 / 纬线色；
   *  - seed：随机种子。
   */
  {
    type: 'fabric',
    name: 'Fabric',
    category: 'Pattern',
    space: 'color',
    desc: 'Fine woven cloth: plain, twill or satin weave with soft fibre fuzz.',
    inputs: [],
    params: [
      { key: 'threads', label: 'Thread Count', type: 'int', min: 16, max: 128, def: 48 },
      { key: 'weave', label: 'Weave', type: 'select', options: ['Plain', 'Twill', 'Satin'], def: 0 },
      { key: 'fuzz', label: 'Fuzz', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Warp Color', type: 'color', def: '#465a72' },
      { key: 'colorB', label: 'Weft Color', type: 'color', def: '#2a3545' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 53 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float n = fbmTiled(vec2(uv.x * 8.0, uv.y * 8.0), 1.0, 3, 0.5, 2.0, u_seed) - 0.5;
        vec2 p = uv * float(u_threads) + n * u_fuzz * 1.2;
        vec2 cell = floor(p);
        vec2 f = fract(p) - 0.5;
        float aa = max(uPx.x, uPx.y) * float(u_threads) * 1.8 + 1e-4;
        float warp = smoothstep(0.34 + aa, 0.34 - aa, abs(f.x));
        float weft = smoothstep(0.34 + aa, 0.34 - aa, abs(f.y));
        float over;
        if (u_weave == 0) over = mod(cell.x + cell.y, 2.0);
        else if (u_weave == 1) over = step(2.0, mod(cell.x + cell.y, 4.0));
        else over = step(3.0, mod(cell.x * 2.0 + cell.y, 5.0));
        float top = mix(weft, warp, over);
        float fuzz = fbmTiled(vec2(uv.x * 220.0, uv.y * 220.0), 1.0, 2, 0.5, 2.0, u_seed + 5.0);
        float thread = sat(top * (0.8 + 0.2 * fuzz) * (0.8 + 0.2 * u_fuzz));
        vec3 base = mix(u_colorB.rgb, u_colorA.rgb, sat(over * 0.65 + 0.25));
        vec3 col = base * (0.84 + 0.24 * fuzz);
        col = mix(col, col * 1.16, sat(top * 0.35));
        if (u_mode == 1) {
          float h = sat(thread * 0.9 + fuzz * 0.1);
          return vec4(vec3(h), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 皮革。
   *
   * 算法：Worley 生成鹅卵石状皮纹单元，F2-F1 差值形成颗粒边缘；多层 fbm 分别模拟
   * 大皱纹、细凹凸与裂纹，颗粒边缘混入高光色。
   *
   * 参数：
   *  - scale：皮纹单元数量（6~48）；
   *  - wrinkle：皱纹强度（0~1）；
   *  - cracks：裂纹强度（0~1）；
   *  - mode：Color / Height；
   *  - colorA / colorB / tipColor：暗部 / 亮部 / 高光色；
   *  - seed：随机种子。
   */
  {
    type: 'leather',
    name: 'Leather',
    category: 'Pattern',
    space: 'color',
    desc: 'Pebbled leather with wrinkles, creases and soft highlights.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Pebble Scale', type: 'int', min: 6, max: 48, def: 16 },
      { key: 'wrinkle', label: 'Wrinkles', type: 'float', min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: 'cracks', label: 'Cracks', type: 'float', min: 0, max: 1, step: 0.01, def: 0.3 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Leather Dark', type: 'color', def: '#2e1b12' },
      { key: 'colorB', label: 'Leather Light', type: 'color', def: '#7b4b31' },
      { key: 'tipColor', label: 'Highlight', type: 'color', def: '#a66d49' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 61 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float pebble = max(4.0, float(u_scale));
        vec2 w = worleyTiled(uv, pebble, 0.8, u_seed);
        vec2 wc = worleyCell(uv, pebble, 0.8, u_seed);
        float edge = sat((w.y - w.x) * 4.0);
        float wrinkle = fbmTiled(vec2(uv.x * 5.0, uv.y * 5.0), 1.0, 4, 0.55, 2.0, u_seed + 3.0);
        float bump = fbmTiled(vec2(uv.x * 28.0, uv.y * 28.0), 1.0, 4, 0.5, 2.0, u_seed + 6.0);
        float ridge = fbmTiled(vec2(uv.x * 12.0, uv.y * 12.0), 1.0, 3, 0.55, 2.0, u_seed + 8.0);
        float crack = smoothstep(0.02, 0.16, abs(ridge - 0.5)) * u_cracks;
        vec3 tint = hash3(wc, u_seed + 5.0);
        vec3 col = mix(u_colorA.rgb, u_colorB.rgb, sat(tint.x * 0.55 + wrinkle * 0.35));
        col = mix(col, u_tipColor.rgb, sat(edge * 0.35 * u_wrinkle));
        col *= 0.85 + 0.28 * bump;
        col *= 1.0 - crack * 0.45;
        if (u_mode == 1) {
          float h = sat(0.35 + bump * 0.25 + edge * 0.25 * u_wrinkle - crack * 0.3 + wrinkle * 0.1);
          return vec4(vec3(h), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 混凝土（浇筑面）。
   *
   * 算法：多尺度 fbm 作为水泥底色，Worley 噪声产生骨料颗粒与气孔，
   * 再用低频 fbm 加阈值形成潮湿污渍。
   *
   * 参数：
   *  - scale：骨料单元数量（3~32）；
   *  - aggregate：骨料颗粒强度（0~1）；
   *  - pores：气孔数量 / 强度（0~1）；
   *  - stain：污渍强度（0~1）；
   *  - mode：Color / Height；
   *  - colorA / colorB：深色 / 浅色水泥；
   *  - seed：随机种子。
   */
  {
    type: 'concrete',
    name: 'Concrete',
    category: 'Pattern',
    space: 'color',
    desc: 'Poured concrete with aggregate speckles, pores and damp staining.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Aggregate Scale', type: 'int', min: 3, max: 32, def: 9 },
      { key: 'aggregate', label: 'Aggregate', type: 'float', min: 0, max: 1, step: 0.01, def: 0.5 },
      { key: 'pores', label: 'Pores', type: 'float', min: 0, max: 1, step: 0.01, def: 0.35 },
      { key: 'stain', label: 'Staining', type: 'float', min: 0, max: 1, step: 0.01, def: 0.4 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Height'], def: 0 },
      { key: 'colorA', label: 'Concrete Dark', type: 'color', def: '#5a5954' },
      { key: 'colorB', label: 'Concrete Light', type: 'color', def: '#a8a69e' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 71 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float base = fbmTiled(vec2(uv.x * 4.0, uv.y * 4.0), 1.0, 5, 0.58, 2.0, u_seed);
        float fine = fbmTiled(vec2(uv.x * 48.0, uv.y * 48.0), 1.0, 3, 0.5, 2.0, u_seed + 3.0);
        float cells = max(3.0, float(u_scale));
        vec2 w = worleyTiled(uv, cells, 0.9, u_seed + 5.0);
        float speck = smoothstep(0.22, 0.0, w.x) * u_aggregate;
        float pore = smoothstep(0.15, 0.0, w.x) * smoothstep(0.55, 0.85, fbmTiled(vec2(uv.x * 32.0, uv.y * 32.0), 1.0, 2, 0.5, 2.0, u_seed + 7.0)) * u_pores;
        float stain = smoothstep(0.42, 0.72, fbmTiled(vec2(uv.x * 2.0, uv.y * 2.0), 1.0, 4, 0.55, 2.0, u_seed + 9.0)) * u_stain;
        vec3 col = mix(u_colorA.rgb, u_colorB.rgb, sat(base * 0.6 + fine * 0.3));
        col = mix(col, vec3(0.32, 0.3, 0.27), stain * 0.35);
        col = mix(col, col * 0.55, pore * 0.65);
        col = mix(col, col * 1.18 + vec3(0.03), speck * 0.6);
        if (u_mode == 1) {
          float h = sat(0.55 + base * 0.22 + fine * 0.1 - pore * 0.28 + speck * 0.2);
          return vec4(vec3(h), 1.0);
        }
        return vec4(col, 1.0);
      }`
  },

  /**
   * 火焰贴图（彩色 / 蒙版）。
   *
   * 算法：以「向上收窄的水滴形包络」为核心，用多套不同频率的 fbm 噪声做三件事：
   * 1. 轮廓塑形：低频噪声调制火焰半宽，得到自然的起伏边缘，而不是一条完美的锥线；
   * 2. 横向摆动：位移随高度增强，让火苗根部稳定、尖端飘动；
   * 3. 纵向纹理：沿 Y 拉伸的高频噪声把火焰打散成丝缕状火舌。
   * 亮度使用三段色带（外焰 / 中焰 / 焰心），并按高度衰减，避免整团火一样亮。
   * 四种样式通过不同的基础半径、收窄指数与火焰高度实现，而不是四份独立代码：
   * 篝火矮而宽、喷枪高而细、火炬居中；火球则使用椭圆距离场。
   *
   * 平铺性：横向（UV.x）严格无缝——噪声周期与火舌数量都取整数；
   * 纵向刻意不做周期（火焰本身是自下而上的形状），适合贴花 / 粒子片 / 材质球局部。
   *
   * 参数：
   *  - style：火焰形态（Torch 火炬 / Campfire 篝火 / Gas Jet 喷枪 / Fireball 火球）；
   *  - tongues：横向火舌数量（1~8），仅柱状样式有效；
   *  - scale：湍流噪声频率（1~12）；
   *  - detail：噪声叠加层数（1~6），越高细节越碎；
   *  - turbulence：横向摆动与侵蚀强度（0~1）；
   *  - rise：噪声在纵向的抬升量（0~2），越大火舌越「拉长」；
   *  - softness：火焰边缘羽化宽度（0.02~0.6）；
   *  - intensity：整体密度增益（0.2~2）；
   *  - mode：Color 输出彩色火焰 / Mask 输出灰度蒙版（可直接当不透明度或不透明度贴图）；
   *  - colorCore / colorMid / colorEdge：焰心 / 中焰 / 外焰颜色；
   *  - seed：随机种子。
   *
   * 输出：RGB 为火焰颜色，A 通道为火焰密度蒙版，因此同一节点可直接接
   * Base Color + Opacity + Emissive（自发光用 Mask 模式或加一个乘算节点）。
   */
  {
    type: 'flame',
    name: 'Flame Texture',
    category: 'Pattern',
    space: 'color',
    desc: 'Procedural fire with torch, campfire, gas jet and fireball shapes. Alpha carries the flame mask.',
    inputs: [],
    params: [
      { key: 'style', label: 'Style', type: 'select', options: ['Torch', 'Campfire', 'Gas Jet', 'Fireball'], def: 0 },
      { key: 'tongues', label: 'Tongues', type: 'int', min: 1, max: 8, def: 3 },
      { key: 'scale', label: 'Scale', type: 'float', min: 1, max: 12, step: 1, def: 5 },
      { key: 'detail', label: 'Detail', type: 'int', min: 1, max: 6, def: 4 },
      { key: 'turbulence', label: 'Turbulence', type: 'float', min: 0, max: 1, step: 0.01, def: 0.55 },
      { key: 'rise', label: 'Rise', type: 'float', min: 0, max: 2, step: 0.01, def: 0.4 },
      { key: 'softness', label: 'Softness', type: 'float', min: 0.02, max: 0.6, step: 0.01, def: 0.2 },
      { key: 'intensity', label: 'Intensity', type: 'float', min: 0.2, max: 2, step: 0.01, def: 1 },
      { key: 'mode', label: 'Output', type: 'select', options: ['Color', 'Mask'], def: 0 },
      { key: 'colorCore', label: 'Core Color', type: 'color', def: '#ffe9a8' },
      { key: 'colorMid', label: 'Mid Color', type: 'color', def: '#ff8a12' },
      { key: 'colorEdge', label: 'Edge Color', type: 'color', def: '#8f1d03' },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 3 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float t = sat(uv.y);
        float freq = max(1.0, u_scale);
        int oct = u_detail;

        // Two periodic noise fields: "rib" sculpts the silhouette, "fine" adds internal detail.
        float rib = fbmTiled(vec2(uv.x, uv.y * 0.6 - u_rise * 0.22), freq, oct, 0.55, 2.0, u_seed);
        float fine = fbmTiled(vec2(uv.x * 2.0 + 0.37, uv.y * 1.2 - u_rise * 0.35), freq * 1.5, max(2, oct - 1), 0.5, 2.0, u_seed + 11.0);

        float mask;
        if (u_style == 3) {
          // Fireball: soft round blob, perturbed by both noise fields.
          vec2 p = vec2((uv.x - 0.5) * 2.0, (t - 0.45) * 1.6);
          p += (vec2(rib, fine) - 0.5) * 0.6 * u_turbulence;
          float rad = 0.74 - 0.12 * (fine - 0.5) - 0.08 * (rib - 0.5);
          mask = pow(sat(1.0 - length(p) / max(rad, 1e-3)), 1.4);
        } else {
          float x = (uv.x - 0.5) * 2.0;
          // Lateral wobble grows with height: the base is anchored, the tip sways.
          x += (rib - 0.5) * u_turbulence * mix(0.12, 0.70, t);

          // Each style has its own width, taper and height: campfire is squat and broad,
          // the gas jet is tall and thin, the torch sits in between.
          float baseW;
          float powW;
          float height;
          if (u_style == 0) { baseW = 0.62; powW = 0.65; height = 1.0; }
          else if (u_style == 1) { baseW = 0.85; powW = 0.55; height = 0.78; }
          else { baseW = 0.34; powW = 1.0; height = 1.15; }

          float th = sat(t / height);
          // Width profile: a broad teardrop that stays wide through the mid body.
          float w = baseW * pow(max(1.0 - th, 0.0), powW);
          w *= 0.75 + 0.55 * rib;

          // Tongues scallop the outline instead of splitting it into thin needles.
          float lobes = 0.78 + 0.22 * cos(uv.x * float(u_tongues) * TAU + rib * 6.2831853);
          w *= mix(1.0, lobes, sat(1.0 - th * 1.5));
          w = max(w, 0.015);

          // Softness controls the lateral falloff exponent: larger = wider feathered rim.
          float edgePow = mix(2.2, 0.9, sat(u_softness / 0.6));
          float body = pow(sat(1.0 - abs(x) / w), edgePow);
          // Vertical envelope: dense at the base, dissolving smoothly towards the tip.
          body *= sat(1.0 - pow(th, 0.9));

          // Vertical filaments: stretched noise breaks the body into flame-like streaks.
          float streak = fbmTiled(vec2(uv.x * 6.0, uv.y * 1.4 - u_rise * 0.3), freq * 2.0, max(2, oct - 1), 0.5, 2.0, u_seed + 27.0);
          body *= clamp(0.45 + 0.9 * streak, 0.35, 1.25);
          mask = sat(body);
        }

        mask = sat(mask * u_intensity);
        if (u_mode == 1) return vec4(vec3(mask), 1.0);

        // Heat falls off with height: pale-yellow core at the base, orange body, deep red rim.
        float heat = sat(pow(mask, 0.8) * (1.05 - 0.55 * t));
        vec3 col = mix(u_colorEdge.rgb, u_colorMid.rgb, smoothstep(0.06, 0.5, heat));
        col = mix(col, u_colorCore.rgb, smoothstep(0.55, 0.92, heat));
        return vec4(col, mask);
      }`
  },

  /**
   * 火焰噪声图（灰度数据）。
   *
   * 算法：两套周期 fbm（第二套频率翻倍并偏移）按 warp 混合，等价于一次廉价的域扭曲，
   * 产生卷曲、翻涌、向上的热流质感；坐标在纵向乘整数倍，因此上下也能无缝平铺。
   * mask 参数可选地叠一层「自下而上渐隐」的火焰包络，方便直接当自发光噪声使用。
   *
   * 参数：
   *  - scale：基础频率（2~32）；
   *  - detail：叠加层数（1~6）；
   *  - stretch：纵向重复次数（1~4），越大噪声越「细长」；
   *  - warp：两套噪声的混合量（0~1），越大卷曲越明显；
   *  - contrast：对比度（0.1~4）；
   *  - mask：火焰包络强度（0~1），0 表示保持完全平铺的纯噪声；
   *  - seed：随机种子。
   */
  {
    type: 'flame_noise',
    name: 'Flame Noise',
    category: 'Noise',
    space: 'data',
    desc: 'Tileable heat-haze noise for fire distortion and emission breakup, with an optional rising envelope.',
    inputs: [],
    params: [
      { key: 'scale', label: 'Scale', type: 'int', min: 2, max: 32, def: 6 },
      { key: 'detail', label: 'Detail', type: 'int', min: 1, max: 6, def: 5 },
      { key: 'stretch', label: 'Stretch', type: 'int', min: 1, max: 4, def: 2 },
      { key: 'warp', label: 'Warp', type: 'float', min: 0, max: 1, step: 0.01, def: 0.45 },
      { key: 'contrast', label: 'Contrast', type: 'float', min: 0.1, max: 4, step: 0.01, def: 1.2 },
      { key: 'mask', label: 'Flame Mask', type: 'float', min: 0, max: 1, step: 0.01, def: 0 },
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 17 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float freq = max(2.0, float(u_scale));
        int oct = u_detail;
        // Integer vertical repetition keeps the pattern seamless in both directions.
        float sy = uv.y * float(u_stretch);

        float a = fbmTiled(vec2(uv.x, sy), freq, oct, 0.55, 2.0, u_seed);
        float b = fbmTiled(vec2(uv.x + 0.29, sy + 0.43), freq * 2.0, max(2, oct - 1), 0.5, 2.0, u_seed + 7.0);

        // Mixing two periodic fields is a cheap domain warp that preserves tileability.
        float v = mix(a, b, u_warp);
        v = sat((v - 0.5) * u_contrast + 0.5);

        if (u_mask > 0.0) {
          // Rising envelope: dense near the bottom, dissolving towards the top (both edges are 0).
          float env = smoothstep(0.0, 0.28, uv.y) * (1.0 - smoothstep(0.35, 1.0, uv.y));
          v = mix(v, v * env, u_mask);
        }
        return vec4(vec3(v), 1.0);
      }`
  }
]
