import { defineComponent, computed, ref } from 'vue'
import { state, nodeById, defOf, setParam, setNodeImage, resolveParams, renameNode, openPaintStudio } from '../engine/store.js'
import GradientEditor from './GradientEditor.js'
import { catColor } from '../ui/theme.js'

export default defineComponent({
  name: 'Inspector',
  components: { GradientEditor },
  emits: ['open-paint'],
  setup(props, { emit }) {
    const fileInput = ref(null)
    const node = computed(() => nodeById(state.activeNodeId))
    const def = computed(() => defOf(node.value))
    const params = computed(() => (node.value && def.value ? resolveParams(def.value, node.value) : {}))
    const strokeCount = computed(() => (node.value?.data?.strokes || []).length)

    function val(p) {
      const v = params.value[p.key]
      return v === undefined ? p.def : v
    }
    function display(p) {
      const v = Number(val(p)) || 0
      if (p.type === 'int') return String(Math.round(v))
      const step = p.step || 0.01
      const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
      return v.toFixed(digits)
    }
    function clampVal(p, x) {
      if (!Number.isFinite(x)) x = p.def
      if (p.type === 'int') x = Math.round(x)
      if (p.min !== undefined) x = Math.max(p.min, x)
      if (p.max !== undefined) x = Math.min(p.max, x)
      return x
    }
    function onRange(p, event) {
      setParam(node.value.id, p.key, clampVal(p, parseFloat(event.target.value)))
    }
    function onNumber(p, event) {
      setParam(node.value.id, p.key, clampVal(p, parseFloat(event.target.value)), { coalesce: false })
    }
    function onBool(p, event) {
      setParam(node.value.id, p.key, event.target.checked, { coalesce: false })
    }
    function onColor(p, event) {
      setParam(node.value.id, p.key, event.target.value)
    }
    function onSelect(p, event) {
      setParam(node.value.id, p.key, Number(event.target.value), { coalesce: false })
    }
    function onText(p, event) {
      setParam(node.value.id, p.key, event.target.value)
    }
    function onGradient(p, value) {
      setParam(node.value.id, p.key, value)
    }
    function onVec(p, axis, event) {
      const arr = [...(val(p) || [0, 0])]
      arr[axis] = clampVal(p, parseFloat(event.target.value))
      setParam(node.value.id, p.key, arr)
    }
    function onVecNum(p, axis, event) {
      const arr = [...(val(p) || [0, 0])]
      arr[axis] = clampVal(p, parseFloat(event.target.value))
      setParam(node.value.id, p.key, arr, { coalesce: false })
    }
    function onRename(event) {
      renameNode(node.value.id, event.target.value)
    }
    function pickFile() {
      fileInput.value?.click()
    }
    function onFile(event) {
      const file = event.target.files && event.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        setNodeImage(node.value.id, reader.result, file.name)
      }
      reader.readAsDataURL(file)
      event.target.value = ''
    }
    return {
      node, def, params, val, display, strokeCount, catColor, fileInput, state,
      onRange, onNumber, onBool, onColor, onSelect, onText, onGradient,
      onVec, onVecNum, onRename, pickFile, onFile, emit, openPaintStudio
    }
  },
  template: `
    <div class="inspector panel">
      <div class="panel-head">
        <span>Properties</span>
        <span v-if="def" class="dim" :style="{ color: catColor(def.category) }">{{ def.category }}</span>
        <span v-else class="dim">no selection</span>
      </div>
      <div v-if="!node || !def" class="insp-empty">
        <div class="big">◎</div>
        Select a node to edit its parameters.<br />Drag from a node's right port to an input to connect streams.
      </div>
      <div v-else class="insp-body">
        <div class="insp-node">
          <input class="title-input" :value="node.data.title || def.name" @change="onRename" />
          <div class="insp-meta">{{ def.name }} · {{ node.id }}</div>
        </div>

        <div v-for="p in def.params" :key="p.key" class="param">
          <template v-if="p.type === 'bool'">
            <label class="check">
              <input type="checkbox" :checked="val(p)" @change="onBool(p, $event)" />
              {{ p.label }}
            </label>
          </template>

          <template v-else-if="p.type === 'color'">
            <div class="param-label"><span>{{ p.label }}</span><span class="val">{{ val(p) }}</span></div>
            <div class="param-row">
              <input type="color" :value="val(p)" @input="onColor(p, $event)" />
              <span class="dim small">sRGB colour picker</span>
            </div>
          </template>

          <template v-else-if="p.type === 'vec2'">
            <div class="param-label"><span>{{ p.label }}</span></div>
            <div class="vec-row">
              <div class="vec-cell">
                <span class="axis">X</span>
                <input type="range" :min="p.min" :max="p.max" :step="p.step || 0.01" :value="val(p)[0]" @input="onVec(p, 0, $event)" />
                <input class="num" type="number" :value="val(p)[0]" @change="onVecNum(p, 0, $event)" />
              </div>
              <div class="vec-cell">
                <span class="axis">Y</span>
                <input type="range" :min="p.min" :max="p.max" :step="p.step || 0.01" :value="val(p)[1]" @input="onVec(p, 1, $event)" />
                <input class="num" type="number" :value="val(p)[1]" @change="onVecNum(p, 1, $event)" />
              </div>
            </div>
          </template>

          <template v-else-if="p.type === 'select'">
            <div class="param-label"><span>{{ p.label }}</span></div>
            <select class="select-full" :value="val(p)" @change="onSelect(p, $event)">
              <option v-for="(opt, i) in p.options" :key="i" :value="i">{{ opt }}</option>
            </select>
          </template>

          <template v-else-if="p.type === 'gradient'">
            <div class="param-label"><span>{{ p.label }}</span></div>
            <GradientEditor :stops="val(p)" @update="(v) => onGradient(p, v)" />
          </template>

          <template v-else-if="p.type === 'text'">
            <div class="param-label"><span>{{ p.label }}</span></div>
            <input class="text-full" :value="val(p)" @input="onText(p, $event)" />
          </template>

          <template v-else>
            <div class="param-label">
              <span>{{ p.label }}</span>
              <span class="val">{{ display(p) }}{{ p.type === 'angle' ? '°' : '' }}</span>
            </div>
            <div class="param-row">
              <input type="range" :min="p.min" :max="p.max" :step="p.step || 0.01" :value="val(p)" @input="onRange(p, $event)" />
              <input class="num" type="number" :min="p.min" :max="p.max" :step="p.step || 0.01" :value="val(p)" @change="onNumber(p, $event)" />
            </div>
          </template>
        </div>

        <div v-if="def.paintInput" class="insp-actions">
          <button class="btn primary" :disabled="state.mode === 'paint'" @click="openPaintStudio(node.id)">
            {{ state.mode === 'paint' ? 'Painting — use the canvas' : 'Open Paint Studio' }}
          </button>
          <div class="hint">{{ strokeCount }} stroke{{ strokeCount === 1 ? '' : 's' }} · painted pixels composite through the graph</div>
        </div>

        <div v-if="def.imageInput" class="insp-actions">
          <button class="btn" @click="pickFile">Load Image…</button>
          <div class="hint">{{ node.data.imageName || 'No image loaded — a placeholder grid is used' }}</div>
          <input type="file" accept="image/*" ref="fileInput" style="display: none" @change="onFile" />
        </div>

        <div class="insp-desc">{{ def.desc }}</div>
      </div>
    </div>
  `
})
