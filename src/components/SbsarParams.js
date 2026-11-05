// ============================================================================
// SbsarParams —— .sbsar 参数工作台（模态框）
//
// 界面位置：素材库中展开某个 .sbsar 归档后，点「参数编辑」打开的弹窗。
//
// 它是什么：归档的「接口」部分（带类型/范围/枚举/默认值的输入参数）无需 Adobe 引擎即可读取，
// 所以可以在这里编辑参数值，并作为 `--set-value` 覆盖项交给本地原生烘焙器（sbsrender）。
// 这就是 sbsar 工作流中「编辑」的一半；「查看」的一半则是应用内的近似重建或经本地引擎的真实烘焙。
//
// 它不是什么：改参数无法在浏览器里得到 Adobe 的精确像素 —— 图被编译成 .sbsasm，
// 只有 Adobe 原生引擎能求值。因此本面板会如实说明是否有可用的真实烘焙后端，而不是伪造预览。
//
// 与 engine 的交互：不直接依赖 store；只通过 props.asset / props.values 接收数据，
// 并通过 emit('apply' / 'bake' / 'close') 把草稿交回父组件（AssetLibrary）处理。
// ============================================================================
import { computed, defineComponent, ref } from 'vue'
import { t } from '../i18n/index.js'

/** 未分组参数使用的伪分组键 */
const NO_GROUP = '__ungrouped__'

