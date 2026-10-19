// Parameter workbench for an imported .sbsar.
//
// What this is: the archive's *interface* (inputs with types/ranges/enums/defaults) is fully readable
// without Adobe's engine, so the values can be edited here and handed to the local native baker
// (sbsrender) as `--set-value` overrides. That is the "edit" half of the sbsar workflow; the "view"
// half is either the approximate in-app reconstruction or a real bake through the local engine.
//
// What this is NOT: changing a parameter cannot be reflected in the browser as Adobe's exact pixels —
// the graph is compiled into .sbsasm and only Adobe's native engine can evaluate it. The panel therefore
// states plainly whether a real bake backend is available instead of showing a fake preview.
import { computed, defineComponent, ref } from 'vue'
import { t } from '../i18n/index.js'

const NO_GROUP = '__ungrouped__'

export default defineComponent({
  name: 'SbsarParams',
  props: {
    asset: { type: Object, required: true },
    values: { type: Object, default: () => ({}) },
    bake: { type: Object, default: () => ({ loading: true, available: false }) }
  },
  emits: ['close', 'apply', 'bake'],
  setup(props, { emit }) {
    const inspection = computed(() => props.asset.inspection || {})
    const allParams = computed(() => (Array.isArray(inspection.value.parameters) ? inspection.value.parameters : []))
    const draft = ref({ ...(props.values || {}) })
    const search = ref('')
    const onlyChanged = ref(false)
    const status = ref('')

    const changed = (p) => draft.value[p.id] !== undefined && String(draft.value[p.id]) !== String(p.default)
    const valueOf = (p) => (draft.value[p.id] !== undefined ? draft.value[p.id] : p.default)
    const changedCount = computed(() => allParams.value.filter(changed).length)

    const visible = computed(() => {
      const q = search.value.trim().toLowerCase()
      return allParams.value.filter((p) => {
        if (onlyChanged.value && !changed(p)) return false
        if (!q) return true
        return String(p.id).toLowerCase().includes(q) || String(p.label || '').toLowerCase().includes(q)
      })
    })

    /** group parameters by the archive's guigroup path; keep the archive order inside a group */
    const groups = computed(() => {
      const map = new Map()
      for (const p of visible.value) {
        const key = p.group || NO_GROUP
        if (!map.has(key)) map.set(key, [])
        map.get(key).push(p)
      }
      return [...map.entries()].map(([name, list]) => ({ name: name === NO_GROUP ? t('sbsarParams.ungrouped') : name, list }))
    })

    const setValue = (p, v) => {
      draft.value = { ...draft.value, [p.id]: v }
    }
    const resetOne = (p) => {
      const next = { ...draft.value }
      delete next[p.id]
      draft.value = next
    }
    const resetAll = () => {
      draft.value = {}
      status.value = t('sbsarParams.resetDone')
    }

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

    const applyOnly = () => {
      emit('apply', { ...draft.value })
      emit('close')
    }
    const bakeNow = () => {
      emit('apply', { ...draft.value })
      emit('bake', { ...draft.value })
    }

    const fmtNum = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v)
      return String(Math.round(n * 1000) / 1000)
    }
    const rangeFor = (p) => {
      const min = Number.isFinite(Number(p.min)) ? Number(p.min) : 0
      const max = Number.isFinite(Number(p.max)) ? Number(p.max) : 1
      const step = Number.isFinite(Number(p.step)) && Number(p.step) > 0 ? Number(p.step) : max - min > 4 ? 0.01 : (max - min) / 100
      return { min, max, step }
    }
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
