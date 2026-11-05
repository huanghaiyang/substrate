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

/** Raised cosine (Hann), Hermite smoothstep or linear ramp: 1 at the border, 0 at `band`. */
function featherCurve(t, band, curve) {
  const e = Math.min(1, Math.max(0, t / Math.max(band, 1e-4)))
  if (curve === 1) {
    const x = 1 - e
    return x * x * (3 - 2 * x)
  }
  if (curve === 2) return 1 - e
  return 0.5 + 0.5 * Math.cos(Math.PI * e)
}

/** Feather weight for a coordinate inside the 0..1 tile: 1 exactly on the border. */
function edgeWeight(t, band, curve) {
  if (t < band) return featherCurve(t, band, curve)
  if (t > 1 - band) return featherCurve(1 - t, band, curve)
  return 0
}

/**
 * Make an image tile seamlessly (CPU twin of the `seamless_tile` shader node).
 * mode 0 = edge blend: opposite borders feather towards their shared average
 * mode 2 = wrap blend: cross-fade into a half-shifted copy (Photoshop "Offset" workflow)
 * mode 1 = mirror: the frame is mirrored around its centre so every border repeats itself
 * `curve` selects cosine / smoothstep / linear falloff; passes are separable, horizontal first.
 * Returns the source canvas untouched when disabled.
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
  const shiftX = Math.floor(w / 2)
  const shiftY = Math.floor(h / 2)

  // pass 1 — horizontal seam
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

  // pass 2 — vertical seam, using the already horizontally feathered rows
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
