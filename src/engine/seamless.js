// 无缝平铺的 CPU 实现，与 GPU 节点 `seamless_tile`（src/engine/nodes/filters.js）一一对应。
// 导入对话框用它做实时预览，所以这里的带宽比例、羽化曲线公式、镜像映射必须与着色器
// 保持数值一致；改动任何一边都要同步另一边，否则预览与最终材质会出现肉眼可见的差异。

/**
 * 把图片来源（data URL 或 object URL）解码成 HTMLImageElement。
 * 用 Promise 包装，方便在对话框的 async 流程里 await。
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image could not be decoded'))
    img.src = src
  })
}

/**
 * 把照片适配成方形贴图。
 * - fit = 'crop'：以中心裁出最大的正方形，保持原始比例、不拉伸，适合绝大多数素材；
 * - fit = 'stretch'：把整幅画面压进正方形，保留全部内容但会变形，适合本身就是满幅的贴图。
 * 输出尺寸取 min(上限, 源图长边)：上限固定 2048（引擎纹理上限），且只缩小不放大，
 * 避免把小图放大成一团模糊的插值像素。
 */
export function fitImageCanvas(img, { fit = 'crop', size = 2048 } = {}) {
  const iw = img.naturalWidth || img.width || 1
  const ih = img.naturalHeight || img.height || 1
  const cap = Math.max(32, Math.min(2048, Math.round(size) || 2048))
  const target = Math.max(32, Math.min(cap, Math.max(iw, ih)))
  const canvas = document.createElement('canvas')
  canvas.width = target
  canvas.height = target
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (fit === 'stretch') {
    ctx.drawImage(img, 0, 0, iw, ih, 0, 0, target, target)
  } else {
    const side = Math.min(iw, ih)
    ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, target, target)
  }
  return canvas
}

/**
 * 三种主流羽化曲线，输入 t 为“到边界的归一化距离”，输出权重。
 * 约定：t = 0（正好压在边界上）时返回 1，t = band 时返回 0，中间单调过渡。
 * - curve 0：升余弦（Hann 窗）0.5 + 0.5·cos(πe)。两端导数为 0，过渡最柔和，
 *   也是各类“Make It Tile / 无缝插件”默认使用的窗口函数；
 * - curve 1：Hermite smoothstep e²(3-2e)，同样是 S 形，但中段更陡、边缘更平；
 * - curve 2：线性斜坡 1 - e，过渡带最少“糊”，但会在带边缘留下轻微折痕。
 */
function featherCurve(t, band, curve) {
  const e = Math.min(1, Math.max(0, t / Math.max(band, 1e-4)))
  if (curve === 1) {
    const x = 1 - e
    return x * x * (3 - 2 * x)
  }
  if (curve === 2) return 1 - e
  return 0.5 + 0.5 * Math.cos(Math.PI * e)
}

/**
 * 计算某个归一化坐标的羽化权重：
 * 左侧 [0, band) 和右侧 (1-band, 1] 两段各用一条羽化曲线，中间完全不受影响（权重 0）。
 * 这样平铺时左边界与右边界会被“拉”到同一个状态，接缝自然消失。
 */
function edgeWeight(t, band, curve) {
  if (t < band) return featherCurve(t, band, curve)
  if (t > 1 - band) return featherCurve(1 - t, band, curve)
  return 0
}

/**
 * 让一张图片可以无缝平铺（GPU 节点 `seamless_tile` 的 CPU 版本）。
 *
 * 参数：
 * - mode = 0 边缘羽化：把左右（再上下）两侧的对边像素向它们的平均值羽化。
 *   这是 GIMP「Make Seamless」一类工具的经典做法；边界被压成同一个颜色，绝对无缝，
 *   代价是过渡带会丢失一点高频细节（因为是向均值“抹平”）。
 * - mode = 2 偏移交叉融合：与“水平/垂直各偏移半幅”的副本做交叉淡化，
 *   等价于 Photoshop 的 Offset 修复接缝流程。它混合的是真实纹理而不是均值，
 *   所以细节保留更好，但过渡带可能出现轻微重影。
 * - mode = 1 镜像：以画面中心镜像填充，边界天然重复，绝对无缝，但能看到对称重复。
 * - curve：0 余弦 / 1 smoothstep / 2 线性，参见 featherCurve。
 *
 * 算法都是“先水平、再垂直”的可分离两遍处理：
 *   第一遍只修左右接缝，第二遍在已经修好的结果上再修上下接缝，
 *   这样四个边界最终都会落在同一个状态，且只需 O(N) 时间。
 * 关闭无缝时原样返回源画布（GPU 节点同样直通）。
 */
