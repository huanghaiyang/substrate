// CPU twin of the `seamless_tile` GPU node (src/engine/nodes/filters.js).
// The import dialog previews with this implementation, so the band width, the cosine
// falloff and the mirror mapping must stay numerically identical to the shader.

/** Load an image source (data URL or object URL) into an HTMLImageElement. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Image could not be decoded'))
    img.src = src
  })
}

/**
 * Square-fit a photo for use as a texture: either centre-crop the largest square
 * (`fit: 'crop'`) or squash the whole frame into a square (`fit: 'stretch'`).
 * Never upscales beyond the source, capped at 2048 like the engine's texture limit.
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

/** Cosine edge weight: 1 exactly at the border, 0 once `band` is reached. */
function bandWeight(t, band) {
  if (t < band) return 0.5 + 0.5 * Math.cos(Math.PI * t / band)
  if (t > 1 - band) return 0.5 + 0.5 * Math.cos(Math.PI * (1 - t) / band)
  return 0
}

/**
 * Make an image tile seamlessly.
 * mode 0 = edge blend: the opposite borders are feathered towards their shared average,
 *          horizontally first and then vertically (two separable passes, exactly like the shader).
 * mode 1 = mirror: the frame is mirrored around its centre so every border repeats itself.
 * Returns the source canvas untouched when disabled.
 */
export function processSeamless(source, { enabled = true, mode = 0, band = 0.08 } = {}) {
  if (!enabled || !source) return source
  const w = source.width
  const h = source.height
  if (!w || !h) return source
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const outCtx = out.getContext('2d')

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

  const b = Math.max(band, 1e-4)
  const src = source.getContext('2d').getImageData(0, 0, w, h).data
  const hpass = new Uint8ClampedArray(src.length)
  // pass 1 — horizontal: each row is blended towards the average of its two border pixels
  for (let y = 0; y < h; y++) {
    const left = (y * w) * 4
    const right = (y * w + w - 1) * 4
    const mr = (src[left] + src[right]) * 0.5
    const mg = (src[left + 1] + src[right + 1]) * 0.5
    const mb = (src[left + 2] + src[right + 2]) * 0.5
    const ma = (src[left + 3] + src[right + 3]) * 0.5
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const a = w > 1 ? bandWeight(x / (w - 1), b) : 1
      hpass[i] = src[i] * (1 - a) + mr * a
      hpass[i + 1] = src[i + 1] * (1 - a) + mg * a
      hpass[i + 2] = src[i + 2] * (1 - a) + mb * a
      hpass[i + 3] = src[i + 3] * (1 - a) + ma * a
    }
  }
  // pass 2 — vertical: blend towards the average of the already feathered top/bottom rows
  const outImg = outCtx.createImageData(w, h)
  const dst = outImg.data
  for (let x = 0; x < w; x++) {
    const top = x * 4
    const bottom = ((h - 1) * w + x) * 4
    const mr = (hpass[top] + hpass[bottom]) * 0.5
    const mg = (hpass[top + 1] + hpass[bottom + 1]) * 0.5
    const mb = (hpass[top + 2] + hpass[bottom + 2]) * 0.5
    const ma = (hpass[top + 3] + hpass[bottom + 3]) * 0.5
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      const a = h > 1 ? bandWeight(y / (h - 1), b) : 1
      dst[i] = hpass[i] * (1 - a) + mr * a
      dst[i + 1] = hpass[i + 1] * (1 - a) + mg * a
      dst[i + 2] = hpass[i + 2] * (1 - a) + mb * a
      dst[i + 3] = hpass[i + 3] * (1 - a) + ma * a
    }
  }
  outCtx.putImageData(outImg, 0, 0)
  return out
}

/** JPEG keeps imported photos small enough for the autosaved project (no alpha needed). */
export function canvasToDataURL(canvas, quality = 0.92) {
  return canvas.toDataURL('image/jpeg', quality)
}

/** Draw a 2×2 (or larger) tiling of an image into a preview canvas. */
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
