// Full application audit harness (dev tool): schema, every node, value semantics,
// store actions, DOM interactions and i18n coverage. Runs in the browser against the live engine.
//
//   await runAudit(engine, 'schema' | 'render' | 'values' | 'actions' | 'dom' | 'i18n' | 'all')
//
import {
  state,
  nodeById,
  outputNode,
  setParam,
  addNode,
  addConnection,
  canConnect,
  removeConnection,
  deleteSelected,
  duplicateSelected,
  selectNode,
  selectNodes,
  setNodePosition,
  renameNode,
  undo,
  redo,
  graphJSON,
  loadDemo,
  newProject,
  saveProject,
  loadProject,
  listProjects,
  loadGraph,
  paintEntry,
  attachPaintCanvas,
  commitStroke,
  clearPaint,
  setNodeImage,
  doEval,
  setResolution,
  setProxy,
  canConnect as _canConnect
} from './store.js'
import { NODE_DEFS, NODE_MAP, OUTPUT_CHANNELS, CATEGORIES, defaultParams } from './nodes/index.js'
import { PRESETS, planFiles, exportMaterial } from './exporter.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx(engine, section) {
  const tests = []
  return {
    engine,
    section,
    tests,
    add(name, pass, info = '') {
      tests.push({ section, name, pass: !!pass, info: pass ? '' : String(info || '') })
      return !!pass
    },
    info(name, info) {
      tests.push({ section, name, pass: true, info: String(info), note: true })
    }
  }
}

function summarize(ctx) {
  const failed = ctx.tests.filter((t) => !t.pass && !t.note)
  return {
    section: ctx.section,
    ok: failed.length === 0,
    passed: ctx.tests.filter((t) => t.pass && !t.note).length,
    failed: failed.length,
    failures: failed.slice(0, 200),
    notes: ctx.tests.filter((t) => t.note).map((t) => t.info)
  }
}

