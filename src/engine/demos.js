// Built-in demo materials, authored as real node graphs.
import { NODE_MAP, defaultParams } from './nodes/index.js'
import { PAINT_SIZE } from './paint.js'

let seq = 0
const uid = (prefix) => `${prefix}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`

function mk(type, x, y, params = {}, data = {}) {
  const def = NODE_MAP[type]
  return {
    id: uid(type),
    type,
    x,
    y,
    params: { ...defaultParams(def), ...params },
    data: { ...data }
  }
}

function link(fromNode, toNode, toPort, fromPort = 'out') {
  return {
    id: uid('link'),
    from: { node: fromNode.id, port: fromPort },
    to: { node: toNode.id, port: toPort }
  }
}

function demoStrokes() {
  const sweep = []
  for (let i = 0; i <= 42; i++) {
    const t = i / 42
    sweep.push({
      x: 0.36 + 0.26 * Math.sin(t * Math.PI * 1.5) + 0.06 * t,
      y: 0.18 + 0.62 * t,
      p: 0.55 + 0.45 * Math.sin(Math.min(1, t * 1.25) * Math.PI)
    })
  }
  const s1 = {
    color: '#15525c',
    size: 148,
    opacity: 1,
    hardness: 0.8,
    erase: false,
    symmetry: { x: false, y: false },
    points: sweep
  }
  const stripe = []
  for (let i = 0; i <= 26; i++) {
    const t = i / 26
    stripe.push({ x: 0.2 + 0.6 * t, y: 0.82 + 0.05 * Math.sin(t * 7.0), p: 0.5 + 0.5 * Math.sin(t * Math.PI) })
  }
  const s2 = { color: '#c25f22', size: 84, opacity: 0.94, hardness: 0.6, erase: false, points: stripe }
  const dots = []
  for (let i = 0; i < 16; i++) {
    const tone = ['#1d5d68', '#d9772e', '#f2e6cd', '#7a4d2b'][i % 4]
    dots.push({
      color: tone,
      size: 26 + (i % 4) * 14,
      opacity: 0.75,
      hardness: 0.45,
      erase: false,
      points: [
        { x: 0.1 + 0.8 * (((i * 37) % 97) / 97), y: 0.12 + 0.72 * (((i * 53) % 89) / 89), p: 0.9 }
      ]
    })
  }
  return [s1, s2, ...dots]
}

