// Compiles a node definition into a GLSL ES 3.00 fragment shader.
import { COMMON_GLSL } from './glsl.js'

export const MAX_GRADIENT_STOPS = 8

function gradientDecls(key) {
  return /* glsl */ `
    uniform int u_${key}_count;
    uniform float u_${key}_pos[${MAX_GRADIENT_STOPS}];
    uniform vec4 u_${key}_col[${MAX_GRADIENT_STOPS}];
    vec4 sampleGradient(float t) {
      t = clamp(t, 0.0, 1.0);
      vec4 c = u_${key}_col[0];
      for (int i = 1; i < ${MAX_GRADIENT_STOPS}; i++) {
        if (i >= u_${key}_count) break;
        float a = u_${key}_pos[i - 1];
        float b = u_${key}_pos[i];
        float f = clamp((t - a) / max(b - a, 1e-5), 0.0, 1.0);
        c = mix(c, u_${key}_col[i], f);
      }
      return c;
    }
  `
}

function paramDecls(def) {
  let s = ''
  for (const p of def.params || []) {
    switch (p.type) {
      case 'float':
      case 'angle':
        s += `uniform float u_${p.key};\n`
        break
      case 'int':
      case 'select':
        s += `uniform int u_${p.key};\n`
        break
      case 'bool':
        s += `uniform bool u_${p.key};\n`
        break
      case 'color':
        s += `uniform vec4 u_${p.key};\n`
        break
      case 'vec2':
        s += `uniform vec2 u_${p.key};\n`
        break
      case 'gradient':
        s += gradientDecls(p.key) + '\n'
        break
      default:
        break
    }
  }
  return s
}

export function passesOf(def) {
  return def.passes || [{ body: def.body }]
}

export function buildFragmentSource(def, passIndex = 0) {
  const pass = passesOf(def)[passIndex]
  if (!pass) throw new Error('Bad pass index for ' + def.type)
  let s = ''
  s += 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n'
  s += 'in vec2 vUv;\nout vec4 fragColor;\n'
  for (const inp of def.inputs || []) s += `uniform sampler2D uIn_${inp.name};\n`
  if (passIndex > 0) s += 'uniform sampler2D uPrev;\n'
  if (def.paintInput) s += 'uniform sampler2D uPaint;\n'
  if (def.imageInput) s += 'uniform sampler2D uImage;\n'
  s += paramDecls(def)
  s += COMMON_GLSL
  if (def.prelude) s += '\n' + def.prelude + '\n'
  s += '\n' + pass.body + '\n'
  s += /* glsl */ `
void main() {
  vec4 c = nodeColor(vUv);
  fragColor = vec4(clamp(c.rgb, 0.0, 1.0), clamp(c.a, 0.0, 1.0));
}
`
  return s
}

export const ENCODE_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform int uMode;
uniform int uFlipY;
${COMMON_GLSL}
void main() {
  vec4 c = texture(uTex, vUv);
  if (uMode == 1) c.rgb = linearToSRGB(c.rgb);
  if (uFlipY == 1) c.g = 1.0 - c.g;
  fragColor = c;
}
`
