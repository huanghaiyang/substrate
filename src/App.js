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
import TrashDialog from './components/TrashDialog.js'
import AiFloating from './components/AiFloating.js'
import { aiChat, hideFloating } from './engine/ai-chat.js'
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
  autoLayout,
  nodeById,
  defOf
} from './engine/store.js'
import { buildPreview } from './engine/preview.js'
import { RESOLUTIONS, PROXIES } from './ui/theme.js'
import { locale, locales, setLocale, t, trText } from './i18n/index.js'
import { MANUAL_SECTIONS, MANUAL_TAGS, GLOSSARY } from './manual.js'

export default defineComponent({
  name: 'App',
  components: { NodePalette, GraphEditor, Inspector, Preview3D, MapPanel, PaintStudio, ExportDialog, TrashDialog, AiPanel, AssetLibrary, AiFloating },
  setup() {
    const graphRef = ref(null)
    const showExport = ref(false)
    const showProjects = ref(false)
    const showTrash = ref(false)
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

    // Built-in manual / glossary panel state (content lives in src/manual.js)
    const helpTab = ref('manual')
    const helpQuery = ref('')
    const helpSection = ref(MANUAL_SECTIONS[0].id)
    const helpTag = ref('all')

    /** current manual language — reactive through the global locale ref */
    const helpLang = computed(() => (locale.value === 'zh' ? 'zh' : 'en'))
    const manualSections = computed(() => MANUAL_SECTIONS)
    const manualTags = computed(() => MANUAL_TAGS)

    const matchText = (value, q) => !q || String(value).toLowerCase().includes(q)

    /** section whose body is shown: search results, or the single selected section */
    const visibleSections = computed(() => {
      const lang = helpLang.value
      const q = helpQuery.value.trim().toLowerCase()
      if (!q) return MANUAL_SECTIONS.filter((s) => s.id === helpSection.value)
      return MANUAL_SECTIONS.filter((s) => {
        const hay = [s.title[lang], ...s.blocks.flatMap((b) => (b.type === 'p' ? [b[lang]] : b.type === 'table' ? b.rows.flat().map((c) => c[lang]) : (b[lang] || [])))].join(' ')
        return matchText(hay, q)
      })
    })

    const visibleGlossary = computed(() => {
      const lang = helpLang.value
      const q = helpQuery.value.trim().toLowerCase()
      return GLOSSARY.filter((g) => helpTag.value === 'all' || g.tag === helpTag.value).filter(
        (g) => !q || matchText(g.term[lang] + ' ' + g.desc[lang] + ' ' + g.app[lang], q)
      )
    })

    /** cross-search: how many glossary terms match whatever is typed in the manual tab */
    const glossaryMatches = computed(() => {
      const q = helpQuery.value.trim().toLowerCase()
      if (!q) return 0
      const lang = helpLang.value
      return GLOSSARY.filter((g) => matchText(g.term[lang] + ' ' + g.desc[lang] + ' ' + g.app[lang], q)).length
    })

    const helpCount = computed(() =>
      helpTab.value === 'manual'
        ? t('help.sectionCount', { n: helpQuery.value.trim() ? visibleSections.value.length : MANUAL_SECTIONS.length })
        : t('help.termCount', { n: visibleGlossary.value.length })
    )

    /** tiny inline formatter for the manual text: **bold**, `code`, and newlines */
    function rich(text) {
      const esc = String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return esc
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
    }

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

    async function deleteProject(name) {
      try {
        const r = await fetch('/api/projects/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        })
        const j = await r.json()
        if (!j.ok) {
          if (j.error?.code === 'PROJECT_ACTIVE') throw new Error(t('projects.activeLocked'))
          throw new Error(j.error?.message || 'delete failed')
        }
        projects.value = await listProjects()
        notify(t('toast.projectTrashed', { name }))
      } catch (e) {
        notify(t('toast.deleteFail', { msg: e.message }), 'error')
      }
    }

    /** tell the server which material is open, so it can refuse to delete it */
    let activeTimer = 0
    function markActiveProject(name) {
      clearTimeout(activeTimer)
      activeTimer = setTimeout(() => {
        fetch('/api/projects/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name || '' })
        }).catch(() => {})
      }, 250)
    }
    watch(
      () => state.projectName,
      (name) => markActiveProject(name),
      { immediate: true }
    )

    const deletingMaterial = ref(false)

    /**
     * Move the material that is open in the editor to the recycle bin.
     *
     * Its assets stay bound: the binned project keeps its graph (with the imageAssetId references), so
     * the library still refuses to delete those assets until the material is purged from the bin.
     * The editor then starts a blank material so it is never editing a file that no longer exists.
     */
    async function deleteCurrentMaterial() {
      if (deletingMaterial.value) return
      deletingMaterial.value = true
      try {
        const name = state.projectName
        const res = await fetch('/api/projects/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, force: true })
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok && j?.error?.code !== 'NOT_FOUND') throw new Error(j?.error?.message || 'delete failed')
        if (j?.trashed) notify(t('toast.materialTrashed', { name }), 'ok')
        else notify(t('toast.materialUnsaved'), 'ok')
        newProject()
      } catch (e) {
        notify(t('toast.deleteFail', { msg: e.message }), 'error')
      } finally {
        deletingMaterial.value = false
      }
    }

    function deleteSelection() {
      if (!state.selectedIds.length) {
        notify(t('top.deleteSelectionEmpty'), 'error')
        return
      }
      const n = state.selectedIds.length
      deleteSelected()
      notify(t('toast.nodesDeleted', { n }))
    }

    function openTrash() {
      showTrash.value = true
      showProjects.value = false
      showAssets.value = false
    }

    async function onTrashChanged() {
      // the bin changed: refresh the open material list and library if they are visible
      if (showProjects.value) projects.value = await listProjects()
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

    function expandAi() {
      showAi.value = true
      hideFloating()
    }
    function toggleAi() {
      showAi.value = !showAi.value
      if (showAi.value) hideFloating()
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

    function doAutoLayout() {
      const result = autoLayout()
      nextTick(() => graphRef.value?.fit())
      notify(t('toast.layoutDone', { n: result.moved }))
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
      showTrash,
      openTrash,
      deleteSelection,
      deleteCurrentMaterial,
      deletingMaterial,
      deleteProject,
      onTrashChanged,
      showDemos,
      showHelp,
      helpTab,
      helpQuery,
      helpSection,
      helpTag,
      helpLang,
      manualSections,
      manualTags,
      visibleSections,
      visibleGlossary,
      helpCount,
      glossaryMatches,
      rich,
      aiChat,
      expandAi,
      toggleAi,
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
      doAutoLayout,
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
        <button class="icon-btn" :title="$t('top.autoLayout')" @click="doAutoLayout">⌗</button>
        <button class="icon-btn danger-icon" :title="state.selectedIds.length ? $t('top.deleteSelectionTitle', { n: state.selectedIds.length }) : $t('top.deleteSelectionEmpty')" :disabled="!state.selectedIds.length" @click="deleteSelection">✕</button>
        <button v-if="state.mode === 'graph'" class="icon-btn danger-icon" :title="$t('top.deleteMaterialTitle')" :disabled="deletingMaterial" @click="deleteCurrentMaterial">⌫</button>
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
        <button class="icon-btn ai-btn" :title="$t('ai.title')" @click="toggleAi">✦</button>
        <button class="icon-btn" :title="$t('assets.title')" @click="showAssets = true">▦</button>
        <button class="icon-btn" :title="$t('trash.open')" @click="openTrash">🗑</button>
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
    <AiFloating v-if="!showAi && aiChat.floatingVisible" @expand="expandAi" />
    <AssetLibrary v-if="showAssets" @close="showAssets = false" @open-trash="openTrash" />

      <TrashDialog v-if="showTrash" @close="showTrash = false" @changed="onTrashChanged" />

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
              <div v-for="p in projects" :key="p.file" class="project-row">
                <button class="pr-open" @click="openProject(p.name)">
                  <span class="pr-name">{{ p.name }}</span>
                  <span class="pr-meta">{{ $t('projects.meta', { res: p.resolution, nodes: p.nodes }) }}</span>
                  <span class="pr-meta">{{ new Date(p.savedAt).toLocaleString() }}</span>
                </button>
                <span v-if="p.name === state.projectName || p.active" class="pr-active">{{ $t('projects.activeBadge') }}</span>
                <button v-if="p.name !== state.projectName && !p.active" class="pr-delete" :title="$t('projects.trashTitle')" @click="deleteProject(p.name)">🗑</button>
                <button v-else class="pr-delete" disabled :title="$t('projects.activeLocked')">🔒</button>
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <span class="hint">{{ $t('projects.tip') }}</span>
            <button class="btn" @click="showProjects = false">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>

      <div v-if="showHelp" class="modal-backdrop" @click.self="showHelp = false">
        <div class="modal wide manual-modal">
          <div class="modal-head">
            <div class="modal-title">{{ $t('help.title') }}</div>
            <div class="manual-tabs">
              <button class="manual-tab" :class="{ on: helpTab === 'manual' }" @click="helpTab = 'manual'">{{ $t('help.tabManual') }}</button>
              <button class="manual-tab" :class="{ on: helpTab === 'glossary' }" @click="helpTab = 'glossary'">{{ $t('help.tabGlossary') }}</button>
            </div>
            <button class="icon-btn" @click="showHelp = false">✕</button>
          </div>

          <div class="manual-toolbar">
            <input
              class="input manual-search"
              v-model="helpQuery"
              :placeholder="helpTab === 'manual' ? $t('help.search') : $t('help.searchGlossary')"
            />
            <select v-if="helpTab === 'glossary'" class="select manual-tag" v-model="helpTag">
              <option v-for="tg in manualTags" :key="tg.id" :value="tg.id">{{ tg.label[helpLang] }}</option>
            </select>
            <span class="hint small manual-count">{{ helpCount }}</span>
            <span class="hint small manual-docs">
              <a href="/README.zh-CN.md" target="_blank" rel="noopener">中文 README</a> ·
              <a href="/docs/zh/README.md" target="_blank" rel="noopener">中文文档</a> ·
              <a href="/docs/mcp.md" target="_blank" rel="noopener">English docs</a>
            </span>
          </div>

          <div class="manual-body" :class="{ 'manual-body-single': helpTab !== 'manual' }">
            <nav v-if="helpTab === 'manual'" class="manual-nav">
              <button
                v-for="s in manualSections"
                :key="s.id"
                class="manual-nav-item"
                :class="{ on: s.id === helpSection && !helpQuery.trim() }"
                @click="helpSection = s.id; helpQuery = ''"
              >
                {{ s.title[helpLang] }}
              </button>
            </nav>
            <div class="manual-pages">
              <template v-if="helpTab === 'manual'">
                <article v-for="s in visibleSections" :key="s.id" class="manual-page">
                  <h3 class="manual-h">{{ s.title[helpLang] }}</h3>
                  <template v-for="(b, bi) in s.blocks" :key="bi">
                    <p v-if="b.type === 'p'" class="manual-p" v-html="rich(b[helpLang])"></p>
                    <ul v-else-if="b.type === 'ul' || b.type === 'steps'" class="manual-ul" :class="{ 'manual-steps': b.type === 'steps' }">
                      <li v-for="(it, ii) in b[helpLang]" :key="ii" v-html="rich(it)"></li>
                    </ul>
                    <table v-else-if="b.type === 'table'" class="manual-table">
                      <thead>
                        <tr><th v-for="(h, hi) in b.head" :key="hi">{{ h[helpLang] }}</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(row, ri) in b.rows" :key="ri">
                          <td v-for="(cell, ci) in row" :key="ci" v-html="rich(cell[helpLang])"></td>
                        </tr>
                      </tbody>
                    </table>
                  </template>
                </article>
              </template>
              <template v-else>
                <article v-for="g in visibleGlossary" :key="g.id" class="gloss-item">
                  <div class="gloss-head">
                    <span class="gloss-term">{{ g.term[helpLang] }}</span>
                    <span class="gloss-tag">{{ (manualTags.find(t => t.id === g.tag) || {}).label?.[helpLang] || g.tag }}</span>
                  </div>
                  <p class="manual-p" v-html="rich(g.desc[helpLang])"></p>
                  <p class="manual-p gloss-app"><strong>{{ $t('help.appliesHere') }}</strong> <span v-html="rich(g.app[helpLang])"></span></p>
                </article>
              </template>
              <div v-if="helpTab === 'manual' ? !visibleSections.length : !visibleGlossary.length" class="hint manual-empty">
                {{ $t('help.noResult') }}
              </div>
              <button
                v-if="helpTab === 'manual' && helpQuery.trim() && glossaryMatches"
                class="btn manual-jump"
                @click="helpTab = 'glossary'; helpTag = 'all'"
              >
                {{ $t('help.glossaryHint', { n: glossaryMatches }) }}
              </button>
            </div>
          </div>

          <div v-if="mcpCheck" class="manual-selfcheck selfcheck-box" :class="mcpCheck.ok ? 'ok' : 'bad'">
            <div>{{ mcpCheck.ok ? $t('ai.selfcheckPass') : $t('ai.selfcheckFail') }} · {{ mcpCheck.totals.passed }}/{{ mcpCheck.totals.passed + mcpCheck.totals.failed }}</div>
            <div v-for="c in mcpCheck.checks.filter(c => !c.ok).slice(0, 6)" :key="c.name" class="hint small">✕ {{ c.name }} {{ c.info }}</div>
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
