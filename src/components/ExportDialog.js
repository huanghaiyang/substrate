// ============================================================================
// ExportDialog —— 导出材质对话框
//
// 界面位置：主界面「导出」按钮打开的模态框。
// 职责：让用户选择导出预设（glTF / Unity / Unreal / 通用等）与分辨率，预览将要生成的文件清单，
// 然后调用 exporter 生成贴图包；浏览器端生成 blob 下载，若本地服务端可用则额外落盘成 zip。
//
// 与 engine 的交互：state.graph / state.engine 来自 store；PRESETS / planFiles / exportMaterial
// 来自 engine/exporter.js。导出前会读取 PBR 输出节点的参数（法线约定、alpha 模式、高度归一化）
// 以决定目标格式。
// ============================================================================
import { defineComponent, ref, computed } from 'vue'
import { state, outputNode } from '../engine/store.js'
import { PRESETS, planFiles, exportMaterial } from '../engine/exporter.js'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'ExportDialog',
  emits: ['close'],
  setup(props, { emit }) {
    /** 选中的导出预设 id（如 'gltf'） */
    const preset = ref('gltf')
    /** 导出分辨率：不低于当前工程分辨率，下限 512 */
    const resolution = ref(Math.max(512, state.resolution))
    /** 高度图是否以 16 位保存（更精细但体积更大） */
    const height16 = ref(true)
    /** 材质名：默认取输出节点参数，其次工程名，最后用 i18n 兜底 */
    const materialName = ref(outputNode()?.params?.materialName || state.projectName || t('export.defaultMaterial'))
    /** 目标法线约定（'gl' OpenGL / 'dx' DirectX），切换预设时会跟着改变 */
    const targetNormal = ref(PRESETS[0].targetNormal)
    /** 导出进行中标记，用于禁用按钮与显示进度条 */
    const busy = ref(false)
    /** 导出进度 { step, total, label } */
    const progress = ref({ step: 0, total: 0, label: '' })
    /** 导出结果对象（含 manifest、blobUrls、server 信息等）；null 表示还未导出 */
    const result = ref(null)
    const error = ref('')
    /** 最近一次复制成功的标识（'manifest' / 'readme'），1.6 秒后自动清空 */
    const copied = ref('')

    /** PBR 输出节点（即材质的最终出口） */
    const out = computed(() => outputNode())
    /** 输出节点是否接了 emissive 输入（决定是否生成自发光贴图） */
    const hasEmissive = computed(() =>
      state.graph.connections.some((c) => c.to.node === out.value?.id && c.to.port === 'emissive')
    )
    /** 输出节点是否接了 opacity 输入（决定是否生成透明贴图） */
    const hasOpacity = computed(() =>
      state.graph.connections.some((c) => c.to.node === out.value?.id && c.to.port === 'opacity')
    )
    /** alpha 模式：0 不透明 / 1 遮罩 / 2 混合（与渲染端约定一致） */
    const alphaMode = computed(() => Number(out.value?.params?.alphaMode || 0))
    /** 当前材质的法线约定：1 表示 DirectX，其余按 OpenGL 处理 */
    const sourceNormal = computed(() => (Number(out.value?.params?.normalConvention || 0) === 1 ? 'dx' : 'gl'))
    /** 即将生成的文件清单（随预设/参数实时变化，仅用于预览表格） */
    const plan = computed(() =>
      planFiles({
        preset: preset.value,
        name: materialName.value,
        hasEmissive: hasEmissive.value,
        hasOpacity: hasOpacity.value,
        alphaMode: alphaMode.value,
        height16: height16.value
      })
    )
    /** 当前预设的描述对象（用于底部提示文案） */
    const presetInfo = computed(() => PRESETS.find((p) => p.id === preset.value) || PRESETS[0])

    /**
     * 切换预设：同时把该预设推荐的目标法线约定同步到下拉框。
     * @param {object} p 预设对象
     */
    function choosePreset(p) {
      preset.value = p.id
      targetNormal.value = p.targetNormal
    }
    /**
     * 触发下载浏览器端生成的单个贴图 blob。
     * @param {{url:string, path:string}} item 文件项
     */
    function downloadBlob(item) {
      const a = document.createElement('a')
      a.href = item.url
      a.download = item.path
      a.click()
    }
    /**
     * 执行导出：把画布渲染到目标分辨率并编码成 PNG，再按预设输出文件与清单。
     * 分辨率会夹紧到 256~4096，防止误输入导致内存溢出。
     * @returns {Promise<void>}
     */
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
          // 输出节点未显式关闭时默认归一化高度图，保证位移强度可预测
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
        // 服务端落盘失败不影响浏览器下载，只作为额外提示展示
        if (res.serverError) error.value = t('export.serverError', { msg: res.serverError })
      } catch (e) {
        console.error(e)
        error.value = e?.message || String(e)
      } finally {
        busy.value = false
      }
    }
    /**
     * 复制文本到剪贴板，并用 copied 标记做短暂的按钮反馈。
     * @param {string} text 要复制的内容
     * @param {string} label 反馈标识（'manifest' 或 'readme'）
     * @returns {Promise<void>}
     */
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
          <!-- 预设选择卡片：点击后同步法线约定 -->
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

          <!-- 导出选项：材质名、分辨率、目标法线、高度图位深 -->
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

          <!-- 文件清单预览：通道 / 文件名 / 位深与格式 / 色彩空间 -->
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

          <!-- 导出进度条 -->
          <div v-if="busy" style="margin-top: 14px">
            <div class="progress"><div :style="{ width: (progress.total ? (progress.step / progress.total) * 100 : 4) + '%' }"></div></div>
            <div class="hint">{{ $t('export.encoding', { label: $tr(progress.label) || $t('export.thChannel'), step: progress.step, total: progress.total }) }}</div>
          </div>

          <!-- 导出结果：服务端 zip / 文件夹链接、浏览器 blob 下载、manifest 与 readme -->
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
          <!-- 底部：说明文案 + 关闭/开始导出按钮 -->
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