// ------------------------------------------------------------------ schema ---
function auditSchema(ctx) {
  const types = new Set()
  const labels = new Set()
  for (const def of NODE_DEFS) {
    ctx.add(`${def.type}: type unique`, !types.has(def.type), def.type)
    types.add(def.type)
    ctx.add(`${def.type}: name`, typeof def.name === 'string' && def.name.length > 0)
    ctx.add(`${def.type}: category valid`, CATEGORIES.includes(def.category), def.category)
    ctx.add(`${def.type}: description`, typeof def.desc === 'string' && def.desc.length > 5)
    if (def.type !== 'material_output') ctx.add(`${def.type}: has render body`, !!(def.body || (def.passes && def.passes.length)))
    const pkeys = new Set()
    const inputs = new Set()
    for (const inp of def.inputs || []) {
      ctx.add(`${def.type}: input ${inp.name} unique`, !inputs.has(inp.name), inp.name)
      inputs.add(inp.name)
      ctx.add(`${def.type}: input ${inp.name} default`, Array.isArray(inp.def) ? inp.def.length >= 3 : typeof inp.def === 'number' && inp.def >= 0 && inp.def <= 1, JSON.stringify(inp.def))
    }
    for (const p of def.params || []) {
      const tag = `${def.type}.${p.key}`
      ctx.add(`${tag}: key unique`, !pkeys.has(p.key), p.key)
      pkeys.add(p.key)
      ctx.add(`${tag}: label`, typeof p.label === 'string' && p.label.length > 0)
      ctx.add(`${tag}: type known`, ['float', 'int', 'angle', 'bool', 'color', 'select', 'vec2', 'text', 'gradient'].includes(p.type), p.type)
      if (['float', 'int', 'angle'].includes(p.type)) {
        ctx.add(`${tag}: min<max`, Number(p.min) < Number(p.max), `${p.min}..${p.max}`)
        if (p.type !== 'int') ctx.add(`${tag}: step>0`, Number(p.step) > 0, String(p.step))
        ctx.add(`${tag}: def in range`, Number(p.def) >= Number(p.min) && Number(p.def) <= Number(p.max), `def=${p.def} range=${p.min}..${p.max}`)
      }
      if (p.type === 'vec2') {
        ctx.add(`${tag}: def length 2`, Array.isArray(p.def) && p.def.length === 2, JSON.stringify(p.def))
        ctx.add(`${tag}: def in range`, p.def.every((v) => v >= p.min && v <= p.max), JSON.stringify(p.def))
      }
      if (p.type === 'select') {
        ctx.add(`${tag}: options non-empty`, Array.isArray(p.options) && p.options.length > 0)
        ctx.add(`${tag}: def index valid`, Number.isInteger(p.def) && p.def >= 0 && p.def < (p.options || []).length, `def=${p.def}`)
        for (const o of p.options || []) ctx.add(`${tag}: option ${o} is string`, typeof o === 'string' && o.length > 0)
      }
      if (p.type === 'color') ctx.add(`${tag}: def hex`, /^#[0-9a-fA-F]{6}$/.test(p.def), p.def)
      if (p.type === 'gradient') {
        const stops = p.def || []
        ctx.add(`${tag}: 2..8 stops`, Array.isArray(stops) && stops.length >= 2 && stops.length <= 8, String(stops.length))
        const ps = stops.map((s) => s.p)
        ctx.add(`${tag}: stop positions sorted`, ps.every((v, i) => i === 0 || v >= ps[i - 1]), JSON.stringify(ps))
        ctx.add(`${tag}: stop colors hex`, stops.every((s) => /^#[0-9a-fA-F]{6}$/.test(s.c)))
      }
    }
    labels.add(def.name)
  }

  // every input named in shader source must exist as a declared input port
  for (const def of NODE_DEFS) {
    const src = [def.body || '', ...(def.passes || []).map((p) => p.body || '')].join('\n')
    const used = new Set([...src.matchAll(/uIn_([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    const declared = new Set((def.inputs || []).map((i) => i.name))
    for (const u of used) ctx.add(`${def.type}: shader input ${u} declared`, declared.has(u), [...declared].join(','))
    // uniforms referenced in source should be declared params (except shared uPx/uRes/uPrev/uPaint/uIn_)
    const uniforms = new Set([...src.matchAll(/\bu_([A-Za-z0-9_]+)/g)].map((m) => m[1]))
    const params = new Set((def.params || []).map((p) => p.key))
    for (const u of uniforms) {
      if (['px', 'res', 'prev', 'paint'].includes(u)) continue
      ctx.add(`${def.type}: shader uniform u_${u} has param`, params.has(u), [...params].join(','))
    }
  }

  // output channels
  ctx.add('channels: 8 outputs', OUTPUT_CHANNELS.length === 8, String(OUTPUT_CHANNELS.length))
  for (const ch of OUTPUT_CHANNELS) {
    ctx.add(`channel ${ch.key}: label`, typeof ch.label === 'string' && ch.label.length > 0)
    ctx.add(`channel ${ch.key}: key`, typeof ch.key === 'string')
  }
  ctx.add('channels: unique keys', new Set(OUTPUT_CHANNELS.map((c) => c.key)).size === OUTPUT_CHANNELS.length)

  // export presets
  ctx.add('presets: 5 entries', PRESETS.length === 5, String(PRESETS.length))
  for (const p of PRESETS) {
    ctx.add(`preset ${p.id}: fields`, !!(p.name && p.desc && p.engine && p.targetNormal), JSON.stringify(Object.keys(p)))
    const files = planFiles({ preset: p.id, name: 'Audit', hasEmissive: true, hasOpacity: true, alphaMode: 2 })
    ctx.add(`preset ${p.id}: plan >= 4 files`, files.length >= 4, String(files.length))
    ctx.add(`preset ${p.id}: unique file names`, new Set(files.map((f) => f.fileName)).size === files.length)
    ctx.add(`preset ${p.id}: labels`, files.every((f) => typeof f.label === 'string' && f.label))
  }
  // height/alpha plan variants
  const h16 = planFiles({ preset: 'gltf', name: 'A', height16: true })
  const h8 = planFiles({ preset: 'gltf', name: 'A', height16: false })
  ctx.add('plan: height bit depth option', h16.length === h8.length, `${h16.length}/${h8.length}`)

  // shader compilation audit
  const shader = ctx.engine.validateShaders()
  ctx.add('shaders: all compile', shader.ok, JSON.stringify(shader.failures || shader).slice(0, 500))
  ctx.add('shaders: count >= 30', shader.checked >= 30, String(shader.checked))
}

// ----------------------------------------------------------- graph helpers ---
let uidN = 0
function mk(type, id, params = {}, data = {}) {
  const def = NODE_MAP[type]
  if (!def) throw new Error('unknown node type ' + type)
  return { id, type, x: 0, y: 0, params: { ...defaultParams(def), ...params }, data }
}
function mkLink(from, fromPort, to, toPort) {
  return { id: 'l' + ++uidN, from: { node: from, port: fromPort || 'out' }, to: { node: to, port: toPort } }
}
function buildProbeGraph(type, params = {}, opts = {}) {
  const def = NODE_MAP[type]
  const res = opts.res || 128
  const nodes = [mk(type, 'n0', params, opts.data || {})]
  const links = []
  const skip = new Set(opts.skipInputs || [])
  let i = 0
  for (const inp of def.inputs || []) {
    if (skip.has(inp.name)) continue
    const srcType = opts.sourceType || 'perlin'
    const srcId = 's' + i
    nodes.push(mk(srcType, srcId, opts.sourceParams || {}, {}))
    links.push(mkLink(srcId, 'out', 'n0', inp.name))
    i++
  }
  return { nodes, connections: links, res }
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear)
}

function readRaw(engine, texture, size) {
  const rt = engine.acquire(size, size, engine.floatType || engine.rtType)
  const mat = engine.encodeMaterial
  const prevTex = mat.uniforms.uTex.value
  const prevMode = mat.uniforms.uMode.value
  mat.uniforms.uTex.value = texture
  mat.uniforms.uMode.value = 0
  mat.uniforms.uFlipY.value = 0
  mat.uniforms.uRes.value.set(size, size)
  mat.uniforms.uPx.value.set(1 / size, 1 / size)
  engine.renderQuad(mat, rt)
  const buf = new Float32Array(size * size * 4)
  engine.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf)
  engine.release(rt)
  mat.uniforms.uTex.value = prevTex
  mat.uniforms.uMode.value = prevMode
  return buf
}

function statsOf(buf, w, h) {
  const st = {
    min: [Infinity, Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity, -Infinity],
    mean: [0, 0, 0, 0],
    std: [0, 0, 0, 0],
    invalid: 0,
    negative: 0,
    overOne: 0,
    pixels: w * h,
    seamH: 0,
    seamV: 0,
    gradH: 0,
    gradV: 0
  }
  const sums = [0, 0, 0, 0]
  const sq = [0, 0, 0, 0]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        const v = buf[i + c]
        if (!Number.isFinite(v)) {
          st.invalid++
          continue
        }
        if (v < -1e-5) st.negative++
        if (v > 1.0 + 1e-5) st.overOne++
        if (v < st.min[c]) st.min[c] = v
        if (v > st.max[c]) st.max[c] = v
        sums[c] += v
        sq[c] += v * v
      }
    }
  }
  const n = w * h
  for (let c = 0; c < 4; c++) {
    st.mean[c] = sums[c] / n
    st.std[c] = Math.sqrt(Math.max(0, sq[c] / n - st.mean[c] * st.mean[c]))
  }
  // seam metric: wrapped-edge step vs the 99th percentile of interior adjacent steps.
  // High-frequency patterns (checker/grating) legitimately have matching edge steps, while a real
  // discontinuity is much larger than any normal neighbouring-pixel step.
  const P = (x, y) => buf[(y * w + x) * 4]
  const horiz = []
  const vert = []
  for (let y = 0; y < h; y++) {
    st.seamH += Math.abs(P(0, y) - P(w - 1, y))
    for (let x = 0; x < w - 1; x++) horiz.push(Math.abs(P(x, y) - P(x + 1, y)))
  }
  for (let x = 0; x < w; x++) {
    st.seamV += Math.abs(P(x, 0) - P(x, h - 1))
    for (let y = 0; y < h - 1; y++) vert.push(Math.abs(P(x, y) - P(x, y + 1)))
  }
  const pct = (arr, p) => {
    if (!arr.length) return 0
    const copy = arr.slice().sort((x, y) => x - y)
    return copy[Math.min(copy.length - 1, Math.floor(copy.length * p))]
  }
  const seamFloor = 0.002
  const seamH = st.seamH / h
  const seamV = st.seamV / w
  st.seamHr = seamH < seamFloor ? 0 : seamH / Math.max(pct(horiz, 0.99), seamFloor)
  st.seamVr = seamV < seamFloor ? 0 : seamV / Math.max(pct(vert, 0.99), seamFloor)
  return st
}

function evalGraph(engine, graph, targetId, res) {
  const result = engine.evaluate(graph, { res, sinks: [targetId] })
  const rt = result.rts.get(targetId)
  if (!rt) throw new Error('no render target for ' + targetId)
  const buf = readRaw(engine, rt.texture, res)
  engine.releaseResult(result)
  return { buf, stats: statsOf(buf, res, res), res }
}

function pixel(buf, res, u, v) {
  const x = Math.min(res - 1, Math.max(0, Math.floor(u * res))) 
  const y = Math.min(res - 1, Math.max(0, Math.floor(v * res)))
  const i = (y * res + x) * 4
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
}
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps
const near3 = (a, b, eps = 1e-3) => near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps)

// -------------------------------------------------------------- render audit ---
const SEAMLESS = new Set([
  'perlin', 'cellular', 'grunge', 'waves', 'checker', 'bricks', 'tiles', 'shape', 'gradient_map',
  'blur', 'directional_blur', 'sharpen', 'highpass', 'emboss', 'warp', 'levels', 'histogram_scan',
  'invert', 'hsl', 'normal', 'ao', 'curvature', 'edges', 'morphology', 'grayscale', 'threshold',
  'posterize', 'transform', 'channels', 'blend', 'paint', 'flat_value', 'flat_color', 'constant_value'
])

function expectNode(ctx, type, st) {
  const std = Math.max(st.std[0], st.std[1], st.std[2])
  if (['flat_value', 'flat_color', 'constant_value'].includes(type)) {
    ctx.add(`${type}: constant output`, std < 1e-4, `std=${std.toFixed(6)}`)
    return
  }
  if (type === 'image_input') {
    ctx.add(`${type}: placeholder has variation`, std > 1e-3, `std=${std.toFixed(5)}`)
    return
  }
  ctx.add(`${type}: output varies`, std > 1e-4, `std=${std.toFixed(6)}`)
  if (type === 'normal') {
    // decode normals and validate unit length on interior pixels
    let bad = 0
    let count = 0
    const res = Math.round(Math.sqrt(st.pixels))
    const buf = st.buf
    for (let y = 2; y < res - 2; y += 3) {
      for (let x = 2; x < res - 2; x += 3) {
        const i = (y * res + x) * 4
        const nx = buf[i] * 2 - 1
        const ny = buf[i + 1] * 2 - 1
        const nz = buf[i + 2] * 2 - 1
        const len = Math.hypot(nx, ny, nz)
        if (len < 0.5 || len > 1.5) bad++
        count++
      }
    }
    ctx.add(`${type}: unit length`, bad / Math.max(1, count) < 0.01, `bad=${bad}/${count}`)
    return
  }
  if (SEAMLESS.has(type)) {
    ctx.add(`${type}: seamless`, st.seamHr < 3 && st.seamVr < 3, `h=${st.seamHr.toFixed(2)} v=${st.seamVr.toFixed(2)}`)
  }
  if (['ao', 'threshold', 'curvature', 'edges'].includes(type)) {
    ctx.add(`${type}: 0..1 range`, st.min[0] >= -1e-4 && st.max[0] <= 1.0001, `min=${st.min[0].toFixed(3)} max=${st.max[0].toFixed(3)}`)
  }
}

function auditRender(ctx) {
  const engine = ctx.engine
  const res = 128
  for (const def of NODE_DEFS) {
    if (def.type === 'material_output') continue
    let probe
    try {
      probe = buildProbeGraph(def.type, {}, { res })
      const out = evalGraph(engine, probe, 'n0', res)
      ctx.add(`${def.type}: default evaluates`, true)
      ctx.add(`${def.type}: finite`, out.stats.invalid === 0, `invalid=${out.stats.invalid}`)
      out.stats.buf = out.buf
      expectNode(ctx, def.type, out.stats)

      // every select option renders cleanly
      for (const p of def.params || []) {
        if (p.type === 'select') {
          for (let oi = 0; oi < p.options.length; oi++) {
            const g = buildProbeGraph(def.type, { [p.key]: oi }, { res: 96 })
            const r = evalGraph(engine, g, 'n0', 96)
            ctx.add(`${def.type}.${p.key}=${p.options[oi]}: finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
          }
        }
        if (['float', 'int', 'angle'].includes(p.type)) {
          for (const v of [p.min, p.max]) {
            const g = buildProbeGraph(def.type, { [p.key]: Number(v) }, { res: 96 })
            const r = evalGraph(engine, g, 'n0', 96)
            ctx.add(`${def.type}.${p.key}=${v}: finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
            const bad = r.stats.min.slice(0, 3).some((m) => m < -100) || r.stats.max.slice(0, 3).some((m) => m > 100)
            ctx.add(`${def.type}.${p.key}=${v}: sane range`, !bad, `min=${r.stats.min[0].toFixed(2)} max=${r.stats.max[0].toFixed(2)}`)
          }
        }
        if (p.type === 'vec2') {
          for (const v of [p.min, p.max]) {
            const g = buildProbeGraph(def.type, { [p.key]: [v, v] }, { res: 96 })
            const r = evalGraph(engine, g, 'n0', 96)
            ctx.add(`${def.type}.${p.key}=${v}: finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
          }
        }
        if (p.type === 'color') {
          for (const v of ['#000000', '#ffffff']) {
            const g = buildProbeGraph(def.type, { [p.key]: v }, { res: 64 })
            const r = evalGraph(engine, g, 'n0', 64)
            ctx.add(`${def.type}.${p.key}=${v}: finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
          }
        }
        if (p.type === 'bool') {
          for (const v of [false, true]) {
            const g = buildProbeGraph(def.type, { [p.key]: v }, { res: 96 })
            const r = evalGraph(engine, g, 'n0', 96)
            ctx.add(`${def.type}.${p.key}=${v}: finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
          }
        }
        if (p.type === 'gradient') {
          for (const stops of [
            [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }],
            [
              { p: 0, c: '#ff0000' }, { p: 0.14, c: '#00ff00' }, { p: 0.29, c: '#0000ff' },
              { p: 0.43, c: '#ffff00' }, { p: 0.57, c: '#00ffff' }, { p: 0.71, c: '#ff00ff' },
              { p: 0.86, c: '#808080' }, { p: 1, c: '#ffffff' }
            ]
          ]) {
            const g = buildProbeGraph(def.type, { [p.key]: stops }, { res: 64 })
            const r = evalGraph(engine, g, 'n0', 64)
            ctx.add(`${def.type}.${p.key}: ${stops.length} stops finite`, r.stats.invalid === 0, `invalid=${r.stats.invalid}`)
          }
        }
      }
    } catch (e) {
      ctx.add(`${def.type}: default evaluates`, false, e?.message || String(e))
    }
  }
}

// -------------------------------------------------------------- value audit ---
function auditValues(ctx) {
  const engine = ctx.engine
  const R = 64
  const flat = (v, id = 's0') => mk('flat_value', id, { value: v })
  const colorNode = (hex, alpha = 1, id = 's0') => mk('flat_color', id, { color: hex, alpha })
  const chain = (nodes, links, target = 'n0', res = R) => evalGraph(engine, { nodes, connections: links }, target, res)
  const single = (type, params = {}, inputs = []) => {
    const nodes = [mk(type, 'n0', params)]
    const links = []
    inputs.forEach((src, i) => {
      nodes.push({ ...src, id: 's' + i })
      links.push(mkLink('s' + i, 'out', 'n0', src.port || NODE_MAP[type].inputs[i].name))
    })
    return { nodes, connections: links }
  }

  // constant value
  {
    const g = single('flat_value', { value: 0.25 })
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    ctx.add('flat_value: exact 0.25 rgb', near3(p, [0.25, 0.25, 0.25], 1e-3), JSON.stringify(p))
    ctx.add('flat_value: alpha 1', near(p[3], 1, 1e-3), String(p[3]))
  }
  // flat color linear conversion
  {
    const g = single('flat_color', { color: '#3366cc', alpha: 0.4 })
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    const want = hexToLinear('#3366cc')
    ctx.add('flat_color: sRGB->linear', near3(p, want, 2e-3), `got=${p.slice(0, 3).map((v) => v.toFixed(4))} want=${want.map((v) => v.toFixed(4))}`)
    ctx.add('flat_color: alpha param', near(p[3], 0.4, 1e-3), String(p[3]))
  }
  // invert
  {
    const g = single('invert', {}, [flat(0.25)])
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    ctx.add('invert: 0.25 -> 0.75', near3(p, [0.75, 0.75, 0.75], 2e-3), JSON.stringify(p))
    const ga = single('invert', { a: true }, [colorNode('#3366cc', 0.4)])
    const pa = pixel(chain(ga.nodes, ga.connections).buf, R, 0.5, 0.5)
    ctx.add('invert: alpha inverted', near(pa[3], 0.6, 2e-3), String(pa[3]))
    const gr = single('invert', { g: false, b: false }, [colorNode('#3366cc')])
    const pr = pixel(chain(gr.nodes, gr.connections).buf, R, 0.5, 0.5)
    const want = hexToLinear('#3366cc')
    ctx.add('invert: per-channel flags', near(pr[0], 1 - want[0], 2e-3) && near(pr[1], want[1], 2e-3), JSON.stringify(pr))
  }
  // threshold / histogram scan
  {
    const hi = single('threshold', { threshold: 0.5, softness: 0 }, [flat(0.7)])
    const lo = single('threshold', { threshold: 0.5, softness: 0 }, [flat(0.3)])
    const ph = pixel(chain(hi.nodes, hi.connections).buf, R, 0.5, 0.5)
    const pl = pixel(chain(lo.nodes, lo.connections).buf, R, 0.5, 0.5)
    ctx.add('threshold: hard hi', near(ph[0], 1, 2e-3), String(ph[0]))
    ctx.add('threshold: hard lo', near(pl[0], 0, 2e-3), String(pl[0]))
    const inv = single('threshold', { threshold: 0.5, softness: 0, invert: true }, [flat(0.7)])
    ctx.add('threshold: invert', near(pixel(chain(inv.nodes, inv.connections).buf, R, 0.5, 0.5)[0], 0, 2e-3))
    const hs = single('histogram_scan', { position: 0.5, width: 0.05 }, [flat(0.7)])
    ctx.add('histogram_scan: 0.7 -> 1', near(pixel(chain(hs.nodes, hs.connections).buf, R, 0.5, 0.5)[0], 1, 2e-3))
  }
  // levels / posterize
  {
    const lv = single('levels', { inLow: 0.2, inHigh: 0.8, outLow: 0, outHigh: 1, gamma: 1 }, [flat(0.5)])
    ctx.add('levels: mid stays mid', near(pixel(chain(lv.nodes, lv.connections).buf, R, 0.5, 0.5)[0], 0.5, 2e-3))
    const lg = single('levels', { inLow: 0, inHigh: 1, outLow: 0, outHigh: 1, gamma: 2 }, [flat(0.25)])
    const wantG = Math.pow(0.25, 1 / 2)
    ctx.add('levels: gamma 2', near(pixel(chain(lg.nodes, lg.connections).buf, R, 0.5, 0.5)[0], wantG, 3e-3), String(wantG))
    const po = single('posterize', { steps: 3 }, [flat(0.33)])
    ctx.add('posterize: 0.33@3 -> 0.5', near(pixel(chain(po.nodes, po.connections).buf, R, 0.5, 0.5)[0], 0.5, 2e-3))
  }
  // grayscale weights
  {
    const red = hexToLinear('#ff0000')
    for (const [mode, want] of [[0, red[0] * 0.2126 + red[1] * 0.7152 + red[2] * 0.0722], [1, (red[0] + red[1] + red[2]) / 3], [2, Math.max(...red)], [3, Math.min(...red)]]) {
      const g = single('grayscale', { mode }, [colorNode('#ff0000')])
      const v = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)[0]
      ctx.add(`grayscale: mode ${mode}`, near(v, want, 3e-3), `got=${v.toFixed(4)} want=${want.toFixed(4)}`)
    }
  }
  // hsl
  {
    const g = single('hsl', { hue: 180, saturation: 1, lightness: 0 }, [colorNode('#ff0000')])
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    ctx.add('hsl: red 180deg -> cyan', p[0] < 0.05 && p[1] > 0.9 && p[2] > 0.9, JSON.stringify(p.map((v) => v.toFixed(3))))
    const g2 = single('hsl', { hue: 0, saturation: 0, lightness: 0.2 }, [colorNode('#3366cc')])
    const p2 = pixel(chain(g2.nodes, g2.connections).buf, R, 0.5, 0.5)
    ctx.add('hsl: saturation 0 is grey', Math.abs(p2[0] - p2[1]) < 2e-3 && Math.abs(p2[1] - p2[2]) < 2e-3, JSON.stringify(p2.map((v) => v.toFixed(3))))
  }
  // blend maths
  {
    const blend = (mode, a, b, opacity = 1, mask) => {
      const nodes = [mk('blend', 'n0', { mode, opacity }), flat(a, 's0'), flat(b, 's1')]
      const links = [mkLink('s0', 'out', 'n0', 'base'), mkLink('s1', 'out', 'n0', 'blend')]
      if (mask) {
        nodes.push(flat(mask, 's2'))
        links.push(mkLink('s2', 'out', 'n0', 'mask'))
      }
      return pixel(chain(nodes, links).buf, R, 0.5, 0.5)[0]
    }
    ctx.add('blend: multiply .5*.4=.2', near(blend(4, 0.5, 0.4), 0.2, 2e-3), String(blend(4, 0.5, 0.4)))
    ctx.add('blend: add .5+.4=.9', near(blend(1, 0.5, 0.4), 0.9, 2e-3), String(blend(1, 0.5, 0.4)))
    ctx.add('blend: subtract .5-.4=.1', near(blend(2, 0.5, 0.4), 0.1, 2e-3), String(blend(2, 0.5, 0.4)))
    ctx.add('blend: screen .5,.4=.7', near(blend(5, 0.5, 0.4), 1 - 0.5 * 0.6, 2e-3), String(blend(5, 0.5, 0.4)))
    ctx.add('blend: opacity .5', near(blend(1, 0.5, 0.4, 0.5), 0.7, 2e-3), String(blend(1, 0.5, 0.4, 0.5)))
    ctx.add('blend: mask .5', near(blend(1, 0.5, 0.4, 1, 0.5), 0.7, 2e-3), String(blend(1, 0.5, 0.4, 1, 0.5)))
    ctx.add('blend: copy = blend', near(blend(0, 0.5, 0.4), 0.4, 2e-3))
    ctx.add('blend: lighten = max', near(blend(7, 0.3, 0.6), 0.6, 2e-3))
    ctx.add('blend: darken = min', near(blend(6, 0.3, 0.6), 0.3, 2e-3))
  }
  // normal / ao / curvature / edges constants
  {
    const ng = single('normal', {}, [flat(0.5)])
    const np = pixel(chain(ng.nodes, ng.connections).buf, R, 0.5, 0.5)
    ctx.add('normal: flat height -> (0.5,0.5,1)', near3(np, [0.5, 0.5, 1], 3e-3), JSON.stringify(np.map((v) => v.toFixed(3))))
    const ag = single('ao', {}, [flat(0.5)])
    ctx.add('ao: flat height -> 1', near(pixel(chain(ag.nodes, ag.connections).buf, R, 0.5, 0.5)[0], 1, 5e-3))
    const cg = single('curvature', {}, [flat(0.5)])
    ctx.add('curvature: flat height -> 0.5', near(pixel(chain(cg.nodes, cg.connections).buf, R, 0.5, 0.5)[0], 0.5, 5e-3))
    const eg = single('edges', {}, [flat(0.5)])
    ctx.add('edges: flat -> 0', near(pixel(chain(eg.nodes, eg.connections).buf, R, 0.5, 0.5)[0], 0, 5e-3))
  }
  // blur on flat
  {
    const g = single('blur', { radius: 12 }, [flat(0.5)])
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    ctx.add('blur: flat stays flat', near3(p, [0.5, 0.5, 0.5], 2e-3), JSON.stringify(p))
  }
  // identity filters
  {
    const gm = single('warp', { intensity: 0, offset: 0 }, [mk('gradient', 's0', { repeat: 2 }), flat(0.5)])
    const base = single('gradient', { repeat: 2 })
    const a = chain(gm.nodes, gm.connections, 'n0', R).buf
    const b = chain(base.nodes, base.connections, 'n0', R).buf
    let max = 0
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
    ctx.add('warp: intensity 0 is identity', max < 3e-3, 'maxdiff=' + max.toFixed(5))
    const tm = single('transform', {}, [mk('gradient', 's0', { repeat: 2 })])
    const ta = chain(tm.nodes, tm.connections).buf
    const tb = chain(base.nodes, base.connections).buf
    max = 0
    for (let i = 0; i < ta.length; i++) max = Math.max(max, Math.abs(ta[i] - tb[i]))
    ctx.add('transform: identity', max < 3e-3, 'maxdiff=' + max.toFixed(5))
    // transform offset: uv .5 with offset .25 samples source at .25
    const tf = chain(single('transform', { offset: [0.25, 0] }, [mk('gradient', 's0', { repeat: 2 })]).nodes, single('transform', { offset: [0.25, 0] }, [mk('gradient', 's0', { repeat: 2 })]).connections).buf
    const basePix = pixel(tb, R, 0.25, 0.5)
    ctx.add('transform: offset .25 correspondence', near(pixel(tf, R, 0.5, 0.5)[0], basePix[0], 3e-3), `got=${pixel(tf, R, 0.5, 0.5)[0].toFixed(4)} want=${basePix[0].toFixed(4)}`)
  }
  // channels mapping
  {
    const nodes = [mk('channels', 'n0', { chR: 2, chG: 1, chB: 0 }), colorNode('#ff0000', 1, 's0'), colorNode('#00ff00', 1, 's1'), colorNode('#0000ff', 1, 's2')]
    const links = [mkLink('s0', 'out', 'n0', 'r'), mkLink('s1', 'out', 'n0', 'g'), mkLink('s2', 'out', 'n0', 'b')]
    const p = pixel(chain(nodes, links).buf, R, 0.5, 0.5)
    const red = hexToLinear('#ff0000')
    const green = hexToLinear('#00ff00')
    const blue = hexToLinear('#0000ff')
    ctx.add('channels: channel picking', near(p[0], red[2], 2e-3) && near(p[1], green[1], 2e-3) && near(p[2], blue[0], 2e-3), JSON.stringify(p))
  }
  // gradient semantics
  {
    const ramp = [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }]
    const g1 = single('gradient', { type: 0, repeat: 1, offset: 0, gradient: ramp })
    const p1 = pixel(chain(g1.nodes, g1.connections, 'n0', 128).buf, 128, 0.25, 0.5)
    ctx.add('gradient: linear at u=.25', near(p1[0], 0.25, 0.01), String(p1[0].toFixed(4)))
    const g2 = single('gradient', { type: 0, repeat: 2, offset: 0, gradient: ramp })
    const p2 = pixel(chain(g2.nodes, g2.connections, 'n0', 128).buf, 128, 0.25, 0.5)
    ctx.add('gradient: linear repeat 2 at u=.25', near(p2[0], 0.5, 0.01), String(p2[0].toFixed(4)))
    const g3 = single('gradient', { type: 0, repeat: 1, offset: 0.25, gradient: ramp })
    const p3 = pixel(chain(g3.nodes, g3.connections, 'n0', 128).buf, 128, 0.5, 0.5)
    ctx.add('gradient: linear offset .25', near(p3[0], 0.75, 0.01), String(p3[0].toFixed(4)))
    const g4 = single('gradient', { type: 3, repeat: 1, offset: 0, gradient: ramp })
    const p4 = pixel(chain(g4.nodes, g4.connections, 'n0', 128).buf, 128, 0.5, 0.5)
    ctx.add('gradient: diamond center 0', near(p4[0], 0, 0.02), String(p4[0].toFixed(4)))
  }
  // gradient map
  {
    const ramp = [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }]
    const g = single('gradient_map', { gradient: ramp, contrast: 1, offset: 0 }, [flat(0.25)])
    const p = pixel(chain(g.nodes, g.connections).buf, R, 0.5, 0.5)
    ctx.add('gradient_map: 0.25 -> 0.25 grey', near3(p, [0.25, 0.25, 0.25], 3e-3), JSON.stringify(p.map((v) => v.toFixed(3))))
    const gi = single('gradient_map', { gradient: ramp, contrast: 1, offset: 0, invert: true }, [flat(0.25)])
    const pi = pixel(chain(gi.nodes, gi.connections).buf, R, 0.5, 0.5)
    ctx.add('gradient_map: invert', near(pi[0], 0.75, 3e-3), String(pi[0].toFixed(3)))
  }
  // paint layer with no strokes is the base stream
  {
    const g = single('paint', {}, [mk('perlin', 's0', { seed: 3 }), flat(1)])
    const base = single('perlin', { seed: 3 })
    const a = chain(g.nodes, g.connections, 'n0', R).buf
    const b = chain(base.nodes, base.connections, 'n0', R).buf
    let max = 0
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]))
    ctx.add('paint: empty layer equals base', max < 3e-3, 'maxdiff=' + max.toFixed(5))
  }
  // tile generator modes differ
  {
    const c = evalGraph(engine, single('tiles', { mode: 0 }), 'n0', 96)
    const h = evalGraph(engine, single('tiles', { mode: 1 }), 'n0', 96)
    ctx.add('tiles: color/height modes differ', c.stats.std[0] > 1e-3 && h.stats.std[0] > 1e-3)
  }
}

// ------------------------------------------------------------- action audit ---
async function auditActions(ctx) {
  const engine = ctx.engine
  const snapshot = {
    graph: JSON.parse(graphJSON()),
    projectName: state.projectName,
    resolution: state.resolution,
    proxy: state.proxy,
    locale: (await import('../i18n/index.js')).locale.value
  }
  const deleteProject = async (name) =>
    fetch('/api/projects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).catch(() => null)

  try {
    // ---------- add every node type ----------
    loadDemo('blank')
    await sleep(80)
    const before = state.graph.nodes.length
    const added = []
    for (const def of NODE_DEFS) {
      const pos = { x: 100 + (added.length % 6) * 220, y: 100 + Math.floor(added.length / 6) * 160 }
      const n = addNode(def.type, pos)
      if (def.type === 'material_output') {
        ctx.add('addNode: second output rejected', n === null || n === undefined, 'returned ' + JSON.stringify(n))
      } else {
        added.push(def.type)
        ctx.add(`addNode: ${def.type}`, !!n, 'null')
        if (n) {
          ctx.add(`addNode: ${def.type} selected`, state.activeNodeId === n.id, `${state.activeNodeId} != ${n.id}`)
          ctx.add(`addNode: ${def.type} defaults`, Object.keys(n.params || {}).length === (NODE_MAP[def.type].params || []).length)
        }
      }
    }
    ctx.add('addNode: all types added', state.graph.nodes.length === before + added.length, `${state.graph.nodes.length} vs ${before + added.length}`)
    const outNode = outputNode()
    const firstAdded = state.graph.nodes.find((n) => n.type === 'perlin')
    if (outNode && firstAdded) addConnection(firstAdded.id, 'out', outNode.id, 'basecolor')
    await sleep(250)
    doEval()
    ctx.add('addNode: thumbnails generated', state.graph.nodes.filter((n) => n._thumb).length > 0, String(state.graph.nodes.filter((n) => n._thumb).length))

    // ---------- delete + undo / redo ----------
    const full = state.graph.nodes.length
    selectNodes(state.graph.nodes.filter((n) => n.type !== 'material_output').map((n) => n.id))
    deleteSelected()
    await sleep(80)
    ctx.add('deleteSelected: non-output deleted', state.graph.nodes.length === 1 && state.graph.nodes[0].type === 'material_output', String(state.graph.nodes.length))
    undo()
    await sleep(80)
    ctx.add('undo: delete restored', state.graph.nodes.length === full, `${state.graph.nodes.length} vs ${full}`)
    redo()
    await sleep(80)
    ctx.add('redo: delete re-applied', state.graph.nodes.length === 1, String(state.graph.nodes.length))
    undo()
    await sleep(80)

    // ---------- connections, cycle detection, undo ----------
    const a = addNode('perlin', { x: 800, y: 800 })
    const b = addNode('blur', { x: 1100, y: 800 })
    const conns0 = state.graph.connections.length
    addConnection(a.id, 'out', b.id, 'input')
    await sleep(60)
    ctx.add('connect: link created', state.graph.connections.length === conns0 + 1)
    const cycle = canConnect(b.id, a.id)
    ctx.add('connect: cycle rejected', cycle.ok === false, JSON.stringify(cycle))
    const cycleAdd = addConnection(b.id, 'out', a.id, 'input')
    ctx.add('connect: cycle not written', cycleAdd === false && state.graph.connections.length === conns0 + 1)
    undo()
    await sleep(60)
    ctx.add('undo: connection removed', state.graph.connections.length === conns0, String(state.graph.connections.length))
    redo()
    await sleep(60)
    ctx.add('redo: connection restored', state.graph.connections.length === conns0 + 1)

    // ---------- param edit undo + coalescing ----------
    let nodeB = nodeById(b.id)
    const old = nodeB.params.radius
    setParam(nodeB.id, 'radius', old + 10, { coalesce: true })
    setParam(nodeB.id, 'radius', old + 20, { coalesce: true })
    await sleep(60)
    ctx.add('param: value applied', nodeById(b.id).params.radius === old + 20, String(nodeById(b.id).params.radius))
    undo()
    await sleep(60)
    ctx.add('param: coalesced undo', nodeById(b.id).params.radius === old, `${nodeById(b.id).params.radius} vs ${old}`)
    redo()
    await sleep(60)

    // ---------- move + rename undo ----------
    const x0 = nodeById(b.id).x
    setNodePosition(b.id, x0 + 120, nodeById(b.id).y)
    undo()
    ctx.add('move: undo restores position', nodeById(b.id).x === x0, `${nodeById(b.id).x} vs ${x0}`)
    renameNode(a.id, 'Audit Title')
    ctx.add('rename: applied', nodeById(a.id).data.title === 'Audit Title')
    undo()
    ctx.add('rename: undo', nodeById(a.id).data.title !== 'Audit Title')

    // ---------- duplicate ----------
    selectNodes([b.id])
    const dupCount = state.graph.nodes.length
    duplicateSelected()
    await sleep(100)
    ctx.add('duplicate: node copied', state.graph.nodes.length === dupCount + 1, `${state.graph.nodes.length} vs ${dupCount + 1}`)
    undo()
    await sleep(60)
    ctx.add('duplicate: undo', state.graph.nodes.length === dupCount)

    // ---------- resolution / proxy ----------
    for (const res of [512, 1024, 512]) {
      setResolution(res)
      await sleep(120)
      ctx.add(`resolution ${res}: state`, state.resolution === res)
      ctx.add(`resolution ${res}: no error`, !state.error, state.error)
    }
    for (const p of [1, 0.5, 0.25, 1]) {
      setProxy(p)
      await sleep(100)
      ctx.add(`proxy ${p}: state`, state.proxy === p)
    }
    setResolution(1024)

    // ---------- demos ----------
    for (const id of ['weathered-steel', 'mossy-rock', 'painted-sign', 'blank']) {
      loadDemo(id)
      await sleep(500)
      ctx.add(`demo ${id}: loaded`, state.graph.nodes.length >= (id === 'blank' ? 1 : 8), String(state.graph.nodes.length))
      ctx.add(`demo ${id}: project name`, typeof state.projectName === 'string' && state.projectName.length > 0)
      ctx.add(`demo ${id}: evaluates`, !state.error, state.error)
      ctx.add(`demo ${id}: evaluation stats`, state.evalNodes > 0 && state.lastEvalMs > 0, `${state.evalNodes}/${state.lastEvalMs}`)
      ctx.add(`demo ${id}: thumbnails`, state.lastThumbCount > 0, String(state.lastThumbCount))
    }

    // ---------- save / load / delete roundtrip ----------
    loadDemo('mossy-rock')
    await sleep(500)
    const savedName = 'Audit Roundtrip 审计'
    const beforeJson = graphJSON()
    const saved = await saveProject(savedName)
    ctx.add('saveProject: file', !!saved.file, JSON.stringify(saved))
    const projects = await listProjects()
    ctx.add('listProjects: contains saved', projects.some((p) => p.name === savedName), JSON.stringify(projects.map((p) => p.name)))
    loadDemo('blank')
    await sleep(200)
    const loaded = await loadProject(savedName)
    await sleep(400)
    ctx.add('loadProject: returns graph', !!loaded.graph)
    ctx.add('loadProject: project name', state.projectName === savedName, state.projectName)
    ctx.add('loadProject: graph identical', graphJSON() === beforeJson, 'graph JSON differs')
    await deleteProject(savedName)
    const after = await listProjects()
    ctx.add('deleteProject: removed', !after.some((p) => p.name === savedName), JSON.stringify(after.map((p) => p.name)))

    // ---------- image input ----------
    loadDemo('blank')
    await sleep(100)
    const imgNode = addNode('image_input', { x: 100, y: 400 })
    const c = document.createElement('canvas')
    c.width = 16
    c.height = 16
    const cx = c.getContext('2d')
    cx.fillStyle = '#804020'
    cx.fillRect(0, 0, 16, 16)
    setNodeImage(imgNode.id, c.toDataURL('image/png'), 'audit.png')
    await sleep(500)
    doEval()
    ctx.add('image: name stored', imgNode.data.imageName === 'audit.png')
    ctx.add('image: data stored', typeof imgNode.data.imageSrc === 'string' && imgNode.data.imageSrc.startsWith('data:'))
    const ir = evalGraph(engine, { nodes: [imgNode], connections: [] }, imgNode.id, 64)
    const ip = pixel(ir.buf, 64, 0.5, 0.5)
    const want = hexToLinear('#804020')
    ctx.add('image: sampled colour', near3(ip, want, 0.02), `got=${ip.slice(0, 3).map((v) => v.toFixed(3))} want=${want.map((v) => v.toFixed(3))}`)
    setParam(imgNode.id, 'invert', true)
    await sleep(200)
    doEval()
    const iri = evalGraph(engine, { nodes: [imgNode], connections: [] }, imgNode.id, 64)
    setParam(imgNode.id, 'invert', false)
    const ipi = pixel(iri.buf, 64, 0.5, 0.5)
    ctx.add('image: invert', near3(ipi, [1 - want[0], 1 - want[1], 1 - want[2]], 0.02), JSON.stringify(ipi.slice(0, 3)))

    // ---------- paint ----------
    loadDemo('painted-sign')
    await sleep(500)
    const paint = state.graph.nodes.find((n) => n.type === 'paint')
    ctx.add('paint: node exists', !!paint)
    const strokes0 = (paint.data.strokes || []).length
    const canvas = paintEntry(paint.id).canvas
    attachPaintCanvas(paint.id, canvas)
    commitStroke(paint.id, { color: '#ff0000', size: 40, opacity: 1, hardness: 0.8, erase: false, points: [{ x: 0.5, y: 0.5, p: 1 }] })
    await sleep(350)
    doEval()
    ctx.add('paint: stroke added', (nodeById(paint.id).data.strokes || []).length === strokes0 + 1, String((nodeById(paint.id).data.strokes || []).length))
    ctx.add('paint: evaluates', !state.error, state.error)
    undo()
    await sleep(300)
    doEval()
    ctx.add('paint: undo removes stroke', (nodeById(paint.id).data.strokes || []).length === strokes0, String((nodeById(paint.id).data.strokes || []).length))
    clearPaint(paint.id)
    await sleep(250)
    ctx.add('paint: clear empties', (nodeById(paint.id).data.strokes || []).length === 0)
    undo()
    await sleep(250)
    ctx.add('paint: undo clear restores', (nodeById(paint.id).data.strokes || []).length === strokes0, String((nodeById(paint.id).data.strokes || []).length))

    // ---------- export presets + normal flip ----------
    loadDemo('weathered-steel')
    await sleep(500)
    for (const preset of PRESETS.map((p) => p.id)) {
      try {
        const r = await exportMaterial(engine, {
          graph: state.graph,
          resolution: 512,
          preset,
          materialName: 'Audit_' + preset,
          targetNormal: preset === 'unreal' || preset === 'unity' ? 'dx' : 'gl',
          height16: true
        })
        ctx.add(`export ${preset}: ok`, !!r.ok, r.serverError || '')
        ctx.add(`export ${preset}: files`, r.files.length >= 4, String(r.files.length))
        ctx.add(`export ${preset}: manifest resolution`, r.manifest.resolution === 512, String(r.manifest.resolution))
        ctx.add(`export ${preset}: manifest normal`, !!(r.manifest.normalMap && r.manifest.normalMap.convention), JSON.stringify(r.manifest.normalMap))
        ctx.add(`export ${preset}: png signature`, r.files.every((f) => f.bytes && f.bytes[0] === 0x89 && f.bytes[1] === 0x50), '')
        ctx.info(`export dirs`, r.server ? r.server.dir : 'none')
      } catch (e) {
        ctx.add(`export ${preset}: ok`, false, e?.message || String(e))
      }
    }
    // normal convention flip: export the same normal graph with GL and DX, decode and compare G channel
    try {
      const graph = {
        nodes: [mk('perlin', 's0', { seed: 2 }), mk('normal', 'n0', { intensity: 0.5 }), mk('material_output', 'out', {})],
        connections: [mkLink('s0', 'out', 'n0', 'height'), mkLink('n0', 'out', 'out', 'normal')]
      }
      const gl = await exportMaterial(engine, { graph, resolution: 128, preset: 'gltf', materialName: 'AuditNormGl', targetNormal: 'gl', sourceNormal: 'gl' })
      const dx = await exportMaterial(engine, { graph, resolution: 128, preset: 'gltf', materialName: 'AuditNormDx', targetNormal: 'dx', sourceNormal: 'gl' })
      const glPng = gl.files.find((f) => /Normal/.test(f.path))
      const dxPng = dx.files.find((f) => /Normal/.test(f.path))
      const glPix = await decodePng(glPng.bytes)
      const dxPix = await decodePng(dxPng.bytes)
      let maxG = 0
      let maxR = 0
      for (let i = 0; i < glPix.length; i += 4) {
        maxG = Math.max(maxG, Math.abs(glPix[i + 1] + dxPix[i + 1] - 255))
        maxR = Math.max(maxR, Math.abs(glPix[i] - dxPix[i]))
      }
      ctx.add('export: DirectX normal green flip', maxG <= 3, 'max |gL+gD-255|=' + maxG)
      ctx.add('export: normal R unchanged', maxR <= 1, 'max dR=' + maxR)
    } catch (e) {
      ctx.add('export: DirectX normal green flip', false, e?.message || String(e))
    }
    // height bit depth / alpha plan
    try {
      const h16 = planFiles({ preset: 'gltf', name: 'A', height16: true })
      const h8 = planFiles({ preset: 'gltf', name: 'A', height16: false })
      const heightPlan16 = h16.find((f) => f.kind === 'height')?.bitDepth
      const heightPlan8 = h8.find((f) => f.kind === 'height')?.bitDepth
      ctx.add('plan: height16 flag', heightPlan16 === 16 && heightPlan8 === 8, JSON.stringify({ h16: heightPlan16, h8: heightPlan8 }))
      const alpha = planFiles({ preset: 'gltf', name: 'A', hasOpacity: true, alphaMode: 2 })
      ctx.add('plan: alpha basecolor RGBA', alpha.find((f) => f.kind === 'basecolor')?.colorType === 6, JSON.stringify(alpha.find((f) => f.kind === 'basecolor')))
    } catch (e) {
      ctx.add('plan: variants', false, e?.message || String(e))
    }
  } finally {
    try {
      const { setLocale } = await import('../i18n/index.js')
      setLocale(snapshot.locale, false)
      setResolution(snapshot.resolution)
      setProxy(snapshot.proxy)
      loadGraph(snapshot.graph, { name: snapshot.projectName, resolution: snapshot.resolution })
      await sleep(150)
      doEval()
    } catch (e) {
      /* restore best effort */
    }
  }
}

function singleNodeGraph(type, params = {}, id = 'n0') {
  return { nodes: [mk(type, id, params)], connections: [] }
}

async function decodePng(bytes) {
  const blob = new Blob([bytes], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = reject
      img.src = url
    })
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    return cx.getImageData(0, 0, c.width, c.height).data
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ------------------------------------------------------------------ dom audit ---
async function auditDom(ctx) {
  if (typeof document === 'undefined' || !document.querySelector('.app')) {
    ctx.add('dom: app mounted', false, 'no .app element')
    return
  }
  const engine = ctx.engine
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => [...document.querySelectorAll(sel)]
  const text = (sel) => q(sel)?.textContent?.trim() || ''
  const visible = (el) => !!el && el.offsetParent !== null
  const click = (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  const setInput = (el, value, event = 'input') => {
    if (!el) return false
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, value)
    el.dispatchEvent(new Event(event, { bubbles: true }))
    return true
  }
  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
  const errors = []
  const origError = console.error
  const origWarn = console.warn
  console.error = (...a) => {
    errors.push('error: ' + a.map(String).join(' ').slice(0, 160))
    origError.apply(console, a)
  }
  console.warn = (...a) => {
    const s = a.map(String).join(' ')
    if (s.includes('[i18n]')) errors.push('i18n: ' + s.slice(0, 160))
    origWarn.apply(console, a)
  }
  const onErr = (e) => errors.push('window: ' + (e.message || String(e)))
  window.addEventListener('error', onErr)

  const snapshot = { graph: JSON.parse(graphJSON()), name: state.projectName, resolution: state.resolution, mode: state.mode }
  const savedLocale = (() => { try { return localStorage.getItem('substrate.locale') } catch (e) { return null } })()
  const hrefBeforeLocaleTests = location.href
  const localeBeforeAudit = (await import('../i18n/index.js')).locale.value

  try {
    // toolbar + panels
    ctx.add('dom: topbar buttons', qa('.topbar .btn').length >= 4, String(qa('.topbar .btn').length))
    ctx.add('dom: palette rendered', qa('.pal-item').length >= 20, String(qa('.pal-item').length))
    ctx.add('dom: graph rendered', !!q('.graph'))
    ctx.add('dom: inspector rendered', !!q('.inspector'))
    ctx.add('dom: preview canvas', !!q('.preview canvas'))
    ctx.add('dom: status bar', qa('.statusbar span').length >= 4)

    // tabs
    const tabs = qa('.right-tabs button')
    click(tabs[1])
    await sleepMs(250)
    ctx.add('dom: 2D maps tab', visible(q('.maps')))
    click(tabs[0])
    await sleepMs(200)
    ctx.add('dom: 3D tab', visible(q('.preview')))

    // palette search (EN + ZH)
    const search = q('.palette .search')
    setInput(search, 'blur')
    await sleepMs(150)
    ctx.add('dom: palette search en', qa('.pal-name').length >= 1, String(qa('.pal-name').length))
    const i18n = await import('../i18n/index.js')
    const prevLocale = i18n.locale.value
    i18n.setLocale('zh', false)
    await sleepMs(150)
    setInput(search, '噪声')
    await sleepMs(200)
    ctx.add('dom: palette search zh', qa('.pal-name').length >= 3, String(qa('.pal-name').length))
    i18n.setLocale(prevLocale, false)
    await sleepMs(150)
    setInput(search, 'zzz-no-such-node')
    await sleepMs(150)
    ctx.add('dom: palette empty state', /No nodes|没有匹配/.test(text('.palette-scroll .pal-item.dim')))
    setInput(search, '')
    await sleepMs(120)

    // palette add
    const nodes0 = state.graph.nodes.length
    click(qa('.pal-item')[0])
    await sleepMs(350)
    ctx.add('dom: palette click adds node', state.graph.nodes.length === nodes0 + 1, `${state.graph.nodes.length} vs ${nodes0 + 1}`)
    ctx.add('dom: added node selected', state.activeNodeId === state.graph.nodes[state.graph.nodes.length - 1].id)

    // graph context menu add
    const nodes1 = state.graph.nodes.length
    q('.graph').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 420, clientY: 320 }))
    await sleepMs(250)
    ctx.add('dom: graph context menu opens', !!q('.graph-menu'))
    const menuSearch = q('.graph-menu .search')
    setInput(menuSearch, 'flat')
    await sleepMs(200)
    const menuItem = q('.graph-menu .menu-item')
    ctx.add('dom: graph menu filtered', !!menuItem)
    if (menuItem) {
      click(menuItem)
      await sleepMs(350)
      ctx.add('dom: graph menu adds node', state.graph.nodes.length === nodes1 + 1, String(state.graph.nodes.length))
    }
    key('Escape')
    await sleepMs(150)

    // ---------- live preview follows demo switches and edits ----------
    const { previewStore } = await import('./preview.js')
    const { loadDemo: loadDemoFn } = await import('./store.js')
    const texHash = (arr) => {
      if (!arr || !arr.length) return 'none'
      let h = 0
      const step = Math.max(1, Math.floor(arr.length / 2048))
      for (let i = 0; i < arr.length; i += step) h = (h * 31 + arr[i]) | 0
      return h + ':' + arr.length
    }
    const previewSnap = () => {
      const mesh = window.__PREVIEW__ && window.__PREVIEW__.getMesh && window.__PREVIEW__.getMesh()
      const mat = mesh && mesh.material
      const thumbs = qa('.map-card .map-thumb').map((e) => e.style.backgroundImage).join('|')
      return {
        map: mat && mat.map ? texHash(mat.map.image && mat.map.image.data) : 'none',
        normal: mat && mat.normalMap ? texHash(mat.normalMap.image && mat.normalMap.image.data) : 'none',
        maps: previewStore.maps && previewStore.maps.basecolor ? texHash(previewStore.maps.basecolor.data) : 'none',
        pv: state.previewVersion,
        nonce: state.previewNonce,
        cards: thumbs
      }
    }
    const waitPreviewVersion = async (from, timeout = 10000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        if (state.previewVersion > from) return true
        await sleepMs(120)
      }
      return false
    }
    const { selectNode: selectNodeFn } = await import('./store.js')
    loadDemoFn('weathered-steel')
    const pvSteel = state.previewVersion
    await waitPreviewVersion(pvSteel)
    const snapSteel = previewSnap()
    loadDemoFn('mossy-rock')
    const pvRock = state.previewVersion
    await waitPreviewVersion(pvRock)
    const snapRock = previewSnap()
    ctx.add('dom: 3D preview follows demo switch', snapSteel.map !== snapRock.map && snapRock.map !== 'none', JSON.stringify({ steel: snapSteel.map, rock: snapRock.map, pv: [snapSteel.pv, snapRock.pv] }))
    ctx.add('dom: 3D normal follows demo switch', snapSteel.normal !== snapRock.normal && snapRock.normal !== 'none', JSON.stringify({ steel: snapSteel.normal, rock: snapRock.normal }))
    ctx.add('dom: 2D map panel follows demo switch', snapSteel.maps !== snapRock.maps && snapRock.maps !== 'none', JSON.stringify({ steel: snapSteel.maps, rock: snapRock.maps }))
    click(tabs[1])
    await sleepMs(500)
    const cardsRock = qa('.map-card .map-thumb').map((e) => e.style.backgroundImage).join('|')
    loadDemoFn('painted-sign')
    const pvSign = state.previewVersion
    await waitPreviewVersion(pvSign)
    await sleepMs(300)
    const cardsSign = qa('.map-card .map-thumb').map((e) => e.style.backgroundImage).join('|')
    ctx.add('dom: map card thumbnails refresh', cardsRock !== cardsSign && cardsSign.length > 0, 'cards unchanged')
    click(tabs[0])
    await sleepMs(400)
    const outId = outputNode().id
    const baseConn = state.graph.connections.find((c) => c.to.node === outId && c.to.port === 'basecolor')
    const editTarget = baseConn ? nodeById(baseConn.from.node) : state.graph.nodes.find((n) => n.type === 'perlin')
    if (editTarget) {
      selectNodeFn(editTarget.id)
      await sleepMs(500)
      const snapBeforeEdit = previewSnap()
      const rng = qa('.inspector input[type=range]')[0]
      if (rng) setInput(rng, String(Number(rng.min) + (Number(rng.max) - Number(rng.min)) * 0.9), 'input')
      await waitPreviewVersion(snapBeforeEdit.pv)
      const snapAfterEdit = previewSnap()
      ctx.add('dom: 3D preview follows parameter edits', !!rng && snapBeforeEdit.map !== snapAfterEdit.map, JSON.stringify({ before: snapBeforeEdit.map, after: snapAfterEdit.map, ranged: !!rng }))
    }

    // node context menu
    const nodeEl = qa('.gnode')[0]
    if (nodeEl) {
      nodeEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await sleepMs(200)
      const actionItems = qa('.graph-menu .menu-item').map((e) => e.textContent)
      ctx.add('dom: node context menu actions', actionItems.length >= 3, JSON.stringify(actionItems))
      key('Escape')
      await sleepMs(100)
    }

    // node drag
    const anyNode = state.graph.nodes.find((n) => n.type !== 'material_output')
    const dragNode = qa('.gnode')[0]
    if (dragNode) {
      const x0 = state.graph.nodes[0].x
      const header = dragNode.querySelector('.gnode-header')
      const r = header.getBoundingClientRect()
      header.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 90, clientY: r.top + 68, pointerId: 1 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 90, clientY: r.top + 68, pointerId: 1 }))
      await sleepMs(200)
      ctx.add('dom: node drag changes position', state.graph.nodes[0].x !== x0, `${x0} -> ${state.graph.nodes[0].x}`)
      key('z', { ctrlKey: true })
      await sleepMs(200)
      ctx.add('dom: ctrl+z undo drag', state.graph.nodes[0].x === x0, `${state.graph.nodes[0].x} vs ${x0}`)
    }

    // connection rubber-band curve must be visible on screen while dragging
    try {
      const outPort = q('.gnode .port.output')
      if (outPort) {
        const pr = outPort.getBoundingClientRect()
        const cx = pr.left + pr.width / 2
        const cy = pr.top + pr.height / 2
        outPort.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 21, button: 0, buttons: 1 }))
        await sleepMs(120)
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + 180, clientY: cy + 140, pointerId: 21, buttons: 1 }))
        await sleepMs(180)
        const rub = q('.edge.rubber')
        const dot = q('.rubber-dot')
        const rb = rub ? rub.getBoundingClientRect() : null
        const gr = q('.graph').getBoundingClientRect()
        const onScreen = rb && rb.width > 5 && rb.height > 5 && rb.right > gr.left && rb.left < gr.right && rb.bottom > gr.top && rb.top < gr.bottom
        ctx.add('dom: connection curve visible while dragging', !!rub && !!rb && onScreen, rub ? JSON.stringify({ w: Math.round(rb.width), h: Math.round(rb.height), graph: [Math.round(gr.left), Math.round(gr.top)] }) : 'no rubber path')
        ctx.add('dom: connection curve endpoint dot', !!dot, 'no endpoint dot')
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + 180, clientY: cy + 140, pointerId: 21, buttons: 0 }))
        await sleepMs(200)
        ctx.add('dom: connection curve cleared on release', !q('.edge.rubber'))
      }
    } catch (e) {
      ctx.add('dom: connection curve visible while dragging', false, e?.message || String(e))
    }

    // marquee selection
    const graphEl = q('.graph')
    const gb = graphEl.getBoundingClientRect()
    state.selectedIds = []
    graphEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: gb.left + 20, clientY: gb.top + 20, pointerId: 2, button: 0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: gb.left + gb.width - 40, clientY: gb.top + gb.height - 40, pointerId: 2 }))
    await sleepMs(120)
    ctx.add('dom: marquee element visible', !!q('.marquee'))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: gb.left + gb.width - 40, clientY: gb.top + gb.height - 40, pointerId: 2 }))
    await sleepMs(200)
    ctx.add('dom: marquee selects nodes', state.selectedIds.length >= 1, String(state.selectedIds.length))

    // keyboard: delete + undo
    const beforeDel = state.graph.nodes.length
    if (state.selectedIds.length) {
      const diag = { mode: state.mode, edge: state.selectedEdgeId, selected: state.selectedIds.length, activeTag: document.activeElement && document.activeElement.tagName }
      key('Delete')
      await sleepMs(400)
      ctx.add('dom: Delete key removes selection', state.graph.nodes.length < beforeDel, `${state.graph.nodes.length} vs ${beforeDel} ${JSON.stringify(diag)}`)
      key('z', { ctrlKey: true })
      await sleepMs(250)
      ctx.add('dom: undo restores deleted', state.graph.nodes.length === beforeDel, String(state.graph.nodes.length))
    }

    // help modal
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '?'))
    await sleepMs(250)
    ctx.add('dom: help modal opens', !!q('.modal'))
    const closeBtn = q('.modal-head .icon-btn')
    click(closeBtn)
    await sleepMs(200)
    ctx.add('dom: help modal closes', !q('.modal'))

    // export dialog
    click(qa('.topbar .btn').find((b) => /Export|导出/.test(b.textContent)))
    await sleepMs(300)
    ctx.add('dom: export dialog opens', !!q('.modal.wide'))
    const planRows = qa('.file-table tbody tr').length
    ctx.add('dom: export plan rows', planRows >= 4, String(planRows))
    const presetCards = qa('.preset-card').length
    ctx.add('dom: export presets', presetCards === 5, String(presetCards))
    click(q('.preset-card'))
    ctx.add('dom: export preset selectable', true)
    click(q('.modal-head .icon-btn'))
    await sleepMs(200)

    // demos dropdown
    click(qa('.topbar .btn').find((b) => /Demos|示例/.test(b.textContent)))
    await sleepMs(200)
    const ddItems = qa('.dd-item')
    ctx.add('dom: demos dropdown', ddItems.length >= 3, String(ddItems.length))
    if (ddItems.length) {
      const name0 = state.projectName
      click(ddItems[1])
      await sleepMs(700)
      ctx.add('dom: demo loads from dropdown', state.projectName !== name0, state.projectName)
    }

    // map zoom
    click(qa('.right-tabs button')[1])
    await sleepMs(900)
    const card = q('.map-card')
    ctx.add('dom: map cards render', qa('.map-card').length >= 4, String(qa('.map-card').length))
    if (card) {
      click(card)
      await sleepMs(250)
      ctx.add('dom: map zoom opens', !!q('.map-zoom'))
      click(q('.map-zoom'))
      await sleepMs(150)
      ctx.add('dom: map zoom closes', !q('.map-zoom'))
    }
    click(qa('.right-tabs button')[0])
    await sleepMs(150)

    // preview shape + sliders
    const shapeSel = q('.shape-select')
    if (shapeSel) {
      for (const opt of [...shapeSel.options].map((o) => o.value)) {
        setInput(shapeSel, opt, 'change')
        await sleepMs(120)
      }
      ctx.add('dom: preview shapes switch', !state.error, state.error)
    }
    const ranges = qa('.preview-tools input[type=range]')
    if (ranges.length >= 2) {
      setInput(ranges[0], '3', 'input')
      setInput(ranges[1], '0.05', 'input')
      await sleepMs(200)
      ctx.add('dom: preview sliders', !state.error, state.error)
    }

    // paint studio
    loadDemo('painted-sign')
    await sleepMs(700)
    const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
    if (paintNode) {
      const { openPaintStudio } = await import('./store.js')
      openPaintStudio(paintNode.id)
      await sleepMs(500)
      ctx.add('dom: paint studio opens', !!q('.paint-studio'))
      const canvas = q('.paint-canvas')
      ctx.add('dom: paint canvas present', !!canvas)
      if (canvas) {
        const r = canvas.getBoundingClientRect()
        const strokes0 = (paintNode.data.strokes || []).length
        const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 9, pressure: 0.8, buttons: 1 }))
        ev('pointerdown', r.left + r.width * 0.4, r.top + r.height * 0.4)
        ev('pointermove', r.left + r.width * 0.5, r.top + r.height * 0.45)
        ev('pointermove', r.left + r.width * 0.6, r.top + r.height * 0.5)
        ev('pointerup', r.left + r.width * 0.6, r.top + r.height * 0.5)
        await sleepMs(400)
        const { nodeById: refetch } = await import('./store.js')
        ctx.add('dom: paint draws stroke', (refetch(paintNode.id).data.strokes || []).length === strokes0 + 1, String((refetch(paintNode.id).data.strokes || []).length))
        const undoBtn = qa('.paint-head .btn').find((b) => /Undo|撤销/.test(b.textContent))
        click(undoBtn)
        await sleepMs(500)
        ctx.add('dom: paint undo', (refetch(paintNode.id).data.strokes || []).length === strokes0, String((refetch(paintNode.id).data.strokes || []).length))
      }
      const back = qa('.paint-head .btn').find((b) => /Graph|节点图/.test(b.textContent))
      click(back)
      await sleepMs(300)
      ctx.add('dom: paint studio closes', !q('.paint-studio'))
    }

    // language switching
    const langBtns = qa('.lang-switch button')
    ctx.add('dom: language switch rendered', langBtns.length === 2, String(langBtns.length))
    const enBtn = langBtns.find((b) => b.textContent.trim() === 'EN')
    const zhBtn = langBtns.find((b) => b.textContent.trim() === '中文')
    if (zhBtn) {
      click(zhBtn)
      await sleepMs(250)
      ctx.add('dom: switch to zh', /程序化/.test(text('.brand-sub')), text('.brand-sub'))
      click(enBtn)
      await sleepMs(250)
      ctx.add('dom: switch to en', /Procedural/.test(text('.brand-sub')), text('.brand-sub'))
    }

    // new button
    const { newProject } = await import('./store.js')
    click(qa('.topbar .btn').find((b) => /New|新建/.test(b.textContent)))
    await sleepMs(500)
    ctx.add('dom: New creates blank material', state.graph.nodes.length <= 3 && state.graph.nodes.some((n) => n.type === 'material_output'), String(state.graph.nodes.length))

    // undo/redo toolbar buttons
    const before = graphJSON()
    const { addNode: addNodeFn } = await import('./store.js')
    addNodeFn('blur', { x: 200, y: 600 })
    await sleepMs(250)
    const addedJson = graphJSON()
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '↺'))
    await sleepMs(300)
    ctx.add('dom: toolbar undo works', addedJson !== before && graphJSON() === before, 'graph state after undo differs')
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '↻'))
    await sleepMs(250)
    ctx.add('dom: toolbar redo works', graphJSON() === addedJson)
  } catch (e) {
    ctx.add('dom: exception', false, e?.stack || e?.message || String(e))
  } finally {
    console.error = origError
    console.warn = origWarn
    window.removeEventListener('error', onErr)
    try {
      key('Escape')
      const { loadGraph, setResolution } = await import('./store.js')
      setResolution(snapshot.resolution)
      loadGraph(snapshot.graph, { name: snapshot.name, resolution: snapshot.resolution })
      state.mode = 'graph'
      state.activePaintId = null
      // the language-switch test is a real UI action; restore the user's remembered language
      try {
        if (savedLocale === null) localStorage.removeItem('substrate.locale')
        else localStorage.setItem('substrate.locale', savedLocale)
        history.replaceState(history.state, '', hrefBeforeLocaleTests)
        const { setLocale: restoreLocale } = await import('../i18n/index.js')
        restoreLocale(localeBeforeAudit, false)
      } catch (e) {
        /* ignore */
      }
      await sleepMs(250)
      doEval()
    } catch (e) {
      /* best effort */
    }
  }
  ctx.add('dom: no console errors/warnings', errors.length === 0, errors.slice(0, 8).join(' | '))
}

// ----------------------------------------------------------------- i18n audit ---
async function auditI18n(ctx) {
  const i18n = await import('../i18n/index.js')
  const { EN, ZH } = await import('../i18n/messages.js')
  const { trNode, trLabel, trOption, setLocale, trText } = i18n
  const restore = i18n.locale.value

  const enKeys = Object.keys(EN)
  const zhKeys = Object.keys(ZH)
  ctx.add('i18n: EN/ZH key parity', enKeys.length === zhKeys.length && enKeys.every((k) => ZH[k] !== undefined), `${enKeys.length}/${zhKeys.length}`)
  const same = enKeys.filter((k) => EN[k] === ZH[k])
  ctx.add('i18n: UI strings translated', same.length <= 10, JSON.stringify(same))

  setLocale('zh', false)
  await sleep(120)

  // node dictionary coverage
  const nodeNamesUntranslated = []
  const descsUntranslated = []
  for (const def of NODE_DEFS) {
    if (trNode(def.name) === def.name) nodeNamesUntranslated.push(def.name)
    if (trNode(def.desc) === def.desc) descsUntranslated.push(def.type)
  }
  ctx.add('i18n: node names translated', nodeNamesUntranslated.length <= 3, JSON.stringify(nodeNamesUntranslated))
  ctx.add('i18n: node descriptions translated', descsUntranslated.length === 0, JSON.stringify(descsUntranslated))
  const labels = new Set()
  const options = new Set()
  for (const def of NODE_DEFS) {
    for (const p of def.params || []) {
      labels.add(p.label)
      for (const o of p.options || []) options.add(o)
    }
  }
  const labelsUntranslated = [...labels].filter((l) => trLabel(l) === l)
  const optionsUntranslated = [...options].filter((o) => trOption(o) === o)
  ctx.add('i18n: parameter labels translated', labelsUntranslated.length <= 3, JSON.stringify(labelsUntranslated))
  ctx.add('i18n: select options translated', optionsUntranslated.length <= 6, JSON.stringify(optionsUntranslated))
  const demos = ['weathered-steel', 'mossy-rock', 'painted-sign']
  ctx.add('i18n: demo names translated', demos.every((id) => { const n = { 'weathered-steel': 'Weathered Painted Steel', 'mossy-rock': 'Mossy Rock', 'painted-sign': 'Hand Painted Sign' }[id]; return trText(n) !== n }))

  setLocale(restore, false)
  await sleep(100)

  // language must be remembered: storage + URL are both written on a real switch
  const savedBefore = localStorage.getItem('substrate.locale')
  const hrefBefore = location.href
  setLocale('zh', true)
  await sleep(80)
  ctx.add('i18n: zh stored', localStorage.getItem('substrate.locale') === 'zh', String(localStorage.getItem('substrate.locale')))
  ctx.add('i18n: zh mirrored in URL', new URLSearchParams(location.search).get('lang') === 'zh', new URL(location.href).search)
  setLocale('en', true)
  await sleep(80)
  ctx.add('i18n: en stored', localStorage.getItem('substrate.locale') === 'en', String(localStorage.getItem('substrate.locale')))
  ctx.add('i18n: en mirrored in URL', new URLSearchParams(location.search).get('lang') === 'en', new URL(location.href).search)
  // restore the caller's storage + URL state
  try {
    if (savedBefore === null) localStorage.removeItem('substrate.locale')
    else localStorage.setItem('substrate.locale', savedBefore)
    history.replaceState(history.state, '', hrefBefore)
  } catch (e) {
    /* ignore */
  }
  setLocale(restore, false)

  // runtime DOM check in both locales
  if (typeof document !== 'undefined' && document.querySelector('.app')) {
    for (const id of ['zh', 'en']) {
      setLocale(id, false)
      await sleep(350)
      ctx.add(`i18n: ${id} html lang`, document.documentElement.lang === (id === 'zh' ? 'zh-CN' : 'en'), document.documentElement.lang)
      ctx.add(`i18n: ${id} title`, id === 'zh' ? /程序化/.test(document.title) : /Procedural/.test(document.title), document.title)
      const brand = document.querySelector('.brand-sub')?.textContent?.trim() || ''
      ctx.add(`i18n: ${id} brand`, id === 'zh' ? /程序化/.test(brand) : /Procedural/.test(brand), brand)
      const bodyText = document.body.innerText || ''
      const rawKeys = bodyText.match(/\b(top|insp|export|maps|paint|graph|palette|status|help|projects|inspector)\.[a-z][a-zA-Z.]*/g)
      ctx.add(`i18n: ${id} no raw keys`, !rawKeys, JSON.stringify((rawKeys || []).slice(0, 5)))
      ctx.add(`i18n: ${id} no missing-key marker`, !/\[i18n\]/.test(bodyText))
    }
  }
  setLocale(restore, false)
  await sleep(200)
}

// -------------------------------------------------------------------- runner ---
const SECTIONS = {
  schema: auditSchema,
  render: auditRender,
  values: auditValues,
  actions: auditActions,
  dom: auditDom,
  i18n: auditI18n,
  mcp: async (ctx) => {
    const { runMcpSelfCheck } = await import('./mcp-selfcheck.js')
    const report = await runMcpSelfCheck()
    for (const c of report.checks || []) ctx.add(c.name, c.ok, c.info)
    ctx.add('mcp: overall', report.ok, report.totals ? JSON.stringify(report.totals) : '')
  },
  ui: async (ctx) => {
    const { runUiCheck } = await import('./ui-check.js')
    const res = await runUiCheck()
    for (const t of res.tests || res.failures || []) ctx.add(t.name, t.pass, t.info)
    if (!res.tests) ctx.add('ui: results', false, 'ui-check returned no test list')
  }
}

export async function runAudit(engine, section = 'all') {
  const list = section === 'all' ? ['schema', 'render', 'values', 'actions', 'dom', 'i18n'] : [section]
  const results = []
  for (const name of list) {
    const fn = SECTIONS[name]
    const ctx = makeCtx(engine, name)
    if (!fn) {
      ctx.add(`${name}: unknown section`, false)
      results.push(summarize(ctx))
      continue
    }
    try {
      await fn(ctx)
    } catch (e) {
      ctx.add(`${name}: section crashed`, false, e?.stack || e?.message || String(e))
    }
    results.push(summarize(ctx))
  }
  return section === 'all'
    ? { ok: results.every((r) => r.ok), sections: results, failed: results.reduce((n, r) => n + r.failed, 0) }
    : results[0]
}
