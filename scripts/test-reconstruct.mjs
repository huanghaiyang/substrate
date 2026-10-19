// Unit tests for the approximate-reconstruction builder (src/engine/reconstruct.js).
// The builder is pure: it takes measured preview statistics and returns a graph, so it can be checked
// without a browser. We validate that every generated connection targets a port that actually exists
// on the node definition — the failure mode that silently produces a black material.
import { buildReconstructionProject } from '../src/engine/reconstruct.js'

import { generatorDefs } from '../src/engine/nodes/generators.js'
import { patternDefs } from '../src/engine/nodes/patterns.js'
import { filterDefs } from '../src/engine/nodes/filters.js'
import { outputDef } from '../src/engine/nodes/output.js'

const defs = [...generatorDefs, ...patternDefs, ...filterDefs, outputDef]
const byType = new Map(defs.map((d) => [d.type, d]))

let pass = 0
let fail = 0
const ok = (label, cond, info = '') => {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (info ? ' :: ' + info : ''))
  }
}

const stats = {
  coverage: 0.67,
  meanColor: '#403f31',
  dark: '#25241b',
  mid: '#403f31',
  light: '#727057',
  brightness: 0.32,
  contrast: 0.55,
  saturation: 0.18,
  palette: ['#25241b', '#403f31', '#727057']
}
const info = { label: 'Cracked Stones With grass', graphType: 'material', parameterCount: 94, resolution: 1024 }

console.log('\n1. graph shape')
const project = buildReconstructionProject({ stats, info, seed: 0xc0ffee })
const graph = project.graph
ok('returns a loadable project object', project.version === 1 && project.app === 'substrate-texture-designer' && !!graph)
ok('project name slug', project.name === 'reconstructed-cracked-stones-with-grass', project.name)
ok('has a material output', graph.nodes.some((n) => n.type === 'material_output'))
ok('every node type is known', graph.nodes.every((n) => byType.has(n.type)), [...new Set(graph.nodes.map((n) => n.type))].join(','))
ok('no duplicate node ids', new Set(graph.nodes.map((n) => n.id)).size === graph.nodes.length)

console.log('\n2. connections are valid')
const broken = graph.connections.filter((c) => {
  const target = graph.nodes.find((n) => n.id === c.to.node)
  const def = target && byType.get(target.type)
  if (!def) return true
  return !(def.inputs || []).some((i) => i.name === c.to.port)
})
ok('all target ports exist on the node definitions', broken.length === 0, JSON.stringify(broken.map((b) => b.to)))
const unknownFrom = graph.connections.filter((c) => !graph.nodes.some((n) => n.id === c.from.node))
ok('all source nodes exist', unknownFrom.length === 0)
const out = graph.nodes.find((n) => n.type === 'material_output')
const wired = graph.connections.filter((c) => c.to.node === out.id).map((c) => c.to.port).sort()
ok('output wires the expected channels', JSON.stringify(wired) === JSON.stringify(['ao', 'basecolor', 'height', 'metallic', 'normal', 'roughness']), wired.join(','))

console.log('\n3. parameters are sane')
const num = (n, k) => n.params[k]
const normal = graph.nodes.find((n) => n.type === 'normal')
ok('normal node reads height intensity within range', num(normal, 'intensity') > 0.2 && num(normal, 'intensity') < 1.6, String(num(normal, 'intensity')))
const rough = graph.nodes.find((n) => n.type === 'levels' && n.params.outLow !== 0)
ok('roughness levels are inside [0,1] and ordered', rough && rough.params.outLow >= 0 && rough.params.outHigh <= 1 && rough.params.outLow < rough.params.outHigh, JSON.stringify(rough && rough.params))
const ramp = graph.nodes.find((n) => n.type === 'gradient_map')
ok('base-colour ramp uses the measured palette', ramp && ramp.params.gradient[0].c === stats.dark && ramp.params.gradient[ramp.params.gradient.length - 1].c === stats.light, JSON.stringify(ramp && ramp.params.gradient.map((g) => g.c)))
ok('output material name comes from the graph label', num(out, 'materialName') === info.label)

console.log('\n4. deterministic + palette driven')
const a = buildReconstructionProject({ stats, info, seed: 123 })
const b = buildReconstructionProject({ stats, info, seed: 123 })
ok('same seed → identical graph', JSON.stringify(a.graph) === JSON.stringify(b.graph))
const c = buildReconstructionProject({ stats: { ...stats, dark: '#101010', light: '#f0f0f0' }, info, seed: 123 })
ok('different palette → different look', JSON.stringify(c.graph) !== JSON.stringify(a.graph))

console.log(`\n${fail ? '✕ FAILED' : '✓ PASSED'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
