// Independent verification of an exported material package.
// Decodes PNGs with node:zlib, validates chunk CRCs, unfilters scanlines,
// checks colour spaces, normal convention, channel packing and the zip archive.
// usage: node scripts/verify-export.mjs [exportDir]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { inflateSync, inflateRawSync } from 'node:zlib'

const ROOT = process.cwd()
const EXPORTS = path.join(ROOT, 'exports')

function latestExportDir() {
  const dirs = readdirSync(EXPORTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, mtime: statSync(path.join(EXPORTS, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (!dirs.length) throw new Error('no exports found')
  return path.join(EXPORTS, dirs[0].name)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function unfilter(raw, width, height, channels, bitDepth) {
  const bytesPerSample = bitDepth / 8
  const bpp = channels * bytesPerSample
  const rowBytes = width * bpp
  const out = new Uint8Array(height * rowBytes)
  let p = 0
  for (let y = 0; y < height; y++) {
    const type = raw[p++]
    const cur = out.subarray(y * rowBytes, (y + 1) * rowBytes)
    const prev = y > 0 ? out.subarray((y - 1) * rowBytes, y * rowBytes) : null
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[p + i]
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      let v
      if (type === 0) v = x
      else if (type === 1) v = x + a
      else if (type === 2) v = x + b
      else if (type === 3) v = x + ((a + b) >> 1)
      else if (type === 4) v = x + paeth(a, b, c)
      else throw new Error('invalid filter type ' + type + ' on row ' + y)
      cur[i] = v & 0xff
    }
    p += rowBytes
  }
  return { pixels: out, rowBytes }
}

function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('bad PNG signature')
  let off = 8
  const chunks = []
  let ihdr = null
  let srgb = null
  let text = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    const crc = buf.readUInt32BE(off + 8 + len)
    const actual = crc32(buf.subarray(off + 4, off + 8 + len))
    chunks.push({ type, len, crcOk: crc === actual })
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      }
    } else if (type === 'sRGB') srgb = data[0]
    else if (type === 'tEXt') text = data.toString('latin1')
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  const channels = ihdr.colorType === 0 ? 1 : ihdr.colorType === 2 ? 3 : 4
  const inflated = inflateSync(Buffer.concat(idat))
  const expected = ihdr.height * (1 + ihdr.width * channels * (ihdr.bitDepth / 8))
  const unf = unfilter(inflated, ihdr.width, ihdr.height, channels, ihdr.bitDepth)
  return {
    ihdr,
    channels,
    chunks,
    crcOk: chunks.every((c) => c.crcOk),
    srgb,
    text,
    inflatedBytes: inflated.length,
    expectedInflatedBytes: expected,
    ...unf
  }
}

function sample8(png, x, y, ch) {
  return png.pixels[y * png.rowBytes + x * png.channels + ch]
}
function sample16(png, x, y, ch) {
  const i = y * png.rowBytes + (x * png.channels + ch) * 2
  return (png.pixels[i] << 8) | png.pixels[i + 1]
}

function channelStats(png) {
  const max = png.ihdr.bitDepth === 16 ? 65535 : 255
  const stats = []
  for (let ch = 0; ch < png.channels; ch++) {
    let min = max
    let maxv = 0
    let sum = 0
    const n = png.ihdr.width * png.ihdr.height
    for (let y = 0; y < png.ihdr.height; y += 2) {
      for (let x = 0; x < png.ihdr.width; x += 2) {
        const v = png.ihdr.bitDepth === 16 ? sample16(png, x, y, ch) : sample8(png, x, y, ch)
        if (v < min) min = v
        if (v > maxv) maxv = v
        sum += v
      }
    }
    const count = Math.ceil(png.ihdr.width / 2) * Math.ceil(png.ihdr.height / 2)
    stats.push({ min, max: maxv, mean: +(sum / count).toFixed(1) })
  }
  return stats
}

