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
  openPaintStudio
} from '../engine/store.js'
import { NODE_DEFS, CATEGORIES } from '../engine/nodes/index.js'
import { catColor } from '../ui/theme.js'

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
      inter = { kind: 'marquee', start, startClient: { x: e.clientX, y: e.clientY }, moved: false }
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
      rubber.value = { d: bezier(x1, y1, start.x, start.y) }
      listen()
    }

    function onWindowMove(e) {
      lastPointer = { x: e.clientX, y: e.clientY }
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
          marquee.value = {
            left: Math.min(e.clientX, inter.startClient.x),
            top: Math.min(e.clientY, inter.startClient.y),
            width: Math.abs(dx),
            height: Math.abs(dy)
          }
        }
      } else if (inter.kind === 'link') {
        const to = toWorld(e.clientX, e.clientY)
        rubber.value = { d: bezier(inter.x1, inter.y1, to.x, to.y) }
        // geometric hit test on input ports
        let hit = null
        for (const node of state.graph.nodes) {
          const def = defOf(node)
          if (!def) continue
          for (let i = 0; i < (def.inputs || []).length; i++) {
            const ix = node.x
            const iy = node.y + HEADER + portOffset(i)
            const d = Math.hypot(ix - to.x, iy - to.y)
            if (d < 26 / view.scale + 10) {
              hit = node.id + ':' + def.inputs[i].name
              break
            }
          }
          if (hit) break
        }
        hoverInput.value = hit
      }
    }

    function onWindowUp(e) {
      if (inter) {
        if (inter.kind === 'pan') panning.value = false
        if (inter.kind === 'node') {
          root.value.style.cursor = ''
          if (inter.moved) pushHistoryRaw(inter.snapshot, 'Move nodes')
        }
        if (inter.kind === 'marquee' && inter.moved && marquee.value) {
          const x1 = (marquee.value.left - root.value.getBoundingClientRect().left - view.x) / view.scale
          const y1 = (marquee.value.top - root.value.getBoundingClientRect().top - view.y) / view.scale
          const x2 = x1 + marquee.value.width / view.scale
          const y2 = y1 + marquee.value.height / view.scale
          const picked = state.graph.nodes.filter((n) => {
            const h = nodeHeightOf(n)
            return n.x < x2 && n.x + W > x1 && n.y < y2 && n.y + h > y1
          })
          if (picked.length) selectNodes(picked.map((n) => n.id))
        }
        if (inter.kind === 'link') {
          if (hoverInput.value) {
            const [toId, port] = hoverInput.value.split(':')
            addConnection(inter.fromNode, 'out', toId, port)
          }
        }
        inter = null
      }
      rubber.value = null
      marquee.value = null
      hoverInput.value = null
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
      panning,
      menu,
      menuGroups,
      menuNode,
      nodes,
      reachable,
      worldStyle,
      edgeSvgStyle,
      menuStyle,
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
        </svg>

        <div
          v-for="node in nodes"
          :key="node.id"
          class="gnode"
          :class="{ selected: isSelected(node.id), dim: !reachable.has(node.id), output: defOf(node).isOutput }"
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
            :class="{ connected: hasInput(node.id, inp.name), hot: hoverInput === node.id + ':' + inp.name }"
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
            title="Output — drag to an input"
            @pointerdown.stop="onOutputDown($event, node)"
          ></div>
          <div
            v-if="defOf(node).isOutput"
            class="gnode-footer"
            style="position: absolute; left: 10px; bottom: 7px; font-family: var(--mono); font-size: 9px; color: var(--text-faint)"
          >
            PBR SINK
          </div>
        </div>
      </div>

      <div class="graph-tools">
        <button class="icon-btn" title="Zoom in" @click="zoomBy(1.25)">+</button>
        <button class="icon-btn" title="Zoom out" @click="zoomBy(0.8)">−</button>
        <button class="icon-btn" title="Fit graph to view" @click="fit">⛶</button>
      </div>
      <div class="graph-hint">
        Drag ports to connect · wheel zooms · Alt/⌥-drag or middle-drag pans · right-click for the node menu ·
        Del/⌫ removes the selected node or link · double-click a Paint node to paint
      </div>

      <div v-if="menu.open" class="graph-menu" :style="menuStyle" @pointerdown.stop @contextmenu.prevent>
        <template v-if="menu.mode === 'add'">
          <input
            ref="menuInput"
            v-model="menu.filter"
            class="search"
            placeholder="Add node… (Enter for first match)"
            @keydown.enter="addFirst"
            @keydown.esc="closeMenu"
          />
          <div class="graph-menu-list">
            <template v-for="group in menuGroups" :key="group.cat">
              <div class="menu-section">{{ group.cat }}</div>
              <button v-for="def in group.defs" :key="def.type" class="menu-item" @click="addFromMenu(def.type)">
                <span>{{ def.name }}</span>
                <span class="dim">{{ def.category }}</span>
              </button>
            </template>
            <div v-if="!menuGroups.length" class="menu-item dim">No match</div>
          </div>
        </template>
        <template v-else>
          <div class="graph-menu-list">
            <div class="menu-section">Node actions</div>
            <button v-if="menuNode && defOf(menuNode).paintInput" class="menu-item" @click="nodeAction('paint')">
              <span>Open Paint Studio</span><span class="dim">paint</span>
            </button>
            <button class="menu-item" @click="nodeAction('duplicate')"><span>Duplicate</span><span class="dim">Ctrl+D</span></button>
            <button class="menu-item" @click="nodeAction('disconnect')"><span>Disconnect inputs</span></button>
            <button class="menu-item" @click="nodeAction('delete')"><span style="color: var(--red)">Delete node</span></button>
          </div>
        </template>
      </div>

      <div v-if="marquee" class="marquee" :style="marquee"></div>
    </div>
  `
})
