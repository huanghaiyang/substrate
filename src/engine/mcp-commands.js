// Browser-side execution of the external MCP tool catalog.
//
// All handlers validate against src/engine/mcp-catalog.js and return plain, serialisable data.
// Failures throw ToolError(code, message) which the MCP gateway turns into the normalized
// error envelope { ok:false, error:{ code, message } }.
import {
  state,
  nodeById,
  outputNode,
  defOf,
  graphJSON,
  loadDemo,
  newProject,
  addNode,
  deleteSelected,
  duplicateSelected,
  setParam,
  setNodePosition,
  addConnection,
  removeConnection,
  commitStroke,
  clearPaint,
  requestEval,
  setResolution,
  setProxy,
  saveProject,
  loadProject,
  listProjects,
  undo,
  redo,
  serializeProject
} from './store.js'
import { ERROR_CODES, validateArguments, getTool } from './mcp-catalog.js'
import { DEMOS } from './demos.js'
import { setLocale } from '../i18n/index.js'
import { exportMaterial } from './exporter.js'
import { runSelfTest } from './selftest.js'

export class ToolError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ToolError'
    this.code = code || ERROR_CODES.INTERNAL
    this.details = details
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate, timeout = 20000, interval = 40) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    if (predicate()) return true
    await sleep(interval)
  }
  return false
}

function evalStats() {
  return {
    nodes: state.evalNodes,
    passes: state.evalPasses,
    ms: state.lastEvalMs,
    gpuMs: state.gpuMs,
    cacheHits: state.cacheHits,
    error: state.error || ''
  }
}

async function evaluate(timeout = 20000) {
  const before = state.previewNonce
  requestEval(true)
  const done = await waitFor(() => state.previewNonce > before, timeout)
  if (!done) throw new ToolError(ERROR_CODES.TIMEOUT, 'Graph evaluation timed out')
  return evalStats()
}

function outputInfo() {
  const out = outputNode()
  if (!out) return null
  return {
    id: out.id,
    materialName: out.params.materialName,
    normalConvention: Number(out.params.normalConvention) === 1 ? 'DirectX' : 'OpenGL',
    alphaMode: Number(out.params.alphaMode || 0),
    normalizeHeight: out.params.normalizeHeight !== false,
    connected: [...new Set(state.graph.connections.filter((c) => c.to.node === out.id).map((c) => c.to.port))].sort()
  }
}

function summarize() {
  return {
    material: state.projectName,
    mode: state.mode,
    resolution: state.resolution,
    proxy: state.proxy,
    locale: (document.documentElement.lang || 'en').startsWith('zh') ? 'zh' : 'en',
    nodes: state.graph.nodes.length,
    connections: state.graph.connections.length,
    output: outputInfo(),
    eval: evalStats(),
    history: {
      label: state.historyLabel,
      undo: state.undoStack.length,
      redo: state.redoStack.length
    },
    selection: { active: state.activeNodeId, selected: [...state.selectedIds] },
    paintNodes: state.graph.nodes.filter((n) => n.type === 'paint').map((n) => ({ id: n.id, strokes: (n.data?.strokes || []).length }))
  }
}

function sanitizeGraph() {
  return {
    nodes: state.graph.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      title: n.data?.title || undefined,
      params: JSON.parse(JSON.stringify(n.params || {})),
      paint: n.type === 'paint' ? { strokes: (n.data?.strokes || []).length } : undefined
    })),
    connections: state.graph.connections.map((c) => ({
      id: c.id,
      from: { node: c.from.node, port: c.from.port },
      to: { node: c.to.node, port: c.to.port }
    })),
    outputNodeId: outputNode()?.id || null,
    resolution: state.resolution
  }
}

function requireNode(nodeId) {
  const node = nodeById(nodeId)
  if (!node) throw new ToolError(ERROR_CODES.NOT_FOUND, `Node not found: ${nodeId}`)
  return node
}

function findPaintNode(nodeId) {
  if (nodeId) {
    const node = requireNode(nodeId)
    if (node.type !== 'paint') throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, `Node ${nodeId} is not a paint layer`)
    return node
  }
  const node = state.graph.nodes.find((n) => n.type === 'paint')
  if (!node) throw new ToolError(ERROR_CODES.NOT_FOUND, 'The current material has no paint layer')
  return node
}

