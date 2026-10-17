// CPU rasterization of paint strokes into a canvas texture.
// Strokes are smoothed with Catmull-Rom → cubic Bézier segments and stamped with the
// selected brush preset. An optional pen taper ("笔锋") thins out both stroke ends.
import { hexToRgb } from './color.js'
import { resolveBrush, stampDab } from './brushes.js'

export const PAINT_SIZE = 1024

export function createPaintCanvas(size = PAINT_SIZE) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

function colorString(hex) {
  const rgb = hexToRgb(hex || '#ffffff')
  return `${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)}`
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

function cubic(p1, c1, c2, p2, t) {
  const u = 1 - t
  return {
    x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
    y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    p: u * u * u * p1.p + 3 * u * u * t * c1.p + 3 * u * t * t * c2.p + t * t * t * p2.p
  }
}

/**
 * Sample a smoothed stroke path (Catmull-Rom through the input points, emitted as cubic Béziers).
 * Returns stamps with position, pressure, cumulative arc length and the optional pen-taper
 * radius factor. drawStroke() and the tests share this helper.
 */
export function strokeSamples(points, width, height, step, opts = {}) {
  const pts = (points || []).map((p) => ({
    x: (p.x ?? 0) * width,
    y: (p.y ?? 0) * height,
    p: clamp(p.p ?? 1, 0.02, 1)
  }))
  if (!pts.length) return { samples: [], total: 0 }
  if (pts.length === 1) {
    return { samples: [{ x: pts[0].x, y: pts[0].y, p: pts[0].p, dist: 0, radiusScale: 1 }], total: 0 }
  }
  const spacing = Math.max(0.4, step || 1)
  const raw = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[Math.min(pts.length - 1, i + 2)]
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6, p: p1.p + (p2.p - p0.p) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6, p: p2.p - (p3.p - p1.p) / 6 }
    const approx =
      Math.hypot(c1.x - p1.x, c1.y - p1.y) +
      Math.hypot(c2.x - c1.x, c2.y - c1.y) +
      Math.hypot(p2.x - c2.x, p2.y - c2.y)
    const steps = Math.max(1, Math.ceil(approx / spacing))
    for (let s = i === 0 ? 0 : 1; s <= steps; s++) {
      raw.push(cubic(p1, c1, c2, p2, s / steps))
    }
  }
  // cumulative arc length
  let total = 0
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) total += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y)
    raw[i].dist = total
  }
  const taper = !!opts.taper
  const taperLength = clamp(opts.taperLength ?? 0.5, 0.02, 1)
  const size = opts.size || 40
  let taperPx = 0
  if (taper && total > 1) {
    taperPx = clamp(size * 1.5 + size * 2.5 * taperLength, size * 0.35, total * 0.45)
  }
  const samples = raw.map((s) => {
    let radiusScale = 1
    if (taperPx > 0) {
      const d = Math.min(s.dist, total - s.dist)
      const k = clamp(d / taperPx, 0, 1)
      // smoothstep-ish ease for a natural brush tip
      radiusScale = 0.12 + 0.88 * (k * k * (3 - 2 * k))
    }
    return { x: s.x, y: s.y, p: s.p, dist: s.dist, radiusScale }
  })
  return { samples, total }
}

export function drawStroke(ctx, stroke, width, height) {
  const brush = resolveBrush(stroke)
  const colStr = colorString(stroke.color)
  if (stroke.fill) {
    ctx.save()
    ctx.globalCompositeOperation = brush.erase ? 'destination-out' : 'source-over'
    ctx.globalAlpha = Math.min(1, Math.max(0, brush.opacity))
    ctx.fillStyle = `rgb(${colStr})`
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
    return
  }
  const radius = Math.max(0.75, brush.size / 2)
  // spacing is relative to the brush diameter; small spacing = smooth, large = dotted
  const step = Math.max(0.6, brush.size * brush.spacing)
  const { samples } = strokeSamples(stroke.points, width, height, step, {
    taper: !!stroke.taper,
    taperLength: stroke.taperLength,
    size: brush.size
  })
  for (const s of samples) {
    stampDab(ctx, s.x, s.y, radius * s.radiusScale, brush, colStr, s.p, width, height)
  }
}

export function rasterizeAll(canvas, strokes) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const s of strokes || []) drawStroke(ctx, s, canvas.width, canvas.height)
  return ctx
}
