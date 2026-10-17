// Built-in brush presets and CPU stamp helpers for the Paint Studio.
//
// A brush preset describes the *character* of the stamp (shape, falloff, grain, scatter,
// spacing, flow). The stroke still carries colour/opacity/size/erase/symmetry, and the user
// can override hardness/flow/spacing from the Paint Studio.
//
// Performance: every brush dab is pre-rendered once into a small sprite canvas (with 3 grain
// variants) and then blitted with drawImage. Painting a long stroke therefore costs one blit
// per stamp instead of rebuilding gradients and hundreds of grain circles per stamp, which
// keeps the canvas responsive.

const TAU = Math.PI * 2

export const BRUSHES = [
  {
    id: 'soft-round',
    nameKey: 'brush.softRound',
    shape: 'round',
    hardness: 0.05,
    spacing: 0.1,
    flow: 0.55,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: false
  },
  {
    id: 'hard-round',
    nameKey: 'brush.hardRound',
    shape: 'round',
    hardness: 0.96,
    spacing: 0.08,
    flow: 1,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: false
  },
  {
    id: 'pencil',
    nameKey: 'brush.pencil',
    shape: 'round',
    hardness: 0.92,
    spacing: 0.045,
    flow: 0.7,
    grain: 0.45,
    scatter: 0.05,
    angle: 18,
    flatness: 1,
    sizeScale: 0.72,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'ink',
    nameKey: 'brush.ink',
    shape: 'round',
    hardness: 0.98,
    spacing: 0.03,
    flow: 1,
    grain: 0,
    scatter: 0,
    angle: 0,
    flatness: 1,
    sizeScale: 0.62,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'airbrush',
    nameKey: 'brush.airbrush',
    shape: 'round',
    hardness: 0,
    spacing: 0.055,
    flow: 0.09,
    grain: 0.06,
    scatter: 0.14,
    angle: 0,
    flatness: 1,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'marker',
    nameKey: 'brush.marker',
    shape: 'flat',
    hardness: 0.72,
    spacing: 0.035,
    flow: 0.45,
    grain: 0,
    scatter: 0,
    angle: 32,
    flatness: 0.42,
    pressureSize: false,
    pressureFlow: false
  },
  {
    id: 'chalk',
    nameKey: 'brush.chalk',
    shape: 'round',
    hardness: 0.5,
    spacing: 0.07,
    flow: 0.5,
    grain: 0.92,
    scatter: 0.5,
    angle: 24,
    flatness: 1,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'spray',
    nameKey: 'brush.spray',
    shape: 'spray',
    hardness: 0.9,
    spacing: 0.1,
    flow: 0.7,
    grain: 0.55,
    scatter: 1.1,
    angle: 0,
    flatness: 1,
    dots: 9,
    dotScale: 0.16,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'sponge',
    nameKey: 'brush.sponge',
    shape: 'round',
    hardness: 0.42,
    spacing: 0.16,
    flow: 0.38,
    grain: 0.85,
    scatter: 0.42,
    angle: 0,
    flatness: 1,
    pressureSize: false,
    pressureFlow: true
  },
  {
    id: 'flat',
    nameKey: 'brush.flat',
    shape: 'flat',
    hardness: 0.88,
    spacing: 0.05,
    flow: 0.66,
    grain: 0,
    scatter: 0,
    angle: 60,
    flatness: 0.22,
    pressureSize: true,
    pressureFlow: false
  }
]

export const DEFAULT_BRUSH_ID = 'soft-round'

export function brushById(id) {
  return BRUSHES.find((b) => b.id === id) || BRUSHES[0]
}

