import { defineComponent, ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import NodePalette from './components/NodePalette.js'
import GraphEditor from './components/GraphEditor.js'
import Inspector from './components/Inspector.js'
import Preview3D from './components/Preview3D.js'
import MapPanel from './components/MapPanel.js'
import PaintStudio from './components/PaintStudio.js'
import ExportDialog from './components/ExportDialog.js'
import AiPanel from './components/AiPanel.js'
import AssetLibrary from './components/AssetLibrary.js'
import { runMcpSelfCheck } from './engine/mcp-selfcheck.js'
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
import { locale, locales, setLocale, t, trText } from './i18n/index.js'

export default defineComponent({
  name: 'App',
  components: { NodePalette, GraphEditor, Inspector, Preview3D, MapPanel, PaintStudio, ExportDialog, AiPanel, AssetLibrary },
  setup() {
    const graphRef = ref(null)
    const showExport = ref(false)
    const showProjects = ref(false)
    const showDemos = ref(false)
    const showHelp = ref(false)
    const showAi = ref(false)
    const showAssets = ref(false)
    const mcpCheck = ref(null)
    const mcpChecking = ref(false)
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
      if (!node) notify(t('toast.addFail'), 'error')
    }

    function doNew() {
      newProject()
      nextTick(() => graphRef.value?.fit())
      notify(t('toast.newMaterial'))
    }

    function doDemo(id) {
      loadDemo(id)
      showDemos.value = false
      nextTick(() => graphRef.value?.fit())
      const demo = state.demos.find((d) => d.id === id)
      notify(t('toast.demoLoaded', { name: trText(demo?.name) || id }))
    }

    async function doSave() {
      try {
        const res = await saveProject(state.projectName)
        notify(t('toast.saved', { file: res.file }))
      } catch (e) {
        notify(t('toast.saveFail', { msg: e.message }), 'error')
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
        notify(t('toast.loaded', { name }))
      } catch (e) {
        notify(t('toast.loadFail', { msg: e.message }), 'error')
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

    async function runMcpCheck() {
      mcpChecking.value = true
      try {
        const report = await runMcpSelfCheck()
        mcpCheck.value = report
        notify(report.ok ? t('ai.selfcheckPass') + ' · ' + report.totals.passed : t('ai.selfcheckFail') + ' · ' + report.totals.failed, report.ok ? 'info' : 'error')
      } catch (e) {
        mcpCheck.value = { ok: false, totals: { passed: 0, failed: 1 }, checks: [{ name: String(e.message || e), ok: false }] }
        notify(String(e.message || e), 'error')
      } finally {
        mcpChecking.value = false
      }
    }

    async function runSelfTest() {
      showHelp.value = false
      notify(t('audit.running'))
      try {
        const { runAudit } = await import('./engine/audit.js')
        const report = await runAudit(state.engine, 'all')
        window.__AUDIT__ = report
        const passed = report.sections ? report.sections.reduce((n, s) => n + s.passed, 0) : report.passed
        if (report.ok) notify(t('audit.pass', { n: passed }))
        else notify(t('audit.fail', { n: report.failed }), 'error')
      } catch (e) {
        notify(t('audit.error', { msg: e?.message || String(e) }), 'error')
      }
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
      if (!n) return t('status.noSelection')
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
      showAi,
      showAssets,
      mcpCheck,
      mcpChecking,
      runMcpCheck,
      projects,
      loadingProjects,
      toast,
      RESOLUTIONS,
      PROXIES,
      locale,
      locales,
      setLocale,
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
      runSelfTest,
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
            <div class="brand-sub">{{ $t('brand.sub') }}</div>
          </div>
        </div>
        <div class="divider"></div>
        <input class="project-name" v-model="state.projectName" :title="$t('top.projectName')" />
        <button class="btn" @click="doNew">{{ $t('top.new') }}</button>
        <div class="dropdown">
          <button class="btn" @click="showDemos = !showDemos">{{ $t('top.demos') }} ▾</button>
          <div v-if="showDemos" class="dropdown-menu" @click.stop>
            <button v-for="d in state.demos" :key="d.id" class="dd-item" @click="doDemo(d.id)">
              <span class="dd-name">{{ $tr(d.name) }}</span>
              <span class="dd-desc">{{ $tr(d.desc) }}</span>
            </button>
          </div>
        </div>
        <button class="btn" @click="doSave" :title="$t('top.saveTitle')">{{ $t('top.save') }}</button>
        <button class="btn" @click="openProjects">{{ $t('top.open') }}</button>
        <div class="divider"></div>
        <button class="icon-btn" :title="$t('top.undo')" @click="undo">↺</button>
        <button class="icon-btn" :title="$t('top.redo')" @click="redo">↻</button>
        <div class="divider"></div>
        <select class="top-select" :value="state.resolution" @change="onResolution" :title="$t('top.resolution')">
          <option v-for="r in RESOLUTIONS" :key="r" :value="r">{{ r }}²</option>
        </select>
        <select class="top-select" :value="state.proxy" @change="onProxy" :title="$t('top.proxy')">
          <option v-for="p in PROXIES" :key="p.value" :value="p.value">{{ $t('top.proxyValue', { p: p.label }) }}</option>
        </select>
        <div class="spacer"></div>
        <div class="lang-switch" :title="$t('lang.label')">
          <button v-for="l in locales" :key="l.id" :class="{ on: locale.value === l.id }" @click="setLocale(l.id)">{{ l.label }}</button>
        </div>
        <button class="icon-btn ai-btn" :title="$t('ai.title')" @click="showAi = !showAi">✦</button>
        <button class="icon-btn" :title="$t('assets.title')" @click="showAssets = true">▦</button>
        <button class="icon-btn" :title="$t('top.help')" @click="showHelp = true">?</button>
        <button class="btn primary" @click="showExport = true">{{ $t('top.export') }}</button>
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
            <button :class="{ on: !state.showMaps }" @click="state.showMaps = false">{{ $t('tabs.3d') }}</button>
            <button :class="{ on: state.showMaps }" @click="state.showMaps = true">{{ $t('tabs.maps') }}</button>
            <span class="spacer"></span>
            <span class="chip">{{ canvasSize }}</span>
          </div>
          <Preview3D v-show="!state.showMaps" />
          <MapPanel v-show="state.showMaps" />
          <Inspector @open-paint="openPaint" />
        </aside>
      </main>

      <footer class="statusbar">
        <span :class="state.engine ? 'ok' : 'err'">{{ state.engine ? $t('status.gpu') : $t('status.offline') }}</span>
        <span>{{ state.engineInfo || $t('status.initialising') }}</span>
        <span>{{ $t('status.eval', { nodes: state.evalNodes, passes: state.evalPasses, ms: state.lastEvalMs.toFixed(1) }) }}</span>
        <span>{{ $t('status.cache', { n: state.cacheHits }) }}</span>
        <span>{{ historyLabel }}</span>
        <span class="spacer"></span>
        <span>{{ selectedInfo }}</span>
        <span v-if="state.error" class="err">{{ state.error }}</span>
      </footer>

      <ExportDialog v-if="showExport" @close="showExport = false" />
    <AiPanel v-if="showAi" @close="showAi = false" />
    <AssetLibrary v-if="showAssets" @close="showAssets = false" />

      <div v-if="showProjects" class="modal-backdrop" @click.self="showProjects = false">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title">{{ $t('projects.title') }}</div>
            <button class="icon-btn" @click="showProjects = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="hint" style="margin-bottom: 10px">{{ $t('projects.hint') }}</div>
            <div class="project-list">
              <div v-if="loadingProjects" class="hint">{{ $t('projects.loading') }}</div>
              <div v-else-if="!projects.length" class="hint">{{ $t('projects.empty') }}</div>
              <button v-for="p in projects" :key="p.file" class="project-row" @click="openProject(p.name)">
                <span class="pr-name">{{ p.name }}</span>
                <span class="pr-meta">{{ $t('projects.meta', { res: p.resolution, nodes: p.nodes }) }}</span>
                <span class="pr-meta">{{ new Date(p.savedAt).toLocaleString() }}</span>
              </button>
            </div>
          </div>
          <div class="modal-foot">
            <span class="hint">{{ $t('projects.tip') }}</span>
            <button class="btn" @click="showProjects = false">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>

      <div v-if="showHelp" class="modal-backdrop" @click.self="showHelp = false">
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title">{{ $t('help.title') }}</div>
            <button class="icon-btn" @click="showHelp = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="side-title">{{ $t('help.graphTitle') }}</div>
            <div class="hint" style="line-height: 1.9">{{ $t('help.graphBody') }}</div>
            <div class="side-title">{{ $t('help.shortcutTitle') }}</div>
            <div class="hint" style="line-height: 1.9">{{ $t('help.shortcutBody') }}</div>
            <div class="side-title">{{ $t('help.paintTitle') }}</div>
            <div class="hint" style="line-height: 1.9">{{ $t('help.paintBody') }}</div>
            <div class="side-title">{{ $t('help.stdTitle') }}</div>
            <div class="hint" style="line-height: 1.9">{{ $t('help.stdBody') }}</div>
            <div v-if="mcpCheck" class="selfcheck-box" :class="mcpCheck.ok ? 'ok' : 'bad'">
              <div>{{ mcpCheck.ok ? $t('ai.selfcheckPass') : $t('ai.selfcheckFail') }} · {{ mcpCheck.totals.passed }}/{{ mcpCheck.totals.passed + mcpCheck.totals.failed }}</div>
              <div v-for="c in mcpCheck.checks.filter(c => !c.ok).slice(0, 6)" :key="c.name" class="hint small">✕ {{ c.name }} {{ c.info }}</div>
            </div>
          </div>
          <div class="modal-foot">
            <span class="hint">{{ $t('help.foot') }}</span>
            <div style="display: flex; gap: 8px">
              <button class="btn" @click="runSelfTest">{{ $t('audit.run') }}</button>
        <button class="btn" @click="runMcpCheck" :disabled="mcpChecking">{{ $t('ai.selfcheck') }}</button>
              <button class="btn" @click="showHelp = false">{{ $t('help.ok') }}</button>
            </div>
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
