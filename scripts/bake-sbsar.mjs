// Bake a .sbsar into real PBR maps by driving Adobe's Substance Automation Toolkit (SAT).
//
// Why this exists: a .sbsar has no pixels. It ships a graph descriptor (.xml) plus compiled engine
// bytecode (.sbsasm); the PBR outputs only exist after Adobe's Substance Engine *evaluates* the graph.
// SAT is the supported, batchable way to do that from a script (it bundles the engine + sbsrender).
//
//   npm run bake:sbsar -- path/to/asset.sbsar [--out baked/name] [--res 2048] [--graph "pkg://…"]
//
// Then import the produced PNGs with the studio's "Import PBR set" button (Material Library), which
// recognises basecolor/normal/roughness/metallic/height/ao by file name and wires them into a material.
//
// Finding SAT: --sbsrender <path>, or env SBSRENDER / SUBSTANCE_SAT_HOME, or `sbsrender` on PATH.
// Install: https://helpx.adobe.com/substance-3d-sat/ (requires a Substance 3D subscription).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)
const input = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')))
if (!input) {
  console.error('usage: node scripts/bake-sbsar.mjs <asset.sbsar> [--out dir] [--res 2048] [--graph url] [--sbsrender path]')
  process.exit(2)
}

const SAT_HINTS = [
  path.resolve(path.dirname(process.execPath), 'sbsrender.exe'),
  'C:/Program Files/Allegorithmic/Substance Automation Toolkit/sbsrender.exe',
  'C:/Program Files/Adobe/Substance 3D Automation Toolkit/sbsrender.exe',
  '/Applications/Substance Automation Toolkit/sbsrender',
  '/opt/Substance Automation Toolkit/sbsrender'
]

function findSbsrender() {
  const explicit = flag('sbsrender') || process.env.SBSRENDER
  if (explicit && existsSync(explicit)) return explicit
  const home = process.env.SUBSTANCE_SAT_HOME
  if (home) {
    const candidates = [
      path.join(home, 'sbsrender.exe'),
      path.join(home, 'bin', 'sbsrender.exe'),
      path.join(home, 'sbsrender')
    ]
    const hit = candidates.find((c) => existsSync(c))
    if (hit) return hit
  }
  for (const c of SAT_HINTS) if (existsSync(c)) return c
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(which, ['sbsrender'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    if (first && existsSync(first)) return first
  } catch (e) {
    /* not on PATH */
  }
  return null
}

const sbsrender = findSbsrender()
if (!sbsrender) {
  console.error(
    [
      '',
      '✕ sbsrender (Substance Automation Toolkit) was not found.',
      '',
      'A .sbsar cannot be turned into PBR maps without Adobe\'s Substance Engine; SAT is the supported',
      'batch path. Install SAT (Substance 3D subscription) and re-run with one of:',
      '',
      '  set SBSRENDER="C:\\Program Files\\Allegorithmic\\Substance Automation Toolkit\\sbsrender.exe"',
      '  set SUBSTANCE_SAT_HOME="C:\\Program Files\\Allegorithmic\\Substance Automation Toolkit"',
      '  node scripts/bake-sbsar.mjs asset.sbsar --sbsrender "…\\sbsrender.exe"',
      '',
      'Alternatives that bake the same graph: Substance 3D Designer (open the .sbsar → Export outputs),',
      'Substance 3D Player, or the Adobe Substance plugin for Unity/Unreal/Blender.',
      ''
    ].join('\n')
  )
  process.exit(1)
}

const res = Number(flag('res', 1024)) || 1024
const outDir = path.resolve(flag('out', path.join('baked', path.basename(input).replace(/\.sbsar$/i, '') + '-' + res)))
const graph = flag('graph')
mkdirSync(outDir, { recursive: true })

console.log('sbsrender :', sbsrender)
console.log('input     :', input)
console.log('resolution:', res + '×' + res)
console.log('output    :', outDir)

// 1) describe the asset (graphs, inputs, outputs) — helps confirm output names before rendering
try {
  const info = execFileSync(sbsrender, ['info', '--input', input], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const start = info.indexOf('{')
  const js = start >= 0 ? JSON.parse(info.slice(start)) : null
  if (js) {
    const graphs = js.graphs || js.substances || []
    for (const g of graphs) {
      console.log('\ngraph:', g.graphUrl || g.url || g.identifier || '(unnamed)')
      for (const o of g.outputs || []) {
        console.log('  output:', o.identifier || o.name, '· usage:', o.usage || '-', '· format:', o.format || '-')
      }
    }
  } else {
    console.log('\n[sbsrender info]\n' + info.trim().split('\n').slice(0, 20).join('\n'))
  }
} catch (e) {
  console.warn('warning: `sbsrender info` failed, continuing to render:', (e.stdout || e.message || '').toString().split('\n')[0])
}

// 2) render every output to PNG, one file per output node name
const args = [
  'render',
  '--input', input,
  '--output-path', outDir,
  '--output-name', '{inputName}_{outputNodeName}',
  '--output-format', 'png',
  '--output-bit-depth', '16',
  '--no-report'
]
if (graph) args.push('--input-graph', graph)
// graph-level resolution input (the descriptor exposes $outputsize as a vector2)
args.push('--set-value', `$outputsize@${res},${res}`)

console.log('\n$', path.basename(sbsrender), args.join(' '))
try {
  execFileSync(sbsrender, args, { stdio: 'inherit' })
} catch (e) {
  console.error('\n✕ sbsrender failed:', e.message)
  process.exit(1)
}

const files = readdirSync(outDir)
  .filter((f) => /\.(png|tga|exr|tif?f)$/i.test(f))
  .map((f) => ({ f, kb: Math.round(statSync(path.join(outDir, f)).size / 1024) }))
console.log('\nbaked ' + files.length + ' map(s):')
for (const { f, kb } of files) console.log('  ' + f + '  ' + kb + ' KB')
console.log(
  [
    '',
    'next: open the studio → Material Library → “Import PBR set” and select these files.',
    '      Channels are recognised by name (basecolor/normal/roughness/metallic/height/ao/…);',
    '      data maps are wired in raw (Data (RGB)) so normals/roughness keep their numeric values.',
    ''
  ].join('\n')
)
