// CPU rasterization of paint strokes into a canvas texture.
import { hexToRgb } from './color.js'

export const PAINT_SIZE = 1024

export function createPaintCanvas(size = PAINT_SIZE) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

function stamp(ctx, x, y, radius, stroke, colStr, pressure, width, height) {
  const positions = [[x, y]]
  const sym = stroke.symmetry || {}
  if (sym.x) positions.push([width - x, y])
  if (sym.y) positions.push([x, height - y])
  if (sym.x && sym.y) positions.push([width - x, height - y])
  const alpha = Math.max(0.02, Math.min(1, (stroke.opacity ?? 1) * (0.35 + 0.65 * pressure)))
  const hardness = Math.min(0.999, Math.max(0, stroke.hardness ?? 0.6))
  for (const [px, py] of positions) {
    if (px < -radius || py < -radius || px > width + radius || py > height + radius) continue
    const g = ctx.createRadialGradient(px, py, 0, px, py, radius)
    g.addColorStop(0, `rgba(${colStr},${alpha})`)
    g.addColorStop(hardness, `rgba(${colStr},${alpha})`)
    g.addColorStop(1, `rgba(${colStr},0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(px, py, radius, 0, Math.PI * 2)
    ctx.fill()
  }
}

export function drawStroke(ctx, stroke, width, height) {
  const rgb = hexToRgb(stroke.color || '#ffffff')
  const colStr = `${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)}`
  if (stroke.fill) {
    ctx.save()
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    ctx.fillStyle = `rgb(${colStr})`
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
    return
  }
  const points = stroke.points || []
  if (!points.length) return
  const radius = Math.max(0.75, (Number(stroke.size) || 40) / 2)
  const spacing = Math.max(0.75, radius * 0.16)
  ctx.save()
  ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = i ? points[i - 1] : null
    if (!prev) {
      stamp(ctx, p.x * width, p.y * height, radius * (0.35 + 0.65 * (p.p ?? 1)), stroke, colStr, p.p ?? 1, width, height)
      continue
    }
    const dx = (p.x - prev.x) * width
    const dy = (p.y - prev.y) * height
    const dist = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.ceil(dist / spacing))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = prev.x + (p.x - prev.x) * t
      const y = prev.y + (p.y - prev.y) * t
      const pressure = (prev.p ?? 1) + ((p.p ?? 1) - (prev.p ?? 1)) * t
      const r = radius * (0.35 + 0.65 * pressure)
      stamp(ctx, x * width, y * height, r, stroke, colStr, pressure, width, height)
    }
  }
  ctx.restore()
}

export function rasterizeAll(canvas, strokes) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const s of strokes || []) drawStroke(ctx, s, canvas.width, canvas.height)
  return ctx
}
