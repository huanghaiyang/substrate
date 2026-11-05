/**
 * 引擎自检：供代理测试框架与页面内 `?selftest=1` 模式调用。
 *
 * 自检做的是“真实求值 + 真实像素读回”，因此能暴露着色器编译失败、GL 错误、
 * 缩略图缺失、法线非单位长度、接缝不连续、非法连线等问题；
 * 同时提供导出冒烟测试（写文件、校验 PNG 签名）与结果上报/浮层展示。
 *
 * 主要导出：runSelfTest（求值自检）、runExportTest（导出自检）、
 * postReport（上报结果）、renderOverlay（页内可视化展示）。
 */
import { state, outputNode, defOf } from './store.js'
import { exportMaterial } from './exporter.js'

/**
 * 统计单通道（R 通道）的 min / max / mean。
 *
 * 注意：像素数组是每像素 4 字节，这里只取 R 通道；对调色板无关，
 * 主要用于判断“输出是否有足够变化（不是一张纯色）”。
 *
 * @param {Uint8Array} data RGBA 像素数据
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{min:number, max:number, mean:number}} 统计结果（mean 保留 1 位小数）
 */
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

/**
 * 计算上下（vertical）与左右（horizontal）接缝的“相对阶跃”比值。
 *
 * 分子：边界列/行的平均绝对差；分母：内部相邻像素差的 99 分位（下限 1.0）。
 * 结果 1.0 左右表示无缝（边界差异与内部正常梯度同量级），明显大于 1 说明有可见接缝。
 * 用相对值而非绝对值，是为了兼容棋盘/光栅等高对比图案。
 *
 * @param {Uint8Array} data RGBA 像素数据
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {{horizontal:number, vertical:number}} 两个方向上的接缝比值
 */
function seamRatios(data, width, height) {
  const px = (x, y) => data[(y * width + x) * 4]
  const horiz = []
  const vert = []
  let seamH = 0
  let seamV = 0
  for (let y = 0; y < height; y++) {
    seamH += Math.abs(px(0, y) - px(width - 1, y))
    for (let x = 0; x < width - 1; x++) horiz.push(Math.abs(px(x, y) - px(x + 1, y)))
  }
  for (let x = 0; x < width; x++) {
    seamV += Math.abs(px(x, 0) - px(x, height - 1))
    for (let y = 0; y < height - 1; y++) vert.push(Math.abs(px(x, y) - px(x, y + 1)))
  }
  const pct = (arr, p) => {
    if (!arr.length) return 0
    const copy = arr.slice().sort((a, b) => a - b)
    return copy[Math.min(copy.length - 1, Math.floor(copy.length * p))]
  }
  // 分母保底 1.0，避免内部完全平坦（99 分位为 0）时把任何微小接缝放大成无穷大
  const floor = 1.0
  const h = seamH / height
  const v = seamV / width
  return {
    horizontal: +(h < floor ? 0 : h / Math.max(pct(horiz, 0.99), floor)).toFixed(2),
    vertical: +(v < floor ? 0 : v / Math.max(pct(vert, 0.99), floor)).toFixed(2)
  }
}

/**
 * 统计法线贴图的合理性。
 *
 * 像素值按 (v/255)*2-1 解码回 [-1,1]，统计：
 * - meanZ：蓝通道均值，切线空间法线应偏正（>0 表示朝外）；
 * - meanUnitError：长度与 1 的平均偏差（理想为 0）；
 * - minLength / maxLength：长度极值，用于发现压缩或未归一化的数据。
 *
 * @param {Uint8Array} data RGBA 像素数据
 * @param {number} width 宽
 * @param {number} height 高
 * @returns {object} { meanZ, meanUnitError, minLength, maxLength }
 */
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

