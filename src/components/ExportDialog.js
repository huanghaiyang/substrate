import { defineComponent, ref, computed } from 'vue'
import { state, outputNode } from '../engine/store.js'
import { PRESETS, planFiles, exportMaterial } from '../engine/exporter.js'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'ExportDialog',
  emits: ['close'],
  setup(props, { emit }) {
    const preset = ref('gltf')
    const resolution = ref(Math.max(512, state.resolution))
    const height16 = ref(true)
    const materialName = ref(outputNode()?.params?.materialName || state.projectName || t('export.defaultMaterial'))
    const targetNormal = ref(PRESETS[0].targetNormal)
    const busy = ref(false)
    const progress = ref({ step: 0, total: 0, label: '' })
    const result = ref(null)
    const error = ref('')
    const copied = ref('')

    const out = computed(() => outputNode())
    const hasEmissive = computed(() =>
      state.graph.connections.some((c) => c.to.node === out.value?.id && c.to.port === 'emissive')
    )
    const hasOpacity = computed(() =>
      state.graph.connections.some((c) => c.to.node === out.value?.id && c.to.port === 'opacity')
    )
    const alphaMode = computed(() => Number(out.value?.params?.alphaMode || 0))
    const sourceNormal = computed(() => (Number(out.value?.params?.normalConvention || 0) === 1 ? 'dx' : 'gl'))
    const plan = computed(() =>
      planFiles({
        preset: preset.value,
        name: materialName.value,
        hasEmissive: hasEmissive.value,
        hasOpacity: hasOpacity.value,
        alphaMode: alphaMode.value
      })
    )
    const presetInfo = computed(() => PRESETS.find((p) => p.id === preset.value) || PRESETS[0])

    function choosePreset(p) {
      preset.value = p.id
      targetNormal.value = p.targetNormal
    }
    function downloadBlob(item) {
      const a = document.createElement('a')
      a.href = item.url
      a.download = item.path
      a.click()
    }
    async function runExport() {
      if (busy.value) return
      busy.value = true
      result.value = null
      error.value = ''
      progress.value = { step: 0, total: plan.value.length, label: t('export.preparing') }
      try {
        const res = await exportMaterial(state.engine, {
          graph: state.graph,
          resolution: Math.min(4096, Math.max(256, Number(resolution.value) || 1024)),
          preset: preset.value,
          materialName: materialName.value || t('export.defaultMaterial'),
          targetNormal: targetNormal.value,
          height16: height16.value,
          normalizeHeight: out.value?.params?.normalizeHeight !== false,
          hasEmissive: hasEmissive.value,
          hasOpacity: hasOpacity.value,
          alphaMode: alphaMode.value,
          sourceNormal: sourceNormal.value,
          onProgress: (p) => {
            progress.value = p
          }
        })
        result.value = res
        if (res.serverError) error.value = t('export.serverError', { msg: res.serverError })
      } catch (e) {
        console.error(e)
        error.value = e?.message || String(e)
      } finally {
        busy.value = false
      }
    }
    async function copy(text, label) {
      try {
        await navigator.clipboard.writeText(text)
        copied.value = label
        setTimeout(() => (copied.value = ''), 1600)
      } catch (e) {
        copied.value = ''
      }
    }
    return {
      PRESETS,
      preset,
      resolution,
      height16,
      materialName,
      targetNormal,
      busy,
      progress,
      result,
      error,
      copied,
      plan,
      presetInfo,
      choosePreset,
      runExport,
      downloadBlob,
      copy,
      emit
    }
  },
  template: `
    <div class="modal-backdrop" @click.self="emit('close')">
      <div class="modal wide">
        <div class="modal-head">
          <div>
            <div class="modal-title">{{ $t('export.title') }}</div>
            <div class="hint" style="margin-top: 2px">{{ $t('export.subtitle') }}</div>
          </div>
          <button class="icon-btn" @click="emit('close')">✕</button>
        </div>
        <div class="modal-body">
          <div class="preset-grid">
            <button
              v-for="p in PRESETS"
              :key="p.id"
              class="preset-card"
              :class="{ on: preset === p.id }"
              @click="choosePreset(p)"
            >
              <div class="pc-name">{{ $tr(p.name) }}</div>
              <div class="pc-desc">{{ $tr(p.engine) }}</div>
            </button>
          </div>

          <div class="form-grid">
            <label>{{ $t('export.materialName') }}</label>
            <input v-model="materialName" :placeholder="$t('export.materialName')" />
            <label>{{ $t('export.resolution') }}</label>
            <select v-model.number="resolution">
              <option :value="512">512 × 512</option>
              <option :value="1024">1024 × 1024</option>
              <option :value="2048">2048 × 2048</option>
              <option :value="4096">{{ $t('export.resHeavy') }}</option>
            </select>
            <label>{{ $t('export.normalTarget') }}</label>
            <select v-model="targetNormal">
              <option value="gl">{{ $t('export.normalGl') }}</option>
              <option value="dx">{{ $t('export.normalDx') }}</option>
            </select>
            <label>{{ $t('export.heightDepth') }}</label>
            <label class="check" style="color: var(--text)">
              <input type="checkbox" v-model="height16" /> {{ $t('export.height16') }}
            </label>
          </div>

          <div style="margin-top: 16px">
            <div class="panel-head" style="height: 24px; padding: 0; border: none; letter-spacing: 1.2px">
              {{ $t('export.files') }}
            </div>
            <table class="file-table">
              <thead>
                <tr><th>{{ $t('export.thChannel') }}</th><th>{{ $t('export.thFile') }}</th><th>{{ $t('export.thMode') }}</th><th>{{ $t('export.thSpace') }}</th></tr>
              </thead>
              <tbody>
                <tr v-for="f in plan" :key="f.fileName">
                  <td>{{ $tr(f.label) }}</td>
                  <td>{{ f.fileName }}</td>
                  <td>{{ $t('export.modeBits', { bits: f.bitDepth || 8, fmt: f.colorType === 0 ? $t('export.fmtGrey') : f.colorType === 6 ? $t('export.fmtRGBA') : $t('export.fmtRGB') }) }}</td>
                  <td>{{ f.srgb ? $t('export.spaceSrgb') : $t('export.spaceLinear') }}</td>
                </tr>
              </tbody>
            </table>
            <div class="hint" style="margin-top: 8px">
              {{ $t('export.presetHint', { desc: $tr(presetInfo.desc) }) }}
            </div>
          </div>

          <div v-if="busy" style="margin-top: 14px">
            <div class="progress"><div :style="{ width: (progress.total ? (progress.step / progress.total) * 100 : 4) + '%' }"></div></div>
            <div class="hint">{{ $t('export.encoding', { label: $tr(progress.label) || $t('export.thChannel'), step: progress.step, total: progress.total }) }}</div>
          </div>

          <div v-if="result" class="result-box">
            <div style="font-weight: 700; color: var(--green)">
              {{ result.ok ? $t('export.pkgOk') : $t('export.pkgBrowser') }}
            </div>
            <div v-if="result.server" class="path">{{ result.server.dir }}</div>
            <div v-if="result.server" class="hint">
              {{ $t('export.pkgMeta', { files: result.files.length, kb: (result.server.zipBytes / 1024).toFixed(0) }) }}
            </div>
            <div class="links">
              <a v-if="result.server" class="btn primary" :href="result.server.zip" download>{{ $t('export.downloadZip') }}</a>
              <a v-if="result.server" class="btn" :href="result.server.url" target="_blank">{{ $t('export.openFolder') }}</a>
              <button
                v-for="item in result.blobUrls"
                :key="item.path"
                class="btn"
                @click="downloadBlob(item)"
                :title="$t('export.downloadZip') + ' · ' + item.path"
              >
                {{ item.path }}
              </button>
            </div>
            <div class="links" style="margin-top: 10px">
              <button class="btn" @click="copy(JSON.stringify(result.manifest, null, 2), 'manifest')">
                {{ copied === 'manifest' ? $t('export.copied') : $t('export.copyManifest') }}
              </button>
              <button class="btn" @click="copy(result.readme, 'readme')">
                {{ copied === 'readme' ? $t('export.copied') : $t('export.copyReadme') }}
              </button>
            </div>
          </div>

          <div v-if="error" class="result-box" style="border-color: #613030; background: rgba(240, 101, 101, 0.07)">
            <div style="font-weight: 700; color: var(--red)">{{ error }}</div>
          </div>
        </div>
        <div class="modal-foot">
          <div class="hint">
            {{ $t('export.foot') }}
          </div>
          <div style="display: flex; gap: 8px">
            <button class="btn" @click="emit('close')">{{ $t('export.close') }}</button>
            <button class="btn primary" :disabled="busy" @click="runExport">
              {{ busy ? $t('export.exporting') : $t('export.run', { res: resolution === 4096 ? '4K' : resolution + '²' }) }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
})
