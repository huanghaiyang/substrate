import { defineComponent, ref, watch, computed } from 'vue'
import { hexToRgb, rgbToHex, clamp, lerp } from '../engine/color.js'

export default defineComponent({
  name: 'GradientEditor',
  props: {
    stops: { type: Array, default: () => [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }] }
  },
  emits: ['update'],
  setup(props, { emit }) {
    const active = ref(0)
    const list = computed(() => {
      const arr = (props.stops || []).map((s) => ({ p: clamp(Number(s.p) || 0, 0, 1), c: s.c || '#000000' }))
      return arr.length ? arr.slice(0, 8).sort((a, b) => a.p - b.p) : [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }]
    })
    watch(list, () => {
      if (active.value > list.value.length - 1) active.value = list.value.length - 1
    })
    const barStyle = computed(() => {
      const stops = list.value.map((s) => `${s.c} ${(s.p * 100).toFixed(2)}%`).join(', ')
      return { background: `linear-gradient(90deg, ${stops})` }
    })
    const activeStop = computed(() => list.value[active.value] || list.value[0])

    function commit(next) {
      emit('update', next.slice(0, 8).map((s) => ({ p: +s.p.toFixed(4), c: s.c })))
    }
    function updateActive(patch) {
      const next = list.value.map((s, i) => (i === active.value ? { ...s, ...patch } : s))
      commit(next)
    }
    function addStop(event) {
      const rect = event.currentTarget.getBoundingClientRect()
      const p = clamp((event.clientX - rect.left) / rect.width, 0, 1)
      if (list.value.length >= 8) return
      // interpolate colour at p
      let color = list.value[0].c
      for (let i = 1; i < list.value.length; i++) {
        const a = list.value[i - 1]
        const b = list.value[i]
        if (p >= a.p && p <= b.p) {
          const t = (p - a.p) / Math.max(b.p - a.p, 1e-5)
          const ca = hexToRgb(a.c)
          const cb = hexToRgb(b.c)
          color = rgbToHex([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)])
          break
        }
      }
      const next = [...list.value, { p, c: color }].sort((x, y) => x.p - y.p)
      active.value = next.findIndex((s) => s.p === p)
      commit(next)
    }
    function removeStop() {
      if (list.value.length <= 2) return
      const next = list.value.filter((_, i) => i !== active.value)
      active.value = Math.max(0, active.value - 1)
      commit(next)
    }
    return { active, list, barStyle, activeStop, updateActive, addStop, removeStop }
  },
  template: `
    <div class="grad-editor">
      <div class="grad-bar" :style="barStyle" @click="addStop" title="Click to add a stop">
        <div
          v-for="(s, i) in list"
          :key="i"
          class="grad-stop"
          :class="{ active: i === active }"
          :style="{ left: (s.p * 100) + '%' }"
          @click.stop="active = i"
        ></div>
      </div>
      <div class="grad-controls">
        <input type="color" :value="activeStop.c" @input="updateActive({ c: $event.target.value })" />
        <input
          class="num"
          type="number" min="0" max="1" step="0.01"
          :value="activeStop.p"
          @change="updateActive({ p: Math.min(1, Math.max(0, Number($event.target.value) || 0)) })"
        />
        <span class="dim small" style="flex:1">{{ list.length }} stops</span>
        <button class="mini" title="Add stop" @click.stop="addStop({ currentTarget: $el.querySelector('.grad-bar'), clientX: 0 })" style="display:none">+</button>
        <button class="mini" @click="removeStop" title="Remove selected stop">−</button>
        <button class="mini" @click="active = (active + 1) % list.length" title="Select next stop">↻</button>
      </div>
    </div>
  `
})
