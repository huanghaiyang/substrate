/**
 * 笔画的 CPU 栅格化模块：把矢量笔画（点集 + 笔刷参数）画进 2D Canvas，再上传为纹理。
 *
 * 处理流程：
 *  1. 用 Catmull-Rom 样条把稀疏的输入点平滑成曲线，并细分为等距采样点；
 *  2. 按笔刷的 spacing 逐点「盖章」（stampDab），可选笔锋（taper）让两端逐渐收细；
 *  3. 特殊笔画（图案填充 / 纯色填充）走单独的快速路径。
 *
 * 放在 engine 层的原因：绘画完全是 CPU 端合成，GPU 只负责把最终画布当纹理使用；
 * 这样撤销 / 重载时只需重放笔画数据即可得到像素级一致的结果。
 */
import { hexToRgb } from './color.js'
import { resolveBrush, stampDab } from './brushes.js'

// 绘画画布默认边长（正方形，像素）。
export const PAINT_SIZE = 1024

// 图案填充（素材库图片）解码后缓存为离屏 canvas。
// 笔画里只存图片 URL；图片尚未解码时该笔画会被跳过，由 preloadPatterns() 解码后再整体重绘。
const patternCache = new Map()
// 正在解码中的 URL → Promise，避免同一张图片被并发重复加载。
const patternLoading = new Map()

/**
 * 判断某个图案 URL 是否已解码完成、可以立即使用。
 * @param {string} url 图片 URL / data URL
 * @returns {boolean}
 */
export function isPatternReady(url) {
  return !!url && patternCache.has(url)
}

/**
 * 加载并解码一个图案图片（带缓存与并发去重）。
 *
 * 解码时把最长边限制在 1024 像素：图案填充会按 UV 平铺，过大的源图只会浪费内存，
 * 且缩小时保持宽高比。加载失败时 resolve(null)，调用方可通过返回值判断是否可用。
 *
 * @param {string} url 图片 URL / data URL
 * @returns {Promise<HTMLCanvasElement|null>} 解码后的离屏画布
 */
export function loadPattern(url) {
  if (!url) return Promise.resolve(null)
  if (patternCache.has(url)) return Promise.resolve(patternCache.get(url))
  if (patternLoading.has(url)) return patternLoading.get(url)
  const promise = new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const max = 1024
      const scale = Math.min(1, max / Math.max(img.width || max, img.height || max))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round((img.width || max) * scale))
      canvas.height = Math.max(1, Math.round((img.height || max) * scale))
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      patternCache.set(url, canvas)
      patternLoading.delete(url)
      resolve(canvas)
    }
    img.onerror = () => {
      patternLoading.delete(url)
      resolve(null)
    }
    img.src = url
  })
  patternLoading.set(url, promise)
  return promise
}

/**
 * 预加载一组笔画中引用到的所有图案（在绑定画布 / 提交笔画时调用）。
 *
 * 只加载尚未缓存的 URL，并等待全部完成；返回去重后的图案数量（不是成功数量）。
 * @param {Array<Object>} strokes 笔画数组
 * @returns {Promise<number>} 引用的图案 URL 数量
 */
export async function preloadPatterns(strokes) {
  const urls = [...new Set((strokes || []).map((s) => s.pattern).filter(Boolean))]
  await Promise.all(urls.filter((u) => !patternCache.has(u)).map((u) => loadPattern(u)))
  return urls.length
}

/**
 * 创建一个空白正方形绘画画布。
 * @param {number} [size] 边长（像素）
 * @returns {HTMLCanvasElement}
 */
export function createPaintCanvas(size = PAINT_SIZE) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return canvas
}

/** 把十六进制颜色转成 "r,g,b" 字符串，供 rgba() 拼接使用（笔刷接口约定）。 */
function colorString(hex) {
  const rgb = hexToRgb(hex || '#ffffff')
  return `${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)}`
}

/** 数值钳制到 [a, b]。 */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/**
 * 计算三次贝塞尔曲线上参数 t（0~1）处的点。
 * 同时对 X / Y 与笔压 p 做插值，因此采样点天然带有平滑后的笔压值。
 */
function cubic(p1, c1, c2, p2, t) {
  const u = 1 - t
  return {
    x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
    y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    p: u * u * u * p1.p + 3 * u * u * t * c1.p + 3 * u * t * t * c2.p + t * t * t * p2.p
  }
}

