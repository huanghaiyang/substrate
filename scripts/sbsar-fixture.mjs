/**
 * .sbsar 测试/演示夹具生成器。
 *
 * 这里产出的是「合成的」Substance 归档：容器外形（zip 打包 / 原生扫描布局）与描述 XML
 * 都依照真实归档建模，但内部的二进制载荷是本文件现场生成的。
 * 因此测试不需要往仓库里提交体积庞大的真实素材，也能覆盖导入器的各条解析路径。
 *
 * 主要导出：makePng、makeZip、GRAPH_XML、SBAM、makeZipSbsar、makeNativeSbsar、crc32。
 */
import zlib from 'node:zlib'

// CRC-32 查表（PNG / ZIP 都需要），一次性预计算
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** 计算任意 Buffer 的 CRC-32 校验值（用于 ZIP 条目与 PNG chunk）。 */
export const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 极简 PNG 编码器：8 位灰度、无滤波。
 * 生成一张带斜向渐变的图（像素值 = shade + 3x + 5y），尺寸/亮度可控，
 * 用于模拟预览图与贴图资源；不同尺寸能让断言区分「预览」与「资源」。
 */
export function makePng(width, height, shade = 128) {
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0
    for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = (shade + x * 3 + y * 5) & 0xff
  }
  // 每个 chunk 的结构：长度 + 类型 + 数据 + CRC（CRC 只覆盖类型与数据）
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

/**
 * 极简 ZIP 写入器，支持「存储(0)」与「deflate(8)」两种压缩方式。
 * 依次写出：本地文件头 + 数据 → 中央目录 → EOCD 结束记录；
 * 中央目录中的 offset 记录着对应本地头的起始位置。不写时间戳与额外字段，保证输出可复现。
 *
 * @param {{name: string, data: Buffer}[]} files 待打包条目
 * @param {{deflate?: boolean}} [opts] deflate 为 true 时使用 raw deflate
 * @returns {Buffer} 完整 zip 字节
 */
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
    // 本地文件头 30 字节，签名 0x04034b50；压缩后/原始大小都要写入，便于导入器校验
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    // 中央目录项 46 字节，签名 0x02014b50，重复保存同样的元数据并记录本地头偏移
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
  // EOCD（22 字节，签名 0x06054b50）：记录条目数、中央目录大小与起始偏移
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

/**
 * 合成描述 XML（模拟 Substance 发布后的接口描述）：
 * 包含 1 个 graph、3 个输入参数（颜色/浮点/整数，各带 GUI 范围）和 3 个输出用法。
 * 导入器据此推导参数类型与输出通道，但不包含任何原始节点图（真实 .sbsar 同样如此）。
 */
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

/** 合成的引擎字节码占位：以 'SBAM' 魔数开头 + 64 字节填充，仅用于验证「能否识别出 .sbsasm」。 */
export const SBAM = Buffer.concat([Buffer.from('SBAM', 'ascii'), Buffer.alloc(64, 0x11)])

/** 生成「zip 结构」的合成归档；这是导入器最确定、最完整的读取格式。 */
export function makeZipSbsar() {
  return makeZip([
    { name: 'TestMaterial.xml', data: Buffer.from(GRAPH_XML, 'utf8') },
    { name: 'thumbnail.png', data: makePng(128, 128, 90) },
    { name: 'resources/albedo.png', data: makePng(512, 512, 160) },
    { name: 'TestMaterial.sbsasm', data: SBAM }
  ])
}

/**
 * 生成「原生结构」的合成归档：不透明头部 + 描述 XML + PNG + 字节码 + 尾部填充。
 * 这种布局没有中央目录，导入器只能靠「扫描魔数与特征」来定位各段内容，
 * 用于验证扫描式解析的健壮性。
 */
export function makeNativeSbsar() {
  const header = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x02]), Buffer.from('SBSAR\0', 'ascii'), Buffer.alloc(24, 0x7f)])
  return Buffer.concat([header, Buffer.from(GRAPH_XML, 'utf8'), makePng(256, 256, 100), SBAM, Buffer.alloc(32, 0)])
}
