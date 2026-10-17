// Automated self-test used by the agent harness and the in-app "?selftest=1" mode.
import { state, outputNode } from './store.js'
import { exportMaterial } from './exporter.js'

function channelStats(data, width, height) {
  let min = 255
  let max = 0
  let sum = 0
  const n = width * height
  for (let i = 0; i < n; i++) {
    const v = data[i * 4]
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { min, max, mean: +(sum / n).toFixed(1) }
}

function seamRatios(data, width, height) {
  const px = (x, y) => data[(y * width + x) * 4]
  let seamH = 0
  let localH = 0
  let seamV = 0
  let localV = 0
  for (let y = 0; y < height; y++) {
    seamH += Math.abs(px(0, y) - px(width - 1, y))
    localH += (Math.abs(px(0, y) - px(1, y)) + Math.abs(px(width - 2, y) - px(width - 1, y))) * 0.5
  }
  for (let x = 0; x < width; x++) {
    seamV += Math.abs(px(x, 0) - px(x, height - 1))
    localV += (Math.abs(px(x, 0) - px(x, 1)) + Math.abs(px(x, height - 2) - px(x, height - 1))) * 0.5
  }
  const h = seamH / height / Math.max(localH / height, 1.0)
  const v = seamV / width / Math.max(localV / width, 1.0)
  return { horizontal: +h.toFixed(2), vertical: +v.toFixed(2) }
}

function normalStats(data, width, height) {
  let meanZ = 0
  let unitErr = 0
  let minLen = 99
  let maxLen = 0
  const n = width * height
  for (let i = 0; i < n; i++) {
    const r = (data[i * 4] / 255) * 2 - 1
    const g = (data[i * 4 + 1] / 255) * 2 - 1
    const b = (data[i * 4 + 2] / 255) * 2 - 1
    const len = Math.sqrt(r * r + g * g + b * b)
    meanZ += b
    unitErr += Math.abs(len - 1)
    minLen = Math.min(minLen, len)
    maxLen = Math.max(maxLen, len)
  }
  return {
    meanZ: +(meanZ / n).toFixed(3),
    meanUnitError: +(unitErr / n).toFixed(3),
    minLength: +minLen.toFixed(3),
    maxLength: +maxLen.toFixed(3)
  }
}

export async function runSelfTest(engine, opts = {}) {
  const resolution = opts.resolution || 512
  const t0 = performance.now()
  const report = {
    ok: false,
    when: new Date().toISOString(),
    resolution,
    engine: { info: state.engineInfo, isFloat: engine.isFloat, rtType: String(engine.rtType), maxTexture: engine.ext.maxTexture },
    graph: {
      demo: state.projectName,
      nodes: state.graph.nodes.length,
      connections: state.graph.connections.length,
      outputs: state.graph.nodes.filter((n) => n.type === 'material_output').length
    },
    error: state.error || ''
  }

  report.shaders = engine.validateShaders()
  report.shaderAudit = { ok: report.shaders.ok, failures: report.shaders.failures.length }

  engine.clearCache()
  let result = null
  try {
    result = engine.evaluate(state.graph, { res: resolution })
  } catch (e) {
    report.ok = false
    report.error = 'evaluate failed: ' + e.message
    return report
  }
  const thumbs = engine.buildThumbs(state.graph, result, 96)
  report.eval = {
    ms: +result.ms.toFixed(1),
    nodes: result.order.length,
    passes: engine.stats.passes,
    cacheHits: result.cacheHits,
    glError: engine.stats.glError,
    thumbnailsBuilt: thumbs,
    nodesWithThumbnail: state.graph.nodes.filter((n) => n._thumb).length
  }

  try {
    const maps = engine.previewMaps(256)
    report.channels = {}
    for (const [key, m] of Object.entries(maps)) {
      report.channels[key] = channelStats(m.data, m.width, m.height)
    }
    report.normal = normalStats(maps.normal.data, maps.normal.width, maps.normal.height)

    // seam check via full-resolution readback of base colour + height
    const outId = [...engine.lastOutputs.keys()][0]
    const texs = engine.lastOutputs.get(outId) || {}
    if (texs.basecolor && texs.height) {
      const size = Math.min(512, resolution)
      const base = engine.readTexture8(texs.basecolor, size, { srgb: false })
      const height = engine.readTexture8(texs.height, size, { srgb: false })
      report.seam = {
        basecolor: seamRatios(base, size, size),
        height: seamRatios(height, size, size)
      }
    }
  } catch (e) {
    report.error = 'readback failed: ' + e.message
  }

  const perfs = []
  const seamOk =
    !report.seam ||
    (report.seam.basecolor.horizontal < 2.5 &&
      report.seam.basecolor.vertical < 2.5 &&
      report.seam.height.horizontal < 2.5 &&
      report.seam.height.vertical < 2.5)
  const outNode = outputNode()
  const wired = new Set(
    state.graph.connections.filter((c) => outNode && c.to.node === outNode.id).map((c) => c.to.port)
  )
  const checks = {
    shadersCompile: report.shaders.ok,
    outputNodePresent: report.graph.outputs === 1,
    evalNoGlError: report.eval.glError === 0,
    thumbnailsPresent: report.eval.nodesWithThumbnail > 0,
    floatTargets: engine.isFloat
  }
  if (wired.has('basecolor')) checks.baseColorVariance = report.channels.basecolor.max - report.channels.basecolor.min > 30
  if (wired.has('normal')) {
    checks.normalUnitLength = report.normal.meanUnitError < 0.12
    checks.normalsFaceOutward = report.normal.meanZ > 0.35
  }
  if (wired.has('basecolor') || wired.has('height')) checks.seamless = seamOk
  report.checks = checks
  report.wired = [...wired]

  report.timing = { totalMs: +(performance.now() - t0).toFixed(1) }
  report.ok = Object.values(report.checks).every(Boolean)
  return report
}

export async function runExportTest(engine, opts = {}) {
  const demo = opts.demo || state.projectName
  const resolution = opts.resolution || 512
  const preset = opts.preset || 'gltf'
  const out = outputNode()
  const hasEmissive = state.graph.connections.some((c) => c.to.node === out?.id && c.to.port === 'emissive')
  const hasOpacity = state.graph.connections.some((c) => c.to.node === out?.id && c.to.port === 'opacity')
  const t0 = performance.now()
  const result = await exportMaterial(engine, {
    graph: state.graph,
    resolution,
    preset,
    materialName: 'SelfTest_' + (String(demo || '').replace(/[^A-Za-z0-9]/g, '') || 'Material'),
    targetNormal: preset === 'unreal' || preset === 'unity' ? 'dx' : 'gl',
    height16: true,
    normalizeHeight: out?.params?.normalizeHeight !== false,
    hasEmissive,
    hasOpacity,
    alphaMode: Number(out?.params?.alphaMode || 0),
    sourceNormal: out?.params?.normalConvention === 1 ? 'dx' : 'gl'
  })
  const files = result.files.map((f) => ({
    path: f.path,
    bytes: f.bytes.length,
    signature: Array.from(f.bytes.slice(0, 8))
  }))
  return {
    ok: !!result.ok,
    preset,
    resolution,
    ms: +(performance.now() - t0).toFixed(1),
    server: result.server,
    serverError: result.serverError,
    files,
    manifest: result.manifest,
    pngValid: files.every((f) => f.signature.join(',') === '137,80,78,71,13,10,26,10')
  }
}

export async function postReport(kind, report) {
  try {
    await fetch('/api/debug/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, report })
    })
  } catch (e) {
    console.warn('report failed', e)
  }
}

