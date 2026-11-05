/**
 * 应用状态中心（store）。
 *
 * 职责：
 *  - 维护节点图（节点、连线、选中状态）与工程元信息；
 *  - 维护撤销/重做历史栈，并对高频修改做合并（coalesce），避免一次拖动产生几十条记录；
 *  - 把笔刷笔画同步成 GPU 纹理，并调度着色器求值（含拖动中的低分辨率快速预览）；
 *  - 工程保存/加载（服务端接口 + localStorage 自动存档）。
 *
 * 架构位置：介于 UI 组件与 WebGL 引擎之间的中间层。UI 只读写这里的 reactive state 并
 * 调用导出的动作函数；真正的着色器编译与渲染由 engine 完成，本文件只负责调度与状态同步。
 *
 * 主要导出：state（响应式全局状态）、节点增删/连线/参数编辑、撤销重做、求值调度、
 * 工程序列化与加载、自动布局、绘画与图片导入辅助。
 *
 * 设计取舍：节点图本身保持为可序列化的纯数据；图片、画布等运行时对象只挂在以 `_`
 * 开头的字段上，序列化时会被剔除，因此历史快照与存档不包含不可序列化内容。
 */
import { reactive, markRaw } from 'vue'
import { NODE_MAP, defaultParams, resolveParams } from './nodes/index.js'
import { buildDemo, DEMOS } from './demos.js'
import { PAINT_SIZE, createPaintCanvas, rasterizeAll, drawStroke, preloadPatterns, isPatternReady } from './paint.js'
import { BRUSHES, DEFAULT_BRUSH_ID } from './brushes.js'
import { hexToRgb } from './color.js'
import { t, trNode, trLabel, trText, localizeDef } from '../i18n/index.js'

let seq = 0
// 节点 / 连线 id 生成器：前缀 + 36 进制自增序号 + 4 位随机串，保证同一会话内不重复。
const uid = (p) => `${p}-${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`
// localStorage 自动存档键（保存最近的工程快照，用于刷新页面后恢复）。
const AUTOSAVE_KEY = 'substrate.autosave.v1'

// localStorage 中「绘画工具栏设置」的键名。
const BRUSH_STORAGE_KEY = 'substrate.brush'

/**
 * 读取上次使用的画笔设置。
 *
 * 逐字段做白名单 + 类型校验：brushId 必须存在于内置笔刷表、颜色必须是 #rrggbb、
 * 数值字段必须能转成有限数字、布尔字段必须是 boolean。这样旧版本或损坏的存档
 * 不会把非法值注入当前状态。
 * @returns {Object} 仅包含通过校验的字段；无存档或解析失败时返回空对象。
 */
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

/**
 * 把当前画笔设置写入 localStorage。
 * 副作用：写本地存储；隐私模式或配额不足时静默忽略，不影响绘画流程。
 */
export function savePaintBrush() {
  try {
    localStorage.setItem(BRUSH_STORAGE_KEY, JSON.stringify(state.paintBrush))
  } catch (e) {
    /* 存储不可用（隐私模式 / 配额已满）时忽略 */
  }
}

/**
 * 全局响应式状态。
 *
 * 说明：
 *  - engine 用 markRaw 包裹——Three.js / WebGL 对象不能被 Vue 的响应式代理包裹；
 *  - undoStack / redoStack 的元素形如 { graph, label }，graph 是序列化后的图 JSON 字符串；
 *  - evalNodes / evalPasses / lastEvalMs 等是给底部状态栏使用的求值统计。
 */
export const state = reactive({
  engine: null, // 求值引擎实例（markRaw，避免被 Vue 深度代理）
  projectName: 'Untitled Project',
  resolution: 1024, // 最终输出分辨率（长边像素）
  proxy: 1, // 预览降采样倍率：1 = 全分辨率，0.5 = 半分辨率
  graph: { nodes: [], connections: [] }, // 节点图数据（可序列化）
  // 选择状态：selectedIds 多选节点集合，activeNodeId 当前活动节点，
  // selectedEdgeId 选中的连线，activePaintId 绘画工作室正在编辑的节点。
  selectedIds: [],
  activeNodeId: null,
  selectedEdgeId: null,
  activePaintId: null,
  undoStack: [], // 撤销栈：每项 { graph: JSON 字符串, label: 操作名称 }
  redoStack: [], // 重做栈：撤销时把当前状态压入这里
  historyLabel: t('history.new'), // 最近一次操作名称，用于界面展示
  dirty: true, // 图是否有未求值的改动
  error: '', // 当前错误信息（空串表示无错误）
  previewNonce: 0, // 每次完整求值后自增，预览组件据此刷新
  previewVersion: 0,
  // 预览与性能统计：lastEvalMs / gpuMs 为最近一次求值耗时；
  // evalNodes / evalPasses / cacheHits / lastThumbCount 供状态栏与调试面板使用。
  lastEvalMs: 0,
  gpuMs: 0,
  evalNodes: 0,
  evalPasses: 0,
  cacheHits: 0,
  lastThumbCount: 0,
  engineStats: {}, // 引擎统计快照 { nodes, passes, ... }
  engineInfo: '', // 引擎信息字符串（GPU 名称 / 浮点纹理支持情况）
  savedAt: 0, // 最近一次成功保存的时间戳
  // 绘画工具栏的当前设置；末尾展开 loadSavedBrush() 以覆盖为上次使用的值。
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
  showMaps: false, // 是否在预览区显示各通道贴图（由 UI 切换）
  mode: 'graph', // 工作模式：graph = 节点图，paint = 绘画工作室
  demos: DEMOS.map((d) => ({ id: d.id, name: d.name, desc: d.desc }))
})

// 每个绘画节点的 CPU 画布缓存：nodeId -> { canvas, drawn, size }。
// drawn 记录已栅格化到画布上的笔画数量，用来区分「只新增一笔」与「需全量重绘」。
const paintCanvases = new Map()
// 求值防抖定时器（见 requestEval）；非空表示已排程。
let evalTimer = null
// 自动存档防抖定时器（见 schedulePersist）。
let persistTimer = null
// 滑杆合并状态：上一次的合并键与发生时间（见 pushHistory）。
let coalesce = { key: '', at: 0 }