export default defineComponent({
  name: 'SbsarParams',
  props: {
    /** 素材库中的 .sbsar 素材对象（含 inspection 解析报告） */
    asset: { type: Object, required: true },
    /** 已保存的参数覆盖值：{ [参数id]: 值 } */
    values: { type: Object, default: () => ({}) },
    /** 烘焙后端状态 { loading, available, reason, sbsrender, installUrl } */
    bake: { type: Object, default: () => ({ loading: true, available: false }) }
  },
  emits: ['close', 'apply', 'bake'],
  setup(props, { emit }) {
    /** 解析报告（可能为空对象，模板中全部用可选链访问） */
    const inspection = computed(() => props.asset.inspection || {})
    /** 报告中的参数列表；结构异常时退化为空数组 */
    const allParams = computed(() => (Array.isArray(inspection.value.parameters) ? inspection.value.parameters : []))
    /** 编辑中的草稿：初始为已保存的覆盖值；删除某项即表示「恢复默认」 */
    const draft = ref({ ...(props.values || {}) })
    /** 搜索关键词（匹配参数 id 或标签） */
    const search = ref('')
    /** 是否只显示被改动的参数 */
    const onlyChanged = ref(false)
    /** 操作状态提示（重置/导入/导出结果） */
    const status = ref('')

    /**
     * 判断参数是否被改动过：草稿里有值且与默认值字符串不同。
     * 统一转字符串比较，兼容 '1' / 1 / true 这类表示差异。
     * @param {object} p 参数项
     * @returns {boolean}
     */
    const changed = (p) => draft.value[p.id] !== undefined && String(draft.value[p.id]) !== String(p.default)
    /**
     * 取参数当前生效值：草稿优先，否则用默认值。
     * @param {object} p 参数项
     * @returns {*}
     */
    const valueOf = (p) => (draft.value[p.id] !== undefined ? draft.value[p.id] : p.default)
    /** 被改动参数的数量，显示在工具栏 */
    const changedCount = computed(() => allParams.value.filter(changed).length)

    /** 经「仅显示改动」与搜索过滤后的参数列表 */
    const visible = computed(() => {
      const q = search.value.trim().toLowerCase()
      return allParams.value.filter((p) => {
        if (onlyChanged.value && !changed(p)) return false
        if (!q) return true
        return String(p.id).toLowerCase().includes(q) || String(p.label || '').toLowerCase().includes(q)
      })
    })

    /** 按归档的 guigroup 路径分组；组内保持归档原有顺序 */
    const groups = computed(() => {
      const map = new Map()
      for (const p of visible.value) {
        const key = p.group || NO_GROUP
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(p)
      }
      return [...map.entries()].map(([name, list]) => ({ name: name === NO_GROUP ? t('sbsarParams.ungrouped') : name, list }))
    })

    /**
     * 写入单个参数到草稿（不立即保存，等用户点「应用」或「烘焙」）。
     * @param {object} p 参数项
     * @param {string|boolean} v 新值
     */
    const setValue = (p, v) => {
      draft.value = { ...draft.value, [p.id]: v }
    }
    /**
     * 把单个参数恢复默认：从草稿中删除该键（而不是写入默认值），
     * 这样父组件能区分「未覆盖」与「显式设为默认值」。
     * @param {object} p 参数项
     */
    const resetOne = (p) => {
      const next = { ...draft.value }
      delete next[p.id]
      draft.value = next
    }
    /** 清空所有覆盖值，全部回到归档默认 */
    const resetAll = () => {
      draft.value = {}
      status.value = t('sbsarParams.resetDone')
    }

    /**
     * 把当前改动导出为 JSON 文件（kind/version/archive/graph/params），
     * 便于在命令行或其它工具里复用同一组覆盖值。
     */
    const exportJson = () => {
      const overrides = {}
      for (const p of allParams.value) if (changed(p)) overrides[p.id] = String(valueOf(p))
      const payload = {
        kind: 'substrate.sbsar.params',
        version: 1,
        archive: props.asset.name,
        graph: inspection.value.graphs?.[0]?.identifier || null,
        params: overrides
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = String(props.asset.name || 'sbsar').replace(/\.sbsar$/i, '') + '.params.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      status.value = t('sbsarParams.exported', { n: Object.keys(overrides).length })
    }

    /**
     * 从 JSON 文件导入覆盖值：只接受归档里真实存在的参数 id（未知 id 直接忽略），
     * 兼容「带 params 包装」与「裸 map」两种格式。
     * @param {Event} event file input 的 change 事件
     * @returns {Promise<void>}
     */
    const importJson = async (event) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        const data = JSON.parse(await file.text())
        const overrides = data && typeof data === 'object' && data.params ? data.params : data
        if (!overrides || typeof overrides !== 'object') throw new Error('no params object')
        const known = new Set(allParams.value.map((p) => p.id))
        const next = { ...draft.value }
        let applied = 0
        for (const [id, v] of Object.entries(overrides)) {
          if (!known.has(id)) continue
          next[id] = String(v)
          applied++
        }
        draft.value = next
        status.value = t('sbsarParams.imported', { n: applied })
      } catch (e) {
        status.value = '✕ ' + (e.message || String(e))
      }
    }

    /** 只保存参数覆盖值并关闭弹窗（不触发烘焙） */
    const applyOnly = () => {
      emit('apply', { ...draft.value })
      emit('close')
    }
    /** 先保存覆盖值，再请求父组件用这些覆盖值调用本地引擎烘焙 */
    const bakeNow = () => {
      emit('apply', { ...draft.value })
      emit('bake', { ...draft.value })
    }

    /**
     * 数值展示：保留最多 3 位小数（去掉多余尾零），非数字原样返回。
     * @param {*} v
     * @returns {string}
     */
    const fmtNum = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return String(Math.round(n * 1000) / 1000)
    }
    /**
     * 推导滑杆的 min/max/step：归档未给 step 时按量程自动估算
     * （跨度大于 4 用 0.01，否则用量程的 1/100）。
     * @param {object} p 参数项
     * @returns {{min:number, max:number, step:number}}
     */
    const rangeFor = (p) => {
      const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0
      const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 1
      const step = Number.isFinite(Number(p.step)) && Number(p.step) > 0 ? Number(p.step) : max - min > 4 ? 0.01 : (max - min) / 100
      return { min, max, step }
    }
    /**
     * 是否按「向量/颜色」处理：类型为 vector2~4 或 color，或默认值本身是逗号分隔的多分量。
     * @param {object} p 参数项
     * @returns {boolean}
     */
    const isVector = (p) => ['vector2', 'vector3', 'vector4', 'color'].includes(String(p.kind)) || String(p.default || '').includes(',')

    return {
      t,
      inspection,
      allParams,
      draft,
      search,
      onlyChanged,
      status,
      changed,
      valueOf,
      changedCount,
      visible,
      groups,
      setValue,
      resetOne,
      resetAll,
      exportJson,
      importJson,
      applyOnly,
      bakeNow,
      fmtNum,
      rangeFor,
      isVector
    }
  },
  template: `
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal wide sbsar-params-modal">
      <div class="modal-head">
        <div class="modal-title">{{ t('sbsarParams.title') }} · {{ asset.name }}</div>
        <button class="icon-btn" @click="$emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="sbsar-note soft">{{ t('sbsarParams.hint') }}</div>
        <!-- 参数工具栏：搜索、仅显示改动、改动计数、重置/导出/导入 -->
        <div class="sbsar-param-toolbar">
          <input class="sbsar-param-search" :placeholder="t('sbsarParams.search')" v-model="search" />
          <label class="sbsar-param-check"><input type="checkbox" v-model="onlyChanged" /> {{ t('sbsarParams.onlyChanged') }}</label>
          <span class="spacer"></span>
          <span class="sbsar-param-count">{{ t('sbsarParams.changed', { n: changedCount }) }}</span>
          <button class="btn tiny" @click="resetAll">{{ t('sbsarParams.resetAll') }}</button>
          <button class="btn tiny" @click="exportJson">{{ t('sbsarParams.export') }}</button>
          <label class="btn tiny sbsar-param-import">{{ t('sbsarParams.import') }}<input type="file" accept=".json,application/json" @change="importJson" /></label>
        </div>
        <div v-if="!allParams.length" class="hint">{{ t('sbsarParams.none') }}</div>
        <!-- 按 guigroup 分组渲染参数；每行按 kind / 向量判定选择不同控件 -->
        <div v-for="g in groups" :key="g.name" class="sbsar-param-group">
          <div class="sbsar-param-group-head">{{ g.name }}</div>
          <div v-for="p in g.list" :key="p.id" class="sbsar-param-row" :class="{ changed: changed(p) }">
            <div class="sbsar-param-meta">
              <div class="sbsar-param-label" :title="p.id">{{ p.label || p.id }}</div>
              <div class="sbsar-param-id">{{ p.id }}<span v-if="p.kind" class="sbsar-param-kind">{{ p.kind }}</span></div>
            </div>
            <div class="sbsar-param-control">
              <template v-if="p.kind === 'bool'">
                <input type="checkbox" :checked="String(valueOf(p)) === '1' || valueOf(p) === true" @change="setValue(p, $event.target.checked ? '1' : '0')" />
              </template>
              <template v-else-if="p.kind === 'enum'">
                <select :value="String(valueOf(p))" @change="setValue(p, $event.target.value)">
                  <option v-for="(item, i) in (p.enumItems || [])" :key="i" :value="String(i)">{{ item }}</option>
                </select>
              </template>
              <template v-else-if="isVector(p)">
                <input class="sbsar-param-text" :value="valueOf(p)" @input="setValue(p, $event.target.value)" />
              </template>
              <template v-else>
                <input v-if="p.min != null && p.max != null" type="range" :min="rangeFor(p).min" :max="rangeFor(p).max" :step="rangeFor(p).step"
                       :value="Number(valueOf(p))" @input="setValue(p, $event.target.value)" />
                <input class="sbsar-param-num" type="number" :step="rangeFor(p).step"
                       :value="Number(valueOf(p))" @input="setValue(p, $event.target.value)" />
              </template>
              <button v-if="changed(p)" class="sbsar-param-reset" :title="t('sbsarParams.resetOne')" @click="resetOne(p)">↺</button>
            </div>
          </div>
        </div>
        <div v-if="status" class="sbsar-note soft">{{ status }}</div>
      </div>
      <div class="modal-foot">
        <!-- 底部左侧：烘焙后端可用性说明（加载中 / 可用并给出 sbsrender 路径 / 不可用原因） -->
        <div class="sbsar-param-bake-note">
          <template v-if="bake.loading">{{ t('common.loading') }}</template>
          <template v-else-if="bake.available">{{ t('sbsarParams.bakeReady', { path: bake.sbsrender }) }}</template>
          <template v-else>{{ t('sbsarParams.bakeUnavailable') }}</template>
        </div>
        <span class="spacer"></span>
        <button class="btn" @click="$emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn" @click="applyOnly">{{ t('sbsarParams.apply') }}</button>
        <button class="btn accent" :disabled="!bake.available" :title="bake.available ? t('sbsarParams.bakeReady', { path: bake.sbsrender }) : bake.reason" @click="bakeNow">
          {{ t('sbsarParams.bake') }}
        </button>
      </div>
    </div>
  </div>
  `
})
