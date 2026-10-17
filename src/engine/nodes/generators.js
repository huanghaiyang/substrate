// Generator nodes: noise, patterns, shapes, gradients.
import { SHAPE_GLSL } from '../glsl.js'

export const generatorDefs = [
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
      { key: 'seed', label: 'Seed', type: 'float', min: 0, max: 100, step: 1, def: 1 }
    ],
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        float n = fbmTiled(uv, max(1.0, u_scale), u_octaves, u_persistence, u_lacunarity, u_seed);
        n = sat((n - 0.5) * max(u_contrast, 0.01) + 0.5);
        return vec4(vec3(n), 1.0);
      }`
  },
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
          vec2 p = rot2(uv - 0.5, radians(u_angle));
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
        vec2 p = rot2(uv - 0.5, radians(u_angle)) * s;
        vec2 c = floor(p);
        float v = mod(c.x + c.y, 2.0);
        return mix(u_colorA, u_colorB, v);
      }`
  },
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
        vec2 p = rot2(uv - 0.5 - u_offset, radians(-u_rotation)) / size;
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
          vec2 p = rot2(uv - 0.5, radians(u_angle));
          t = p.x * float(u_repeat) + 0.5 + u_offset;
        } else if (u_type == 1) {
          t = length(uv - 0.5) * 2.0;
        } else if (u_type == 2) {
          t = atan(uv.y - 0.5, uv.x - 0.5) / TAU + 0.5;
        } else {
          t = abs(uv.x - 0.5) + abs(uv.y - 0.5);
        }
        t = sat(t * float(u_repeat) + u_offset);
        return sampleGradient(t);
      }`
  },
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
  {
    type: 'image_input',
    name: 'Texture Input',
    category: 'Input',
    space: 'color',
    desc: 'Load a bitmap (color or mask) into the graph.',
    inputs: [],
    params: [
      { key: 'channelMode', label: 'Channel', type: 'select', options: ['Color', 'Grayscale', 'Alpha'], def: 0 },
      { key: 'scale', label: 'Tiling', type: 'vec2', min: 0.1, max: 8, step: 0.01, def: [1, 1] },
      { key: 'offset', label: 'Offset', type: 'vec2', min: -1, max: 1, step: 0.005, def: [0, 0] },
      { key: 'invert', label: 'Invert', type: 'bool', def: false }
    ],
    imageInput: true,
    body: /* glsl */ `
      vec4 nodeColor(vec2 uv) {
        vec2 p = uv * u_scale + u_offset;
        vec4 c = texture(uImage, p);
        if (u_channelMode == 1) c = vec4(vec3(c.r), c.a);
        else if (u_channelMode == 2) c = vec4(vec3(c.a), c.a);
        if (u_invert) c.rgb = 1.0 - c.rgb;
        return c;
      }`
  },
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
