// Unit tests for the .sbsar inspector (server/sbsar.mjs) — builds fixtures in memory, no server.
// Run: node scripts/test-sbsar.mjs
import zlib from 'node:zlib'
import { inspectSbsar } from '../server/sbsar.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, info = '') => {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, info) }
}
const section = (t) => console.log('\n' + t)

// ------------------------------------------------------------------ fixture helpers
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** minimal PNG encoder (8-bit greyscale) so the fixture needs no binary assets */
function makePng(width, height, shade = 128) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0 // filter: none
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (shade + x * 3 + y * 5) & 0xff
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** store-or-deflate ZIP writer */
function makeZip(files, { deflate = false } = {}) {
  const locals = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const data = f.data
    const payload = deflate ? zlib.deflateRawSync(data) : data
    const method = deflate ? 8 : 0
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, name]))
    offset += 30 + name.length + payload.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

// A trimmed-down Substance-archive-style descriptor: package metadata, one graph, three inputs
// (one with gui range hints), two outputs.
const GRAPH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sbsar version="2024.1">
  <metadata name="author" value="Substrate test fixture"/>
  <metadata name="description" value="Synthetic archive used by scripts/test-sbsar.mjs"/>
  <metadata name="label" value="Test Material"/>
  <graphs>
    <graph identifier="TestMaterial" label="Test Material">
      <inputs>
        <input identifier="BaseColorTint" type="color" default="0.5,0.5,0.5">
          <gui>
            <min>0</min>
            <max>1</max>
          </gui>
        </input>
        <input identifier="Roughness" type="float" default="0.45">
          <gui>
            <min>0</min>
            <max>1</max>
            <step>0.01</step>
          </gui>
        </input>
        <input identifier="PatternCount" type="int" default="6">
          <gui>
            <min>1</min>
            <max>32</max>
            <step>1</step>
          </gui>
        </input>
      </inputs>
      <outputs>
        <output usage="baseColor"/>
        <output usage="roughness"/>
        <output usage="normal"/>
      </outputs>
    </graph>
  </graphs>
</sbsar>`

const SBAM = Buffer.concat([Buffer.from('SBAM', 'ascii'), Buffer.alloc(64, 0x11)])

// ------------------------------------------------------------------ tests
section('1. zip container (stored entries)')
{
  const zip = makeZip([
    { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
    { name: 'thumbnail.png', data: makePng(128, 128, 90) },
    { name: 'resources/albedo.png', data: makePng(512, 512, 160) },
    { name: 'TestMaterial.sbsasm', data: SBAM }
  ])
  const r = inspectSbsar(zip)
  ok('container detected as zip', r.container === 'zip', r.container)
  ok('container confidence certain', r.containerConfidence === 'certain')
  ok('graph found', r.graphs.length === 1 && r.graphs[0].identifier === 'TestMaterial', JSON.stringify(r.graphs))
  ok('3 parameters parsed', r.parameters.length === 3, JSON.stringify(r.parameters.map((p) => p.id)))
  const rough = r.parameters.find((p) => p.id === 'Roughness')
  ok('float parameter keeps default+range+step', rough && rough.default === '0.45' && rough.min === 0 && rough.max === 1 && rough.step === 0.01, JSON.stringify(rough))
  ok('metadata extracted', r.metadata.author === 'Substrate test fixture' && r.metadata.label === 'Test Material', JSON.stringify(r.metadata))
  ok('3 output usages', r.outputs.length === 3, JSON.stringify(r.outputs))
  ok('2 images extracted', r.images.length === 2, JSON.stringify(r.images.map((i) => i.name)))
  const thumb = r.images.find((i) => /thumbnail/.test(i.name))
  ok('thumbnail marked as preview (128px)', thumb.role === 'preview' && thumb.width === 128 && thumb.height === 128, JSON.stringify(thumb))
  ok('resource image kept', !!r.images.find((i) => /albedo/.test(i.name)))
  ok('assembly detected', r.assemblies.length === 1 && /sbsasm/.test(r.assemblies[0].name), JSON.stringify(r.assemblies))
  ok('evaluation is declared unsupported', r.canEvaluate === false && /Substance Engine/.test(r.evaluateBlockedReason))
  ok('image payloads available for storage', Array.isArray(r.imagePayloads) && r.imagePayloads.length === 2 && r.imagePayloads[0].bytes.length > 100)
}

section('2. zip container (deflate entries)')
{
  const zip = makeZip(
    [
      { name: 'graph.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
      { name: 'icon.png', data: makePng(128, 128, 60) }
    ],
    { deflate: true }
  )
  const r = inspectSbsar(zip)
  ok('deflated xml parsed', r.parameters.length === 3, String(r.parameters.length))
  ok('deflated image extracted', r.images.length === 1 && r.images[0].width === 128)
}

section('3. native container (scan fallback)')
{
  const header = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x02]), Buffer.from('SBSAR\0', 'ascii'), Buffer.alloc(24, 0x7f)])
  const png = makePng(256, 256, 100)
  const native = Buffer.concat([header, Buffer.from(GRAPH_XML, 'utf8'), png, SBAM, Buffer.alloc(32, 0)])
  const r = inspectSbsar(native)
  ok('container reported as native', r.container === 'native', r.container)
  ok('confidence is heuristic', r.containerConfidence === 'heuristic')
  ok('xml recovered by scanning', r.parameters.length === 3, String(r.parameters.length))
  ok('image recovered by scanning', r.images.length >= 1, String(r.images.length))
  ok('SBAM assembly noted', r.assemblies.length >= 1)
  ok('note explains heuristic recovery', r.notes.some((n) => /scanning/i.test(n)), JSON.stringify(r.notes))
}

section('4. native container with zlib-compressed XML')
{
  const xmlZ = zlib.deflateSync(Buffer.from(GRAPH_XML, 'utf8'))
  const native = Buffer.concat([Buffer.alloc(64, 0x33), xmlZ, Buffer.alloc(32, 0)])
  const r = inspectSbsar(native)
  ok('compressed xml inflated and parsed', r.parameters.length === 3, String(r.parameters.length))
}

section('5. rejection paths')
{
  let threw = false
  try { inspectSbsar(Buffer.alloc(4)) } catch (e) { threw = /too small/i.test(e.message) }
  ok('short file rejected', threw)

  // A file that carries none of the archive landmarks must be rejected, not imported as empty.
  const emptyZipLike = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(64, 0)])
  threw = false
  try { inspectSbsar(emptyZipLike) } catch (e) { threw = /not a substance archive/i.test(e.message) }
  ok('empty zip-like buffer rejected', threw)

  threw = false
  try { inspectSbsar(Buffer.from('definitely not a substance archive, just some bytes here'.repeat(2))) } catch (e) {
    threw = /not a substance archive/i.test(e.message)
  }
  ok('arbitrary bytes rejected', threw)
}

console.log(`\n${fail ? '✕ FAILED' : '✓ PASSED'} — ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