// ------------------------------------------------------------------ 通用辅助
/**
 * 取节点定义（已按当前语言本地化）。
 * @param {Object} node 图节点
 * @returns {Object|null} 节点定义；节点不存在或类型未注册时为 null
 */
export function defOf(node) {
  return node ? localizeDef(NODE_MAP[node.type]) : null
}
/**
 * 按 id 查节点。
 * @param {string} id 节点 id
 * @returns {Object|undefined} 节点对象（即 state.graph.nodes 中的引用）
 */
export function nodeById(id) {
  return state.graph.nodes.find((n) => n.id === id)
}

/**
 * 把「请求的输入端口名」解析为节点定义中真实存在的端口名。
 *
 * 背景：外部（脚本 / 智能体）建图时常把唯一的输入端口猜成 "in"，而实际定义里叫
 * "input"（例如 Transform 2D）。对单输入节点接受这类别名，可以避免连线被静默丢弃；
 * 多输入节点无法判断对应关系，因此不做猜测。
 *
 * @param {Object} node 目标节点
 * @param {string} requested 请求的端口名
 * @returns {string|null} 真实端口名；无输入端口或无法唯一匹配时返回 null
 */
export function resolveInputPort(node, requested) {
  const inputs = defOf(node)?.inputs || []
  if (!inputs.length) return null
  const port = String(requested == null ? '' : requested)
  if (inputs.some((i) => i.name === port)) return port
  const alias = port.toLowerCase()
  if (inputs.length === 1 && ['in', 'input', 'src', 'source', 'value', 'base', 'tex', 'texture'].includes(alias)) {
    return inputs[0].name
  }
  return null
}
/**
 * 查找材质输出节点。
 * @returns {Object|undefined} 标有 isOutput 的节点（同一工程中最多一个）
 */
export function outputNode() {
  return state.graph.nodes.find((n) => NODE_MAP[n.type]?.isOutput)
}
/**
 * 注册求值引擎，并记录 GPU / 浮点渲染能力信息。
 * 副作用：写入 state.engine（markRaw）、state.engineInfo；若引擎不支持浮点渲染目标，
 * 同时设置 state.error 提示降级到 8-bit 的情况。
 * @param {Object} engine 引擎实例（需提供 gl 与 isFloat）
 */
