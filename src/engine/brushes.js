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

const BASIC_BRUSHES = [
  {
    id: 'soft-round',
    nameKey: 'brush.softRound',
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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
    category: 'basic',
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

const NATURE_BRUSHES = [
  {
    id: 'grass',
    nameKey: 'brush.grass',
    category: 'nature',
    shape: 'flora',
    motif: 'grass',
    hardness: 0.9,
    spacing: 0.36,
    flow: 0.9,
    grain: 0.32,
    scatter: 0.5,
    angle: 0,
    rotateJitter: 42,
    sizeScale: 1.4,
    pressureSize: true,
    pressureFlow: true
  },
  {
    id: 'leaf',
    nameKey: 'brush.leaf',
    category: 'nature',
    shape: 'flora',
    motif: 'leaf',
    hardness: 0.95,
    spacing: 0.62,
    flow: 0.95,
    grain: 0.18,
    scatter: 0.9,
    angle: 0,
    rotateJitter: 85,
    scaleJitter: 0.35,
    sizeScale: 1.15
  },
  {
    id: 'flower',
    nameKey: 'brush.flower',
    category: 'nature',
    shape: 'flora',
    motif: 'flower',
    hardness: 0.98,
    spacing: 0.95,
    flow: 1,
    grain: 0.06,
    scatter: 1.1,
    angle: 0,
    rotateJitter: 180,
    scaleJitter: 0.35,
    sizeScale: 1.1
  },
  {
    id: 'tree',
    nameKey: 'brush.tree',
    category: 'nature',
    shape: 'flora',
    motif: 'tree',
    hardness: 0.9,
    spacing: 1.6,
    flow: 1,
    grain: 0.14,
    scatter: 0.8,
    angle: 0,
    rotateJitter: 10,
    scaleJitter: 0.3,
    sizeScale: 1.5,
    pressureSize: false
  },
  {
    id: 'fern',
    nameKey: 'brush.fern',
    category: 'nature',
    shape: 'flora',
    motif: 'fern',
    hardness: 0.92,
    spacing: 0.5,
    flow: 0.92,
    grain: 0.22,
    scatter: 0.45,
    angle: 0,
    rotateJitter: 35,
    sizeScale: 1.25
  },
  {
    id: 'branch',
    nameKey: 'brush.branch',
    category: 'nature',
    shape: 'flora',
    motif: 'branch',
    hardness: 0.94,
    spacing: 0.9,
    flow: 0.95,
    grain: 0.14,
    scatter: 0.35,
    angle: 0,
    rotateJitter: 70,
    scaleJitter: 0.25,
    sizeScale: 1.15
  }
]

export const BRUSHES = [...BASIC_BRUSHES, ...NATURE_BRUSHES]
export const BRUSH_GROUPS = [
  { key: 'brush.catBasic', items: BASIC_BRUSHES },
  { key: 'brush.catNature', items: NATURE_BRUSHES }
]

// ---------------------------------------------------------------- custom (imported) brushes
const CUSTOM_BRUSH_KEY = 'substrate.customBrushes'
const CUSTOM_SHAPES = ['round', 'flat', 'spray', 'flora']
const CUSTOM_MOTIFS = ['grass', 'leaf', 'flower', 'tree', 'fern', 'branch']
let customBrushes = []
const customMap = new Map()

function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function brushSlug(name) {
  return String(name || 'brush')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'brush'
}

function normalizeCustomBrush(def, index = 0) {
  if (!def || typeof def !== 'object') throw new Error('Brush definition must be an object')
  const name = String(def.name || def.label || '').trim().slice(0, 48)
  if (!name) throw new Error('Brush needs a "name"')
  const shape = CUSTOM_SHAPES.includes(def.shape) ? def.shape : 'round'
  const brush = {
    id: 'custom-' + brushSlug(name) + '-' + (index + 1),
    name,
    nameKey: null,
    source: 'custom',
    category: 'custom',
    shape,
    hardness: clampNum(def.hardness, 0, 0.999, shape === 'round' ? 0.8 : 0.7),
    spacing: clampNum(def.spacing, 0.01, 1, 0.1),
    flow: clampNum(def.flow, 0.01, 1, 0.8),
    grain: clampNum(def.grain, 0, 1, 0),
    scatter: clampNum(def.scatter, 0, 2, 0),
    angle: clampNum(def.angle, -360, 360, 0),
    flatness: clampNum(def.flatness, 0.05, 1, 1),
    rotateJitter: clampNum(def.rotateJitter, 0, 360, 0),
    scaleJitter: clampNum(def.scaleJitter, 0, 1, 0),
    sizeScale: clampNum(def.sizeScale, 0.1, 4, 1),
    pressureSize: def.pressureSize !== false,
    pressureFlow: def.pressureFlow === true
  }
  if (shape === 'spray') {
    brush.dots = Math.round(clampNum(def.dots, 1, 40, 8))
    brush.dotScale = clampNum(def.dotScale, 0.01, 1, 0.16)
  }
  if (shape === 'flora') {
    brush.motif = CUSTOM_MOTIFS.includes(def.motif) ? def.motif : 'leaf'
    if (!brush.rotateJitter) brush.rotateJitter = 45
    if (!brush.scaleJitter) brush.scaleJitter = 0.2
  }
  return brush
}

function persistCustomBrushes() {
  try {
    localStorage.setItem(CUSTOM_BRUSH_KEY, JSON.stringify(customBrushes))
  } catch (e) {
    /* storage may be unavailable */
  }
}

export function loadCustomBrushes() {
  customBrushes = []
  customMap.clear()
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_BRUSH_KEY) || '[]')
    if (Array.isArray(raw)) {
      raw.forEach((def, i) => {
        try {
          const brush = normalizeCustomBrush(def, i)
          // preserve the stored id if it is the expected shape
          if (typeof def.id === 'string' && def.id.startsWith('custom-')) brush.id = def.id
          if (!customMap.has(brush.id)) {
            customBrushes.push(brush)
            customMap.set(brush.id, brush)
          }
        } catch (e) {
          /* skip invalid entries */
        }
      })
    }
  } catch (e) {
    customBrushes = []
  }
  return customBrushes.slice()
}