/**
 * 运行引擎自检（核心入口）。
 *
 * 流程：收集引擎/图信息 → 校验全部着色器 → 清缓存后按指定分辨率求值 → 生成缩略图
 * → 读回各通道做统计（含法线单位长度与接缝）→ 依据“是否接了对应输出通道”决定启用哪些断言
 * → 汇总为 checks 并给出整体 ok。
 *
 * 副作用：会清空引擎缓存并触发一次全图求值/缩略图生成，但不修改用户的图结构。
 * 这是刻意的：缓存命中会掩盖真实的求值问题。
 *
 * @param {object} engine 引擎实例
 * @param {{resolution?:number}} [opts] 求值分辨率（默认 512）
 * @returns {Promise<object>} 自检报告：ok、graph、shaders、eval、channels、seam、normal、
 *                            checks、wired、warnings、timing、error
 */
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

  // 目标端口不存在的连线会被求值器静默忽略（节点改用默认输入），
  // 表现为“贴图好像没接上”。这里显式把它们列出来，便于定位问题。
  report.graph.invalidConnections = (state.graph.connections || [])
    .filter((c) => {
      const target = state.graph.nodes.find((n) => n.id === c.to?.node)
      return !(defOf(target)?.inputs || []).some((i) => i.name === c.to?.port)
    })
    .map((c) => ({ id: c.id, to: c.to }))

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
  // 法线按“实际求值分辨率”读回，而不是 256 的降采样结果：
  // 降采样时的滤波会把单位法线插值成更短的向量，导致高频但正常的法线图被误判为非单位长度。
  const outTexs = engine.lastOutputs.get([...engine.lastOutputs.keys()][0]) || {}
  if (outTexs.normal) {
    const normalSize = Math.min(2048, Math.max(64, resolution))
    report.normal = normalStats(
      engine.readTexture8(outTexs.normal, normalSize, { srgb: false, flipRows: false }),
      normalSize,
      normalSize
    )
    report.normal.sampledAt = normalSize
  } else {
    report.normal = normalStats(maps.normal.data, maps.normal.width, maps.normal.height)
  }

    // 接缝检查：对基础色与高度按全分辨率读回（上限 512，兼顾耗时）
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
    floatTargets: engine.isFloat,
    connectionPortsValid: report.graph.invalidConnections.length === 0
  }
  if (wired.has('basecolor')) checks.baseColorVariance = report.channels.basecolor.max - report.channels.basecolor.min > 30
  if (wired.has('normal')) {
    checks.normalUnitLength = report.normal.meanUnitError < 0.02
    // 切线空间法线始终朝 +Z；非常陡峭但合法的表面也可能让 meanZ 偏低。
    // 因此只把严重异常/反转（<=0.05）判为失败，把过度陡峭（<0.35）降级为警告。
    checks.normalsFaceOutward = report.normal.meanZ > 0.05
    if (report.normal.meanZ < 0.35) {
      report.warnings = report.warnings || []
      report.warnings.push(
        'Normal map is extremely steep (mean Z ' +
          report.normal.meanZ +
          '). Reduce Normal intensity, increase its sample radius, or blur the height input.'
      )
    }
  }
  if (wired.has('basecolor') || wired.has('height')) checks.seamless = seamOk
  report.checks = checks
  report.wired = [...wired]

  report.timing = { totalMs: +(performance.now() - t0).toFixed(1) }
  report.ok = Object.values(report.checks).every(Boolean)
  return report
}

/**
 * 导出冒烟测试：用当前图按指定分辨率与预设实际导出一次，校验产物。
 *
 * 判定项：服务端是否写入成功、文件数量、以及每个 PNG 的前 8 字节是否为标准签名
 * （137,80,78,71,13,10,26,10 即 "\x89PNG\r\n\x1a\n"）。
 * 会写到服务端的导出目录（SelfTest_* 命名），属于有副作用的测试。
 *
 * @param {object} engine 引擎实例
 * @param {{demo?:string, resolution?:number, preset?:string}} [opts]
 * @returns {Promise<object>} { ok, preset, resolution, ms, server, serverError, files, manifest, pngValid }
 */
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

/**
 * 把自检/导出报告 POST 到服务端调试接口，便于代理或 CI 收集结果。
 *
 * 失败只打印警告不抛出：自检的核心结论应保存在本地 report 中，
 * 上报失败不应掩盖自检本身的结果。
 *
 * @param {string} kind 报告类型（如 'selftest' / 'export'）
 * @param {object} report 报告对象
 * @returns {Promise<void>}
 */
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

/**
 * 在页面左上角渲染自检结果浮层（`?selftest=1` 模式下使用）。
 *
 * 浮层内容：通过/失败标题（按整体 ok 着色）、图规模与求值耗时、引擎信息、
 * 逐项 checks、各通道统计、接缝比值、法线指标、错误信息，以及可选导出结果。
 * 注意：本函数不做去重，重复调用会叠加多个浮层，调用方需自行保证只调用一次。
 *
 * @param {object} report runSelfTest 的报告
 * @returns {void}
 */
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