/** Merge stroke overrides with the selected brush preset. */
export function resolveBrush(stroke = {}) {
  const base = brushById(stroke.brushId || DEFAULT_BRUSH_ID)
  const num = (v, fallback) => (v === undefined || v === null || Number.isNaN(Number(v)) ? fallback : Number(v))
  return {
    ...base,
    size: num(stroke.size, 40),
    opacity: Math.min(1, Math.max(0, num(stroke.opacity, 1))),
    hardness: Math.min(0.999, Math.max(0, num(stroke.hardness, base.hardness))),
    flow: Math.min(1, Math.max(0.01, num(stroke.flow, base.flow))),
    spacing: Math.min(1, Math.max(0.01, num(stroke.spacing, base.spacing))),
    scatter: Math.min(2, Math.max(0, num(stroke.scatter, base.scatter))),
    grain: Math.min(1, Math.max(0, num(stroke.grain, base.grain))),
    angle: num(stroke.angle, base.angle),
    erase: !!stroke.erase,
    symmetry: stroke.symmetry || {}
  }
}

// Deterministic value noise so a stroke looks identical every time it is re-rasterised
// (live painting, undo/redo, project reload).
export function hash01(x, y, z = 0) {
  let h = Math.imul(Math.floor(x * 127.1 + y * 311.7 + z * 74.7), 0x27d4eb2d)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

function ellipsePath(ctx, x, y, rx, ry, angle) {
  ctx.beginPath()
  ctx.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), angle, 0, TAU)
  ctx.closePath()
}

function paintStampShape(ctx, x, y, radius, brush, alpha, colStr, seed) {
  const hardness = brush.hardness
  const angle = ((brush.angle || 0) * Math.PI) / 180
  const flatness = Math.max(0.08, Math.min(1, brush.flatness ?? 1))
  if (brush.shape === 'spray') {
    const dots = brush.dots || 8
    const spread = radius * (0.9 + brush.scatter * 0.6)
    ctx.fillStyle = `rgba(${colStr},${Math.min(1, alpha * 1.25)})`
    for (let i = 0; i < dots; i++) {
      const a = hash01(seed, i, 11) * TAU
      const d = Math.sqrt(hash01(seed, i, 37)) * spread
      const dr = Math.max(0.6, radius * (brush.dotScale || 0.16) * (0.6 + hash01(seed, i, 71) * 0.9))
      ctx.beginPath()
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, dr, 0, TAU)
      ctx.fill()
    }
    return
  }
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
  const inner = Math.max(0, Math.min(0.985, hardness))
  g.addColorStop(0, `rgba(${colStr},${alpha})`)
  g.addColorStop(inner, `rgba(${colStr},${alpha})`)
  g.addColorStop(1, `rgba(${colStr},0)`)
  ctx.save()
  ctx.translate(x, y)
  if (flatness < 0.999) {
    ctx.rotate(angle)
    ctx.scale(1, flatness)
  }
  ctx.fillStyle = g
  if (brush.shape === 'flat') {
    ellipsePath(ctx, 0, 0, radius, radius, 0)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.arc(0, 0, radius, 0, TAU)
    ctx.fill()
  }
  ctx.restore()

  // grain: punch small holes in the stamp for chalk / sponge / pencil texture
  if (brush.grain > 0.01) {
    const holes = Math.round(6 + brush.grain * 34)
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < holes; i++) {
      const a = hash01(seed, i, 3) * TAU
      const d = Math.sqrt(hash01(seed, i, 9)) * radius
      const hr = Math.max(0.4, radius * (0.06 + hash01(seed, i, 17) * 0.22) * brush.grain)
      ctx.globalAlpha = 0.35 + hash01(seed, i, 23) * 0.6
      ctx.beginPath()
      ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, hr, 0, TAU)
      ctx.fill()
    }
    ctx.restore()
  }
}

// ---------------------------------------------------------------- stamp sprites
const SPRITE_VARIANTS = 3
const spriteCache = new Map()
const SPRITE_CACHE_LIMIT = 96

function spriteKey(brush, colStr, baseSize) {
  return [
    brush.id,
    Math.round(baseSize),
    colStr,
    brush.shape,
    Number(brush.hardness).toFixed(2),
    Number(brush.grain).toFixed(2),
    Number(brush.flatness ?? 1).toFixed(2),
    Number(brush.angle || 0).toFixed(1),
    brush.dots || 0,
    Number(brush.dotScale || 0).toFixed(2)
  ].join('|')
}

