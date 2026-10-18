// Pattern generators: material-specific procedural surfaces (wood, fur, grass, plastic,
// woven cloth, leather, concrete). Every pattern is periodic so it tiles exactly.
//
// These nodes are colour sources by default. Their optional Height mode makes the same
// pattern usable as a bump/height source without another conversion node.

export const patternDefs = [
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
  }
]
