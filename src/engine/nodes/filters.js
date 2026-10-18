// Filter / adjust / combine nodes.

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
  }
]
