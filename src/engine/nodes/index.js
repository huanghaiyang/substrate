import { generatorDefs } from './generators.js'
import { filterDefs } from './filters.js'
import { outputDef } from './output.js'

export const NODE_DEFS = [...generatorDefs, ...filterDefs, outputDef]
export const NODE_MAP = Object.fromEntries(NODE_DEFS.map((d) => [d.type, d]))

export const CATEGORIES = ['Input', 'Noise', 'Pattern', 'Shape', 'Color', 'Paint', 'Filter', 'Blend', 'Adjust', 'Normal', 'Output']

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

export function defaultParams(def) {
  const out = {}
  for (const p of def.params || []) {
    if (p.type === 'gradient') out[p.key] = (p.def || []).map((s) => ({ p: s.p, c: s.c }))
    else if (p.type === 'vec2') out[p.key] = Array.isArray(p.def) ? [...p.def] : [p.def, p.def]
    else out[p.key] = p.def
  }
  return out
}

export function resolveParams(def, node) {
  const base = defaultParams(def)
  const p = node && node.params ? node.params : {}
  const out = { ...base }
  for (const key of Object.keys(base)) {
    if (p[key] !== undefined) out[key] = p[key]
  }
  return out
}
