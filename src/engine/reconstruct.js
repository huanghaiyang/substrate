/**
 * .sbsar 材质的「近似重建」：无法还原原始节点图，但可以根据归档中的预览图重建出观感接近的可编辑程序化材质。
 *
 * 能做到什么、不能做到什么：
 * - .sbsar 发布时已被编译成引擎字节码（.sbsasm），并不包含原始节点图；
 *   描述 XML 里只有「接口信息」（输入参数、分组、输出通道）。因此忠实移植是不可能的。
 * - 可以利用的是：接口信息（存在哪些 PBR 通道、参数名与分组）以及内嵌的预览渲染图。
 *   本模块会统计预览图的调色板、对比度、亮度、饱和度，然后生成一个「可平铺」的程序化材质来复刻它的观感，
 *   给用户一个可继续调整的起点，而不是死路。
 *
 * 输出是一个普通图对象 {nodes, connections}，可直接交给 store.loadGraph() 加载。
 *
 * 主要导出：analyzePreview（分析预览图）、buildReconstructionProject（生成重建工程）。
 */
import { filterDefs } from './nodes/filters.js'

// 以下均为小工具：clamp 限制范围；hex/rgbOf 做十六进制与 RGB 三元组的互转；
// mix 在两个颜色之间线性插值；luma 为 Rec.709 亮度；satOf 计算 HSV 意义上的饱和度。
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))
const hex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')
const rgbOf = (h) => {
  const s = String(h).replace('#', '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const mix = (a, b, t) => {
  const A = rgbOf(a)
  const B = rgbOf(b)
  return hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t)
}
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const satOf = (r, g, b) => {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return mx === 0 ? 0 : (mx - mn) / mx
}
const lift = (c, t = 1.12) => hex(rgbOf(c)[0] * t, rgbOf(c)[1] * t, rgbOf(c)[2] * t)

/**
 * 按「选项文案」查找混合模式的索引。
 * 不写死数字，是因为节点参数选项顺序可能调整；按名称匹配可保证重建结果稳定。
 * 找不到时回退为 0（通常是 Normal）。
 */
function blendModeIndex(label) {
  const def = filterDefs.find((d) => d.type === 'blend')
  const opts = (def?.params || []).find((p) => p.key === 'mode')?.options || []
  const i = opts.findIndex((o) => String(o).toLowerCase().includes(label.toLowerCase()))
  return i < 0 ? 0 : i
}

/**
 * 分析归档中的预览渲染图，得到调色板与整体观感指标。
 *
 * 预览图是「打过光的材质球」，直接求平均会偏暗偏灰。因此先按亮度百分位裁剪：
 * 去掉最暗的 10%（阴影）与最亮的 10%（过曝高光），再在剩余像素上取三个亮度窗口：
 * - shadow（10%..28%）→ 暗部颜色
 * - med（45%..60%）   → 中间调 / 主色
 * - lit（72%..90%）   → 亮部颜色
 * 同时统计亮度均值、对比度（亮度的标准差放大 3.2 倍）与平均饱和度。
 *
 * @param {string} url 预览图 URL（blob URL 或 data URL）
 * @returns {Promise<{coverage: number, meanColor: string, dark: string, mid: string, light: string, brightness: number, contrast: number, saturation: number, palette: string[]}>}
 *   coverage 为有效像素占比；颜色均为 #rrggbb
 */
