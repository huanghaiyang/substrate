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
    const host = ref(null)
    const canvasRef = ref(null)
    const shape = ref('sphere')
    const tiling = ref(1)
    const displacement = ref(0.012)
    const autoRotate = ref(true)
    let renderer = null
    let scene = null
    let camera = null
    let controls = null
    let mesh = null
    let pmrem = null
    let envRT = null
    let material = null
    let raf = 0
    let ro = null
    let textures = []
    let currentShape = ''

    const badge = computed(() => {
      const out = outputNode()
      void state.previewVersion // reactive dependency: refresh the channel count after every bake
      const n = out ? Object.keys(previewStore.maps || {}).length : 0
      return t('preview.badge', { res: state.resolution, n })
    })

    const materialName = computed(() => {
      const out = outputNode()
      const raw = out?.params?.materialName || ''
      return raw ? trText(raw) : ''
    })

    function makeTexture(key, srgb, flipSource) {
      const m = previewStore.maps && previewStore.maps[key]
      if (!m) return null
      let data = m.data
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

    function disposeTextures() {
      for (const t of textures) t.dispose()
      textures = []
    }

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
        // compose alpha channel for blended / masked materials
        const n = base.image.width * base.image.height
        const composed = new Uint8Array(base.image.data.length)
        composed.set(base.image.data)
        for (let i = 0; i < n; i++) composed[i * 4 + 3] = opacity.data[i * 4]
        base.image.data = composed
        base.needsUpdate = true
      }

      material.map = base
      material.normalMap = normal
      material.normalScale.set(1, normalsDX ? -1 : 1)
      material.displacementMap = height
      material.displacementScale = displacement.value
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
      for (const t of textures) t.offset.set(0.17, 0.09)
      applyTiling()
    }

    function applyTiling() {
      for (const t of textures) {
        t.repeat.set(tiling.value, tiling.value)
        t.needsUpdate = true
      }
      if (material) material.needsUpdate = true
    }

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

    function setShape(kind) {
      if (!scene || !material) return
      if (mesh) {
        scene.remove(mesh)
        mesh.geometry.dispose()
      }
      const geometry = makeGeometry(kind)
      // AO map uses uv1; also keep uv2 for older engines
      if (geometry.attributes.uv) {
        if (!geometry.attributes.uv1) geometry.setAttribute('uv1', geometry.attributes.uv.clone())
        if (!geometry.attributes.uv2) geometry.setAttribute('uv2', geometry.attributes.uv.clone())
      }
      mesh = new THREE.Mesh(geometry, material)
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

    function animate() {
      raf = requestAnimationFrame(animate)
      if (!renderer) return
      if (autoRotate.value && mesh) mesh.rotation.y += 0.0035
      controls.update()
      renderer.render(scene, camera)
    }

    onMounted(() => {
      renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true, alpha: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05

      scene = new THREE.Scene()
      camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60)
      camera.position.set(0, 0.5, 3.5)

      controls = new OrbitControls(camera, canvasRef.value)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = 1.4
      controls.maxDistance = 12
      controls.enablePan = false

      pmrem = new THREE.PMREMGenerator(renderer)
      envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
      scene.environment = envRT.texture
      scene.environmentIntensity = 0.85

      const key = new THREE.DirectionalLight(0xfff2e0, 2.4)
      key.position.set(3.2, 4.2, 2.6)
      scene.add(key)
      const rim = new THREE.DirectionalLight(0x9fc3ff, 1.6)
      rim.position.set(-3.4, 1.4, -2.4)
      scene.add(rim)
      const fill = new THREE.DirectionalLight(0xffffff, 0.5)
      fill.position.set(0, -2, 1.5)
      scene.add(fill)

      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 1,
        metalness: 1,
        envMapIntensity: 0.9
      })
      setShape('sphere')
      buildTextures()
      resize()
      // PNG capture of the shaded material ball, used by the MCP tool substrate_get_preview
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
      ro = new ResizeObserver(resize)
      if (host.value) ro.observe(host.value)
      animate()
    })

    watch(() => state.previewVersion, () => buildTextures())
    watch(shape, (v) => setShape(v))
    watch(tiling, () => applyTiling())
    watch(displacement, (v) => {
      if (material) {
        material.displacementScale = v
        material.displacementBias = -v * 0.5
        material.needsUpdate = true
      }
    })
    watch(
      () => outputNode()?.params?.alphaMode,
      () => buildTextures()
    )

    onBeforeUnmount(() => {
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
      <div class="panel-head">
        <span>{{ $t('preview.title') }}</span>
        <select v-model="shape" class="shape-select" style="background: var(--bg0); border: 1px solid var(--line); border-radius: 4px; font-size: 10px; padding: 2px 4px; text-transform: none; letter-spacing: 0">
          <option v-for="s in SHAPES" :key="s.id" :value="s.id">{{ $tr(s.label) }}</option>
        </select>
      </div>
      <div class="preview-body" ref="host">
        <canvas ref="canvasRef"></canvas>
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
