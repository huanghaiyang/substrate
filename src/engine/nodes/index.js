/**
 * 节点注册表：汇总所有节点定义，并提供参数默认值/参数解析工具。
 *
 * 节点定义的约定（各定义文件共同遵守）：
 * - type：唯一类型标识，也是保存到工程文件中的字符串；
 * - name/category/desc：UI 展示与分类；
 * - inputs：输入口列表，每项含 name（端口名，对应着色器 uniform）、label、def（未连接时的默认值）；
 * - params：参数列表，每项含 key/label/type/def，编译器据此生成 uniform；
 * - body 或 passes：该节点的 GLSL 主体（由 compiler.js 拼装）；
 * - isOutput：标记「输出节点」，求值时只收集通道而不渲染。
 *
 * 主要导出：NODE_DEFS（全部定义）、NODE_MAP（按 type 索引）、CATEGORIES（分类顺序）、
 * OUTPUT_CHANNELS（导出通道元数据）、defaultParams / resolveParams。
 */
import { generatorDefs } from './generators.js'
import { patternDefs } from './patterns.js'
import { filterDefs } from './filters.js'
import { outputDef } from './output.js'

// 生成器 / 图案 / 滤镜 三类节点加上唯一的输出节点，构成完整注册表
export const NODE_DEFS = [...generatorDefs, ...patternDefs, ...filterDefs, outputDef]
export const NODE_MAP = Object.fromEntries(NODE_DEFS.map((d) => [d.type, d]))

// 节点面板的分类显示顺序
export const CATEGORIES = ['Input', 'Noise', 'Pattern', 'Shape', 'Color', 'Paint', 'Filter', 'Blend', 'Adjust', 'Normal', 'Output']

/**
 * 输出节点可用的 PBR 通道元数据。
 * - key：内部通道名，同时是输出端口名；
 * - srgb：该通道在导出/显示时是否按 sRGB 编码（颜色类为 true，数据类为 false）；
 * - group：用于 UI 分组（color/data）；
 * - single：单通道数据（灰度），预览与导出时只取 R 分量。
 */
export const OUTPUT_CHANNELS = [
  { key: 'basecolor', label: 'Base Color', srgb: true, group: 'color' },
  { key: 'height', label: 'Height', srgb: false, group: 'data', single: true },
  { key: 'normal', label: 'Normal', srgb: false, group: 'data' },
  { key: 'roughness', label: 'Roughness', srgb: false, group: 'data', single: true },
  { key: 'metallic', label: 'Metallic', srgb: false, group: 'data', single: true },
  { key: 'ao', label: 'AO', srgb: false, group: 'data', single: true },
  { key: 'emissive', label: 'Emissive', srgb: true, group: 'color' },
  { key: 'opacity', label: 'Opacity', srgb: false, group: 'data', single: true }
]

/**
 * 根据节点定义生成一份全新的默认参数对象。
 * 对数组类参数做拷贝（gradient 逐项复制、vec2 复制数组），
 * 避免多个节点实例共享同一个数组引用而互相影响。
 */
export function defaultParams(def) {
  const out = {}
  for (const p of def.params || []) {
    if (p.type === 'gradient') out[p.key] = (p.def || []).map((s) => ({ p: s.p, c: s.c }))
    else if (p.type === 'vec2') out[p.key] = Array.isArray(p.def) ? [...p.def] : [p.def, p.def]
    else out[p.key] = p.def
  }
  return out
}

/**
 * 把节点的实际参数与定义默认值合并。
 * 只保留定义中存在的参数键，因此即使旧工程里残留了已删除的参数，也不会被带进着色器 uniform。
 *
 * @param {object} def 节点定义
 * @param {object} node 图节点实例
 * @returns {object} 合并后的完整参数对象
 */
export function resolveParams(def, node) {
  const base = defaultParams(def)
  const p = node && node.params ? node.params : {}
  const out = { ...base }
  // 逐个覆盖为节点实际值；undefined 视为「未设置」，保留默认值
  for (const key of Object.keys(base)) {
    if (p[key] !== undefined) out[key] = p[key]
  }
  return out
}