/**
 * 把笔画点集平滑成采样点序列。
 *
 * 算法：相邻 4 个点构造一段 Catmull-Rom 样条（转成三次贝塞尔控制点），
 * 按控制多边形的近似长度均分成若干步，保证采样点在屏幕上大致等距。
 *
 * 输出每个采样点包含：位置、笔压、累计弧长 dist、以及可选的笔锋半径系数 radiusScale。
 * 笔锋算法：以「到两端距离的较小值」为自变量，在 taperPx 范围内做 smoothstep 缓动，
 * 半径从 0.12 平滑增长到 1，使笔画两端自然收尖。
 *
 * 输入点坐标为归一化值（0~1），本函数乘以 width / height 转为像素。
 *
 * @param {Array<{x:number,y:number,p?:number}>} points 归一化输入点
 * @param {number} width 画布宽
 * @param {number} height 画布高
 * @param {number} step 采样步长（像素）
 * @param {{taper?:boolean, taperLength?:number, size?:number}} [opts] 笔锋设置
 * @returns {{samples: Array<Object>, total: number}} 采样点与总弧长
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
    // Catmull-Rom → 贝塞尔：控制点由相邻点切线（除以 6）偏移得到，保证曲线穿过所有输入点。
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
  // 累计弧长：后续笔锋与间距判断都基于 dist。
  let total = 0
  for (let i = 0; i < raw.length; i++) {
    if (i > 0) total += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y)
    raw[i].dist = total
  }
  const taper = !!opts.taper
  const taperLength = clamp(opts.taperLength ?? 0.5, 0.02, 1)
  const size = opts.size || 40
  let taperPx = 0
  // 笔锋像素长度：随笔刷尺寸与 taperLength 增长，并限制在 [0.35 倍笔刷尺寸, 45% 总长]，
  // 避免短笔画被完全收尖、长笔画收尖段过长。
  if (taper && total > 1) {
    taperPx = clamp(size * 1.5 + size * 2.5 * taperLength, size * 0.35, total * 0.45)
  }
  const samples = raw.map((s) => {
    let radiusScale = 1
    if (taperPx > 0) {
      const d = Math.min(s.dist, total - s.dist)
      const k = clamp(d / taperPx, 0, 1)
      // 用 smoothstep 缓动模拟自然笔锋：两端半径为 12%，平滑过渡到 100%。
      radiusScale = 0.12 + 0.88 * (k * k * (3 - 2 * k))
    }
    return { x: s.x, y: s.y, p: s.p, dist: s.dist, radiusScale }
  })
  return { samples, total }
}

/**
 * 把一条笔画绘制到 2D 上下文中。
 *
 * 三种绘制路径（按优先级）：
 *  1. 图案填充：用素材图片平铺整块画布，支持缩放与偏移；
 *  2. 纯色填充：整块画布铺满；
 *  3. 普通笔画：平滑采样后逐个 stampDab。
 *
 * 图案尚未解码时直接返回（不会画出半个图案），外层会在解码完成后整体重绘。
 *
 * @param {CanvasRenderingContext2D} ctx 目标上下文
 * @param {Object} stroke 笔画数据
 * @param {number} width 画布宽
 * @param {number} height 画布高
 */
export function drawStroke(ctx, stroke, width, height) {
  const brush = resolveBrush(stroke)
  const colStr = colorString(stroke.color)
  if (stroke.pattern) {
    const patternCanvas = patternCache.get(stroke.pattern)
    if (!patternCanvas) return
    ctx.save()
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    ctx.globalAlpha = Math.min(1, Math.max(0, Number(stroke.opacity ?? 1)))
    const pattern = ctx.createPattern(patternCanvas, 'repeat')
    if (!pattern) {
      ctx.restore()
      return
    }
    const scale = Math.max(0.05, Number(stroke.patternScale ?? 1))
    if (typeof DOMMatrix !== 'undefined' && pattern.setTransform) {
      pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, Number(stroke.patternOffsetX ?? 0) * width, Number(stroke.patternOffsetY ?? 0) * height]))
    }
    ctx.fillStyle = pattern
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
    return
  }
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
  // spacing 是相对笔刷直径的比例：值小 → 笔尖密集、笔画连续；值大 → 断续的点状笔画。
  // 下限 0.6px 防止间距为 0 时采样点数量爆炸。
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

/**
 * 清空画布并按顺序重放所有笔画（全量重绘）。
 *
 * willReadFrequently: true 提示浏览器把画布放在 CPU 内存中——这里会频繁绘制并在之后
 * 读取像素上传纹理，走软件路径反而更快、也更少出现 GPU→CPU 回读的卡顿。
 *
 * @param {HTMLCanvasElement} canvas 目标画布
 * @param {Array<Object>} strokes 笔画数组（可为空）
 * @returns {CanvasRenderingContext2D} 画布上下文（调用方可继续增量绘制）
 */
export function rasterizeAll(canvas, strokes) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const s of strokes || []) drawStroke(ctx, s, canvas.width, canvas.height)
  return ctx
}
