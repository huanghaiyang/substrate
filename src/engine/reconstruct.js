// Approximate reconstruction of a .sbsar material as a procedural graph.
//
// What this can and cannot do:
//   * A .sbsar does NOT contain its node graph — publishing compiles it into engine bytecode
//     (.sbsasm), and the descriptor XML only keeps the *interface* (inputs, groups, outputs). A
//     faithful port is impossible; there is nothing to port.
//   * What IS available: the interface (which PBR channels exist, parameter names/groups) and the
//     embedded preview render. This module measures that preview (palette, contrast, brightness,
//     colourfulness) and builds a *tileable* procedural material that reproduces its look — an
//     adjustable starting point instead of a dead end.
//
// The output is a plain graph object ({nodes, connections}) that store.loadGraph() accepts.
import { filterDefs } from './nodes/filters.js'

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

/** index of a blend mode by label (robust against option reordering) */
function blendModeIndex(label) {
  const def = filterDefs.find((d) => d.type === 'blend')
  const opts = (def?.params || []).find((p) => p.key === 'mode')?.options || []
  const i = opts.findIndex((o) => String(o).toLowerCase().includes(label.toLowerCase()))
  return i < 0 ? 0 : i
}

/**
 * Measure the archive preview render: palette + contrast + brightness + colourfulness.
 *
 * The preview is a *lit* render of a material ball, so a plain mean is dark and muddy. Pixels are
 * therefore trimmed by luminance percentile (drop the darkest 10% = shadow, brightest 10% = blown
 * highlights) and the palette is read from three windows of what remains.
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
    if (l < 0.045 || l > 0.985) continue // black backdrop / blown highlights
    samples.push({ r, g, b, l, s: satOf(r, g, b) })
  }
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

  // the render carries its own lighting; lift slightly so the rebuilt material is not darker
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
 * Build a tileable procedural graph that approximates the preview's look.
 * @param {object} opts
 * @param {object} opts.stats  result of analyzePreview()
 * @param {object} opts.info   { label, graphType, parameterCount, groups, outputs, resolution }
 * @param {number} opts.seed   stable seed (derived from the archive sha256)
 */
export function buildReconstructionProject({ stats, info = {}, seed = 1 }) {
  let counter = 0
  const uid = (type) => `${type}-rc${(counter++).toString(36)}${Math.floor(Math.abs(seed) % 997).toString(36)}`
  const nodes = []
  const connections = []
  const add = (type, x, y, params = {}) => {
    const node = { id: uid(type), type, x, y, params, data: {} }
    nodes.push(node)
    return node
  }
  const link = (from, to, toPort) => connections.push({ id: `link-${from.id}-${toPort}-${to.id}`, from: { node: from.id, port: 'out' }, to: { node: to.id, port: toPort } })

  const s = Math.abs(seed | 0) || 1
  const detail = clamp(stats.contrast * 1.4 + 0.25, 0.2, 1)
  const seedA = (s % 9000) + 11
  const seedB = ((s >> 3) % 8000) + 37

  // --- large forms + crack-like cells ------------------------------------------------
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

  // --- fine grain -------------------------------------------------------------------
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

  // --- grunge mask for stains -------------------------------------------------------
  const grunge = add('grunge', 60, 600, { scale: 3 + detail * 2, octaves: 6, detail: 3.6, threshold: 0.55, contrast: 5, seed: seedB + 3 })

  // --- base color: gradient map driven by the preview palette ------------------------
  const ramp = [
    { p: 0, c: stats.dark },
    { p: 0.5, c: stats.mid || stats.meanColor },
    { p: 1, c: stats.light }
  ]
  if (stats.saturation > 0.22) ramp.splice(2, 0, { p: 0.76, c: mix(stats.mid || stats.meanColor, stats.light, 0.55) })
  const colorMap = add('gradient_map', 600, 40, { gradient: ramp, contrast: 1 + detail * 0.2, offset: 0 })
  link(detailBlend, colorMap, 'input')
  const stains = add('blend', 870, 40, { mode: blendModeIndex('Multiply'), opacity: 0.12 + stats.saturation * 0.16 })
  link(colorMap, stains, 'base')
  link(grunge, stains, 'blend')

  // --- height / normal / ao ----------------------------------------------------------
  const heightLevels = add('levels', 870, 260, { inLow: 0.15, inHigh: 0.9, gamma: 1, outLow: 0, outHigh: 1 })
  link(detailBlend, heightLevels, 'input')
  const normal = add('normal', 1140, 200, { intensity: 0.6 + detail * 0.35, radius: 1, directx: false })
  link(heightLevels, normal, 'height')
  const ao = add('ao', 1140, 360, { radius: 0.06, intensity: 1.2 + detail * 0.4, samples: 12 })
  link(heightLevels, ao, 'height')

  // --- roughness: varies with the same structure, centred on the measured brightness --
  const roughBase = clamp(0.45 + (1 - stats.brightness) * 0.35 + detail * 0.15, 0.35, 0.92)
  const roughLevels = add('levels', 1140, 520, {
    inLow: 0.2,
    inHigh: 0.85,
    gamma: 1,
    outLow: clamp(roughBase - 0.12, 0.1, 1),
    outHigh: clamp(roughBase + 0.12, 0.1, 1)
  })
  link(detailBlend, roughLevels, 'input')

  // --- metallic: keep dielectric (stones/soil); adjustable in the inspector ----------
  const metallic = add('flat_value', 1140, 680, { value: 0 })

  // --- output -----------------------------------------------------------------------
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
