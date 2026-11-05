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

const W = 200
const HEADER = 28
const OFFSET = 40000
const EDGE_SIZE = 80000

function portOffset(i) {
  return 14 + i * 16
}
function bodyHeight(def) {
  const n = (def.inputs || []).length
  return Math.max(94, 14 + n * 16 + 10)
}
function nodeHeightOf(node) {
  const def = defOf(node)
  return HEADER + (def ? bodyHeight(def) : 94)
}
function outputYRel(node) {
  const def = defOf(node)
  return HEADER + bodyHeight(def) / 2
}
function bezier(x1, y1, x2, y2) {
  const dx = Math.max(46, Math.abs(x2 - x1) * 0.5)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/**
 * Purpose of the best-known input ports. The graph itself is an untyped RGBA stream (any output
 * can feed any input), so these strings explain *intent* rather than enforce a type system.
 * Unknown port names fall back to the receiving node's own description.
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
    const root = ref(null)
    const menuInput = ref(null)
    const view = reactive({ x: 80, y: 60, scale: 0.85 })
    const rubber = ref(null)
    const marquee = ref(null)
    const hoverInput = ref(null)
    const invalidPort = ref(null)
    const linkSource = ref(null)
    const pointer = reactive({ x: 0, y: 0 })
    const panning = ref(false)
    const menu = reactive({ open: false, x: 0, y: 0, wx: 0, wy: 0, mode: 'add', nodeId: null, filter: '' })
    let inter = null
    let fitted = false
    let lastPointer = { x: 0, y: 0 }

    const nodes = computed(() => state.graph.nodes)
    const reachable = computed(() => reachableIds())
    const worldStyle = computed(() => ({ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }))
    const edgeSvgStyle = computed(() => ({ left: -OFFSET + 'px', top: -OFFSET + 'px' }))
    const menuStyle = computed(() => ({ left: menu.x + 'px', top: menu.y + 'px' }))
    // Vue sets numeric style values verbatim (no implicit px), so unitless numbers would produce an
    // invalid declaration and an invisible 0×0 box — build the style string explicitly.
    const marqueeStyle = computed(() => {
      const m = marquee.value
      if (!m) return null
      return { left: m.left + 'px', top: m.top + 'px', width: m.width + 'px', height: m.height + 'px' }
    })

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

    // ------------------------------------------------------- link suggestions
    // While a link is being dragged we collect every input port that can legally receive the
    // stream (i.e. no cycle), then rank them: semantic match first, free ports before occupied
    // ones, and finally by graph distance so nearby nodes surface first.
    const candidates = computed(() => (linkSource.value ? collectCandidates(linkSource.value) : []))
    const candidateMap = computed(() => {
      const map = new Map()
      for (const c of candidates.value) map.set(c.key, c)
      return map
    })
    const linkableIds = computed(() => new Set(candidates.value.map((c) => c.nodeId)))
    // The suggestion dock is selection-driven (single selection only) and never shown while
    // a link is being dragged.
    const selectedNode = computed(() => {
      if (linkSource.value || state.selectedIds.length !== 1) return null
      return nodeById(state.selectedIds[0])
    })
    const selectionCandidates = computed(() =>
      selectedNode.value ? collectSelectionCandidates(selectedNode.value) : []
    )
    const selectionTop = computed(() => selectionCandidates.value.slice(0, 7))
    const hoverDetail = computed(() => candidateMap.value.get(hoverInput.value) || null)
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
    // Keep the port tooltip on the side away from the viewport edge so it never covers the node
    // being aimed at: right/below on the top-left half, left/above on the bottom-right half.
    const tipStyle = computed(() => {
      const w = 272
      const h = 150
      const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
      const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
      const left = pointer.x > vw / 2 ? pointer.x - w - 18 : pointer.x + 18
      const top = pointer.y > vh / 2 ? pointer.y - h - 20 : pointer.y + 20
      return { left: Math.max(8, Math.min(left, vw - w - 8)) + 'px', top: Math.max(8, Math.min(top, vh - h - 8)) + 'px' }
    })

    function portRole(def, inp) {
      const key = PORT_ROLE_KEYS[inp.name]
      const text = key ? t(key) : ''
      if (text && text !== key) return text
      return def.desc || ''
    }
    function spaceLabel(space) {
      return space === 'color' ? t('link.spaceColor') : t('link.spaceData')
    }
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
    function rankCandidates(list) {
      return list.sort(
        (a, b) =>
          Number(b.match) - Number(a.match) ||
          Number(a.occupied) - Number(b.occupied) ||
          a.dist - b.dist
      )
    }
    /**
     * Selection suggestions cover both directions around the selected node:
     * - `out`: the selected node's output feeding another node's input (click connects them)
     * - `in`: another node feeding one of the selected node's inputs
     * Entries carry concrete from/to endpoints so a click in the dock can connect immediately.
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
    function portKey(nodeId, port) {
      return 'out|' + nodeId + ':' + port
    }
    function isCandidate(nodeId, port) {
      return candidateMap.value.has(portKey(nodeId, port))
    }
    function isMismatch(nodeId, port) {
      const c = candidateMap.value.get(portKey(nodeId, port))
      return !!c && !c.match
    }
    function isInvalidPort(nodeId, port) {
      return invalidPort.value === portKey(nodeId, port)
    }
    function connectSuggestion(c) {
      if (!c || !c.fromId) return
      addConnection(c.fromId, 'out', c.toId, c.toPort)
    }
    const menuGroups = computed(() => {
      const q = (menu.filter || '').trim().toLowerCase()
      return CATEGORIES.map((cat) => ({
        cat,
        defs: NODE_DEFS.filter(
          (d) => d.category === cat && (!q || d.name.toLowerCase().includes(q) || d.type.includes(q))
        )
      })).filter((g) => g.defs.length)
    })

    const menuNode = computed(() => (menu.nodeId ? nodeById(menu.nodeId) : null))

    function nodeStyle(node) {
      return { left: node.x + 'px', top: node.y + 'px', width: W + 'px', height: nodeHeightOf(node) + 'px' }
    }
    function outputTop(node) {
      const def = defOf(node)
      return HEADER + (def ? bodyHeight(def) / 2 : 47)
    }
    function isSelected(id) {
      return state.selectedIds.includes(id)
    }
    function hasInput(nodeId, port) {
      return state.graph.connections.some((c) => c.to.node === nodeId && c.to.port === port)
    }
    function toWorld(clientX, clientY) {
      const rect = root.value.getBoundingClientRect()
      return { x: (clientX - rect.left - view.x) / view.scale, y: (clientY - rect.top - view.y) / view.scale }
    }

    // ------------------------------------------------------------- interaction
    function listen() {
      window.addEventListener('pointermove', onWindowMove)
      window.addEventListener('pointerup', onWindowUp)
    }
    function unlisten() {
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('pointerup', onWindowUp)
    }

    function onCanvasDown(e) {
      if (menu.open) closeMenu()
      if (e.button === 1 || e.altKey) {
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
        // canvas-local anchor: the highlight box lives inside .graph, so it must not depend on
        // viewport position (position: fixed would also break under scaled/transformed layouts)
        startLocal: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        moved: false
      }
      listen()
    }

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

    function onWindowMove(e) {
      lastPointer = { x: e.clientX, y: e.clientY }
      pointer.x = e.clientX
      pointer.y = e.clientY
      if (!inter) return
      if (inter.kind === 'pan') {
        view.x = inter.vx + (e.clientX - inter.sx)
        view.y = inter.vy + (e.clientY - inter.sy)
      } else if (inter.kind === 'node') {
        const dx = (e.clientX - inter.start.x) / view.scale
        const dy = (e.clientY - inter.start.y) / view.scale
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
        // geometric hit test on input ports
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
        // Only legal targets may snap and be picked up on release; any other port is flagged
        // red with an explanation ("would create a cycle", "cannot connect to itself").
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

    function onWindowUp(e) {
      if (inter) {
        if (inter.kind === 'pan') panning.value = false
        if (inter.kind === 'node') {
          root.value.style.cursor = ''
          if (inter.moved) pushHistoryRaw(inter.snapshot, t('history.move'))
        }
        if (inter.kind === 'marquee' && inter.moved && marquee.value) {
          // marquee is stored in canvas-local pixels; convert the box to graph (world) units
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

    function onWheel(e) {
      const rect = root.value.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const wx = (mx - view.x) / view.scale
      const wy = (my - view.y) / view.scale
      const next = Math.min(1.8, Math.max(0.22, view.scale * Math.exp(-e.deltaY * 0.0014)))
      view.scale = next
      view.x = mx - wx * next
      view.y = my - wy * next
    }

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

    function addAtCenter(type) {
      if (!root.value) return null
      const rect = root.value.getBoundingClientRect()
      const world = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return addNode(type, { x: world.x - W / 2, y: world.y - 60 })
    }

    // ------------------------------------------------------------------ menus
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
      nextTick(() => menuInput.value?.focus())
    }
    function closeMenu() {
      menu.open = false
    }
    function onCanvasContext(e) {
      openMenuAt(e, 'add', null)
    }
    function onNodeContext(e, node) {
      selectNode(node.id)
      openMenuAt(e, 'node', node.id)
    }
    function addFromMenu(type) {
      addNode(type, { x: menu.wx, y: menu.wy })
      closeMenu()
    }
    function addFirst() {
      const first = menuGroups.value[0]?.defs[0]
      if (first) addFromMenu(first.type)
    }
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
        const def = defOf(node)
        for (const inp of def.inputs || []) disconnectInput(node.id, inp.name)
      } else if (kind === 'paint') {
        openPaintStudio(node.id)
      }
      closeMenu()
    }
    function onNodeDblClick(node) {
      const def = defOf(node)
      if (def && def.paintInput) emit('open-paint', node.id)
      else addNodeFromNode(node)
    }
    function addNodeFromNode(node) {
      /* reserved for future inline actions */
    }
    function selectEdge(id) {
      state.selectedEdgeId = id
      state.selectedIds = []
      state.activeNodeId = null
    }

    function onKeyDown(e) {
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedEdgeId) {
        removeConnection(state.selectedEdgeId)
        state.selectedEdgeId = null
        e.preventDefault()
      }
    }

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
        <svg class="edges" :width="80000" :height="80000" :style="edgeSvgStyle">
          <g v-for="e in edges" :key="e.id">
            <path class="edge-hit" :d="e.d" @pointerdown.stop="selectEdge(e.id)"></path>
            <path class="edge" :class="{ selected: e.selected }" :d="e.d" @pointerdown.stop="selectEdge(e.id)"></path>
          </g>
          <path v-if="rubber" class="edge rubber" :d="rubber.d"></path>
          <circle v-if="rubber" class="rubber-dot" :class="{ snapped: rubber.snapped, invalid: rubber.invalid }" :cx="rubber.ex" :cy="rubber.ey" r="4.5"></circle>
        </svg>

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
          <div class="gnode-header">
            <span class="cat-dot" :style="{ background: catColor(defOf(node).category) }"></span>
            <span class="gnode-title">{{ node.data.title || defOf(node).name }}</span>
            <span class="gnode-cat">{{ defOf(node).category }}</span>
          </div>
          <img v-if="node._thumb" class="gnode-thumb" :src="node._thumb" draggable="false" alt="" />
          <div v-else class="gnode-thumb"></div>
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

      <div class="graph-tools">
        <button class="icon-btn" :title="$t('graph.zoomIn')" @click="zoomBy(1.25)">+</button>
        <button class="icon-btn" :title="$t('graph.zoomOut')" @click="zoomBy(0.8)">−</button>
        <button class="icon-btn" :title="$t('graph.fit')" @click="fit">⛶</button>
      </div>
      <div v-if="!selectedNode && !linkSource" class="graph-hint">{{ $t('graph.hint') }}</div>

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

      <div v-if="marquee" class="marquee" :style="marqueeStyle"></div>
    </div>
  `
})