export function processSeamless(source, { enabled = true, mode = 0, band = 0.08, curve = 0 } = {}) {
  if (!enabled || !source) return source
  const w = source.width
  const h = source.height
  if (!w || !h) return source
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const outCtx = out.getContext('2d')

  // 镜像模式：逐像素重映射，不涉及羽化。
  // 把左半幅映射到右半幅（右半幅是左半幅的镜像），垂直方向同理，
  // 于是 x=0 与 x=W-1 都取到源图中心列，平铺边界完全连续。
  if (mode === 1) {
    const halfW = Math.floor(w / 2)
    const halfH = Math.floor(h / 2)
    const img = outCtx.createImageData(w, h)
    const src = source.getContext('2d').getImageData(0, 0, w, h).data
    const dst = img.data
    for (let y = 0; y < h; y++) {
      const sy = y < halfH ? y + halfH : h - 1 - (y - halfH)
      for (let x = 0; x < w; x++) {
        const sx = x < halfW ? x + halfW : w - 1 - (x - halfW)
        const si = (sy * w + sx) * 4
        const di = (y * w + x) * 4
        dst[di] = src[si]
        dst[di + 1] = src[si + 1]
        dst[di + 2] = src[si + 2]
        dst[di + 3] = src[si + 3]
      }
    }
    outCtx.putImageData(img, 0, 0)
    return out
  }

  // shiftX / shiftY：偏移模式的“半幅”位移（与着色器里的 uv + 0.5 等价）
  const b = Math.max(band, 1e-4)
  const src = source.getContext('2d').getImageData(0, 0, w, h).data
  const hpass = new Uint8ClampedArray(src.length)
  const shiftX = Math.floor(w / 2)
  const shiftY = Math.floor(h / 2)

  // 第一遍：只处理水平方向（左右接缝）。
  // 对每一行，把 x 坐标换算成归一化位置 t = x/(w-1) 后取羽化权重 a：
  //   mode 0 → 目标色 = 该行左右边界像素的平均值（逐行计算，保留纵向明暗变化）
  //   mode 2 → 目标色 = 该行偏移半幅后的像素（即 (x + w/2) mod w 处）
  // 权重 a 为 0 的中间区域直接复制原像素，避免无谓的浮点运算。
  for (let y = 0; y < h; y++) {
    const row = y * w
    let tr = 0
    let tg = 0
    let tb = 0
    let ta = 0
    if (mode === 0) {
      const left = row * 4
      const right = (row + w - 1) * 4
      tr = (src[left] + src[right]) * 0.5
      tg = (src[left + 1] + src[right + 1]) * 0.5
      tb = (src[left + 2] + src[right + 2]) * 0.5
      ta = (src[left + 3] + src[right + 3]) * 0.5
    }
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4
      const a = w > 1 ? edgeWeight(x / (w - 1), b, curve) : 1
      if (a <= 0) {
        hpass[i] = src[i]
        hpass[i + 1] = src[i + 1]
        hpass[i + 2] = src[i + 2]
        hpass[i + 3] = src[i + 3]
        continue
      }
      if (mode === 2) {
        const j = (row + ((x + shiftX) % w)) * 4
        tr = src[j]
        tg = src[j + 1]
        tb = src[j + 2]
        ta = src[j + 3]
      }
      hpass[i] = src[i] * (1 - a) + tr * a
      hpass[i + 1] = src[i + 1] * (1 - a) + tg * a
      hpass[i + 2] = src[i + 2] * (1 - a) + tb * a
      hpass[i + 3] = src[i + 3] * (1 - a) + ta * a
    }
  }

  // 第二遍：只用已经完成水平羽化的 hpass 处理垂直方向（上下接缝），
  // 目标色同样取“上下边界平均值”或“纵向偏移半幅的像素”，
  // 因此最终四个边界都落在同一状态，横竖都不会再出现接缝。
  const outImg = outCtx.createImageData(w, h)
  const dst = outImg.data
  for (let x = 0; x < w; x++) {
    let tr = 0
    let tg = 0
    let tb = 0
    let ta = 0
    if (mode === 0) {
      const top = x * 4
      const bottom = ((h - 1) * w + x) * 4
      tr = (hpass[top] + hpass[bottom]) * 0.5
      tg = (hpass[top + 1] + hpass[bottom + 1]) * 0.5
      tb = (hpass[top + 2] + hpass[bottom + 2]) * 0.5
      ta = (hpass[top + 3] + hpass[bottom + 3]) * 0.5
    }
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      const a = h > 1 ? edgeWeight(y / (h - 1), b, curve) : 1
      if (a <= 0) {
        dst[i] = hpass[i]
        dst[i + 1] = hpass[i + 1]
        dst[i + 2] = hpass[i + 2]
        dst[i + 3] = hpass[i + 3]
        continue
      }
      if (mode === 2) {
        const j = (((y + shiftY) % h) * w + x) * 4
        tr = hpass[j]
        tg = hpass[j + 1]
        tb = hpass[j + 2]
        ta = hpass[j + 3]
      }
      dst[i] = hpass[i] * (1 - a) + tr * a
      dst[i + 1] = hpass[i + 1] * (1 - a) + tg * a
      dst[i + 2] = hpass[i + 2] * (1 - a) + tb * a
      dst[i + 3] = hpass[i + 3] * (1 - a) + ta * a
    }
  }
  outCtx.putImageData(outImg, 0, 0)
  return out
}

/**
 * 把画布编码成 data URL 存进节点。
 * 用 JPEG(0.92) 而不是 PNG：导入的照片通常没有透明通道，JPEG 能把 2048² 的贴图
 * 压到几百 KB～2 MB，避免自动保存（localStorage 约 5 MB）被单张贴图撑爆。
 */
export function canvasToDataURL(canvas, quality = 0.92) {
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * 把一张图按 cols×rows 平铺画进预览画布。
 * 对话框用它做 2×2 平铺，让用户直接看到接缝是否消失——
 * 单张图本身是看不出接缝的，必须平铺后边界才会暴露问题。
 */
export function drawTiled(canvas, image, cols = 2, rows = 2) {
  if (!canvas || !image) return
  const ctx = canvas.getContext('2d')
  const cellW = canvas.width / cols
  const cellH = canvas.height / rows
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) ctx.drawImage(image, c * cellW, r * cellH, cellW, cellH)
  }
}