export function setEngine(engine) {
  state.engine = markRaw(engine)
  const gl = engine.gl
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  const rendererName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL2'
  // ?redact=1 隐藏 GPU/驱动指纹，用于生成文档截图时脱敏。
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
/**
 * 设置输出分辨率。
 * 副作用：清空引擎缓存（分辨率变化会使所有中间纹理尺寸失效）并立即重新求值。
 * @param {number} res 新的长边像素数
 */
export function setResolution(res) {
  state.resolution = res
  if (state.engine) state.engine.clearCache()
  requestEval(true)
}
/**
 * 设置预览降采样倍率。
 * @param {number} p 1 = 全分辨率，0.5 = 半分辨率（画质更低但更快）
 */
export function setProxy(p) {
  state.proxy = p
  requestEval(true)
}

/**
 * 计算「从当前节点图出发、能被输出节点用到的节点集合」。
 *
 * 做法：从所有输出节点沿输入连线反向遍历（深度优先），只有真正参与输出的节点
 * 才会被求值，未连接的节点不编译着色器，从而节省 GPU 时间。
 * @returns {Set<string>} 可达节点 id 集合
 */
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

/**
 * 查询某个节点的某个输入端口上现有的连线。
 * 一个输入端口最多只有一条连线（由 addConnection 保证）。
 * @returns {Object|null} 连线对象，未连接时为 null
 */
export function nodeInputConnection(nodeId, port) {
  return state.graph.connections.find((c) => c.to.node === nodeId && c.to.port === port) || null
}

// ------------------------------------------------------------------ 撤销历史
// historyBatch：批处理计数器。> 0 时所有 pushHistory 都被忽略，只有最后一个 endHistoryBatch 才真正入栈，
// 这样「一键建整条材质节点链」这种多步修改只占用一步撤销。
let historyBatch = 0
let batchSnapshot = null
/**
 * 序列化图结构用于撤销快照。
 * 跳过以 _ 开头的字段（例如运行时缓存的 _image / _tex），避免把不可序列化的对象写进历史。
 */
export function graphJSON() {
  return JSON.stringify(state.graph, (k, v) => (k.startsWith('_') ? undefined : v))
}
/**
 * 开始一次批处理：把多节点修改（例如一键导入图片→PBR）合并成单步撤销。
 * 只在第一次调用时抓取快照；后续嵌套调用只增加计数。
 * 必须与 endHistoryBatch 成对使用（建议放在 try/finally 里）。
 */
export function beginHistoryBatch(label) {
  if (historyBatch === 0) batchSnapshot = { graph: graphJSON(), label }
  historyBatch++
}
/**
 * 结束一次批处理：计数归零时才把开始时抓的快照压入撤销栈，
 * 并清空重做栈（与 pushHistory 的行为保持一致）。
 * 未开始过批处理或快照丢失时直接返回，防止栈被意外污染。
 */
export function endHistoryBatch() {
  if (historyBatch <= 0) return
  historyBatch--
  if (historyBatch > 0 || !batchSnapshot) return
  const snapshot = batchSnapshot
  batchSnapshot = null
  state.undoStack.push(snapshot)
  if (state.undoStack.length > 80) state.undoStack.shift()
  state.redoStack.length = 0
  state.historyLabel = snapshot.label
  schedulePersist()
}
/**
 * 记录一次可撤销的修改。
 * - 批处理期间直接跳过（由 endHistoryBatch 统一入栈）；
 * - coalesceKey 相同且间隔小于 700ms 的连续修改（如拖动滑杆）只保留第一条，
 *   避免一次拖动产生几十条历史记录。
 */
export function pushHistory(label, coalesceKey) {
  if (historyBatch > 0) return
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
/**
 * 直接压入一个已经序列化好的图快照（不做当前状态抓取、也不参与批处理）。
 * 适用于「快照在修改之前就已生成」的场景。
 * @param {string} snapshotJson graphJSON() 产出的字符串
 * @param {string} label 历史记录显示名称
 */
export function pushHistoryRaw(snapshotJson, label) {
  state.undoStack.push({ graph: snapshotJson, label })
  if (state.undoStack.length > 80) state.undoStack.shift()
  state.redoStack.length = 0
  state.historyLabel = label
  schedulePersist()
}
/**
 * 撤销：把当前图压入重做栈，再恢复撤销栈顶的快照。
 * 副作用：重建节点/连线、清理绘画画布缓存、清空引擎缓存、触发重新求值。
 */
export function undo() {
  if (!state.undoStack.length) return
  state.redoStack.push({ graph: graphJSON(), label: state.historyLabel })
  const snap = state.undoStack.pop()
  restoreGraphString(snap.graph)
  state.historyLabel = snap.label
}
/**
 * 重做：把当前图压回撤销栈，再恢复重做栈顶的快照。
 */
export function redo() {
  if (!state.redoStack.length) return
  state.undoStack.push({ graph: graphJSON(), label: state.historyLabel })
  const snap = state.redoStack.pop()
  restoreGraphString(snap.graph)
  state.historyLabel = snap.label
}
/**
 * 规范化一个来自存档 / 撤销快照的节点：
 * 补齐缺失的 id、坐标和参数（用节点定义的默认值填充），并丢弃缩略图缓存。
 * @param {Object} n 原始节点数据
 * @returns {Object|null} 规范化后的节点；类型未注册时返回 null
 */
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
/**
 * 修复旧工程 / 脚本生成工程中的端口别名。
 *
 * 历史遗留：早前生成的图会把多输入节点（例如 Warp 的 input / warper）的端口写成
 * 通用的 "a" / "b" 或 "in1" / "in2"。这里仅在「加载工程 / 恢复快照」时按顺序映射到
 * 第一、第二个输入端口——因为这些场景下若不管，连线会被静默忽略；而新建连线走
 * addConnection，会直接给出明确的端口不存在错误。
 *
 * @param {Array} nodes 已规范化的节点数组
 * @param {Array} connections 原始连线数组
 * @returns {Array} 修正端口名后的连线数组
 */
function repairConnectionPorts(nodes, connections) {
  return (connections || [])
    .filter((c) => c && c.from && c.to)
    .map((c) => {
      const target = nodes.find((n) => n.id === c.to.node)
      let resolved = resolveInputPort(target, c.to.port)
      if (!resolved) {
        // 对多输入节点兜底：a/in1/input1 → 第 0 个端口，b/in2/input2 → 第 1 个端口。
        const inputs = defOf(target)?.inputs || []
        const requested = String(c.to.port || '').toLowerCase()
        if (inputs.length >= 2) {
          const index = requested === 'a' || requested === 'in1' || requested === 'input1' ? 0 : requested === 'b' || requested === 'in2' || requested === 'input2' ? 1 : -1
          if (index >= 0 && inputs[index]) resolved = inputs[index].name
        }
      }
      return resolved && resolved !== c.to.port ? { ...c, to: { ...c.to, port: resolved } } : c
    })
}

/**
 * 用一个序列化快照重建当前图（撤销 / 重做的核心）。
 *
 * 副作用：替换 nodes/connections、修剪失效的选中项、重置所有绘画画布的已绘制计数、
 * 清空引擎缓存、重新同步绘画纹理并强制求值。解析失败时仅打印日志，不破坏当前状态。
 * @param {string} json graphJSON() 产出的图快照
 */
function restoreGraphString(json) {
  try {
    const g = JSON.parse(json)
    state.graph.nodes = (g.nodes || []).map(normalizeNode).filter(Boolean)
    // 迁移旧连线里使用的别名端口（例如单输入节点上的 "in"）。
    state.graph.connections = repairConnectionPorts(state.graph.nodes, g.connections)
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

// --------------------------------------------------------------- 节点图编辑
/**
 * 在指定位置新建一个节点。
 *
 * 约束：输出节点全图只能有一个；绘画类节点会预置空的笔画列表与画布尺寸。
 * 副作用：写入历史、加入图、选中新节点并触发求值。
 *
 * @param {string} type 节点类型（必须是 NODE_MAP 中已注册的类型）
 * @param {{x:number,y:number}} pos 画布坐标（内部取整）
 * @returns {Object|null} 新节点；类型非法或已存在输出节点时返回 null
 */
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

/**
 * 删除所有选中的节点（输出节点受保护，不允许删除）。
 * 副作用：同时移除与这些节点相连的连线、释放其绘画 GPU 纹理，并触发重新求值。
 */
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

/**
 * 复制选中的节点：深拷贝数据、向右下偏移 36px，并重建选中节点之间的内部连线。
 * 新节点会成为当前选中项。
 */
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

/**
 * 检查 from → to 是否允许连线（主要用于环路检测）。
 *
 * 实现：从 fromId 沿输入边反向遍历上游，如果能走到 toId，说明 toId 已经是 fromId 的
 * 上游节点，再连一条 from→to 就会形成环，因此拒绝。
 *
 * @param {string} fromId 上游（输出端）节点 id
 * @param {string} toId 下游（输入端）节点 id
 * @returns {{ok:boolean, reason?:string}} 校验结果；失败时 reason 为提示文案
 */
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

/**
 * 新建一条连线。
 *
 * 步骤：先做环路校验，再把请求端口解析成真实端口名；同一输入端口上的旧连线会被替换
 * （输入端口只允许一条连线）。成功后写入历史并重新求值。
 *
 * @returns {boolean} 是否连接成功；失败时把原因写入 state.error
 */
export function addConnection(fromId, fromPort, toId, toPort) {
  const check = canConnect(fromId, toId)
  if (!check.ok) {
    state.error = check.reason
    return false
  }
  const target = nodeById(toId)
  const resolved = resolveInputPort(target, toPort)
  if (!resolved) {
    const ports = (defOf(target)?.inputs || []).map((i) => i.name)
    state.error = t('error.portNotFound', { port: toPort, ports: ports.join(', ') })
    return false
  }
  pushHistory(t('history.connect'))
  state.graph.connections = state.graph.connections.filter((c) => !(c.to.node === toId && c.to.port === resolved))
  state.graph.connections.push({ id: uid('link'), from: { node: fromId, port: fromPort || 'out' }, to: { node: toId, port: resolved } })
  requestEval()
  return true
}
/**
 * 按 id 删除一条连线。
 * @param {string} id 连线 id
 */
export function removeConnection(id) {
  pushHistory(t('history.disconnect'))
  state.graph.connections = state.graph.connections.filter((c) => c.id !== id)
  requestEval()
}
/**
 * 断开某个节点的某个输入端口（若存在连线）。
 * @param {string} nodeId 节点 id
 * @param {string} port 输入端口名
 */
export function disconnectInput(nodeId, port) {
  const c = nodeInputConnection(nodeId, port)
  if (c) removeConnection(c.id)
}

/**
 * 修改节点参数。
 *
 * 历史合并：默认以 `nodeId:key` 作为合并键，700ms 内对同一参数的连续修改只记一步历史，
 * 这样拖动滑杆不会塞满撤销栈；传 opts.coalesce = false 可关闭合并（例如逐帧动画式修改）。
 *
 * @param {string} nodeId 节点 id
 * @param {string} key 参数键
 * @param {*} value 新值
 * @param {{coalesce?:boolean}} [opts]
 */
export function setParam(nodeId, key, value, opts = {}) {
  const node = nodeById(nodeId)
  if (!node) return
  const editDef = NODE_MAP[node.type]
  const editParam = (editDef?.params || []).find((p) => p.key === key)
  pushHistory(t('history.edit', { key: editParam ? trLabel(editParam.label) : key }), opts.coalesce === false ? '' : nodeId + ':' + key)
  node.params[key] = value
  requestEval()
}
/**
 * 直接设置节点坐标（不写历史、不触发求值——拖拽过程由调用方控制何时入栈）。
 */
export function setNodePosition(id, x, y) {
  const node = nodeById(id)
  if (!node) return
  node.x = x
  node.y = y
}
// -------------------------------------------------------------------- 自动布局
// 自动布局的几何常量：节点宽度、标题栏高度、列/行间距、整体页边距。
const LAYOUT_WIDTH = 200
const LAYOUT_HEADER = 28
const LAYOUT_GAP_X = 84
const LAYOUT_GAP_Y = 46
const LAYOUT_MARGIN_X = 60
const LAYOUT_MARGIN_Y = 80

/**
 * 估算节点在布局中的高度：标题栏 + 输入端口行高，并保证最小高度。
 * 节点高度会随输入端口数量变化，用它堆叠可避免上下重叠。
 */
function layoutHeightOf(node) {
  const def = defOf(node)
  const inputs = def?.inputs?.length || 0
  return LAYOUT_HEADER + Math.max(94, 14 + inputs * 16 + 10)
}

/**
 * 一键整理节点图：确定性的「从左到右」分层布局。
 *
 * 算法三步：
 * 1. 用 Kahn 拓扑排序求最长路径深度，作为节点所在的列（输出节点自然落在最右列）；
 * 2. 在相邻层之间做 4 轮重心（barycentre）扫描，减少连线交叉；
 * 3. 每层按真实节点高度纵向堆叠（互不重叠），并在整体高度内垂直居中。
 *
 * 位置直接写入节点，只记录一步撤销。
 * @returns {{moved:number,layers:number,width?:number,gapX?:number,gapY?:number}}
 *   布局摘要；图为空时只返回 { moved: 0, layers: 0 }
 */
export function autoLayout() {
  const nodes = state.graph.nodes || []
  if (!nodes.length) return { moved: 0, layers: 0 }
  pushHistory(t('history.autoLayout'))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const preds = new Map(nodes.map((n) => [n.id, []]))
  const succs = new Map(nodes.map((n) => [n.id, []]))
  for (const c of state.graph.connections || []) {
    if (!byId.has(c.from?.node) || !byId.has(c.to?.node)) continue
    succs.get(c.from.node).push(c.to.node)
    preds.get(c.to.node).push(c.from.node)
  }

  // 通过 Kahn 拓扑序求「最长路径」深度：深度 = 所有前驱最大深度 + 1。
  const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id).length]))
  const depth = new Map(nodes.map((n) => [n.id, 0]))
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id)
  let head = 0
  while (head < queue.length) {
    const id = queue[head++]
    for (const next of succs.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1))
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) queue.push(next)
    }
  }
  // 理论上不应存在环（连线时已校验），但若仍有入度未归零的节点，
  // 就按前驱深度给它分配一个有效层，避免这些节点被丢弃或叠在一起。
  for (const n of nodes) {
    if (indeg.get(n.id) > 0) {
      const pd = preds.get(n.id).map((id) => depth.get(id) ?? 0)
      depth.set(n.id, pd.length ? Math.max(...pd) + 1 : 0)
    }
  }

  const maxDepth = Math.max(...depth.values())
  const layers = Array.from({ length: maxDepth + 1 }, () => [])
  for (const n of nodes) layers[depth.get(n.id)].push(n)
  // 初始顺序取当前「从上到下」的位置，并以 id 兜底，保证同一工程每次布局结果一致。
  for (const layer of layers) layer.sort((a, b) => (a.y - b.y) || (a.x - b.x) || a.id.localeCompare(b.id))

  const rank = new Map()
  const refreshRanks = () => {
    for (const layer of layers) layer.forEach((n, i) => rank.set(n.id, i))
  }
  refreshRanks()
  // 4 轮重心中位扫描：正向按前驱的平均排名排序，反向按后继的平均排名排序。
  // 轮数固定为 4，是在布局质量与耗时之间的折中（节点图通常只有几十个节点）。
  for (let iter = 0; iter < 4; iter++) {
    // 正向扫描：按前驱节点的平均排名排序，减少相邻层之间的交叉。
    for (let d = 1; d <= maxDepth; d++) {
      const layer = layers[d]
      const score = new Map()
      for (const n of layer) {
        const ps = preds.get(n.id).map((id) => rank.get(id)).filter((v) => Number.isFinite(v))
        score.set(n.id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : rank.get(n.id))
      }
      layer.sort((a, b) => (score.get(a.id) - score.get(b.id)) || a.id.localeCompare(b.id))
      refreshRanks()
    }
    // 反向扫描：按后继节点的平均排名排序，进一步压缩交叉。
    for (let d = maxDepth - 1; d >= 0; d--) {
      const layer = layers[d]
      const score = new Map()
      for (const n of layer) {
        const ss = succs.get(n.id).map((id) => rank.get(id)).filter((v) => Number.isFinite(v))
        score.set(n.id, ss.length ? ss.reduce((a, b) => a + b, 0) / ss.length : rank.get(n.id))
      }
      layer.sort((a, b) => (score.get(a.id) - score.get(b.id)) || a.id.localeCompare(b.id))
      refreshRanks()
    }
  }

  const layerHeights = layers.map((layer) => layer.reduce((sum, n) => sum + layoutHeightOf(n), 0) + LAYOUT_GAP_Y * Math.max(0, layer.length - 1))
  const tallest = Math.max(...layerHeights, 0)
  for (let d = 0; d < layers.length; d++) {
    const layer = layers[d]
    let y = LAYOUT_MARGIN_Y + Math.max(0, (tallest - layerHeights[d]) / 2)
    for (const n of layer) {
      n.x = Math.round(LAYOUT_MARGIN_X + d * (LAYOUT_WIDTH + LAYOUT_GAP_X))
      n.y = Math.round(y)
      y += layoutHeightOf(n) + LAYOUT_GAP_Y
    }
  }
  schedulePersist()
  return { moved: nodes.length, layers: layers.length, width: LAYOUT_WIDTH, gapX: LAYOUT_GAP_X, gapY: LAYOUT_GAP_Y }
}

