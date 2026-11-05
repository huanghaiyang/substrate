/**
 * 节点着色器编译器：把一个节点定义（NODE_DEFS 中的对象）拼装成
 * 一段完整的 GLSL ES 3.00 片元着色器源码。
 *
 * 在整体架构中的位置：engine.js 在创建节点材质时调用 buildFragmentSource；
 * 这里负责「声明区 + 公共 GLSL + 可选前导代码 + 节点主体 + main()」的拼接顺序，
 * 以及把节点参数声明为对应的 uniform。
 *
 * 主要导出：passesOf（取得节点的 pass 列表）、buildFragmentSource（生成源码）、
 * ENCODE_FRAG（回读/编码用的固定片元着色器）。
 *
 * 注意：本文件中的着色器源码内部只使用 ASCII 英文注释，避免部分驱动对非 ASCII 字符报错；
 * 中文说明一律写在模板字符串之外。
 */
import { COMMON_GLSL } from './glsl.js'

// 渐变最多支持的色标数量，必须与 engine.js 中的同名常量保持一致
export const MAX_GRADIENT_STOPS = 8

/**
 * 生成某个渐变参数的 uniform 声明与采样函数 `sampleGradient`。
 * uniform 数组长度固定为 MAX_GRADIENT_STOPS，实际色标数由 u_<key>_count 控制，
 * 因此调整色标数量不会触发着色器重新编译。
 */
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

/**
 * 为节点定义的每个参数生成对应的 uniform 声明。
 * 参数类型与 GLSL 类型的对应关系：
 * float/angle → float；int/select → int；bool → bool；color → vec4；vec2 → vec2；
 * gradient → 三个数组 + 采样函数。
 */
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

/**
 * 取得节点的 pass 列表。
 * 单 pass 节点只声明了 body，这里统一包装成 [{ body }]；
 * 多 pass 节点（如模糊、距离场迭代）使用 def.passes 数组，后续 pass 可以读取 uPrev。
 */
export function passesOf(def) {
  return def.passes || [{ body: def.body }]
}

/**
 * 生成一个节点某个 pass 的完整片元着色器源码。
 *
 * 拼接顺序（顺序对 GLSL 很关键）：
 * 精度限定 → 输入/输出变量 → 输入纹理 sampler → 参数 uniform → COMMON_GLSL →
 * （可选）节点自带的 prelude → 节点 body（定义 nodeColor）→ 固定的 main()。
 *
 * @param {object} def 节点定义
 * @param {number} [passIndex=0] pass 序号，越界时抛错
 * @returns {string} 可直接交给 WebGL 编译的着色器源码
 */
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

/**
 * 回读/编码用的固定片元着色器。
 * uMode == 1 时把线性颜色编码为 sRGB（用于颜色通道）；uFlipY == 1 时翻转法线 Y 分量，
 * 实现 OpenGL(+Y) 与 DirectX(-Y) 两种法线约定之间的互转。
 */
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
