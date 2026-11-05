/**
 * 导出包的「独立」验证器：不依赖应用自身的解码逻辑，直接用 Node 原生 zlib 重新解析产物，
 * 因此能真正发现编码层的错误（而不是让编码器自证正确）。
 *
 * 检查内容：
 * - PNG：签名、逐 chunk 的 CRC、IDAT 解压后的扫描线长度、反滤波、位深/颜色类型、sRGB chunk；
 * - 元数据：manifest 中的分辨率、色彩空间、法线约定、金属度工作流、无缝标记；
 * - 通道布局：颜色贴图必须带 sRGB chunk，数据贴图必须不带；ORM/MaskMap 的打包是否合法；
 * - 平铺无缝性：左右/上下边缘的差值应显著小于内部像素的 99 分位差；
 * - ZIP：中央目录、CRC/大小比对，以及与磁盘上同名文件是否一致；
 * - README：是否包含各引擎的导入说明。
 *
 * 用法：node scripts/verify-export.mjs [导出目录]（省略时取 exports/ 下最新目录）
 * 失败时以退出码 1 结束，可直接接入 CI。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { inflateSync, inflateRawSync } from 'node:zlib'

const ROOT = process.cwd()
const EXPORTS = path.join(ROOT, 'exports')

/** 取 exports/ 下修改时间最新的子目录；一个导出都没有时抛错。 */
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

/** PNG Paeth 预测器的参考值选择（与编码端一致）。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 逐行反滤波，恢复原始像素。
 * bpp 为「一个像素的字节数」，用于定位左侧参考像素 a、上方参考像素 b、左上角 c；
 * 遇到非法滤波类型立即抛错（这通常意味着文件损坏）。
 *
 * @returns {{pixels: Uint8Array, rowBytes: number}}
 */
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

/**
 * 解析 PNG 文件，返回头部信息、chunk 列表、CRC 结果、sRGB/tEXt 内容与解码后的像素。
 * 若缺少 IHDR 或 IDAT 会因访问 null 而报错——这是有意为之：这类文件本就不可用。
 */
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
  // 期望的解压长度 = 每行（1 字节滤波标志 + 像素数据）× 行数；不符说明扫描线结构有问题
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

/** 读取 8 位 PNG 中某个通道的像素值（x,y 为左上角原点坐标）。 */
function sample8(png, x, y, ch) {
  return png.pixels[y * png.rowBytes + x * png.channels + ch]
}
/** 读取 16 位 PNG 中某个通道的像素值：PNG 以「大端」存放两字节，这里手动拼合。 */
function sample16(png, x, y, ch) {
  const i = y * png.rowBytes + (x * png.channels + ch) * 2
  return (png.pixels[i] << 8) | png.pixels[i + 1]
}

/**
 * 统计每个通道的最小值、最大值与均值。
 * 只隔行隔列抽样（步长 2），在保证结果稳定的同时把大图统计开销降到 1/4。
 * 常见用途：判断高度图是否几乎全黑（没有起伏）、法线图是否大致以 128/0.5 为中心。
 */
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

/**
 * 计算「接缝比」：图左右（或上下）边缘的平均差异，除以内部相邻像素差异的 99 分位。
 * 比值接近 0 说明首尾能自然衔接（可平铺）；明显大于 1 则说明边缘有断层。
 * floor 用于抑制平坦区域中「几乎为 0」的分母，避免出现无穷大的比值。
 *
 * @returns {{horizontal: number, vertical: number}}
 */
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

/**
 * 校验 zip 归档：定位 EOCD、遍历中央目录、逐条解压并比对 CRC 与原始大小，
 * 再与磁盘上的同名文件逐字节比较，确保「zip 内容 == 导出的真实文件」。
 * 所有问题写入 failures，不抛异常，便于一次报告全部错误。
 */
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

/**
 * 主流程：定位导出目录 → 解析 manifest → 逐个 PNG 校验 → 结构/README/zip 校验 → 输出 JSON 报告。
 * 报告同时包含失败清单与每个文件的具体统计，便于人工排查。
 */
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
  // 每种通道「允许的」颜色类型与位深：颜色贴图可为 RGB/RGBA，数据贴图必须为 RGB 或灰度；
  // 高度图允许 8 位或 16 位，其余只允许 8 位
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
      // 分辨率必须与 manifest 声明一致，否则下游引擎可能出现贴图尺寸不匹配
      failures.push(`${file}: resolution ${png.ihdr.width}x${png.ihdr.height} != manifest ${manifest.resolution}`)
    }
    if (meta) {
      // 由文件名/manifest 中的通道名推断它「应该是什么通道」，再套用上面的期望表
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
      // 只对「平滑、应可平铺」的贴图检查接缝：比值超过 2.5 通常意味着边缘出现肉眼可见的断层
      entry.seam = { horizontal: seamRatio(png, 0), vertical: seamRatio(png, 1 % png.channels) }
      if (entry.seam.horizontal > 2.5 || entry.seam.vertical > 2.5) {
        failures.push(`${file}: tiling seam ratio too high ${JSON.stringify(entry.seam)}`)
      }
    }
    report.files[file] = entry
  }
  // manifest 结构完整性：缺少这些声明，导入方就无从判断色彩空间与法线约定
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