/**
 * 重命名节点（自定义标题存放在 node.data.title，仅影响显示）。
 */
export function renameNode(id, title) {
  const node = nodeById(id)
  if (!node) return
  pushHistory(t('history.rename'))
  node.data.title = title
}

/**
 * 选中节点。
 * @param {string|null} id 节点 id；传空表示清空选择
 * @param {boolean} [additive] 是否追加选择（按住 Shift 多选时使用；已选中则取消选中）
 */
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
/**
 * 批量选中（去重），并让第一个节点成为「当前活动节点」。
 * @param {string[]} ids 节点 id 列表
 */
export function selectNodes(ids) {
  state.selectedIds = [...new Set(ids)]
  state.activeNodeId = state.selectedIds[0] || null
}

/**
 * 进入绘画工作室并聚焦指定节点。
 * 副作用：切换 state.mode = 'paint'，设置 activePaintId 与选中状态。
 * @returns {boolean} 节点不存在时返回 false
 */
export function openPaintStudio(nodeId) {
  const node = nodeById(nodeId)
  if (!node) return false
  state.activePaintId = nodeId
  state.mode = 'paint'
  state.selectedIds = [nodeId]
  state.activeNodeId = nodeId
  return true
}

// --------------------------------------------------------------------- 绘画（paint）
/**
 * 取得（必要时创建）某个绘画节点的画布缓存条目。
 * 尺寸以 node.data.paintSize 为准；显式传 size 可强制指定。尺寸变化会重建画布，
 * 新画布初始 drawn = -1，表示「尚未栅格化任何笔画」。
 * @param {string} nodeId 节点 id
 * @param {number} [size] 画布边长（像素）
 * @returns {{canvas: HTMLCanvasElement, drawn: number, size: number}}
 */
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
/**
 * 取该绘画节点的画布（不存在则按默认尺寸创建）。
 * @returns {HTMLCanvasElement}
 */
