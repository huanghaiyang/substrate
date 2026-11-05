// ============================================================================
// PaintStudio —— 手绘工作台（全屏绘制模式）
//
// 界面位置：从检查器「进入绘制」按钮或节点双击打开的独立全屏视图（覆盖主界面）。
// 布局：左侧笔刷与参数面板 → 中间画布 → 右侧实时预览与提示。
//
// 绘制模型（与 engine/paint.js 协作）：
//  - 每一笔（stroke）以矢量形式保存到 node.data.strokes，而不是直接改像素；
//    因此撤销、重绘、改变分辨率都不会损失质量。
//  - 画布只是 strokes 的栅格化结果：commitStroke 保存笔画，attachPaintCanvas 把
//    store 中的笔画重绘到给定 canvas 上。
//  - 绘制过程中用「底图快照 + 重绘当前笔画」的方式做实时预览，保证所见即最终结果。
//
// 与 engine 的交互：store 负责笔画/撤销/求值调度，brushes.js 提供笔刷定义与预览图，
// paint.js 的 drawStroke 负责真正的栅格化；画笔参数变更会防抖保存到 store。
// ============================================================================
import { defineComponent, ref, computed, onMounted, watch, nextTick } from 'vue'
import {
  state,
  nodeById,
  attachPaintCanvas,
  commitStroke,
  clearPaint,
  undo,
  requestEval,
  savePaintBrush
} from '../engine/store.js'
import { drawStroke } from '../engine/paint.js'
import {
  getAllBrushes,
  getBrushGroups,
  brushById,
  brushPreview,
  importCustomBrushJson,
  removeCustomBrush
} from '../engine/brushes.js'
import { loadPattern } from '../engine/paint.js'
import { t, trNode } from '../i18n/index.js'