export async function analyzePreview(url) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => resolve(im)
    im.onerror = () => reject(new Error('preview image failed to load'))
    im.src = url
  })
  const N = 96
  // 缩小到 96×96 再采样：既保证统计稳定，又避免对大图逐像素处理
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, N, N)
  const data = ctx.getImageData(0, 0, N, N).data

  const samples = []
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 8) continue
    const l = luma(r, g, b)
    if (l < 0.045 || l > 0.985) continue // 跳过黑色背景与过曝的高光像素
    samples.push({ r, g, b, l, s: satOf(r, g, b) })
  }
  // 有效像素占比过低说明预览图基本是背景，返回一组中性默认色，避免重建出纯黑材质
  const coverage = samples.length / (N * N)
  if (!samples.length) {
    return {
      coverage: 0,
      meanColor: '#8a8378',
      dark: '#3a3733',
      mid: '#8a8378',
      light: '#cfc8bc',
      brightness: 0.5,
      contrast: 0.2,
      saturation: 0.15,
      palette: ['#3a3733', '#8a8378', '#cfc8bc']
    }
  }

  // 按亮度排序后，meanOf 会取 [from,to] 百分位区间内像素的平均颜色与平均亮度/饱和度
  samples.sort((a, b) => a.l - b.l)
  const at = (p) => samples[clamp(Math.round(p * (samples.length - 1)), 0, samples.length - 1)]
  const meanOf = (from, to) => {
    const lo = at(from)
    const hi = at(to)
    const slice = samples.filter((x) => x.l >= lo.l && x.l <= hi.l)
    const arr = slice.length ? slice : [lo]
    const avg = (k) => arr.reduce((acc, x) => acc + x[k], 0) / arr.length
    return { r: avg('r'), g: avg('g'), b: avg('b'), l: avg('l'), s: avg('s') }
  }
  const shadow = meanOf(0.1, 0.28)
  const med = meanOf(0.45, 0.6)
  const lit = meanOf(0.72, 0.9)
  const win = samples.filter((x) => x.l >= shadow.l && x.l <= lit.l)
  const avgL = win.reduce((acc, x) => acc + x.l, 0) / Math.max(1, win.length)
  const variance = win.reduce((acc, x) => acc + (x.l - avgL) * (x.l - avgL), 0) / Math.max(1, win.length)
  const saturation = win.reduce((acc, x) => acc + x.s, 0) / Math.max(1, win.length)

  // 预览图自带光照，整体会偏暗；稍微提亮，避免重建出的材质比原图更黑
  const dark = lift(hex(shadow.r, shadow.g, shadow.b))
  const mid = lift(hex(med.r, med.g, med.b))
  const light = lift(hex(lit.r, lit.g, lit.b))
  return {
    coverage,
    meanColor: mid,
    dark,
    mid,
    light,
    brightness: avgL,
    contrast: clamp(Math.sqrt(variance) * 3.2, 0, 1),
    saturation: clamp(saturation, 0, 1),
    palette: [dark, mid, light]
  }
}

/**
 * 根据预览分析结果生成一个观感接近、且可继续编辑的「可平铺」程序化节点图。
 *
 * 图的结构（左 → 右）：
 * - 大形：Perlin 噪声 + 细胞（Cellular）噪声，用 Multiply 混合 → 提供整体起伏与裂纹感；
 * - 细节：高频 Perlin 噪声，用 Overlay 叠加到结构上 → 提供颗粒感；
 * - 脏污：grunge 噪声 → 作为染色蒙版，让颜色略带污渍；
 * - 颜色：gradient_map 用分析出的暗/中/亮三色作为色标，再叠加脏污；
 * - 高度：对细节做 levels 调整后同时送入 normal 与 ao 节点；
 * - 粗糙度：用同一结构做 levels，输出区间以「测量到的亮度」为中心；
 * - 金属度：固定为 0（石/土类材质为电介质），用户可在检查器里改；
 * - 输出：material_output 汇总以上通道。
 *
 * @param {object} opts
 * @param {object} opts.stats analyzePreview() 的返回值
 * @param {object} [opts.info] 归档接口信息：{ label, graphType, parameterCount, groups, outputs, resolution }
 * @param {number} [opts.seed=1] 稳定随机种子（通常由归档 sha256 派生），保证同一归档每次重建结果一致
 * @returns {object} 可直接 loadGraph 的工程对象 {version, app, name, resolution, savedAt, graph}
 */
