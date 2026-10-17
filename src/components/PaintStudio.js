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
import { BRUSHES, brushById, brushPreview } from '../engine/brushes.js'
import { trNode } from '../i18n/index.js'

export default defineComponent({
  name: 'PaintStudio',
  props: { nodeId: { type: String, required: true } },
  emits: ['close'],
  setup(props, { emit }) {
    const canvasRef = ref(null)
    const wrapRef = ref(null)
    const cursor = ref(null)
    const brush = state.paintBrush
    const brushes = BRUSHES
    const node = computed(() => nodeById(props.nodeId))
    const currentBrush = computed(() => brushById(brush.brushId))
    const brushValue = (key) => {
      const v = brush[key]
      return v === undefined || v === null ? currentBrush.value[key] : v
    }
    const thumbCache = new Map()
    function brushThumbFor(b) {
      if (!thumbCache.has(b.id)) thumbCache.set(b.id, brushPreview(b))
      return thumbCache.get(b.id)
    }
    function selectBrush(b) {
      brush.brushId = b.id
      brush.hardness = b.hardness
      brush.flow = b.flow
      brush.spacing = b.spacing
    }
    let brushSaveTimer = null
    watch(
      () => ({ ...brush }),
      () => {
        if (brushSaveTimer) clearTimeout(brushSaveTimer)
        brushSaveTimer = setTimeout(savePaintBrush, 250)
      },
      { deep: true }
    )
    const title = computed(() => node.value?.data?.title || trNode('Paint Layer'))
    const strokes = computed(() => node.value?.data?.strokes || [])
    let painting = false
    let stroke = null
    let prevPoint = null
    let lastLive = 0
    let liveBase = null
    let lastLiveRender = 0

    // Live painting: keep a snapshot of the committed texture and re-rasterise the whole
    // (cubic-smoothed) current stroke on top of it, so the preview matches the committed result
    // exactly — including curve smoothing and pen taper.
    function snapshotBase() {
      const src = canvasRef.value
      liveBase = document.createElement('canvas')
      liveBase.width = src.width
      liveBase.height = src.height
      liveBase.getContext('2d').drawImage(src, 0, 0)
    }
    function renderLive(force = false) {
      if (!canvasRef.value || !stroke || !liveBase) return
      const now = performance.now()
      if (!force && now - lastLiveRender < 24) return
      lastLiveRender = now
      const ctx = canvasRef.value.getContext('2d')
      ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      ctx.drawImage(liveBase, 0, 0)
      drawStroke(ctx, stroke, canvasRef.value.width, canvasRef.value.height)
    }

    const brushDotStyle = computed(() => {
      const px = Math.min(74, Math.max(4, brush.size * 0.32))
      return { width: px + 'px', height: px + 'px', background: brush.color, opacity: brush.erase ? 0.25 : brush.opacity }
    })
    const cursorStyle = computed(() => {
      if (!cursor.value) return {}
      const d = cursor.value.size
      return {
        left: cursor.value.x - d / 2 + 'px',
        top: cursor.value.y - d / 2 + 'px',
        width: d + 'px',
        height: d + 'px',
        borderStyle: brush.erase ? 'dashed' : 'solid'
      }
    })

    function pressureOf(e) {
      if (e.pointerType === 'mouse') return 0.85
      return Math.min(1, Math.max(0.05, e.pressure || 0.6))
    }
    function pointFrom(e) {
      const rect = canvasRef.value.getBoundingClientRect()
      return {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
        p: pressureOf(e)
      }
    }
    function updateCursor(e) {
      if (!canvasRef.value || !wrapRef.value) return
      const rect = canvasRef.value.getBoundingClientRect()
      const wrapRect = wrapRef.value.getBoundingClientRect()
      const scale = rect.width / canvasRef.value.width
      cursor.value = {
        x: e.clientX - wrapRect.left,
        y: e.clientY - wrapRect.top,
        size: Math.max(6, brush.size * scale)
      }
    }
    function hideCursor() {
      cursor.value = null
    }
    function live(immediate = false) {
      const now = performance.now()
      if (!immediate && now - lastLive < 45) return
      lastLive = now
      state.engine?.touchPaint(props.nodeId)
      requestEval(immediate)
    }
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
    function onDown(e) {
      if (e.button !== 0 || !canvasRef.value) return
      e.preventDefault()
      updateCursor(e)
      try {
        canvasRef.value.setPointerCapture(e.pointerId)
      } catch (err) {
        /* ignore */
      }
      stroke = newStroke()
      const pt = pointFrom(e)
      stroke.points.push(pt)
      snapshotBase()
      renderLive(true)
      prevPoint = pt
      painting = true
      live(true)
    }
    function onMove(e) {
      updateCursor(e)
      if (!painting || !stroke || !canvasRef.value) return
      const pt = pointFrom(e)
      const dx = (pt.x - prevPoint.x) * canvasRef.value.width
      const dy = (pt.y - prevPoint.y) * canvasRef.value.height
      if (Math.hypot(dx, dy) < 0.6) return
      stroke.points.push(pt)
      renderLive()
      prevPoint = pt
      live()
    }
    function onUp(e) {
      if (!painting) return
      painting = false
      try {
        canvasRef.value.releasePointerCapture(e.pointerId)
      } catch (err) {
        /* ignore */
      }
      const done = stroke
      renderLive(true)
      stroke = null
      prevPoint = null
      liveBase = null
      lastLiveRender = 0
      if (done) commitStroke(props.nodeId, done)
      live(true)
    }
    function fill() {
      if (!canvasRef.value) return
      const s = { ...newStroke(), fill: true }
      drawStroke(canvasRef.value.getContext('2d'), s, canvasRef.value.width, canvasRef.value.height)
      commitStroke(props.nodeId, s)
      live(true)
    }
    function clear() {
      if (!canvasRef.value) return
      clearPaint(props.nodeId)
    }
    function undoStroke() {
      undo()
      setTimeout(() => {
        // ensure canvas reflects restored strokes
        if (node.value) attachPaintCanvas(props.nodeId, canvasRef.value)
      }, 30)
    }
    function attach() {
      if (!canvasRef.value || !node.value) return
      attachPaintCanvas(props.nodeId, canvasRef.value)
    }

    onMounted(() => nextTick(attach))
    watch(() => props.nodeId, () => nextTick(attach))

    return {
      canvasRef,
      wrapRef,
      cursor,
      brush,
      brushes,
      currentBrush,
      brushThumbFor,
      selectBrush,
      brushValue,
      node,
      title,
      strokes,
      brushDotStyle,
      cursorStyle,
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
        <button class="btn" @click="emit('close')">{{ $t('paint.back') }}</button>
        <span class="paint-title">{{ $t('paint.title') }}</span>
        <span class="dim small">{{ $t('paint.meta', { name: title, n: strokes.length, size: node.data.paintSize }) }}</span>
        <div class="spacer"></div>
        <button class="btn" @click="undoStroke" :title="$t('paint.undoTitle')">{{ $t('paint.undo') }}</button>
        <button class="btn" @click="fill" :title="$t('paint.fillTitle')">{{ $t('paint.fill') }}</button>
        <button class="btn danger" @click="clear">{{ $t('paint.clear') }}</button>
      </div>
      <div class="paint-main" @pointermove="onMove" @pointerup="onUp">
        <div class="paint-tools">
          <div class="brush-preview"><div class="brush-dot" :style="brushDotStyle"></div></div>
          <div class="brush-head">
            <span>{{ $t('paint.brushes') }}</span>
            <span class="dim small">{{ $t(currentBrush.nameKey) }}</span>
          </div>
          <div class="brush-grid">
            <button
              v-for="b in brushes"
              :key="b.id"
              class="brush-item"
              :class="{ on: brush.brushId === b.id }"
              :title="$t(b.nameKey)"
              @click="selectBrush(b)"
            >
              <img :src="brushThumbFor(b)" alt="" draggable="false" />
              <span>{{ $t(b.nameKey) }}</span>
            </button>
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
          <canvas
            ref="canvasRef"
            class="paint-canvas"
            @pointerdown="onDown"
            @pointerleave="hideCursor"
          ></canvas>
          <div v-if="cursor" class="brush-cursor" :style="cursorStyle"></div>
        </div>
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
