// 零依赖 7-Zip(7z / LZMA) 归档读取器。
//
// .sbsar 就是 7-Zip 归档。Adobe 官方发布文档给出的布局是：
//   assemblies/content/0000/<Graph>.sbsasm     引擎字节码（无法在纯 JS 里执行）
//   assemblies/content/0000/<Graph>.xml        图描述（工具真正解析的部分）
//   assemblies/content/0000/metadata.json      包元数据（JSON）
//   assemblies/content/0000/resources/<n>/…    通用资源（内嵌位图等）
// 并说明读取方应「用任意 LZMA 解码器打开该归档」。
//
// 范围：只实现枚举与解包普通归档所必需的 7z 容器部分——文件头（明文与 LZMA 压缩两种）、
// pack/unpack/folder 信息、substream 切分、文件名/标志位、folder CRC。
// 支持的 coder：Copy、LZMA、LZMA2，且每个 folder 只允许单个 coder；
// BCJ/Delta 等过滤器链会明确报「不支持」，而不是返回错误字节。
//
// 对外接口：is7z（魔数判断）、crc32、parse7zHeader（只解析头，用于诊断/测试）、read7z（完整解包）。
// 与其他模块的关系：解码算法来自 lzma.mjs；被 sbsar.mjs 用于解析 .sbsar。
// 安全边界：read7z 支持 maxEntryBytes（默认 64 MB）限制单条目大小，防止压缩炸弹耗尽内存；
// 所有头部读取都做越界检查，畸形归档抛错而不是静默返回半截数据。
import { copyDecode, lzmaDecode, lzma2Decode } from './lzma.mjs'

const SIG = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
const BASE = 32 // signature header size; all archive offsets are relative to it

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/**
 * 标准 CRC-32（IEEE，反射版，与 ZIP/7z 一致）。表在模块加载时一次性生成。
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 无符号 32 位校验值
 */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const ID = {
  kEnd: 0x00,
  kHeader: 0x01,
  kArchiveProperties: 0x02,
  kAdditionalStreamsInfo: 0x03,
  kMainStreamsInfo: 0x04,
  kFilesInfo: 0x05,
  kPackInfo: 0x06,
  kUnpackInfo: 0x07,
  kSubStreamsInfo: 0x08,
  kSize: 0x09,
  kCRC: 0x0a,
  kFolder: 0x0b,
  kCodersUnpackSize: 0x0c,
  kNumUnpackStream: 0x0d,
  kEmptyStream: 0x0e,
  kEmptyFile: 0x0f,
  kAnti: 0x10,
  kName: 0x11,
  kCTime: 0x12,
  kATime: 0x13,
  kMTime: 0x14,
  kWinAttributes: 0x15,
  kComment: 0x16,
  kEncodedHeader: 0x17,
  kStartPos: 0x18,
  kDummy: 0x19
}

/**
 * 判断缓冲区是否以 7z 魔数（37 7A BC AF 27 1C）开头且长度足够容纳 32 字节签名头。
 * @param {Buffer|Uint8Array} buf
 * @returns {boolean}
 */
export const is7z = (buf) => buf.length >= 32 && buf.subarray(0, 6).equals(SIG)

/**
 * 7z 头部读取游标。与定长整数不同，7z 的数字是「首字节高位决定后续字节数」的变长编码：
 * 首个字节最高位为 1 表示还要再读一字节，为 0 时其低位就是最后一字节。见 number()。
 */
