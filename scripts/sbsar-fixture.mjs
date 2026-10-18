// Fixture builders for .sbsar tests and demos. Produces *synthetic* Substance archives: the container
// shapes (zip / native-scan) and the descriptor XML are modelled on real archives, but the payload is
// generated here so tests need no binary assets checked into the repository.
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** minimal PNG encoder (8-bit greyscale gradient) */
export function makePng(width, height, shade = 128) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
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
  ihdr[8] = 8
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** store-or-deflate ZIP writer */
export function makeZip(files, { deflate = false } = {}) {
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

export const GRAPH_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

export const SBAM = Buffer.concat([Buffer.from('SBAM', 'ascii'), Buffer.alloc(64, 0x11)])

/** a zip-shaped archive (the shape this importer reads authoritatively) */
export function makeZipSbsar() {
  return makeZip([
    { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
    { name: 'thumbnail.png', data: makePng(128, 128, 90) },
    { name: 'resources/albedo.png', data: makePng(512, 512, 160) },
    { name: 'TestMaterial.sbsasm', data: SBAM }
  ])
}

/** a native-shaped archive: opaque header + descriptor + bitmap + assembly, recovered by scanning */
export function makeNativeSbsar() {
  const header = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x02]), Buffer.from('SBSAR\0', 'ascii'), Buffer.alloc(24, 0x7f)])
  return Buffer.concat([header, Buffer.from(GRAPH_XML, 'utf8'), makePng(256, 256, 100), SBAM, Buffer.alloc(32, 0)])
}
