// ============================================================================
// JsonViewer —— JSON 查看器弹窗
//
// 界面位置：从素材库（AssetLibrary）打开的模态框，用来展示 .sbsar 归档的「解析报告」。
// 直接用浏览器打开原始接口只会看到无格式文本，所以这里用第三方格式化组件渲染成可折叠树。
//
// 依赖：json-formatter-js 2.3.4（MIT），以 UMD 形式从 /vendor/json-formatter.umd.js 加载，
// 挂在全局 globalThis.JSONFormatter 上（不在 package.json 里，属于随仓库引入的第三方脚本）。
// 交互：可切换展开层级、在「树视图 / 原始文本」之间切换、复制、下载。
// ============================================================================
import { defineComponent, onMounted, ref, computed, nextTick } from 'vue'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'JsonViewer',
  props: {
    /** 要拉取的 JSON 接口地址 */
    url: { type: String, required: true },
    /** 弹窗标题，同时用作下载文件名前缀 */
    title: { type: String, default: '' }
  },
  emits: ['close'],
  setup(props, { emit }) {
    /** 格式化组件挂载的宿主 div */
    const host = ref(null)
    /** 解析后的 JSON 数据（null 表示还没加载到） */
    const data = ref(null)
    /** 加载/渲染错误信息 */
    const error = ref('')
    /** 原始 JSON 文本，用于「原始」视图、复制与下载 */
    const raw = ref('')
    /** 是否显示未格式化的原始文本 */
    const showRaw = ref(false)
    /** 树视图的展开层级：1 / 2 / 99（全部展开） */
    const depth = ref(2)
    const loading = ref(true)

    /**
     * 取全局的 JSONFormatter 构造器；脚本没加载成功时抛出可读错误。
     * @returns {Function} JSONFormatter 构造器
     */
    const formatter = () => {
      const lib = globalThis.JSONFormatter
      if (!lib) throw new Error(t('json.libMissing'))
      return lib
    }

    /**
     * 用 JSONFormatter 把 data 渲染成可折叠树，重建前先清空宿主节点。
     * 渲染后再检查是否真的产生了 .json-formatter-row，以防 UMD 脚本静默失效。
     * @returns {void} 失败时把异常写入 error
     */
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
          // 逐层展开模式下多给 6 层余量，避免用户看不到深层内容；99 表示不限
          maxDepth: depth.value > 1 ? depth.value + 6 : 999,
          transitionDuration: 0.15
        }).render()
        el.appendChild(node)
        if (!el.querySelector('.json-formatter-row')) throw new Error(t('json.libMissing'))
      } catch (e) {
        error.value = String(e.message || e)
      }
    }

    /** 复制原始 JSON 到剪贴板；浏览器未授权剪贴板时静默失败 */
    async function copy() {
      try {
        await navigator.clipboard.writeText(raw.value)
        error.value = ''
      } catch (e) {
        /* 剪贴板不可用（非 https / 无权限）时静默忽略 */
      }
    }
    /** 把原始 JSON 下载成 .json 文件；2 秒后释放 blob URL 避免内存泄漏 */
    function download() {
      const blob = new Blob([raw.value], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = (props.title || 'inspection') + '.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    }
    /**
     * 切换展开层级：先改 depth、退出原始视图，等 DOM 更新后再重渲染。
     * @param {number} d 1 / 2 / 99
     * @returns {Promise<void>}
     */
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
        // 接口通常把报告包在 inspection 字段里；没有包裹时直接把整个响应当报告
        const payload = json.inspection ?? json
        data.value = payload
        raw.value = JSON.stringify(payload, null, 2)
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        loading.value = false
      }
      // 宿主元素只有在 loading 变为 false、v-else 分支渲染后才存在，因此必须等一次 tick
      await nextTick()
      render()
    })

    return { host, error, raw, showRaw, depth, setDepth, copy, download, loading, titleText: computed(() => props.title || t('json.title')), close: () => emit('close') }
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal wide json-modal">
        <!-- 工具条：展开层级、树视图/原始文本切换、复制、下载 -->
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
        <!-- 内容区：加载中 / 出错 / 原始文本 / 格式化树，四者互斥 -->
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
