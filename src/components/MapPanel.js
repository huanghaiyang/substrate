// ============================================================================
// MapPanel —— 2D 贴图通道面板（「Maps」视图）
//
// 界面位置：主界面中可切换的 2D 输出页签。把引擎烘焙出的各个 PBR 通道（basecolor / normal /
// roughness / metallic / height / ao / emissive / opacity）以缩略图卡片的形式平铺展示，
// 点击任一张可打开放大预览。
//
// 与 engine 的交互：state（图、分辨率、showMaps 开关）来自 engine/store.js；
// previewStore.maps 是 engine/preview.js 维护的 Uint8 像素缓冲，这里把它转成 PNG dataURL 显示。
//
// 缩略图固定用 384²（每次求值都要重建全部通道，尺寸必须小）；点击放大时再按需向引擎回读
// 「单个通道」的全分辨率数据（上限 4096²，并受 GPU 纹理上限与当前求值分辨率约束），
// 这样既能看清细节，又不会让每次拖动滑杆都付出几百兆的回读开销。
// 注意：像素缓冲是「上下翻转」的（WebGL 习惯），重建图片时需要按行倒序拷贝。
// ============================================================================
import { defineComponent, ref, watch, onMounted, computed } from 'vue'
import { state, outputNode } from '../engine/store.js'
import { previewStore } from '../engine/preview.js'
import { OUTPUT_CHANNELS } from '../engine/nodes/index.js'

export default defineComponent({
  name: 'MapPanel',
  setup() {
    /** 当前可展示的通道卡片列表（每项含 key/label/url/色彩空间等） */
    const items = ref([])
    /** 点击缩略图后放大预览的通道对象；null 表示未打开大图 */
    const zoom = ref(null)

    /**
     * 打开放大预览：先立即显示 384² 缩略图，再异步回读该通道的全分辨率数据。
     *
     * 全分辨率尺寸取「实际求值分辨率」= state.resolution × state.proxy
     * （doEval 就是按这个尺寸烘焙的，超过它只是把低分辨率纹理放大，没有意义），
     * 再夹在 64 ~ min(4096, GPU 最大纹理尺寸) 之间。
     * 4096² 的回读 + PNG 编码是同步重活，所以先让遮罩渲染一帧再执行，避免点击后界面像卡死。
     *
     * @param {{key:string,label:string,srgb:boolean,single:boolean,url:string}} item 通道卡片
     * @returns {Promise<void>}
     */
    async function openZoom(item) {
      // 先展示缩略图，size 用于遮罩标题上的分辨率标记
      zoom.value = { ...item, size: 384, full: false }
      const engine = state.engine
      if (!engine) return
      const size = Math.min(
        4096,
        engine.ext?.maxTexture || 4096,
        Math.max(64, Math.round((state.resolution || 1024) * (state.proxy || 1)))
      )
      const key = item.key
      try {
        // 让浏览器先绘制放大遮罩，再执行阻塞式回读与编码
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const url = engine.mapDataURL(key, size, { srgb: item.srgb })
        // 期间用户可能已关闭遮罩或点了别的通道，只有仍停在同一通道时才替换
        if (url && zoom.value && zoom.value.key === key) {
          zoom.value = { ...item, url, size, full: true }
        }
      } catch (e) {
        // 回读失败（显存不足等）时保留缩略图，不让整个面板报错
        console.warn('[maps] full-resolution preview failed', e)
      }
    }

    /**
     * 把某个通道的像素缓冲编码成 PNG dataURL，供 <img>/CSS 背景使用。
     * @param {string} key previewStore.maps 中的通道键名（如 'normal'）
     * @returns {string|null} png dataURL；该通道不存在时返回 null
     */
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
      // 逐行倒序拷贝：引擎的缓冲原点在左下角，而 canvas 的 ImageData 原点在左上角
      for (let y = 0; y < m.height; y++) {
        const srcRow = (m.height - 1 - y) * row
        img.data.set(src.subarray(srcRow, srcRow + row), y * row)
      }
      ctx.putImageData(img, 0, 0)
      return canvas.toDataURL('image/png')
    }

    /**
     * 重建整份通道列表：只为有像素数据的通道生成卡片，normal 通道还会标注 OpenGL/DirectX 约定。
     * @returns {void}
     */
    function rebuild() {
      items.value = OUTPUT_CHANNELS.map((ch) => ({
        key: ch.key,
        label: ch.label,
        srgb: !!ch.srgb,
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

    // 只在面板可见时重建（转 PNG 较昂贵）：
    // 1) 每次烘焙版本变化时，如果当前正显示 Maps 页签就立即刷新；
    // 2) 用户切到 Maps 页签时再重建一次，保证数据一定是最新的。
    // flush: 'post' 让回调在 DOM 更新之后执行。
    watch(
      () => state.previewVersion,
      () => {
        if (state.showMaps) rebuild()
      },
      { flush: 'post' }
    )
    watch(
      () => state.showMaps,
      (visible) => {
        if (visible) rebuild()
      }
    )
    onMounted(() => {
      if (state.showMaps) rebuild()
    })

    /** 面板头部的摘要信息：材质名、分辨率、节点数 */
    const meta = computed(() => {
      const out = outputNode()
      return {
        name: out?.params?.materialName || '—',
        resolution: state.resolution,
        nodes: state.graph.nodes.length
      }
    })

    return { items, zoom, meta, openZoom }
  },
  template: `
    <div class="maps panel">
      <!-- 面板头：标题与说明 -->
      <div class="panel-head">
        <span>{{ $t('maps.title') }}</span>
        <span class="dim">{{ $t('maps.hint') }}</span>
      </div>
      <!-- 摘要条：材质名 / 分辨率 / 节点数 / 无缝标记 -->
      <div class="maps-meta">
        <span class="chip">{{ $tr(meta.name) }}</span>
        <span class="chip">{{ meta.resolution }}²</span>
        <span class="chip">{{ $t('maps.nodes', { n: meta.nodes }) }}</span>
        <span class="chip">{{ $t('maps.seamless') }}</span>
      </div>
      <!-- 通道卡片网格：点击卡片按需打开全分辨率放大预览 -->
      <div class="maps-grid">
        <button v-for="item in items" :key="item.key" class="map-card" @click="openZoom(item)">
          <span class="map-thumb" :style="{ backgroundImage: 'url(' + item.url + ')' }"></span>
          <span class="map-label">{{ $tr(item.label) }}</span>
          <span class="map-sub">{{ $t(item.srgb ? 'maps.space.srgb' : 'maps.space.linear') }} · {{ item.single ? $t('maps.grey') : 'RGB' }}{{ item.note ? ' · ' + item.note : '' }}</span>
        </button>
      </div>
      <!-- 放大预览遮罩：点击遮罩或关闭按钮都置空 zoom；标题显示当前回读分辨率 -->
      <div v-if="zoom" class="map-zoom" @click="zoom = null">
        <div class="zoom-caption">{{ $tr(zoom.label) }} — {{ $t(zoom.srgb ? 'maps.space.srgb' : 'maps.space.linear') }} · {{ zoom.size }}²{{ zoom.full ? '' : ' …' }}</div>
        <img :src="zoom.url" :alt="$tr(zoom.label)" />
        <button class="zoom-close" @click.stop="zoom = null">×</button>
      </div>
    </div>
  `
})