// ---------------------------------------------------------------------------
// Demo 1 — weathered painted steel panels
// ---------------------------------------------------------------------------
function weatheredSteel() {
  const tilesH = mk('tiles', 40, 60, {
    count: [3, 3], gap: 0.014, round: 0.014, randomize: 0.14, rotate: 0.005, bevel: 0.06,
    variation: 0, mode: 1, colorA: '#808080', colorB: '#000000', seed: 12
  })
  const tilesC = mk('tiles', 40, 330, {
    count: [3, 3], gap: 0.014, round: 0.014, randomize: 0.14, rotate: 0.005, bevel: 0.06,
    variation: 0.2, mode: 0, colorA: '#8a9099', colorB: '#343a42', seed: 12
  })
  const perlinFine = mk('perlin', 40, 600, { scale: 52, octaves: 4, persistence: 0.45, lacunarity: 2, contrast: 1.4, seed: 2 })
  const perlinMid = mk('perlin', 40, 850, { scale: 6, octaves: 5, persistence: 0.55, lacunarity: 2, contrast: 1.15, seed: 5 })
  const grunge = mk('grunge', 40, 1100, { scale: 4, octaves: 5, detail: 2.0, threshold: 0.5, contrast: 4.5, invert: false, seed: 9 })
  const perlinBig = mk('perlin', 40, 1350, { scale: 6, octaves: 6, persistence: 0.52, lacunarity: 2, contrast: 1.3, seed: 11 })

  const heightBlend = mk('blend', 320, 60, { mode: 1, opacity: 0.07 })
  const edges = mk('edges', 320, 330, { strength: 4, radius: 1, invert: false })
  const wear = mk('threshold', 320, 560, { threshold: 0.45, softness: 0.06, invert: false })
  const rustMix = mk('blend', 320, 790, { mode: 4, opacity: 1 })
  const rustMask = mk('threshold', 320, 1020, { threshold: 0.3, softness: 0.1, invert: false })

  const normal = mk('normal', 600, 30, { intensity: 2.2, radius: 1, directx: false })
  const ao = mk('ao', 600, 280, { radius: 0.045, intensity: 1.1, samples: 16, heightScale: 1 })
  const steel = mk('gradient_map', 600, 530, {
    gradient: [
      { p: 0, c: '#3a4048' }, { p: 0.5, c: '#9aa1aa' }, { p: 1, c: '#e7ecf1' }
    ],
    contrast: 1.05, offset: 0, invert: false
  })
  const rust = mk('gradient_map', 600, 900, {
    gradient: [
      { p: 0, c: '#2a190b' }, { p: 0.38, c: '#6b3a1b' }, { p: 0.78, c: '#c07332' }, { p: 1, c: '#e6bc8d' }
    ],
    contrast: 1.2, offset: 0, invert: false
  })
  const base = mk('blend', 880, 60, { mode: 12, opacity: 0.5 })
  const baseRust = mk('blend', 1160, 60, { mode: 12, opacity: 0.9 })
  const metalLight = mk('flat_color', 880, 330, { color: '#a8aeb6', alpha: 1 })
  const baseFinal = mk('blend', 1440, 60, { mode: 0, opacity: 0.5 })
  const roughLevels = mk('levels', 880, 560, { inLow: 0, inHigh: 1, gamma: 1, outLow: 0.34, outHigh: 0.85 })
  const roughLow = mk('flat_value', 880, 790, { value: 0.26 })
  const roughWear = mk('blend', 1160, 560, { mode: 0, opacity: 0.85 })
  const metalLevels = mk('levels', 1160, 300, { inLow: 0, inHigh: 1, gamma: 1, outLow: 0.9, outHigh: 0.12 })

  const out = mk('material_output', 1440, 620, { materialName: 'Weathered Painted Steel' })

  const connections = [
    link(tilesH, heightBlend, 'base'),
    link(perlinFine, heightBlend, 'blend'),
    link(heightBlend, normal, 'height'),
    link(heightBlend, ao, 'height'),
    link(tilesH, edges, 'input'),
    link(edges, wear, 'input'),
    link(perlinMid, steel, 'input'),
    link(perlinBig, rust, 'input'),
    link(grunge, rustMix, 'base'),
    link(perlinFine, rustMix, 'blend'),
    link(rustMix, rustMask, 'input'),
    link(tilesC, base, 'base'),
    link(steel, base, 'blend'),
    link(base, baseRust, 'base'),
    link(rust, baseRust, 'blend'),
    link(rustMask, baseRust, 'mask'),
    link(baseRust, baseFinal, 'base'),
    link(metalLight, baseFinal, 'blend'),
    link(wear, baseFinal, 'mask'),
    link(grunge, roughLevels, 'input'),
    link(roughLevels, roughWear, 'base'),
    link(roughLow, roughWear, 'blend'),
    link(wear, roughWear, 'mask'),
    link(grunge, metalLevels, 'input'),
    link(baseFinal, out, 'basecolor'),
    link(heightBlend, out, 'height'),
    link(normal, out, 'normal'),
    link(roughWear, out, 'roughness'),
    link(metalLevels, out, 'metallic'),
    link(ao, out, 'ao')
  ]

  return {
    id: 'weathered-steel',
    name: 'Weathered Painted Steel',
    desc: 'Panel tiles, bevels, rust and edge wear — full PBR set.',
    resolution: 1024,
    graph: {
      nodes: [
        tilesH, tilesC, perlinFine, perlinMid, grunge, perlinBig,
        heightBlend, edges, wear, rustMix, rustMask,
        normal, ao, steel, rust, base, baseRust, metalLight, baseFinal,
        roughLevels, roughLow, roughWear, metalLevels, out
      ],
      connections
    }
  }
}