async function projectList() {
  const projects = await listProjects()
  return { projects: projects.map((p) => ({ name: p.name, resolution: p.resolution, mtime: p.mtime, file: p.file })) }
}

const handlers = {
  async substrate_get_state() {
    return summarize()
  },

  async substrate_get_graph() {
    return sanitizeGraph()
  },

  async substrate_list_demos() {
    return {
      demos: DEMOS.map((d) => ({ id: d.id, name: d.name, description: d.desc, nodes: d.graph?.nodes?.length ?? null }))
    }
  },

  async substrate_list_projects() {
    return projectList()
  },

  async substrate_search_open_assets(args) {
    const limit = Math.min(24, Math.max(1, Number(args.limit) || 12))
    const res = await fetch('/api/assets/search?q=' + encodeURIComponent(args.query) + '&limit=' + limit)
    const data = await res.json()
    if (!data?.ok) {
      throw new ToolError(data?.error?.code || ERROR_CODES.INTERNAL, data?.error?.message || 'Asset search failed', data?.error?.details)
    }
    return { query: data.query, provider: data.provider, results: data.results }
  },

  async substrate_import_asset_url(args) {
    const res = await fetch('/api/assets/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    })
    const data = await res.json()
    if (!data?.ok) throw new ToolError(ERROR_CODES.INTERNAL, data?.error?.message || 'Asset import failed')
    return { asset: data.asset }
  },

  async substrate_get_thumbnail(args) {
    let node = args.nodeId ? requireNode(args.nodeId) : outputNode()
    if (!node) throw new ToolError(ERROR_CODES.NOT_FOUND, 'No output node')
    if (!node._thumb) {
      await evaluate()
      node = nodeById(node.id)
    }
    if (!node?._thumb) throw new ToolError(ERROR_CODES.NOT_FOUND, 'Thumbnail not available for this node')
    return { nodeId: node.id, type: node.type, mimeType: 'image/png', dataUrl: node._thumb }
  },

  async substrate_get_preview(args) {
    const view = args.view || '2d'
    if (view === '3d') {
      const preview = window.__PREVIEW__
      if (!preview || typeof preview.capture !== 'function') {
        throw new ToolError(ERROR_CODES.EVAL_FAILED, '3D preview is not available')
      }
      const dataUrl = preview.capture(args.size || 256)
      if (!dataUrl) throw new ToolError(ERROR_CODES.EVAL_FAILED, '3D capture failed')
      return { view: '3d', mimeType: 'image/png', dataUrl }
    }
    await evaluate()
    const engine = state.engine
    const channel = args.channel || 'basecolor'
    const size = args.size || 256
    const srgb = channel === 'basecolor' || channel === 'emissive'
    const dataUrl = engine?.mapDataURL(channel, size, { srgb })
    if (!dataUrl) throw new ToolError(ERROR_CODES.NOT_FOUND, `Channel "${channel}" is not connected on the output`)
    return { view: '2d', channel, mimeType: 'image/png', dataUrl }
  },

  async substrate_evaluate() {
    const evalInfo = await evaluate()
    if (evalInfo.error) throw new ToolError(ERROR_CODES.EVAL_FAILED, evalInfo.error)
    return { eval: evalInfo, output: outputInfo() }
  },

  async substrate_run_selftest(args) {
    const resolution = args.resolution || 512
    const report = await runSelfTest(state.engine, { resolution })
    const failures = Object.entries(report.checks || {})
      .filter(([, v]) => !v)
      .map(([k]) => k)
    return {
      ok: !!report.ok,
      resolution,
      checks: report.checks || {},
      failures,
      graph: report.graph,
      eval: report.eval ? { nodes: report.eval.nodes, passes: report.eval.passes, ms: report.eval.ms } : null,
      seam: report.seam || null,
      normal: report.normal || null,
      timing: report.timing,
      error: report.error || ''
    }
  },

  async substrate_run_audit(args) {
    const section = args.section || 'all'
    const { runAudit } = await import('./audit.js')
    const report = await runAudit(state.engine, section)
    const sections = report.sections
      ? report.sections.map((s) => ({ section: s.section, ok: s.ok, passed: s.passed, failed: s.failed }))
      : [{ section: report.section, ok: report.ok, passed: report.passed, failed: report.failed }]
    const failures = (report.failures || []).slice(0, 25).map((f) => ({ section: f.section, name: f.name, info: f.info }))
    return {
      ok: !!report.ok,
      section,
      totals: {
        passed: sections.reduce((n, s) => n + (s.passed || 0), 0),
        failed: sections.reduce((n, s) => n + (s.failed || 0), 0)
      },
      sections,
      failures
    }
  },

  async substrate_load_demo(args) {
    if (!DEMOS.some((d) => d.id === args.id)) {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, `Unknown demo id: ${args.id}`)
    }
    loadDemo(args.id)
    await evaluate()
    return summarize()
  },

  async substrate_new_project() {
    newProject()
    await evaluate()
    return summarize()
  },

  async substrate_add_node(args) {
    const node = addNode(args.type, { x: args.x ?? Math.round(80 + Math.random() * 320), y: args.y ?? Math.round(80 + Math.random() * 220) })
    if (!node) {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, `Unknown node type or output already exists: ${args.type}`, { error: state.error })
    }
    await evaluate()
    return { nodeId: node.id, type: node.type, x: node.x, y: node.y, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_delete_node(args) {
    const node = requireNode(args.nodeId)
    if (defOf(node)?.isOutput) throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, 'The output node cannot be deleted')
    const previous = [...state.selectedIds]
    state.selectedIds = [node.id]
    deleteSelected()
    state.selectedIds = previous.filter((id) => id !== node.id)
    await evaluate()
    return { deleted: node.id, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_duplicate_node(args) {
    requireNode(args.nodeId)
    const previous = [...state.selectedIds]
    state.selectedIds = [args.nodeId]
    duplicateSelected()
    const created = state.selectedIds.filter((id) => id !== args.nodeId)
    state.selectedIds = previous
    await evaluate()
    return { source: args.nodeId, created, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_move_node(args) {
    const node = requireNode(args.nodeId)
    setNodePosition(node.id, args.x, args.y)
    return { nodeId: node.id, x: args.x, y: args.y }
  },

  async substrate_connect(args) {
    requireNode(args.fromNode)
    requireNode(args.toNode)
    const ok = addConnection(args.fromNode, args.fromPort || 'out', args.toNode, args.toPort)
    if (!ok) throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, state.error || 'Connection rejected', { error: state.error })
    await evaluate()
    const conn = state.graph.connections.find((c) => c.to.node === args.toNode && c.to.port === args.toPort)
    return { connectionId: conn?.id || null, from: args.fromNode, to: args.toNode, port: args.toPort, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_disconnect(args) {
    const connection = state.graph.connections.find((c) => c.id === args.connectionId)
    if (!connection) throw new ToolError(ERROR_CODES.NOT_FOUND, `Connection not found: ${args.connectionId}`)
    removeConnection(args.connectionId)
    await evaluate()
    return { removed: args.connectionId, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_set_param(args) {
    const node = requireNode(args.nodeId)
    setParam(node.id, args.key, args.value)
    const evalInfo = await evaluate()
    if (evalInfo.error) throw new ToolError(ERROR_CODES.EVAL_FAILED, evalInfo.error)
    return { nodeId: node.id, key: args.key, value: node.params[args.key], eval: evalInfo }
  },

  async substrate_set_resolution(args) {
    if (args.resolution) setResolution(args.resolution)
    if (args.proxy) setProxy(args.proxy)
    const evalInfo = await evaluate()
    return { resolution: state.resolution, proxy: state.proxy, eval: evalInfo }
  },

  async substrate_set_locale(args) {
    const locale = setLocale(args.locale, false)
    return { locale, documentLang: document.documentElement.lang }
  },

  async substrate_history(args) {
    if (args.action === 'undo') undo()
    else redo()
    const evalInfo = await evaluate()
    return { action: args.action, history: { label: state.historyLabel, undo: state.undoStack.length, redo: state.redoStack.length }, eval: evalInfo }
  },

  async substrate_paint_stroke(args) {
    const node = findPaintNode(args.nodeId)
    const stroke = {
      points: args.points.map((p) => ({ x: p.x, y: p.y, p: p.p ?? (p.pressure != null ? p.pressure : 0.85) })),
      brushId: args.brushId || state.paintBrush.brushId,
      color: args.color || state.paintBrush.color,
      size: args.size ?? state.paintBrush.size,
      opacity: args.opacity ?? state.paintBrush.opacity,
      hardness: args.hardness ?? state.paintBrush.hardness,
      flow: args.flow ?? state.paintBrush.flow ?? undefined,
      spacing: args.spacing ?? state.paintBrush.spacing ?? undefined,
      taper: !!args.taper,
      taperLength: args.taperLength ?? state.paintBrush.taperLength ?? 0.5,
      erase: !!args.erase,
      symmetry: { x: !!args.symmetry?.x, y: !!args.symmetry?.y }
    }
    commitStroke(node.id, stroke)
    const evalInfo = await evaluate()
    if (evalInfo.error) throw new ToolError(ERROR_CODES.EVAL_FAILED, evalInfo.error)
    return { nodeId: node.id, strokes: (nodeById(node.id)?.data?.strokes || []).length, brushId: stroke.brushId, eval: evalInfo }
  },

  async substrate_clear_paint(args) {
    const node = findPaintNode(args.nodeId)
    clearPaint(node.id)
    const evalInfo = await evaluate()
    return { nodeId: node.id, strokes: 0, eval: evalInfo }
  },

  async substrate_export(args) {
    const out = outputNode()
    if (!out) throw new ToolError(ERROR_CODES.NOT_FOUND, 'No output node')
    const materialName = args.name || out.params.materialName || state.projectName || 'Material'
    const connected = new Set(state.graph.connections.filter((c) => c.to.node === out.id).map((c) => c.to.port))
    const targetNormal = args.normalConvention || (Number(out.params.normalConvention) === 1 ? 'dx' : 'gl')
    const alphaMode = args.alphaMode ?? Number(out.params.alphaMode || 0)
    let result
    try {
      result = await exportMaterial(state.engine, {
        graph: state.graph,
        resolution: args.resolution || 1024,
        preset: args.preset || 'gltf',
        materialName,
        targetNormal,
        height16: args.height16 !== false,
        normalizeHeight: out.params.normalizeHeight !== false,
        hasEmissive: connected.has('emissive'),
        hasOpacity: connected.has('opacity'),
        alphaMode,
        sourceNormal: Number(out.params.normalConvention) === 1 ? 'dx' : 'gl'
      })
    } catch (e) {
      throw new ToolError(ERROR_CODES.EXPORT_FAILED, e?.message || String(e))
    }
    if (!result?.files?.length) throw new ToolError(ERROR_CODES.EXPORT_FAILED, 'Export produced no files')
    return {
      ok: true,
      preset: args.preset || 'gltf',
      resolution: args.resolution || 1024,
      materialName: result.manifest?.name || materialName,
      server: result.server,
      serverError: result.serverError || '',
      manifest: result.manifest,
      files: result.files.map((f) => ({ path: f.path, bytes: f.bytes.length }))
    }
  },

  async substrate_save_project(args) {
    const result = await saveProject(args.name || state.projectName)
    return { ok: true, name: state.projectName, file: result.file, resolution: state.resolution }
  },

  async substrate_load_project(args) {
    const data = await loadProject(args.name)
    await evaluate()
    return { ok: true, name: data.name || args.name, resolution: data.resolution || state.resolution, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_delete_project(args) {
    const res = await fetch('/api/projects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: args.name })
    })
    if (!res.ok) throw new ToolError(ERROR_CODES.NOT_FOUND, `Project not found: ${args.name}`)
    return { ok: true, deleted: args.name }
  }
}

export const HANDLER_NAMES = Object.keys(handlers)

export async function executeTool(name, args = {}) {
  const tool = getTool(name)
  if (!tool) throw new ToolError(ERROR_CODES.UNKNOWN_TOOL, `Unknown tool: ${name}`)
  if (typeof handlers[name] !== 'function') {
    throw new ToolError(ERROR_CODES.UNKNOWN_TOOL, `No handler registered for: ${name}`)
  }
  const validated = validateArguments(name, args || {})
  try {
    const data = await handlers[name](validated)
    return data
  } catch (e) {
    if (e instanceof ToolError) throw e
    throw new ToolError(ERROR_CODES.INTERNAL, e?.message || String(e), { stack: e?.stack })
  }
}

export { serializeProject, graphJSON }