function seamRatio(png, ch) {
  const w = png.ihdr.width
  const h = png.ihdr.height
  const get = png.ihdr.bitDepth === 16 ? sample16 : sample8
  const horiz = []
  const vert = []
  let seamH = 0
  let seamV = 0
  for (let y = 0; y < h; y++) {
    seamH += Math.abs(get(png, 0, y, ch) - get(png, w - 1, y, ch))
    for (let x = 0; x < w - 1; x++) horiz.push(Math.abs(get(png, x, y, ch) - get(png, x + 1, y, ch)))
  }
  for (let x = 0; x < w; x++) {
    seamV += Math.abs(get(png, x, 0, ch) - get(png, x, h - 1, ch))
    for (let y = 0; y < h - 1; y++) vert.push(Math.abs(get(png, x, y, ch) - get(png, x, y + 1, ch)))
  }
  const pct = (arr, p) => {
    if (!arr.length) return 0
    const copy = arr.slice().sort((a, b) => a - b)
    return copy[Math.min(copy.length - 1, Math.floor(copy.length * p))]
  }
  const floor = png.ihdr.bitDepth === 16 ? 256 : 1.0
  const hStep = seamH / h
  const vStep = seamV / w
  return {
    horizontal: +(hStep < floor ? 0 : hStep / Math.max(pct(horiz, 0.99), floor)).toFixed(2),
    vertical: +(vStep < floor ? 0 : vStep / Math.max(pct(vert, 0.99), floor)).toFixed(2)
  }
}

function verifyZip(zipPath, dir, failures, report) {
  const buf = readFileSync(zipPath)
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) {
    failures.push('zip: EOCD not found')
    return
  }
  const entries = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  let p = cdOffset
  const seen = []
  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      failures.push('zip: bad central directory signature')
      break
    }
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compSize)
    let data
    try {
      data = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed)
    } catch (e) {
      failures.push(`zip: could not inflate ${name}: ${e.message}`)
      p += 46 + nameLen + extraLen + commentLen
      continue
    }
    const crcOk = crc32(data) === crc
    const sizeOk = data.length === uncompSize
    if (!crcOk || !sizeOk) failures.push(`zip: CRC/size mismatch for ${name}`)
    const onDisk = path.join(dir, name)
    if (!existsSync(onDisk)) failures.push(`zip: entry not on disk: ${name}`)
    else if (crc32(readFileSync(onDisk)) !== crc) failures.push(`zip: on-disk file differs from zip entry: ${name}`)
    seen.push({ name, method, bytes: uncompSize, crcOk })
    p += 46 + nameLen + extraLen + commentLen
  }
  report.zip = { entries, files: seen }
}