loadCustomBrushes()

export function getAllBrushes() {
  return [...BRUSHES, ...customBrushes]
}

export function getBrushGroups() {
  const groups = [...BRUSH_GROUPS]
  if (customBrushes.length) groups.push({ key: 'brush.catCustom', items: customBrushes.slice() })
  return groups
}

export function getCustomBrushes() {
  return customBrushes.slice()
}

function uniqueCustomId(base) {
  let id = base
  let n = 2
  while (customMap.has(id) || BRUSHES.some((b) => b.id === id)) id = base + '-' + n++
  return id
}

/** Validate + register one brush definition (object) and persist the library. */
export function addCustomBrush(def) {
  const brush = normalizeCustomBrush(def, customBrushes.length)
  brush.id = uniqueCustomId(brush.id)
  customBrushes.push(brush)
  customMap.set(brush.id, brush)
  persistCustomBrushes()
  return { ...brush }
}

export function removeCustomBrush(id) {
  const before = customBrushes.length
  customBrushes = customBrushes.filter((b) => b.id !== id)
  customMap.delete(id)
  if (customBrushes.length !== before) persistCustomBrushes()
  return customBrushes.length !== before
}

/**
 * Import brushes from a JSON string. Accepts a single brush object, an array of brushes, or
 * { "brushes": [...] }. Also accepts { "version": 1, "brushes": [...] }.
 */