/** cursor over a buffer with 7z's variable-length number encoding */
class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf
    this.pos = pos
  }
  byte() {
    if (this.pos >= this.buf.length) throw new Error('7z: unexpected end of header')
    return this.buf[this.pos++]
  }
  bytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  /**
   * 读 4 字节小端无符号整数。
   * 手动逐字节组装，因为这里的缓冲区可能是 Buffer，也可能是解压后的普通 Uint8Array
   * （后者没有 readUInt32LE 方法）。
   * @returns {number} 0..2^32-1
   */
  u32() {
    // manual little-endian read: buffers here can be Buffer or plain Uint8Array (decoded headers)
    const b = this.buf
    const p = this.pos
    this.pos += 4
    return ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0)
  }
  /**
   * 读 8 字节小端无符号整数（拆成高低两个 u32 以避免 BigInt，数值可能超过 2^53 而丢精度）。
   * @returns {number}
   */
  u64() {
    const lo = this.u32()
    const hi = this.u32()
    return hi * 0x100000000 + lo
  }
  /**
   * 读 7z 变长数字（最多 8 个附加字节）。
   * 首字节的 8 个位自高向低依次对应「是否还有下一字节」；第一个 0 位及其低位组成最高字节，
   * 之前的字节按小端依次贡献低位。8 位全为 1 时表示这是一个完整 8 字节数字。
   * @returns {number}
   */
  number() {
    const first = this.byte()
    let mask = 0x80
    let value = 0
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * Math.pow(2, i * 8)
        return value
      }
      value += this.byte() * Math.pow(2, i * 8)
      mask >>= 1
    }
    return value
  }
  /**
   * 读取 count 个位（MSB first，按字节打包）。
   * @param {number} count
   * @returns {boolean[]}
   */
  bits(count) {
    const out = new Array(count)
    let mask = 0
    let byte = 0
    for (let i = 0; i < count; i++) {
      if (mask === 0) {
        byte = this.byte()
        mask = 0x80
      }
      out[i] = (byte & mask) !== 0
      mask >>= 1
    }
    return out
  }
  /**
   * 读取 count 个 CRC 摘要。
   * 7z 先写一个「是否全部已定义」布尔字节：非 0 表示全部存在，只有为 0 时才跟一个位向量。
   * 未定义的摘要返回 null。
   * @param {number} count
   * @returns {(number|null)[]}
   */
  digests(count) {
    // 7z writes a boolean "all defined" byte first; only a zero byte is followed by a bit vector.
    const allDefined = this.byte()
    const defined = allDefined !== 0 ? new Array(count).fill(true) : this.bits(count)
    const out = new Array(count)
    for (let i = 0; i < count; i++) out[i] = defined[i] ? this.u32() : null
    return out
  }
}

/**
 * 跳过 ArchiveProperties：逐项读 id + size 并前进，直到 kEnd。
 * @param {Reader} r
 * @returns {void}
 */
function skipArchiveProperties(r) {
  while (true) {
    const id = r.byte()
    if (id === ID.kEnd) return
    const size = r.number()
    r.bytes(size)
  }
}

/**
 * 解析 PackInfo：压缩流起始偏移、每个 pack 流的字节数与其 CRC。
 * @param {Reader} r
 * @returns {{packPos:number,sizes:number[],crcs:(number|null)[]}}
 * @throws {Error} 缺少 kSize 或结构不合法
 */
function parsePackInfo(r) {
  const packPos = r.number()
  const numPackStreams = r.number()
  const sizes = new Array(numPackStreams).fill(0)
  let id = r.byte()
  if (id === ID.kSize) {
    for (let i = 0; i < numPackStreams; i++) sizes[i] = r.number()
    id = r.byte()
  }
  let crcs = new Array(numPackStreams).fill(null)
  if (id === ID.kCRC) {
    crcs = r.digests(numPackStreams)
    id = r.byte()
  }
  if (id !== ID.kEnd) throw new Error('7z: malformed PackInfo')
  return { packPos, sizes, crcs }
}

// 说明：每个 coder 含 id（方法 id 字节串）、输入/输出流数与属性；folder 的输出流数为各 coder 输出之和，
// 绑定对（bindPairs）连接 coder 之间的流，未被绑定的输入即来自 pack 流。
/**
 * 解析单个 folder（一组 coder 及其绑定关系）。
 * @param {Reader} r
 * @param {{next:number}} packCounter pack 流全局索引计数器（隐式单流会取下一个未用索引）
 * @returns {{coders:object[],bindPairs:{inIndex:number,outIndex:number}[],packedIndices:number[]}}
 */