// ---------------------------------------------------------------------------
// Demo 2 — mossy rock
// ---------------------------------------------------------------------------
function mossyRock() {
  const perlinA = mk('perlin', 40, 60, { scale: 4, octaves: 6, persistence: 0.55, lacunarity: 2, contrast: 1.1, seed: 21 })
  const cellWarp = mk('cellular', 40, 330, { cells: 5, jitter: 1, mode: 0, invert: false, contrast: 1, seed: 4 })
  const perlinDetail = mk('perlin', 320, 330, { scale: 30, octaves: 5, persistence: 0.5, lacunarity: 2, contrast: 1.25, seed: 7 })
  const warp = mk('warp', 320, 60, { intensity: 1.7, offset: 0 })
  const heightBlend = mk('blend', 600, 60, { mode: 1, opacity: 0.16 })
  const grunge = mk('grunge', 40, 600, { scale: 7, octaves: 6, detail: 3.1, threshold: 0.5, contrast: 6, invert: false, seed: 15 })
  const heightFinal = mk('blend', 880, 60, { mode: 4, opacity: 0.32 })

  const normal = mk('normal', 600, 330, { intensity: 0.38, radius: 3, directx: false })
  const ao = mk('ao', 600, 580, { radius: 0.06, intensity: 1.15, samples: 16, heightScale: 1 })
  const curv = mk('curvature', 600, 830, { radius: 2, intensity: 0.9, mode: 0, invert: false })
  const rockColor = mk('gradient_map', 880, 330, {
    gradient: [
      { p: 0, c: '#2b2e28' }, { p: 0.3, c: '#4a4d43' }, { p: 0.58, c: '#75755f' },
      { p: 0.82, c: '#9d9a86' }, { p: 1, c: '#c6c2ac' }
    ],
    contrast: 1, offset: 0, invert: false
  })
  const invAO = mk('invert', 880, 580, { r: true, g: true, b: true, a: false })
  const mossRaw = mk('blend', 1160, 580, { mode: 4, opacity: 1 })
  const mossMask = mk('threshold', 1440, 580, { threshold: 0.3, softness: 0.18, invert: false })
  const mossColor = mk('gradient_map', 1160, 850, {
    gradient: [
      { p: 0, c: '#1a2512' }, { p: 0.45, c: '#3f5c25' }, { p: 0.8, c: '#6f9139' }, { p: 1, c: '#96ad5e' }
    ],
    contrast: 1.1, offset: 0, invert: false
  })
  const albedo = mk('blend', 1720, 330, { mode: 0, opacity: 0.82 })
  const roughRock = mk('levels', 1160, 1100, { inLow: 0, inHigh: 1, gamma: 1, outLow: 0.55, outHigh: 0.95 })
  const roughTarget = mk('flat_value', 1160, 1320, { value: 0.98 })
  const roughMoss = mk('blend', 1440, 1100, { mode: 0, opacity: 0.9 })
  const out = mk('material_output', 2000, 400, { materialName: 'Mossy Rock' })

  const connections = [
    link(perlinA, warp, 'input'),
    link(cellWarp, warp, 'warper'),
    link(warp, heightBlend, 'base'),
    link(perlinDetail, heightBlend, 'blend'),
    link(heightBlend, heightFinal, 'base'),
    link(grunge, heightFinal, 'blend'),
    link(heightFinal, normal, 'height'),
    link(heightFinal, ao, 'height'),
    link(heightFinal, curv, 'height'),
    link(heightFinal, rockColor, 'input'),
    link(ao, invAO, 'input'),
    link(grunge, mossRaw, 'base'),
    link(invAO, mossRaw, 'blend'),
    link(mossRaw, mossMask, 'input'),
    link(grunge, mossColor, 'input'),
    link(rockColor, albedo, 'base'),
    link(mossColor, albedo, 'blend'),
    link(mossMask, albedo, 'mask'),
    link(heightFinal, roughRock, 'input'),
    link(roughRock, roughMoss, 'base'),
    link(roughTarget, roughMoss, 'blend'),
    link(mossMask, roughMoss, 'mask'),
    link(albedo, out, 'basecolor'),
    link(heightFinal, out, 'height'),
    link(normal, out, 'normal'),
    link(roughMoss, out, 'roughness'),
    link(ao, out, 'ao')
  ]

  return {
    id: 'mossy-rock',
    name: 'Mossy Rock',
    desc: 'Warped fBm rock with cavity-moss, AO and curvature.',
    resolution: 1024,
    graph: {
      nodes: [
        perlinA, cellWarp, perlinDetail, warp, heightBlend, grunge, heightFinal,
        normal, ao, curv, rockColor, invAO, mossRaw, mossMask, mossColor, albedo,
        roughRock, roughTarget, roughMoss, out
      ],
      connections
    }
  }
}