export function importCustomBrushJson(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch (e) {
    throw new Error('Invalid JSON: ' + e.message)
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.brushes) ? parsed.brushes : parsed && typeof parsed === 'object' ? [parsed] : []
  if (!list.length) throw new Error('No brush definitions found')
  const added = []
  for (const def of list.slice(0, 50)) added.push(addCustomBrush(def))
  return added
}

export function resetCustomBrushes() {
  customBrushes = []
  customMap.clear()
  try {
    localStorage.removeItem(CUSTOM_BRUSH_KEY)
  } catch (e) {
    /* ignore */
  }
}


export const DEFAULT_BRUSH_ID = 'soft-round'

export function brushById(id) {
  return customMap.get(id) || BRUSHES.find((b) => b.id === id) || BRUSHES[0]
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

// ---------------------------------------------------------------- nature motifs
function taperedBlade(ctx, x0, y0, x1, y1, w) {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * w
  const ny = (dx / len) * w
  ctx.beginPath()
  ctx.moveTo(x0 + nx, y0 + ny)
  ctx.quadraticCurveTo(x0 + dx * 0.5 + nx * 0.55, y0 + dy * 0.5 + ny * 0.55, x1, y1)
  ctx.quadraticCurveTo(x0 + dx * 0.5 - nx * 0.55, y0 + dy * 0.5 - ny * 0.55, x0 - nx, y0 - ny)
  ctx.closePath()
  ctx.fill()
}

function drawLeaf(ctx, r, col, seed) {
  const w = r * 0.58
  const base = r * 0.5
  const tip = -r * 0.95
  ctx.fillStyle = `rgba(${col},0.94)`
  ctx.beginPath()
  ctx.moveTo(0, base)
  ctx.bezierCurveTo(w, base * 0.35, w * 0.92, tip * 0.5, 0, tip)
  ctx.bezierCurveTo(-w * 0.92, tip * 0.5, -w, base * 0.35, 0, base)
  ctx.closePath()
  ctx.fill()
  // veins: punched out of the silhouette so they read at any brush colour
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = 'rgba(0,0,0,0.32)'
  ctx.lineWidth = Math.max(0.7, r * 0.055)
  ctx.beginPath()
  ctx.moveTo(0, base * 0.85)
  ctx.lineTo(0, tip * 0.82)
  ctx.stroke()
  for (let i = 0; i < 3; i++) {
    const y = base * 0.35 - i * r * 0.3
    const span = w * (0.72 - i * 0.14)
    ctx.lineWidth = Math.max(0.5, r * 0.04)
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(span * 0.5, y + r * 0.12, span, y - r * 0.06)
    ctx.moveTo(0, y)
    ctx.quadraticCurveTo(-span * 0.5, y + r * 0.12, -span, y - r * 0.06)
    ctx.stroke()
  }
  ctx.restore()
}

function drawGrass(ctx, r, col, seed) {
  const blades = 6 + Math.floor(hash01(seed, 1, 5) * 4)
  const baseY = r * 0.82
  ctx.fillStyle = `rgba(${col},0.9)`
  for (let i = 0; i < blades; i++) {
    const spread = (hash01(seed, i, 3) - 0.5) * 1.85
    const len = r * (0.85 + hash01(seed, i, 7) * 0.6)
    const tipX = Math.sin(spread) * len
    const tipY = baseY - Math.cos(spread) * len
    taperedBlade(ctx, 0, baseY, tipX, tipY, r * (0.05 + hash01(seed, i, 11) * 0.045))
  }
}

function drawFlower(ctx, r, col, seed) {
  const petals = 5 + Math.floor(hash01(seed, 2, 7) * 3)
  const dist = r * 0.42
  const prx = r * 0.27
  const pry = r * 0.4
  ctx.fillStyle = `rgba(${col},0.9)`
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * TAU + hash01(seed, i, 13) * 0.35
    ctx.save()
    ctx.rotate(a)
    ctx.beginPath()
    ctx.ellipse(0, -dist, prx, pry, 0, 0, TAU)
    ctx.fill()
    ctx.restore()
  }
  ctx.fillStyle = `rgba(${col},1)`
  ctx.beginPath()
  ctx.arc(0, 0, r * 0.19, 0, TAU)
  ctx.fill()
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  for (let i = 0; i < 6; i++) {
    const a = hash01(seed, i, 19) * TAU
    const d = hash01(seed, i, 23) * r * 0.14
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.5, r * 0.035), 0, TAU)
    ctx.fill()
  }
  ctx.restore()
}