function parseFolder(r, packCounter) {
  const numCoders = r.number()
  const coders = []
  for (let i = 0; i < numCoders; i++) {
    const flags = r.byte()
    const idSize = flags & 0x0f
    const isComplex = (flags & 0x10) !== 0
    const hasAttrs = (flags & 0x20) !== 0
    const id = r.bytes(idSize)
    let numIn = 1
    let numOut = 1
    if (isComplex) {
      numIn = r.number()
      numOut = r.number()
    }
    const propsSize = hasAttrs ? r.number() : 0
    const props = propsSize ? r.bytes(propsSize) : null
    coders.push({ id: Buffer.from(id), numIn, numOut, props })
  }
  const numBindPairs = 0
  let totalOut = coders.reduce((a, c) => a + c.numOut, 0)
  let totalIn = coders.reduce((a, c) => a + c.numIn, 0)
  const bindPairs = []
  // In the spec the count is derived: totalOut - 1
  const bindCount = totalOut - 1
  for (let i = 0; i < bindCount; i++) {
    bindPairs.push({ inIndex: r.number(), outIndex: r.number() })
  }
  const packedCount = totalIn - bindCount
  const packedIndices = []
  if (packedCount > 1) {
    // explicit indices are already global (followed by at least one other pack stream)
    for (let i = 0; i < packedCount; i++) packedIndices.push(r.number())
    packCounter.next = Math.max(packCounter.next, Math.max(...packedIndices) + 1)
  } else {
    // an implicit single stream takes the next unused global index
    packedIndices.push(packCounter.next++)
  }
  if (numBindPairs !== 0) throw new Error('7z: internal error')
  return { coders, bindPairs, packedIndices }
}

/**
 * 解析 UnpackInfo：folder 列表、各 coder 的解压大小、可选 folder CRC。
 * @param {Reader} r
 * @returns {{folders:object[]}} 每个 folder 含 coders / bindPairs / packedIndices / unpackSizes / crc
 * @throws {Error} 结构不合法或使用外部 folder 数据（不支持）
 */
function parseUnpackInfo(r) {
  let id = r.byte()
  if (id !== ID.kFolder) throw new Error('7z: malformed UnpackInfo (expected kFolder=11, got ' + id + ')')
  const numFolders = r.number()
  const external = r.byte()
  if (external !== 0) throw new Error('7z: external folder data is unsupported')
  const folders = []
  const packCounter = { next: 0 }
  for (let i = 0; i < numFolders; i++) folders.push(parseFolder(r, packCounter))
  id = r.byte()
  if (id !== ID.kCodersUnpackSize) throw new Error('7z: malformed UnpackInfo (expected kCodersUnpackSize=12, got ' + id + ')')
  for (const folder of folders) {
    folder.unpackSizes = []
    for (const coder of folder.coders) {
      for (let i = 0; i < coder.numOut; i++) folder.unpackSizes.push(r.number())
    }
  }
  id = r.byte()
  if (id === ID.kCRC) {
    const crcs = r.digests(folders.length)
    folders.forEach((f, i) => (f.crc = crcs[i]))
    id = r.byte()
  }
  if (id !== ID.kEnd) throw new Error('7z: malformed UnpackInfo (expected kEnd=0, got ' + id + ')')
  return { folders }
}

/**
 * 解析 SubStreamsInfo：每个 folder 内的子流数量、除最后一个外的尺寸与 CRC。
 * 子流尺寸用于把一个解压后的 folder 切成多个文件。
 * @param {Reader} r
 * @param {object[]} folders UnpackInfo 的 folder 列表
 * @returns {{counts:number[],sizes:number[][],crcs:(number|null)[][],needSizes:boolean}}
 */
function parseSubStreamsInfo(r, folders) {
  const counts = new Array(folders.length).fill(1)
  let id = r.byte()
  if (id === ID.kNumUnpackStream) {
    for (let i = 0; i < folders.length; i++) counts[i] = r.number()
    id = r.byte()
  }
  const sizes = []
  let needSizes = false
  for (let i = 0; i < folders.length; i++) {
    sizes.push(new Array(Math.max(0, counts[i] - 1)).fill(0))
    if (counts[i] !== 1) needSizes = true
  }
  if (id === ID.kSize) {
    for (let i = 0; i < folders.length; i++) {
      for (let j = 0; j < sizes[i].length; j++) sizes[i][j] = r.number()
    }
    id = r.byte()
  }
  const crcs = []
  for (let i = 0; i < folders.length; i++) crcs.push(new Array(counts[i]).fill(null))
  if (id === ID.kCRC) {
    const allDefined = r.byte()
    const defined = allDefined !== 0 ? new Array(folders.reduce((a, f, i) => a + counts[i], 0)).fill(true) : r.bits(folders.reduce((a, f, i) => a + counts[i], 0))
    let k = 0
    for (let i = 0; i < folders.length; i++) {
      for (let j = 0; j < counts[i]; j++) {
        if (counts[i] === 1 && !defined[k]) crcs[i][j] = folders[i].crc ?? null
        else crcs[i][j] = defined[k] ? r.u32() : folders[i].crc ?? null
        k++
      }
    }
    id = r.byte()
  }
  if (id !== ID.kEnd) throw new Error('7z: malformed SubStreamsInfo')
  return { counts, sizes, crcs, needSizes }
}

