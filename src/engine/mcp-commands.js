/**
 * MCP 外部工具目录的浏览器端执行实现。
 *
 * 架构位置：mcp-catalog.js 定义“接口契约”，本模块定义“接口行为”——
 * 每个处理器先用 validateArguments 校验参数，再调用 store.js 的图操作，
 * 最后返回可 JSON 序列化的纯数据（不返回 Three.js 对象等运行时引用）。
 *
 * 错误约定：处理器内部抛出 ToolError(code, message, details)，由 gateway/bridge 转换为
 * 规范化信封 { ok:false, error:{ code, message, details } }。
 */
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
  resolveInputPort,
  setNodeImage,
  autoLayout,
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

/**
 * 工具执行错误。携带稳定的错误码与可选的结构化详情（可用端口、候选节点等），
 * 便于外部代理在失败后自行纠正并重试。
 */
export class ToolError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ToolError'
    this.code = code || ERROR_CODES.INTERNAL
    this.details = details
  }
}

// 等待辅助：sleep 用于轮询间隔，waitFor 用于把“异步求值完成”转成可 await 的判定
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 轮询等待条件成立。
 *
 * 引擎求值是异步的（requestAnimationFrame / GPU 回读），工具层无法直接 await，
 * 因此统一用“等待某个状态量变化”的方式同步。
 *
 * @param {() => boolean} predicate 判定函数
 * @param {number} [timeout=20000] 最长等待毫秒数
 * @param {number} [interval=40] 轮询间隔毫秒数
 * @returns {Promise<boolean>} 是否在超时前满足条件
 */
async function waitFor(predicate, timeout = 20000, interval = 40) {
  const t0 = performance.now()
  while (performance.now() - t0 < timeout) {
    if (predicate()) return true
    await sleep(interval)
  }
  return false
}

/** 汇总最近一次求值的统计信息（节点数、通道 pass 数、耗时、GPU 耗时、缓存命中、错误）。 */
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

/**
 * 请求一次强制全图求值，并等待其完成。
 *
 * 判定“完成”的方式是 previewNonce 递增（引擎每次求值结束都会自增该计数器），
 * 比轮询 error/stats 更可靠，也不会因缓存命中而误判。
 *
 * @param {number} [timeout=20000] 等待上限（毫秒）
 * @returns {Promise<object>} 求值统计
 * @throws {ToolError} 超时抛出 TIMEOUT
 */
async function evaluate(timeout = 20000) {
  const before = state.previewNonce
  requestEval(true)
  const done = await waitFor(() => state.previewNonce > before, timeout)
  if (!done) throw new ToolError(ERROR_CODES.TIMEOUT, 'Graph evaluation timed out')
  return evalStats()
}

/**
 * 读取输出节点及其对外配置。
 *
 * connected 使用 Set 去重后排序，得到“已被连线占用的输出通道名”（如 basecolor/normal），
 * 外部代理可据此判断哪些通道还没接上。
 *
 * @returns {object|null} 输出节点信息；没有输出节点时返回 null
 */
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

/**
 * 生成“工作室状态”摘要（substrate_get_state 的返回体）。
 *
 * 除常规统计外，还给出 invalidConnections：目标端口在当前节点定义中已不存在的老连线。
 * 这类连线会被求值器静默忽略，表现为“贴图没接上”，因此显式暴露便于代理修复。
 *
 * @returns {object} 状态摘要（材质名、模式、分辨率、节点/连线数、输出配置、求值统计、历史、选区等）
 */
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
    paintNodes: state.graph.nodes.filter((n) => n.type === 'paint').map((n) => ({ id: n.id, strokes: (n.data?.strokes || []).length })),
  invalidConnections: state.graph.connections
    .filter((c) => {
      const target = state.graph.nodes.find((n) => n.id === c.to?.node)
      return !(defOf(target)?.inputs || []).some((i) => i.name === c.to?.port)
    })
    .map((c) => ({ id: c.id, to: c.to }))
  }
}

/**
 * 生成“可序列化的节点图”快照（substrate_get_graph 的返回体）。
 *
 * 特意不包含缩略图（体积很大），只给结构信息：节点 id/type/位置/标题/输入端口名/参数，
 * 以及连线端点。参数做深拷贝，避免外部代码意外改写内部响应式对象。
 *
 * @returns {object} { nodes, connections, outputNodeId, resolution, invalidConnections }
 */
function sanitizeGraph() {
  return {
    nodes: state.graph.nodes.map((n) => {
      const def = defOf(n)
      return {
        id: n.id,
        type: n.type,
        x: n.x,
        y: n.y,
        title: n.data?.title || undefined,
        inputPorts: (def?.inputs || []).map((i) => i.name),
        params: JSON.parse(JSON.stringify(n.params || {})),
        paint: n.type === 'paint' ? { strokes: (n.data?.strokes || []).length } : undefined
      }
    }),
    connections: state.graph.connections.map((c) => ({
      id: c.id,
      from: { node: c.from.node, port: c.from.port },
      to: { node: c.to.node, port: c.to.port }
    })),
    outputNodeId: outputNode()?.id || null,
    resolution: state.resolution,
    invalidConnections: state.graph.connections
      .filter((c) => {
        const target = state.graph.nodes.find((n) => n.id === c.to?.node)
        return !(defOf(target)?.inputs || []).some((i) => i.name === c.to?.port)
      })
      .map((c) => ({ id: c.id, to: c.to }))
  }
}