function drawTree(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.95)`
  taperedBlade(ctx, 0, r * 0.88, 0, -r * 0.02, r * 0.11)
  const blobs = 6 + Math.floor(hash01(seed, 3, 9) * 3)
  for (let i = 0; i < blobs; i++) {
    const cx = (hash01(seed, i, 29) - 0.5) * r * 0.95
    const cy = -r * 0.42 + (hash01(seed, i, 31) - 0.5) * r * 0.5
    const rr = r * (0.26 + hash01(seed, i, 37) * 0.24)
    ctx.fillStyle = `rgba(${col},${0.72 + hash01(seed, i, 41) * 0.2})`
    ctx.beginPath()
    ctx.arc(cx, cy, rr, 0, TAU)
    ctx.fill()
  }
}

function drawFern(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.92)`
  taperedBlade(ctx, 0, r * 0.88, r * 0.2, -r * 0.82, r * 0.055)
  for (let i = 0; i < 6; i++) {
    const t = i / 5
    const y = r * 0.66 - t * r * 1.4
    const len = r * (0.52 - t * 0.3)
    for (const side of [-1, 1]) {
      taperedBlade(ctx, r * 0.12 * t, y, side * len, y - len * 0.42, r * (0.05 - t * 0.018))
    }
  }
}

function drawBranch(ctx, r, col, seed) {
  ctx.fillStyle = `rgba(${col},0.95)`
  ctx.strokeStyle = `rgba(${col},0.95)`
  ctx.lineCap = 'round'
  ctx.lineWidth = r * 0.13
  ctx.beginPath()
  ctx.moveTo(-r * 0.65, r * 0.85)
  ctx.quadraticCurveTo(-r * 0.1, r * 0.15, r * 0.15, -r * 0.5)
  ctx.quadraticCurveTo(r * 0.28, -r * 0.78, r * 0.55, -r * 0.88)
  ctx.stroke()
  ctx.lineWidth = r * 0.07
  for (const [sx, sy, ex, ey] of [
    [-0.25, 0.35, -0.62, 0.02],
    [0.02, -0.12, 0.5, -0.3],
    [0.2, -0.56, -0.28, -0.78]
  ]) {
    ctx.beginPath()
    ctx.moveTo(sx * r, sy * r)
    ctx.lineTo(ex * r, ey * r)
    ctx.stroke()
  }
  const leaves = 7
  for (let i = 0; i < leaves; i++) {
    const t = i / (leaves - 1)
    const x = -r * 0.5 + t * r * 0.95
    const y = r * 0.7 - t * r * 1.25 + Math.sin(t * 3) * r * 0.08
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((hash01(seed, i, 43) - 0.5) * 2.2)
    ellipsePath(ctx, 0, 0, r * 0.16, r * 0.075, 0)
    ctx.fill()
    ctx.restore()
  }
}

function drawMotif(ctx, x, y, radius, brush, colStr, seed) {
  const motif = brush.motif || 'leaf'
  ctx.save()
  ctx.translate(x, y)
  if (motif === 'grass') drawGrass(ctx, radius, colStr, seed)
  else if (motif === 'flower') drawFlower(ctx, radius, colStr, seed)
  else if (motif === 'tree') drawTree(ctx, radius, colStr, seed)
  else if (motif === 'fern') drawFern(ctx, radius, colStr, seed)
  else if (motif === 'branch') drawBranch(ctx, radius, colStr, seed)
  else drawLeaf(ctx, radius, colStr, seed)
  ctx.restore()
}