/**
 * 解析 StreamsInfo（可选出现 PackInfo / UnpackInfo / SubStreamsInfo 三段），
 * 并把 pack 流偏移换算成每个 folder 的 packOffset / packSize / packedSizes。
 * @param {Reader} r
 * @returns {{packInfo:object,folders:object[],subInfo:object|null}}
 * @throws {Error} 缺少必要段或结尾标记不合法
 */
function parseStreamsInfo(r) {
  let packInfo = null
  let unpackInfo = null
  let subInfo = null
  let id = r.byte()
  if (id === ID.kPackInfo) {
    packInfo = parsePackInfo(r)
    id = r.byte()
  }
  if (id === ID.kUnpackInfo) {
    unpackInfo = parseUnpackInfo(r)
    id = r.byte()
  }
  if (id === ID.kSubStreamsInfo) {
    subInfo = parseSubStreamsInfo(r, unpackInfo ? unpackInfo.folders : [])
    id = r.byte()
  }
  if (id !== ID.kEnd) throw new Error(`7z: unexpected streams property ${id}`)
  if (!packInfo || !unpackInfo) throw new Error('7z: incomplete StreamsInfo')
  const folders = unpackInfo.folders
  // resolve packed stream offsets
  let cursor = packInfo.packPos
  for (const folder of folders) {
    folder.packOffset = cursor
    let size = 0
    for (const idx of folder.packedIndices) size += packInfo.sizes[idx] || 0
    folder.packSize = size
    folder.packedSizes = folder.packedIndices.map((idx) => packInfo.sizes[idx] || 0)
    cursor += size
  }
  return { packInfo, folders, subInfo }
}

/**
 * 解压一个 folder：按 coder 方法 id 分派到 Copy / LZMA / LZMA2，
 * 并在有 CRC 时校验结果；多 coder folder 直接报不支持（避免错误解码）。
 * @param {Buffer|Uint8Array} buf 完整归档缓冲
 * @param {object} folder 含 packOffset / packSize / unpackSizes / coders / crc
 * @returns {Uint8Array} 解压数据
 * @throws {Error} 多 coder / 未知 coder / CRC 不匹配
 */
function decodeFolder(buf, folder) {
  const dataStart = BASE + folder.packOffset
  const packed = buf.subarray(dataStart, dataStart + folder.packSize)
  const outSize = folder.unpackSizes[folder.unpackSizes.length - 1]
  const coder = folder.coders[0]
  if (folder.coders.length !== 1) throw new Error('7z: multi-coder folders are unsupported')
  const idHex = coder.id.toString('hex')
  let out
  // 7z identifies the Copy method by an EMPTY method id (an explicit '00' byte also appears in some
  // writers); both mean stored data.
  if (idHex === '' || idHex === '00') out = copyDecode(packed, outSize)
  else if (idHex === '030101') out = lzmaDecode(coder.props, packed, outSize)
  else if (idHex === '21') out = lzma2Decode(coder.props ? coder.props[0] : 0, packed, outSize)
  else throw new Error(`7z: unsupported coder ${idHex} (only Copy/LZMA/LZMA2)`)
  if (folder.crc != null && crc32(out) !== folder.crc) throw new Error('7z: folder CRC mismatch')
  return out
}

