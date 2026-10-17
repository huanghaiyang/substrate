import { defineComponent, ref, computed, onMounted, watch, nextTick } from 'vue'
import {
  state,
  nodeById,
  attachPaintCanvas,
  commitStroke,
  clearPaint,
  undo,
  requestEval
} from '../engine/store.js'
import { drawStroke } from '../engine/paint.js'

export default defineComponent({
  name: 'PaintStudio',
  props: { nodeId: { type: String, required: true } },
  emits: ['close'],
  setup(props, { emit }) {
    const canvasRef = ref(null)
    const wrapRef = ref(null)
    const cursor = ref(null)
    const brush = state.paintBrush
    const node = computed(() => nodeById(props.nodeId))
    const title = computed(() => node.value?.data?.title || 'Paint Layer')
    const strokes = computed(() => node.value?.data?.strokes || [])
    let painting = false
    let stroke = null
    let prevPoint = null
    let lastLive = 0

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
        hardness: brush.hardness,
        erase: brush.erase,
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
      drawStroke(canvasRef.value.getContext('2d'), stroke, canvasRef.value.width, canvasRef.value.height)
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
      drawStroke(
        canvasRef.value.getContext('2d'),
        { ...stroke, points: [prevPoint, pt] },
        canvasRef.value.width,
        canvasRef.value.height
      )
      stroke.points.push(pt)
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
      stroke = null
      prevPoint = null
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
        <button class="btn" @click="emit('close')">← Graph</button>
        <span class="paint-title">Paint Studio</span>
        <span class="dim small">{{ title }} · {{ strokes.length }} strokes · {{ node.data.paintSize }}²</span>
        <div class="spacer"></div>
        <button class="btn" @click="undoStroke" title="Undo (Ctrl+Z)">Undo</button>
        <button class="btn" @click="fill" title="Fill the layer with the brush colour">Fill</button>
        <button class="btn danger" @click="clear">Clear</button>
      </div>
      <div class="paint-main" @pointermove="onMove" @pointerup="onUp">
        <div class="paint-tools">
          <div class="brush-preview"><div class="brush-dot" :style="brushDotStyle"></div></div>
          <div class="param">
            <div class="param-label"><span>Colour</span><span class="val">{{ brush.color }}</span></div>
            <div class="param-row">
              <input type="color" v-model="brush.color" />
              <label class="check" style="margin-left: 6px">
                <input type="checkbox" v-model="brush.erase" /> Erase
              </label>
            </div>
          </div>
          <div class="param">
            <div class="param-label"><span>Brush Size</span><span class="val">{{ brush.size }} px</span></div>
            <input type="range" min="2" max="256" step="1" v-model.number="brush.size" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>Opacity</span><span class="val">{{ brush.opacity.toFixed(2) }}</span></div>
            <input type="range" min="0.02" max="1" step="0.01" v-model.number="brush.opacity" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>Hardness</span><span class="val">{{ brush.hardness.toFixed(2) }}</span></div>
            <input type="range" min="0" max="0.98" step="0.01" v-model.number="brush.hardness" style="width: 100%" />
          </div>
          <div class="param">
            <div class="param-label"><span>Symmetry</span></div>
            <label class="check"><input type="checkbox" v-model="brush.symmetryX" /> Mirror X</label>
            <label class="check" style="margin-top: 5px"><input type="checkbox" v-model="brush.symmetryY" /> Mirror Y</label>
          </div>
          <div class="hint">Pressure from pen tablets affects stroke width and opacity. Strokes are resolution independent and editable via Undo.</div>
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
          <div class="side-title">Live result</div>
          <img v-if="node._thumb" :src="node._thumb" alt="painted layer result" />
          <div class="hint">Painted pixels composite through this node into every downstream map — base colour, roughness, height and the 3D preview all update live.</div>
          <div class="side-title">Tips</div>
          <div class="hint">
            · Paint in the node's base stream, then use a Threshold / Gradient Map to derive height or gloss from the paint mask.<br />
            · Keep strokes inside the canvas border — painted layers are sampled with wrap for seamless tiling.<br />
            · Use Mirror X/Y for herringbone and symmetric detail.<br />
            · Fill + Erase are stored as strokes, so they undo cleanly.
          </div>
        </div>
      </div>
    </div>
  `
})
