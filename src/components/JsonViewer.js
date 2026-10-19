// Modal that pretty-prints an arbitrary JSON document using the vendored third-party viewer
// (json-formatter-js 2.3.4, MIT — loaded as UMD from /vendor/json-formatter.umd.js).
//
// Used by the material library for a .sbsar archive's inspection report, where the raw endpoint
// would otherwise just show unstyled JSON text in a browser tab.
import { defineComponent, onMounted, ref, computed, nextTick } from 'vue'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'JsonViewer',
  props: {
    url: { type: String, required: true },
    title: { type: String, default: '' }
  },
  emits: ['close'],
  setup(props, { emit }) {
    const host = ref(null)
    const data = ref(null)
    const error = ref('')
    const raw = ref('')
    const showRaw = ref(false)
    const depth = ref(2)
    const loading = ref(true)

    const formatter = () => {
      const lib = globalThis.JSONFormatter
      if (!lib) throw new Error(t('json.libMissing'))
      return lib
    }

    const render = () => {
      const el = host.value
      if (!el || data.value == null) return
      el.innerHTML = ''
      try {
        const F = formatter()
        const node = new F(data.value, depth.value, {
          theme: 'dark',
          hoverPreviewEnabled: true,
          hoverPreviewArrayCount: 8,
          hoverPreviewFieldCount: 6,
          animateOpen: true,
          animateClose: true,
          useToJSON: false,
          maxDepth: depth.value > 1 ? depth.value + 6 : 999,
          transitionDuration: 0.15
        }).render()
        el.appendChild(node)
        if (!el.querySelector('.json-formatter-row')) throw new Error(t('json.libMissing'))
      } catch (e) {
        error.value = String(e.message || e)
      }
    }

    async function copy() {
      try {
        await navigator.clipboard.writeText(raw.value)
        error.value = ''
      } catch (e) {
        /* clipboard may be unavailable */
      }
    }
    function download() {
      const blob = new Blob([raw.value], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = (props.title || 'inspection') + '.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    }
    const setDepth = async (d) => {
      depth.value = d
      showRaw.value = false
      await nextTick()
      render()
    }

    onMounted(async () => {
      try {
        const res = await fetch(props.url)
        const json = await res.json()
        if (!json.ok) throw new Error(json.error?.message || 'request failed')
        const payload = json.inspection ?? json
        data.value = payload
        raw.value = JSON.stringify(payload, null, 2)
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        loading.value = false
      }
      // the host element only exists once loading=false has been rendered
      await nextTick()
      render()
    })

    return { host, error, raw, showRaw, depth, setDepth, copy, download, loading, titleText: computed(() => props.title || t('json.title')), close: () => emit('close') }
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal wide json-modal">
        <div class="modal-head">
          <div class="modal-title">{{ titleText }}</div>
          <div class="spacer"></div>
          <button class="btn tiny" :class="{ on: depth === 1 }" @click="setDepth(1)">{{ $t('json.depth1') }}</button>
          <button class="btn tiny" :class="{ on: depth === 2 }" @click="setDepth(2)">{{ $t('json.depth2') }}</button>
          <button class="btn tiny" :class="{ on: depth === 99 }" @click="setDepth(99)">{{ $t('json.expandAll') }}</button>
          <button class="btn tiny" @click="showRaw = !showRaw">{{ showRaw ? $t('json.pretty') : $t('json.raw') }}</button>
          <button class="btn tiny" @click="copy">{{ $t('json.copy') }}</button>
          <button class="btn tiny" @click="download">{{ $t('json.download') }}</button>
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body json-body">
          <div v-if="loading" class="hint">{{ $t('common.loading') }}</div>
          <div v-else-if="error" class="json-error">{{ error }}</div>
          <pre v-else-if="showRaw" class="json-raw">{{ raw }}</pre>
          <div v-else ref="host" class="json-host"></div>
        </div>
        <div class="modal-foot">
          <span class="hint">{{ $t('json.foot') }}</span>
          <button class="btn" @click="close">{{ $t('common.close') }}</button>
        </div>
      </div>
    </div>
  `
})
