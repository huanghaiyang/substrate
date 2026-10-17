import { defineComponent, ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import NodePalette from './components/NodePalette.js'
import GraphEditor from './components/GraphEditor.js'
import Inspector from './components/Inspector.js'
import Preview3D from './components/Preview3D.js'
import MapPanel from './components/MapPanel.js'
import PaintStudio from './components/PaintStudio.js'
import ExportDialog from './components/ExportDialog.js'
import {
  state,
  newProject,
  loadDemo,
  undo,
  redo,
  saveProject,
  listProjects,
  loadProject,
  requestEval,
  setResolution,
  setProxy,
  deleteSelected,
  duplicateSelected,
  nodeById,
  defOf
} from './engine/store.js'
import { buildPreview } from './engine/preview.js'
import { RESOLUTIONS, PROXIES } from './ui/theme.js'

export default defineComponent({
  name: 'App',
  components: { NodePalette, GraphEditor, Inspector, Preview3D, MapPanel, PaintStudio, ExportDialog },
  setup() {
    const graphRef = ref(null)
    const showExport = ref(false)
    const showProjects = ref(false)
    const showDemos = ref(false)
    const showHelp = ref(false)
    const projects = ref([])
    const loadingProjects = ref(false)
    const toast = ref({ msg: '', type: '' })
    let toastTimer = null
    let previewTimer = null

    function notify(msg, type = '') {
      toast.value = { msg, type }
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toast.value = { msg: '', type: '' }), 3200)
    }

    function onPaletteAdd(type) {
      const node = graphRef.value?.addAtCenter(type)
      if (!node) notify('Could not add node — only one PBR Output is allowed', 'error')
    }

    function doNew() {
      newProject()
      nextTick(() => graphRef.value?.fit())
      notify('New material created')
    }

    function doDemo(id) {
      loadDemo(id)
      showDemos.value = false
      nextTick(() => graphRef.value?.fit())
      notify('Loaded demo: ' + (state.demos.find((d) => d.id === id)?.name || id))
    }

    async function doSave() {
      try {
        const res = await saveProject(state.projectName)
        notify('Saved projects/' + res.file)
      } catch (e) {
        notify('Save failed: ' + e.message, 'error')
      }
    }

    async function openProjects() {
      showProjects.value = true
      loadingProjects.value = true
      try {
        projects.value = await listProjects()
      } catch (e) {
        projects.value = []
      }
      loadingProjects.value = false
    }

    async function openProject(name) {
      try {
        await loadProject(name)
        showProjects.value = false
        nextTick(() => graphRef.value?.fit())
        notify('Loaded ' + name)
      } catch (e) {
        notify('Load failed: ' + e.message, 'error')
      }
    }

    function openPaint(nodeId) {
      const node = nodeById(nodeId)
      if (!node) return
      state.activePaintId = nodeId
      state.mode = 'paint'
      state.selectedIds = [nodeId]
      state.activeNodeId = nodeId
    }
    function closePaint() {
      state.mode = 'graph'
      state.activePaintId = null
      requestEval(true)
    }

    function onResolution(e) {
      setResolution(Number(e.target.value))
    }
    function onProxy(e) {
      setProxy(Number(e.target.value))
    }

    function onKey(e) {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      const key = (e.key || '').toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key === 'd') {
        e.preventDefault()
        duplicateSelected()
        return
      }
      if (mod && key === 's') {
        e.preventDefault()
        doSave()
        return
      }
      if (mod && key === 'e') {
        e.preventDefault()
        showExport.value = true
        return
      }
      if (e.key === 'Escape') {
        if (state.mode === 'paint') closePaint()
        else {
          showExport.value = false
          showProjects.value = false
          showDemos.value = false
          showHelp.value = false
        }
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.mode === 'graph') {
        if (state.selectedEdgeId) return
        e.preventDefault()
        deleteSelected()
      }
    }

    watch(
      () => state.previewNonce,
      () => {
        if (previewTimer) clearTimeout(previewTimer)
        previewTimer = setTimeout(() => {
          previewTimer = null
          if (buildPreview(state.engine, 384)) state.previewVersion++
        }, 120)
      }
    )
    watch(
      () => state.error,
      (msg) => {
        if (msg) notify(msg, 'error')
      }
    )

    const selectedInfo = computed(() => {
      const n = nodeById(state.activeNodeId)
      if (!n) return 'No selection'
      return defOf(n)?.name + ' · ' + n.id
    })
    const historyLabel = computed(() => state.historyLabel)
    const canvasSize = computed(() => state.resolution + ' × ' + state.resolution)

    onMounted(() => window.addEventListener('keydown', onKey))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    return {
      state,
      graphRef,
      showExport,
      showProjects,
      showDemos,
      showHelp,
      projects,
      loadingProjects,
      toast,
      RESOLUTIONS,
      PROXIES,
      selectedInfo,
      historyLabel,
      canvasSize,
      onPaletteAdd,
      doNew,
      doDemo,
      doSave,
      openProjects,
      openProject,
      openPaint,
      closePaint,
      onResolution,
      onProxy,
      undo,
      redo
    }
  },
  template: `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">SUBSTRATE</div>
            <div class="brand-sub">Procedural Texture Studio</div>
          </div>
        </div>
        <div class="divider"></div>
        <input class="project-name" v-model="state.projectName" title="Material / project name" />
        <button class="btn" @click="doNew">New</button>
        <div class="dropdown">
          <button class="btn" @click="showDemos = !showDemos">Demos ▾</button>
          <div v-if="showDemos" class="dropdown-menu" @click.stop>
            <button v-for="d in state.demos" :key="d.id" class="dd-item" @click="doDemo(d.id)">
              <span class="dd-name">{{ d.name }}</span>
              <span class="dd-desc">{{ d.desc }}</span>
            </button>
          </div>
        </div>
        <button class="btn" @click="doSave" title="Save project (Ctrl+S)">Save</button>
        <button class="btn" @click="openProjects">Open</button>
        <div class="divider"></div>
        <button class="icon-btn" title="Undo (Ctrl+Z)" @click="undo">↺</button>
        <button class="icon-btn" title="Redo (Ctrl+Shift+Z)" @click="redo">↻</button>
        <div class="divider"></div>
        <select class="top-select" :value="state.resolution" @change="onResolution" title="Document resolution">
          <option v-for="r in RESOLUTIONS" :key="r" :value="r">{{ r }}²</option>
        </select>
        <select class="top-select" :value="state.proxy" @change="onProxy" title="Proxy resolution while editing">
          <option v-for="p in PROXIES" :key="p.value" :value="p.value">Proxy {{ p.label }}</option>
        </select>
        <div class="spacer"></div>
        <button class="icon-btn" title="Shortcuts & help" @click="showHelp = true">?</button>
        <button class="btn primary" @click="showExport = true">Export Material</button>
      </header>

      <main class="workspace">
        <NodePalette @add="onPaletteAdd" />
        <section class="center-col">
          <GraphEditor
            ref="graphRef"
            v-show="state.mode === 'graph'"
            @open-paint="openPaint"
          />
          <PaintStudio
            v-if="state.mode === 'paint' && state.activePaintId"
            :node-id="state.activePaintId"
            @close="closePaint"
          />
        </section>
        <aside class="right-col">
          <div class="right-tabs">
            <button :class="{ on: !state.showMaps }" @click="state.showMaps = false">3D View</button>
            <button :class="{ on: state.showMaps }" @click="state.showMaps = true">2D Maps</button>
            <span class="spacer"></span>
            <span class="chip">{{ canvasSize }}</span>
          </div>
          <Preview3D v-show="!state.showMaps" />
          <MapPanel v-show="state.showMaps" />
          <Inspector @open-paint="openPaint" />
        </aside>
      </main>

      <footer class="statusbar">
        <span :class="state.engine ? 'ok' : 'err'">{{ state.engine ? '● GPU' : '○ GPU offline' }}</span>
        <span>{{ state.engineInfo || 'initialising…' }}</span>
        <span>{{ state.evalNodes }} nodes · {{ state.evalPasses }} passes · {{ state.lastEvalMs.toFixed(1) }} ms</span>
        <span>cache {{ state.cacheHits }} hits</span>
        <span>{{ historyLabel }}</span>
        <span class="spacer"></span>
        <span>{{ selectedInfo }}</span>
        <span v-if="state.error" class="err">{{ state.error }}</span>
      </footer>

      <ExportDialog v-if="showExport" @close="showExport = false" />

      <div v-if="showProjects" class="modal-backdrop" @click.self="showProjects = false">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title">Open Material</div>
            <button class="icon-btn" @click="showProjects = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="hint" style="margin-bottom: 10px">Projects are stored as JSON in the <code>projects/</code> folder on the Node server.</div>
            <div class="project-list">
              <div v-if="loadingProjects" class="hint">Loading…</div>
              <div v-else-if="!projects.length" class="hint">No saved projects yet — use Save to create one.</div>
              <button v-for="p in projects" :key="p.file" class="project-row" @click="openProject(p.name)">
                <span class="pr-name">{{ p.name }}</span>
                <span class="pr-meta">{{ p.resolution }}² · {{ p.nodes }} nodes</span>
                <span class="pr-meta">{{ new Date(p.savedAt).toLocaleString() }}</span>
              </button>
            </div>
          </div>
          <div class="modal-foot">
            <span class="hint">Tip: the current session is auto-saved to your browser storage.</span>
            <button class="btn" @click="showProjects = false">Close</button>
          </div>
        </div>
      </div>

      <div v-if="showHelp" class="modal-backdrop" @click.self="showHelp = false">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title">Workflow & Shortcuts</div>
            <button class="icon-btn" @click="showHelp = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="side-title">Graph</div>
            <div class="hint" style="line-height: 1.9">
              Drag from a node's right port to an input to connect. Drag on empty canvas for a selection box.
              Alt-drag or middle-drag pans, the wheel zooms, right-click adds nodes.
              Right-click a node for duplicate / disconnect / delete.
            </div>
            <div class="side-title">Shortcuts</div>
            <div class="hint" style="line-height: 1.9">
              ⌘/Ctrl+Z undo · ⌘/Ctrl+Shift+Z redo · ⌘/Ctrl+D duplicate selection · Del delete ·
              ⌘/Ctrl+S save · ⌘/Ctrl+E export · Esc leave paint studio / close dialogs
            </div>
            <div class="side-title">Painting</div>
            <div class="hint" style="line-height: 1.9">
              Double-click a Paint Layer node (or use its properties button) to open Paint Studio.
              Brush colour, size, opacity, hardness and X/Y symmetry are stored per stroke, so undo works.
            </div>
            <div class="side-title">Standards</div>
            <div class="hint" style="line-height: 1.9">
              All processing happens in linear light on RGBA16F targets. Base colour and emissive are sRGB-encoded on
              export; normal / roughness / metallic / AO / height stay linear. Export presets pack ORM (glTF/Unreal) and
              Mask Map (Unity), with manifest.json + README.md describing colour spaces and normal convention.
            </div>
          </div>
          <div class="modal-foot">
            <span class="hint">Substrate 1.0 · Vue 3 + Three.js + Node (zero-bundler ESM)</span>
            <button class="btn" @click="showHelp = false">Got it</button>
          </div>
        </div>
      </div>

      <div v-if="toast.msg" class="toast" :class="toast.type">
        <span>{{ toast.msg }}</span>
        <span class="close" @click="toast.msg = ''">✕</span>
      </div>
    </div>
  `
})
