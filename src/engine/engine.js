/**
 * GPU 图求值引擎：节点式 PBR 贴图设计器的渲染核心。
 *
 * 设计要点：
 * - 每个节点都被编译成一段 GLSL 片元着色器，通过一个覆盖全屏的四边形渲染到 RGBA16F 的 RenderTarget；
 *   所有中间结果都以「线性光（linear light）」保存，只在最终导出/显示时做 sRGB 编码。
 * - 节点结果按「结构哈希」（节点类型 + 分辨率 + 参数 + 上游哈希 + 外部资源版本）缓存，
 *   因此只有真正发生变化的脏分支才会重新渲染，交互式调参时开销很低。
 * - RenderTarget 采用池化管理（acquire/release），避免每帧反复分配显存。
 * - 导出时使用 streaming 模式：算完即释放上游纹理，避免高分辨率导出把显存撑爆。
 *
 * 主要导出：TextureEngine（渲染/预览/导出/缩略图/着色器审计）。
 */
import * as THREE from 'three'
import { t } from '../i18n/index.js'
import { VERTEX_SRC, PREVIEW_GLSL, COMMON_GLSL } from './glsl.js'
import { buildFragmentSource, passesOf, ENCODE_FRAG } from './compiler.js'
import { NODE_DEFS, NODE_MAP, resolveParams } from './nodes/index.js'
import { hexToLinear, clamp } from './color.js'

// 渐变最多支持的色标数量（同时决定了着色器里 uniform 数组的长度）
const MAX_GRADIENT_STOPS = 8
// 节点缩略图的默认边长（像素）
const THUMB = 96

/**
 * 把任意值序列化成「键顺序稳定」的字符串。
 * 用于生成节点缓存哈希：对象键经过排序，保证同样的参数内容永远得到同一个字符串，
 * 不受属性插入顺序影响。数组、对象与基本类型分别递归处理。
 */
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

/**
 * 就地（in-place）上下翻转一张像素缓冲。
 * WebGL 的 readRenderTargetPixels 起点在左下角，而 PNG/ImageData 以左上角为原点，
 * 因此回读后通常需要翻转。函数直接修改传入的 TypedArray 并返回它。
 */
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

