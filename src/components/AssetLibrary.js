import { defineComponent, ref, onMounted, computed } from 'vue'
import { state, nodeById, addNode, setNodeImage, commitStroke, addConnection, disconnectInput, setParam, outputNode, requestEval, graphJSON, loadGraph } from '../engine/store.js'
import { analyzePreview, buildReconstructionProject } from '../engine/reconstruct.js'
import { loadPattern } from '../engine/paint.js'
import { t } from '../i18n/index.js'
import JsonViewer from './JsonViewer.js'

export default defineComponent({
  name: 'AssetLibrary',
  components: { JsonViewer },
  emits: ['close'],
  setup(_props, { emit }) {
    const assets = ref([])
    const status = ref('')
    const loading = ref(true)
    const fileInput = ref(null)
    const busy = ref(false)
    const searchQuery = ref('')
    const searching = ref(false)
    const searchResults = ref([])
    const searchError = ref('')
    const searchWarning = ref('')
    const sbsarInput = ref(null)
    const expanded = ref('')
    const pbrInput = ref(null)     // hidden file input for a PBR map set
    const reconstructing = ref(false)
    const baking = ref(false)
    const bake = ref({ loading: true, available: false, reason: '', installUrl: '' })
    const jsonTarget = ref(null)   // sbsar asset whose inspection report is open in the JSON viewer
    const lightbox = ref(null)     // { url, name, width, height, bytes } previewed image
    const PBR_CHANNELS = [
      // order matters: first match wins
      { port: 'basecolor', mode: 0, re: /(base ?colou?r|albedo|diffuse|_diff|_bc\b|^colou?r)/i },
      { port: 'normal', mode: 3, re: /(normal|_nor\b|_nrm\b|_n\b|norm)/i },
      { port: 'roughness', mode: 3, re: /(rough|_r\b|rgh)/i },
      { port: 'metallic', mode: 3, re: /(metal|_m\b|mtl)/i },
      { port: 'height', mode: 3, re: /(height|displac|_disp|_h\b|elev)/i },
      { port: 'ao', mode: 3, re: /(occlusion|ambient|_ao\b|\bao_|_ao)/i },
      { port: 'emissive', mode: 0, re: /(emiss|glow)/i },
      { port: 'opacity', mode: 3, re: /(opacity|alpha|_mask\b)/i }
    ]
    /** which PBR channel a file name refers to (null = unknown) */
    const detectChannel = (name) => {
      const base = String(name || '').replace(/\.[a-z0-9]+$/i, '')
      for (const c of PBR_CHANNELS) if (c.re.test(base)) return c
      return null
    }
    const openPbrPicker = () => pbrInput.value?.click()

    /** wire already-imported maps into the PBR Output: entries = [{ name, dataUrl, channel? }] */
    async function applyMapEntries(entries) {
      const out = outputNode()
      if (!out) throw new Error(t('assets.pbrNoOutput'))
      const found = new Map()
      const skipped = []
      for (const entry of entries) {
        const ch = entry.channel ? PBR_CHANNELS.find((c) => c.port === entry.channel) : detectChannel(entry.name)
        if (!ch) {
          skipped.push(entry.name)
          continue
        }
        if (found.has(ch.port)) {
          skipped.push(entry.name)
          continue
        }
        found.set(ch.port, { ch, entry })
      }
      let row = 0
      for (const [port, { ch, entry }] of found) {
        const node = addNode('image_input', { x: out.x - 640, y: out.y - 320 + row * 190 })
        row++
        if (!node) continue
        setParam(node.id, 'channelMode', ch.mode)
        setNodeImage(node.id, entry.dataUrl, entry.name)
        disconnectInput(out.id, port)
        addConnection(node.id, 'out', out.id, port)
      }
      requestEval(true)
      await load()
      return { channels: [...found.keys()], skipped }
    }

    const blobToDataUrl = (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(blob)
      })

    async function refreshBakeStatus() {
      try {
        const r = await fetch('/api/sbsar/bake/status')
        const j = await r.json()
        bake.value = { loading: false, available: !!j.available, reason: j.reason || '', installUrl: j.installUrl || '', sbsrender: j.sbsrender || null }
      } catch (e) {
        bake.value = { loading: false, available: false, reason: String(e.message || e), installUrl: '' }
      }
    }

    /**
     * Bake through the *local* Adobe engine (SAT sbsrender) and wire the results. The engine is native
     * and per-user licensed, so it cannot ship as WebAssembly: the browser asks the local studio server
     * to run it. Without SAT the button explains what to install instead of pretending.
     */
    async function bakeInApp(asset) {
      if (baking.value) return
      baking.value = true
      try {
        status.value = t('assets.baking')
        const r = await fetch('/api/sbsar/bake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: asset.id, res: Math.min(2048, state.resolution || 1024) })
        })
        const j = await r.json()
        if (!j.ok) throw new Error(j.error?.message || 'bake failed')
        const entries = []
        for (const a of j.assets || []) {
          const blob = await (await fetch(a.url)).blob()
          entries.push({ name: a.name, dataUrl: await blobToDataUrl(blob), channel: a.channel || undefined })
        }
        const wired = await applyMapEntries(entries)
        status.value = t('assets.bakeDone', { n: wired.channels.length, channels: wired.channels.join(', ') })
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        baking.value = false
      }
    }

    /**
     * Import a baked PBR map set (basecolor/normal/roughness/…), register every file as an asset and
     * wire one Texture Input per channel into the PBR Output. This is the practical end of the
     * ".sbsar → real PBR" pipeline: the maps have to be baked by Adobe's engine first.
     */
    async function onPbrSet(event) {
      const files = [...(event.target?.files || [])]
      event.target.value = ''
      if (!files.length) return
      busy.value = true
      try {
        const entries = []
        for (const file of files) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.onerror = () => reject(new Error('read failed'))
            reader.readAsDataURL(file)
          })
          const res = await fetch('/api/assets/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, dataUrl })
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error?.message || 'import failed')
          entries.push({ name: file.name, dataUrl })
        }
        const wired = await applyMapEntries(entries)
        const missing = PBR_CHANNELS.map((c) => c.port).filter((p) => !wired.channels.includes(p) && !['emissive', 'opacity'].includes(p))
        status.value =
          t('assets.pbrImported', { n: wired.channels.length, channels: wired.channels.join(', ') }) +
          (missing.length ? ' · ' + t('assets.pbrMissing', { channels: missing.join(', ') }) : '') +
          (wired.skipped.length ? ' · ' + t('assets.pbrUnknownCount', { n: wired.skipped.length }) : '')
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    const openJson = (asset) => (jsonTarget.value = asset)

    /**
     * Approximate reconstruction: a .sbsar has no node graph to port (it is compiled into .sbsasm),
     * so we measure its embedded preview render and build a tileable procedural material that
     * reproduces that look. The result is a new project, loaded immediately.
     */
    async function reconstruct(asset) {
      if (reconstructing.value) return
      reconstructing.value = true
      try {
        const children = childAssets(asset)
        const preview = children.find((c) => c.role === 'substance-preview') || children.find((c) => c.width && c.height) || children[0]
        if (!preview) throw new Error(t('assets.reconstructNoPreview'))
        const stats = await analyzePreview(preview.url)
        const ins = asset.inspection || {}
        const graph = (ins.graphs || [])[0] || {}
        const seed = parseInt(String(ins.sha256 || '1').slice(0, 8), 16) || 1
        const project = buildReconstructionProject({
          stats,
          seed,
          info: {
            label: graph.label || asset.name.replace(/\.sbsar$/i, ''),
            graphType: graph.graphType || null,
            parameterCount: ins.parameterCount || 0,
            groups: (ins.parameterGroups || []).map((g) => g.name),
            outputs: (ins.outputs || []).map((o) => o.usage),
            resolution: state.resolution || 1024
          }
        })
        // keep whatever the user was working on
        try {
          await fetch('/api/projects/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'autosave-before-reconstruct',
              version: 1,
              app: 'substrate-texture-designer',
              resolution: state.resolution,
              graph: JSON.parse(graphJSON())
            })
          })
        } catch (e) {
          /* best effort */
        }
        const saved = await fetch('/api/projects/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(project)
        })
        const payload = await saved.json()
        if (!payload.ok) throw new Error(payload.error?.message || 'save failed')
        loadGraph(project.graph, { name: project.name, resolution: project.resolution })
        status.value = t('assets.reconstructDone', {
          name: project.name,
          palette: [stats.dark, stats.mid || stats.meanColor, stats.light].join(' / '),
          coverage: Math.round(stats.coverage * 100)
        })
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        reconstructing.value = false
      }
    }
    const openLightbox = (img) => (lightbox.value = img)
    const closeLightbox = () => (lightbox.value = null)
    /** 资源类型标签：按扩展名给出可读种类（图片/描述符/程序集/其他） */
    const entryKind = (name) => {
      const n = String(name || '').toLowerCase()
      if (/\.(png|jpe?g|webp)$/.test(n)) return 'image'
      if (n.endsWith('.xml')) return 'descriptor'
      if (n.endsWith('.sbsasm')) return 'assembly'
      if (n.endsWith('.json')) return 'json'
      return 'other'
    }
    const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
    /** 接口图布局：参数分组 → 图 → 输出通道（节点拓扑在 .sbsasm 里，不可还原） */
    const interfaceLayout = (a) => {
      const ins = a.inspection || {}
      let groupList
      if (ins.parameterGroups && ins.parameterGroups.length) {
        // server-side histogram over all parameters (the inline list is truncated)
        groupList = ins.parameterGroups.slice(0, 14).map((g) => ({ name: g.name, count: g.count }))
      } else {
        const groups = new Map()
        for (const p of ins.parameters || []) {
          const g = p.group || '·'
          groups.set(g, (groups.get(g) || 0) + 1)
        }
        groupList = [...groups.entries()].slice(0, 14).map(([name, count]) => ({ name, count }))
      }
      const outs = (ins.outputs || []).map((o) => o.usage)
      return { groupList, outs }
    }

    async function searchOnline() {
      const q = String(searchQuery.value || '').trim()
      if (!q) return
      searching.value = true
      searchError.value = ''
      searchResults.value = []
      searchWarning.value = ''
      try {
        const res = await fetch('/api/assets/search?q=' + encodeURIComponent(q) + '&limit=12')
        const data = await res.json()
        if (!data?.ok) {
          throw new Error(t('assets.searchUnavailable'))
        }
        searchResults.value = data.results || []
        if (data.fallback) searchWarning.value = t('assets.searchFallback')
        if (!searchResults.value.length) searchError.value = t('assets.noResults')
      } catch (e) {
        searchError.value = String(e.message || e)
      } finally {
        searching.value = false
      }
    }
    async function importSearchResult(result) {
      if (!result?.downloadUrl) return
      busy.value = true
      try {
        const res = await fetch('/api/assets/import-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: result.downloadUrl,
            name: result.title || 'Online asset',
            provider: result.provider,
            creator: result.creator,
            license: result.license,
            licenseUrl: result.licenseUrl,
            sourceUrl: result.sourceUrl
          })
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error?.message || 'import failed')
        status.value = t('assets.importedOnline', { name: data.asset.name })
        await load()
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    async function load() {
      loading.value = true
      try {
        const res = await fetch('/api/assets')
        const data = await res.json()
        assets.value = data.assets || []
      } catch (e) {
        status.value = String(e.message || e)
      } finally {
        loading.value = false
        // auto-open a single archive so its interface map / contents are visible right away
        const archives = assets.value.filter((a) => a.kind === 'sbsar')
        if (!expanded.value && archives.length === 1) expanded.value = archives[0].id
      }
    }
    function openPicker() {
      fileInput.value?.click()
    }
    function openSbsarPicker() {
      sbsarInput.value?.click()
    }

    /** .sbsar import: metadata + embedded bitmaps (the graph itself needs Adobe's engine, see note) */
    async function importSbsarFile(file) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/assets/import-sbsar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, data })
      })
      const payload = await res.json().catch(() => ({}))
      if (!payload.ok) throw new Error(payload.error?.message || 'sbsar import failed')
      const ins = payload.inspection || {}
      expanded.value = payload.asset.id
      return `${file.name}: ${ins.container} · ${(ins.graphs || []).length} 图 · ${ins.parameterCount || 0} 参数 · ${ins.imageCount || 0} 图片`
    }

    async function onSbsarFile(event) {
      const files = [...(event.target?.files || [])]
      event.target.value = ''
      if (!files.length) return
      busy.value = true
      try {
        const done = []
        for (const file of files) done.push(await importSbsarFile(file))
        status.value = '✓ ' + done.join(' | ')
        await load()
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    const toggleExpand = (asset) => {
      expanded.value = expanded.value === asset.id ? '' : asset.id
    }
    const childAssets = (asset) => assets.value.filter((a) => a.parentId === asset.id)
    const fmtParam = (p) => {
      const bits = []
      // real sbsar: label/group/kind come from <inputgui> + widget; older/synthetic: raw type code
      if (p.kind && p.kind !== 'other') bits.push(p.kind)
      else if (p.type) bits.push('type ' + p.type)
      if (p.default !== null && p.default !== undefined && p.default !== '') bits.push('= ' + p.default)
      if (p.min !== null && p.min !== null && p.max !== null) bits.push(`[${p.min} … ${p.max}${p.step ? ' / ' + p.step : ''}]`)
      if (p.enumItems && p.enumItems.length) bits.push('{' + p.enumItems.slice(0, 4).join(' | ') + (p.enumItems.length > 4 ? ' | …' : '') + '}')
      return bits.join(' · ')
    }
    async function onFile(event) {
      const files = [...(event.target?.files || [])]
      event.target.value = ''
      if (!files.length) return
      busy.value = true
      try {
        const done = []
        for (const file of files) {
          if (/\.sbsar$/i.test(file.name)) {
            done.push(await importSbsarFile(file))
            continue
          }
          if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('PNG/JPEG/WebP/.sbsar only')
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result)
            reader.onerror = () => reject(new Error('read failed'))
            reader.readAsDataURL(file)
          })
          const res = await fetch('/api/assets/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, dataUrl })
          })
          const data = await res.json()
          if (!data.ok) throw new Error(data.error?.message || 'import failed')
          done.push(file.name)
        }
        status.value = '✓ 已导入 ' + done.length + ' 个素材'
        await load()
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    async function assetDataUrl(asset) {
      const res = await fetch(asset.url)
      const blob = await res.blob()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(blob)
      })
    }

    async function useAsTexture(asset) {
      busy.value = true
      try {
        const imageNodes = state.graph.nodes.filter((n) => n.type === 'image_input')
        let node = imageNodes.find((n) => n.id === state.activeNodeId) || imageNodes[0]
        if (!node) node = addNode('image_input', { x: 60, y: 60 })
        if (!node) throw new Error('无法创建贴图输入节点')
        const dataUrl = await assetDataUrl(asset)
        setNodeImage(node.id, dataUrl, asset.name, asset.id)
        if (asset.role === 'substance-preview') {
          status.value = t('assets.sbsarPreviewWarning')
        } else {
          status.value = t('assets.usedAsTexture', { name: asset.name })
        }
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    async function useInPaint(asset) {
      const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
      if (!paintNode) {
        status.value = '✕ 当前材质没有绘制图层'
        return
      }
      busy.value = true
      try {
        await loadPattern(asset.url)
        commitStroke(paintNode.id, { pattern: asset.url, patternScale: 1, opacity: 1 })
        paintNode.data.patternAssetId = asset.id
        status.value = '✓ 已把「' + asset.name + '」填入绘制层'
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    async function removeAsset(asset) {
      if (isAssetLocked(asset)) {
        status.value = t('assets.deleteBlocked', { list: usageLabel(assetUsage(asset)) })
        return
      }
      busy.value = true
      try {
        const res = await fetch('/api/assets/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: asset.id })
        })
        const data = await res.json()
        if (!data.ok) {
          if (data.error?.code === 'ASSET_IN_USE') {
            const list = (data.error.usage || []).map((u) => u.project).join('、')
            throw new Error(t('assets.deleteBlocked', { list: usageLabel(data.error.usage || []) }))
          }
          throw new Error(data.error?.message || 'delete failed')
        }
        status.value = t('assets.trashed', { name: asset.name }) + (data.children ? ' ' + t('assets.trashedChildren', { n: data.children }) : '')
        await load()
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    function onDrop(event) {
      event.preventDefault()
      const files = [...(event.dataTransfer?.files || [])]
      if (files.length) {
        const input = fileInput.value
        if (input) {
          const dt = new DataTransfer()
          for (const f of files) dt.items.add(f)
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }
    }
    /** assets referenced by the graph that is open right now (not saved yet, so the server cannot know) */
    const currentGraphAssetIds = computed(() => {
      const ids = new Set()
      for (const node of state.graph.nodes) {
        const d = node.data || {}
        if (typeof d.imageAssetId === 'string') ids.add(d.imageAssetId)
        if (typeof d.patternAssetId === 'string') ids.add(d.patternAssetId)
        for (const stroke of Array.isArray(d.strokes) ? d.strokes : []) {
          const m = /\/assets\/([0-9a-f]{8,16})\./.exec(String(stroke.pattern || ''))
          if (m) ids.add(m[1])
        }
      }
      return ids
    })
    const usedInCurrentGraph = (asset) => currentGraphAssetIds.value.has(asset.id)
    /** every material that references the asset: saved projects (from the API) + the open graph */
    const assetUsage = (asset) => {
      const list = (asset.usage || []).slice()
      if (usedInCurrentGraph(asset) && !list.some((u) => u.project === state.projectName)) {
        list.push({ project: state.projectName || 'current', nodeId: null, current: true })
      }
      return list
    }
    /** "name" for saved materials, "name（回收站）" for binned ones — bindings survive the bin */
    const usageLabel = (list) => list.map((u) => (u.trashed ? u.project + ' ' + t('assets.binSuffix') : u.project)).join('、')
    const isAssetLocked = (asset) => assetUsage(asset).length > 0
    const usageTitle = (asset) => {
      const list = assetUsage(asset)
      return list.length ? t('assets.inUse', { list: usageLabel(list) }) : t('assets.trashTitle')
    }

    function quoteUrl(asset) {
      const url = location.origin + asset.url
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => (status.value = '✓ 已复制 ' + url), () => {})
    }

    onMounted(() => {
      load()
      refreshBakeStatus()
    })

    return {
      assets,
      assetUsage,
      usageLabel,
      isAssetLocked,
      usageTitle,
      status,
      loading,
      busy,
      searchQuery,
      searching,
      searchResults,
      searchError,
      searchWarning,
      searchOnline,
      importSearchResult,
      fileInput,
      sbsarInput,
      openPicker,
      openSbsarPicker,
      onFile,
      onSbsarFile,
      expanded,
      jsonTarget,
      lightbox,
      pbrInput,
      reconstructing,
      reconstruct,
      baking,
      bake,
      bakeInApp,
      openPbrPicker,
      onPbrSet,
      openJson,
      openLightbox,
      closeLightbox,
      entryKind,
      fmtBytes,
      interfaceLayout,
      toggleExpand,
      childAssets,
      fmtParam,
      onDrop,
      useAsTexture,
      useInPaint,
      removeAsset,
      quoteUrl,
      close: () => emit('close')
    }
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal wide asset-modal" @dragover.prevent @drop.prevent="onDrop">
        <div class="modal-head">
          <div class="modal-title">{{ $t('assets.title') }}</div>
          <div class="spacer"></div>
          <button class="btn" @click="openPicker" :disabled="busy">{{ $t('assets.import') }}</button>
          <button class="btn" @click="openSbsarPicker" :disabled="busy" :title="$t('assets.sbsarTitle')">{{ $t('assets.importSbsar') }}</button>
          <button class="btn" @click="openPbrPicker" :disabled="busy" :title="$t('assets.pbrTitle')">{{ $t('assets.importPbr') }}</button>
          <input ref="pbrInput" type="file" accept="image/png,image/jpeg,image/webp" multiple style="display: none" @change="onPbrSet" />
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,.sbsar" multiple style="display: none" @change="onFile" />
          <input ref="sbsarInput" type="file" accept=".sbsar" multiple style="display: none" @change="onSbsarFile" />
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="hint">{{ $t('assets.hint') }}</div>
          <div class="hint small sbsar-hint">{{ $t('assets.sbsarHint') }}</div>
          <div class="hint small sbsar-hint">{{ $t('assets.pbrHint') }}</div>
          <div class="asset-search">
            <input v-model="searchQuery" :placeholder="$t('assets.searchPlaceholder')" @keydown.enter="searchOnline" />
            <button class="btn" :disabled="searching" @click="searchOnline">{{ searching ? $t('assets.searching') : $t('assets.searchOnline') }}</button>
          </div>
          <div v-if="searchError" class="asset-search-error">{{ searchError }}</div>
          <div v-if="searchWarning" class="asset-search-error">{{ searchWarning }}</div>
          <div v-if="searchResults.length" class="asset-search-results">
            <div v-for="r in searchResults" :key="r.id" class="asset-search-card">
              <img :src="r.thumbnail" :alt="r.title" loading="lazy" />
              <div class="asset-search-meta">
                <div class="asset-search-title" :title="r.title">{{ r.title }}</div>
                <div class="asset-attribution">{{ r.provider }} · {{ r.creator }} · {{ r.license }}</div>
                <button class="btn tiny" @click="importSearchResult(r)">{{ $t('assets.importResult') }}</button>
              </div>
            </div>
          </div>
          <div v-if="loading" class="hint">{{ $t('common.loading') }}</div>
          <div v-else-if="!assets.length" class="asset-empty">
            <div>{{ $t('assets.empty') }}</div>
            <button class="btn" @click="openPicker">{{ $t('assets.importFirst') }}</button>
          </div>
          <div v-else class="asset-library">
            <div v-for="a in assets" :key="a.id" class="asset-card" :class="{ 'asset-card-sbsar': a.kind === 'sbsar' }">
              <template v-if="a.kind === 'sbsar'">
                <div class="sbsar-head" @click="toggleExpand(a)">
                  <div class="sbsar-icon">SA</div>
                  <div class="sbsar-head-body">
                    <div class="asset-name" :title="a.name">{{ a.name }}</div>
                    <div class="sbsar-badges">
                      <span class="sbsar-badge">{{ a.inspection?.container || '?' }}</span>
                      <span class="sbsar-badge">{{ (a.inspection?.graphs || []).length }} {{ $t('assets.sbsarGraphs') }}</span>
                      <span class="sbsar-badge">{{ a.inspection?.parameterCount || 0 }} {{ $t('assets.sbsarParams') }}</span>
                      <span class="sbsar-badge">{{ a.inspection?.imageCount || 0 }} {{ $t('assets.sbsarImages') }}</span>
                      <span class="sbsar-badge warn">{{ $t('assets.sbsarNoBake') }}</span>
                    </div>
                  </div>
                  <button class="icon-btn" @click.stop="toggleExpand(a)">{{ expanded === a.id ? '▾' : '▸' }}</button>
                </div>
                <div v-if="expanded === a.id" class="sbsar-detail">
                  <div class="sbsar-note">{{ a.inspection?.evaluateBlockedReason }}</div>
                  <div v-for="(n, i) in (a.inspection?.notes || [])" :key="'note' + i" class="sbsar-note soft">{{ n }}</div>
                  <div v-if="a.inspection?.metadata && Object.keys(a.inspection.metadata).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarMetadata') }}</div>
                    <div v-for="(v, k) in a.inspection.metadata" :key="k" class="sbsar-row"><span>{{ k }}</span><b>{{ v }}</b></div>
                  </div>
                  <div v-if="(a.inspection?.graphs || []).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarGraphsTitle') }}</div>
                    <div v-for="g in a.inspection.graphs" :key="g.identifier" class="sbsar-row"><span>{{ g.identifier }}</span><b>{{ g.label }}</b></div>
                  </div>
                  <div v-if="(a.inspection?.outputs || []).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarOutputs') }}</div>
                    <div class="sbsar-chips"><span v-for="o in a.inspection.outputs" :key="o.usage" class="sbsar-chip">{{ o.usage }}</span></div>
                  </div>
                  <div class="sbsar-block">
                    <div class="sbsar-label">
                      {{ $t('assets.sbsarInterface') }}
                      <span class="hint small">{{ $t('assets.sbsarInterfaceNote') }}</span>
                    </div>
                    <svg class="sbsar-igraph" :viewBox="'0 0 460 ' + (interfaceLayout(a).groupList.length * 26 + 40)" preserveAspectRatio="xMidYMin meet">
                      <g v-for="(g, i) in interfaceLayout(a).groupList" :key="g.name">
                        <rect x="4" :y="8 + i * 26" width="150" height="20" rx="5" class="ig-node" />
                        <text x="12" :y="22 + i * 26" class="ig-text">{{ g.name.length > 20 ? g.name.slice(0, 20) + '…' : g.name }}</text>
                        <text x="146" :y="22 + i * 26" class="ig-count" text-anchor="end">{{ g.count }}</text>
                        <line x1="154" :y1="18 + i * 26" x2="300" :y2="(interfaceLayout(a).groupList.length * 26 + 18) / 2" class="ig-edge" />
                      </g>
                      <rect x="300" :y="(interfaceLayout(a).groupList.length * 26 + 40) / 2 - 20" width="150" height="40" rx="7" class="ig-graph" />
                      <text x="375" :y="(interfaceLayout(a).groupList.length * 26 + 40) / 2 + 4" class="ig-graph-text" text-anchor="middle">
                        {{ (a.inspection?.graphs?.[0]?.label || 'graph').slice(0, 22) }}
                      </text>
                      <g v-for="(o, i) in interfaceLayout(a).outs" :key="o">
                        <line x1="450" :y1="(interfaceLayout(a).groupList.length * 26 + 40) / 2" x2="452" :y2="(interfaceLayout(a).groupList.length * 26 + 40) / 2" class="ig-edge" />
                      </g>
                    </svg>
                    <div class="sbsar-chips sbsar-igraph-outs">
                      <span v-for="o in interfaceLayout(a).outs" :key="o" class="sbsar-chip">→ {{ o }}</span>
                    </div>
                  </div>
                  <div v-if="(a.inspection?.entries || []).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarContents') }}</div>
                    <div v-for="e in a.inspection.entries" :key="e.name" class="sbsar-row sbsar-entry">
                      <span class="sbsar-entry-kind" :class="'k-' + entryKind(e.name)">{{ $t('assets.sbsarKind.' + entryKind(e.name)) }}</span>
                      <span class="sbsar-entry-name" :title="e.name">{{ e.name.split('/').pop() }}</span>
                      <b>{{ e.size != null ? fmtBytes(e.size) : '—' }}</b>
                    </div>
                  </div>
                  <div v-if="(a.inspection?.parameters || []).length" class="sbsar-block">
                    <div class="sbsar-label">
                      {{ $t('assets.sbsarParamsTitle') }}
                      <span class="hint small">{{ $t('assets.sbsarReadOnly') }}</span>
                      <span v-if="a.inspection.parameterCount > a.inspection.parameters.length" class="hint small">
                        {{ $t('assets.sbsarParamsShown', { n: a.inspection.parameters.length, total: a.inspection.parameterCount }) }}
                      </span>
                    </div>
                    <div v-for="p in a.inspection.parameters" :key="p.id" class="sbsar-row">
                      <span>
                        {{ p.label !== p.id ? p.label + '  (' + p.id + ')' : p.id }}
                        <span v-if="p.group" class="sbsar-group">{{ p.group }}</span>
                      </span><b>{{ fmtParam(p) }}</b>
                    </div>
                  </div>
                  <div class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.bakeSection') }}</div>
                    <div v-if="bake.loading" class="hint small">{{ $t('common.loading') }}</div>
                    <div v-else-if="bake.available" class="sbsar-note soft">{{ $t('assets.bakeReady', { path: bake.sbsrender }) }}</div>
                    <div v-else class="sbsar-warn">
                      {{ $t('assets.bakeUnavailable') }}
                      <a :href="bake.installUrl" target="_blank" rel="noopener">{{ $t('assets.bakeInstall') }}</a>
                    </div>
                  </div>
                  <div v-if="(a.inspection?.warnings || []).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarWarnings') }}</div>
                    <div v-for="(w, i) in a.inspection.warnings" :key="i" class="sbsar-warn">{{ w }}</div>
                  </div>
                  <div v-if="childAssets(a).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarExtracted') }}</div>
                    <div class="sbsar-thumbs">
                      <div v-for="c in childAssets(a)" :key="c.id" class="sbsar-thumb">
                        <img :src="c.url" :alt="c.name" loading="lazy" class="sbsar-zoomable" @click="openLightbox({ url: c.url, name: c.name, width: c.width, height: c.height, bytes: c.bytes })" />
                        <div class="sbsar-role" :class="{ warn: c.role === 'substance-preview' }">
                          {{ c.role === 'substance-preview' ? $t('assets.sbsarPreviewRole') : $t('assets.sbsarResourceRole') }}
                        </div>
                        <div class="dim small">{{ c.width }}×{{ c.height }} · {{ fmtBytes(c.bytes) }}</div>
                        <div class="asset-actions">
                          <button class="btn tiny" @click="useAsTexture(c)">{{ $t('assets.useTexture') }}</button>
                          <button class="btn tiny" @click="useInPaint(c)">{{ $t('assets.usePaint') }}</button>
                          <button class="btn tiny" @click="openLightbox({ url: c.url, name: c.name, width: c.width, height: c.height, bytes: c.bytes })">⤢</button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="assetUsage(a).length" class="asset-usage">🔒 {{ $t('assets.usedBy', { list: usageLabel(assetUsage(a)) }) }}</div>
                  <div class="asset-actions">
                    <button class="btn tiny accent" :disabled="reconstructing" @click="reconstruct(a)" :title="$t('assets.reconstructTitle')">{{ reconstructing ? $t('assets.reconstructing') : $t('assets.reconstruct') }}</button>
                    <button class="btn tiny" :disabled="baking || bake.loading || !bake.available" @click="bakeInApp(a)" :title="bake.available ? $t('assets.bakeTitle', { path: bake.sbsrender }) : bake.reason">
                      {{ baking ? $t('assets.baking') : $t('assets.bake') }}
                    </button>
                    <button class="btn tiny" @click="openJson(a)">{{ $t('assets.sbsarJson') }}</button>
                    <a class="btn tiny" :href="a.inspectionUrl" target="_blank" rel="noopener">{{ $t('assets.sbsarJsonRaw') }}</a>
                    <button class="btn tiny danger" :disabled="isAssetLocked(a)" :title="usageTitle(a)" @click="removeAsset(a)">{{ isAssetLocked(a) ? '🔒' : '🗑' }}</button>
                  </div>
                </div>
              </template>
              <template v-else>
                <img :src="a.url" :alt="a.name" loading="lazy" />
                <div class="asset-card-body">
                  <div class="asset-name" :title="a.name">{{ a.name }}</div>
                  <div class="dim small">{{ Math.round(a.bytes / 1024) }} KB<span v-if="a.width"> · {{ a.width }}×{{ a.height }}</span></div>
                  <div v-if="a.role && a.role.indexOf('substance') === 0" class="dim small">{{ $t('assets.sbsarChild') }}</div>
                  <div v-if="a.attribution" class="asset-attribution">{{ a.attribution.provider }} · {{ a.attribution.creator }} · {{ a.attribution.license }}</div>
                  <div v-if="assetUsage(a).length" class="asset-usage">🔒 {{ $t('assets.usedBy', { list: usageLabel(assetUsage(a)) }) }}</div>
                  <div class="asset-actions">
                    <button class="btn tiny" @click="useAsTexture(a)">{{ $t('assets.useTexture') }}</button>
                    <button class="btn tiny" @click="useInPaint(a)">{{ $t('assets.usePaint') }}</button>
                    <button class="btn tiny" @click="quoteUrl(a)">{{ $t('assets.copyUrl') }}</button>
                    <button class="btn tiny danger" :disabled="isAssetLocked(a)" :title="usageTitle(a)" @click="removeAsset(a)">{{ isAssetLocked(a) ? '🔒' : '🗑' }}</button>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div v-if="status" class="asset-status">{{ status }}</div>
        </div>
        <div class="modal-foot">
          <span class="hint">{{ $t('assets.foot') }}</span>
          <div style="display: flex; gap: 8px">
            <button class="btn tiny" @click="$emit('open-trash')">🗑 {{ $t('trash.open') }}</button>
            <button class="btn" @click="close">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>

      <JsonViewer v-if="jsonTarget" :url="jsonTarget.inspectionUrl" :title="jsonTarget.name" @close="jsonTarget = null" />

      <div v-if="lightbox" class="modal-backdrop lightbox-backdrop" @click.self="closeLightbox">
        <div class="lightbox">
          <div class="lightbox-head">
            <div class="modal-title">{{ lightbox.name }}</div>
            <div class="spacer"></div>
            <span class="hint small">{{ lightbox.width }}×{{ lightbox.height }} · {{ fmtBytes(lightbox.bytes || 0) }}</span>
            <button class="icon-btn" @click="closeLightbox">✕</button>
          </div>
          <img :src="lightbox.url" :alt="lightbox.name" class="lightbox-img" />
          <div class="modal-foot">
            <span class="hint">{{ $t('assets.sbsarLightboxFoot') }}</span>
            <div style="display: flex; gap: 8px">
              <a class="btn" :href="lightbox.url" target="_blank" rel="noopener">{{ $t('assets.sbsarOpenOriginal') }}</a>
              <button class="btn" @click="closeLightbox">{{ $t('common.close') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