export function paintCanvasFor(nodeId) {
  return paintEntry(nodeId).canvas
}
/**
 * 把一个外部画布绑定到绘画节点（绘画工作室初始化时使用）。
 *
 * 副作用：
 *  - 把画布尺寸对齐到节点的 paintSize；
 *  - 立即按现有笔画全量栅格化，并上传为 GPU 纹理；
 *  - 若笔画里引用了还未解码的图案（pattern 填充），异步解码完成后再重绘并上传。
 *
 * @returns {HTMLCanvasElement|null} 传入节点不存在时返回 null
 */
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
  const pendingPatterns = (node.data?.strokes || []).filter((s) => s.pattern && !isPatternReady(s.pattern))
  if (pendingPatterns.length) {
    preloadPatterns(node.data.strokes).then(() => {
      const nodeNow = nodeById(nodeId)
      if (!nodeNow) return
      rasterizeAll(canvas, nodeNow.data.strokes || [])
      entry.drawn = (nodeNow.data.strokes || []).length
      state.engine?.setPaintCanvas(nodeId, canvas)
      state.engine?.touchPaint(nodeId)
      requestEval()
    })
  }
  state.engine?.setPaintCanvas(nodeId, canvas)
  requestEval(true)
  return canvas
}
/**
 * 把缓存条目的 drawn 计数标记为「已与节点笔画数一致」。
 * 绘画工作室在实时绘制一笔后调用它，这样后续 commitStroke 就不必全量重绘。
 */
export function markPaintDrawn(nodeId) {
  const node = nodeById(nodeId)
  if (!node) return
  const entry = paintEntry(nodeId)
  entry.drawn = (node.data.strokes || []).length
}
/**
 * 让 CPU 画布缓存与图状态保持一致（每次求值前调用）。
 *
 * 对每个 paint 节点：
 *  - 若笔画数大于已绘制数，则全量重绘并上传纹理；
 *  - 若 GPU 侧还没有纹理（例如刚从存档恢复），也重新上传；
 *  - 含未解码图案的笔画会异步解码后重绘；
 * 最后清理已不在图中的画布缓存与 GPU 纹理，防止显存泄漏。
 */
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
    // 图案填充引用的是素材库图片：先解码，再重绘并重新上传纹理。
    if (strokes.some((s) => s.pattern && !isPatternReady(s.pattern))) {
      preloadPatterns(strokes).then(() => {
        const nodeNow = nodeById(node.id)
        if (!nodeNow) return
        const entryNow = paintEntry(node.id, nodeNow.data?.paintSize)
        rasterizeAll(entryNow.canvas, nodeNow.data?.strokes || [])
        entryNow.drawn = (nodeNow.data?.strokes || []).length
        state.engine?.setPaintCanvas(node.id, entryNow.canvas)
        state.engine?.touchPaint(node.id)
        requestEval()
      })
    }
  }
  for (const id of [...paintCanvases.keys()]) {
    if (!alive.has(id)) {
      paintCanvases.delete(id)
      state.engine.removePaint(id)
    }
  }
}
/**
 * 提交一笔新笔画：写入节点数据、栅格化到画布、上传 GPU 纹理并触发求值。
 *
 * 增量优化：若缓存已绘制数正好等于「新笔画之前」的数量，只需把这一笔补画到画布；
 * 否则（例如历史回退后）退化为全量重绘。图案填充同理需要等待解码后重绘。
 *
 * @param {string} nodeId 绘画节点 id
 * @param {Object} stroke 笔画数据（颜色、点集、笔刷参数等），会先深拷贝再存储
 */
