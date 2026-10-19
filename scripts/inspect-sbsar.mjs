// CLI: inspect a .sbsar and print what the importer sees. Useful for triaging "import failed" reports.
//   node scripts/inspect-sbsar.mjs <file.sbsar> [--json]
import { readFileSync } from 'node:fs'
import { inspectSbsar } from '../server/sbsar.mjs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/inspect-sbsar.mjs <file.sbsar> [--json]')
  process.exit(2)
}
const buf = readFileSync(file)
const r = inspectSbsar(buf)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...r, imagePayloads: undefined }, null, 2))
  process.exit(0)
}
const kb = (n) => (n ? Math.round(n / 1024) + ' KB' : '-')
console.log('file      ', file, '(' + buf.length + ' bytes)')
console.log('container ', r.container, '· confidence', r.containerConfidence, '· header version', buf[6] + '.' + buf[7])
console.log('entries   ', r.entryCount)
for (const e of r.entries) console.log('   ', e.name, e.size != null ? '(' + kb(e.size) + ')' : '')
console.log('descriptor', r.graphXml || '(none)', '· root element', r.rootElement || '-')
console.log('graphs    ', r.graphs.map((g) => g.identifier + (g.graphType ? ' [' + g.graphType + ']' : '')).join(', ') || '-')
console.log('outputs   ', r.outputs.map((o) => o.usage).join(', ') || '-')
console.log('params    ', r.parameters.length)
const byKind = {}
for (const p of r.parameters) byKind[p.kind || p.type || '?'] = (byKind[p.kind || p.type || '?'] || 0) + 1
console.log('          ', JSON.stringify(byKind))
for (const p of r.parameters.slice(0, 8)) {
  const range = p.min != null && p.max != null ? ` [${p.min}..${p.max}${p.step ? '/' + p.step : ''}]` : ''
  const enums = p.enumItems ? ' {' + p.enumItems.slice(0, 4).join('|') + (p.enumItems.length > 4 ? '|…' : '') + '}' : ''
  console.log(`    ${p.id.padEnd(32)} ${(p.kind || 'type ' + p.type).padEnd(8)} = ${p.default}${range}${enums}`)
}
if (r.parameters.length > 8) console.log('    …')
console.log('metadata  ', JSON.stringify(r.metadata))
console.log('images    ', r.images.map((i) => `${i.name} ${i.width}x${i.height} ${i.role} ${kb(i.bytes)}`).join(' | ') || '-')
console.log('assemblies', r.assemblies.map((a) => a.name + (a.bytes ? ' ' + kb(a.bytes) : '')).join(' | ') || '-')
console.log('warnings  ', r.warnings.length ? r.warnings : '(none)')
console.log('notes     ', r.notes.length ? r.notes : '(none)')
console.log('canEvaluate', r.canEvaluate, '—', r.evaluateBlockedReason)