export function buildReconstructionProject({ stats, info = {}, seed = 1 }) {
  let counter = 0
  // 节点 id 中混入种子派生后缀，避免同名节点在不同重建工程间 id 冲突
  const uid = (type) => `${type}-rc${(counter++).toString(36)}${Math.floor(Math.abs(seed) % 997).toString(36)}`
  const nodes = []
  const connections = []
  const add = (type, x, y, params = {}) => {
    const node = { id: uid(type), type, x, y, params, data: {} }
    nodes.push(node)
    return node
  }
  const link = (from, to, toPort) => connections.push({ id: `link-${from.id}-${toPort}-${to.id}`, from: { node: from.id, port: 'out' }, to: { node: to.id, port: toPort } })

  // detail 把「对比度」映射为细节强度（0.2..1），后续多个节点的频率/幅度都依赖它
  const s = Math.abs(seed | 0) || 1
  const detail = clamp(stats.contrast * 1.4 + 0.25, 0.2, 1)
  // 由同一种子派生两个互不相关的子种子，让大形与细节噪声不会完全同步
  const seedA = (s % 9000) + 11
  const seedB = ((s >> 3) % 8000) + 37

  // --- 大形 + 裂纹状细胞结构 ---
  const forms = add('perlin', 60, 40, {
    scale: 5 + detail * 3,
    octaves: 6,
    persistence: 0.55,
    lacunarity: 2,
    contrast: 1 + detail * 0.4,
    seed: seedA
  })
  const cells = add('cellular', 60, 240, { cells: 9, jitter: 0.85, mode: 0, invert: true, contrast: 1.25, seed: seedB })
  const structure = add('blend', 330, 120, { mode: blendModeIndex('Multiply'), opacity: 0.5 })
  link(forms, structure, 'base')
  link(cells, structure, 'blend')

  // --- 细颗粒噪声 ---
  const grain = add('perlin', 60, 430, {
    scale: 26 + detail * 14,
    octaves: 5,
    persistence: 0.5,
    lacunarity: 2.1,
    contrast: 1.1,
    seed: seedA + 5
  })
  const detailBlend = add('blend', 600, 200, { mode: blendModeIndex('Overlay'), opacity: 0.32 + detail * 0.22 })
  link(structure, detailBlend, 'base')
  link(grain, detailBlend, 'blend')

  // --- 用于制造污渍的 grunge 蒙版 ---
  const grunge = add('grunge', 60, 600, { scale: 3 + detail * 2, octaves: 6, detail: 3.6, threshold: 0.55, contrast: 5, seed: seedB + 3 })

  // --- 基础色：以预览图调色板为色标的渐变映射 ---
  const ramp = [
    { p: 0, c: stats.dark },
    { p: 0.5, c: stats.mid || stats.meanColor },
    { p: 1, c: stats.light }
  ]
  // 原图偏鲜艳时，在高亮端前插入一个过渡色，避免渐变只有三段显得生硬
  if (stats.saturation > 0.22) ramp.splice(2, 0, { p: 0.76, c: mix(stats.mid || stats.meanColor, stats.light, 0.55) })
  const colorMap = add('gradient_map', 600, 40, { gradient: ramp, contrast: 1 + detail * 0.2, offset: 0 })
  link(detailBlend, colorMap, 'input')
  const stains = add('blend', 870, 40, { mode: blendModeIndex('Multiply'), opacity: 0.12 + stats.saturation * 0.16 })
  link(colorMap, stains, 'base')
  link(grunge, stains, 'blend')

  // --- 高度 / 法线 / AO ---
  const heightLevels = add('levels', 870, 260, { inLow: 0.15, inHigh: 0.9, gamma: 1, outLow: 0, outHigh: 1 })
  link(detailBlend, heightLevels, 'input')
  const normal = add('normal', 1140, 200, { intensity: 0.6 + detail * 0.35, radius: 1, directx: false })
  link(heightLevels, normal, 'height')
  const ao = add('ao', 1140, 360, { radius: 0.06, intensity: 1.2 + detail * 0.4, samples: 12 })
  link(heightLevels, ao, 'height')

  // --- 粗糙度：沿用同一结构，输出区间以「测量到的亮度」为中心 ---
  const roughBase = clamp(0.45 + (1 - stats.brightness) * 0.35 + detail * 0.15, 0.35, 0.92)
  const roughLevels = add('levels', 1140, 520, {
    inLow: 0.2,
    inHigh: 0.85,
    gamma: 1,
    outLow: clamp(roughBase - 0.12, 0.1, 1),
    outHigh: clamp(roughBase + 0.12, 0.1, 1)
  })
  link(detailBlend, roughLevels, 'input')

  // --- 金属度：保持电介质（石材/土壤），用户可在检查器中调整 ---
  const metallic = add('flat_value', 1140, 680, { value: 0 })

  // --- 输出节点 ---
  const label = String(info.label || 'Reconstructed material').slice(0, 64)
  const output = add('material_output', 1440, 360, {
    materialName: label,
    normalConvention: 0,
    normalizeHeight: true,
    alphaMode: 0,
    alphaCutoff: 0.5
  })
  link(stains, output, 'basecolor')
  link(heightLevels, output, 'height')
  link(normal, output, 'normal')
  link(roughLevels, output, 'roughness')
  link(metallic, output, 'metallic')
  link(ao, output, 'ao')

  const name = 'reconstructed-' + String(info.label || 'sbsar').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return {
    version: 1,
    app: 'substrate-texture-designer',
    name,
    resolution: info.resolution || 1024,
    savedAt: Date.now(),
    graph: { nodes, connections }
  }
}