export function commitStroke(nodeId, stroke) {
  const node = nodeById(nodeId)
  if (!node) return
  pushHistory(t('history.paint'))
  if (!Array.isArray(node.data.strokes)) node.data.strokes = []
  node.data.strokes.push(JSON.parse(JSON.stringify(stroke)))
  // 栅格化到共享画布：绘画工作室已经实时画过这一笔，所以通常只需补画新增的一笔；
  // 由脚本（MCP）提交的笔画与图案填充则在这里统一绘制。
  const entry = paintEntry(nodeId)
  const strokes = node.data.strokes
  try {
    if (entry.drawn === strokes.length - 1) {
      drawStroke(entry.canvas.getContext('2d'), strokes[strokes.length - 1], entry.canvas.width, entry.canvas.height)
    } else {
      rasterizeAll(entry.canvas, strokes)
    }
    entry.drawn = strokes.length
    state.engine?.setPaintCanvas(nodeId, entry.canvas)
  } catch (e) {
    console.warn('[paint] commit rasterisation failed', e)
  }
  // 图案素材是懒加载的：引用的素材库图片解码完成后需要重新栅格化。
  if (strokes.some((s) => s.pattern && !isPatternReady(s.pattern))) {
    preloadPatterns(strokes).then(() => {
      const nodeNow = nodeById(nodeId)
      if (!nodeNow) return
      const entryNow = paintEntry(nodeId)
      rasterizeAll(entryNow.canvas, nodeNow.data.strokes || [])
      entryNow.drawn = (nodeNow.data.strokes || []).length
      state.engine?.setPaintCanvas(nodeId, entryNow.canvas)
      state.engine?.touchPaint(nodeId)
      requestEval()
    })
  }
  state.engine?.touchPaint(nodeId)
  requestEval()
}
/**
 * 清空某绘画节点的所有笔画，并把画布与 GPU 纹理同步为空。
 * 该操作可撤销。
 */
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

// -------------------------------------------------------------------- 图片纹理
/**
 * 把一张图片写进 image_input 节点，并异步解码成 GPU 纹理。
 * - data URL 同时存进节点数据（用于保存工程 / 撤销恢复）；
 * - 解码时把长边限制在 2048（引擎纹理上限），且只缩小不放大；
 * - 解码完成前先 requestEval 一次，让预览早点拿到「占位」状态，避免界面卡白。
 */
