import { defineComponent, ref, shallowRef, computed, watch, nextTick } from 'vue'
import { createImagePbrMaterial } from '../engine/store.js'
import { loadImage, fitImageCanvas, processSeamless, canvasToDataURL, drawTiled } from '../engine/seamless.js'
import { t } from '../i18n/index.js'

/**
 * 「一键导入图片 → PBR 材质」对话框。
 *
 * 设计要点：
 * 1. 左右两个画布都按 2×2 平铺显示：单张图是看不出接缝的，只有平铺后边界才会暴露问题，
 *    所以左侧画原图、右侧画「无缝处理后」的结果，用户可以直接对比效果再决定是否生成。
 * 2. 预览只在 512px 上跑 CPU 算法（够看清接缝即可），真正生成时才用 2048px；
 *    所选的无缝参数会写进图里的 seamless_tile 节点，导入后仍可在检查器里实时调整。
 * 3. 组件只负责「收集参数 + 预览」，建图交给 store 的 createImagePbrMaterial。
 */
export default defineComponent({
  name: 'ImagePbrDialog',
  emits: ['close', 'generated'],
  setup(_props, { emit }) {
    // ---- 模板引用与图片状态 -------------------------------------------------
    const fileInput = ref(null) // 隐藏的 <input type="file">，用按钮/拖放间接触发
    const originalCanvas = ref(null) // 左侧预览画布（原图 2×2 平铺）
    const seamlessCanvas = ref(null) // 右侧预览画布（无缝结果 2×2 平铺）
    // 图片对象体积大且内部字段无需响应式，用 shallowRef 避免 Vue 深度代理带来的开销
    const image = shallowRef(null)
    const fileName = ref('')
    const dims = ref('') // 形如 "4032 × 3024" 的原始像素尺寸，仅用于展示

    // ---- 用户可调参数 -------------------------------------------------------
    const fit = ref('crop') // 'crop' 中心裁方形 / 'stretch' 整幅压进方形
    const seamlessOn = ref(true)
    const mode = ref(0) // 0 边缘羽化 / 1 镜像 / 2 偏移交叉融合（与 seamless_tile 节点一致）
    const curve = ref(0) // 0 余弦 / 1 平滑步进 / 2 线性
    const band = ref(0.08) // 羽化宽度占图幅的比例（0.005 ~ 0.25）
    // 需要生成哪些 PBR 通道；默认全部开启，用户可自行取消不需要的通道以减少生成耗时
    const channels = ref({
      basecolor: true,
      height: true,
      normal: true,
      roughness: true,
      ao: true,
      metallic: true
    })

    // busy：解码 / 生成期间禁用按钮，防止重复触发；error：错误提示；dragOver：拖放高亮
    const busy = ref(false)
    const error = ref('')
    const dragOver = ref(false)

    const hasImage = computed(() => !!image.value)
    // 滑杆用 1~25 的整数百分比，内部仍保存 0.005~0.25 的比例
    const bandPct = computed(() => Math.round(band.value * 100))
    // 根据当前无缝模式给出对应的一句话说明，帮助用户理解三种算法的区别
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

    // 预览用的中间画布（512px 适配结果），以及待执行的动画帧句柄
    let previewSource = null
    let raf = 0

    /**
     * 重绘两侧预览。
     * 拖动羽化宽度滑杆时会连续触发，因此用 requestAnimationFrame 合并到每一帧最多一次，
     * 避免同步跑两遍 512² 的无缝算法把主线程卡住。
     * 左侧始终是原图平铺，右侧是「当前参数」的无缝结果，方便直接对比接缝。
     */
    function render() {
      if (!image.value) return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        // 对话框可能已被关闭（画布 ref 为 null），此时直接放弃本帧
        if (!originalCanvas.value || !seamlessCanvas.value) return
        // 预览固定缩到 512：够看清接缝，又比 2048 快十几倍
        previewSource = fitImageCanvas(image.value, { fit: fit.value, size: 512 })
        drawTiled(originalCanvas.value, previewSource, 2, 2)
        // 无缝处理是 CPU 版本，与 GPU 节点 seamless_tile 数值一致
        const processed = processSeamless(previewSource, {
          enabled: seamlessOn.value,
          mode: mode.value,
          band: band.value,
          curve: curve.value
        })
        drawTiled(seamlessCanvas.value, processed, 2, 2)
      })
    }

    // 任一预览参数变化都重绘；flush: 'post' 保证在 DOM 更新（画布尺寸/显隐）之后执行
    watch([fit, seamlessOn, mode, curve, band], render, { flush: 'post' })

    /**
     * 读取用户选中的文件并解码成图片，成功后立即渲染预览。
     * 用 createObjectURL 而不是 FileReader + base64：大图转 base64 既慢又占内存，
     * objectURL 是浏览器内部的轻量引用，用完（finally 中）即释放。
     */
    async function handleFile(file) {
      if (!file) return
      // 只接受图片类型，其它文件（哪怕后缀是 .png）一律拒绝并提示
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
        // 等 Vue 把画布渲染出来（v-if 切换）后再绘制，否则 ref 还是 null
        await nextTick()
        render()
      } catch (e) {
        error.value = e.message || String(e)
      } finally {
        URL.revokeObjectURL(url)
        busy.value = false
      }
    }

    /** 打开系统文件选择框（按钮和拖放区都复用这一个入口） */
    function pick() {
      fileInput.value?.click()
    }
    /** <input type="file"> 的 change 回调；清空 value 以便再次选择同一个文件也能触发 change */
    function onFileInput(e) {
      const file = e.target.files && e.target.files[0]
      e.target.value = ''
      handleFile(file)
    }
    /** 拖放释放：取第一个文件交给 handleFile，并取消高亮 */
    function onDrop(e) {
      dragOver.value = false
      const file = e.dataTransfer?.files && e.dataTransfer.files[0]
      handleFile(file)
    }
    /** 滑杆回调：界面是 1~25 的百分比，转回内部 0.01~0.25 的比例 */
    function setBand(e) {
      band.value = Number(e.target.value) / 100
    }

    /**
     * 生成材质：把原图按当前「适配方式」缩到 2048 并编码成 JPEG，
     * 然后交给 store 一次性建好整条节点链。
     * 注意这里传的是原图而不是预览用的无缝结果——无缝作为 seamless_tile 节点留在图里，
     * 这样导入后还能在检查器里继续调 mode/band，而不是把算法结果「烤死」进图片。
     */
    async function generate() {
      if (!image.value || busy.value) return
      busy.value = true
      error.value = ''
      try {
        // 真正写进节点的是 2048 的方形图；无缝步骤交给 GPU 节点执行
        const fitted = fitImageCanvas(image.value, { fit: fit.value, size: 2048 })
        // 用 JPEG 0.92 控制体积，避免 localStorage 自动保存被单张贴图撑爆
        const dataURL = canvasToDataURL(fitted, 0.92)
        const result = createImagePbrMaterial({
          dataURL,
          fileName: fileName.value,
          seamless: { enabled: seamlessOn.value, mode: mode.value, band: band.value, curve: curve.value },
          channels: channels.value
        })
        if (!result) throw new Error(t('imagePbr.failed'))
        // 先通知外部「已生成」（父组件会 fit 视图），再关闭对话框
        emit('generated')
        emit('close')
      } catch (e) {
        error.value = e.message || String(e)
      } finally {
        busy.value = false
      }
    }

    /** 点击遮罩或关闭按钮时只通知父组件，不自行修改外部状态 */
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
            <!-- 左右对比预览：左=原图 2×2 平铺，右=无缝处理后的 2×2 平铺 -->
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
              <!-- 适配与无缝参数：模式/曲线/羽化宽度；关闭无缝或镜像模式时对应选项置灰 -->
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
                <!-- 通道勾选：决定生成哪些 PBR 贴图 -->
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
