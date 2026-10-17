// Minimal, standards-compliant PNG encoder (8/16-bit, grey/RGB/RGBA, optional sRGB chunk).
// Uses the browser CompressionStream (zlib) with a stored-block fallback.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes) {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function concat(parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type)
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes, 0)
  crcInput.set(data, 4)
  dv.setUint32(8 + data.length, crc32(crcInput))
  return out
}

function storedZlib(bytes) {
  const parts = [new Uint8Array([0x78, 0x01])]
  let offset = 0
  while (offset < bytes.length) {
    const len = Math.min(65535, bytes.length - offset)
    const header = new Uint8Array([0x00, len & 255, (len >>> 8) & 255, ~len & 255, (~len >>> 8) & 255])
    parts.push(header)
    parts.push(bytes.subarray(offset, offset + len))
    offset += len
  }
  if (bytes.length === 0) parts.push(new Uint8Array([0x01, 0, 0, 0xff, 0xff]))
  const a = adler32(bytes)
  parts.push(new Uint8Array([(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255]))
  return concat(parts)
}

async function deflateZlib(bytes) {
  if (typeof CompressionStream === 'undefined') return storedZlib(bytes)
  let writer = null
  try {
    const cs = new CompressionStream('deflate')
    // Start consuming the readable side *before* writing: awaiting writer.close() first
    // would deadlock once the stream's internal queue hits backpressure.
    const responsePromise = new Response(cs.readable).arrayBuffer()
    writer = cs.writable.getWriter()
    const writePromise = (async () => {
      await writer.write(bytes)
      await writer.close()
    })()
    const result = await Promise.race([
      responsePromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 20000))
    ])
    await writePromise.catch(() => {})
    if (!result) {
      try {
        writer.abort()
      } catch (e) {
        /* ignore */
      }
      return storedZlib(bytes)
    }
    const out = new Uint8Array(result)
    if (out.length > 2 && (out[0] & 0x0f) === 8) return out
    return storedZlib(bytes)
  } catch (e) {
    return storedZlib(bytes)
  }
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function filterRow(type, cur, prev, bpp) {
  const n = cur.length
  const out = new Uint8Array(n)
  if (type === 0) {
    out.set(cur)
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0)
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev ? prev[i] : 0)
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      out[i] = cur[i] - ((a + b) >> 1)
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= bpp ? prev[i - bpp] : 0
      out[i] = cur[i] - paeth(a, b, c)
    }
  }
  return out
}

function filterScore(row) {
  let score = 0
  for (let i = 0; i < row.length; i++) score += row[i] < 128 ? row[i] : 256 - row[i]
  return score
}

/**
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {Uint8Array|Uint16Array} opts.data  packed samples, row-major, top-down, `channels` per pixel
 * @param {0|2|6} [opts.colorType] 0 = grey, 2 = RGB, 6 = RGBA
 * @param {8|16} [opts.bitDepth]
 * @param {boolean} [opts.srgb]
 */
export async function encodePng(opts) {
  const { width, height, data } = opts
  const colorType = opts.colorType ?? 6
  const bitDepth = opts.bitDepth ?? 8
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4
  const bytesPerSample = bitDepth / 8
  const samplesPerRow = width * channels
  const rowBytes = samplesPerRow * bytesPerSample
  const bpp = channels * bytesPerSample
  const raw = new Uint8Array((rowBytes + 1) * height)
  let p = 0
  let prevRow = null
  for (let y = 0; y < height; y++) {
    const cur = new Uint8Array(rowBytes)
    const start = y * samplesPerRow
    if (bitDepth === 8) {
      cur.set(data.subarray(start, start + samplesPerRow))
    } else {
      let q = 0
      for (let i = 0; i < samplesPerRow; i++) {
        const v = data[start + i] & 0xffff
        cur[q++] = (v >>> 8) & 255
        cur[q++] = v & 255
      }
    }
    // adaptive filter selection (None / Sub / Up / Average / Paeth)
    let bestType = 0
    let bestRow = cur
    let bestScore = Infinity
    for (let t = 0; t < 5; t++) {
      const candidate = filterRow(t, cur, prevRow, bpp)
      const score = filterScore(candidate)
      if (score < bestScore) {
        bestScore = score
        bestType = t
        bestRow = candidate
      }
    }
    raw[p++] = bestType
    raw.set(bestRow, p)
    p += rowBytes
    prevRow = cur
  }
  const zlib = await deflateZlib(raw)
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)]
  if (opts.srgb) parts.push(chunk('sRGB', new Uint8Array([0])))
  const software = new TextEncoder().encode('Software\0Substrate Texture Studio')
  parts.push(chunk('tEXt', software))
  parts.push(chunk('IDAT', zlib))
  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}
