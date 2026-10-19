// Zero-dependency 7-Zip (7z / LZMA) archive reader.
//
// .sbsar is a 7-Zip archive: Adobe's own publishing docs show the layout
//   assemblies/content/0000/<Graph>.sbsasm     (engine bytecode)
//   assemblies/content/0000/<Graph>.xml        (graph descriptor — what tools parse)
//   assemblies/content/0000/metadata.json      (package metadata, JSON)
//   assemblies/content/0000/resources/<n>/…    (generic resources)
// and state that readers should "open the archive with the LZMA decoder of your choice".
//
// Scope: enough of the 7z container to enumerate and extract normal archives — header (plain and
// LZMA-encoded), pack/unpack/folder info, substreams, file names/flags, folder CRCs. Coders supported:
// Copy, LZMA, LZMA2, each as a single-coder folder. BCJ/Delta filter chains are reported as
// unsupported rather than decoded incorrectly.
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

export const is7z = (buf) => buf.length >= 32 && buf.subarray(0, 6).equals(SIG)

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
  u32() {
    // manual little-endian read: buffers here can be Buffer or plain Uint8Array (decoded headers)
    const b = this.buf
    const p = this.pos
    this.pos += 4
    return ((b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0)
  }
  u64() {
    const lo = this.u32()
    const hi = this.u32()
    return hi * 0x100000000 + lo
  }
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
  digests(count) {
    // 7z writes a boolean "all defined" byte first; only a zero byte is followed by a bit vector.
    const allDefined = this.byte()
    const defined = allDefined !== 0 ? new Array(count).fill(true) : this.bits(count)
    const out = new Array(count)
    for (let i = 0; i < count; i++) out[i] = defined[i] ? this.u32() : null
    return out
  }
}

function skipArchiveProperties(r) {
  while (true) {
    const id = r.byte()
    if (id === ID.kEnd) return
    const size = r.number()
    r.bytes(size)
  }
}

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
