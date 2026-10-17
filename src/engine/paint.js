// CPU rasterization of paint strokes into a canvas texture.
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
  const points = stroke.points || []
  if (!points.length) return
  const radius = Math.max(0.75, brush.size / 2)
  // spacing is relative to the brush diameter; small spacing = smooth, large = dotted
  const step = Math.max(0.6, brush.size * brush.spacing)
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = i ? points[i - 1] : null
    if (!prev) {
      stampDab(ctx, p.x * width, p.y * height, radius, brush, colStr, p.p ?? 1, width, height)
      continue
    }
    const dx = (p.x - prev.x) * width
    const dy = (p.y - prev.y) * height
    const dist = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.ceil(dist / step))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = prev.x + (p.x - prev.x) * t
      const y = prev.y + (p.y - prev.y) * t
      const pressure = (prev.p ?? 1) + ((p.p ?? 1) - (prev.p ?? 1)) * t
      stampDab(ctx, x * width, y * height, radius, brush, colStr, pressure, width, height)
    }
  }
}

export function rasterizeAll(canvas, strokes) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const s of strokes || []) drawStroke(ctx, s, canvas.width, canvas.height)
  return ctx
}