export function renderOverlay(report) {
  const el = document.createElement('div')
  el.id = 'selftest-overlay'
  el.style.cssText =
    'position:fixed;z-index:999;left:16px;top:16px;max-width:520px;max-height:70vh;overflow:auto;background:rgba(12,15,19,.94);border:1px solid ' +
    (report.ok ? '#2f6b46' : '#7a3333') +
    ';border-radius:10px;padding:14px 16px;color:#d9dee6;font:11px/1.5 ui-monospace,monospace;box-shadow:0 18px 50px rgba(0,0,0,.6)'
  const checks = Object.entries(report.checks || {})
    .map(([k, v]) => `<div style="color:${v ? '#69d69b' : '#ff8b8b'}">${v ? 'PASS' : 'FAIL'} ${k}</div>`)
    .join('')
  const channels = Object.entries(report.channels || {})
    .map(([k, s]) => `<div>${k}: min ${s.min} max ${s.max} mean ${s.mean}</div>`)
    .join('')
  el.innerHTML =
    `<div style="font-size:13px;font-weight:700;margin-bottom:6px;color:${report.ok ? '#69d69b' : '#ff8b8b'}">SUBSTRATE SELF-TEST ${report.ok ? 'PASSED' : 'FAILED'}</div>` +
    `<div>${report.graph.demo} · ${report.graph.nodes} nodes · ${report.graph.connections} links · eval ${report.eval ? report.eval.ms : '?'} ms</div>` +
    `<div>${report.engine.info}</div><hr style="border-color:#2c333d;margin:8px 0">${checks}` +
    `<hr style="border-color:#2c333d;margin:8px 0">${channels}` +
    (report.seam
      ? `<div>seam ratios: base ${report.seam.basecolor.horizontal}/${report.seam.basecolor.vertical} · height ${report.seam.height.horizontal}/${report.seam.height.vertical} (1.0 = seamless)</div>`
      : '') +
    (report.normal ? `<div>normal: meanZ ${report.normal.meanZ} · unit err ${report.normal.meanUnitError}</div>` : '') +
    (report.error ? `<div style="color:#ff8b8b;margin-top:6px">${report.error}</div>` : '') +
    (window.__SELFTEST_EXPORT__
      ? `<hr style="border-color:#2c333d;margin:8px 0"><div style="color:#69d69b">EXPORT ${window.__SELFTEST_EXPORT__.ok ? 'OK' : 'FAILED'} · ${window.__SELFTEST_EXPORT__.files.length} files · ${window.__SELFTEST_EXPORT__.ms} ms</div><div>${window.__SELFTEST_EXPORT__.server ? window.__SELFTEST_EXPORT__.server.dir : window.__SELFTEST_EXPORT__.serverError}</div>`
      : '')
  document.body.appendChild(el)
}
