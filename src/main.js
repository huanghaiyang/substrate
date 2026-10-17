import { createApp } from 'vue'
import App from './App.js'
import { initLocale, t, tr, trNode } from './i18n/index.js'
import { TextureEngine } from './engine/engine.js'
import { setEngine, bootProject, state } from './engine/store.js'
import { registerTools } from './engine/webmcp.js'

initLocale()
const app = createApp(App)
app.config.globalProperties.$t = t
app.config.globalProperties.$tr = tr
app.config.globalProperties.$trNode = trNode
app.mount('#app')

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
    maybeSelfTest(engine)
  } catch (e) {
    console.error('[substrate] engine init failed', e)
    state.error = t('error.webglInit') + ': ' + (e && e.message ? e.message : e)
    window.__SUBSTRATE__ = { engine: null, state, ready: false }
    window.__SUBSTRATE_READY__ = true
  }
}

async function maybeSelfTest(engine) {
  const params = new URLSearchParams(location.search)
  if (!params.has('selftest')) return
  try {
    const { runSelfTest, runExportTest, postReport, renderOverlay } = await import('./engine/selftest.js')
    await new Promise((r) => setTimeout(r, 600))
    const resolution = Number(params.get('res')) || 512
    const report = await runSelfTest(engine, { resolution })
    if (params.has('export')) {
      window.__SELFTEST_EXPORT__ = await runExportTest(engine, {
        resolution: Number(params.get('exportres')) || resolution
      })
      report.export = window.__SELFTEST_EXPORT__
    }
    await postReport('selftest', report)
    renderOverlay(report)
    window.__SELFTEST__ = report
    window.__SELFTEST_DONE__ = true
    console.log('[substrate] selftest', report.ok ? 'PASSED' : 'FAILED', report)
  } catch (e) {
    console.error('[substrate] selftest crashed', e)
    window.__SELFTEST__ = { ok: false, error: String(e && e.message ? e.message : e) }
    window.__SELFTEST_DONE__ = true
    try {
      const { postReport } = await import('./engine/selftest.js')
      await postReport('selftest', window.__SELFTEST__)
    } catch (err) {
      /* ignore */
    }
  }
}

setTimeout(initEngine, 0)