// ---------------------------------------------------------------------------
// Demo 3 — hand painted sign (paint layer demo)
// ---------------------------------------------------------------------------
function paintedSign() {
  const wall = mk('grunge', 40, 60, { scale: 9, octaves: 5, detail: 3.2, threshold: 0.5, contrast: 4, invert: false, seed: 3 })
  const baseColor = mk('gradient_map', 320, 60, {
    gradient: [
      { p: 0, c: '#b3a58e' }, { p: 0.5, c: '#d5c9b4' }, { p: 1, c: '#ece3d2' }
    ],
    contrast: 1.1, offset: 0, invert: false
  })
  const paint = mk('paint', 600, 60, { opacity: 1, blend: 0, useMask: false }, {
    strokes: demoStrokes(),
    paintSize: PAINT_SIZE
  })
  const diff = mk('blend', 600, 330, { mode: 8, opacity: 1 })
  const paintMask = mk('threshold', 880, 330, { threshold: 0.06, softness: 0.02, invert: false })
  const heightNoise = mk('perlin', 320, 330, { scale: 42, octaves: 4, persistence: 0.5, lacunarity: 2, contrast: 1.2, seed: 8 })
  const heightBlend = mk('blend', 600, 600, { mode: 1, opacity: 0.16 })
  const normal = mk('normal', 880, 60, { intensity: 0.17, radius: 3, directx: false })
  const ao = mk('ao', 1160, 60, { radius: 0.05, intensity: 1.2, samples: 10, heightScale: 1 })
  const roughBase = mk('flat_value', 320, 600, { value: 0.72 })
  const roughPaint = mk('flat_value', 880, 600, { value: 0.34 })
  const roughFinal = mk('blend', 1160, 330, { mode: 0, opacity: 1 })
  const out = mk('material_output', 1440, 330, { materialName: 'Hand Painted Sign' })

  const connections = [
    link(wall, baseColor, 'input'),
    link(baseColor, paint, 'input'),
    link(baseColor, diff, 'base'),
    link(paint, diff, 'blend'),
    link(diff, paintMask, 'input'),
    link(heightNoise, heightBlend, 'base'),
    link(paintMask, heightBlend, 'blend'),
    link(heightBlend, normal, 'height'),
    link(heightBlend, ao, 'height'),
    link(roughBase, roughFinal, 'base'),
    link(roughPaint, roughFinal, 'blend'),
    link(paintMask, roughFinal, 'mask'),
    link(paint, out, 'basecolor'),
    link(heightBlend, out, 'height'),
    link(normal, out, 'normal'),
    link(roughFinal, out, 'roughness'),
    link(ao, out, 'ao')
  ]

  return {
    id: 'painted-sign',
    name: 'Hand Painted Sign',
    desc: 'Paint layer demo — brush strokes drive color, height and gloss.',
    resolution: 1024,
    graph: { nodes: [wall, baseColor, paint, diff, paintMask, heightNoise, heightBlend, normal, ao, roughBase, roughPaint, roughFinal, out], connections }
  }
}

// ---------------------------------------------------------------------------
function bareMaterial() {
  const fbm = mk('perlin', 40, 60, { scale: 8, octaves: 5 })
  const normal = mk('normal', 320, 60, { intensity: 0.4, radius: 2 })
  const out = mk('material_output', 600, 60, { materialName: 'New Material' })
  return {
    id: 'blank',
    name: 'New Material',
    desc: 'Empty starter graph.',
    resolution: 1024,
    graph: {
      nodes: [fbm, normal, out],
      connections: [link(fbm, normal, 'height'), link(fbm, out, 'height'), link(normal, out, 'normal')]
    }
  }
}

export const DEMOS = [weatheredSteel(), mossyRock(), paintedSign(), bareMaterial()]

export function buildDemo(id) {
  const src = DEMOS.find((d) => d.id === id) || DEMOS[0]
  // deep clone so the demo can be edited without mutating the template
  const clone = JSON.parse(JSON.stringify({ name: src.name, resolution: src.resolution, graph: src.graph }))
  return { name: src.name, desc: src.desc, id: src.id, resolution: src.resolution, graph: clone.graph }
}
