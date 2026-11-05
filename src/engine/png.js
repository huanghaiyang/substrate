/**
 * 极简但符合规范的 PNG 编码器（浏览器端）。
 *
 * 支持 8/16 位、灰度(0)/RGB(2)/RGBA(6) 三种颜色类型，可选写入 sRGB 与 tEXt 块。
 * 压缩优先使用浏览器内置的 CompressionStream（zlib），
 * 不可用时回退到「stored（不压缩）」块实现，保证任何环境都能产出合法 PNG。
 *
 * 为什么自己实现：项目是零打包 ESM，不引入第三方 PNG 库；
 * 而浏览器 canvas.toDataURL 只能输出 8 位、无法控制 16 位高度图与 sRGB 元数据。
 */
const CRC_TABLE = (() => {
  // 预计算 CRC-32 查表（多项式 0xEDB88320，即反射后的 0x04C11DB7）
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** 计算字节序列的 CRC-32（PNG 每个 chunk 都需要用它校验）。 */
function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 计算 zlib 流所需的 Adler-32 校验值。 */
function adler32(bytes) {
  let a = 1
  let b = 0
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

/** 把多个 Uint8Array 片段拼接成一个新数组。 */
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

/**
 * 构造一个 PNG chunk：长度(4) + 类型(4) + 数据 + CRC(4)。
 * CRC 覆盖「类型 + 数据」，不包含长度字段。
 */
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

/**
 * 生成「stored（不压缩）」的 zlib 数据流。
 * 用于 CompressionStream 缺失或超时时的兜底方案。数据被切成 ≤65535 字节的块，
 * 每块使用 stored 块头（类型 0x00，带原始长度与反码长度），最后附 Adler-32。
 */
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

/**
 * 使用浏览器 CompressionStream('deflate') 压缩 zlib 数据。
 * 关键细节：必须在写入数据之前就开始消费 readable 端（Response.arrayBuffer），
 * 否则当内部队列达到背压上限时，writer.close() 会一直等待而互相死锁（见下方注释）。
 * 设有 20 秒超时：一旦卡住就中止写入并退回 storedZlib，保证导出流程不会永远挂起。
 */
async function deflateZlib(bytes) {
  if (typeof CompressionStream === 'undefined') return storedZlib(bytes)
  let writer = null
  try {
    const cs = new CompressionStream('deflate')
    // 先开始消费 readable 端：若先 await writer.close()，一旦流内部队列达到背压就会死锁
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

/** PNG Paeth 预测器：从 a(左)、b(上)、c(左上) 中选出与 p=a+b-c 最接近的参考值。 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 按 PNG 滤波类型（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth）处理一行像素。
 * bpp 为一个像素占用的字节数（用于定位左侧参考像素）。
 */
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

/**
 * 给滤波后的行打分：把每个字节按「有符号绝对值」累加（即取 0 的绝对距离）。
 * 分数越小说明数据越接近 0，压缩率越高；编码时选择分数最低的滤波类型。
 */
function filterScore(row) {
  let score = 0
  for (let i = 0; i < row.length; i++) score += row[i] < 128 ? row[i] : 256 - row[i]
  return score
}

/**
 * 把像素数据编码为 PNG 文件字节。
 *
 * 编码流程：逐行写滤波字节与滤波后的像素（自适应选择 5 种滤波里分数最低的）→
 * zlib 压缩 → 组装 IHDR / 可选 sRGB / tEXt / IDAT / IEND chunk。
 *
 * @param {object} opts
 * @param {number} opts.width 图像宽度
 * @param {number} opts.height 图像高度
 * @param {Uint8Array|Uint16Array} opts.data 按行优先、自上而下排列的样本数据，每像素 `channels` 个分量；
 *   16 位时请传入 Uint16Array（每个元素 0..65535，内部按大端写入）
 * @param {0|2|6} [opts.colorType] 0=灰度，2=RGB，6=RGBA（默认 6）
 * @param {8|16} [opts.bitDepth] 位深（默认 8）
 * @param {boolean} [opts.srgb] 是否写入 sRGB chunk（颜色贴图应为 true，数据贴图应为 false）
 * @returns {Promise<Uint8Array>} PNG 文件字节
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
    // 自适应滤波：依次尝试 5 种类型（None/Sub/Up/Average/Paeth），保留得分最低的一行
    let bestType = 0
    // 注意：raw 每行先写 1 个滤波类型字节，再写滤波后的像素数据
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
  // IHDR：宽、高、位深、颜色类型、压缩方法(0)、滤波方法(0)、隔行方式(0)
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
  // sRGB chunk（渲染意图 0 = perceptual），让引擎正确识别颜色贴图
  if (opts.srgb) parts.push(chunk('sRGB', new Uint8Array([0])))
  // tEXt 记录生成软件，便于验证导出包来源
  const software = new TextEncoder().encode('Software\0Substrate Texture Studio')
  parts.push(chunk('tEXt', software))
  parts.push(chunk('IDAT', zlib))
  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}