/**
 * 基于 Three.js 的 GPU 节点图求值器。
 *
 * 一个实例对应页面上的一个隐藏 WebGL 上下文；它负责：
 * - 节点材质（RawShaderMaterial）的创建与复用；
 * - RenderTarget 池与哈希缓存；
 * - 图求值（evaluate）、回读像素、生成缩略图与预览；
 * - 导出会话（beginExport/readExportChannel/endExport）与着色器编译审计。
 *
 * 所有渲染都是「一个全屏 quad + 节点片元着色器」，因此不需要相机变换或几何体。
 */
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

    // 探测浮点渲染能力：优先使用 16F 渲染目标保存中间结果（避免 8 位量化造成的色阶）；
    // 完全不支持浮点颜色缓冲时退回 8 位，UI 会据此提示精度降级。
    this.extFloat = this.gl.getExtension('EXT_color_buffer_float')
    this.extHalf = this.gl.getExtension('EXT_color_buffer_half_float')
    this.rtType = this.extFloat || this.extHalf ? THREE.HalfFloatType : THREE.UnsignedByteType
    this.floatType = this.extFloat ? THREE.FloatType : this.rtType
    this.isFloat = this.rtType !== THREE.UnsignedByteType

    // 全屏四边形：正交相机固定 -1..1，平面几何体尺寸 2×2，正好铺满 NDC 空间。
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial())
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    // 各类资源容器：
    // pools       —— 按「尺寸:类型」分组的 RenderTarget 空闲池
    // cache       —— 结构哈希 → 节点渲染结果
    // materials   —— 「节点类型:pass」→ 已编译材质
    // solids      —— 1×1 纯色纹理缓存（用于未连接输入口的默认值）
    // paint/image —— 绘制层与外部图片节点的纹理及版本号（版本号参与缓存哈希）
    this.pools = new Map()
    this.cache = new Map()
    this.cacheRts = new Set()
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

    // 对外暴露的能力信息，供 UI 判断是否显示「浮点渲染不可用」等警告
    this.ext = {
      floatRender: this.gl.getExtension('EXT_color_buffer_float') !== null,
      halfFilter: true,
      maxTexture: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)
    }

    // 编码材质：把线性浮点结果转成 8 位 / sRGB，并可选翻转 Y，用于回读与缩略图。
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

    // 预览材质：把 7 张 PBR 通道贴图合成一个「带光照的材质球」，用于输出节点缩略图。
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

    // 缩略图借用一张 2D canvas 做「像素 → dataURL」中转，避免额外的编码库
    this.thumbCanvas = document.createElement('canvas')
    this.thumbCanvas.width = THUMB
    this.thumbCanvas.height = THUMB
    this.thumbCtx = this.thumbCanvas.getContext('2d', { willReadFrequently: true })

    // 上下文丢失：阻止默认行为以允许浏览器后续恢复；置位标志后 evaluate() 会抛错而不是渲染黑图
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.contextLost = true
    })
  }

  /**
   * 拼装「材质球预览」的完整片元着色器源码。
   * 复用 COMMON_GLSL（线性/sRGB 转换等工具函数）与 PREVIEW_GLSL（着色函数 shadePreview）。
   * 圆形裁剪（step(dot(p,p), 1.0)）把方形画布外缘裁掉，使缩略图呈现为球体。
   */
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
  /**
   * 创建一个渲染目标（RGBA、双线性过滤、Repeat 环绕，无深度/模板缓冲）。
   * 关闭 mipmap 以节省显存并避免不必要的采样开销；颜色空间设为 NoColorSpace，
   * 保证引擎内部的数值始终保持线性，不做隐式转换。
   */
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

  /**
   * 从池中取出（或新建）一个指定尺寸/类型的 RenderTarget。
   * 尺寸向下取整并限制最小为 4，避免 0 尺寸导致的 framebuffer 创建失败。
   */
  acquire(w, h, type = this.rtType) {
    w = Math.max(4, Math.round(w))
    h = Math.max(4, Math.round(h))
    const key = `${w}x${h}:${type}`
    const list = this.pools.get(key)
    if (list && list.length) return list.pop()
    return this.createRT(w, h, type)
  }

  /**
   * 把 RenderTarget 归还到池中以便复用。
   * 同一「尺寸:类型」最多保留 12 个空闲对象，超出部分直接 dispose，防止显存无限增长。
   */
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

  /** 清空结构哈希缓存：释放其占用的 RenderTarget 并解除引用。 */
  clearCache() {
    for (const e of this.cache.values()) this.release(e.rt)
    for (const e of this.cache.values()) this.cacheRts.delete(e.rt)
    this.cache.clear()
  }

  /** 彻底销毁所有池化对象与缓存（用于页面卸载或上下文重建）。 */
  disposePool() {
    for (const list of this.pools.values()) for (const rt of list) rt.dispose()
    this.pools.clear()
    for (const e of this.cache.values()) e.rt.dispose()
    this.cache.clear()
  }

  /**
   * 获取（并缓存）一张 1×1 的纯色纹理，颜色值按 0..1 归一化。
   * 用于输入口未连接时的默认值；相同颜色只创建一次，节省纹理对象与显存。
   */
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

  /**
   * 根据输入口定义的默认值（标量或 [r,g,b] / [r,g,b,a]）生成对应的纯色纹理。
   * def 缺省时使用 0.5 灰，保证未连接输入口也有合理的可视化结果。
   */
  solidDefault(def) {
    const d = def === undefined ? 0.5 : def
    if (Array.isArray(d)) return this.solid(d[0] ?? 0.5, d[1] ?? 0.5, d[2] ?? 0.5, d[3] ?? 1)
    return this.solid(d, d, d, 1)
  }

  /** 全透明纹理（RGBA 均为 0），用作绘制层为空时的占位。 */
  transparent() {
    return this.solid(0, 0, 0, 0)
  }

  /** 延迟创建一张 256×256 的棋盘格纹理，作为 Image Input 节点的「无图片」占位。 */
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

  /** 取出某个绘制节点的纹理；尚未创建时返回全透明纹理。 */
  getPaintTexture(nodeId) {
    return this.paintTextures.get(nodeId) || this.transparent()
  }

  /**
   * 绑定绘制节点的画布到纹理。
   * 已存在纹理时只替换 image 并标记更新（复用 GPU 纹理对象）；否则新建 CanvasTexture。
   * 纹理统一设置 Repeat 环绕、无 mipmap、NoColorSpace，保证绘制内容按线性数值参与运算。
   */
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

  /**
   * 标记绘制纹理已更新，并递增版本号。
   * 版本号会进入节点结构哈希，从而让下游节点缓存失效、重新渲染。
   */
  touchPaint(nodeId) {
    const tex = this.paintTextures.get(nodeId)
    if (tex) tex.needsUpdate = true
    this.paintVersions.set(nodeId, (this.paintVersions.get(nodeId) || 0) + 1)
  }

  /** 删除绘制节点的纹理与版本记录（节点被删除时调用）。 */
  removePaint(nodeId) {
    const tex = this.paintTextures.get(nodeId)
    if (tex) tex.dispose()
    this.paintTextures.delete(nodeId)
    this.paintVersions.delete(nodeId)
  }

  /** 绑定外部图片节点的画布（逻辑与 setPaintCanvas 一致，只是存放在独立的 image 表中）。 */
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
  /**
   * 取得节点定义某个 pass 的材质，按「类型:pass」缓存。
   * 首次调用时用 buildFragmentSource 编译着色器，并先用占位 uniform 构造材质；
   * 真正求值时会逐个覆写 uniform 值（见 evaluate），因此这里只需保证结构完整。
   */
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

  /**
   * 为一次渲染构造 uniform 值表。
   * - uRes/uPx：目标分辨率与像素步长，供着色器做坐标/采样偏移；
   * - 每个输入口对应 uIn_<name>；
   * - 多 pass 节点从第二个 pass 起额外传入 uPrev（上一 pass 的结果）；
   * - paint/image 节点绑定对应外部纹理；
   * - 参数按类型映射为对应的 GLSL uniform（角度转弧度、颜色转线性空间、渐变拆成三个数组）。
   *
   * @param {object} def 节点定义
   * @param {object} node 图节点实例（提供 id 与 params）
   * @param {number} passIndex 当前 pass 序号
   * @param {number} w 渲染宽度
   * @param {number} h 渲染高度
   * @param {THREE.Texture[]} inputTextures 与 def.inputs 顺序一致的输入纹理
   * @param {THREE.Texture|null} prevTexture 上一 pass 的结果纹理
   */
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
          // UI 以角度（0..360）编辑，着色器统一使用弧度
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
          // 颜色参数以 sRGB 十六进制保存，传入 GPU 前必须转为线性光
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
          // 渐变以「固定长度数组」上传：多余的槽位填 0，实际参与计算的只有前 n 个色标，
          // 这样 uniform 数组长度在编译期固定，避免每种渐变都触发一次着色器重编译。
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

  /** 用给定材质渲染一次全屏 quad 到 target（target 为 null 时渲染到画布）。 */
  renderQuad(material, target) {
    this.quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }

  // ---------------------------------------------------------------- evaluation
  /**
   * 求值整张节点图，返回本次求值结果。
   *
   * 流程：
   * 1. 从所有输出节点（或 opts.sinks 指定的节点）出发做 DFS，得到拓扑顺序；
   *    同时检测环（遇到「访问中」的节点即判定有环并抛错）。
   * 2. 逆着输入边计算每个节点的「结构哈希」，哈希相同则命中缓存直接复用 RenderTarget。
   * 3. 按拓扑序逐个渲染节点；每个 pass 渲染到新 RT，上一 pass 的结果在下一 pass 使用后释放。
   * 4. 输出节点本身不渲染，只把各输入通道的纹理收集到 lastOutputs。
   * 5. streaming 模式下不写缓存，并在下游全部消费完后立即释放上游 RT，控制峰值显存。
   *
   * @param {{nodes: object[], connections: object[]}} graph 图数据
   * @param {{res?: number, streaming?: boolean, sinks?: string[]}} [opts]
   * @returns {{rts: Map, order: string[], hashes: Map, sinks: string[], res: number, streaming: boolean, ms: number, cacheHits: number, outputs: Map}}
   * @throws {Error} 上下文丢失、没有输出节点、图中存在环时抛出（错误文案经 i18n 翻译）
   */
  evaluate(graph, opts = {}) {
    if (this.contextLost) throw new Error(t('error.contextLost'))
    const t0 = performance.now()
    const res = Math.max(8, Math.round(opts.res || 1024))
    const streaming = !!opts.streaming
    const frame = ++this.frame
    const nodes = graph.nodes || []
    const connections = graph.connections || []
    const byId = new Map(nodes.map((n) => [n.id, n]))
    // incoming: "节点id:输入口名" → 连线，便于 O(1) 查询某个输入口连接了谁
    const incoming = new Map()
    for (const c of connections) if (c && c.to && c.from) incoming.set(c.to.node + ':' + c.to.port, c)

    const explicitSinks = opts.sinks && opts.sinks.length ? opts.sinks : null
    const sinks = explicitSinks || nodes.filter((n) => NODE_MAP[n.type] && NODE_MAP[n.type].isOutput).map((n) => n.id)
    if (!sinks.length) throw new Error(t('error.noOutput'))

    // state: 0/未访问、1/访问中（用于环检测）、2/已完成
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
        // 输出节点不渲染，只需记录上游通道哈希：上游任何变化都会导致其「结果」变化
        key = 'out|' + inputHashes.join(',')
      } else {
        // 结构哈希的组成：节点类型 + 分辨率 + 参数 + 上游哈希 + 绘制/图片资源版本号。
        // 任一项变化都会让缓存失效，从而只重算受影响的节点。
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
      throw new Error(t('error.cycle'))
    }

    // 统计每个中间节点的「消费者数量」，streaming 模式下用于判断何时可以提前释放纹理
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
        // 未连接时使用该输入口定义的默认纯色，保证着色器始终能采到有效纹理
        if (!c) return this.solidDefault(inp.def)
        const rt = rts.get(c.from.node)
        return rt ? rt.texture : this.solidDefault(inp.def)
      })

      const key = hashes.get(id)
      let rt = null
      // streaming 模式刻意跳过缓存，避免导出时缓存持有全部高分辨率结果
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
          // Three.js 的材质 uniform 对象复用：只更新 value，不重建材质，避免每帧重新编译
          for (const k in uniforms) {
            const target = mat.uniforms[k]
            if (target) target.value = uniforms[k].value
          }
          this.renderQuad(mat, out)
          // 上一 pass 已作为 uniform 采样完毕，可以立即归还到池中
          if (prevRt) this.release(prevRt)
          prevRt = out
          passes++
        }
        rt = prevRt
        if (!streaming) {
          this.cache.set(key, { rt, w: res, stamp: frame })
          this.cacheRts.add(rt)
        }
      }
      rts.set(id, rt)

      if (streaming) {
        // streaming：每消费完一个上游节点就把它的消费者计数减一，减到 0 时立即释放显存
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
      // 缓存淘汰：连续 2 帧未被使用的条目直接回收；随后再按「最近最少使用」把总量压到上限 96
      const cap = 96
      for (const [k, e] of this.cache) {
        if (e.stamp < frame - 2) {
          this.cacheRts.delete(e.rt)
          this.release(e.rt)
          this.cache.delete(k)
        }
      }
      if (this.cache.size > cap) {
        const sorted = [...this.cache.entries()].sort((a, b) => a[1].stamp - b[1].stamp)
        for (let i = 0; i < sorted.length - cap; i++) {
          this.cacheRts.delete(sorted[i][1].rt)
          this.release(sorted[i][1].rt)
          this.cache.delete(sorted[i][0])
        }
      }
    }

    // 读取 GL 错误码并写入统计：非 0 通常意味着显存/着色器执行出了问题，UI 可据此提示
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

  /**
   * 释放一次求值结果持有的 RenderTarget。
   * 已被普通缓存引用的纹理不归还（否则会破坏缓存），其余全部回池；
   * 同时把 last 指针清空，避免继续引用已释放的对象。
   */
  releaseResult(result) {
    if (!result) return
    for (const rt of result.rts.values()) {
      if (this.cacheRts && this.cacheRts.has(rt)) continue
      this.release(rt)
    }
    result.rts.clear()
    if (this.last === result) this.last = null
  }

  // ------------------------------------------------------------------ readback
  /**
   * 把浮点/线性纹理回读为 8 位 RGBA 缓冲。
   * 借助 encodeMaterial 完成「可选 sRGB 编码 + 可选 Y 翻转」，再 readRenderTargetPixels 取像素。
   * opts.flipRows 默认为 true，因为 GL 原点在左下角而 PNG 原点在左上角。
   *
   * @returns {Uint8Array} 长度 size×size×4 的 RGBA 数据
   */
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

  /**
   * 回读为 16 位无符号整数（0..65535），用于 16-bit 高度图导出。
   * 优先使用 Float32 渲染目标读回真实浮点值；若硬件不支持浮点颜色缓冲，
   * 则退化为 8 位读回再乘以 257 放大（对应 8bit→16bit 的位映射，精度有限）。
   *
   * @returns {Uint16Array} 长度 size×size×4
   */
  readTexture16(texture, size, opts = {}) {
    if (this.floatType !== THREE.FloatType) {
      // 当前设备没有浮点颜色缓冲：只能把 8 位结果放大到 16 位，精度仍为 8 位（UI 会提示质量降级）
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
  /**
   * 从任意节点的 RenderTarget 生成缩略图 dataURL。
   * srgb 决定是否做 sRGB 编码（颜色通道需要，数据通道不需要）。
   */
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

  /**
   * 把 RGBA 像素缓冲写入缩略图 canvas 并导出为 PNG dataURL。
   * 复用同一张 canvas 以减少内存分配；尺寸变化时才重设画布大小。
   */
  bufToDataURL(buf, w, h) {
    if (this.thumbCanvas.width !== w || this.thumbCanvas.height !== h) {
      this.thumbCanvas.width = w
      this.thumbCanvas.height = h
    }
    const img = new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, w * h * 4), w, h)
    this.thumbCtx.putImageData(img, 0, 0)
    return this.thumbCanvas.toDataURL('image/png')
  }

  /**
   * 生成输出节点的「材质球」缩略图：把 7 个 PBR 通道交给 previewMaterial 合成。
   * 缺失的通道用中性默认值补齐（法线 (0.5,0.5,1)、AO 1、金属度 0 等）。
   */
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

  /**
   * 为本次求值涉及的节点刷新缩略图。
   * 用节点的结构哈希判断是否需要重画：哈希未变且已有缩略图时直接跳过，
   * 避免每次调参都重新回读全部节点像素。
   * @returns {number} 本次实际生成的缩略图数量
   */
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
  /**
   * 回读第一个输出节点的全部通道，供 2D/3D 预览面板使用。
   * basecolor 与 emissive 按 sRGB 编码，其余通道保持线性原始数值；
   * flipRows:false 表示保留 GL 的左下角原点——预览面板把数据作为 DataTexture 上传
   * （其默认 flipY=false），因此翻转反而会让预览上下颠倒。
   *
   * @returns {Record<string, {data: Uint8Array, width: number, height: number}>|null}
   */
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

  /** 把某个通道回读并转成 PNG dataURL（供单通道 2D 预览使用）。 */
  mapDataURL(channelKey, size = 256, opts = {}) {
    const outNodeId = [...this.lastOutputs.keys()][0]
    const ch = this.lastOutputs.get(outNodeId)
    if (!ch || !ch[channelKey]) return null
    const data = this.readTexture8(ch[channelKey], size, { srgb: opts.srgb })
    return this.bufToDataURL(data, size, size)
  }

  // --------------------------------------------------------------------- export
  /**
   * 开启一次导出会话。
   * 使用 streaming 求值以限制显存峰值，并把输出节点的通道纹理快照保存到会话对象，
   * 之后 readExportChannel 可以按需、按位深逐个通道回读。
   *
   * 注意：调用方必须在 finally 中调用 endExport 释放会话，否则高分辨率纹理不会被回收。
   */
  beginExport(graph, resolution) {
    const result = this.evaluate(graph, { res: resolution, streaming: true })
    const outputId = result.sinks[0]
    const channelTextures = this.lastOutputs.get(outputId) || {}
    return { result, resolution, outputId, channelTextures }
  }

  /**
   * 回读导出会话中的某个通道。
   * opts.bitDepth === 16 时返回 Uint16Array，否则返回 Uint8Array；
   * opts.srgb 控制颜色通道是否做 sRGB 编码；opts.flipY 用于法线贴图的 DirectX/OpenGL 约定转换。
   */
  readExportChannel(session, key, opts = {}) {
    const tex = session.channelTextures[key]
    if (!tex) return null
    const size = session.resolution
    if (opts.bitDepth === 16) return this.readTexture16(tex, size, { srgb: opts.srgb, flipY: opts.flipY })
    return this.readTexture8(tex, size, { srgb: opts.srgb, flipY: opts.flipY })
  }

  /** 结束导出会话：释放 streaming 求值产生的高分辨率纹理并清空通道快照。 */
  endExport(session) {
    if (!session) return
    this.releaseResult(session.result)
    this.lastOutputs = new Map()
  }

  /** 释放引擎持有的全部资源；之后该实例不可再用（需重新构造）。 */
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
  /**
   * 着色器自检：逐个编译所有节点定义的每个 pass，并尝试链接成完整程序。
   * 用于在没有真实渲染的情况下提前发现 GLSL 编译/链接错误（例如某个节点的着色器写错）。
   *
   * @returns {{total: number, checked: number, failures: object[], ok: boolean}}
   *   failures 中每项包含 type/pass/ok/log，便于定位出错节点。
   */
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
