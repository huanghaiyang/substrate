// Build .sbsar fixtures and validate the importer against genuine LZMA archives.
//
// A real .sbsar is a 7-Zip archive with this layout (Adobe's publishing docs):
//   assemblies/content/0000/<Graph>.xml · <Graph>.sbsasm · metadata.json · resources/<n>/…
// We generate exactly that tree and compress it with the installed 7-Zip, so tests exercise the real
// container + LZMA/LZMA2 decoders instead of a hand-made approximation.
//
// usage: node scripts/make-sbsar-fixture.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makePng, makeZip, makeNativeSbsar, GRAPH_XML, SBAM } from './sbsar-fixture.mjs'
import { inspectSbsar } from '../server/sbsar.mjs'

const OUT = 'docs/reports/sbsar-import/fixtures'
mkdirSync(OUT, { recursive: true })

const SEVEN_ZIP_CANDIDATES = [
  'C:/Program Files/7-Zip/7z.exe',
  'C:/Program Files (x86)/7-Zip/7z.exe',
  '7z',
  '7za'
]
const sevenZip = SEVEN_ZIP_CANDIDATES.find((p) => {
  try {
    execFileSync(p, ['i'], { stdio: 'ignore' })
    return true
  } catch (e) {
    return false
  }
})

// ---------------------------------------------------------------- synthetic container variants
writeFileSync(path.join(OUT, 'TestMaterial.sbsar'), makeZip([
  { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
  { name: 'thumbnail.png', data: makePng(128, 128, 90) },
  { name: 'resources/albedo.png', data: makePng(512, 512, 160) },
  { name: 'TestMaterial.sbsasm', data: SBAM }
]))
writeFileSync(path.join(OUT, 'Native-Container.sbsar'), makeNativeSbsar())

/** the real 7z layout as a directory tree */
export function makeRealLayoutTree(dir) {
  const root = path.join(dir, 'assemblies', 'content', '0000')
  mkdirSync(path.join(root, 'resources', '0'), { recursive: true })
  mkdirSync(path.join(root, 'resources', '1'), { recursive: true })
  writeFileSync(path.join(root, 'TestMaterial.xml'), GRAPH_XML)
  writeFileSync(path.join(root, 'TestMaterial.sbsasm'), SBAM)
  writeFileSync(
    path.join(root, 'metadata.json'),
    JSON.stringify(
      { author: 'Substrate test fixture', description: 'Synthetic archive with the real 7z layout', url: 'https://example.invalid/asset' },
      null,
      2
    )
  )
  writeFileSync(path.join(root, 'resources', '0', 'preview.png'), makePng(256, 256, 100))
  writeFileSync(path.join(root, 'resources', '1', 'albedo.png'), makePng(512, 512, 170))
  return root
}

if (!sevenZip) {
  console.log('7-Zip not found — skipped the real-layout fixtures (synthetic ones were written)')
} else {
  console.log('using', sevenZip)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sbsar-fixture-'))
  try {
    makeRealLayoutTree(tmp)
    for (const [name, method] of [
      ['RealLayout-lzma2.sbsar', 'lzma2'],
      ['RealLayout-lzma1.sbsar', 'lzma'],
      ['RealLayout-copy.sbsar', 'copy']
    ]) {
      const out = path.resolve(OUT, name)
      if (existsSync(out)) rmSync(out)
      execFileSync(sevenZip, ['a', '-t7z', `-m0=${method}`, '-mx=9', out, path.join(tmp, '*'), '-r'], { stdio: 'ignore' })
      console.log('wrote', name)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- verify with the importer
let failures = 0
const check = (label, cond, info = '') => {
  console.log((cond ? '  PASS ' : '  FAIL ') + label + (cond ? '' : ' :: ' + info))
  if (!cond) failures++
}
for (const name of ['RealLayout-lzma2.sbsar', 'RealLayout-lzma1.sbsar', 'RealLayout-copy.sbsar']) {
  const file = path.join(OUT, name)
  if (!existsSync(file)) {
    console.log('skip', name)
    continue
  }
  console.log('\n' + name)
  const r = inspectSbsar(readFileSync(file))
  check('container is 7z', r.container === '7z', r.container)
  check('parameters parsed (3)', r.parameters.length === 3, String(r.parameters.length))
  check('graph parsed', r.graphs.length >= 1, JSON.stringify(r.graphs))
  check('output usages (3)', r.outputs.length === 3, JSON.stringify(r.outputs))
  check('metadata.json merged', r.metadata.author === 'Substrate test fixture', JSON.stringify(r.metadata))
  check('xml metadata kept', r.metadata.label === 'Test Material', JSON.stringify(r.metadata))
  check('2 resource bitmaps', r.images.length === 2, JSON.stringify(r.images.map((i) => i.name)))
  check('sbsasm recognised', r.assemblies.length === 1, JSON.stringify(r.assemblies))
  check('cannot evaluate (documented)', r.canEvaluate === false && /Substance Engine/.test(r.evaluateBlockedReason))
}
console.log(failures ? `\n✕ ${failures} check(s) failed` : '\n✓ fixtures and importer agree')
process.exit(failures ? 1 : 0)
