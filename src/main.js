/**
 * 应用入口（零打包 ESM）。
 *
 * 启动顺序刻意和引擎初始化分开：
 *  1. 先初始化语言并挂载 Vue —— 界面、加载态、错误提示可以先出现；
 *  2. 再用 setTimeout 把 WebGL 引擎放到下一轮事件循环 —— 构造 TextureEngine 会编译
 *     shader、创建 GPU 资源，阻塞较久；先让首屏渲染出来，避免白屏。
 * 引擎失败只写进 state.error，不抛出，页面仍可显示错误信息。
 */
import { createApp } from 'vue'
import App from './App.js'
import { initLocale, t, tr, trNode } from './i18n/index.js'
import { TextureEngine } from './engine/engine.js'
import { setEngine, bootProject, state } from './engine/store.js'
import { registerTools } from './engine/webmcp.js'

// 语言必须先于挂载确定，否则首帧会用错误的语言渲染
initLocale()
const app = createApp(App)
// 把翻译函数挂到全局属性，模板里即可使用 $t / $tr / $trNode，无需逐组件注入
app.config.globalProperties.$t = t
app.config.globalProperties.$tr = tr
app.config.globalProperties.$trNode = trNode
app.mount('#app')

/**
 * 创建 WebGL 引擎、加载启动工程并注册外部工具接口。
 * 失败时降级为“离线”状态：state.error 供状态栏与 toast 展示，页面本身继续可用。
 * @sideEffect 写入全局 window.__SUBSTRATE__ 供调试/自动化脚本检查就绪状态
 */
function initEngine() {
  try {
    const engine = new TextureEngine()
    setEngine(engine)
    bootProject()
    try {
      registerTools(engine)
    } catch (e) {
      console.warn('[substrate] WebMCP registration failed', e)
    }
    window.__SUBSTRATE__ = { engine, state, ready: true }
    console.log('[substrate] engine ready:', state.engineInfo)
    // 外部 MCP 网关桥接：动态 import 保证未启用时（?mcp=off）完全不加载
    import('./engine/mcp-bridge.js')
      .then((mod) => mod.startMcpBridge())
      .catch((e) => console.warn('[substrate] MCP bridge unavailable', e))
    maybeSelfTest(engine)
    maybeAudit(engine)
  } catch (e) {
    // WebGL 不可用或初始化异常：保留应用外壳，把原因交给状态栏显示
    console.error('[substrate] engine init failed', e)
    state.error = t('error.webglInit') + ': ' + (e && e.message ? e.message : e)
    window.__SUBSTRATE__ = { engine: null, state, ready: false }
    // 自动化脚本等待这个标记来判断“启动流程已结束（无论成功与否）”
    window.__SUBSTRATE_READY__ = true
  }
}

/**
 * URL 带 ?selftest 时执行引擎自检，并把报告回传服务器、在页面上叠一份可视结果。
 * 支持参数：res（自检分辨率，默认 512）、export（同时跑导出测试）、exportres（导出分辨率）。
 * 仅在开发/自动化场景使用，不影响正常启动路径。
 * @param {TextureEngine} engine 已就绪的引擎实例
 */
async function maybeSelfTest(engine) {
  const params = new URLSearchParams(location.search)
  if (!params.has('selftest')) return
  try {
    const { runSelfTest, runExportTest, postReport, renderOverlay } = await import('./engine/selftest.js')
    // 等首帧与资源上传稳定后再自检，否则可能读到尚未编译完成的纹理
    await new Promise((r) => setTimeout(r, 600))
    const resolution = Number(params.get('res')) || 512
    const report = await runSelfTest(engine, { resolution })
    if (params.has('export')) {
      // 导出测试的结果并进同一份报告，便于一次性回传
      window.__SELFTEST_EXPORT__ = await runExportTest(engine, {
        resolution: Number(params.get('exportres')) || resolution
      })
      report.export = window.__SELFTEST_EXPORT__
    }
    await postReport('selftest', report)
    // 在页面上叠加可视化报告，并把结果挂到 window 供外部脚本读取
    renderOverlay(report)
    window.__SELFTEST__ = report
    window.__SELFTEST_DONE__ = true
    console.log('[substrate] selftest', report.ok ? 'PASSED' : 'FAILED', report)
  } catch (e) {
    console.error('[substrate] selftest crashed', e)
    // 崩溃也要产出结构化结论并置完成标记，避免等待方一直挂起
    window.__SELFTEST__ = { ok: false, error: String(e && e.message ? e.message : e) }
    window.__SELFTEST_DONE__ = true
    try {
      const { postReport } = await import('./engine/selftest.js')
      await postReport('selftest', window.__SELFTEST__)
    } catch (err) {
      /* 上报失败可忽略：结论已经写入 window.__SELFTEST__ */
    }
  }
}

/**
 * URL 带 ?audit 时运行节点审计，并把摘要打印到控制台、POST 到调试接口。
 * 参数 auditsection 可选择只审计某一段（默认 all）。
 * @param {TextureEngine} engine 已就绪的引擎实例
 * @sideEffect 写入 window.__AUDIT__，并尝试向 /api/debug/report 上报
 */
async function maybeAudit(engine) {
  const params = new URLSearchParams(location.search)
  if (!params.has('audit')) return
  try {
    const { runAudit } = await import('./engine/audit.js')
    const section = params.get('auditsection') || 'all'
    const report = await runAudit(engine, section)
    window.__AUDIT__ = report
    // 控制台只打印各段摘要，完整报告太长且会拖慢日志面板
    const summary = report.sections
      ? report.sections.map((s) => ({ section: s.section, ok: s.ok, passed: s.passed, failed: s.failed }))
      : { section: report.section, ok: report.ok, passed: report.passed, failed: report.failed }
    console.log('[substrate] audit ' + (report.ok ? 'PASSED' : 'FAILED'), JSON.stringify(summary))
    try {
      await fetch('/api/debug/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'audit', summary, report })
      })
    } catch (e) {
      /* 上报接口是可选的：静态部署下没有该端点也不应影响审计结果 */
    }
  } catch (e) {
    console.error('[substrate] audit crashed', e)
    window.__AUDIT__ = { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

// 延后一轮再初始化引擎：先把 Vue 首屏渲染出来，避免 WebGL 构建期出现白屏
setTimeout(initEngine, 0)