function buildSprites(brush, colStr, baseSize) {
  const base = Math.max(2, Math.min(512, Math.round(baseSize)))
  const pad = Math.ceil(base * 0.18) + 2
  const dim = base + pad * 2
  const sprites = []
  for (let v = 0; v < SPRITE_VARIANTS; v++) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = dim
    const ctx = canvas.getContext('2d')
    ctx.translate(dim / 2, dim / 2)
    paintStampShape(ctx, 0, 0, base / 2, brush, 1, colStr, 17.31 + v * 91.7)
    sprites.push(canvas)
  }
  return { sprites, dim, base }
}

/** Cached, pre-rendered stamp sprites for the current brush (3 grain variants). */
export function getStampSprites(brush, colStr, baseSize) {
  const key = spriteKey(brush, colStr, baseSize)
  let entry = spriteCache.get(key)
  if (!entry) {
    entry = buildSprites(brush, colStr, baseSize)
    spriteCache.set(key, entry)
    if (spriteCache.size > SPRITE_CACHE_LIMIT) {
      const first = spriteCache.keys().next().value
      spriteCache.delete(first)
    }
  }
  return entry
}

/** Paint one brush dab. Handles scatter, grain variants and X/Y symmetry. */
export function stampDab(ctx, x, y, radius, brush, colStr, pressure, width, height) {
  const p = Math.max(0.05, Math.min(1, pressure == null ? 1 : pressure))
  let r = brush.sizeScale ? radius * brush.sizeScale : radius
  if (brush.pressureSize) r *= 0.35 + 0.65 * p
  r = Math.max(0.6, r)
  let alpha = brush.opacity * brush.flow
  if (brush.pressureFlow) alpha *= 0.3 + 0.7 * p
  alpha = Math.max(0.015, Math.min(1, alpha))
  const baseSize = brush.size || radius * 2
  const entry = getStampSprites(brush, colStr, baseSize)
  const nominalRadius = entry.base / 2
  const scale = r / nominalRadius
  const jitter = brush.scatter * r * 0.65
  const positions = [[x, y]]
  const sym = brush.symmetry || {}
  if (sym.x) positions.push([width - x, y])
  if (sym.y) positions.push([x, height - y])
  if (sym.x && sym.y) positions.push([width - x, height - y])
  ctx.save()
  ctx.globalCompositeOperation = brush.erase ? 'destination-out' : 'source-over'
  for (const [baseX, baseY] of positions) {
    let px = baseX
    let py = baseY
    if (jitter > 0) {
      px += (hash01(baseX, baseY, 51) - 0.5) * 2 * jitter
      py += (hash01(baseX, baseY, 83) - 0.5) * 2 * jitter
    }
    if (px < -r || py < -r || px > width + r || py > height + r) continue
    const variant = entry.sprites[Math.floor(hash01(px, py, 7) * SPRITE_VARIANTS) % SPRITE_VARIANTS]
    const dw = entry.dim * scale
    ctx.globalAlpha = Math.max(0.01, Math.min(1, alpha))
    ctx.drawImage(variant, px - dw / 2, py - dw / 2, dw, dw)
  }
  ctx.restore()
}

const previewCache = new Map()

/** Small visual preview of a brush preset (stroke dab), cached for the brush picker. */
export function brushPreview(brush, size = 44) {
  const key = brush.id + ':' + size
  if (previewCache.has(key)) return previewCache.get(key)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const b = { ...brush, size: size * 0.6, opacity: Math.min(1, brush.opacity || 1), flow: Math.min(1, Math.max(0.35, brush.flow ?? 0.7)), erase: false, symmetry: {} }
  const col = '222,230,242'
  const n = 14
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    stampDab(ctx, size * (0.2 + 0.6 * t), size * (0.7 - 0.42 * Math.sin(t * Math.PI * 0.9)), size * 0.24, b, col, 0.45 + 0.55 * Math.sin(t * Math.PI), size, size)
  }
  const url = canvas.toDataURL('image/png')
  previewCache.set(key, url)
  return url
}