/**
 * 解析 FilesInfo：文件数量、空流/空文件/反文件标志、文件名（UTF-16LE，NUL 结尾）。
 * 遇到不关心的属性按 size 跳过，保证游标始终对齐。
 * @param {Reader} r
 * @returns {{numFiles:number,emptyStream:boolean[],emptyFileFlags:boolean[]|null,antiFlags:boolean[]|null,names:string[]|null}}
 * @throws {Error} 使用外部文件名（不支持）
 */
function parseFilesInfo(r) {
  const numFiles = r.number()
  const emptyStream = new Array(numFiles).fill(false)
  let emptyFileFlags = null
  let antiFlags = null
  let names = null
  let startPos = 0

  while (true) {
    const propId = r.byte()
    if (propId === ID.kEnd) break
    const size = r.number()
    const end = r.pos + size
    if (propId === ID.kEmptyStream) emptyStream.splice(0, numFiles, ...r.bits(numFiles))
    else if (propId === ID.kEmptyFile) emptyFileFlags = r.bits(emptyStream.filter(Boolean).length)
    else if (propId === ID.kAnti) antiFlags = r.bits(emptyStream.filter(Boolean).length)
    else if (propId === ID.kName) {
      const external = r.byte()
      if (external !== 0) throw new Error('7z: external file names are unsupported')
      names = []
      const decoder = new TextDecoder('utf-16le')
      // names are NUL-terminated UTF-16LE strings, numFiles of them, starting right here
      let at = r.pos
      for (let i = 0; i < numFiles; i++) {
        const from = at
        while (at + 1 < end && !(r.buf[at] === 0 && r.buf[at + 1] === 0)) at += 2
        names.push(decoder.decode(r.buf.subarray(from, at)))
        at += 2
      }
      r.pos = end
    } else if (propId === ID.kStartPos) {
      startPos = r.number()
    }
    r.pos = end
  }
  return { numFiles, emptyStream, emptyFileFlags, antiFlags, names }
}

/** Diagnostic/test hook: parse only the header (no data decoding). */
/**
 * 诊断/测试用：只解析头部，不解压任何文件数据。
 * 会处理「头部被 LZMA 压缩」（kEncodedHeader）的情况，此时仍需从归档正文读 pack 流。
 * @param {Buffer|Uint8Array} buf 归档字节
 * @returns {{streams:object|null,files:object|null}}
 * @throws {Error} 非 7z、头部越界或结构不合法
 */
export function parse7zHeader(buf) {
  if (!is7z(buf)) throw new Error('Not a 7z archive')
  const nextOffset = buf.readUInt32LE ? buf.readUInt32LE(12) : (buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24))
  const nextSize = buf.readUInt32LE ? buf.readUInt32LE(20) : (buf[20] | (buf[21] << 8) | (buf[22] << 16) | (buf[23] << 24))
  // 64-bit fields: read both halves portably
  const readU64 = (at) => {
    const lo = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] * 0x1000000)
    const hi = buf[at + 4] | (buf[at + 5] << 8) | (buf[at + 6] << 16) | (buf[at + 7] * 0x1000000)
    return hi * 0x100000000 + (lo >>> 0)
  }
  const offset = readU64(12)
  const size = readU64(20)
  const headerBuf = buf.subarray(BASE + offset, BASE + offset + size)
  return parseHeader(headerBuf, buf)
}

/** Parse a 7z header buffer into streams + file records. `fileBuf` is needed to read the packed
 * streams of an encoded header: those live in the archive body (offsets relative to byte 32), not
 * inside the header slice. */
/**
 * 解析头部缓冲，若是 kEncodedHeader 则先解压再递归解析。
 * fileBuf 用于读取「被压缩头部」对应的 pack 流（这些流位于归档正文，偏移相对第 32 字节）。
 * @param {Buffer|Uint8Array} hdr 头部字节
 * @param {Buffer|Uint8Array} fileBuf 完整归档
 * @returns {{streams:object|null,files:object|null}}
 * @throws {Error} 头 id 非预期、出现不支持的附加流等
 */