export function setNodeImage(nodeId, dataURL, fileName, sourceAssetId) {
  const node = nodeById(nodeId)
  if (!node) return
  pushHistory(t('history.texture'))
  node.data.imageSrc = dataURL
  node.data.imageName = fileName || 'texture.png'
  // 记录这张贴图来自哪个素材库资源：删除素材时据此判断是否仍被工程引用
  if (sourceAssetId) {
    node.data.imageAssetId = sourceAssetId
  } else {
    delete node.data.imageAssetId
  }
  const img = new Image()
  img.onload = () => {
    const max = 2048
    // 等比缩放到 2048 以内；小图保持原尺寸（scale 取 1）
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

/**
 * 一键「照片 → PBR 材质」建图函数。
 *
 * 生成的节点链（坐标按从左到右、从上到下排布）：
 *
 *   图片节点(image_input) → 无缝平铺(seamless_tile) → basecolor
 *                                ├→ 灰度(grayscale) → 色阶(levels) → height
 *                                │                        ├→ 法线(normal)
 *                                │                        └→ AO(ao)
 *                                └→ 灰度 → 反相(invert) → 色阶 → roughness
 *   常量 0(flat_value) → metallic
 *
 * 关键设计：
 * - 照片以 data URL 存进 image_input 节点，无缝处理保留为「活的」seamless_tile 节点，
 *   所以导入后仍可在检查器里调整模式与羽化宽度；
 * - 灰度节点被 height 链与 roughness 链共享，避免重复采样；
 * - 整个建图过程用 beginHistoryBatch/endHistoryBatch 包住，只产生一步撤销；
 * - 参数（seamless.mode/curve/band）在这里做范围钳制，保证非法值不会写进节点。
 *
 * @param {Object} opts
 * @param {string} opts.dataURL   方形化后的图片数据（JPEG data URL）
 * @param {string} opts.fileName  存进节点的文件名，仅用于界面展示
 * @param {Object} opts.seamless  { enabled, mode, band, curve }
 * @param {Object} opts.channels  需要生成哪些通道（缺省视为开启，metallic 需显式 true）
 * @param {boolean} opts.normalDirectX  法线是否使用 DirectX 约定
 * @returns {Object|null} 建图结果；失败（例如没有输出节点）时返回 null
 */
export function createImagePbrMaterial({
  dataURL,
  fileName,
  seamless = {},
  channels = {},
  normalDirectX = false
} = {}) {
  if (!dataURL) return null
  // 整个建图过程算一步撤销
  beginHistoryBatch(t('history.imagePbr'))
  try {
    // 已有材质输出节点就直接复用，没有才新建（避免图上出现两个输出）
    const out = outputNode() || addNode('material_output', { x: 900, y: 0 })
    if (!out) return null
    // 通道开关：除 metallic 必须显式开启外，其余缺省视为需要
    const want = {
      basecolor: channels.basecolor !== false,
      height: channels.height !== false,
      normal: channels.normal !== false,
      roughness: channels.roughness !== false,
      ao: channels.ao !== false,
      metallic: channels.metallic === true
    }
    // 把新链路摆到现有节点下方，避免与已有内容重叠
    const maxY = state.graph.nodes.reduce((m, n) => Math.max(m, n.y), 0)
    const baseX = 80
    const baseY = Math.round(maxY + 140)

    // 1) 图片节点：channelMode = 0 表示按 RGBA 原样读取
    const image = addNode('image_input', { x: baseX, y: baseY })
    if (!image) return null
    setParam(image.id, 'channelMode', 0)
    setNodeImage(image.id, dataURL, fileName || 'texture.jpg')

    // 2) 无缝平铺节点：参数做钳制，并把照片接到它的输入
    const tile = addNode('seamless_tile', { x: baseX + 230, y: baseY })
    if (!tile) return null
    setParam(tile.id, 'enabled', seamless.enabled !== false)
    setParam(tile.id, 'mode', Number(seamless.mode) === 1 ? 1 : Number(seamless.mode) === 2 ? 2 : 0)
    setParam(tile.id, 'curve', Math.min(2, Math.max(0, Number(seamless.curve) || 0)))
    setParam(tile.id, 'band', Math.min(0.25, Math.max(0.005, Number(seamless.band) || 0.08)))
    addConnection(image.id, 'out', tile.id, 'input')

    // 3) 基础色：先断开输出节点原有连线，再接入新链路（保证「一键替换」语义）
    if (want.basecolor) {
      disconnectInput(out.id, 'basecolor')
      addConnection(tile.id, 'out', out.id, 'basecolor')
    }

    // 4) 灰度：height/normal/AO/roughness 都基于亮度推导，共用这一个节点
    let grayId = null
    if (want.height || want.normal || want.ao || want.roughness) {
      const gray = addNode('grayscale', { x: baseX + 460, y: baseY })
      if (!gray) return null
      grayId = gray.id
      addConnection(tile.id, 'out', gray.id, 'input')
    }
    // 5) 高度链：灰度 → 色阶（提高对比度）→ height / normal / AO
    if (want.height || want.normal || want.ao) {
      const levels = addNode('levels', { x: baseX + 690, y: baseY })
      addConnection(grayId, 'out', levels.id, 'input')
      if (want.height) {
        disconnectInput(out.id, 'height')
        addConnection(levels.id, 'out', out.id, 'height')
      }
      if (want.normal) {
        const n = addNode('normal', { x: baseX + 920, y: baseY - 110 })
        addConnection(levels.id, 'out', n.id, 'height')
        setParam(n.id, 'directx', !!normalDirectX)
        disconnectInput(out.id, 'normal')
        addConnection(n.id, 'out', out.id, 'normal')
      }
      if (want.ao) {
        const ao = addNode('ao', { x: baseX + 920, y: baseY + 90 })
        addConnection(levels.id, 'out', ao.id, 'height')
        disconnectInput(out.id, 'ao')
        addConnection(ao.id, 'out', out.id, 'ao')
      }
    }
    // 6) 粗糙度：亮部更粗糙、暗部更光滑 —— 先反相再压到 0.55~0.95，
    //    避免全黑/全亮区域导致表面完全没有高光
    if (want.roughness) {
      const inv = addNode('invert', { x: baseX + 690, y: baseY + 260 })
      addConnection(grayId, 'out', inv.id, 'input')
      const levels = addNode('levels', { x: baseX + 920, y: baseY + 260 })
      setParam(levels.id, 'outLow', 0.55)
      setParam(levels.id, 'outHigh', 0.95)
      addConnection(inv.id, 'out', levels.id, 'input')
      disconnectInput(out.id, 'roughness')
      addConnection(levels.id, 'out', out.id, 'roughness')
    }
    // 7) 金属度：照片默认当作非金属，用常量 0 驱动
    if (want.metallic) {
      const flat = addNode('flat_value', { x: baseX + 460, y: baseY + 400 })
      setParam(flat.id, 'value', 0)
      disconnectInput(out.id, 'metallic')
      addConnection(flat.id, 'out', out.id, 'metallic')
    }

    // 节点全建完后再清缓存/选中/求值，避免中间态被编译成多份着色器
    state.engine?.clearCache()
    selectNode(image.id)
    requestEval(true)
    return { imageNodeId: image.id, seamlessNodeId: tile.id, outputId: out.id, channels: Object.keys(want).filter((k) => want[k]) }
  } finally {
    // 无论成功还是中途 return，都要结束批处理，否则后续历史记录会全部被吞掉
    endHistoryBatch()
  }
}

/**
 * 加载工程后，把每个 image_input 节点保存的 data URL 重新解码并上传为 GPU 纹理。
 *
 * 为什么异步逐个解码：图片解码是 CPU 密集操作，逐个串行可以避免一次性占用过多内存；
 * 单张图片加载失败（onerror）时直接 resolve，保证不会卡住整个恢复流程。
 * 全部完成后做一次完整求值。
 */
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

// ------------------------------------------------------------------ 求值调度
// 当前排程中的求值选项（最后一次 requestEval 的 opts 生效）。
let pendingEvalOpts = null

/**
 * 请求一次求值（带去抖）。
 *
 * opts.low = true 时执行「低质量快速通道」：半分辨率、不生成节点缩略图、不重建预览，
 * 用于用户拖动笔刷期间保持画布响应；笔画结束时再触发一次完整质量的求值。
 *
 * 去抖策略：已有排程时，非 immediate 请求直接复用（只更新选项）；immediate 请求会取消
 * 旧排程并立即执行。延迟：immediate = 0，low = 110ms，普通 = 60ms。
 *
 * @param {boolean} [immediate] 是否立刻执行（跳过延迟）
 * @param {{low?:boolean}} [opts] 求值选项
 */
export function requestEval(immediate = false, opts = {}) {
  state.dirty = true
  pendingEvalOpts = opts
  if (evalTimer) {
    if (!immediate) return
    clearTimeout(evalTimer)
  }
  const delay = immediate ? 0 : opts.low ? 110 : 60
  evalTimer = setTimeout(() => {
    evalTimer = null
    const o = pendingEvalOpts || {}
    pendingEvalOpts = null
    doEval(o)
  }, delay)
}

/**
 * 真正执行一次图求值。
 *
 * 流程：先同步绘画纹理 → 按 proxy 与 low 计算分辨率 → 交给引擎求值 → 记录耗时/统计 →
 * 重建节点缩略图与预览。出错时把异常信息写入 state.error，避免异常冒泡打断 UI。
 *
 * @param {{low?:boolean}} [opts] low = 低质量快速通道（半分辨率、跳过缩略图与预览）
 * @returns {null} 该函数不返回求值结果（结果通过引擎缓存和 state 暴露）
 */
export function doEval(opts = {}) {
  const engine = state.engine
  if (!engine) return null
  syncPaintTextures()
  const low = !!opts.low
  try {
    const t0 = performance.now()
    const scale = state.proxy * (low ? 0.5 : 1)
    const res = Math.min(engine.ext.maxTexture, Math.max(64, Math.round(state.resolution * scale)))
    const result = engine.evaluate(state.graph, { res })
    // 缩略图与 3D/2D 预览是开销最大的部分：笔画进行中的求值跳过它们，
    // 由笔画结束时的完整求值统一刷新。
    const thumbs = low ? state.lastThumbCount : engine.buildThumbs(state.graph, result, 96)
    state.gpuMs = result.ms
    state.lastEvalMs = +(performance.now() - t0).toFixed(1)
    state.evalNodes = engine.stats.nodes
    state.evalPasses = engine.stats.passes
    state.cacheHits = result.cacheHits
    state.lastThumbCount = thumbs
    state.engineStats = { ...engine.stats }
    state.dirty = false
    state.error = ''
    if (!low) state.previewNonce++
  } catch (e) {
    console.error('[eval]', e)
    state.error = e?.message || String(e)
  }
  return null
}

// ------------------------------------------------------------- 加载 / 持久化
/**
 * 用一份图数据整体替换当前工程（打开工程、切换示例、新建工程都走这里）。
 *
 * 副作用：清空引擎缓存与绘画画布/纹理、规范化节点、修复旧端口别名、重置选中与历史栈、
 * 重新同步绘画纹理、异步解码图片、立即求值并安排自动存档。
 *
 * @param {{nodes:Array, connections:Array}} graph 图数据
 * @param {{name?:string, resolution?:number, label?:string}} [opts] 工程名 / 分辨率 / 历史标签
 */
export function loadGraph(graph, opts = {}) {
  state.engine?.clearCache()
  for (const id of [...paintCanvases.keys()]) {
    state.engine?.removePaint(id)
    paintCanvases.delete(id)
  }
  state.graph.nodes = (graph.nodes || []).map(normalizeNode).filter(Boolean)
  // 迁移旧工程 / 脚本生成的别名连线（例如单输入节点上的 "in"，
  // 而 Transform 2D 的真实端口是 "input"），否则该输入会被静默断连。
  state.graph.connections = repairConnectionPorts(state.graph.nodes, graph.connections)
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

/**
 * 载入内置示例工程。
 * @param {string} id 示例 id（见 demos.js 的 DEMOS）
 * @returns {Object} 示例对象（含 name / graph / resolution）
 */
export function loadDemo(id) {
  const demo = buildDemo(id)
  const demoName = trText(demo.name)
  loadGraph(demo.graph, { name: demoName, resolution: demo.resolution, label: demoName })
  state.projectName = demoName
  return demo
}

/**
 * 新建空白工程：载入 blank 示例，并把工程名重置为「未命名」。
 */
export function newProject() {
  loadDemo('blank')
  state.projectName = t('project.untitled')
  schedulePersist()
}

/**
 * 序列化为可保存的工程对象。
 * 以 _ 开头的运行时字段（如图片缓存）会通过 graphJSON 的 replacer 被剔除。
 * @returns {{version:number, app:string, name:string, resolution:number, graph:Object}}
 */
export function serializeProject() {
  return {
    version: 1,
    app: 'substrate-texture-designer',
    name: state.projectName,
    resolution: state.resolution,
    graph: JSON.parse(graphJSON())
  }
}

/**
 * 把工程 POST 到服务端保存。
 * @param {string} [name] 新工程名（省略则沿用当前名称）
 * @returns {Promise<Object>} 服务端返回的 JSON
 * @throws {Error} 非 2xx 响应时抛出服务端返回的文本或状态码
 */
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

/**
 * 从服务端按名称加载工程并应用到当前会话。
 * @throws {Error} 工程不存在或请求失败时抛出本地化错误
 */
export async function loadProject(name) {
  const res = await fetch('/api/projects/load?name=' + encodeURIComponent(name))
  if (!res.ok) throw new Error(t('error.projectNotFound'))
  const data = await res.json()
  loadGraph(data.graph, { name: data.name, resolution: data.resolution, label: t('history.load', { name: data.name }) })
  return data
}

/**
 * 列出服务端保存的工程。
 * 请求失败时返回空数组，让「打开工程」面板可以继续以空列表展示。
 * @returns {Promise<Array>} 工程摘要列表
 */
export async function listProjects() {
  const res = await fetch('/api/projects')
  if (!res.ok) return []
  const data = await res.json()
  return data.projects || []
}

/**
 * 安排一次自动存档（900ms 防抖）。
 *
 * 频繁的编辑（拖动、绘画）会不断重置定时器，只有停下来后才真正写入 localStorage，
 * 减少同步写磁盘的开销。写入失败（例如配额超限）时静默忽略。
 */
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      const data = { name: state.projectName, resolution: state.resolution, graph: JSON.parse(graphJSON()), at: Date.now() }
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(data))
    } catch (e) {
      /* 配额超限 —— 忽略 */
    }
  }, 900)
}

/**
 * 尝试恢复本地自动存档。
 * @returns {boolean} 是否成功恢复了非空工程；无存档 / 数据损坏时返回 false
 */
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

/**
 * 应用启动时决定打开哪个工程，优先级从高到低：
 * 1. ?demo=<id> 指定示例；
 * 2. ?fresh 强制打开默认示例（忽略自动存档）；
 * 3. 本地自动存档；
 * 4. 兜底打开 weathered-steel 示例。
 */
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

/**
 * 生成底部状态栏文案：参与求值的节点数、渲染通道数、最近一次求值耗时。
 * @returns {string}
 */
export function statusLine() {
  return `${state.evalNodes} nodes · ${state.evalPasses} passes · ${state.lastEvalMs.toFixed(1)} ms`
}

export { hexToRgb, resolveParams }
