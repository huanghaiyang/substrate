// ============================================================================
// AssetLibrary —— 素材库弹窗（工程/图片/.sbsar 归档管理）
//
// 界面位置：主界面工具栏「素材库」按钮打开的大尺寸模态框，底部还有入口进入回收站。
//
// 三类内容：
//  1. 普通图片：可一键用作贴图输入节点，或填入绘制图层；
//  2. .sbsar 归档：服务端解析出「接口」（图、参数、输出、内嵌资源），可展开查看、
//     编辑参数、调用本地原生引擎烘焙，或用预览图做近似重建；
//  3. 在线搜索结果：从外部图库搜索并导入（自动记录授权信息）。
//
// 与 engine 的交互：建节点/接线/写参数全部走 engine/store.js（addNode / setNodeImage /
// addConnection / setParam / requestEval），图数据在浏览器内存中实时同步；
// .sbsar 子资源与烘焙则通过本机服务端 HTTP 接口（/api/assets*、/api/sbsar/bake*）完成。
// ============================================================================
import { defineComponent, ref, onMounted, computed } from 'vue'
import { state, nodeById, addNode, setNodeImage, commitStroke, addConnection, disconnectInput, setParam, outputNode, requestEval, graphJSON, loadGraph } from '../engine/store.js'
import { analyzePreview, buildReconstructionProject } from '../engine/reconstruct.js'
import { loadPattern } from '../engine/paint.js'
import { t } from '../i18n/index.js'
import JsonViewer from './JsonViewer.js'
import SbsarParams from './SbsarParams.js'

// .sbsar 的参数覆盖值按「归档素材 id」存进 localStorage：
// 归档接口是稳定的，因此不需要哈希；数据量也很小。
const PARAM_STORAGE_KEY = 'substrate.sbsar.params'
/**
 * 读取所有归档的参数覆盖值。
 * @returns {Object<string, Object<string, string>>} 解析失败时返回空对象
 */