/** 列出当前图里的节点 id/type（最多 80 个），用于错误提示中给代理提供候选节点。 */
function availableNodeIds() {
  return state.graph.nodes.slice(0, 80).map((n) => ({ id: n.id, type: n.type }))
}

/**
 * 按 id 取节点，不存在时抛出 NOT_FOUND 并在 details 里附带可用节点列表。
 *
 * @param {string} nodeId 节点 id
 * @returns {object} 节点对象
 * @throws {ToolError}
 */
function requireNode(nodeId) {
  const node = nodeById(nodeId)
  if (!node) throw new ToolError(ERROR_CODES.NOT_FOUND, `Node not found: ${nodeId}`, { availableNodes: availableNodeIds() })
  return node
}

/**
 * 定位画笔图层节点：传 id 时校验其类型必须是 paint；不传则取第一个 paint 节点。
 *
 * @param {string} [nodeId] 可选节点 id
 * @returns {object} paint 节点
 * @throws {ToolError} 节点不存在、类型不对，或当前材质里根本没有画笔层
 */
function findPaintNode(nodeId) {
  if (nodeId) {
    const node = requireNode(nodeId)
    if (node.type !== 'paint') throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, `Node ${nodeId} is not a paint layer`, { availableNodes: availableNodeIds() })
    return node
  }
  const node = state.graph.nodes.find((n) => n.type === 'paint')
  if (!node) throw new ToolError(ERROR_CODES.NOT_FOUND, 'The current material has no paint layer — add one with substrate_add_node {type:"paint"} first')
  return node
}

/**
 * 读取本地服务端保存的工程列表，并裁剪成对外字段（只暴露 name/resolution/mtime/file）。
 *
 * @returns {Promise<{projects: Array<object>}>}
 */
async function projectList() {
  const projects = await listProjects()
  return { projects: projects.map((p) => ({ name: p.name, resolution: p.resolution, mtime: p.mtime, file: p.file })) }
}

