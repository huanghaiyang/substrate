import { defineComponent, ref, watch, onMounted, computed } from 'vue'
import { state, outputNode } from '../engine/store.js'
import { previewStore } from '../engine/preview.js'
import { OUTPUT_CHANNELS } from '../engine/nodes/index.js'

export default defineComponent({
  name: 'MapPanel',
  setup() {
    const items = ref([])
    const zoom = ref(null)

    function makeDataURL(key) {
      const m = previewStore.maps && previewStore.maps[key]
      if (!m) return null
      const canvas = document.createElement('canvas')
      canvas.width = m.width
      canvas.height = m.height
      const ctx = canvas.getContext('2d')
      const img = ctx.createImageData(m.width, m.height)
      const row = m.width * 4
      const src = m.data
      for (let y = 0; y < m.height; y++) {
        const srcRow = (m.height - 1 - y) * row
        img.data.set(src.subarray(srcRow, srcRow + row), y * row)
      }
      ctx.putImageData(img, 0, 0)
      return canvas.toDataURL('image/png')
    }

    function rebuild() {
      items.value = OUTPUT_CHANNELS.map((ch) => ({
        key: ch.key,
        label: ch.label,
        space: ch.srgb ? 'sRGB' : 'Linear',
        single: !!ch.single,
        url: makeDataURL(ch.key),
        note:
          ch.key === 'normal'
            ? Number(outputNode()?.params?.normalConvention || 0) === 1
              ? 'DirectX'
              : 'OpenGL'
            : ''
      })).filter((i) => i.url)
    }

    watch(() => state.previewVersion, rebuild, { flush: 'post' })
    onMounted(rebuild)

    const meta = computed(() => {
      const out = outputNode()
      return {
        name: out?.params?.materialName || '—',
        resolution: state.resolution,
        nodes: state.graph.nodes.length
      }
    })

    return { items, zoom, meta }
  },
  template: `
    <div class="maps panel">
      <div class="panel-head">
        <span>Channels</span>
        <span class="dim">click a map to inspect</span>
      </div>
      <div class="maps-meta">
        <span class="chip">{{ meta.name }}</span>
        <span class="chip">{{ meta.resolution }}²</span>
        <span class="chip">{{ meta.nodes }} nodes</span>
        <span class="chip">seamless</span>
      </div>
      <div class="maps-grid">
        <button v-for="item in items" :key="item.key" class="map-card" @click="zoom = item">
          <span class="map-thumb" :style="{ backgroundImage: 'url(' + item.url + ')' }"></span>
          <span class="map-label">{{ item.label }}</span>
          <span class="map-sub">{{ item.space }} · {{ item.single ? 'grey' : 'RGB' }}{{ item.note ? ' · ' + item.note : '' }}</span>
        </button>
      </div>
      <div v-if="zoom" class="map-zoom" @click="zoom = null">
        <div class="zoom-caption">{{ zoom.label }} — {{ zoom.space }}</div>
        <img :src="zoom.url" :alt="zoom.label" />
        <button class="zoom-close" @click.stop="zoom = null">×</button>
      </div>
    </div>
  `
})
