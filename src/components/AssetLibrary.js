import { defineComponent, ref, onMounted } from 'vue'
import { state, nodeById, addNode, setNodeImage, commitStroke } from '../engine/store.js'
import { loadPattern } from '../engine/paint.js'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'AssetLibrary',
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
        setNodeImage(node.id, dataUrl, asset.name)
        status.value = '✓ 已应用到贴图输入节点「' + asset.name + '」'
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
        status.value = '✓ 已把「' + asset.name + '」填入绘制层'
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        busy.value = false
      }
    }

    async function removeAsset(asset) {
      busy.value = true
      try {
        const res = await fetch('/api/assets/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: asset.id })
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error?.message || 'delete failed')
        status.value = '✓ 已删除「' + asset.name + '」'
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
    function quoteUrl(asset) {
      const url = location.origin + asset.url
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => (status.value = '✓ 已复制 ' + url), () => {})
    }

    onMounted(load)

    return {
      assets,
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
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp,.sbsar" multiple style="display: none" @change="onFile" />
          <input ref="sbsarInput" type="file" accept=".sbsar" multiple style="display: none" @change="onSbsarFile" />
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="hint">{{ $t('assets.hint') }}</div>
          <div class="hint small sbsar-hint">{{ $t('assets.sbsarHint') }}</div>
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
                  <div v-if="(a.inspection?.warnings || []).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarWarnings') }}</div>
                    <div v-for="(w, i) in a.inspection.warnings" :key="i" class="sbsar-warn">{{ w }}</div>
                  </div>
                  <div v-if="childAssets(a).length" class="sbsar-block">
                    <div class="sbsar-label">{{ $t('assets.sbsarExtracted') }}</div>
                    <div class="sbsar-thumbs">
                      <div v-for="c in childAssets(a)" :key="c.id" class="sbsar-thumb">
                        <img :src="c.url" :alt="c.name" loading="lazy" />
                        <div class="dim small">{{ c.width }}×{{ c.height }} · {{ Math.round(c.bytes / 1024) }} KB</div>
                        <button class="btn tiny" @click="useAsTexture(c)">{{ $t('assets.useTexture') }}</button>
                      </div>
                    </div>
                  </div>
                  <div class="asset-actions">
                    <a class="btn tiny" :href="a.inspectionUrl" target="_blank" rel="noopener">{{ $t('assets.sbsarJson') }}</a>
                    <button class="btn tiny danger" @click="removeAsset(a)">✕</button>
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
                  <div class="asset-actions">
                    <button class="btn tiny" @click="useAsTexture(a)">{{ $t('assets.useTexture') }}</button>
                    <button class="btn tiny" @click="useInPaint(a)">{{ $t('assets.usePaint') }}</button>
                    <button class="btn tiny" @click="quoteUrl(a)">{{ $t('assets.copyUrl') }}</button>
                    <button class="btn tiny danger" @click="removeAsset(a)">✕</button>
                  </div>
                </div>
              </template>
            </div>
          </div>
          <div v-if="status" class="asset-status">{{ status }}</div>
        </div>
        <div class="modal-foot">
          <span class="hint">{{ $t('assets.foot') }}</span>
          <button class="btn" @click="close">{{ $t('common.close') }}</button>
        </div>
      </div>
    </div>
  `
})
