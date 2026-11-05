// ============================================================================
// GraphEditor —— 节点图编辑器（应用的核心画布）
//
// 界面位置：主界面中央最大的区域，用无限画布展示节点与连线。
//
// 坐标系统（关键概念）：
//  - 「世界坐标」是节点自身的 x/y（存进 store，逻辑单位）；
//  - 「视图变换」view = { x, y, scale }，作用在 .graph-world 的 CSS transform 上；
//  - 屏幕坐标 → 世界坐标由 toWorld 完成（减去画布左上角与平移量，再除以缩放）。
//  - 连线用 SVG 绘制，SVG 尺寸为 80000×80000 并整体偏移 -40000，
//    以此模拟「以原点为中心的正负坐标空间」，避免负坐标被裁掉。
//
// 交互：
//  - 左键空白拖拽 = 框选；中键或 Alt+左键拖拽 = 平移；滚轮 = 以指针为中心缩放；
//  - 节点拖拽（支持多选一起移动）、输出口拖拽连线（带吸附与合法性校验）、右键菜单增删节点。
//
// 与 engine 的交互：所有图数据的读写都走 engine/store.js（addNode / addConnection /
// setNodePosition / selectNode / pushHistoryRaw 等），本组件只维护视图状态与临时交互状态。
// ============================================================================
import { defineComponent, ref, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import {
  state,
  nodeById,
  defOf,
  addNode,
  addConnection,
  removeConnection,
  selectNode,
  selectNodes,
  setNodePosition,
  pushHistoryRaw,
  graphJSON,
  duplicateSelected,
  deleteSelected,
  disconnectInput,
  reachableIds,
  canConnect,
  openPaintStudio
} from '../engine/store.js'
import { NODE_DEFS, CATEGORIES } from '../engine/nodes/index.js'
import { catColor } from '../ui/theme.js'
import { t } from '../i18n/index.js'

/** 节点卡片宽度（px，世界单位） */
const W = 200
/** 节点标题栏高度 */
const HEADER = 28
/** SVG 画布的整体偏移量，使坐标系可以从负数开始 */
const OFFSET = 40000
/** SVG 画布边长 */
const EDGE_SIZE = 80000

/**
 * 第 i 个输入端口相对节点顶部的纵向偏移。
 * @param {number} i 端口序号（从 0 开始）
 * @returns {number} 像素偏移
 */
function portOffset(i) {
  return 14 + i * 16
}
/**
 * 节点正文区高度：随输入端口数量增长，并保证最小高度。
 * @param {object} def 节点定义
 * @returns {number}
 */
function bodyHeight(def) {
  const n = (def.inputs || []).length
  return Math.max(94, 14 + n * 16 + 10)
}
/**
 * 节点整体高度 = 标题栏 + 正文区。
 * @param {object} node 节点实例
 * @returns {number}
 */
function nodeHeightOf(node) {
  const def = defOf(node)
  return HEADER + (def ? bodyHeight(def) : 94)
}
/**
 * 输出端口相对节点顶部的纵向偏移：默认落在正文区垂直居中处。
 * @param {object} node 节点实例
 * @returns {number}
 */
function outputYRel(node) {
  const def = defOf(node)
  return HEADER + bodyHeight(def) / 2
}
/**
 * 生成三次贝塞尔连线的 SVG path 数据（水平出入，控制点按距离自动伸展）。
 * @param {number} x1 起点 x
 * @param {number} y1 起点 y
 * @param {number} x2 终点 x
 * @param {number} y2 终点 y
 * @returns {string} path 的 d 属性
 */
function bezier(x1, y1, x2, y2) {
  const dx = Math.max(46, Math.abs(x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/**
 * 常见输入端口名的「语义角色」说明。整张图是无类型的 RGBA 数据流（任何输出都能接到任何输入），
 * 因此这些文案只表达意图，不做类型约束；未收录的端口名回退到节点自身的描述。
 */
const PORT_ROLE_KEYS = {
  input: 'link.role.input',
  base: 'link.role.base',
  blend: 'link.role.blend',
  mask: 'link.role.mask',
  height: 'link.role.height',
  warper: 'link.role.warper',
  r: 'link.role.r',
  g: 'link.role.g',
  b: 'link.role.b',
  basecolor: 'link.role.basecolor',
  normal: 'link.role.normal',
  roughness: 'link.role.roughness',
  metallic: 'link.role.metallic',
  ao: 'link.role.ao',
  emissive: 'link.role.emissive',
  opacity: 'link.role.opacity'
}

export default defineComponent({
  name: 'GraphEditor',
  emits: ['open-paint'],
  setup(props, { emit }) {
    /** 画布根元素：坐标系原点、事件监听与尺寸计算的基准 */
    const root = ref(null)
    /** 右键「添加节点」菜单里的搜索输入框 */
    const menuInput = ref(null)
    /** 视图变换：平移 x/y 与缩放 scale（直接映射到 .graph-world 的 transform） */
    const view = reactive({ x: 80, y: 60, scale: 0.85 })
    /** 拖拽连线时临时绘制的橡皮筋曲线 { d, ex, ey, snapped, invalid } */
    const rubber = ref(null)
    /** 框选矩形（相对画布左上角的像素坐标） */
    const marquee = ref(null)
    /** 当前吸附到的合法输入端口 key（'out|nodeId:port'） */
    const hoverInput = ref(null)
    /** 当前指向但不合法的端口 key（用于红色高亮与原因提示） */
    const invalidPort = ref(null)
    /** 正在拖拽的连线源节点 id；null 表示没有连线操作 */
    const linkSource = ref(null)
    /** 指针屏幕坐标，用于把提示气泡避开边缘 */
    const pointer = reactive({ x: 0, y: 0 })
    /** 是否正在平移画布（模板用它切换光标样式） */
    const panning = ref(false)
    /** 右键菜单状态：屏幕坐标 x/y、世界坐标 wx/wy、模式（'add' 添加 / 'node' 节点操作）、目标节点、搜索词 */
    const menu = reactive({ open: false, x: 0, y: 0, wx: 0, wy: 0, mode: 'add', nodeId: null, filter: '' })
    /** 当前进行中的拖拽操作：{ kind: 'pan'|'node'|'marquee'|'link', ... } */
    let inter = null
    /** 是否已经自动「适应视图」过一次，避免重复打断用户视角 */
    let fitted = false
    /** 最近一次指针位置（预留给后续交互逻辑） */
    let lastPointer = { x: 0, y: 0 }

    /** 全部节点 */
    const nodes = computed(() => state.graph.nodes)
    /** 从输出节点反向可达的节点集合：用于把无关节点置灰 */
    const reachable = computed(() => reachableIds())
    /** 世界层 transform 样式 */
    const worldStyle = computed(() => ({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }))
    /** SVG 层的偏移样式（配合 OFFSET 让坐标可为负） */
    const edgeSvgStyle = computed(() => ({ left: -OFFSET + 'px', top: -OFFSET + 'px' }))
    /** 右键菜单定位样式 */
    const menuStyle = computed(() => ({ left: menu.x + 'px', top: menu.y + 'px' }))
    // Vue 对纯数字的 style 值不会自动补 px，未带单位的数值会产生非法声明、框体不可见，
    // 因此这里显式拼成带 px 的样式字符串。
    const marqueeStyle = computed(() => {
      const m = marquee.value
      if (!m) return null
      return { left: m.left + 'px', top: m.top + 'px', width: m.width + 'px', height: m.height + 'px' }
    })

    /**
     * 计算所有连线的 path 数据。
     * 遍历 connections，找到两端节点与目标输入口序号，换算成 SVG 坐标（统一加 OFFSET）；
     * 任一端缺失或端口名不存在时跳过（避免脏数据导致异常）。
     */
    const edges = computed(() => {
      const map = new Map(state.graph.nodes.map((n) => [n.id, n]))
      const out = []
      for (const c of state.graph.connections) {
        const a = map.get(c.from.node)
        const b = map.get(c.to.node)
        if (!a || !b) continue
        const defB = defOf(b)
        if (!defB) continue
        const idx = (defB.inputs || []).findIndex((i) => i.name === c.to.port)
        if (idx < 0) continue
        const x1 = a.x + W + OFFSET
        const y1 = a.y + outputYRel(a) + OFFSET
        const x2 = b.x + OFFSET
        const y2 = b.y + HEADER + portOffset(idx) + OFFSET
        out.push({ id: c.id, d: bezier(x1, y1, x2, y2), selected: state.selectedEdgeId === c.id, active: false })
      }
      return out
    })

    // ------------------------------------------------------- 连线建议
    // 拖拽连线期间，收集所有能合法接收该数据流的输入端口（即不会形成环），
    // 然后排序：语义匹配优先 → 空闲端口优先于已占用端口 → 最后按图上距离，让近的节点先出现。
    /** 拖拽连线时的候选端口列表 */
    const candidates = computed(() => (linkSource.value ? collectCandidates(linkSource.value) : []))
    /** 候选端口按 key 建索引，便于 O(1) 判断某端口是否可接 */
    const candidateMap = computed(() => {
      const map = new Map()
      for (const c of candidates.value) map.set(c.key, c)
      return map
    })
    /** 可接收当前连线的节点 id 集合，用于给节点加高亮样式 */
    const linkableIds = computed(() => new Set(candidates.value.map((c) => c.nodeId)))
    // 建议浮窗由「单选」驱动，且拖拽连线期间不显示（避免与吸附提示互相干扰）。
    /** 当前单选节点；多选或正在连线时为 null */
    const selectedNode = computed(() => {
      if (linkSource.value || state.selectedIds.length !== 1) return null
      return nodeById(state.selectedIds[0])
    })
    /** 选中节点的双向连接建议（出/入两个方向） */
    const selectionCandidates = computed(() =>
      selectedNode.value ? collectSelectionCandidates(selectedNode.value) : []
    )
    /** 浮窗只展示排名前 7 条建议 */
    const selectionTop = computed(() => selectionCandidates.value.slice(0, 7))
    /** 当前吸附端口的详细信息（显示在跟手提示气泡里） */
    const hoverDetail = computed(() => candidateMap.value.get(hoverInput.value) || null)
    /** 指向非法端口时的提示信息（含具体原因：会成环 / 不能连自己） */
    const invalidDetail = computed(() => {
      const key = invalidPort.value
      if (!key || !linkSource.value) return null
      const at = key.indexOf(':')
      const nodeId = key.slice(key.indexOf('|') + 1, at)
      const port = key.slice(at + 1)
      const node = nodeById(nodeId)
      const def = defOf(node)
      if (!node || !def) return null
      const inp = (def.inputs || []).find((i) => i.name === port)
      if (!inp) return null
      const check = canConnect(linkSource.value, nodeId)
      return {
        nodeTitle: node.data?.title || def.name,
        label: inp.label,
        reason: nodeId === linkSource.value ? t('link.self') : check.reason || t('link.invalidTitle')
      }
    })
    // 让端口提示气泡始终出现在远离视口边缘的一侧，避免遮住正在对准的节点：
    // 指针在左上半个屏幕时气泡朝右下，在右下半个屏幕时朝左上。
    const tipStyle = computed(() => {
      const w = 272
      const h = 150
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
      const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
      const left = pointer.x > vw / 2 ? pointer.x - w - 18 : pointer.x + 18
      const top = pointer.y > vh / 2 ? pointer.y - h - 20 : pointer.y + 20
      return { left: Math.max(8, Math.min(left, vw - w - 8)) + 'px', top: Math.max(8, Math.min(top, vh - h - 8)) + 'px' }
    })

    /**
     * 取输入端口的中文语义说明；没有词条时回退到节点描述。
     * @param {object} def 节点定义
     * @param {object} inp 输入端口定义
     * @returns {string}
     */
    function portRole(def, inp) {
      const key = PORT_ROLE_KEYS[inp.name]
      const text = key ? t(key) : ''
      if (text && text !== key) return text
      return def.desc || ''
    }
    /**
     * 色彩空间标签：'color' 表示颜色数据（sRGB），其它按数据（线性/法线等）处理。
     * @param {string} space
     * @returns {string}
     */
    function spaceLabel(space) {
      return space === 'color' ? t('link.spaceColor') : t('link.spaceData')
    }
    /**
     * 收集某个节点输出可以作为目标的全部输入端口候选。
     * 逐个节点用 canConnect 做合法性判断（成环/自连会被排除），
     * 再记录端口语义、色彩空间是否匹配、是否已被占用、以及用于排序的图上距离。
     * @param {string} fromId 源节点 id
     * @returns {Array<object>} 已排序的候选列表
     */
    function collectCandidates(fromId) {
      const src = nodeById(fromId)
      if (!src) return []
      const srcDef = defOf(src)
      const srcSpace = (srcDef && srcDef.space) || 'data'
      const out = []
      for (const n of state.graph.nodes) {
        if (n.id === fromId) continue
        const def = defOf(n)
        if (!def) continue
        const check = canConnect(fromId, n.id)
        if (!check.ok) continue
        for (const inp of def.inputs || []) {
          const space = inp.space || def.space || 'data'
          out.push({
            key: 'out|' + n.id + ':' + inp.name,
            direction: 'out',
            fromId,
            toId: n.id,
            toPort: inp.name,
            nodeId: n.id,
            port: inp.name,
            nodeTitle: n.data?.title || def.name,
            label: inp.label,
            role: portRole(def, inp),
            category: def.category,
            space,
            match: space === srcSpace,
            occupied: hasInput(n.id, inp.name),
            dist: Math.hypot(n.x + W - src.x, n.y + HEADER - src.y)
          })
        }
      }
      return rankCandidates(out)
    }
    /**
     * 候选排序：语义匹配 > 端口空闲 > 距离近。
     * @param {Array<object>} list 候选列表
     * @returns {Array<object>} 原数组（就地排序）
     */
    function rankCandidates(list) {
      return list.sort(
        (a, b) =>
          Number(b.match) - Number(a.match) ||
          Number(a.occupied) - Number(b.occupied) ||
          a.dist - b.dist
      )
    }
    /**
     * 选中节点的双向建议覆盖两个方向：
     * - `out`：选中节点的输出接入其它节点的输入（点一下即连线）
     * - `in`：其它节点接入选中节点的某个输入
     * 每条记录都带完整的 from/to 端点，因此浮窗里点一下就能直接建立连接。
     * @param {object} sel 选中的节点
     * @returns {Array<object>} 已排序的候选列表
     */
    function collectSelectionCandidates(sel) {
      const def = defOf(sel)
      if (!def) return []
      const out = []
      if (!def.isOutput) out.push(...collectCandidates(sel.id))
      for (const inp of def.inputs || []) {
        const targetSpace = inp.space || def.space || 'data'
        const occupied = hasInput(sel.id, inp.name)
        for (const src of state.graph.nodes) {
          if (src.id === sel.id) continue
          const srcDef = defOf(src)
          if (!srcDef || srcDef.isOutput) continue
          if (!canConnect(src.id, sel.id).ok) continue
          out.push({
            key: 'in|' + src.id + '|' + inp.name,
            direction: 'in',
            fromId: src.id,
            toId: sel.id,
            toPort: inp.name,
            nodeId: src.id,
            port: inp.name,
            nodeTitle: src.data?.title || srcDef.name,
            label: inp.label,
            role: portRole(def, inp),
            category: srcDef.category,
            space: targetSpace,
            match: (srcDef.space || 'data') === targetSpace,
            occupied,
            dist: Math.hypot(sel.x - src.x, sel.y - src.y)
          })
        }
      }
      return rankCandidates(out)
    }
    /**
     * 构造候选端口的唯一 key。
     * @param {string} nodeId 节点 id
     * @param {string} port 端口名
     * @returns {string}
     */
    function portKey(nodeId, port) {
      return 'out|' + nodeId + ':' + port
    }
    /**
     * 该端口是否是当前连线的合法目标。
     * @returns {boolean}
     */
    function isCandidate(nodeId, port) {
      return candidateMap.value.has(portKey(nodeId, port))
    }
    /**
     * 该端口合法但色彩空间不匹配（模板用 warn 样式提示）。
     * @returns {boolean}
     */
    function isMismatch(nodeId, port) {
      const c = candidateMap.value.get(portKey(nodeId, port))
      return !!c && !c.match
    }
    /**
     * 该端口是否正是当前被标记为非法（红色）的端口。
     * @returns {boolean}
     */
    function isInvalidPort(nodeId, port) {
      return invalidPort.value === portKey(nodeId, port)
    }
    /**
     * 点击浮窗建议：按候选记录的端点直接建立连接。
     * @param {object} c 候选记录
     */
    function connectSuggestion(c) {
      if (!c || !c.fromId) return
      addConnection(c.fromId, 'out', c.toId, c.toPort)
    }
    /** 右键菜单里按分类过滤后的节点定义（搜索匹配名称或类型） */
    const menuGroups = computed(() => {
      const q = (menu.filter || '').trim().toLowerCase()
      return CATEGORIES.map((cat) => ({
        cat,
        defs: NODE_DEFS.filter(
          (d) => d.category === cat && (!q || d.name.toLowerCase().includes(q) || d.type.includes(q))
        )
      })).filter((g) => g.defs.length)
    })

    /** 右键菜单当前操作的目标节点 */
    const menuNode = computed(() => (menu.nodeId ? nodeById(menu.nodeId) : null))

    /**
     * 节点卡片的定位与尺寸样式（世界坐标 → 绝对定位）。
     * @param {object} node 节点实例
     * @returns {object}
     */
    function nodeStyle(node) {
      return { left: node.x + 'px', top: node.y + 'px', width: W + 'px', height: nodeHeightOf(node) + 'px' }
    }
    /**
     * 输出端口相对节点顶部的偏移（模板中据此定位圆点）。
     * @param {object} node 节点实例
     * @returns {number}
     */
    function outputTop(node) {
      const def = defOf(node)
      return HEADER + (def ? bodyHeight(def) / 2 : 47)
    }
    /**
     * 节点是否处于选中状态。
     * @param {string} id 节点 id
     * @returns {boolean}
     */
    function isSelected(id) {
      return state.selectedIds.includes(id)
    }
    /**
     * 某个输入端口是否已经有连线（用于渲染「已连接」样式与「替换」提示）。
     * @param {string} nodeId 节点 id
     * @param {string} port 端口名
     * @returns {boolean}
     */
    function hasInput(nodeId, port) {
      return state.graph.connections.some((c) => c.to.node === nodeId && c.to.port === port)
    }
    /**
     * 屏幕坐标 → 世界坐标。
     * @param {number} clientX 视口 x
     * @param {number} clientY 视口 y
     * @returns {{x:number,y:number}}
     */
    function toWorld(clientX, clientY) {
      const rect = root.value.getBoundingClientRect()
      return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale }
    }

    // ------------------------------------------------------------- 交互状态机
    // 拖拽期间在 window 上监听 move/up，这样指针移出画布（甚至移出窗口）也能持续跟踪。
    /** 开始监听全局指针事件 */
    function listen() {
      window.addEventListener('pointermove', onWindowMove)
      window.addEventListener('pointerup', onWindowUp)
    }
    /** 结束监听（每次交互收尾都要调用，避免监听器泄漏） */
    function unlisten() {
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('pointerup', onWindowUp)
    }

    /**
     * 画布空白处按下：处理关闭菜单、平移（中键/Alt）与框选（左键）。
     * 只有事件目标确实是画布背景时才进入框选，避免在节点上按下时误触发。
     * @param {PointerEvent} e
     */
    function onCanvasDown(e) {
      if (menu.open) closeMenu()
      if (e.button === 1 || e.altKey) {
        // 中键或 Alt+左键：平移画布，记录起始指针位置与起始视图偏移
        inter = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }
        panning.value = true
        listen()
        return
      }
      if (e.button !== 0) return
      if (e.target !== root.value && !e.target.classList.contains('graph-world') && !e.target.closest('svg')) return
      selectNode(null)
      state.selectedEdgeId = null
      const start = toWorld(e.clientX, e.clientY)
      const rect = root.value.getBoundingClientRect()
      inter = {
        kind: 'marquee',
        start,
        startClient: { x: e.clientX, y: e.clientY },
        // 锚点用画布局部坐标：高亮框绘制在 .graph 内部，不能依赖视口位置
        //（position: fixed 在带缩放/变换的布局下也会算错）
        startLocal: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        moved: false
      }
      listen()
    }

    /**
     * 节点上按下：处理选中（Shift 多选）并进入节点拖拽；
     * 记录所有被拖拽节点的起始坐标与一份图快照（用于拖动结束后写入历史）。
     * @param {PointerEvent} e
     * @param {object} node 被按下的节点
     */
    function onNodeDown(e, node) {
      if (e.button !== 0) return
      if (e.shiftKey) selectNode(node.id, true)
      else if (!state.selectedIds.includes(node.id)) selectNode(node.id)
      const start = { x: e.clientX, y: e.clientY }
      const positions = state.graph.nodes
        .filter((n) => state.selectedIds.includes(n.id) || n.id === node.id)
        .map((n) => ({ id: n.id, x: n.x, y: n.y }))
      if (!state.selectedIds.includes(node.id)) selectNode(node.id)
      inter = {
        kind: 'node',
        start,
        positions,
        moved: false,
        snapshot: graphJSON(),
        nodeId: node.id
      }
      listen()
    }

    /**
     * 从输出端口按下开始拖拽连线：初始化橡皮筋曲线与候选集合。
     * 输出节点（PBR 终点）没有输出口，直接忽略。
     * @param {PointerEvent} e
     * @param {object} node 源节点
     */
    function onOutputDown(e, node) {
      if (e.button !== 0) return
      const def = defOf(node)
      if (!def || def.isOutput) return
      const start = toWorld(e.clientX, e.clientY)
      const x1 = node.x + W
      const y1 = node.y + outputYRel(node)
      inter = { kind: 'link', fromNode: node.id, x1, y1 }
      linkSource.value = node.id
      invalidPort.value = null
      pointer.x = e.clientX
      pointer.y = e.clientY
      const end = { x: start.x + OFFSET, y: start.y + OFFSET }
      rubber.value = { d: bezier(x1 + OFFSET, y1 + OFFSET, end.x, end.y), ex: end.x, ey: end.y }
      listen()
    }

    /**
     * 全局指针移动：按当前交互类型分发到平移 / 节点拖拽 / 框选 / 连线四种逻辑。
     * @param {PointerEvent} e
     */
    function onWindowMove(e) {
      lastPointer = { x: e.clientX, y: e.clientY }
      pointer.x = e.clientX
      pointer.y = e.clientY
      if (!inter) return
      if (inter.kind === 'pan') {
        view.x = inter.vx + (e.clientX - inter.sx)
        view.y = inter.vy + (e.clientY - inter.sy)
      } else if (inter.kind === 'node') {
        // 位移需除以缩放，保证拖动时节点与指针严格跟随
        const dx = (e.clientX - inter.start.x) / view.scale
        const dy = (e.clientY - inter.start.y) / view.scale
        // 超过 3px 才认为真的开始拖动（区分点击与拖拽）
        if (!inter.moved && Math.hypot(dx * view.scale, dy * view.scale) > 3) {
          inter.moved = true
          root.value.style.cursor = 'grabbing'
        }
        if (inter.moved) {
          for (const p of inter.positions) {
            const node = nodeById(p.id)
            if (node) setNodePosition(p.id, Math.round(p.x + dx), Math.round(p.y + dy))
          }
        }
      } else if (inter.kind === 'marquee') {
        const dx = e.clientX - inter.startClient.x
        const dy = e.clientY - inter.startClient.y
        if (!inter.moved && Math.hypot(dx, dy) > 4) inter.moved = true
        if (inter.moved) {
          // 框选矩形始终用「左上角 + 宽高」表示（因为可能向左上拖）
          const rect = root.value.getBoundingClientRect()
          const curX = e.clientX - rect.left
          const curY = e.clientY - rect.top
          marquee.value = {
            left: Math.min(curX, inter.startLocal.x),
            top: Math.min(curY, inter.startLocal.y),
            width: Math.abs(curX - inter.startLocal.x),
            height: Math.abs(curY - inter.startLocal.y)
          }
        }
      } else if (inter.kind === 'link') {
        const to = toWorld(e.clientX, e.clientY)
        // 对输入端口做几何命中测试（阈值随缩放调整，保证不同缩放下手感一致）
        let hit = null
        let snap = null
        for (const node of state.graph.nodes) {
          const def = defOf(node)
          if (!def) continue
          for (let i = 0; i < (def.inputs || []).length; i++) {
            const ix = node.x
            const iy = node.y + HEADER + portOffset(i)
            const d = Math.hypot(ix - to.x, iy - to.y)
            if (d < 26 / view.scale + 10) {
              hit = portKey(node.id, def.inputs[i].name)
              snap = { x: ix + OFFSET, y: iy + OFFSET }
              break
            }
          }
          if (hit) break
        }
        // 只有合法目标才可吸附并在抬手时建立连接；其它端口标红并给出原因
        //（「会形成环」「不能连自己」）。
        const valid = !!hit && candidateMap.value.has(hit)
        hoverInput.value = valid ? hit : null
        invalidPort.value = hit && !valid ? hit : null
        const end = valid ? snap : { x: to.x + OFFSET, y: to.y + OFFSET }
        rubber.value = {
          d: bezier(inter.x1 + OFFSET, inter.y1 + OFFSET, end.x, end.y),
          ex: end.x,
          ey: end.y,
          snapped: valid,
          invalid: !!invalidPort.value && !valid
        }
      }
    }

    /**
     * 全局指针抬起：结束当前交互并按类型提交结果
     * （拖拽结束写历史、框选选出节点、连线建立连接），最后清空所有临时状态。
     * @param {PointerEvent} e
     */
    function onWindowUp(e) {
      if (inter) {
        if (inter.kind === 'pan') panning.value = false
        if (inter.kind === 'node') {
          root.value.style.cursor = ''
          // 只有真的移动过才写入一条「移动」历史记录
          if (inter.moved) pushHistoryRaw(inter.snapshot, t('history.move'))
        }
        if (inter.kind === 'marquee' && inter.moved && marquee.value) {
          // 框选矩形是画布局部像素，需要换算成图（世界）坐标
          const x1 = (marquee.value.left - view.x) / view.scale
          const y1 = (marquee.value.top - view.y) / view.scale
          const x2 = x1 + marquee.value.width / view.scale
          const y2 = y1 + marquee.value.height / view.scale
          const picked = state.graph.nodes.filter((n) => {
            const h = nodeHeightOf(n)
            return n.x < x2 && n.x + W > x1 && n.y < y2 && n.y + h > y1
          })
          if (picked.length) selectNodes(picked.map((n) => n.id))
        }
        if (inter.kind === 'link') {
          const picked = hoverInput.value ? candidateMap.value.get(hoverInput.value) : null
          if (picked) addConnection(picked.fromId, 'out', picked.toId, picked.toPort)
        }
        inter = null
      }
      rubber.value = null
      marquee.value = null
      hoverInput.value = null
      invalidPort.value = null
      linkSource.value = null
      unlisten()
    }

    /**
     * 滚轮缩放：以指针位置为锚点，保证指针下的世界坐标在缩放前后不移动。
     * 缩放系数由 deltaY 指数映射，并限制在 0.22~1.8 之间。
     * @param {WheelEvent} e
     */
    function onWheel(e) {
      const rect = root.value.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      // 记录指针当前指向的世界坐标
      const wx = (mx - view.x) / view.scale
      const wy = (my - view.y) / view.scale
      const next = Math.min(1.8, Math.max(0.22, view.scale * Math.exp(-e.deltaY * 0.0014)))
      view.scale = next
      // 反推新的平移量，使世界坐标 wx/wy 仍落在指针处
      view.x = mx - wx * next
      view.y = my - wy * next
    }

    /**
     * 以画布中心为锚点按比例缩放（工具栏 +/- 按钮使用）。
     * @param {number} f 缩放倍数（>1 放大，<1 缩小）
     */
    function zoomBy(f) {
      const rect = root.value.getBoundingClientRect()
      const mx = rect.width / 2
      const my = rect.height / 2
      const wx = (mx - view.x) / view.scale
      const wy = (my - view.y) / view.scale
      view.scale = Math.min(1.8, Math.max(0.22, view.scale * f))
      view.x = mx - wx * view.scale
      view.y = my - wy * view.scale
    }

    /**
     * 自适应视图：计算所有节点的包围盒，取合适的缩放并居中显示（留 70px 边距）。
     * 缩放限制在 0.25~1.1，避免小图被放得过大。
     */
    function fit() {
      const list = state.graph.nodes
      if (!list.length || !root.value) return
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of list) {
        minX = Math.min(minX, n.x)
        minY = Math.min(minY, n.y)
        maxX = Math.max(maxX, n.x + W)
        maxY = Math.max(maxY, n.y + nodeHeightOf(n))
      }
      const rect = root.value.getBoundingClientRect()
      const pad = 70
      const sx = (rect.width - pad * 2) / Math.max(1, maxX - minX)
      const sy = (rect.height - pad * 2) / Math.max(1, maxY - minY)
      view.scale = Math.min(1.1, Math.max(0.25, Math.min(sx, sy)))
      view.x = (rect.width - (maxX - minX) * view.scale) / 2 - minX * view.scale
      view.y = (rect.height - (maxY - minY) * view.scale) / 2 - minY * view.scale
      fitted = true
    }

    /**
     * 在画布中心创建一个新节点（节点左侧居中于视口中心）。
     * @param {string} type 节点类型
     * @returns {object|null} 新建的节点；画布未就绪时为 null
     */
    function addAtCenter(type) {
      if (!root.value) return null
      const rect = root.value.getBoundingClientRect()
      const world = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return addNode(type, { x: world.x - W / 2, y: world.y - 60 })
    }

    // ------------------------------------------------------------------ 右键菜单
    /**
     * 在指定屏幕位置打开菜单，并记录该位置对应的世界坐标（用于「在此处添加节点」）。
     * 菜单坐标会夹紧在视口内，防止溢出屏幕。
     * @param {MouseEvent} e 右键事件
     * @param {'add'|'node'} mode 菜单模式
     * @param {string|null} nodeId 节点操作模式下的目标节点
     */
    function openMenuAt(e, mode, nodeId) {
      menu.open = true
      menu.mode = mode
      menu.nodeId = nodeId || null
      menu.filter = ''
      menu.x = Math.min(e.clientX, window.innerWidth - 300)
      menu.y = Math.min(e.clientY, window.innerHeight - 440)
      const world = toWorld(e.clientX, e.clientY)
      menu.wx = world.x
      menu.wy = world.y
      // 等菜单渲染出来后再聚焦搜索框，用户可直接输入
      nextTick(() => menuInput.value?.focus())
    }
    /** 关闭右键菜单 */
    function closeMenu() {
      menu.open = false
    }
    /** 画布右键：打开「添加节点」菜单 */
    function onCanvasContext(e) {
      openMenuAt(e, 'add', null)
    }
    /** 节点右键：先选中该节点，再打开「节点操作」菜单 */
    function onNodeContext(e, node) {
      selectNode(node.id)
      openMenuAt(e, 'node', node.id)
    }
    /**
     * 从菜单添加节点：位置用菜单打开时记录的世界坐标。
     * @param {string} type 节点类型
     */
    function addFromMenu(type) {
      addNode(type, { x: menu.wx, y: menu.wy })
      closeMenu()
    }
    /** 搜索框回车：添加当前过滤结果中的第一个节点 */
    function addFirst() {
      const first = menuGroups.value[0]?.defs[0]
      if (first) addFromMenu(first.type)
    }
    /**
     * 执行节点操作菜单里的动作。
     * @param {'delete'|'duplicate'|'disconnect'|'paint'} kind 动作类型
     */
    function nodeAction(kind) {
      const node = menuNode.value
      if (!node) return
      if (kind === 'delete') {
        selectNode(node.id)
        deleteSelected()
      } else if (kind === 'duplicate') {
        selectNode(node.id)
        duplicateSelected()
      } else if (kind === 'disconnect') {
        // 断开该节点所有输入连接
        const def = defOf(node)
        for (const inp of def.inputs || []) disconnectInput(node.id, inp.name)
      } else if (kind === 'paint') {
        openPaintStudio(node.id)
      }
      closeMenu()
    }
    /**
     * 双击节点：绘制型节点打开绘制工作台，其它节点交给（预留的）内联操作。
     * @param {object} node 节点实例
     */
    function onNodeDblClick(node) {
      const def = defOf(node)
      if (def && def.paintInput) emit('open-paint', node.id)
      else addNodeFromNode(node)
    }
    /** 预留：未来用于双击节点时的内联操作 */
    function addNodeFromNode(node) {
      /* 预留给未来的内联操作 */
    }
    /**
     * 选中连线：清空节点选择，只保留连线选中态（按 Delete 时用于删除连线）。
     * @param {string} id 连线 id
     */
    function selectEdge(id) {
      state.selectedEdgeId = id
      state.selectedIds = []
      state.activeNodeId = null
    }

    /**
     * 全局键盘：Delete/Backspace 删除选中连线。
     * 在输入框/文本域/下拉框中按键时不拦截，避免影响正常输入。
     * @param {KeyboardEvent} e
     */
    function onKeyDown(e) {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedEdgeId) {
        removeConnection(state.selectedEdgeId)
        state.selectedEdgeId = null
        e.preventDefault()
      }
    }

    // 图中首次出现节点时自动适应视图（仅一次，之后不打扰用户视角）
    watch(
      () => state.graph.nodes.length,
      (n) => {
        if (n > 0 && !fitted) nextTick(fit)
      }
    )

    onMounted(() => {
      window.addEventListener('keydown', onKeyDown)
      nextTick(() => {
        if (state.graph.nodes.length) fit()
      })
    })
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown)
      unlisten()
    })

    // 对外暴露：视图状态、候选集合、几何辅助函数与事件处理器，全部供模板使用
    return {
      root,
      menuInput,
      view,
      rubber,
      marquee,
      hoverInput,
      invalidPort,
      linkSource,
      selectedNode,
      selectionCandidates,
      selectionTop,
      linkableIds,
      hoverDetail,
      invalidDetail,
      tipStyle,
      panning,
      menu,
      menuGroups,
      menuNode,
      nodes,
      reachable,
      worldStyle,
      edgeSvgStyle,
      menuStyle,
      marqueeStyle,
      edges,
      W,
      HEADER,
      portOffset,
      nodeStyle,
      outputTop,
      isSelected,
      hasInput,
      catColor,
      defOf,
      portKey,
      isCandidate,
      isMismatch,
      isInvalidPort,
      connectSuggestion,
      spaceLabel,
      onCanvasDown,
      onNodeDown,
      onOutputDown,
      onWheel,
      zoomBy,
      fit,
      addAtCenter,
      onCanvasContext,
      onNodeContext,
      addFromMenu,
      addFirst,
      nodeAction,
      onNodeDblClick,
      selectEdge,
      closeMenu
    }
  },
  template: `
    <div
      class="graph"
      ref="root"
      :class="{ panning: panning }"
      @pointerdown="onCanvasDown"
      @wheel.prevent="onWheel"
      @contextmenu.prevent="onCanvasContext"
    >
      <div class="graph-world" :style="worldStyle">
        <!-- 连线层：SVG 尺寸固定为 80000×80000 并整体左上偏移，以此支持负坐标；
             每条连线由「加粗命中路径 + 可见路径」两条 path 组成，便于点击选中 -->
        <svg class="edges" :width="80000" :height="80000" :style="edgeSvgStyle">
          <g v-for="e in edges" :key="e.id">
            <path class="edge-hit" :d="e.d" @pointerdown.stop="selectEdge(e.id)"></path>
            <path class="edge" :class="{ selected: e.selected }" :d="e.d" @pointerdown.stop="selectEdge(e.id)"></path>
          </g>
          <!-- 拖拽中的橡皮筋曲线与端点圆点（吸附成功/非法时改变样式） -->
          <path v-if="rubber" class="edge rubber" :d="rubber.d"></path>
          <circle v-if="rubber" class="rubber-dot" :class="{ snapped: rubber.snapped, invalid: rubber.invalid }" :cx="rubber.ex" :cy="rubber.ey" r="4.5"></circle>
        </svg>

        <!-- 节点层：每张卡片按世界坐标绝对定位；dim 表示与输出节点无关，linkable 表示可接收当前连线 -->
        <div
          v-for="node in nodes"
          :key="node.id"
          class="gnode"
          :class="{
            selected: isSelected(node.id),
            dim: !reachable.has(node.id),
            output: defOf(node).isOutput,
            linkable: linkableIds.has(node.id)
          }"
          :style="nodeStyle(node)"
          @pointerdown.stop="onNodeDown($event, node)"
          @dblclick.stop="onNodeDblClick(node)"
          @contextmenu.stop.prevent="onNodeContext($event, node)"
        >
          <!-- 卡片头：分类色点 + 标题（可改名）+ 分类名 -->
          <div class="gnode-header">
            <span class="cat-dot" :style="{ background: catColor(defOf(node).category) }"></span>
            <span class="gnode-title">{{ node.data.title || defOf(node).name }}</span>
            <span class="gnode-cat">{{ defOf(node).category }}</span>
          </div>
          <!-- 缩略图（_thumb 由引擎烘焙时生成），没有则占位 -->
          <img v-if="node._thumb" class="gnode-thumb" :src="node._thumb" draggable="false" alt="" />
          <div v-else class="gnode-thumb"></div>
          <!-- 输入端口：小圆点与左侧标签，位置由 portOffset 统一计算；
               连线拖拽时通过 candidate/mismatch/invalid 类给出视觉反馈 -->
          <div
            v-for="(inp, i) in defOf(node).inputs"
            :key="inp.name"
            class="port input"
            :class="{
              connected: hasInput(node.id, inp.name),
              hot: hoverInput === portKey(node.id, inp.name),
              candidate: isCandidate(node.id, inp.name),
              mismatch: isMismatch(node.id, inp.name),
              invalid: isInvalidPort(node.id, inp.name)
            }"
            :style="{ top: (HEADER + portOffset(i)) + 'px' }"
          ></div>
          <span
            v-for="(inp, i) in defOf(node).inputs"
            :key="'lbl' + inp.name"
            class="port-label"
            :style="{ top: (HEADER + portOffset(i)) + 'px' }"
            >{{ inp.label }}</span
          >
          <!-- 输出端口：按下即开始拖拽连线；输出节点（PBR 终点）没有输出口，改为底部说明文字 -->
          <div
            v-if="!defOf(node).isOutput"
            class="port output"
            :style="{ top: outputTop(node) + 'px' }"
            :title="$t('graph.outputPort')"
            @pointerdown.stop="onOutputDown($event, node)"
          ></div>
          <div
            v-if="defOf(node).isOutput"
            class="gnode-footer"
            style="position: absolute; left: 10px; bottom: 7px; font-family: var(--mono); font-size: 9px; color: var(--text-faint)"
          >
            {{ $t('graph.pbrSink') }}
          </div>
        </div>
      </div>

      <!-- 连接建议浮窗：单选节点时列出可一键连接的目标端口（最多 7 条） -->
      <div v-if="selectedNode" class="link-dock" @pointerdown.stop @contextmenu.prevent>
        <span class="link-dock-count">{{ $t('link.suggestTitle', { n: selectionCandidates.length }) }}</span>
        <div v-if="selectionTop.length" class="link-dock-list">
          <button
            v-for="c in selectionTop"
            :key="c.key"
            class="link-item"
            :title="$t('link.itemTitle', { node: c.nodeTitle, port: c.label, role: c.role })"
            @pointerdown.prevent.stop="connectSuggestion(c)"
          >
            <span class="link-item-main">
              <span class="cat-dot" :style="{ background: catColor(c.category) }"></span>
              <span class="link-item-name">{{ c.nodeTitle }}</span>
              <span class="link-item-dir" :class="c.direction">{{ c.direction === 'out' ? '→' : '←' }}</span>
              <span class="link-item-port">{{ c.label }}</span>
              <span class="link-item-space" :class="{ warn: !c.match }">{{ spaceLabel(c.space) }}</span>
              <span v-if="c.occupied" class="link-item-replace">{{ $t('link.replaceShort') }}</span>
            </span>
            <span class="link-item-role">{{ c.role }}</span>
          </button>
        </div>
        <span v-else class="link-dock-empty">{{ $t('link.empty') }}</span>
      </div>

      <!-- 跟手提示气泡：吸附到合法端口时显示详情，指向非法端口时显示失败原因 -->
      <div v-if="hoverDetail" class="link-tip" :style="tipStyle">
        <div class="link-tip-title">
          <span class="cat-dot" :style="{ background: catColor(hoverDetail.category) }"></span>
          <span class="link-tip-node">{{ hoverDetail.nodeTitle }}</span>
          <span class="link-tip-arrow">→</span>
          <span class="link-tip-port">{{ hoverDetail.label }}</span>
        </div>
        <div class="link-tip-role">{{ hoverDetail.role }}</div>
        <div class="link-tip-meta">
          <span class="link-chip" :class="{ warn: !hoverDetail.match }">{{ spaceLabel(hoverDetail.space) }}</span>
          <span v-if="!hoverDetail.match" class="link-chip warn">{{ $t('link.spaceMismatch') }}</span>
          <span v-if="hoverDetail.occupied" class="link-chip warn">{{ $t('link.replace') }}</span>
        </div>
        <div class="link-tip-action">{{ $t('link.release') }}</div>
      </div>
      <div v-else-if="invalidDetail" class="link-tip invalid" :style="tipStyle">
        <div class="link-tip-title">
          <span class="link-tip-node">{{ invalidDetail.nodeTitle }}</span>
          <span class="link-tip-arrow">→</span>
          <span class="link-tip-port">{{ invalidDetail.label }}</span>
        </div>
        <div class="link-tip-action">{{ $t('link.invalidTitle') }} · {{ invalidDetail.reason }}</div>
      </div>

      <!-- 右下角视图工具：放大、缩小、适应视图 -->
      <div class="graph-tools">
        <button class="icon-btn" :title="$t('graph.zoomIn')" @click="zoomBy(1.25)">+</button>
        <button class="icon-btn" :title="$t('graph.zoomOut')" @click="zoomBy(0.8)">−</button>
        <button class="icon-btn" :title="$t('graph.fit')" @click="fit">⛶</button>
      </div>
      <div v-if="!selectedNode && !linkSource" class="graph-hint">{{ $t('graph.hint') }}</div>

      <!-- 右键菜单：add 模式带搜索与分类列表；node 模式提供绘制/复制/断开/删除 -->
      <div v-if="menu.open" class="graph-menu" :style="menuStyle" @pointerdown.stop @contextmenu.prevent>
        <template v-if="menu.mode === 'add'">
          <input
            ref="menuInput"
            v-model="menu.filter"
            class="search"
            :placeholder="$t('graph.addTitle')"
            @keydown.enter="addFirst"
            @keydown.esc="closeMenu"
          />
          <div class="graph-menu-list">
            <template v-for="group in menuGroups" :key="group.cat">
              <div class="menu-section">{{ $trNode(group.cat) }}</div>
              <button v-for="def in group.defs" :key="def.type" class="menu-item" @click="addFromMenu(def.type)">
                <span>{{ $trNode(def.name) }}</span>
                <span class="dim">{{ $trNode(def.category) }}</span>
              </button>
            </template>
            <div v-if="!menuGroups.length" class="menu-item dim">{{ $t('graph.noMatch') }}</div>
          </div>
        </template>
        <template v-else>
          <div class="graph-menu-list">
            <div class="menu-section">{{ $t('graph.nodeActions') }}</div>
            <button v-if="menuNode && defOf(menuNode).paintInput" class="menu-item" @click="nodeAction('paint')">
              <span>{{ $t('graph.openPaint') }}</span><span class="dim">{{ $t('graph.paintTag') }}</span>
            </button>
            <button class="menu-item" @click="nodeAction('duplicate')"><span>{{ $t('graph.duplicate') }}</span><span class="dim">Ctrl+D</span></button>
            <button class="menu-item" @click="nodeAction('disconnect')"><span>{{ $t('graph.disconnect') }}</span></button>
            <button class="menu-item" @click="nodeAction('delete')"><span style="color: var(--red)">{{ $t('graph.delete') }}</span></button>
          </div>
        </template>
      </div>

      <!-- 框选高亮矩形（画布局部像素坐标） -->
      <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>
    </div>
  `
})
