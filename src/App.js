/**
 * 根组件 App。
 *
 * 职责：组装整个工作台的骨架（顶栏 / 左侧节点库 / 中间画布 / 右侧预览与检查器 / 状态栏），
 * 并集中管理各类弹窗的显隐、工程与素材的增删读写、快捷键、预览重建与 toast 提示。
 * 真正的渲染与业务逻辑分别下沉到 components/ 与 engine/store.js，这里只做编排与反馈。
 *
 * 模板以内联字符串形式声明（见文件末尾的 template），因此组件采用运行时模板编译，
 * 所有按钮/弹窗都在同一处可见，便于对照 setup() 中的状态。
 */
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
import ImagePbrDialog from './components/ImagePbrDialog.js'
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

// 组件注册表：模板里可直接使用 PascalCase 标签（如 <GraphEditor />），无需逐个 import 到模板
export default defineComponent({
  name: 'App',
  components: { NodePalette, GraphEditor, Inspector, Preview3D, MapPanel, PaintStudio, ExportDialog, TrashDialog, AiPanel, AssetLibrary, AiFloating, ImagePbrDialog },
  setup() {
    /** 画布组件实例引用：用于调用 addAtCenter() 与 fit()（新增节点后居中、载入工程后适配视图） */
    const graphRef = ref(null)
    // 各弹窗/浮层的显隐开关；统一用独立 ref 便于模板里 v-if 精确控制挂载与卸载
    const showExport = ref(false)
    const showProjects = ref(false)
    const showTrash = ref(false)
    const showDemos = ref(false)
    const showHelp = ref(false)
    const showAi = ref(false)
    const showAssets = ref(false)
    const showImagePbr = ref(false)
    const mcpCheck = ref(null)
    const mcpChecking = ref(false)
    // 工程列表弹窗自身的数据：projects 是服务端返回的素材清单，loadingProjects 控制加载态
    const projects = ref([])
    const loadingProjects = ref(false)
    // 轻提示：type 为空表示普通信息，'error' 会渲染成红色；toastTimer 用于重置自动关闭计时
    const toast = ref({ msg: '', type: '' })
    let toastTimer = null
    // 预览重建的防抖计时器：短时间内多次触发只重建一次，避免拖参数时反复编译
    let previewTimer = null

    // 内置手册 / 术语表面板状态（正文数据在 src/manual.js，不随组件重复创建）
    const helpTab = ref('manual')
    const helpQuery = ref('')
    const helpSection = ref(MANUAL_SECTIONS[0].id)
    const helpTag = ref('all')

    /** 手册当前语言：借助全局 locale 保持响应式，语言切换后手册正文即时更新 */
    const helpLang = computed(() => (locale.value === 'zh' ? 'zh' : 'en'))
    // 手册的章节与标签是静态数据，包一层 computed 只是为了让模板以统一方式访问
    const manualSections = computed(() => MANUAL_SECTIONS)
    const manualTags = computed(() => MANUAL_TAGS)

    /**
     * 大小写不敏感的关键词匹配。
     * @param {string} value 被检索的文本
     * @param {string} q 已转小写的关键词；为空表示“不过滤”
     * @returns {boolean} 是否命中
     */
    const matchText = (value, q) => !q || String(value).toLowerCase().includes(q)

    /** 当前正文要展示的章节：无搜索词时只显示选中章节，有搜索词时返回全部命中章节 */
    const visibleSections = computed(() => {
      const lang = helpLang.value
      const q = helpQuery.value.trim().toLowerCase()
      if (!q) return MANUAL_SECTIONS.filter((s) => s.id === helpSection.value)
      return MANUAL_SECTIONS.filter((s) => {
        // 把标题 + 各类型区块（段落/表格/列表）的文本拼成一段“检索语料”，再统一匹配
        const hay = [s.title[lang], ...s.blocks.flatMap((b) => (b.type === 'p' ? [b[lang]] : b.type === 'table' ? b.rows.flat().map((c) => c[lang]) : (b[lang] || [])))].join(' ')
        return matchText(hay, q)
      })
    })

    /** 术语表过滤：先按标签筛选，再按关键词匹配术语名/释义/在本工具中的应用 */
    const visibleGlossary = computed(() => {
      const lang = helpLang.value
      const q = helpQuery.value.trim().toLowerCase()
      return GLOSSARY.filter((g) => helpTag.value === 'all' || g.tag === helpTag.value).filter(
        (g) => !q || matchText(g.term[lang] + ' ' + g.desc[lang] + ' ' + g.app[lang], q)
      )
    })

    /** 交叉检索：手册页里输入的关键词命中了多少条术语，用于提示“可跳转到术语表” */
    const glossaryMatches = computed(() => {
      const q = helpQuery.value.trim().toLowerCase()
      if (!q) return 0
      const lang = helpLang.value
      return GLOSSARY.filter((g) => matchText(g.term[lang] + ' ' + g.desc[lang] + ' ' + g.app[lang], q)).length
    })

    // 右上角的计数文案：手册页显示章节数，术语页显示命中词条数
    const helpCount = computed(() =>
      helpTab.value === 'manual'
        ? t('help.sectionCount', { n: helpQuery.value.trim() ? visibleSections.value.length : MANUAL_SECTIONS.length })
        : t('help.termCount', { n: visibleGlossary.value.length })
    )

    /**
     * 手册正文的极简格式化：**粗体**、`代码`，其余原样输出。
     *
     * 安全要点：先转义 & < > 再插入标签，因为它最终会通过 v-html 渲染；
     * 不允许任何用户输入绕过转义，避免手册文本里混入脚本。
     * @param {string} text 原始文本（可含 ** 与 ` 标记）
     * @returns {string} 可安全用于 v-html 的 HTML 片段
     */
    function rich(text) {
      const esc = String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return esc
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
    }

    /**
     * 弹出一条轻提示，并在 3.2 秒后自动消失。
     * @param {string} msg 提示文本（调用方通常已用 t() 翻译）
     * @param {''|'error'} [type=''] 为 'error' 时渲染红色样式
     * @sideEffect 修改 toast 响应式状态；重复调用会重置计时，避免旧计时器提前清掉新提示
     */
    function notify(msg, type = '') {
      toast.value = { msg, type }
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (toast.value = { msg: '', type: '' }), 3200)
    }

    /**
     * 从左侧节点库点击某类节点时，在画布中心创建它。
     * @param {string} type 节点类型 id
     * @sideEffect 失败（画布未就绪）时弹出错误提示
     */
    function onPaletteAdd(type) {
      const node = graphRef.value?.addAtCenter(type)
      if (!node) notify(t('toast.addFail'), 'error')
    }

    /** 新建空白材质，并在渲染完成后把视图适配到内容（nextTick 等画布重建结束） */
    function doNew() {
      newProject()
      nextTick(() => graphRef.value?.fit())
      notify(t('toast.newMaterial'))
    }

    /**
     * 载入内置示例工程。
     * @param {string} id 示例 id（对应 state.demos）
     * @sideEffect 关闭示例下拉、适配视图、弹出成功提示
     */
    function doDemo(id) {
      loadDemo(id)
      showDemos.value = false
      nextTick(() => graphRef.value?.fit())
      // 提示语里用本地化后的示例名，取不到时退回 id，避免出现 undefined
      const demo = state.demos.find((d) => d.id === id)
      notify(t('toast.demoLoaded', { name: trText(demo?.name) || id }))
    }

    /**
     * 保存当前工程（以顶栏里的工程名为文件名）。
     * @sideEffect 写入磁盘并提示结果；失败时提示错误详情
     */
    async function doSave() {
      try {
        const res = await saveProject(state.projectName)
        notify(t('toast.saved', { file: res.file }))
      } catch (e) {
        notify(t('toast.saveFail', { msg: e.message }), 'error')
      }
    }

    /** 打开工程列表弹窗并拉取服务端素材清单；拉取失败时展示空列表而不是让弹窗卡在加载态 */
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

    /**
     * 把工程列表里的某项移入回收站（不强制删除）。
     * @param {string} name 工程名
     * @sideEffect 成功后刷新列表并提示；若该工程正被打开，服务端返回 PROJECT_ACTIVE，
     *   这里转成“当前打开中，无法删除”的友好提示
     */
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

    /** 告诉服务端当前打开的是哪个材质，服务端据此拒绝删除正在编辑的工程 */
    let activeTimer = 0
    /**
     * 防抖地把“当前工程名”同步给服务端（250ms）。
     * 工程名输入框是 v-model 实时绑定的，逐字符请求会产生大量无效调用，
     * 因此只在用户停手后上报一次；请求失败静默忽略，不影响编辑。
     * @param {string} name 当前工程名（空串表示未命名/新建）
     */
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
    // immediate:true 保证首次挂载时也上报一次，服务端从启动起就知道当前打开的工程
    watch(
      () => state.projectName,
      (name) => markActiveProject(name),
      { immediate: true }
    )

    /** 防止重复点击“删除当前材质”导致并发请求 */
    const deletingMaterial = ref(false)

    /**
     * 把编辑器里正打开的材质移入回收站。
     *
     * 素材仍然绑定：被回收的工程保留完整图结构（含 imageAssetId 引用），
     * 因此素材库在它被彻底清除前仍会拒绝删除对应素材。
     * 删除后立即新建空白材质，保证编辑器永远不会指向一个已经不存在的文件。
     *
     * 请求带 force:true 表示“允许回收当前打开的工程”；NOT_FOUND 视为已删除，不报错。
     * @sideEffect 关闭/重置工程、弹出提示
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

    /** 删除画布中选中的节点；未选中任何节点时给出错误提示而不是静默无反应 */
    function deleteSelection() {
      if (!state.selectedIds.length) {
        notify(t('top.deleteSelectionEmpty'), 'error')
        return
      }
      const n = state.selectedIds.length
      deleteSelected()
      notify(t('toast.nodesDeleted', { n }))
    }

    /** 打开回收站；同时收起工程列表与素材库，避免多个弹窗叠在一起 */
    function openTrash() {
      showTrash.value = true
      showProjects.value = false
      showAssets.value = false
    }

    /**
     * 回收站内容变化后的回调（恢复/彻底删除）。
     * 若工程列表此刻可见，重新拉取一次，保证列表与回收站状态一致。
     */
    async function onTrashChanged() {
      // 回收站变了：如果工程列表正打开，刷新它
      if (showProjects.value) projects.value = await listProjects()
    }

    /**
     * 打开（载入）指定工程。
     * @param {string} name 工程名
     * @sideEffect 切换当前工程、关闭列表弹窗、适配视图并提示
     */
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

    /** 进入绘制模式：把目标节点设为当前绘制对象并选中它，画布先隐藏（模板里用 v-show 控制） */
    function openPaint(nodeId) {
      const node = nodeById(nodeId)
      if (!node) return
      state.activePaintId = nodeId
      state.mode = 'paint'
      state.selectedIds = [nodeId]
      state.activeNodeId = nodeId
    }
    /** 退出绘制模式并强制重新求值，让画布与 3D 预览看到最新笔触结果 */
    function closePaint() {
      state.mode = 'graph'
      state.activePaintId = null
      requestEval(true)
    }

    /** 从浮动小窗展开为右侧完整 AI 面板（两者互斥，展开时隐藏浮窗） */
    function expandAi() {
      showAi.value = true
      hideFloating()
    }
    /** 顶栏 ✦ 按钮：开/关 AI 面板；打开时同样收起浮窗，避免同一内容出现两份 */
    function toggleAi() {
      showAi.value = !showAi.value
      if (showAi.value) hideFloating()
    }

    /**
     * 运行 MCP 工具自检，结果既写入状态（供帮助弹窗展示明细）也弹 toast 汇总。
     * 异常时构造一份失败报告，保证界面不会缺少 totals 字段而报错。
     * @sideEffect 修改 mcpCheck / mcpChecking，并弹出提示
     */
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

    /** 从帮助弹窗里运行完整审计：先收起弹窗让用户看到画布，再动态加载审计模块 */
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

    /** 自动整理节点布局，并汇报移动了多少个节点 */
    function doAutoLayout() {
      const result = autoLayout()
      nextTick(() => graphRef.value?.fit())
      notify(t('toast.layoutDone', { n: result.moved }))
    }

    /** 图片转 PBR 生成完成后：关闭导入弹窗，并等新节点写入后再适配视图把它们框进视野 */
    function onImagePbrGenerated() {
      showImagePbr.value = false
      nextTick(() => graphRef.value?.fit())
    }

    /** 顶栏分辨率下拉：值来自 DOM，需显式转成数字再交给 store（store 会触发全局重算） */
    function onResolution(e) {
      setResolution(Number(e.target.value))
    }
    /** 顶栏预览倍率下拉：同样需要 Number 转换，否则 0.5 会以字符串参与运算 */
    function onProxy(e) {
      setProxy(Number(e.target.value))
    }

    /**
     * 全局快捷键处理（挂在 window 的 keydown 上）。
     *
     * 规则：
     *  - 正在输入框/文本域/下拉框/可编辑区域中时全部放行，不劫持用户输入；
     *  - Ctrl/⌘ + Z/Shift+Z、Y、D、S、E 分别对应撤销/重做/复制/保存/导出；
     *  - Esc 优先退出绘制模式，否则关闭当前弹窗；
     *  - Delete/Backspace 仅在画布模式下删除节点，且选中连线时交给连线自身处理。
     * @param {KeyboardEvent} e 键盘事件
     */
    function onKey(e) {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      const key = (e.key || '').toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        // Shift+Z 约定为“重做”，与常见设计工具保持一致
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
        // 选中连线时删除键由连线自己的键盘处理，这里直接返回避免误删节点
        if (state.selectedEdgeId) return
        e.preventDefault()
        deleteSelected()
      }
    }

    // 预览重建：previewNonce 每次求值后自增，这里 120ms 防抖，避免连续拖动滑块时反复编译
    watch(
      () => state.previewNonce,
      () => {
        if (previewTimer) clearTimeout(previewTimer)
        previewTimer = setTimeout(() => {
          previewTimer = null
          // 384 是折中分辨率：够看清结构，又不会让每次拖动都卡顿
          if (buildPreview(state.engine, 384)) state.previewVersion++
        }, 120)
      }
    )
    // 引擎错误统一转成 toast；state.error 为空时不弹，避免清空错误时误报
    watch(
      () => state.error,
      (msg) => {
        if (msg) notify(msg, 'error')
      }
    )

    /** 状态栏右上角：“节点名 · 节点 id”，用于快速定位当前节点 */
    const selectedInfo = computed(() => {
      const n = nodeById(state.activeNodeId)
      if (!n) return t('status.noSelection')
      return defOf(n)?.name + ' · ' + n.id
    })
    // 历史记录标签（如“已保存/有未保存修改”）与当前输出分辨率，直接透传给状态栏
    const historyLabel = computed(() => state.historyLabel)
    const canvasSize = computed(() => state.resolution + ' × ' + state.resolution)

    // 快捷键是全局行为：组件挂载时注册、卸载时移除，避免内存泄漏与重复响应
    onMounted(() => window.addEventListener('keydown', onKey))
    onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

    // setup 的返回值即模板可访问的上下文；这里把状态、方法与常量统一暴露给内联模板
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
      showImagePbr,
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
      onImagePbrGenerated,
      onResolution,
      onProxy,
      undo,
      redo
    }
  },
  /**
   * 内联模板：按屏幕区域自上而下组织，便于与 setup() 中的状态逐一对应。
   *  - header.topbar：品牌、工程名、示例/保存/打开、撤销重做、分辨率与预览倍率、
   *    语言切换，以及 AI/素材库/回收站/帮助/图片转 PBR/导出入口；
   *  - main.workspace：左侧 <NodePalette>，中间 <GraphEditor> / <PaintStudio>（互斥），
   *    右侧预览与贴图分页 + <Inspector>；
   *  - footer.statusbar：引擎状态、求值耗时、缓存命中、历史与当前选中节点；
   *  - 尾部弹层：导出、AI 面板/浮窗、素材库、图片转 PBR、回收站、工程列表、帮助手册、toast。
   */
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
        <button class="btn" @click="showImagePbr = true" :title="$t('imagePbr.title')">{{ $t('imagePbr.button') }}</button>
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
    <ImagePbrDialog v-if="showImagePbr"
                     @close="showImagePbr = false"
                     @generated="onImagePbrGenerated" />

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