function applyGrain(ctx, x, y, radius, brush, seed) {
  if (brush.grain <= 0.01) return
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
  if (brush.shape === 'flora') {
    drawMotif(ctx, x, y, radius, brush, colStr, seed)
    applyGrain(ctx, x, y, radius, brush, seed)
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
  applyGrain(ctx, x, y, radius, brush, seed)
}

// ---------------------------------------------------------------- stamp sprites
const SPRITE_VARIANTS = 3
const spriteCache = new Map()
const SPRITE_CACHE_LIMIT = 144

function spriteKey(brush, colStr, baseSize) {
  return [
    brush.id,
    Math.round(baseSize),
    colStr,
    brush.shape,
    brush.motif || '',
    Number(brush.hardness).toFixed(2),
    Number(brush.grain).toFixed(2),
    Number(brush.flatness ?? 1).toFixed(2),
    Number(brush.rotateJitter ? 0 : brush.angle || 0).toFixed(1),
    Number(brush.rotateJitter || 0).toFixed(1),
    brush.dots || 0,
    Number(brush.dotScale || 0).toFixed(2)
  ].join('|')
}

function buildSprites(brush, colStr, baseSize) {
  const base = Math.max(2, Math.min(640, Math.round(baseSize * (brush.sizeScale || 1))))
  // flora motifs are drawn upright and rotated per stamp (rotation jitter), so bake them at 0°
  const bakeBrush = brush.rotateJitter ? { ...brush, angle: 0 } : brush
  const pad = Math.ceil(base * 0.22) + 2
  const dim = base + pad * 2
  const sprites = []
  for (let v = 0; v < SPRITE_VARIANTS; v++) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = dim
    const ctx = canvas.getContext('2d')
    ctx.translate(dim / 2, dim / 2)
    paintStampShape(ctx, 0, 0, base / 2, bakeBrush, 1, colStr, 17.31 + v * 91.7)
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

/** Paint one brush dab. Handles scatter, rotation/scale jitter, grain variants and X/Y symmetry. */
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
  const scatter = brush.scatter * r * 0.65
  const rotateJitter = brush.rotateJitter || 0
  const scaleJitter = brush.scaleJitter || 0
  const positions = [[x, y]]
  const sym = brush.symmetry || {}
  if (sym.x) positions.push([width - x, y])
  if (sym.y) positions.push([x, height - y])
  if (sym.x && sym.y) positions.push([width - x, height - y])
  ctx.save()
  ctx.globalCompositeOperation = brush.erase ? 'destination-out' : 'source-over'
  ctx.globalAlpha = Math.max(0.01, Math.min(1, alpha))
  for (const [baseX, baseY] of positions) {
    let px = baseX
    let py = baseY
    if (scatter > 0) {
      px += (hash01(baseX, baseY, 51) - 0.5) * 2 * scatter
      py += (hash01(baseX, baseY, 83) - 0.5) * 2 * scatter
    }
    if (px < -r || py < -r || px > width + r || py > height + r) continue
    const variant = entry.sprites[Math.floor(hash01(px, py, 7) * SPRITE_VARIANTS) % SPRITE_VARIANTS]
    const jitterScale = scaleJitter ? 1 + (hash01(px, py, 61) - 0.5) * 2 * scaleJitter : 1
    let rot = 0
    if (rotateJitter) {
      rot = (((brush.angle || 0) + (hash01(px, py, 29) - 0.5) * 2 * rotateJitter) * Math.PI) / 180
    }
    const scale = (r / nominalRadius) * jitterScale
    const dw = entry.dim * scale
    if (rot) {
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(rot)
      ctx.drawImage(variant, -dw / 2, -dw / 2, dw, dw)
      ctx.restore()
    } else {
      ctx.drawImage(variant, px - dw / 2, py - dw / 2, dw, dw)
    }
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