export default defineComponent({
  name: 'PaintStudio',
  props: { nodeId: { type: String, required: true } },
  emits: ['close'],
  setup(props, { emit }) {
    /** 画布元素：既是绘制输入面，也是笔画的显示载体 */
    const canvasRef = ref(null)
    /** 画布外层容器，用于把光标位置从视口坐标换算到容器坐标 */
    const wrapRef = ref(null)
    /** 跟随鼠标的笔刷圆环光标（用 DOM 直接改样式，避免响应式重渲染） */
    const cursorEl = ref(null)
    // 画笔参数直接引用 store 中的共享对象，改动即时生效并持久化
    const brush = state.paintBrush
    /** 笔刷列表版本号：导入/删除自定义笔刷后自增，用于强制重算 computed */
    const brushVersion = ref(0)
    /** 全部笔刷（内置 + 自定义） */
    const brushes = computed(() => {
      void brushVersion.value
      return getAllBrushes()
    })
    /** 笔刷按分组归类，用于左侧分栏展示 */
    const brushGroups = computed(() => {
      void brushVersion.value
      return getBrushGroups()
    })
    /** 笔刷导入的状态提示 */
    const brushStatus = ref('')
    /** 隐藏的笔刷 JSON 文件选择框 */
    const brushFileInput = ref(null)
    /** 隐藏的素材图片文件选择框 */
    const assetFileInput = ref(null)
    /** 素材库列表（可在绘制区一键填充为图案） */
    const assets = ref([])
    /** 素材相关操作的状态提示 */
    const assetStatus = ref('')
    /** 当前绘制的节点 */
    const node = computed(() => nodeById(props.nodeId))
    /**
     * 取笔刷显示名：优先用 i18n 键，其次 name 字段。
     * @param {object} b 笔刷对象
     * @returns {string}
     */
    const brushName = (b) => (b && b.nameKey ? t(b.nameKey) : b?.name || '')
    /** 当前笔刷定义（用于取默认的 hardness/flow/spacing） */
    const currentBrush = computed(() => brushById(brush.brushId))
    /**
     * 取画笔参数的有效值：用户显式设置过就用它，否则回落到笔刷定义里的默认值。
     * @param {'hardness'|'flow'|'spacing'} key 参数名
     * @returns {number}
     */
    const brushValue = (key) => {
      const v = brush[key]
      return v === undefined || v === null ? currentBrush.value[key] : v
    }
    /** 笔刷缩略图缓存：笔刷预览的生成需要画 canvas，避免每次渲染都重算 */
    const thumbCache = new Map()
    /**
     * 取（并缓存）笔刷缩略图 dataURL。
     * @param {object} b 笔刷对象
     * @returns {string}
     */
    function brushThumbFor(b) {
      if (!thumbCache.has(b.id)) thumbCache.set(b.id, brushPreview(b))
      return thumbCache.get(b.id)
    }
    /**
     * 选中笔刷：切换 id 并继承该笔刷的默认硬度/流量/间距。
     * 设为 null 的参数表示「跟随笔刷默认值」（见 brushValue）。
     * @param {object} b 笔刷对象
     */
    function selectBrush(b) {
      brush.brushId = b.id
      if (b.hardness !== undefined) brush.hardness = b.hardness
      brush.flow = b.flow ?? null
      brush.spacing = b.spacing ?? null
    }
    /**
     * 删除自定义笔刷；若删的正是当前笔刷则回退到内置的 'soft-round'。
     * 内置笔刷不可删除。
     * @param {object} b 笔刷对象
     */
    function removeBrush(b) {
      if (!b || b.source !== 'custom') return
      if (removeCustomBrush(b.id)) {
        if (brush.brushId === b.id) brush.brushId = 'soft-round'
        brushVersion.value++
        brushStatus.value = ''
      }
    }
    /** 打开笔刷导入文件框 */
    function openBrushImport() {
      brushFileInput.value?.click()
    }
    /**
     * 导入笔刷 JSON：成功后自增版本号刷新列表，并自动选中第一个新笔刷。
     * @param {Event} event file input 的 change 事件
     * @returns {Promise<void>}
     */
    async function onBrushFile(event) {
      const file = event.target?.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        const text = await file.text()
        const added = importCustomBrushJson(text)
        brushVersion.value++
        brushStatus.value = t('paint.brushImportOk', { n: added.length })
        if (added[0]) selectBrush(added[0])
      } catch (e) {
        brushStatus.value = t('paint.brushImportFail', { msg: e.message || String(e) })
      }
    }

    // ---- 绘制工作台内的素材库调用 ----
    /** 从本地服务端拉取素材列表；失败时清空（不阻塞绘制） */
    async function refreshAssets() {
      try {
        const res = await fetch('/api/assets')
        const data = await res.json()
        if (data?.ok) assets.value = data.assets || []
      } catch (e) {
        assets.value = []
      }
    }
    /** 打开素材导入文件框 */
    function openAssetImport() {
      assetFileInput.value?.click()
    }
    /**
     * 导入图片素材：仅接受 PNG/JPEG/WebP，读成 dataURL 后提交到素材库接口。
     * @param {Event} event file input 的 change 事件
     * @returns {Promise<void>}
     */
    async function onAssetFile(event) {
      const file = event.target?.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('PNG/JPEG/WebP only')
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const res = await fetch('/api/assets/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, dataUrl })
        })
        const data = await res.json()
        if (!data.ok) throw new Error(data.error?.message || 'import failed')
        assetStatus.value = t('assets.imported', { name: data.asset.name })
        await refreshAssets()
      } catch (e) {
        assetStatus.value = t('assets.importFail', { msg: e.message || String(e) })
      }
    }
    /**
     * 用素材图片铺满整层：加载图案后提交一次「填充」笔画，
     * 清空本地画布再重新挂载，保证显示与 store 中数据一致。
     * @param {{url:string,name:string}} asset 素材对象
     * @returns {Promise<void>}
     */
    async function fillWithAsset(asset) {
      if (!asset || !canvasRef.value) return
      try {
        await loadPattern(asset.url)
        commitStroke(props.nodeId, { pattern: asset.url, patternScale: 1, opacity: 1 })
        canvasRef.value.getContext('2d').clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
        attachPaintCanvas(props.nodeId, canvasRef.value)
        assetStatus.value = t('assets.applied', { name: asset.name })
      } catch (e) {
        assetStatus.value = t('assets.applyFail', { msg: e.message || String(e) })
      }
    }
    /** 画笔参数保存的防抖定时器 */
    let brushSaveTimer = null
    // 深度监听画笔参数：连续拖动滑杆时合并为一次保存（250ms 防抖）
    watch(
      () => ({ ...brush }),
      () => {
        if (brushSaveTimer) clearTimeout(brushSaveTimer)
        brushSaveTimer = setTimeout(savePaintBrush, 250)
      },
      { deep: true }
    )
    /** 工作台标题：优先取节点自定义标题，否则用默认的「Paint Layer」 */
    const title = computed(() => node.value?.data?.title || trNode('Paint Layer'))
    /** 已提交的笔画数量（显示在标题栏元信息里） */
    const strokes = computed(() => node.value?.data?.strokes || [])
    // ---- 绘制过程状态（非响应式：仅在事件回调与 rAF 中使用，不需要触发重渲染） ----
    /** 是否正在落笔 */
    let painting = false
    /** 当前正在绘制的笔画对象；抬手时提交到 store */
    let stroke = null
    /** 上一个采样点，用于计算移动距离（过滤过密采样点） */
    let prevPoint = null
    /** 上次触发实时求值的时间戳，用于限流 */
    let lastLive = 0
    /** 落笔时的画布快照：实时预览 = 快照 + 当前笔画 */
    let liveBase = null
    /** 是否已排入一次 requestAnimationFrame 渲染，避免重复排队 */
    let renderScheduled = false

    // 实时绘制：保存一份已提交贴图的快照，再把整条（三次平滑后的）当前笔画重绘在快照之上，
    // 使预览与最终提交结果完全一致 —— 包括曲线平滑与笔尖收细。
    /** 抓取当前画布内容作为快照 */
    function snapshotBase() {
      const src = canvasRef.value
      liveBase = document.createElement('canvas')
      liveBase.width = src.width
      liveBase.height = src.height
      liveBase.getContext('2d').drawImage(src, 0, 0)
    }
    /** 重绘实时预览：清空 → 贴回快照 → 叠加当前笔画 */
    function renderLive() {
      if (!canvasRef.value || !stroke || !liveBase) return
      const ctx = canvasRef.value.getContext('2d')
      ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      ctx.drawImage(liveBase, 0, 0)
      drawStroke(ctx, stroke, canvasRef.value.width, canvasRef.value.height)
    }
    /** 把渲染合并到下一帧执行（pointermove 可能高频触发） */
    function scheduleRender() {
      if (renderScheduled) return
      renderScheduled = true
      requestAnimationFrame(() => {
        renderScheduled = false
        renderLive()
      })
    }

    /** 选中笔刷的预览圆点：大小/颜色/透明度随笔刷参数变化（尺寸限制在 4~74px） */
    const brushDotStyle = computed(() => {
      const px = Math.min(74, Math.max(4, brush.size * 0.32))
      return { width: px + 'px', height: px + 'px', background: brush.color, opacity: brush.erase ? 0.25 : brush.opacity }
    })
    /** 橡皮模式下光标边框改为虚线以示区分 */
    const cursorBorder = computed(() => (brush.erase ? 'dashed' : 'solid'))

    /**
     * 取压感值：鼠标固定 0.85，触控笔/手写板用设备上报值并夹紧到 [0.05, 1]。
     * @param {PointerEvent} e
     * @returns {number}
     */
    function pressureOf(e) {
      if (e.pointerType === 'mouse') return 0.85
      return Math.min(1, Math.max(0.05, e.pressure || 0.6))
    }
    /**
     * 把指针视口坐标换算成画布归一化坐标（0~1，左上角为原点），并附带压感。
     * @param {PointerEvent} e
     * @returns {{x:number,y:number,p:number}}
     */
    function pointFrom(e) {
      const rect = canvasRef.value.getBoundingClientRect()
      return {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
        p: pressureOf(e)
      }
    }
    // 笔刷光标通过直接写 DOM 样式跟随指针：每次 pointermove 更新响应式 ref 会让整个工作台
    // 重新渲染，是主要的卡顿来源，因此这里完全绕过响应式系统。
    /**
     * 更新笔刷光标的位置与大小（位置按画布实际显示比例换算）。
     * @param {PointerEvent} e
     */
    function updateCursor(e) {
      const el = cursorEl.value
      if (!el || !canvasRef.value || !wrapRef.value) return
      const rect = canvasRef.value.getBoundingClientRect()
      const wrapRect = wrapRef.value.getBoundingClientRect()
      const scale = rect.width / canvasRef.value.width
      const d = Math.max(6, brush.size * scale)
      el.style.left = e.clientX - wrapRect.left - d / 2 + 'px'
      el.style.top = e.clientY - wrapRect.top - d / 2 + 'px'
      el.style.width = d + 'px'
      el.style.height = d + 'px'
      el.style.visibility = 'visible'
    }
    /** 指针离开画布时隐藏光标 */
    function hideCursor() {
      if (cursorEl.value) cursorEl.value.style.visibility = 'hidden'
    }
    /**
     * 触发一次引擎求值以刷新实时预览。
     * 绘制过程中限流到约 8fps 且用低质量档；抬手/填充时立即全质量求值。
     * @param {boolean} [immediate] 是否立即全质量求值
     */
    function live(immediate = false) {
      const now = performance.now()
      if (!immediate && now - lastLive < 120) return
      lastLive = now
      state.engine?.touchPaint(props.nodeId)
      // 绘制过程中用低开销的求值；落笔结束时再走全质量
      requestEval(immediate, immediate ? {} : { low: true })
    }
    /**
     * 依据当前画笔参数创建一个新笔画对象（此时 points 为空）。
     * @returns {object} 笔画对象，字段与 engine/paint.js 的 drawStroke 约定一致
     */
    function newStroke() {
      return {
        color: brush.color,
        size: brush.size,
        opacity: brush.opacity,
        hardness: brushValue('hardness'),
        flow: brushValue('flow'),
        spacing: brushValue('spacing'),
        brushId: brush.brushId,
        erase: brush.erase,
        taper: !!brush.taper,
        taperLength: brush.taperLength ?? 0.5,
        symmetry: { x: brush.symmetryX, y: brush.symmetryY },
        points: []
      }
    }
    /**
     * 落笔：创建笔画、记录首个点、抓快照并立即预览一次。
     * 使用 setPointerCapture 让指针移出画布后仍能继续接收事件（保证笔画连续）。
     * @param {PointerEvent} e
     */
    function onDown(e) {
      if (e.button !== 0 || !canvasRef.value) return
      e.preventDefault()
      updateCursor(e)
      try {
        canvasRef.value.setPointerCapture(e.pointerId)
      } catch (err) {
        /* 忽略 */
      }
      stroke = newStroke()
      const pt = pointFrom(e)
      stroke.points.push(pt)
      snapshotBase()
      renderLive()
      prevPoint = pt
      painting = true
      live(true)
    }
    /**
     * 拖动：采样点并与上一点比较，像素距离小于 0.6 的点丢弃（避免点数暴涨）。
     * @param {PointerEvent} e
     */
    function onMove(e) {
      updateCursor(e)
      if (!painting || !stroke || !canvasRef.value) return
      const pt = pointFrom(e)
      const dx = (pt.x - prevPoint.x) * canvasRef.value.width
      const dy = (pt.y - prevPoint.y) * canvasRef.value.height
      if (Math.hypot(dx, dy) < 0.6) return
      stroke.points.push(pt)
      scheduleRender()
      prevPoint = pt
      live()
    }
    /**
     * 抬手：把笔画提交到 store（真正写入 node.data.strokes），并做一次全质量求值。
     * @param {PointerEvent} e
     */
    function onUp(e) {
      if (!painting) return
      painting = false
      try {
        canvasRef.value.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* 忽略 */
      }
      const done = stroke
      renderLive()
      stroke = null
      prevPoint = null
      liveBase = null
      if (done) commitStroke(props.nodeId, done)
      live(true)
    }
    /** 用当前颜色/透明度把整层填满（作为一条 fill 笔画提交，可撤销） */
    function fill() {
      if (!canvasRef.value) return
      const s = { ...newStroke(), fill: true }
      drawStroke(canvasRef.value.getContext('2d'), s, canvasRef.value.width, canvasRef.value.height)
      commitStroke(props.nodeId, s)
      live(true)
    }
    /** 清空本层所有笔画（走 store，保持可撤销） */
    function clear() {
      if (!canvasRef.value) return
      clearPaint(props.nodeId)
    }
    /** 撤销上一笔：store 回退后需稍等一拍再把剩余笔画重绘回画布 */
    function undoStroke() {
      undo()
      setTimeout(() => {
        // 确保画布反映回退后的笔画集合
        if (node.value) attachPaintCanvas(props.nodeId, canvasRef.value)
      }, 30)
    }
    /** 把 store 中的笔画挂载/重绘到本地画布 */
    function attach() {
      if (!canvasRef.value || !node.value) return
      attachPaintCanvas(props.nodeId, canvasRef.value)
    }

    onMounted(() => {
      // 等 DOM 渲染完成再挂载笔画，否则画布尺寸可能还是 0
      nextTick(attach)
      refreshAssets()
    })
    // 切换到另一个绘制节点时重新挂载笔画
    watch(() => props.nodeId, () => nextTick(attach))

    return {
      canvasRef,
      wrapRef,
      cursorEl,
      cursorBorder,
      brush,
      brushes,
      brushGroups,
      currentBrush,
      brushThumbFor,
      brushName,
      selectBrush,
      removeBrush,
      openBrushImport,
      onBrushFile,
      brushFileInput,
      brushStatus,
      assets,
      assetStatus,
      refreshAssets,
      openAssetImport,
      onAssetFile,
      fillWithAsset,
      brushValue,
      node,
      title,
      strokes,
      brushDotStyle,
      onDown,
      onMove,
      onUp,
      hideCursor,
      fill,
      clear,
      undoStroke,
      emit
    }
  },
  template: `
    <div class="paint-studio">
      <div class="paint-head">
        <!-- 标题栏：返回、标题、元信息（节点名/笔画数/画布尺寸）与撤销/填充/清空 -->
        <button class="btn" @click="emit('close')">{{ $t('paint.back') }}</button>
        <span class="paint-title">{{ $t('paint.title') }}</span>
        <span class="dim small">{{ $t('paint.meta', { name: title, n: strokes.length, size: node.data.paintSize }) }}</span>
        <div class="spacer"></div>
        <button class="btn" @click="undoStroke" :title="$t('paint.undoTitle')">{{ $t('paint.undo') }}</button>
        <button class="btn" @click="fill" :title="$t('paint.fillTitle')">{{ $t('paint.fill') }}</button>
        <button class="btn danger" @click="clear">{{ $t('paint.clear') }}</button>
      </div>
      <div class="paint-main" @pointermove="onMove" @pointerup="onUp">
        <!-- 左侧工具面板：笔刷库、素材、颜色与画笔参数 -->
        <div class="paint-tools">
          <div class="brush-preview"><div class="brush-dot" :style="brushDotStyle"></div></div>
          <div class="brush-head">
            <span>{{ $t('paint.brushes') }}</span>
            <span class="dim small">{{ brushName(currentBrush) }}</span>
          </div>
          <div v-for="g in brushGroups" :key="g.key" class="brush-group">
            <div class="brush-group-label">{{ $t(g.key) }}</div>
            <div class="brush-grid">
              <button
                v-for="b in g.items"
                :key="b.id"
                class="brush-item"
                :class="{ on: brush.brushId === b.id }"
                :title="brushName(b)"
                @click="selectBrush(b)"
              >
                <img :src="brushThumbFor(b)" alt="" draggable="false" />
                <span>{{ brushName(b) }}</span>
                <span v-if="b.source === 'custom'" class="brush-del" :title="$t('paint.brushDelete')" @click.stop="removeBrush(b)">×</span>
              </button>
            </div>
          </div>
          <div class="brush-import-row">
            <button class="btn tiny" @click="openBrushImport">{{ $t('paint.importBrush') }}</button>
            <input ref="brushFileInput" type="file" accept=".json,application/json" style="display: none" @change="onBrushFile" />
            <span v-if="brushStatus" class="brush-status">{{ brushStatus }}</span>
          </div>
          <div class="paint-assets">
            <div class="brush-head">
              <span>{{ $t('paint.assets') }}</span>
              <button class="btn tiny" @click="openAssetImport">{{ $t('paint.assetImport') }}</button>
              <input ref="assetFileInput" type="file" accept="image/png,image/jpeg,image/webp" style="display: none" @change="onAssetFile" />
            </div>
            <div v-if="assets.length" class="asset-strip">
              <button v-for="a in assets" :key="a.id" class="asset-thumb" :title="a.name" @click="fillWithAsset(a)">
                <img :src="a.url" :alt="a.name" />
              </button>
            </div>
            <div v-else class="hint small">{{ $t('paint.noAssets') }}</div>
            <div v-if="assetStatus" class="brush-status">{{ assetStatus }}</div>
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.color') }}</span><span class="val">{{ brush.color }}</span></div>
            <div class="param-row">
              <input type="color" v-model="brush.color" />
              <label class="check" style="margin-left: 6px">
                <input type="checkbox" v-model="brush.erase" /> {{ $t('paint.erase') }}
              </label>
            </div>
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.size') }}</span><span class="val">{{ $t('paint.sizeUnit', { n: brush.size }) }}</span></div>
            <input type="range" min="2" max="256" step="1" v-model.number="brush.size" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.opacity') }}</span><span class="val">{{ brush.opacity.toFixed(2) }}</span></div>
            <input type="range" min="0.02" max="1" step="0.01" v-model.number="brush.opacity" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.hardness') }}</span><span class="val">{{ brush.hardness.toFixed(2) }}</span></div>
            <input type="range" min="0" max="0.98" step="0.01" v-model.number="brush.hardness" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.flow') }}</span><span class="val">{{ brushValue('flow').toFixed(2) }}</span></div>
            <input type="range" min="0.02" max="1" step="0.01" :value="brushValue('flow')" @input="brush.flow = Number($event.target.value)" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.spacing') }}</span><span class="val">{{ brushValue('spacing').toFixed(2) }}</span></div>
            <input type="range" min="0.02" max="0.5" step="0.005" :value="brushValue('spacing')" @input="brush.spacing = Number($event.target.value)" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.taper') }}</span></div>
            <label class="check"><input type="checkbox" v-model="brush.taper" /> {{ $t('paint.taperOn') }}</label>
            <div v-if="brush.taper" class="taper-length">
              <div class="param-label"><span>{{ $t('paint.taperLength') }}</span><span class="val">{{ (brush.taperLength ?? 0.5).toFixed(2) }}</span></div>
              <input type="range" min="0.05" max="1" step="0.05" :value="brush.taperLength ?? 0.5" @input="brush.taperLength = Number($event.target.value)" style="width: 100%" />
            </div>
          </div>
          <div class="param">
            <div class="param-label"><span>{{ $t('paint.symmetry') }}</span></div>
            <label class="check"><input type="checkbox" v-model="brush.symmetryX" /> {{ $t('paint.mirrorX') }}</label>
            <label class="check" style="margin-top: 5px"><input type="checkbox" v-model="brush.symmetryY" /> {{ $t('paint.mirrorY') }}</label>
          </div>
          <div class="hint">{{ $t('paint.pressureHint') }}</div>
        </div>
        <div class="paint-canvas-wrap" ref="wrapRef">
          <!-- 画布：pointerdown 落笔；移动/抬手事件由外层 paint-main 统一监听 -->
          <canvas
            ref="canvasRef"
            class="paint-canvas"
            @pointerdown="onDown"
            @pointerleave="hideCursor"
          ></canvas>
          <!-- 跟随指针的笔刷光标（位置由 DOM 直接写入，不参与响应式） -->
          <div ref="cursorEl" class="brush-cursor" :style="{ borderStyle: cursorBorder }" style="visibility: hidden"></div>
        </div>
        <!-- 右侧信息栏：引擎实时缩略图与使用提示 -->
        <div class="paint-side">
          <div class="side-title">{{ $t('paint.live') }}</div>
          <img v-if="node._thumb" :src="node._thumb" :alt="$t('paint.live')" />
          <div class="hint">{{ $t('paint.liveHint') }}</div>
          <div class="side-title">{{ $t('paint.tips') }}</div>
          <div class="hint">
            · {{ $t('paint.tip1') }}<br />
            · {{ $t('paint.tip2') }}<br />
            · {{ $t('paint.tip3') }}
          </div>
        </div>
      </div>
    </div>
  `
})
