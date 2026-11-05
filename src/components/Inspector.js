// ============================================================================
// Inspector —— 右侧「检查器」参数面板
//
// 界面位置：主界面右侧栏。显示当前选中节点的标题、分类、可编辑参数、绘制/图片相关操作与描述。
//
// 与 engine 的交互：通过 engine/store.js 读写选中节点（nodeById / setParam / setNodeImage /
// renameNode），参数定义与默认值来自 defOf / resolveParams；所有修改都走 setParam 以便
// store 统一处理合并、历史记录与重新求值。渐变参数交给子组件 GradientEditor 编辑。
// ============================================================================
import { defineComponent, computed, ref } from 'vue'
import { state, nodeById, defOf, setParam, setNodeImage, resolveParams, renameNode, openPaintStudio } from '../engine/store.js'
import GradientEditor from './GradientEditor.js'
import { catColor } from '../ui/theme.js'

export default defineComponent({
  name: 'Inspector',
  components: { GradientEditor },
  emits: ['open-paint'],
  setup(props, { emit }) {
    /** 隐藏的图片文件选择框，供「加载图片」按钮间接触发 */
    const fileInput = ref(null)
    /** 当前选中的节点对象；未选中时为 undefined */
    const node = computed(() => nodeById(state.activeNodeId))
    /** 该节点的定义（参数表、分类、能力开关等） */
    const def = computed(() => defOf(node.value))
    /** 合并了节点自定义值后的实际参数对象（未设置的参数回落到默认值） */
    const params = computed(() => (node.value && def.value ? resolveParams(def.value, node.value) : {}))
    /** 绘制节点的笔画数量，用于在按钮下方显示提示 */
    const strokeCount = computed(() => (node.value?.data?.strokes || []).length)

    /**
     * 取参数当前值，缺失时回落到参数定义中的默认值。
     * @param {object} p 参数定义（key/def/type/...）
     * @returns {*} 参数值
     */
    function val(p) {
      const v = params.value[p.key]
      return v === undefined ? p.def : v
    }
    /**
     * 把参数值格式化为展示文本（按 step 决定小数位；int 取整）。
     * @param {object} p 参数定义
     * @returns {string} 用于显示在参数名右侧的数值字符串
     */
    function display(p) {
      const v = Number(val(p)) || 0
      if (p.type === 'int') return String(Math.round(v))
      const step = p.step || 0.01
      const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
      return v.toFixed(digits)
    }
    /**
     * 按参数定义夹紧数值：非法值回落到默认值，int 取整，并遵守 min/max 限制。
     * @param {object} p 参数定义
     * @param {number} x 用户输入的原始数值
     * @returns {number} 合法数值
     */
    function clampVal(p, x) {
      if (!Number.isFinite(x)) x = p.def
      if (p.type === 'int') x = Math.round(x)
      if (p.min !== undefined) x = Math.max(p.min, x)
      if (p.max !== undefined) x = Math.min(p.max, x)
      return x
    }
    // 以下 onXxx 均为模板中的输入回调：统一调用 setParam 写回 store。
    // coalesce: false 表示把这次修改当作独立历史节点（数值框/开关/下拉），
    // 而滑杆拖动使用默认合并行为，避免拖动过程产生大量撤销记录。
    /** 滑杆 input：实时更新（合并历史） */
    function onRange(p, event) {
      setParam(node.value.id, p.key, clampVal(p, parseFloat(event.target.value)))
    }
    /** 数值框 change：提交一次独立修改 */
    function onNumber(p, event) {
      setParam(node.value.id, p.key, clampVal(p, parseFloat(event.target.value)), { coalesce: false })
    }
    /** 布尔开关 */
    function onBool(p, event) {
      setParam(node.value.id, p.key, event.target.checked, { coalesce: false })
    }
    /** 颜色取色器 */
    function onColor(p, event) {
      setParam(node.value.id, p.key, event.target.value)
    }
    /** 枚举下拉：模板里的 option 值是索引，因此转成 Number */
    function onSelect(p, event) {
      setParam(node.value.id, p.key, Number(event.target.value), { coalesce: false })
    }
    /** 文本输入 */
    function onText(p, event) {
      setParam(node.value.id, p.key, event.target.value)
    }
    /** 渐变子组件回传的完整停靠点数组 */
    function onGradient(p, value) {
      setParam(node.value.id, p.key, value)
    }
    /** vec2 滑杆：复制数组后只改某一轴，保证响应式更新 */
    function onVec(p, axis, event) {
      const arr = [...(val(p) || [0, 0])]
      arr[axis] = clampVal(p, parseFloat(event.target.value))
      setParam(node.value.id, p.key, arr)
    }
    /** vec2 数值框（独立历史节点） */
    function onVecNum(p, axis, event) {
      const arr = [...(val(p) || [0, 0])]
      arr[axis] = clampVal(p, parseFloat(event.target.value))
      setParam(node.value.id, p.key, arr, { coalesce: false })
    }
    /** 修改节点显示标题 */
    function onRename(event) {
      renameNode(node.value.id, event.target.value)
    }
    /** 打开系统文件选择框 */
    function pickFile() {
      fileInput.value?.click()
    }
    /**
     * 读取图片文件并写入节点：转成 dataURL 后交给 setNodeImage（同时保存文件名）。
     * 结束后清空 input.value，保证重复选择同一文件仍会触发 change。
     * @param {Event} event file input 的 change 事件
     * @returns {void}
     */
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
      <!-- 面板头：标题 + 选中节点的分类（按分类着色） -->
      <div class="panel-head">
        <span>{{ $t('insp.title') }}</span>
        <span v-if="def" class="dim" :style="{ color: catColor(def.category) }">{{ def.category }}</span>
        <span v-else class="dim">{{ $t('insp.noSelection') }}</span>
      </div>
      <div v-if="!node || !def" class="insp-empty">
        <div class="big">◎</div>
        {{ $t('insp.emptyTitle') }}<br />{{ $t('insp.emptyHint') }}
      </div>
      <div v-else class="insp-body">
        <!-- 节点标题（可直接改名）与定义名/节点 id 元信息 -->
        <div class="insp-node">
          <input class="title-input" :value="node.data.title || def.name" @change="onRename" />
          <div class="insp-meta">{{ def.name }} · {{ node.id }}</div>
        </div>

        <!-- 参数列表：按参数 type 分别渲染 bool / color / vec2 / select / gradient / text / 数值 -->
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
              <span class="dim small">{{ $t('insp.srgb') }}</span>
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

        <!-- 绘制型节点：进入绘制工作台 -->
        <div v-if="def.paintInput" class="insp-actions">
          <button class="btn primary" :disabled="state.mode === 'paint'" @click="openPaintStudio(node.id)">
            {{ state.mode === 'paint' ? $t('insp.painting') : $t('insp.openPaint') }}
          </button>
          <div class="hint">{{ $t('insp.strokes', { n: strokeCount }) }}</div>
        </div>

        <!-- 图片型节点：加载本地图片作为贴图 -->
        <div v-if="def.imageInput" class="insp-actions">
          <button class="btn" @click="pickFile">{{ $t('insp.loadImage') }}</button>
          <div class="hint">{{ node.data.imageName || $t('insp.noImage') }}</div>
          <input type="file" accept="image/*" ref="fileInput" style="display: none" @change="onFile" />
        </div>

        <div class="insp-desc">{{ def.desc }}</div>
      </div>
    </div>
  `
})
