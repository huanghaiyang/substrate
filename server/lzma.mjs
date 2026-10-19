// Zero-dependency LZMA / LZMA2 decoders (raw streams, as used inside 7z folders).
//
// Why this exists: a .sbsar is a **7-Zip (LZMA) archive** — Adobe's own docs say to unpack it with
// "the LZMA decoder of your choice" and then read `assemblies/content/0000/<Graph>.xml` plus
// `metadata.json`. Node ships zlib (deflate) but no LZMA, so the archive reader needs its own.
//
// Scope: exactly what 7z folders use for substance packages — a single LZMA or LZMA2 coder, or a
// stored (copy) stream. BCJ/Delta/ARM64 filter chains are not implemented; the 7z reader reports those
// as unsupported instead of returning wrong bytes.
//
// The algorithms follow the public LZMA specification (range coder + LZ77 + context-modelled literals).

const TOP = 1 << 24
const MASK32 = 0xffffffff

/** Range decoder over a byte buffer. */
function createRangeDecoder(buf) {
  let pos = 0
  let range = MASK32
  let code = 0
  const first = buf[pos++]
  if (first !== 0) throw new Error('LZMA: corrupt stream (range coder init byte != 0)')
  for (let i = 0; i < 4; i++) {
    code = ((code << 8) | buf[pos++]) >>> 0
    range = MASK32
  }

  function normalize() {
    while (range < TOP) {
      range = (range << 8) >>> 0
      code = ((code << 8) | (pos < buf.length ? buf[pos++] : 0)) >>> 0
    }
  }

  return {
    get pos() { return pos },
    bit(probs, index) {
      const p = probs[index]
      const bound = ((range >>> 11) * p) >>> 0
      let bit
      if (code < bound) {
        range = bound
        probs[index] = p + ((2048 - p) >>> 5)
        bit = 0
      } else {
        range = (range - bound) >>> 0
        code = (code - bound) >>> 0
        probs[index] = p - (p >>> 5)
        bit = 1
      }
      normalize()
      return bit
    },
    directBits(count) {
      let result = 0
      for (let i = 0; i < count; i++) {
        range = (range >>> 1) >>> 0
        code = (code - range) >>> 0
        const borrow = code >>> 31 // 1 when the subtraction underflowed
        if (borrow) code = (code + range) >>> 0
        result = ((result << 1) | (1 - borrow)) >>> 0
        normalize()
      }
      return result >>> 0
    },
    bitTree(probs, offset, bits) {
      let m = 1
      for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probs, offset + m)
      return m - (1 << bits)
    },
    reverseBitTree(probs, offset, bits) {
      let m = 1
      let symbol = 0
      for (let i = 0; i < bits; i++) {
        const bit = this.bit(probs, offset + m)
        m = (m << 1) | bit
        symbol |= bit << i
      }
      return symbol
    }
  }
}

function lzmaState(lc, lp, pb) {
  return {
    lc,
    lp,
    pb,
    state: 0,
    rep0: 0,
    rep1: 0,
    rep2: 0,
    rep3: 0,
    isMatch: new Uint16Array(12 * 16).fill(1024),
    isRep: new Uint16Array(12).fill(1024),
    isRepG0: new Uint16Array(12).fill(1024),
    isRepG1: new Uint16Array(12).fill(1024),
    isRepG2: new Uint16Array(12).fill(1024),
    isRep0Long: new Uint16Array(12 * 16).fill(1024),
    posSlot: Array.from({ length: 4 }, () => new Uint16Array(64).fill(1024)),
    // specPos needs (rep0 - posSlot - 1) up to 114 as a valid index.
    posDecoders: new Uint16Array(118).fill(1024),
    align: new Uint16Array(16).fill(1024),
    // LZMA keeps TWO independent length coders: one for ordinary matches and one for rep matches.
    // Sharing one set corrupts the model slowly (output stays correct for dozens of bytes, then diverges).
    len: newLenCoder(),
    repLen: newLenCoder(),
    literal: null // sized lazily: 0x300 << (lc + lp)
  }
}

function newLenCoder() {
  return {
    choice: new Uint16Array(2).fill(1024),
    low: Array.from({ length: 16 }, () => new Uint16Array(8).fill(1024)),
    mid: Array.from({ length: 16 }, () => new Uint16Array(8).fill(1024)),
    high: new Uint16Array(256).fill(1024)
  }
}

