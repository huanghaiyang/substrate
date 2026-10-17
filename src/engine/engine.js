// GPU graph evaluation engine.
// Every node renders full-screen into RGBA16F render targets (linear light),
// results are cached by a structural hash so only dirty branches re-render.
import * as THREE from 'three'
import { VERTEX_SRC, PREVIEW_GLSL, COMMON_GLSL } from './glsl.js'
import { buildFragmentSource, passesOf, ENCODE_FRAG } from './compiler.js'
import { NODE_DEFS, NODE_MAP, resolveParams } from './nodes/index.js'
import { hexToLinear, clamp } from './color.js'

const MAX_GRADIENT_STOPS = 8
const THUMB = 96

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function flipRows(buf, width, height, bpp) {
  const row = width * bpp
  const tmp = new Uint8Array(row)
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row
    const b = (height - 1 - y) * row
    tmp.set(buf.subarray(a, a + row))
    buf.copyWithin(a, b, b + row)
    buf.set(tmp, b)
  }
  return buf
}

export class TextureEngine {
  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 8
    this.canvas.height = 8
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(8, 8, false)
    this.gl = this.renderer.getContext()

    this.extFloat = this.gl.getExtension('EXT_color_buffer_float')
    this.extHalf = this.gl.getExtension('EXT_color_buffer_half_float')
    this.rtType = this.extFloat || this.extHalf ? THREE.HalfFloatType : THREE.UnsignedByteType
    this.floatType = this.extFloat ? THREE.FloatType : this.rtType
    this.isFloat = this.rtType !== THREE.UnsignedByteType

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial())
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.pools = new Map()
    this.cache = new Map()
    this.materials = new Map()
    this.solids = new Map()
    this.paintTextures = new Map()
    this.paintVersions = new Map()
    this.imageTextures = new Map()
    this.imageVersions = new Map()
    this.lastOutputs = new Map()
    this.last = null
    this.frame = 0
    this.stats = { nodes: 0, passes: 0, evalMs: 0, cacheHits: 0, cacheSize: 0, lastFrameMs: 0 }

    this.ext = {
      floatRender: this.gl.getExtension('EXT_color_buffer_float') !== null,
      halfFilter: true,
      maxTexture: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)
    }

    this.encodeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SRC,
      fragmentShader: ENCODE_FRAG,
      uniforms: {
        uTex: { value: null },
        uMode: { value: 0 },
        uFlipY: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uPx: { value: new THREE.Vector2(1, 1) }
      },
      depthTest: false,
      depthWrite: false
    })

    this.previewMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SRC,
      fragmentShader: this.buildPreviewSource(),
      uniforms: {
        uBaseColor: { value: null },
        uNormal: { value: null },
        uRoughness: { value: null },
        uMetallic: { value: null },
        uAO: { value: null },
        uHeight: { value: null },
        uEmissive: { value: null },
        uFlipY: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
        uPx: { value: new THREE.Vector2(1, 1) }
      },
      depthTest: false,
      depthWrite: false
    })

    this.thumbCanvas = document.createElement('canvas')
    this.thumbCanvas.width = THUMB
    this.thumbCanvas.height = THUMB
    this.thumbCtx = this.thumbCanvas.getContext('2d', { willReadFrequently: true })

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.contextLost = true
    })
  }

  buildPreviewSource() {
    return (
      `precision highp float;\nprecision highp sampler2D;\n` +
      `in vec2 vUv;\nout vec4 fragColor;\n` +
      COMMON_GLSL +
      PREVIEW_GLSL +
      `\nvoid main() {\n` +
      `  vec2 p = vUv * 2.0 - 1.0;\n` +
      `  float m = step(dot(p, p), 1.0);\n` +
      `  vec3 col = shadePreview(vUv, p, 1.0);\n` +
      `  fragColor = vec4(col, m);\n` +
      `}\n`
    )
  }

  // ---------------------------------------------------------------- resources
  createRT(w, h, type = this.rtType) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false
    })
    rt.texture.colorSpace = THREE.NoColorSpace
    return rt
  }

  acquire(w, h, type = this.rtType) {
    w = Math.max(4, Math.round(w))
    h = Math.max(4, Math.round(h))
    const key = `${w}x${h}:${type}`
    const list = this.pools.get(key)
    if (list && list.length) return list.pop()
    return this.createRT(w, h, type)
  }

  release(rt) {
    if (!rt) return
    const key = `${rt.width}x${rt.height}:${rt.texture.type}`
    let list = this.pools.get(key)
    if (!list) {
      list = []
      this.pools.set(key, list)
    }
    if (list.length < 12) list.push(rt)
    else rt.dispose()
  }

  clearCache() {
    for (const e of this.cache.values()) this.release(e.rt)
    this.cache.clear()
  }

  disposePool() {
    for (const list of this.pools.values()) for (const rt of list) rt.dispose()
    this.pools.clear()
    for (const e of this.cache.values()) e.rt.dispose()
    this.cache.clear()
  }

  solid(r, g, b, a = 1) {
    const key = [r, g, b, a].map((v) => Math.round(clamp(v, 0, 1) * 255)).join(',')
    let tex = this.solids.get(key)
    if (!tex) {
      const arr = new Uint8Array(key.split(',').map(Number).concat([a === 1 ? 255 : Math.round(a * 255)]))
      tex = new THREE.DataTexture(arr, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
      tex.needsUpdate = true
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.colorSpace = THREE.NoColorSpace
      this.solids.set(key, tex)
    }
    return tex
  }

  solidDefault(def) {
    const d = def === undefined ? 0.5 : def
    if (Array.isArray(d)) return this.solid(d[0] ?? 0.5, d[1] ?? 0.5, d[2] ?? 0.5, d[3] ?? 1)
    return this.solid(d, d, d, 1)
  }

  transparent() {
    return this.solid(0, 0, 0, 0)
  }

  gridTexture() {
    if (this._grid) return this._grid
    const n = 256
    const arr = new Uint8Array(n * n * 4)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4
        const check = ((x >> 5) + (y >> 5)) & 1
        arr[i] = check ? 120 : 70
        arr[i + 1] = check ? 120 : 70
        arr[i + 2] = check ? 120 : 70
        arr[i + 3] = 255
      }
    }
    const tex = new THREE.DataTexture(arr, n, n, THREE.RGBAFormat, THREE.UnsignedByteType)
    tex.needsUpdate = true
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.colorSpace = THREE.NoColorSpace
    this._grid = tex
    return tex
  }

  getPaintTexture(nodeId) {
    return this.paintTextures.get(nodeId) || this.transparent()
  }

  setPaintCanvas(nodeId, canvas) {
    let tex = this.paintTextures.get(nodeId)
    if (tex) {
      tex.image = canvas
      tex.needsUpdate = true
    } else {
      tex = new THREE.CanvasTexture(canvas)
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.NoColorSpace
      tex.flipY = true
      this.paintTextures.set(nodeId, tex)
    }
    this.touchPaint(nodeId)
  }

  touchPaint(nodeId) {
    const tex = this.paintTextures.get(nodeId)
    if (tex) tex.needsUpdate = true
    this.paintVersions.set(nodeId, (this.paintVersions.get(nodeId) || 0) + 1)
  }

  removePaint(nodeId) {
    const tex = this.paintTextures.get(nodeId)
    if (tex) tex.dispose()
    this.paintTextures.delete(nodeId)
    this.paintVersions.delete(nodeId)
  }

  setImage(nodeId, canvas) {
    let tex = this.imageTextures.get(nodeId)
    if (tex) {
      tex.image = canvas
      tex.needsUpdate = true
    } else {
      tex = new THREE.CanvasTexture(canvas)
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.NoColorSpace
      tex.flipY = true
      this.imageTextures.set(nodeId, tex)
    }
    this.imageVersions.set(nodeId, (this.imageVersions.get(nodeId) || 0) + 1)
  }

  // ----------------------------------------------------------------- materials
  getMaterial(def, passIndex) {
    const key = `${def.type}:${passIndex}`
    let mat = this.materials.get(key)
    if (mat) return mat
    const src = buildFragmentSource(def, passIndex)
    mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SRC,
      fragmentShader: src,
      uniforms: this.buildUniforms(def, { id: '__proto__', params: {} }, passIndex, 2, 2, def.inputs.map(() => this.solid(0.5)), this.solid(0.5)),
      depthTest: false,
      depthWrite: false
    })
    this.materials.set(key, mat)
    return mat
  }

  buildUniforms(def, node, passIndex, w, h, inputTextures, prevTexture) {
    const u = {
      uRes: { value: new THREE.Vector2(w, h) },
      uPx: { value: new THREE.Vector2(1 / w, 1 / h) }
    }
    ;(def.inputs || []).forEach((inp, i) => {
      u['uIn_' + inp.name] = { value: inputTextures[i] || this.solid(0.5) }
    })
    if (passIndex > 0) u.uPrev = { value: prevTexture || this.solid(0.5) }
    if (def.paintInput) u.uPaint = { value: this.getPaintTexture(node.id) }
    if (def.imageInput) u.uImage = { value: this.imageTextures.get(node.id) || this.gridTexture() }
    const params = resolveParams(def, node)
    for (const p of def.params || []) {
      const v = params[p.key]
      switch (p.type) {
        case 'float':
          u['u_' + p.key] = { value: Number(v) || 0 }
          break
        case 'angle':
          u['u_' + p.key] = { value: ((Number(v) || 0) * Math.PI) / 180 }
          break
        case 'int':
        case 'select':
          u['u_' + p.key] = { value: Math.round(Number(v) || 0) }
          break
        case 'bool':
          u['u_' + p.key] = { value: !!v }
          break
        case 'color': {
          const [r, g, b] = hexToLinear(v)
          u['u_' + p.key] = { value: new THREE.Vector4(r, g, b, 1) }
          break
        }
        case 'vec2': {
          const arr = Array.isArray(v) ? v : [v, v]
          u['u_' + p.key] = { value: new THREE.Vector2(Number(arr[0]) || 0, Number(arr[1]) || 0) }
          break
        }
        case 'gradient': {
          const stops = Array.isArray(v) && v.length ? v : [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }]
          const n = Math.min(stops.length, MAX_GRADIENT_STOPS)
          const pos = new Float32Array(MAX_GRADIENT_STOPS)
          const cols = []
          for (let i = 0; i < MAX_GRADIENT_STOPS; i++) cols.push(new THREE.Vector4(0, 0, 0, 1))
          for (let i = 0; i < n; i++) {
            pos[i] = clamp(Number(stops[i].p) || 0, 0, 1)
            const [r, g, b] = hexToLinear(stops[i].c)
            cols[i] = new THREE.Vector4(r, g, b, 1)
          }
          u['u_' + p.key + '_count'] = { value: n }
          u['u_' + p.key + '_pos'] = { value: pos }
          u['u_' + p.key + '_col'] = { value: cols }
          break
        }
        default:
          break
      }
    }
    return u
  }

  renderQuad(material, target) {
    this.quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }

  // ---------------------------------------------------------------- evaluation
  evaluate(graph, opts = {}) {
    if (this.contextLost) throw new Error('WebGL context lost — reload the page')
    const t0 = performance.now()
    const res = Math.max(8, Math.round(opts.res || 1024))
    const streaming = !!opts.streaming
    const frame = ++this.frame
    const nodes = graph.nodes || []
    const connections = graph.connections || []
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const incoming = new Map()
    for (const c of connections) if (c && c.to && c.from) incoming.set(c.to.node + ':' + c.to.port, c)

    const explicitSinks = opts.sinks && opts.sinks.length ? opts.sinks : null
    const sinks = explicitSinks || nodes.filter((n) => NODE_MAP[n.type] && NODE_MAP[n.type].isOutput).map((n) => n.id)
    if (!sinks.length) throw new Error('Graph has no PBR Output node')

    const state = new Map()
    const order = []
    const hashes = new Map()
    let cycle = false

    const visit = (id) => {
      const st = state.get(id)
      if (st === 2) return
      if (st === 1) {
        cycle = true
        return
      }
      state.set(id, 1)
      const node = byId.get(id)
      const def = node && NODE_MAP[node.type]
      if (!node || !def) {
        state.set(id, 2)
        return
      }
      const inputHashes = []
      for (const inp of def.inputs || []) {
        const c = incoming.get(id + ':' + inp.name)
        if (c && byId.has(c.from.node)) {
          visit(c.from.node)
          inputHashes.push(hashes.get(c.from.node) || '')
        } else {
          inputHashes.push('-')
        }
      }
      let key = ''
      if (def.isOutput) {
        key = 'out|' + inputHashes.join(',')
      } else {
        const paintV = this.paintVersions.get(id) || 0
        const imgV = this.imageVersions.get(id) || 0
        key = [def.type, res + 'x' + res, stable(node.params || {}), inputHashes.join(','), paintV, imgV].join('|')
      }
      hashes.set(id, key)
      state.set(id, 2)
      order.push(id)
    }
    for (const s of sinks) visit(s)
    if (cycle) {
      this.stats.cycle = true
      throw new Error('Cycle detected in the node graph')
    }

    const reachable = new Set(order)
    const consumers = new Map()
    for (const c of connections) {
      if (reachable.has(c.from.node) && reachable.has(c.to.node)) {
        consumers.set(c.from.node, (consumers.get(c.from.node) || 0) + 1)
      }
    }

    const rts = new Map()
    this.lastOutputs = new Map()
    let cacheHits = 0
    let passes = 0
    const gl = this.renderer.getContext()

    for (const id of order) {
      const node = byId.get(id)
      const def = NODE_MAP[node.type]
      if (def.isOutput) {
        const channelTex = {}
        for (const inp of def.inputs) {
          const c = incoming.get(id + ':' + inp.name)
          const rt = c ? rts.get(c.from.node) : null
          channelTex[inp.name] = rt ? rt.texture : this.solidDefault(inp.def)
        }
        this.lastOutputs.set(id, channelTex)
        continue
      }

      const inputs = (def.inputs || []).map((inp) => {
        const c = incoming.get(id + ':' + inp.name)
        if (!c) return this.solidDefault(inp.def)
        const rt = rts.get(c.from.node)
        return rt ? rt.texture : this.solidDefault(inp.def)
      })

      const key = hashes.get(id)
      let rt = null
      const cached = streaming ? null : this.cache.get(key)
      if (cached && cached.w === res) {
        rt = cached.rt
        cached.stamp = frame
        cacheHits++
      } else {
        const passList = passesOf(def)
        let prevRt = null
        for (let pi = 0; pi < passList.length; pi++) {
          const out = this.acquire(res, res)
          const mat = this.getMaterial(def, pi)
          const uniforms = this.buildUniforms(def, node, pi, res, res, inputs, prevRt ? prevRt.texture : null)
          for (const k in uniforms) {
            const target = mat.uniforms[k]
            if (target) target.value = uniforms[k].value
          }
          this.renderQuad(mat, out)
          if (prevRt) this.release(prevRt)
          prevRt = out
          passes++
        }
        rt = prevRt
        if (!streaming) this.cache.set(key, { rt, w: res, stamp: frame })
      }
      rts.set(id, rt)

      if (streaming) {
        for (const inp of def.inputs || []) {
          const c = incoming.get(id + ':' + inp.name)
          if (!c) continue
          const src = c.from.node
          if (!reachable.has(src)) continue
          const n = (consumers.get(src) || 0) - 1
          consumers.set(src, n)
          if (n <= 0 && byId.get(src) && !NODE_MAP[byId.get(src).type].isOutput) {
            const dead = rts.get(src)
            if (dead) {
              this.release(dead)
              rts.delete(src)
            }
          }
        }
      }
    }

    if (!streaming) {
      // evict stale cache entries, keep memory bounded
      const cap = 96
      for (const [k, e] of this.cache) {
        if (e.stamp < frame - 2) {
          this.release(e.rt)
          this.cache.delete(k)
        }
      }
      if (this.cache.size > cap) {
        const sorted = [...this.cache.entries()].sort((a, b) => a[1].stamp - b[1].stamp)
        for (let i = 0; i < sorted.length - cap; i++) {
          this.release(sorted[i][1].rt)
          this.cache.delete(sorted[i][0])
        }
      }
    }

    const err = gl.getError()
    const ms = performance.now() - t0
    this.stats = {
      nodes: order.length,
      passes,
      evalMs: +ms.toFixed(1),
      cacheHits,
      cacheSize: this.cache.size,
      resolution: res,
      streaming,
      glError: err
    }
    const result = {
      rts,
      order,
      hashes,
      sinks,
      res,
      streaming,
      ms,
      cacheHits,
      outputs: this.lastOutputs
    }
    this.last = result
    return result
  }

  releaseResult(result) {
    if (!result) return
    for (const rt of result.rts.values()) this.release(rt)
    result.rts.clear()
    if (this.last === result) this.last = null
  }

  // ------------------------------------------------------------------ readback
  readTexture8(texture, size, opts = {}) {
    const rt = this.acquire(size, size, THREE.UnsignedByteType)
    const mode = opts.srgb ? 1 : 0
    this.encodeMaterial.uniforms.uTex.value = texture
    this.encodeMaterial.uniforms.uMode.value = mode
    this.encodeMaterial.uniforms.uFlipY.value = opts.flipY ? 1 : 0
    this.encodeMaterial.uniforms.uRes.value.set(size, size)
    this.encodeMaterial.uniforms.uPx.value.set(1 / size, 1 / size)
    this.renderQuad(this.encodeMaterial, rt)
    const buf = new Uint8Array(size * size * 4)
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf)
    this.release(rt)
    if (opts.flipRows !== false) flipRows(buf, size, size, 4)
    return buf
  }

  readTexture16(texture, size, opts = {}) {
    if (this.floatType !== THREE.FloatType) {
      // no float render targets available: 8-bit source up-converted (quality warning shown in UI)
      const b8 = this.readTexture8(texture, size, opts)
      const out8 = new Uint16Array(size * size * 4)
      for (let i = 0; i < out8.length; i++) out8[i] = b8[i] * 257
      return out8
    }
    const rt = this.acquire(size, size, this.floatType)
    this.encodeMaterial.uniforms.uTex.value = texture
    this.encodeMaterial.uniforms.uMode.value = opts.srgb ? 1 : 0
    this.encodeMaterial.uniforms.uFlipY.value = opts.flipY ? 1 : 0
    this.encodeMaterial.uniforms.uRes.value.set(size, size)
    this.encodeMaterial.uniforms.uPx.value.set(1 / size, 1 / size)
    this.renderQuad(this.encodeMaterial, rt)
    const f32 = new Float32Array(size * size * 4)
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, f32)
    this.release(rt)
    const out = new Uint16Array(size * size * 4)
    for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp(f32[i], 0, 1) * 65535)
    if (opts.flipRows !== false) {
      const row = size * 4
      const tmp = new Uint16Array(row)
      for (let y = 0; y < size >> 1; y++) {
        const a = y * row
        const b = (size - 1 - y) * row
        tmp.set(out.subarray(a, a + row))
        out.copyWithin(a, b, b + row)
        out.set(tmp, b)
      }
    }
    return out
  }

  // ----------------------------------------------------------------- thumbnails
  thumbFromRT(rt, srgb, size = THUMB) {
    const rt8 = this.acquire(size, size, THREE.UnsignedByteType)
    this.encodeMaterial.uniforms.uTex.value = rt.texture
    this.encodeMaterial.uniforms.uMode.value = srgb ? 1 : 0
    this.encodeMaterial.uniforms.uFlipY.value = 0
    this.encodeMaterial.uniforms.uRes.value.set(size, size)
    this.encodeMaterial.uniforms.uPx.value.set(1 / size, 1 / size)
    this.renderQuad(this.encodeMaterial, rt8)
    const buf = new Uint8Array(size * size * 4)
    this.renderer.readRenderTargetPixels(rt8, 0, 0, size, size, buf)
    this.release(rt8)
    flipRows(buf, size, size, 4)
    return this.bufToDataURL(buf, size, size)
  }

  bufToDataURL(buf, w, h) {
    if (this.thumbCanvas.width !== w || this.thumbCanvas.height !== h) {
      this.thumbCanvas.width = w
      this.thumbCanvas.height = h
    }
    const img = new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, w * h * 4), w, h)
    this.thumbCtx.putImageData(img, 0, 0)
    return this.thumbCanvas.toDataURL('image/png')
  }

  outputThumbnail(outputNodeId, size = THUMB) {
    const ch = this.lastOutputs.get(outputNodeId)
    if (!ch) return null
    const u = this.previewMaterial.uniforms
    u.uBaseColor.value = ch.basecolor || this.solid(0.5, 0.5, 0.5)
    u.uNormal.value = ch.normal || this.solid(0.5, 0.5, 1)
    u.uRoughness.value = ch.roughness || this.solid(0.5, 0.5, 0.5)
    u.uMetallic.value = ch.metallic || this.solid(0, 0, 0)
    u.uAO.value = ch.ao || this.solid(1, 1, 1)
    u.uHeight.value = ch.height || this.solid(0.5, 0.5, 0.5)
    u.uEmissive.value = ch.emissive || this.solid(0, 0, 0)
    u.uRes.value.set(size, size)
    u.uPx.value.set(1 / size, 1 / size)
    const rt8 = this.acquire(size, size, THREE.UnsignedByteType)
    this.renderQuad(this.previewMaterial, rt8)
    const buf = new Uint8Array(size * size * 4)
    this.renderer.readRenderTargetPixels(rt8, 0, 0, size, size, buf)
    this.release(rt8)
    flipRows(buf, size, size, 4)
    return this.bufToDataURL(buf, size, size)
  }

  buildThumbs(graph, result, size = THUMB) {
    if (!result) return
    const byId = new Map((graph.nodes || []).map((n) => [n.id, n]))
    let count = 0
    for (const id of result.order) {
      const node = byId.get(id)
      if (!node) continue
      const def = NODE_MAP[node.type]
      if (!def) continue
      const key = result.hashes.get(id)
      if (node._thumbKey === key && node._thumb) continue
      try {
        let url = null
        if (def.isOutput) {
          url = this.outputThumbnail(id, size)
        } else {
          const rt = result.rts.get(id)
          if (rt) url = this.thumbFromRT(rt, def.space === 'color', size)
        }
        if (url) {
          node._thumb = url
          node._thumbKey = key
          count++
        }
      } catch (e) {
        console.warn('thumb failed', node.type, e)
      }
    }
    return count
  }

  // ---------------------------------------------------------------- preview data
  previewMaps(size = 384) {
    const outNodeId = [...this.lastOutputs.keys()][0]
    const ch = this.lastOutputs.get(outNodeId)
    if (!ch) return null
    const maps = {}
    for (const key of ['basecolor', 'height', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity']) {
      const tex = ch[key]
      if (!tex) continue
      const srgb = key === 'basecolor' || key === 'emissive'
      const data = this.readTexture8(tex, size, { srgb, flipRows: false })
      maps[key] = { data, width: size, height: size }
    }
    return maps
  }

  mapDataURL(channelKey, size = 256, opts = {}) {
    const outNodeId = [...this.lastOutputs.keys()][0]
    const ch = this.lastOutputs.get(outNodeId)
    if (!ch || !ch[channelKey]) return null
    const data = this.readTexture8(ch[channelKey], size, { srgb: opts.srgb })
    return this.bufToDataURL(data, size, size)
  }

  // --------------------------------------------------------------------- export
  beginExport(graph, resolution) {
    const result = this.evaluate(graph, { res: resolution, streaming: true })
    const outputId = result.sinks[0]
    const channelTextures = this.lastOutputs.get(outputId) || {}
    return { result, resolution, outputId, channelTextures }
  }

  readExportChannel(session, key, opts = {}) {
    const tex = session.channelTextures[key]
    if (!tex) return null
    const size = session.resolution
    if (opts.bitDepth === 16) return this.readTexture16(tex, size, { srgb: opts.srgb, flipY: opts.flipY })
    return this.readTexture8(tex, size, { srgb: opts.srgb, flipY: opts.flipY })
  }

  endExport(session) {
    if (!session) return
    this.releaseResult(session.result)
    this.lastOutputs = new Map()
  }

  dispose() {
    this.disposePool()
    for (const m of this.materials.values()) m.dispose()
    this.materials.clear()
    for (const t of this.paintTextures.values()) t.dispose()
    this.paintTextures.clear()
    for (const t of this.imageTextures.values()) t.dispose()
    this.imageTextures.clear()
    this.renderer.dispose()
  }

  // --------------------------------------------------------------- shader audit
  validateShaders() {
    const gl = this.gl
    const results = []
    let checked = 0
    const vert = gl.createShader(gl.VERTEX_SHADER)
    gl.shaderSource(vert, '#version 300 es\n' + VERTEX_SRC)
    gl.compileShader(vert)
    const vertOk = gl.getShaderParameter(vert, gl.COMPILE_STATUS)
    for (const def of NODE_DEFS) {
      if (def.isOutput) continue
      passesOf(def).forEach((pass, pi) => {
        checked++
        const frag = gl.createShader(gl.FRAGMENT_SHADER)
        const src = '#version 300 es\n' + buildFragmentSource(def, pi)
        gl.shaderSource(frag, src)
        gl.compileShader(frag)
        const ok = gl.getShaderParameter(frag, gl.COMPILE_STATUS) && vertOk
        const log = gl.getShaderInfoLog(frag) || ''
        if (ok) {
          const prog = gl.createProgram()
          gl.attachShader(prog, vert)
          gl.attachShader(prog, frag)
          gl.linkProgram(prog)
          const linked = gl.getProgramParameter(prog, gl.LINK_STATUS)
          const linkLog = gl.getProgramInfoLog(prog) || ''
          gl.deleteProgram(prog)
          if (!linked) results.push({ type: def.type, pass: pi, ok: false, log: linkLog })
        } else {
          results.push({ type: def.type, pass: pi, ok: false, log })
        }
        gl.deleteShader(frag)
      })
    }
    gl.deleteShader(vert)
    const failures = results.filter((r) => !r.ok)
    return {
      total: checked + NODE_DEFS.filter((d) => d.isOutput).length,
      checked,
      failures,
      ok: failures.length === 0
    }
  }
}