/**
 * 工具处理器注册表：键名必须与 mcp-catalog.js 的 TOOLS.name 一一对应
 * （mcp-selfcheck 会校验双向一致性）。每个处理器接收已校验的参数，返回纯数据。
 */
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

  async substrate_list_assets() {
    const data = await (await fetch('/api/assets')).json()
    if (!data?.ok) throw new ToolError(ERROR_CODES.INTERNAL, 'Could not list material assets')
    return { assets: data.assets || [] }
  },

  async substrate_apply_asset(args) {
    const data = await (await fetch('/api/assets')).json()
    const assets = data?.assets || []
    const wanted = String(args.assetId || args.name || '').trim()
    const asset =
      assets.find((a) => a.id === args.assetId) ||
      assets.find((a) => a.name === args.name) ||
      assets.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
    if (!asset) {
      throw new ToolError(ERROR_CODES.NOT_FOUND, 'Asset not found', {
        availableAssets: assets.map((a) => ({ id: a.id, name: a.name })).slice(0, 80)
      })
    }
    const target = args.target === 'paint' ? 'paint' : 'texture'
    if (target === 'paint') {
      const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
      if (!paintNode) throw new ToolError(ERROR_CODES.NOT_FOUND, 'The current material has no paint layer')
      // commitStroke() 会异步预载/解码图片 URL，并在就绪后重新栅格化，因此随后需要触发一次求值
      commitStroke(paintNode.id, { pattern: asset.url, patternScale: 1, opacity: 1 })
      const evalInfo = await evaluate()
      return { target, nodeId: paintNode.id, asset: { id: asset.id, name: asset.name, url: asset.url }, eval: evalInfo }
    }
    let node = state.graph.nodes.find((n) => n.type === 'image_input')
    if (!node) node = addNode('image_input', { x: 120, y: 120 })
    // 下载完成后转成 DataURL，保证后续画布采样不受跨域限制
    const res = await fetch(asset.url)
    if (!res.ok) throw new ToolError(ERROR_CODES.INTERNAL, 'Could not download asset file')
    const blob = await res.blob()
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(blob)
    })
    setNodeImage(node.id, dataUrl, asset.name)
    const evalInfo = await evaluate()
    return { target, nodeId: node.id, asset: { id: asset.id, name: asset.name, url: asset.url }, eval: evalInfo }
  },

  async substrate_get_thumbnail(args) {
    // 缩略图可能尚未生成：先强制求值一次，再按 id 重新取节点（求值会替换节点对象引用）
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
    // 颜色/自发光通道是 sRGB 编码，读回时需按 sRGB 处理；法线、粗糙度等数据通道保持线性
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
    // store 的删除/复制操作依赖“当前选中集合”，这里临时替换选区并在完成后还原，
    // 以免工具的副作用破坏用户原本的手动选择。
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
    const fromNode = requireNode(args.fromNode)
    const toNode = requireNode(args.toNode)
    const inputs = (defOf(toNode)?.inputs || []).map((i) => i.name)
    // 解析目标端口：兼容单输入节点上的 "in" 之类别名，返回真实的端口名；无法解析返回空
    const resolved = resolveInputPort(toNode, args.toPort)
    if (!resolved) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENT,
        'No input port "' + args.toPort + '" on ' + toNode.type + '. Available input ports: ' + (inputs.join(', ') || '(none)'),
        { availablePorts: inputs, nodeType: toNode.type, example: { fromNode: args.fromNode, fromPort: 'out', toNode: args.toNode, toPort: inputs[0] } }
      )
    }
    const ok = addConnection(args.fromNode, args.fromPort || 'out', args.toNode, resolved)
    if (!ok) throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, state.error || 'Connection rejected', { error: state.error, availablePorts: inputs })
    await evaluate()
    const conn = state.graph.connections.find((c) => c.to.node === args.toNode && c.to.port === resolved)
    // correctedPort 非空即表示端口被自动纠正，提示调用方下一次直接用正确名称
    return {
      connectionId: conn?.id || null,
      from: args.fromNode,
      to: args.toNode,
      port: resolved,
      correctedPort: resolved !== args.toPort ? args.toPort + ' -> ' + resolved : undefined,
      graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length }
    }
  },

  async substrate_disconnect(args) {
    const connection = state.graph.connections.find((c) => c.id === args.connectionId)
    if (!connection) throw new ToolError(ERROR_CODES.NOT_FOUND, `Connection not found: ${args.connectionId}`)
    removeConnection(args.connectionId)
    await evaluate()
    return { removed: args.connectionId, graph: { nodes: state.graph.nodes.length, connections: state.graph.connections.length } }
  },

  async substrate_auto_layout() {
    const result = autoLayout()
    await new Promise((r) => setTimeout(r, 0))
    return { ...result, nodes: state.graph.nodes.length, outputId: outputNode()?.id || null }
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

/** 已实现处理器名称的列表，供自检核对“目录 ↔ 实现”是否双向一致。 */
export const HANDLER_NAMES = Object.keys(handlers)

/** 取该工具的第一个非空参数示例，用于参数校验失败时给调用方“照抄”的提示。 */
function firstExample(tool) {
  const examples = Array.isArray(tool?.examples) ? tool.examples : []
  return examples.find((e) => e && typeof e === 'object' && Object.keys(e).length) || examples[0] || undefined
}

/**
 * 执行一次外部工具调用（唯一的对外入口）。
 *
 * 执行顺序：查目录 → 查处理器 → 参数校验 → 调用处理器。
 * 参数校验失败时会把“工具名 + 示例 + inputSchema”塞进错误详情，
 * 让不具备先验知识的代理能自我纠错；处理器内部的 ToolError 原样透传，
 * 其他异常统一包装为 INTERNAL 错误。
 *
 * @param {string} name 工具名
 * @param {object} [args={}] 调用参数
 * @returns {Promise<any>} 可直接 JSON 序列化的结果
 * @throws {ToolError} 任一阶段的失败
 */
export async function executeTool(name, args = {}) {
  const tool = getTool(name)
  if (!tool) throw new ToolError(ERROR_CODES.UNKNOWN_TOOL, `Unknown tool: ${name}`)
  if (typeof handlers[name] !== 'function') {
    throw new ToolError(ERROR_CODES.UNKNOWN_TOOL, `No handler registered for: ${name}`)
  }
  let validated
  try {
    validated = validateArguments(name, args || {})
  } catch (e) {
    throw new ToolError(e.code || ERROR_CODES.INVALID_ARGUMENT, e.message, {
      tool: name,
      example: firstExample(tool),
      inputSchema: tool.inputSchema
    })
  }
  try {
    const data = await handlers[name](validated)
    return data
  } catch (e) {
    if (e instanceof ToolError) {
      if (!e.details) e.details = {}
      // 补齐“可照抄的示例”；NOT_FOUND 额外附带当前可用节点，便于代理改用正确 id
      if (!e.details.example) e.details.example = firstExample(tool)
      if (e.code === ERROR_CODES.NOT_FOUND && !e.details.availableNodes) e.details.availableNodes = availableNodeIds()
      throw e
    }
    // 非预期异常：包装为 INTERNAL，并保留原始堆栈供服务端日志排查
    throw new ToolError(ERROR_CODES.INTERNAL, e?.message || String(e), { stack: e?.stack })
  }
}

export { serializeProject, graphJSON }
