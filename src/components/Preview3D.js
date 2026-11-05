// ============================================================================
// Preview3D —— 3D 材质预览（Three.js 渲染窗口）
//
// 界面位置：主界面右侧/中央的 3D 预览区，显示可旋转的材质球/平面/立方体等模型。
//
// 与 engine 的交互：每次引擎烘焙完成（state.previewVersion 变化）后，从 previewStore.maps
// 取出各通道像素缓冲，重新构造 DataTexture 并挂到 MeshStandardMaterial 上；
// 输出节点的参数（法线约定、alpha 模式）决定法线翻转与透明/遮罩行为。
//
// 渲染循环：requestAnimationFrame 持续渲染；OrbitControls 负责拖拽旋转/缩放；
// ResizeObserver 跟随容器尺寸；环境光用 RoomEnvironment 经 PMREM 预烘焙成 IBL。
// 另外会在 window.__PREVIEW__ 上暴露调试/截图接口，供 MCP 工具取缩略图。
// ============================================================================
import { defineComponent, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { state, outputNode } from '../engine/store.js'
import { previewStore } from '../engine/preview.js'
import { SHAPES } from '../ui/theme.js'
import { t, trText } from '../i18n/index.js'

export default defineComponent({
  name: 'Preview3D',
  setup() {
    /** 容器 div，用于取尺寸并挂 ResizeObserver */
    const host = ref(null)
    /** 传给 WebGLRenderer 的 canvas */
    const canvasRef = ref(null)
    /** 当前模型形状 id（站方球/平面/立方体/圆柱/圆环） */
    const shape = ref('sphere')
    /** UV 平铺次数 1~4 */
    const tiling = ref(1)
    /** 高度图位移强度（相对模型尺寸） */
    const displacement = ref(0.012)
    /** 是否自动旋转 */
    const autoRotate = ref(true)
    // ---- Three.js 非响应式对象，用普通变量保存，避免被 Vue 深度代理 ----
    let renderer = null
    let scene = null
    let camera = null
    let controls = null
    let mesh = null
    let pmrem = null
    let envRT = null
    let material = null
    /** 动画帧句柄，卸载时用于取消 */
    let raf = 0
    /** 容器尺寸观察器 */
    let ro = null
    /** 当前材质上挂载的所有贴图，重建/卸载时需要逐个 dispose 释放显存 */
    let textures = []
    let currentShape = ''

    /** 顶部徽标文案：分辨率 + 通道数量；依赖 previewVersion 以便每次烘焙后刷新 */
    const badge = computed(() => {
      const out = outputNode()
      void state.previewVersion // 建立响应式依赖：每次烘焙后刷新通道计数
      const n = out ? Object.keys(previewStore.maps || {}).length : 0
      return t('preview.badge', { res: state.resolution, n })
    })

    /** 输出节点上的材质名（翻译后显示），为空时不显示徽标 */
    const materialName = computed(() => {
      const out = outputNode()
      const raw = out?.params?.materialName || ''
      return raw ? trText(raw) : ''
    })

    /**
     * 把某个通道的像素缓冲包装成 Three.js DataTexture。
     * @param {string} key previewStore.maps 中的通道键名
     * @param {boolean} srgb 是否按 sRGB 解释（颜色类贴图需要，数据类贴图不能）
     * @returns {THREE.DataTexture|null} 通道不存在时返回 null
     */
    function makeTexture(key, srgb, flipSource) {
      const m = previewStore.maps && previewStore.maps[key]
      if (!m) return null
      let data = m.data
      // 复制一份 buffer：DataTexture 持有引用，后续重新烘焙会复用同一缓冲导致画面错乱
      const tex = new THREE.DataTexture(new Uint8Array(data.buffer.slice(0)), m.width, m.height, THREE.RGBAFormat, THREE.UnsignedByteType)
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
      textures.push(tex)
      return tex
    }

    /** 释放当前所有贴图并清空列表（重建材质前调用） */
    function disposeTextures() {
      for (const t of textures) t.dispose()
      textures = []
    }

    /**
     * 依据 previewStore.maps 重建整套 PBR 贴图并重新绑定到材质。
     * 会先释放旧贴图；对透明材质还会把 opacity 通道合成进 basecolor 的 alpha。
     */
    function buildTextures() {
      if (!material || !previewStore.maps) return
      disposeTextures()
      const out = outputNode()
      const normalsDX = Number(out?.params?.normalConvention || 0) === 1
      const alphaMode = Number(out?.params?.alphaMode || 0)
      const base = makeTexture('basecolor', true)
      const normal = makeTexture('normal', false)
      const height = makeTexture('height', false)
      const rough = makeTexture('roughness', false)
      const metal = makeTexture('metallic', false)
      const ao = makeTexture('ao', false)
      const emis = makeTexture('emissive', true)
      const opacity = previewStore.maps.opacity

      if (base && opacity && alphaMode !== 0) {
        // 为混合 / 遮罩材质合成 alpha 通道：取 opacity 的 R 分量写进 basecolor 的 A
        const n = base.image.width * base.image.height
        const composed = new Uint8Array(base.image.data.length)
        composed.set(base.image.data)
        for (let i = 0; i < n; i++) composed[i * 4 + 3] = opacity.data[i * 4]
        base.image.data = composed
        base.needsUpdate = true
      }

      material.map = base
      material.normalMap = normal
      // DirectX 与 OpenGL 的绿通道方向相反，通过翻转 Y 缩放来适配
      material.normalScale.set(1, normalsDX ? -1 : 1)
      material.displacementMap = height
      material.displacementScale = displacement.value
      // 位移以中值为基准向两侧展开，避免模型整体膨胀
      material.displacementBias = -displacement.value * 0.5
      material.roughnessMap = rough
      material.metalnessMap = metal
      material.aoMap = ao
      material.aoMapIntensity = 1
      material.emissiveMap = emis
      material.emissive = new THREE.Color(emis ? 0xffffff : 0x000000)
      material.emissiveIntensity = 1
      material.transparent = alphaMode === 2
      material.alphaTest = alphaMode === 1 ? 0.5 : 0
      material.needsUpdate = true
      // 给所有贴图加一点偏移，避免平铺接缝正好落在模型轮廓线上
      for (const t of textures) t.offset.set(0.17, 0.09)
      applyTiling()
    }

    /** 把 tiling 同步到所有贴图的 repeat，并触发材质重编译 */
    function applyTiling() {
      for (const t of textures) {
        t.repeat.set(tiling.value, tiling.value)
        t.needsUpdate = true
      }
      if (material) material.needsUpdate = true
    }

    /**
     * 按形状 id 生成几何体；分段数给得较高，以便高度图位移有足够顶点表现细节。
     * @param {string} kind 形状 id
     * @returns {THREE.BufferGeometry}
     */
    function makeGeometry(kind) {
      switch (kind) {
        case 'plane':
          return new THREE.PlaneGeometry(2.6, 2.6, 300, 300)
        case 'cube':
          return new THREE.BoxGeometry(1.75, 1.75, 1.75, 96, 96, 96)
        case 'cylinder':
          return new THREE.CylinderGeometry(1, 1, 1.9, 220, 120)
        case 'torus':
          return new THREE.TorusGeometry(0.92, 0.38, 110, 220)
        default:
          return new THREE.SphereGeometry(1.12, 256, 180)
      }
    }

    /**
     * 切换预览模型：移除旧 mesh 并释放其几何体，创建新几何体后重置视角。
     * @param {string} kind 形状 id
     */
    function setShape(kind) {
      if (!scene || !material) return
      if (mesh) {
        scene.remove(mesh)
        mesh.geometry.dispose()
      }
      const geometry = makeGeometry(kind)
      // AO 贴图使用 uv1；同时保留 uv2 以兼容旧引擎/旧版本 Three.js
      if (geometry.attributes.uv) {
        if (!geometry.attributes.uv1) geometry.setAttribute('uv1', geometry.attributes.uv.clone())
        if (!geometry.attributes.uv2) geometry.setAttribute('uv2', geometry.attributes.uv.clone())
      }
      mesh = new THREE.Mesh(geometry, material)
      // 位移会让顶点超出原始包围盒，关闭视锥剔除以免模型被误裁掉
      mesh.frustumCulled = false
      if (kind === 'plane') {
        mesh.rotation.x = -Math.PI / 2
        mesh.position.y = -0.55
        mesh.scale.setScalar(1.05)
      }
      scene.add(mesh)
      currentShape = kind
      resetView()
    }

    /** 把相机与控制器恢复到该形状的默认机位 */
    function resetView() {
      if (!camera || !controls) return
      const poses = {
        sphere: [0, 0.55, 4.0],
        plane: [0, 3.1, 2.6],
        cube: [3.0, 2.4, 3.0],
        cylinder: [0, 1.0, 3.9],
        torus: [0, 1.2, 3.6]
      }
      const p = poses[shape.value] || poses.sphere
      camera.position.set(p[0], p[1], p[2])
      controls.target.set(0, 0, 0)
      controls.update()
    }

    /** 容器尺寸变化时同步渲染尺寸与相机宽高比 */
    function resize() {
      if (!renderer || !host.value) return
      const w = host.value.clientWidth || 1
      const h = host.value.clientHeight || 1
      renderer.setSize(w, h, false)
      if (camera) {
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
    }

    /** 渲染循环：每帧先排下一帧，自动旋转时绕 Y 轴转动模型，再交给控制器与渲染器 */
    function animate() {
      raf = requestAnimationFrame(animate)
      if (!renderer) return
      if (autoRotate.value && mesh) mesh.rotation.y += 0.0035
      controls.update()
      renderer.render(scene, camera)
    }

    onMounted(() => {
      // ---- 渲染器：透明背景 + 保留绘图缓冲（便于截图） ----
      renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true, alpha: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05

      // ---- 场景与透视相机 ----
      scene = new THREE.Scene()
      camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60)
      camera.position.set(0, 0.5, 3.5)

      // ---- 轨道控制器：阻尼、限制缩放范围、禁用平移（只允许旋转/缩放） ----
      controls = new OrbitControls(camera, canvasRef.value)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = 1.4
      controls.maxDistance = 12
      controls.enablePan = false

      // ---- 环境光照：RoomEnvironment 场景经 PMREM 预卷积成 IBL 贴图 ----
      pmrem = new THREE.PMREMGenerator(renderer)
      envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
      scene.environment = envRT.texture
      scene.environmentIntensity = 0.85

      // ---- 三盏方向灯：主光（暖）、轮廓光（冷）、补光 ----
      const key = new THREE.DirectionalLight(0xfff2e0, 2.4)
      key.position.set(3.2, 4.2, 2.6)
      scene.add(key)
      const rim = new THREE.DirectionalLight(0x9fc3ff, 1.6)
      rim.position.set(-3.4, 1.4, -2.4)
      scene.add(rim)
      const fill = new THREE.DirectionalLight(0xffffff, 0.5)
      fill.position.set(0, -2, 1.5)
      scene.add(fill)

      // ---- 材质：roughness/metalness 初始拉满，随后由各贴图调制 ----
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 1,
        metalness: 1,
        envMapIntensity: 0.9
      })
      setShape('sphere')
      buildTextures()
      resize()
      // 把材质球渲染成 PNG 截图，供 MCP 工具 substrate_get_preview 使用
      function capture(size = 256) {
        try {
          renderer.render(scene, camera)
          const src = renderer.domElement
          const scale = Math.min(1, Number(size) / Math.max(src.width, src.height))
          const w = Math.max(16, Math.round(src.width * scale))
          const h = Math.max(16, Math.round(src.height * scale))
          const out = document.createElement('canvas')
          out.width = w
          out.height = h
          out.getContext('2d').drawImage(src, 0, 0, w, h)
          return out.toDataURL('image/png')
        } catch (e) {
          console.warn('[preview] capture failed', e)
          return null
        }
      }
      // 暴露给自动化/调试工具：可切换形状、重建贴图、调整位移、截图
      window.__PREVIEW__ = {
        renderer,
        capture,
        scene,
        camera,
        material,
        controls,
        getMesh: () => mesh,
        setShape,
        buildTextures,
        setDisplacement: (v) => {
          material.displacementScale = v
          material.displacementBias = -v * 0.5
          material.needsUpdate = true
        }
      }
      // 容器尺寸变化时重设渲染尺寸与相机比例
      ro = new ResizeObserver(resize)
      if (host.value) ro.observe(host.value)
      animate()
    })

    // 每次烘焙完成重建贴图
    watch(() => state.previewVersion, () => buildTextures())
    // 下拉切换形状
    watch(shape, (v) => setShape(v))
    // 平铺次数变化
    watch(tiling, () => applyTiling())
    // 位移强度变化：同步缩放与 bias
    watch(displacement, (v) => {
      if (material) {
        material.displacementScale = v
        material.displacementBias = -v * 0.5
        material.needsUpdate = true
      }
    })
    // alpha 模式变化会影响是否合成 alpha 通道，需要重建贴图
    watch(
      () => outputNode()?.params?.alphaMode,
      () => buildTextures()
    )

    onBeforeUnmount(() => {
      // 逆序释放所有 Three.js 资源，避免显卡显存泄漏
      cancelAnimationFrame(raf)
      if (ro) ro.disconnect()
      disposeTextures()
      if (mesh) mesh.geometry.dispose()
      if (material) material.dispose()
      if (envRT) envRT.dispose()
      if (pmrem) pmrem.dispose()
      if (controls) controls.dispose()
      if (renderer) renderer.dispose()
    })

    return { host, canvasRef, shape, tiling, displacement, autoRotate, SHAPES, badge, materialName, resetView }
  },
  template: `
    <div class="preview panel">
      <!-- 面板头：标题与形状下拉框 -->
      <div class="panel-head">
        <span>{{ $t('preview.title') }}</span>
        <select v-model="shape" class="shape-select" style="background: var(--bg0); border: 1px solid var(--line); border-radius: 4px; font-size: 10px; padding: 2px 4px; text-transform: none; letter-spacing: 0">
          <option v-for="s in SHAPES" :key="s.id" :value="s.id">{{ $tr(s.label) }}</option>
        </select>
      </div>
      <div class="preview-body" ref="host">
        <canvas ref="canvasRef"></canvas>
        <!-- 叠加信息：通道徽标、材质名，以及平铺/位移/自动旋转/重置控件 -->
        <div class="preview-overlay">
          <div class="row">
            <span class="badge">{{ badge }}</span>
            <span class="badge" v-if="materialName">{{ materialName }}</span>
          </div>
          <div class="row">
            <div class="preview-tools">
              <label>{{ $t('preview.tiling') }}</label>
              <input type="range" min="1" max="4" step="1" v-model.number="tiling" />
              <label>{{ $t('preview.displace') }}</label>
              <input type="range" min="0" max="0.2" step="0.005" v-model.number="displacement" />
              <button class="mini" @click="autoRotate = !autoRotate">{{ autoRotate ? $t('preview.pause') : $t('preview.spin') }}</button>
              <button class="mini" @click="resetView">{{ $t('preview.reset') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
})