function loadParamValues() {
  try {
    const raw = localStorage.getItem(PARAM_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    return {}
  }
}
/**
 * 持久化参数覆盖值。
 * @param {Object<string, Object<string, string>>} values
 * @returns {void} 配额不足/隐私模式下静默失败（覆盖值只是不持久，不影响当前会话）
 */
function saveParamValues(values) {
  try {
    localStorage.setItem(PARAM_STORAGE_KEY, JSON.stringify(values || {}))
  } catch (e) {
    /* 配额或隐私模式：覆盖值直接不持久化 */
  }
}

export default defineComponent({
  name: 'AssetLibrary',
  components: { JsonViewer, SbsarParams },
  emits: ['close'],
  setup(_props, { emit }) {
    /** 当前素材列表（含 .sbsar 归档及其子资源） */
    const assets = ref([])
    /** 操作结果提示文案 */
    const status = ref('')
    const loading = ref(true)
    /** 隐藏的主导入文件框（图片 + .sbsar） */
    const fileInput = ref(null)
    /** 有耗时操作进行中时禁用按钮 */
    const busy = ref(false)
    const searchQuery = ref('')
    const searching = ref(false)
    /** 在线搜索结果 */
    const searchResults = ref([])
    const searchError = ref('')
    /** 非致命提示（例如服务端退化为本地检索） */
    const searchWarning = ref('')
    /** 隐藏的 .sbsar 导入文件框 */
    const sbsarInput = ref(null)
    /** 当前展开详情的 .sbsar 归档 id；空字符串表示全部收起 */
    const expanded = ref('')
    const pbrInput = ref(null) // 隐藏文件框：一次选择整套 PBR 通道贴图
    /** 近似重建进行中 */
    const reconstructing = ref(false)
    /** 本地引擎烘焙进行中 */
    const baking = ref(false)
    /** 烘焙后端状态：loading / available / reason / installUrl / sbsrender 路径 */
    const bake = ref({ loading: true, available: false, reason: '', installUrl: '' })
    const jsonTarget = ref(null) // 正在用 JSON 查看器打开解析报告的归档
    const lightbox = ref(null) // { url, name, width, height, bytes } 放大预览的图片
    /**
     * PBR 通道识别表。顺序很重要：先匹配到的规则生效，
     * 因此通用规则（如 _r）要放在更具体的规则之后。
     * mode 对应贴图输入节点的 channelMode（0=颜色，3=数据）。
     */
    const PBR_CHANNELS = [
      // 顺序很重要：先匹配到的规则生效
      { port: 'basecolor', mode: 0, re: /(base ?colou?r|albedo|diffuse|_diff|_bc\b|^colou?r)/i },
      { port: 'normal', mode: 3, re: /(normal|_nor\b|_nrm\b|_n\b|norm)/i },
      { port: 'roughness', mode: 3, re: /(rough|_r\b|rgh)/i },
      { port: 'metallic', mode: 3, re: /(metal|_m\b|mtl)/i },
      { port: 'height', mode: 3, re: /(height|displac|_disp|_h\b|elev)/i },
      { port: 'ao', mode: 3, re: /(occlusion|ambient|_ao\b|\bao_|_ao)/i },
      { port: 'emissive', mode: 0, re: /(emiss|glow)/i },
      { port: 'opacity', mode: 3, re: /(opacity|alpha|_mask\b)/i }
    ]
    /**
     * 根据文件名推断它属于哪个 PBR 通道。
     * @param {string} name 文件名（可带扩展名）
     * @returns {object|null} 命中的通道定义；无法识别时为 null
     */
    const detectChannel = (name) => {
      const base = String(name || '').replace(/\.[a-z0-9]+$/i, '')
      for (const c of PBR_CHANNELS) if (c.re.test(base)) return c
      return null
    }
    /** 打开 PBR 贴图集选择框 */
    const openPbrPicker = () => pbrInput.value?.click()

    /**
     * 把（已导入的）贴图接到 PBR 输出节点：每个通道建一个 image_input 节点并连线。
     * 同一通道出现多张时只取第一张，其余记入 skipped；无法识别的文件同样跳过。
     * @param {Array<{name:string,dataUrl:string,channel?:string}>} entries 贴图条目
     * @returns {Promise<{channels:string[], skipped:string[]}>} 已接上的通道与跳过的文件
     * @throws {Error} 图中没有 PBR 输出节点时抛出
     */
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
        // 节点依次排在输出节点左侧，按行错开避免互相遮挡
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

    /**
     * 读取 Blob 内容并转成 dataURL。
     * @param {Blob} blob
     * @returns {Promise<string>}
     */
    const blobToDataUrl = (blob) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(blob)
      })

    /** 查询本地烘焙后端是否可用（sbsrender 是否安装），失败时按不可用处理 */
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
     * 通过本地 Adobe 引擎（SAT sbsrender）烘焙并把结果接进图中。
     * 该引擎是原生程序且按用户授权，无法以 WebAssembly 形式随应用分发，
     * 因此由浏览器请求本机 studio 服务端代为执行。没有 SAT 时按钮会说明需要安装什么，
     * 而不是伪造一个预览。
     *
     * paramOverrides 是参数工作台提交的草稿：所有被改动的输入都会作为
     * `--set-value` 覆盖项转发给引擎，这才让「编辑」具有真实效果。
     * @param {object} asset 归档素材
     * @param {Object<string,string>|null} [paramOverrides] 参数覆盖值
     * @returns {Promise<void>}
     */
    async function bakeInApp(asset, paramOverrides = null) {
      if (baking.value) return
      baking.value = true
      try {
        status.value = t('assets.baking')
        const params = paramOverrides || paramValues.value[asset.id] || {}
        const r = await fetch('/api/sbsar/bake', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assetId: asset.id,
            res: Math.min(2048, state.resolution || 1024),
            params
          })
        })
        const j = await r.json()
        if (!j.ok) throw new Error(j.error?.message || 'bake failed')
        const entries = []
        for (const a of j.assets || []) {
          const blob = await (await fetch(a.url)).blob()
          entries.push({ name: a.name, dataUrl: await blobToDataUrl(blob), channel: a.channel || undefined })
        }
        const wired = await applyMapEntries(entries)
        const applied = Array.isArray(j.applied) ? j.applied.length : 0
        status.value =
          t('assets.bakeDone', { n: wired.channels.length, channels: wired.channels.join(', ') }) +
          (applied ? ' · ' + t('assets.bakeParamsApplied', { n: applied }) : '')
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      } finally {
        baking.value = false
      }
    }

    // ---- .sbsar 参数工作台 -----------------------------------------------------
    // 归档的接口部分无需 Adobe 引擎即可完整读取，因此参数编辑按素材分别存储，
    // 再转发给原生烘焙器。这里刻意不做「假的浏览器预览」：
    // 真实像素必须依赖引擎（参见 docs/reports/sbsar-engine-re/REPORT.md）。
    /** 当前打开参数工作台的归档 */
    const paramTarget = ref(null)
    /** 全部归档的参数覆盖值（初始化自 localStorage） */
    const paramValues = ref(loadParamValues())
    /** 某个归档被改动（非默认值）的参数数量，用于卡片角标 */
    function changedParamCount(asset) {
      const overrides = paramValues.value[asset.id] || {}
      const params = asset.inspection?.parameters || []
      return params.filter((p) => overrides[p.id] !== undefined && String(overrides[p.id]) !== String(p.default)).length
    }
    /** 打开某归档的参数编辑工作台 */
    function openParams(asset) {
      paramTarget.value = asset
    }
    /**
     * 保存参数草稿：工作台提交的是完整草稿（其初始值就是已存覆盖值），
     * 因此直接整体替换是正确的 —— 恢复某项默认值会删除对应覆盖项，
     * 不会残留旧值。
     * @param {Object<string,string>} draft 参数 id → 值
     */
    function applyParamDraft(draft) {
      if (!paramTarget.value) return
      const id = paramTarget.value.id
      const next = { ...(paramValues.value || {}) }
      // 工作台始终持有完整草稿（初始值就是已存覆盖值），因此这里整体替换是正确的：
      // 恢复某项默认值会移除对应覆盖项，而不会残留旧值
      next[id] = { ...(draft || {}) }
      paramValues.value = next
      saveParamValues(next)
    }
    /**
     * 参数工作台点击「烘焙」：保存草稿、关闭工作台，再用覆盖值请求真实烘焙。
     * @param {Object<string,string>} draft
     */
    function onParamsBake(draft) {
      applyParamDraft(draft)
      const asset = paramTarget.value
      paramTarget.value = null
      if (asset) bakeInApp(asset, { ...(paramValues.value[asset.id] || {}) })
    }

    /**
     * 导入一整套已烘焙的 PBR 贴图（basecolor/normal/roughness/…），
     * 把每个文件注册为素材，并按通道各建一个贴图输入节点接入 PBR 输出。
     * 这是「.sbsar → 真实 PBR」流程的实操终点：贴图需要先由 Adobe 引擎烘焙出来。
     * @param {Event} event 文件选择框的 change 事件
     * @returns {Promise<void>}
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

    /** 打开某归档的 JSON 解析报告查看器 */
    const openJson = (asset) => (jsonTarget.value = asset)

    /**
     * 近似重建：.sbsar 里没有可移植的节点图（它被编译成 .sbsasm），
     * 因此改为分析归档内嵌的预览渲染图，再生成一个外观相近、可平铺的程序化材质工程，
     * 结果作为新工程立即载入。
     * @param {object} asset .sbsar 归档素材
     * @returns {Promise<void>}
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
        // 保留用户当前正在编辑的工程（先尽力自动保存一份快照）
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
          /* 尽力而为，失败不阻塞重建 */
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
    /** 打开图片放大预览 */
    const openLightbox = (img) => (lightbox.value = img)
    /** 关闭放大预览 */
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
    /**
     * 格式化字节数为 KB / MB（不足 1KB 也显示 1KB）。
     * @param {number} n 字节数
     * @returns {string}
     */
    const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
    /**
     * 推导「接口图」的布局数据：参数分组 → 图 → 输出通道。
     * 节点拓扑本身在 .sbsasm 里，无法还原，所以这里只画接口层。
     * @param {object} a 归档素材
     * @returns {{groupList:Array<{name:string,count:number}>, outs:string[]}}
     */
    const interfaceLayout = (a) => {
      const ins = a.inspection || {}
      let groupList
      if (ins.parameterGroups && ins.parameterGroups.length) {
        // 服务端已对全部参数做过直方图统计（内联参数列表被截断过，不能直接数）
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

    /**
     * 在线搜索素材：请求本机服务端的聚合搜索接口（最多 12 条）。
     * 服务端可能降级到本地索引（fallback），此时用 searchWarning 提示而非报错。
     * @returns {Promise<void>}
     */
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
    /**
     * 导入一条在线搜索结果：服务端按 URL 下载并登记素材，
     * 同时保存来源（provider/creator/license）以便后续追溯授权。
     * @param {object} result 搜索结果项（需含 downloadUrl）
     * @returns {Promise<void>}
     */
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

    /**
     * 重新拉取素材列表。
     * 若当前没有展开任何归档且只有 1 个 .sbsar，则自动展开它，
     * 让用户一进来就能看到接口图与归档内容。
     * @returns {Promise<void>}
     */
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
        // 只有一个归档时自动展开，方便立刻看到接口图 / 内容
        const archives = assets.value.filter((a) => a.kind === 'sbsar')
        if (!expanded.value && archives.length === 1) expanded.value = archives[0].id
      }
    }
    /** 打开主导入文件框（图片 json 与 .sbsar） */
    function openPicker() {
      fileInput.value?.click()
    }
    /** 打开 .sbsar 专用导入文件框 */
    function openSbsarPicker() {
      sbsarInput.value?.click()
    }

    /**
     * 导入单个 .sbsar：读取成 dataURL 交给服务端解析。
     * 服务端会抽取出元数据与内嵌位图（节点图本身仍需 Adobe 引擎，见界面提示）。
     * @param {File} file .sbsar 文件
     * @returns {Promise<string>} 供状态栏显示的摘要文案
     * @throws {Error} 解析失败时抛出
     */
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

    /**
     * .sbsar 文件选择框 change：批量导入并汇总每个文件的解析摘要。
     * @param {Event} event
     * @returns {Promise<void>}
     */
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

    /**
     * 切换归档的展开/收起状态。
     * @param {object} asset 归档素材
     */
    const toggleExpand = (asset) => {
      expanded.value = expanded.value === asset.id ? '' : asset.id
    }
    /**
     * 取某个归档的所有子资源（.sbsar 内嵌图片）。
     * @param {object} asset 归档素材
     * @returns {Array<object>}
     */
    const childAssets = (asset) => assets.value.filter((a) => a.parentId === asset.id)
    /**
     * 把参数格式化为一行可读描述：种类 / 默认值 / 范围 / 枚举。
     * @param {object} p 参数项
     * @returns {string}
     */
    const fmtParam = (p) => {
      const bits = []
      // 真实 sbsar：label/group/kind 来自 <inputgui> 与 widget；旧的/合成数据：只有原始类型码
      if (p.kind && p.kind !== 'other') bits.push(p.kind)
      else if (p.type) bits.push('type ' + p.type)
      if (p.default !== null && p.default !== undefined && p.default !== '') bits.push('= ' + p.default)
      if (p.min !== null && p.min !== null && p.max !== null) bits.push(`[${p.min} … ${p.max}${p.step ? ' / ' + p.step : ''}]`)
      if (p.enumItems && p.enumItems.length) bits.push('{' + p.enumItems.slice(0, 4).join(' | ') + (p.enumItems.length > 4 ? ' | …' : '') + '}')
      return bits.join(' · ')
    }
    /**
     * 主导入框 change：逐个体处理，.sbsar 走归档解析，其余只接受 PNG/JPEG/WebP 图片。
     * 任一个文件失败即中断并显示错误（已成功的仍保留）。
     * @param {Event} event 文件选择框的 change 事件
     * @returns {Promise<void>}
     */
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

    /**
     * 下载素材文件并转成 dataURL（贴图节点需要内联数据，不能只存 URL）。
     * @param {object} asset 素材
     * @returns {Promise<string>} dataURL
     */
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

    /**
     * 把素材用作贴图：优先写入当前选中的贴图输入节点，没有则复用第一个，仍没有就新建。
     * .sbsar 的内嵌预览图会额外提示「仅供近似参考」。
     * @param {object} asset 素材
     * @returns {Promise<void>}
     */
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

    /**
     * 把素材作为图案填充到绘制图层：先加载图案，再提交一条 fill 笔画（可撤销），
     * 并记录来源素材 id 以便追踪引用关系。
     * @param {object} asset 素材
     * @returns {Promise<void>}
     */
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

    /**
     * 把素材移入回收站（不是真正删除，可从回收站恢复）。
     * 若素材仍被工程引用则拒绝删除，并列出引用它的工程名。
     * @param {object} asset 素材
     * @returns {Promise<void>}
     */
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

    /**
     * 拖拽文件到弹窗：把 DataTransfer 里的文件塞进隐藏的 file input 并手动派发 change，
     * 这样拖放与点选走同一套导入逻辑（无需重复实现）。
     * @param {DragEvent} event
     */
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
    /** 当前打开的图所引用的素材 id 集合（工程尚未保存，服务端无法知道，因此需在本地统计） */
    const currentGraphAssetIds = computed(() => {
      const ids = new Set()
      for (const node of state.graph.nodes) {
        const d = node.data || {}
        if (typeof d.imageAssetId === 'string') ids.add(d.imageAssetId)
        if (typeof d.patternAssetId === 'string') ids.add(d.patternAssetId)
        for (const stroke of Array.isArray(d.strokes) ? d.strokes : []) {
          // 从图案 URL 里提取素材 id（形如 /assets/<id>.png）
          const m = /\/assets\/([0-9a-f]{8,16})\./.exec(String(stroke.pattern || ''))
          if (m) ids.add(m[1])
        }
      }
      return ids
    })
    /**
     * 该素材是否被当前打开的图引用。
     * @param {object} asset 素材
     * @returns {boolean}
     */
    const usedInCurrentGraph = (asset) => currentGraphAssetIds.value.has(asset.id)
    /**
     * 汇总所有引用该素材的材质：已保存工程（来自接口）+ 当前打开的图。
     * @param {object} asset 素材
     * @returns {Array<{project:string,nodeId:string|null,current?:boolean,trashed?:boolean}>}
     */
    const assetUsage = (asset) => {
      const list = (asset.usage || []).slice()
      if (usedInCurrentGraph(asset) && !list.some((u) => u.project === state.projectName)) {
        list.push({ project: state.projectName || 'current', nodeId: null, current: true })
      }
      return list
    }
    /**
     * 把引用列表格式化为可读文本：已保存材质显示名称，已进回收站的追加「（回收站）」——
     * 因为引用关系不会随回收站消失。
     * @param {Array<object>} list assetUsage 的返回
     * @returns {string}
     */
    const usageLabel = (list) => list.map((u) => (u.trashed ? u.project + ' ' + t('assets.binSuffix') : u.project)).join('、')
    /** 素材被任何材质引用时禁止删除（保护工程的可复现性） */
    const isAssetLocked = (asset) => assetUsage(asset).length > 0
    /**
     * 删除按钮的悬停提示：被引用时说明引用方，否则提示将移入回收站。
     * @param {object} asset 素材
     * @returns {string}
     */
    const usageTitle = (asset) => {
      const list = assetUsage(asset)
      return list.length ? t('assets.inUse', { list: usageLabel(list) }) : t('assets.trashTitle')
    }

    /**
     * 复制素材的绝对 URL 到剪贴板，方便在其它工具里直接引用。
     * @param {object} asset 素材
     */
    function quoteUrl(asset) {
      const url = location.origin + asset.url
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => (status.value = '✓ 已复制 ' + url), () => {})
    }

    onMounted(() => {
      load()
      refreshBakeStatus()
    })

    // 对外暴露：素材列表、操作函数与状态，供模板绑定
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
      paramTarget,
      paramValues,
      changedParamCount,
      openParams,
      applyParamDraft,
      onParamsBake,
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
          <!-- 顶部说明：支持的内容、.sbsar 与 PBR 导入的限制 -->
          <div class="hint">{{ $t('assets.hint') }}</div>
          <div class="hint small sbsar-hint">{{ $t('assets.sbsarHint') }}</div>
          <div class="hint small sbsar-hint">{{ $t('assets.pbrHint') }}</div>
          <!-- 在线素材搜索区：输入关键词或回车触发 -->
          <div class="asset-search">
            <input v-model="searchQuery" :placeholder="$t('assets.searchPlaceholder')" @keydown.enter="searchOnline" />
            <button class="btn" :disabled="searching" @click="searchOnline">{{ searching ? $t('assets.searching') : $t('assets.searchOnline') }}</button>
          </div>
          <div v-if="searchError" class="asset-search-error">{{ searchError }}</div>
          <div v-if="searchWarning" class="asset-search-error">{{ searchWarning }}</div>
          <div v-if="searchResults.length" class="asset-search-results">
            <!-- 搜索结果卡片：缩略图、来源/作者/许可证，以及「导入」按钮 -->
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
            <!-- 素材网格：sbsar 归档卡片（可展开详情）与普通图片卡片两种形态 -->
            <div v-for="a in assets" :key="a.id" class="asset-card" :class="{ 'asset-card-sbsar': a.kind === 'sbsar' }">
              <template v-if="a.kind === 'sbsar'">
                <!-- 归档头部：图标、文件名、能力徽标（容器/图数/参数数/资源数/已改参数） -->
                <div class="sbsar-head" @click="toggleExpand(a)">
                  <div class="sbsar-icon">SA</div>
                  <div class="sbsar-head-body">
                    <div class="asset-name" :title="a.name">{{ a.name }}</div>
                    <div class="sbsar-badges">
                      <span class="sbsar-badge">{{ a.inspection?.container || '?' }}</span>
                      <span class="sbsar-badge">{{ (a.inspection?.graphs || []).length }} {{ $t('assets.sbsarGraphs') }}</span>
                      <span class="sbsar-badge">{{ a.inspection?.parameterCount || 0 }} {{ $t('assets.sbsarParams') }}</span>
                      <span class="sbsar-badge">{{ a.inspection?.imageCount || 0 }} {{ $t('assets.sbsarImages') }}</span>
                      <span v-if="changedParamCount(a)" class="sbsar-badge accent">{{ $t('assets.sbsarParamsEdited', { n: changedParamCount(a) }) }}</span>
                      <span class="sbsar-badge warn">{{ $t('assets.sbsarNoBake') }}</span>
                    </div>
                  </div>
                  <button class="icon-btn" @click.stop="toggleExpand(a)">{{ expanded === a.id ? '▾' : '▸' }}</button>
                </div>
                <div v-if="expanded === a.id" class="sbsar-detail">
                  <!-- 展开详情：报告说明/元数据/图/输出通道/接口图/归档内容/参数列表/烘焙状态/警告 -->
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
                    <!-- 接口图：左侧参数分组 → 中间图 → 右侧输出通道（纯示意，代表可编辑的接口层） -->
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
                    <!-- 归档内嵌资源：预览图可作贴图/绘制图案，其余资源仅展示 -->
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
                  <!-- 归档操作：近似重建、参数编辑、原生引擎烘焙、JSON 报告、删除 -->
                  <div class="asset-actions">
                    <button class="btn tiny accent" :disabled="reconstructing" @click="reconstruct(a)" :title="$t('assets.reconstructTitle')">{{ reconstructing ? $t('assets.reconstructing') : $t('assets.reconstruct') }}</button>
                    <button class="btn tiny" @click="openParams(a)" :title="$t('assets.sbsarParamsEditTitle')">{{ $t('assets.sbsarParamsEdit') }}</button>
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
                <!-- 普通图片卡片：缩略图、尺寸、授权信息与被引用提示 -->
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
          <!-- 底部：说明与回收站入口 -->
          <span class="hint">{{ $t('assets.foot') }}</span>
          <div style="display: flex; gap: 8px">
            <button class="btn tiny" @click="$emit('open-trash')">🗑 {{ $t('trash.open') }}</button>
            <button class="btn" @click="close">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>

      <JsonViewer v-if="jsonTarget" :url="jsonTarget.inspectionUrl" :title="jsonTarget.name" @close="jsonTarget = null" />

      <SbsarParams
        v-if="paramTarget"
        :asset="paramTarget"
        :values="paramValues[paramTarget.id] || {}"
        :bake="bake"
        @close="paramTarget = null"
        @apply="applyParamDraft"
        @bake="onParamsBake"
      />

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
