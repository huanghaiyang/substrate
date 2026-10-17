// Application store: graph model, history, paint texture sync, GPU evaluation scheduling.
import { reactive, markRaw } from 'vue'
import { NODE_MAP, defaultParams, resolveParams } from './nodes/index.js'
import { buildDemo, DEMOS } from './demos.js'
import { PAINT_SIZE, createPaintCanvas, rasterizeAll } from './paint.js'
import { BRUSHES, DEFAULT_BRUSH_ID } from './brushes.js'
import { hexToRgb } from './color.js'
import { t, trNode, trLabel, trText, localizeDef } from '../i18n/index.js'

let seq = 0
const uid = (p) => `${p}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
const AUTOSAVE_KEY = 'substrate.autosave.v1'

const BRUSH_STORAGE_KEY = 'substrate.brush'

function loadSavedBrush() {
  try {
    const raw = JSON.parse(localStorage.getItem(BRUSH_STORAGE_KEY) || 'null')
    if (!raw || typeof raw !== 'object') return {}
    const out = {}
    if (typeof raw.brushId === 'string' && BRUSHES.some((b) => b.id === raw.brushId)) out.brushId = raw.brushId
    if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) out.color = raw.color
    for (const key of ['size', 'opacity', 'hardness', 'flow', 'spacing', 'taperLength']) {
      if (raw[key] !== undefined && raw[key] !== null && Number.isFinite(Number(raw[key]))) out[key] = Number(raw[key])
    }
    for (const key of ['erase', 'symmetryX', 'symmetryY', 'taper']) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key]
    }
    return out
  } catch (e) {
    return {}
  }
}

export function savePaintBrush() {
  try {
    localStorage.setItem(BRUSH_STORAGE_KEY, JSON.stringify(state.paintBrush))
  } catch (e) {
    /* storage may be unavailable */
  }
}

export const state = reactive({
  engine: null,
  projectName: 'Untitled Project',
  resolution: 1024,
  proxy: 1,
  graph: { nodes: [], connections: [] },
  selectedIds: [],
  activeNodeId: null,
  selectedEdgeId: null,
  activePaintId: null,
  undoStack: [],
  redoStack: [],
  historyLabel: t('history.new'),
  dirty: true,
  error: '',
  previewNonce: 0,
  previewVersion: 0,
  lastEvalMs: 0,
  gpuMs: 0,
  evalNodes: 0,
  evalPasses: 0,
  cacheHits: 0,
  lastThumbCount: 0,
  engineStats: {},
  engineInfo: '',
  savedAt: 0,
  paintBrush: {
    color: '#e0574a',
    size: 48,
    opacity: 1,
    hardness: 0.7,
    erase: false,
    symmetryX: false,
    symmetryY: false,
    taper: false,
    taperLength: 0.5,
    brushId: DEFAULT_BRUSH_ID,
    flow: null,
    spacing: null,
    ...loadSavedBrush()
  },
  showMaps: false,
  mode: 'graph', // graph | paint
  demos: DEMOS.map((d) => ({ id: d.id, name: d.name, desc: d.desc }))
})

const paintCanvases = new Map() // nodeId -> { canvas, drawn, size }
let evalTimer = null
let persistTimer = null
let coalesce = { key: '', at: 0 }

// ------------------------------------------------------------------ helpers
export function defOf(node) {
  return node ? localizeDef(NODE_MAP[node.type]) : null
}
export function nodeById(id) {
  return state.graph.nodes.find((n) => n.id === id)
}
export function outputNode() {
  return state.graph.nodes.find((n) => NODE_MAP[n.type]?.isOutput)
}
export function setEngine(engine) {
  state.engine = markRaw(engine)
  const gl = engine.gl
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const rendererName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL2'
  // ?redact=1 hides the GPU/driver fingerprint (used for documentation screenshots)
  let redact = false
  try {
    redact = new URLSearchParams(location.search).has('redact')
  } catch (e) {
    redact = false
  }
  state.engineInfo = redact
    ? `WebGL2 · ${engine.isFloat ? 'RGBA16F' : '8-bit fallback'}`
    : `${rendererName}${engine.isFloat ? ' · RGBA16F' : ' · 8-bit fallback'}`
  if (!engine.isFloat) {
    state.error = t('error.floatTargets')
  }
}
export function setResolution(res) {
  state.resolution = res
  if (state.engine) state.engine.clearCache()
  requestEval(true)
}
export function setProxy(p) {
  state.proxy = p
  requestEval(true)
}

export function reachableIds() {
  const outs = state.graph.nodes.filter((n) => NODE_MAP[n.type]?.isOutput).map((n) => n.id)
  const incoming = new Map()
  for (const c of state.graph.connections) incoming.set(c.to.node + ':' + c.to.port, c)
  const seen = new Set()
  const stack = [...outs]
  while (stack.length) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodeById(id)
    const def = defOf(node)
    if (!def) continue
    for (const inp of def.inputs || []) {
      const c = incoming.get(id + ':' + inp.name)
      if (c) stack.push(c.from.node)
    }
  }
  return seen
}

export function nodeInputConnection(nodeId, port) {
  return state.graph.connections.find((c) => c.to.node === nodeId && c.to.port === port) || null
}

// ------------------------------------------------------------------- history
export function graphJSON() {
  return JSON.stringify(state.graph, (k, v) => (k.startsWith('_') ? undefined : v))
}
export function pushHistory(label, coalesceKey) {
  if (coalesceKey) {
    const now = Date.now()
    if (coalesce.key === coalesceKey && now - coalesce.at < 700) {
      coalesce.at = now
      return
    }
    coalesce = { key: coalesceKey, at: now }
  } else {
    coalesce = { key: '', at: 0 }
  }
  state.undoStack.push({ graph: graphJSON(), label })
  if (state.undoStack.length > 80) state.undoStack.shift()
  state.redoStack.length = 0
  state.historyLabel = label
  schedulePersist()
}
export function pushHistoryRaw(snapshotJson, label) {
  state.undoStack.push({ graph: snapshotJson, label })
  if (state.undoStack.length > 80) state.undoStack.shift()
  state.redoStack.length = 0
  state.historyLabel = label
  schedulePersist()
}
export function undo() {
  if (!state.undoStack.length) return
  state.redoStack.push({ graph: graphJSON(), label: state.historyLabel })
  const snap = state.undoStack.pop()
  restoreGraphString(snap.graph)
  state.historyLabel = snap.label
}
export function redo() {
  if (!state.redoStack.length) return
  state.undoStack.push({ graph: graphJSON(), label: state.historyLabel })
  const snap = state.redoStack.pop()
  restoreGraphString(snap.graph)
  state.historyLabel = snap.label
}
function normalizeNode(n) {
  const def = NODE_MAP[n.type]
  if (!def) return null
  const data = n.data ? { ...n.data } : {}
  delete data.thumbs
  return {
    id: n.id || uid(n.type),
    type: n.type,
    x: Number(n.x) || 0,
    y: Number(n.y) || 0,
    params: { ...defaultParams(def), ...(n.params || {}) },
    data
  }
}
function restoreGraphString(json) {
  try {
    const g = JSON.parse(json)
    state.graph.nodes = (g.nodes || []).map(normalizeNode).filter(Boolean)
    state.graph.connections = (g.connections || []).filter((c) => c && c.from && c.to)
    state.selectedIds = state.selectedIds.filter((id) => nodeById(id))
    state.activeNodeId = state.selectedIds[0] || null
    for (const entry of paintCanvases.values()) entry.drawn = -1
    state.engine?.clearCache()
    syncPaintTextures()
    requestEval(true)
  } catch (e) {
    console.error('restore failed', e)
  }
}

// --------------------------------------------------------------- graph edits
export function addNode(type, pos) {
  const def = NODE_MAP[type]
  if (!def) return null
  if (def.isOutput && outputNode()) {
    state.error = t('error.oneOutput')
    return null
  }
  pushHistory(t('history.add', { name: trNode(def.name) }))
  const node = {
    id: uid(type),
    type,
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    params: defaultParams(def),
    data: {}
  }
  if (def.paintInput) {
    node.data.strokes = []
    node.data.paintSize = PAINT_SIZE
  }
  state.graph.nodes.push(node)
  selectNode(node.id)
  requestEval()
  return node
}

export function deleteSelected() {
  const ids = new Set(state.selectedIds.filter((id) => {
    const n = nodeById(id)
    return n && !defOf(n)?.isOutput
  }))
  if (!ids.size) return
  pushHistory(t('history.delete'))
  for (const id of ids) state.engine?.removePaint(id)
  state.graph.nodes = state.graph.nodes.filter((n) => !ids.has(n.id))
  state.graph.connections = state.graph.connections.filter((c) => !ids.has(c.from.node) && !ids.has(c.to.node))
  state.selectedIds = state.selectedIds.filter((id) => !ids.has(id))
  state.activeNodeId = state.selectedIds[0] || null
  requestEval()
}

export function duplicateSelected() {
  const ids = new Set(state.selectedIds)
  const nodes = state.graph.nodes.filter((n) => ids.has(n.id))
  if (!nodes.length) return
  pushHistory(t('history.duplicate'))
  const map = new Map()
  const created = []
  for (const n of nodes) {
    const copy = JSON.parse(JSON.stringify(n))
    const newId = uid(n.type)
    copy.id = newId
    copy.x += 36
    copy.y += 36
    copy.data = copy.data || {}
    map.set(n.id, newId)
    state.graph.nodes.push(copy)
    created.push(newId)
  }
  for (const c of [...state.graph.connections]) {
    if (ids.has(c.from.node) && ids.has(c.to.node)) {
      state.graph.connections.push({
        id: uid('link'),
        from: { node: map.get(c.from.node), port: c.from.port },
        to: { node: map.get(c.to.node), port: c.to.port }
      })
    }
  }
  state.selectedIds = created
  state.activeNodeId = created[0] || null
  requestEval()
}

export function canConnect(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return { ok: false, reason: 'invalid' }
  const incoming = new Map()
  for (const c of state.graph.connections) incoming.set(c.to.node + ':' + c.to.port, c)
  const stack = [fromId]
  const seen = new Set()
  while (stack.length) {
    const id = stack.pop()
    if (id === toId) return { ok: false, reason: t('error.cycle') }
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodeById(id)
    const def = defOf(node)
    if (!def) continue
    for (const inp of def.inputs || []) {
      const c = incoming.get(id + ':' + inp.name)
      if (c) stack.push(c.from.node)
    }
  }
  return { ok: true }
}

export function addConnection(fromId, fromPort, toId, toPort) {
  const check = canConnect(fromId, toId)
  if (!check.ok) {
    state.error = check.reason
    return false
  }
  pushHistory(t('history.connect'))
  state.graph.connections = state.graph.connections.filter((c) => !(c.to.node === toId && c.to.port === toPort))
  state.graph.connections.push({ id: uid('link'), from: { node: fromId, port: fromPort || 'out' }, to: { node: toId, port: toPort } })
  requestEval()
  return true
}
export function removeConnection(id) {
  pushHistory(t('history.disconnect'))
  state.graph.connections = state.graph.connections.filter((c) => c.id !== id)
  requestEval()
}
export function disconnectInput(nodeId, port) {
  const c = nodeInputConnection(nodeId, port)
  if (c) removeConnection(c.id)
}

export function setParam(nodeId, key, value, opts = {}) {
  const node = nodeById(nodeId)
  if (!node) return
  const editDef = NODE_MAP[node.type]
  const editParam = (editDef?.params || []).find((p) => p.key === key)
  pushHistory(t('history.edit', { key: editParam ? trLabel(editParam.label) : key }), opts.coalesce === false ? '' : nodeId + ':' + key)
  node.params[key] = value
  requestEval()
}
export function setNodePosition(id, x, y) {
  const node = nodeById(id)
  if (!node) return
  node.x = x
  node.y = y
}
export function renameNode(id, title) {
  const node = nodeById(id)
  if (!node) return
  pushHistory(t('history.rename'))
  node.data.title = title
}

export function selectNode(id, additive = false) {
  if (!id) {
    state.selectedIds = []
    state.activeNodeId = null
    return
  }
  if (additive) {
    const set = new Set(state.selectedIds)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    state.selectedIds = [...set]
  } else {
    state.selectedIds = [id]
  }
  state.activeNodeId = id || null
}
export function selectNodes(ids) {
  state.selectedIds = [...new Set(ids)]
  state.activeNodeId = state.selectedIds[0] || null
}

export function openPaintStudio(nodeId) {
  const node = nodeById(nodeId)
  if (!node) return false
  state.activePaintId = nodeId
  state.mode = 'paint'
  state.selectedIds = [nodeId]
  state.activeNodeId = nodeId
  return true
}

// --------------------------------------------------------------------- paint
export function paintEntry(nodeId, size) {
  let entry = paintCanvases.get(nodeId)
  const target = size || nodeById(nodeId)?.data?.paintSize || PAINT_SIZE
  if (!entry || entry.size !== target) {
    const canvas = createPaintCanvas(target)
    entry = { canvas, drawn: -1, size: target }
    paintCanvases.set(nodeId, entry)
  }
  return entry
}
export function paintCanvasFor(nodeId) {
  return paintEntry(nodeId).canvas
}
export function attachPaintCanvas(nodeId, canvas) {
  const node = nodeById(nodeId)
  if (!node) return null
  const size = node.data?.paintSize || PAINT_SIZE
  if (canvas.width !== size) canvas.width = size
  if (canvas.height !== size) canvas.height = size
  const entry = { canvas, drawn: -1, size }
  paintCanvases.set(nodeId, entry)
  rasterizeAll(canvas, node.data?.strokes || [])
  entry.drawn = (node.data?.strokes || []).length
  state.engine?.setPaintCanvas(nodeId, canvas)
  requestEval(true)
  return canvas
}
export function markPaintDrawn(nodeId) {
  const node = nodeById(nodeId)
  if (!node) return
  const entry = paintEntry(nodeId)
  entry.drawn = (node.data.strokes || []).length
}
export function syncPaintTextures() {
  if (!state.engine) return
  const alive = new Set()
  for (const node of state.graph.nodes) {
    if (node.type !== 'paint') continue
    alive.add(node.id)
    const strokes = node.data?.strokes || []
    const entry = paintEntry(node.id, node.data?.paintSize)
    if (entry.drawn !== strokes.length) {
      rasterizeAll(entry.canvas, strokes)
      entry.drawn = strokes.length
      state.engine.setPaintCanvas(node.id, entry.canvas)
    } else if (!state.engine.paintTextures.has(node.id)) {
      state.engine.setPaintCanvas(node.id, entry.canvas)
    }
  }
  for (const id of [...paintCanvases.keys()]) {
    if (!alive.has(id)) {
      paintCanvases.delete(id)
      state.engine.removePaint(id)
    }
  }
}
export function commitStroke(nodeId, stroke) {
  const node = nodeById(nodeId)
  if (!node) return
  pushHistory(t('history.paint'))
  if (!Array.isArray(node.data.strokes)) node.data.strokes = []
  node.data.strokes.push(JSON.parse(JSON.stringify(stroke)))
  markPaintDrawn(nodeId)
  state.engine?.touchPaint(nodeId)
  requestEval()
}
export function clearPaint(nodeId) {
  const node = nodeById(nodeId)
  if (!node) return
  pushHistory(t('history.clearPaint'))
  node.data.strokes = []
  const entry = paintEntry(nodeId)
  rasterizeAll(entry.canvas, [])
  entry.drawn = 0
  state.engine?.setPaintCanvas(nodeId, entry.canvas)
  requestEval()
}

// -------------------------------------------------------------------- images
export function setNodeImage(nodeId, dataURL, fileName) {
  const node = nodeById(nodeId)
  if (!node) return
  pushHistory(t('history.texture'))
  node.data.imageSrc = dataURL
  node.data.imageName = fileName || 'texture.png'
  const img = new Image()
  img.onload = () => {
    const max = 2048
    const scale = Math.min(1, max / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.width * scale))
    canvas.height = Math.max(1, Math.round(img.height * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    state.engine?.setImage(nodeId, canvas)
    requestEval(true)
  }
  img.src = dataURL
  requestEval(true)
}
async function hydrateImages() {
  for (const node of state.graph.nodes) {
    if (node.type !== 'image_input' || !node.data?.imageSrc) continue
    await new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        const max = 2048
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        state.engine?.setImage(node.id, canvas)
        resolve()
      }
      img.onerror = resolve
      img.src = node.data.imageSrc
    })
  }
  requestEval(true)
}

// ------------------------------------------------------------------ evaluate
export function requestEval(immediate = false) {
  state.dirty = true
  if (evalTimer) {
    if (!immediate) return
    clearTimeout(evalTimer)
  }
  evalTimer = setTimeout(() => {
    evalTimer = null
    doEval()
  }, immediate ? 0 : 60)
}

export function doEval() {
  const engine = state.engine
  if (!engine) return null
  syncPaintTextures()
  try {
    const t0 = performance.now()
    const res = Math.min(engine.ext.maxTexture, Math.max(64, Math.round(state.resolution * state.proxy)))
    const result = engine.evaluate(state.graph, { res })
    const thumbs = engine.buildThumbs(state.graph, result, 96)
    state.gpuMs = result.ms
    state.lastEvalMs = +(performance.now() - t0).toFixed(1)
    state.evalNodes = engine.stats.nodes
    state.evalPasses = engine.stats.passes
    state.cacheHits = result.cacheHits
    state.lastThumbCount = thumbs
    state.engineStats = { ...engine.stats }
    state.dirty = false
    state.error = ''
    state.previewNonce++
  } catch (e) {
    console.error('[eval]', e)
    state.error = e?.message || String(e)
  }
  return null
}

// ------------------------------------------------------------- load / persist
export function loadGraph(graph, opts = {}) {
  state.engine?.clearCache()
  for (const id of [...paintCanvases.keys()]) {
    state.engine?.removePaint(id)
    paintCanvases.delete(id)
  }
  state.graph.nodes = (graph.nodes || []).map(normalizeNode).filter(Boolean)
  state.graph.connections = (graph.connections || []).filter((c) => c && c.from && c.to)
  if (opts.name) state.projectName = opts.name
  state.resolution = opts.resolution || state.resolution
  state.selectedIds = []
  state.activeNodeId = outputNode()?.id || null
  state.undoStack.length = 0
  state.redoStack.length = 0
  state.historyLabel = opts.label || (opts.name ? t('history.load', { name: opts.name }) : t('history.new'))
  state.activePaintId = null
  syncPaintTextures()
  hydrateImages()
  requestEval(true)
  schedulePersist()
}

export function loadDemo(id) {
  const demo = buildDemo(id)
  const demoName = trText(demo.name)
  loadGraph(demo.graph, { name: demoName, resolution: demo.resolution, label: demoName })
  state.projectName = demoName
  return demo
}

export function newProject() {
  loadDemo('blank')
  state.projectName = t('project.untitled')
  schedulePersist()
}

export function serializeProject() {
  return {
    version: 1,
    app: 'substrate-texture-designer',
    name: state.projectName,
    resolution: state.resolution,
    graph: JSON.parse(graphJSON())
  }
}

export async function saveProject(name) {
  const payload = serializeProject()
  if (name) {
    state.projectName = name
    payload.name = name
  }
  const res = await fetch('/api/projects/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || String(res.status))
  }
  state.savedAt = Date.now()
  schedulePersist()
  return res.json()
}

export async function loadProject(name) {
  const res = await fetch('/api/projects/load?name=' + encodeURIComponent(name))
  if (!res.ok) throw new Error(t('error.projectNotFound'))
  const data = await res.json()
  loadGraph(data.graph, { name: data.name, resolution: data.resolution, label: t('history.load', { name: data.name }) })
  return data
}

export async function listProjects() {
  const res = await fetch('/api/projects')
  if (!res.ok) return []
  const data = await res.json()
  return data.projects || []
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const data = { name: state.projectName, resolution: state.resolution, graph: JSON.parse(graphJSON()), at: Date.now() }
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data))
    } catch (e) {
      /* quota exceeded — ignore */
    }
  }, 900)
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (!raw) return false
    const data = JSON.parse(raw)
    if (!data?.graph?.nodes?.length) return false
    loadGraph(data.graph, { name: data.name || t('project.untitled'), resolution: data.resolution || 1024, label: t('history.restore') })
    return true
  } catch (e) {
    return false
  }
}

export function bootProject() {
  const params = new URLSearchParams(location.search)
  const demo = params.get('demo')
  if (demo) {
    loadDemo(demo)
    return
  }
  if (params.has('fresh')) {
    loadDemo('weathered-steel')
    return
  }
  if (!loadAutosave()) loadDemo('weathered-steel')
}

export function statusLine() {
  return `${state.evalNodes} nodes · ${state.evalPasses} passes · ${state.lastEvalMs.toFixed(1)} ms`
}

export { hexToRgb, resolveParams }
