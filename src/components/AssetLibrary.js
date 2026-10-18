import { defineComponent, ref, onMounted } from 'vue'
import { state, nodeById, addNode, setNodeImage, commitStroke } from '../engine/store.js'
import { loadPattern } from '../engine/paint.js'

export default defineComponent({
  name: 'AssetLibrary',
  emits: ['close'],
  setup(_props, { emit }) {
    const assets = ref([])
    const status = ref('')
    const loading = ref(true)
    const fileInput = ref(null)
    const busy = ref(false)

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
    async function onFile(event) {
      const files = [...(event.target?.files || [])]
      event.target.value = ''
      if (!files.length) return
      busy.value = true
      try {
        for (const file of files) {
          if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('PNG/JPEG/WebP only')
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
        }
        status.value = '✓ 已导入 ' + files.length + ' 个素材'
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
      fileInput,
      openPicker,
      onFile,
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
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple style="display: none" @change="onFile" />
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="hint">{{ $t('assets.hint') }}</div>
          <div v-if="loading" class="hint">{{ $t('common.loading') }}</div>
          <div v-else-if="!assets.length" class="asset-empty">
            <div>{{ $t('assets.empty') }}</div>
            <button class="btn" @click="openPicker">{{ $t('assets.importFirst') }}</button>
          </div>
          <div v-else class="asset-library">
            <div v-for="a in assets" :key="a.id" class="asset-card">
              <img :src="a.url" :alt="a.name" loading="lazy" />
              <div class="asset-card-body">
                <div class="asset-name" :title="a.name">{{ a.name }}</div>
                <div class="dim small">{{ Math.round(a.bytes / 1024) }} KB<span v-if="a.width"> · {{ a.width }}×{{ a.height }}</span></div>
                <div class="asset-actions">
                  <button class="btn tiny" @click="useAsTexture(a)">{{ $t('assets.useTexture') }}</button>
                  <button class="btn tiny" @click="useInPaint(a)">{{ $t('assets.usePaint') }}</button>
                  <button class="btn tiny" @click="quoteUrl(a)">{{ $t('assets.copyUrl') }}</button>
                  <button class="btn tiny danger" @click="removeAsset(a)">✕</button>
                </div>
              </div>
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