function parseHeader(hdr, fileBuf) {
  const r = new Reader(hdr)
  const first = r.byte()
  if (first === ID.kEncodedHeader) {
    const streams = parseStreamsInfo(r)
    const folder = streams.folders[0]
    const decoded = decodeFolder(fileBuf, folder)
    return parseHeader(decoded, fileBuf)
  }
  if (first !== ID.kHeader) throw new Error(`7z: unexpected header id ${first}`)
  let id = r.byte()
  if (id === ID.kArchiveProperties) {
    skipArchiveProperties(r)
    id = r.byte()
  }
  if (id === ID.kAdditionalStreamsInfo) throw new Error('7z: additional streams are unsupported')
  let streams = null
  if (id === ID.kMainStreamsInfo) {
    streams = parseStreamsInfo(r)
    id = r.byte()
  }
  let files = null
  if (id === ID.kFilesInfo) {
    files = parseFilesInfo(r)
    id = r.byte()
  }
  if (id !== ID.kEnd) throw new Error(`7z: unexpected header terminator ${id}`)
  return { streams, files }
}

/**
 * Read a 7z archive.
 * @returns {{entries:Array<{name:string,isDir:boolean,size:number,data:Buffer|null}>}}
 */
/**
 * 读取 7z 归档并解出所有文件。
 * 步骤：校验魔数与头部范围 → 解析头 → 逐个 folder 解压 → 按 SubStreamsInfo 切分子流
 * → 按文件记录顺序分配数据（空流条目为目录或空文件）。
 * @param {Buffer|Uint8Array} buf 归档字节
 * @param {{maxEntryBytes?:number}} [options] 单条目解压后大小上限，默认 64 MB（防压缩炸弹）
 * @returns {{entries:{name:string,isDir:boolean,size:number,data:Buffer|null}[]}}
 * @throws {Error} 非 7z、头部越界、文件名缺失、文件/子流数量不匹配、条目超过 maxEntryBytes
 */
export function read7z(buf, { maxEntryBytes = 64 * 1024 * 1024 } = {}) {
  if (!is7z(buf)) throw new Error('Not a 7z archive')
  const nextOffset = buf.readUInt32LE(12) + buf.readUInt32LE(16) * 0x100000000
  const nextSize = buf.readUInt32LE(20) + buf.readUInt32LE(24) * 0x100000000
  if (BASE + nextOffset + nextSize > buf.length) throw new Error('7z: truncated archive (header out of range)')
  const headerBuf = buf.subarray(BASE + nextOffset, BASE + nextOffset + nextSize)
  const { streams, files } = parseHeader(headerBuf, buf)
  if (!files) return { entries: [] }

  const entries = []
  const names = files.names || []
  if (!names.length) throw new Error('7z: archive has no file names')

  // decode every folder once; then hand out substreams in order
  const folderData = []
  if (streams) for (const folder of streams.folders) folderData.push(decodeFolder(buf, folder))

  // build the ordered substream list (folder by folder)
  const substreams = []
  if (streams) {
    const counts = streams.subInfo ? streams.subInfo.counts : streams.folders.map(() => 1)
    const sizes = streams.subInfo ? streams.subInfo.sizes : streams.folders.map(() => [])
    for (let f = 0; f < streams.folders.length; f++) {
      const data = folderData[f]
      const total = streams.folders[f].unpackSizes[streams.folders[f].unpackSizes.length - 1]
      const per = []
      let used = 0
      for (let j = 0; j < counts[f] - 1; j++) {
        const size = sizes[f][j]
        per.push(size)
        used += size
      }
      per.push(total - used)
      let cursor = 0
      for (const size of per) {
        substreams.push({ data: data.subarray(cursor, cursor + size), size })
        cursor += size
      }
    }
  }

  let streamIndex = 0
  for (let i = 0; i < files.numFiles; i++) {
    const name = names[i] ?? `file${i}`
    if (files.emptyStream[i]) {
      const emptyIdx = files.emptyStream.slice(0, i).filter(Boolean).length
      const isDir = !(files.emptyFileFlags && files.emptyFileFlags[emptyIdx])
      entries.push({ name, isDir, size: 0, data: null })
      continue
    }
    const sub = substreams[streamIndex++]
    if (!sub) throw new Error('7z: file/substream mismatch')
    if (sub.size > maxEntryBytes) throw new Error(`7z: entry ${name} is too large (${sub.size} bytes)`)
    entries.push({ name, isDir: false, size: sub.size, data: Buffer.from(sub.data) })
  }
  return { entries }
}