function resetLenCoder(c) {
  c.choice.fill(1024)
  for (const a of c.low) a.fill(1024)
  for (const a of c.mid) a.fill(1024)
  c.high.fill(1024)
}

function resetState(s) {
  s.state = 0
  s.rep0 = s.rep1 = s.rep2 = s.rep3 = 0
  for (const arr of [s.isMatch, s.isRep, s.isRepG0, s.isRepG1, s.isRepG2, s.isRep0Long, s.posDecoders, s.align]) arr.fill(1024)
  for (const arr of s.posSlot) arr.fill(1024)
  resetLenCoder(s.len)
  resetLenCoder(s.repLen)
  s.literal = null
}

/** Decode one LZMA symbol stream into `out` (a Uint8Array view) for `outSize` bytes. */
function decodeLzmaStream(state, rc, out, outStart, outSize, dictStart) {
  const { lc, lp, pb } = state
  const pbMask = (1 << pb) - 1
  const lpMask = (1 << lp) - 1
  if (!state.literal) state.literal = new Uint16Array(0x300 << (lc + lp)).fill(1024)
  const lit = state.literal
  let pos = outStart
  const end = outStart + outSize

  // two independent length coders: ordinary matches vs rep matches (LZMA spec)
  const decodeLen = (coder, posState) => {
    if (rc.bit(coder.choice, 0) === 0) return rc.bitTree(coder.low[posState], 0, 3)
    if (rc.bit(coder.choice, 1) === 0) return 8 + rc.bitTree(coder.mid[posState], 0, 3)
    return 16 + rc.bitTree(coder.high, 0, 8)
  }

  while (pos < end) {
    const posState = pos & pbMask
    if (rc.bit(state.isMatch, (state.state << 4) + posState) === 0) {
      // ---------------- literal
      const prevByte = pos > dictStart ? out[pos - 1] : 0
      const base = 0x300 * (((pos & lpMask) << lc) + (prevByte >> (8 - lc)))
      let symbol = 1
      if (state.state >= 7) {
        // matched literal: bias the context with the byte at the current match distance
        let matchByte = pos - state.rep0 - 1 >= dictStart ? out[pos - state.rep0 - 1] : 0
        do {
          const matchBit = (matchByte >> 7) & 1
          matchByte = (matchByte << 1) & 0xff
          const bit = rc.bit(lit, base + ((1 + matchBit) << 8) + symbol)
          symbol = (symbol << 1) | bit
          if (matchBit !== bit) break
        } while (symbol < 0x100)
      }
      while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(lit, base + symbol)
      out[pos++] = symbol & 0xff
      state.state = state.state < 4 ? 0 : state.state < 10 ? state.state - 3 : state.state - 6
      continue
    }

    // ---------------- match (rep or new)
    let length
    if (rc.bit(state.isRep, state.state)) {
      if (pos === dictStart) throw new Error('LZMA: corrupt stream (rep match at start)')
      if (rc.bit(state.isRepG0, state.state) === 0) {
        if (rc.bit(state.isRep0Long, (state.state << 4) + posState) === 0) {
          // short rep: one byte at rep0, no history rotation
          state.state = state.state < 7 ? 9 : 11
          out[pos] = out[pos - state.rep0 - 1]
          pos++
          continue
        }
      } else {
        let dist
        if (rc.bit(state.isRepG1, state.state) === 0) {
          dist = state.rep1
        } else {
          if (rc.bit(state.isRepG2, state.state) === 0) {
            dist = state.rep2
          } else {
            dist = state.rep3
            state.rep3 = state.rep2
          }
          state.rep2 = state.rep1
        }
        state.rep1 = state.rep0
        state.rep0 = dist
      }
      length = decodeLen(state.repLen, posState) + 2
      state.state = state.state < 7 ? 8 : 11
    } else {
      state.rep3 = state.rep2
      state.rep2 = state.rep1
      state.rep1 = state.rep0
      length = decodeLen(state.len, posState) + 2
      state.state = state.state < 7 ? 7 : 10
      const lenState = length - 2 < 4 ? length - 2 : 3
      const slot = rc.bitTree(state.posSlot[lenState], 0, 6)
      if (slot < 4) {
        state.rep0 = slot
      } else {
        const directBits = (slot >> 1) - 1
        state.rep0 = (2 | (slot & 1)) << directBits
        if (slot < 14) {
          state.rep0 += rc.reverseBitTree(state.posDecoders, state.rep0 - slot - 1, directBits)
        } else {
          state.rep0 = (state.rep0 + (((rc.directBits(directBits - 4) << 4) >>> 0) + rc.reverseBitTree(state.align, 0, 4))) >>> 0
        }
        if (state.rep0 === 0xffffffff) break // end marker
      }
    }

    const from = pos - state.rep0 - 1
    if (from < dictStart) throw new Error('LZMA: corrupt stream at pos ' + pos + ' (match distance ' + (state.rep0 + 1) + ' exceeds available output)')
    for (let i = 0; i < length && pos < end; i++) {
      out[pos] = out[from + i]
      pos++
    }
  }

}