async function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : latestExportDir()
  const report = { dir, failures: [], checks: {}, files: {} }
  const failures = report.failures
  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) failures.push('missing manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  report.manifest = {
    name: manifest.name,
    resolution: manifest.resolution,
    preset: manifest.preset,
    normalConvention: manifest.normalMap?.convention,
    colorSpace: manifest.colorSpace,
    files: manifest.files?.length
  }
  const expected = {
    basecolor: { colorType: [2, 6], bitDepth: [8] },
    normal: { colorType: [2], bitDepth: [8] },
    orm: { colorType: [2], bitDepth: [8] },
    maskmap: { colorType: [6], bitDepth: [8] },
    roughness: { colorType: [0], bitDepth: [8] },
    metallic: { colorType: [0], bitDepth: [8] },
    ao: { colorType: [0], bitDepth: [8] },
    height: { colorType: [0], bitDepth: [8, 16] },
    emissive: { colorType: [2, 6], bitDepth: [8] }
  }
  const metaByPath = new Map((manifest.files || []).map((f) => [f.path, f]))
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const png = decodePng(readFileSync(path.join(dir, file)))
    const meta = metaByPath.get(file)
    const entry = {
      width: png.ihdr.width,
      height: png.ihdr.height,
      bitDepth: png.ihdr.bitDepth,
      colorType: png.ihdr.colorType,
      channels: png.channels,
      crcOk: png.crcOk,
      srgbChunk: png.srgb !== null,
      text: png.text,
      inflatedOk: png.inflatedBytes === png.expectedInflatedBytes,
      stats: channelStats(png)
    }
    if (!png.crcOk) failures.push(`${file}: bad chunk CRC`)
    if (!entry.inflatedOk) failures.push(`${file}: scanline data size mismatch`)
    if (png.ihdr.compression !== 0 || png.ihdr.interlace !== 0) failures.push(`${file}: unsupported PNG options`)
    if (png.ihdr.width !== manifest.resolution || png.ihdr.height !== manifest.resolution) {
      failures.push(`${file}: resolution ${png.ihdr.width}x${png.ihdr.height} != manifest ${manifest.resolution}`)
    }
    if (meta) {
      const kind = (meta.channel || '').toLowerCase()
      let expectedKind = null
      if (kind.includes('orm')) expectedKind = 'orm'
      else if (kind.includes('mask')) expectedKind = 'maskmap'
      else if (kind.includes('base')) expectedKind = 'basecolor'
      else if (kind.includes('normal')) expectedKind = 'normal'
      else if (kind.includes('height')) expectedKind = 'height'
      else if (kind.includes('rough')) expectedKind = 'roughness'
      else if (kind.includes('metal')) expectedKind = 'metallic'
      else if (kind.includes('ao')) expectedKind = 'ao'
      else if (kind.includes('emissive')) expectedKind = 'emissive'
      if (expectedKind) {
        const exp = expected[expectedKind]
        if (!exp.colorType.includes(png.ihdr.colorType)) {
          failures.push(`${file}: colorType ${png.ihdr.colorType} not expected for ${expectedKind}`)
        }
        if (!exp.bitDepth.includes(png.ihdr.bitDepth)) {
          failures.push(`${file}: bitDepth ${png.ihdr.bitDepth} not expected for ${expectedKind}`)
        }
        const isColor = expectedKind === 'basecolor' || expectedKind === 'emissive'
        if (isColor && png.srgb === null) failures.push(`${file}: missing sRGB chunk for colour map`)
        if (!isColor && png.srgb !== null) failures.push(`${file}: unexpected sRGB chunk on linear data map`)
        if (!png.text || !png.text.includes('Substrate')) failures.push(`${file}: missing Software tEXt metadata`)
      }
    } else {
      failures.push(`${file}: not listed in manifest`)
    }
    if (file.toLowerCase().includes('basecolor') || file.toLowerCase().includes('height')) {
      entry.seam = { horizontal: seamRatio(png, 0), vertical: seamRatio(png, 1 % png.channels) }
      if (entry.seam.horizontal > 2.5 || entry.seam.vertical > 2.5) {
        failures.push(`${file}: tiling seam ratio too high ${JSON.stringify(entry.seam)}`)
      }
    }
    report.files[file] = entry
  }
  // manifest structural checks
  if (!manifest.colorSpace) failures.push('manifest: missing colorSpace block')
  if (!manifest.normalMap?.convention) failures.push('manifest: missing normalMap.convention')
  if (!manifest.pbr?.metallicWorkflow) failures.push('manifest: missing metallic workflow declaration')
  if (!manifest.seamless) failures.push('manifest: seamless flag not set')

  const readmePath = path.join(dir, 'README.md')
  if (!existsSync(readmePath)) failures.push('missing README.md')
  else {
    const readme = readFileSync(readmePath, 'utf8')
    for (const needle of ['Color space rules', 'ORM', 'Normal map convention', 'three.js', 'Unreal', 'Unity']) {
      if (!readme.includes(needle)) failures.push('README missing section: ' + needle)
    }
  }
  const zipFile = readdirSync(dir).find((f) => f.endsWith('.zip'))
  if (!zipFile) failures.push('missing zip archive')
  else verifyZip(path.join(dir, zipFile), dir, failures, report)

  report.ok = failures.length === 0
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
