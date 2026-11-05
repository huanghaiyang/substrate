import { defineComponent, ref, shallowRef, computed, watch, nextTick } from 'vue'
import { createImagePbrMaterial } from '../engine/store.js'
import { loadImage, fitImageCanvas, processSeamless, canvasToDataURL, drawTiled } from '../engine/seamless.js'
import { t } from '../i18n/index.js'

/**
 * One-click image → PBR material import. The photo is previewed as a 2×2 tile next to its
 * seamless version, so the edge treatment can be judged before the graph is built.
 */
export default defineComponent({
  name: 'ImagePbrDialog',
  emits: ['close', 'generated'],
  setup(_props, { emit }) {
    const fileInput = ref(null)
    const originalCanvas = ref(null)
    const seamlessCanvas = ref(null)
    const image = shallowRef(null)
    const fileName = ref('')
    const dims = ref('')
    const fit = ref('crop')
    const seamlessOn = ref(true)
    const mode = ref(0)
    const curve = ref(0)
    const band = ref(0.08)
    const channels = ref({
      basecolor: true,
      height: true,
      normal: true,
      roughness: true,
      ao: true,
      metallic: true
    })
    const busy = ref(false)
    const error = ref('')
    const dragOver = ref(false)

    const hasImage = computed(() => !!image.value)
    const bandPct = computed(() => Math.round(band.value * 100))
    const modeHint = computed(() => {
      if (mode.value === 1) return t('imagePbr.modeMirrorHint')
      if (mode.value === 2) return t('imagePbr.modeWrapHint')
      return t('imagePbr.modeBlendHint')
    })
    const channelList = [
      { key: 'basecolor', label: 'imagePbr.chBase' },
      { key: 'height', label: 'imagePbr.chHeight' },
      { key: 'normal', label: 'imagePbr.chNormal' },
      { key: 'roughness', label: 'imagePbr.chRough' },
      { key: 'ao', label: 'imagePbr.chAO' },
      { key: 'metallic', label: 'imagePbr.chMetal' }
    ]

    let previewSource = null
    let raf = 0

    function render() {
      if (!image.value) return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!originalCanvas.value || !seamlessCanvas.value) return
        previewSource = fitImageCanvas(image.value, { fit: fit.value, size: 512 })
        drawTiled(originalCanvas.value, previewSource, 2, 2)
        const processed = processSeamless(previewSource, {
          enabled: seamlessOn.value,
          mode: mode.value,
          band: band.value,
          curve: curve.value
        })
        drawTiled(seamlessCanvas.value, processed, 2, 2)
      })
    }

    watch([fit, seamlessOn, mode, curve, band], render, { flush: 'post' })

    async function handleFile(file) {
      if (!file) return
      if (!/^image\//.test(file.type)) {
        error.value = t('imagePbr.errType')
        return
      }
      busy.value = true
      error.value = ''
      const url = URL.createObjectURL(file)
      try {
        const loaded = await loadImage(url)
        image.value = loaded
        fileName.value = file.name
        dims.value = `${loaded.naturalWidth} × ${loaded.naturalHeight}`
        await nextTick()
        render()
      } catch (e) {
        error.value = e.message || String(e)
      } finally {
        URL.revokeObjectURL(url)
        busy.value = false
      }
    }

    function pick() {
      fileInput.value?.click()
    }
    function onFileInput(e) {
      const file = e.target.files && e.target.files[0]
      e.target.value = ''
      handleFile(file)
    }
    function onDrop(e) {
      dragOver.value = false
      const file = e.dataTransfer?.files && e.dataTransfer.files[0]
      handleFile(file)
    }
    function setBand(e) {
      band.value = Number(e.target.value) / 100
    }

    async function generate() {
      if (!image.value || busy.value) return
      busy.value = true
      error.value = ''
      try {
        // the graph keeps the square-fitted photo and applies the seamless step live on the GPU,
        // so band/mode stay adjustable inside the Inspector afterwards
        const fitted = fitImageCanvas(image.value, { fit: fit.value, size: 2048 })
        const dataURL = canvasToDataURL(fitted, 0.92)
        const result = createImagePbrMaterial({
          dataURL,
          fileName: fileName.value,
          seamless: { enabled: seamlessOn.value, mode: mode.value, band: band.value, curve: curve.value },
          channels: channels.value
        })
        if (!result) throw new Error(t('imagePbr.failed'))
        emit('generated')
        emit('close')
      } catch (e) {
        error.value = e.message || String(e)
      } finally {
        busy.value = false
      }
    }

    function close() {
      emit('close')
    }

    return {
      fileInput,
      originalCanvas,
      seamlessCanvas,
      fileName,
      dims,
      fit,
      seamlessOn,
      mode,
      curve,
      band,
      bandPct,
      modeHint,
      channels,
      channelList,
      busy,
      error,
      dragOver,
      hasImage,
      pick,
      onFileInput,
      onDrop,
      setBand,
      generate,
      close
    }
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal wide ipbr-modal">
        <div class="modal-head">
          <div class="modal-title">{{ $t('imagePbr.title') }}</div>
          <button class="icon-btn" @click="close">✕</button>
        </div>
        <div class="modal-body">
          <div class="hint ipbr-sub">{{ $t('imagePbr.sub') }}</div>

          <input ref="fileInput" type="file" accept="image/*" class="ipbr-file" @change="onFileInput" />

          <div v-if="!hasImage" class="ipbr-drop" :class="{ over: dragOver }"
               @dragover.prevent="dragOver = true"
               @dragleave="dragOver = false"
               @drop.prevent="onDrop">
            <div class="ipbr-drop-icon">▣</div>
            <div class="ipbr-drop-title">{{ $t('imagePbr.drop') }}</div>
            <div class="hint">{{ $t('imagePbr.dropHint') }}</div>
            <button class="btn primary" @click="pick">{{ $t('imagePbr.browse') }}</button>
          </div>

          <div v-else class="ipbr-workspace">
            <div class="ipbr-previews">
              <div class="ipbr-preview">
                <div class="ipbr-preview-head">
                  <span>{{ $t('imagePbr.original') }}</span>
                  <span class="chip">{{ dims }}</span>
                </div>
                <canvas ref="originalCanvas" width="512" height="512" class="ipbr-canvas"></canvas>
              </div>
              <div class="ipbr-preview">
                <div class="ipbr-preview-head">
                  <span>{{ $t('imagePbr.seamless') }}</span>
                  <span class="chip">{{ seamlessOn ? $t('imagePbr.on') : $t('imagePbr.off') }}</span>
                </div>
                <canvas ref="seamlessCanvas" width="512" height="512" class="ipbr-canvas"></canvas>
              </div>
            </div>

            <div class="ipbr-controls">
              <div class="ipbr-row">
                <label>{{ $t('imagePbr.fitLabel') }}</label>
                <select v-model="fit" class="top-select">
                  <option value="crop">{{ $t('imagePbr.fitCrop') }}</option>
                  <option value="stretch">{{ $t('imagePbr.fitStretch') }}</option>
                </select>
                <button class="btn ghost ipbr-replace" @click="pick">{{ $t('imagePbr.replace') }}</button>
              </div>
              <div class="ipbr-row">
                <label>{{ $t('imagePbr.seamlessToggle') }}</label>
                <label class="ipbr-switch">
                  <input type="checkbox" v-model="seamlessOn" />
                  <span>{{ seamlessOn ? $t('imagePbr.on') : $t('imagePbr.off') }}</span>
                </label>
              </div>
              <div class="ipbr-row" :class="{ dim: !seamlessOn }">
                <label>{{ $t('imagePbr.mode') }}</label>
                <select v-model.number="mode" class="top-select">
                  <option :value="0">{{ $t('imagePbr.modeBlend') }}</option>
                  <option :value="1">{{ $t('imagePbr.modeMirror') }}</option>
                  <option :value="2">{{ $t('imagePbr.modeWrap') }}</option>
                </select>
              </div>
              <div class="ipbr-row" :class="{ dim: !seamlessOn || mode === 1 }">
                <label>{{ $t('imagePbr.curve') }}</label>
                <select v-model.number="curve" class="top-select">
                  <option :value="0">{{ $t('imagePbr.curveCosine') }}</option>
                  <option :value="1">{{ $t('imagePbr.curveSmooth') }}</option>
                  <option :value="2">{{ $t('imagePbr.curveLinear') }}</option>
                </select>
              </div>
              <div class="ipbr-row" :class="{ dim: !seamlessOn || mode === 1 }">
                <label>{{ $t('imagePbr.band') }}</label>
                <input class="ipbr-range" type="range" min="1" max="25" step="1" :value="bandPct" @input="setBand" />
                <span class="ipbr-value">{{ bandPct }}%</span>
              </div>
              <div class="hint ipbr-mode-hint">{{ modeHint }}</div>

              <div class="ipbr-channels">
                <div class="ipbr-channels-title">{{ $t('imagePbr.channels') }}</div>
                <div class="ipbr-chip-list">
                  <label v-for="c in channelList" :key="c.key" class="ipbr-chip" :class="{ on: channels[c.key] }">
                    <input type="checkbox" v-model="channels[c.key]" />
                    <span>{{ $t(c.label) }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div v-if="error" class="err ipbr-error">{{ error }}</div>
        </div>
        <div class="modal-foot">
          <span class="hint">{{ $t('imagePbr.foot') }}</span>
          <div class="ipbr-actions">
            <button class="btn" @click="close">{{ $t('common.close') }}</button>
            <button class="btn primary" :disabled="!hasImage || busy" @click="generate">
              {{ busy ? $t('imagePbr.generating') : $t('imagePbr.gen') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