/** Decode a raw LZMA (LZMA1) stream. `props` = 5 bytes. */
export function lzmaDecode(props, buf, outSize) {
  if (!props || props.length < 5) throw new Error('LZMA: missing properties')
  const d = props[0]
  const lc = d % 9
  const lp = Math.floor(d / 9) % 5
  const pb = Math.floor(d / 45)
  if (pb > 4) throw new Error('LZMA: invalid property byte')
  const out = new Uint8Array(outSize)
  const st = lzmaState(lc, lp, pb)
  const rc = createRangeDecoder(buf)
  try {
    decodeLzmaStream(st, rc, out, 0, outSize, 0)
  } catch (e) {
    e.partial = out
    e.decodedBytes = st.__pos || 0
    throw e
  }
  return out
}

/** Decode a raw LZMA2 stream (as used by 7-Zip's default "-m0=lzma2"). */
export function lzma2Decode(propByte, buf, outSize) {
  const dictSize = (() => {
    if (propByte > 40) throw new Error('LZMA2: invalid dictionary property')
    if (propByte === 40) return 0xffffffff
    return (2 | (propByte & 1)) * Math.pow(2, Math.floor(propByte / 2) + 11)
  })()
  const out = new Uint8Array(outSize)
  let ip = 0
  let op = 0
  let st = null
  let needDictReset = true
  let needProps = true
  let dictStart = 0

  while (ip < buf.length && op < outSize) {
    const control = buf[ip++]
    if (control === 0) break
    if (control === 1 || control === 2) {
      // uncompressed chunk
      const size = ((buf[ip] << 8) | buf[ip + 1]) + 1
      ip += 2
      if (control === 1) {
        needDictReset = false
        dictStart = op
        if (st) resetState(st)
        needProps = true
      } else if (needDictReset) {
        throw new Error('LZMA2: corrupt stream (uncompressed chunk before dictionary reset)')
      }
      out.set(buf.subarray(ip, ip + size), op)
      ip += size
      op += size
      continue
    }
    if (control < 0x80) throw new Error('LZMA2: invalid control byte ' + control)

    let unpacked = ((control & 0x1f) << 16) | (buf[ip] << 8) | buf[ip + 1]
    unpacked += 1
    ip += 2
    const compressed = ((buf[ip] << 8) | buf[ip + 1]) + 1
    ip += 2
    const reset = (control >> 5) & 3
    if (reset === 3) {
      needDictReset = false
      dictStart = op
      if (!st) st = lzmaState(3, 0, 2)
      resetState(st)
      needProps = true
    } else if (reset === 2) {
      if (!st) st = lzmaState(3, 0, 2)
      resetState(st)
      needProps = true
    } else if (reset === 1) {
      if (!st) throw new Error('LZMA2: corrupt stream (state reset without previous state)')
      resetState(st)
    } else if (needProps) {
      throw new Error('LZMA2: corrupt stream (chunk without properties)')
    }
    if (needProps) {
      const d = buf[ip++]
      const lc = d % 9
      const lp = Math.floor(d / 9) % 5
      const pb = Math.floor(d / 45)
      if (pb > 4) throw new Error('LZMA2: invalid lc/lp/pb')
      if (!st) st = lzmaState(3, 0, 2)
      st.lc = lc
      st.lp = lp
      st.pb = pb
      st.literal = null
      needProps = false
    }
    const chunk = buf.subarray(ip, ip + compressed)
    ip += compressed
    const rc = createRangeDecoder(chunk)
    decodeLzmaStream(st, rc, out, op, unpacked, dictStart)
    op += unpacked
  }
  if (op !== outSize) throw new Error(`LZMA2: size mismatch (decoded ${op}, expected ${outSize})`)
  return out
}

/** Copy coder: data is stored as-is. */
export function copyDecode(buf, outSize) {
  const out = new Uint8Array(outSize)
  out.set(buf.subarray(0, Math.min(outSize, buf.length)))
  return out
}
