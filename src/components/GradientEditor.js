// ============================================================================
// GradientEditor —— 渐变参数编辑器（子组件，被 Inspector 使用）
//
// 界面位置：检查器面板里 type 为 'gradient' 的参数下方，是一条色带 + 色标控制行。
// 交互：点击色带空白处新增色标，拖动/选择色标后可用取色器与数值框修改其颜色和位置；
//      最多 8 个色标，任意修改都通过 emit('update', stops) 交回父组件保存。
//
// 与 engine 的交互：无直接依赖，仅做纯展示与编辑；颜色插值使用 engine/color.js 的工具函数。
// 注意：props.stops 只读，组件内部不会就地修改它，而是生成新数组后 emit 出去。
// ============================================================================
import { defineComponent, ref, watch, computed } from 'vue'
import { hexToRgb, rgbToHex, clamp, lerp } from '../engine/color.js'

export default defineComponent({
  name: 'GradientEditor',
  props: {
    /** 渐变停靠点数组：[{ p: 位置0~1, c: '#rrggbb' }]，默认黑白两色 */
    stops: { type: Array, default: () => [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }] }
  },
  emits: ['update'],
  setup(props, { emit }) {
    /** 当前选中的色标索引（用于取色器/数值框定位） */
    const active = ref(0)
    /**
     * 规范化后的停靠点列表：位置夹紧到 0~1、补齐颜色默认值、按位置升序、
     * 最多 8 个；若传入为空则回退到黑白默认值。
     */
    const list = computed(() => {
      const arr = (props.stops || []).map((s) => ({ p: clamp(Number(s.p) || 0, 0, 1), c: s.c || '#000000' }))
      return arr.length ? arr.slice(0, 8).sort((a, b) => a.p - b.p) : [{ p: 0, c: '#000000' }, { p: 1, c: '#ffffff' }]
    })
    // 停靠点数量变少时（如父组件恢复历史记录），把越界的选中索引收回到最后一个色标
    watch(list, () => {
      if (active.value > list.value.length - 1) active.value = list.value.length - 1
    })
    /** 色带背景：CSS linear-gradient，把每个停靠点转成 "颜色 百分比%" 片段 */
    const barStyle = computed(() => {
      const stops = list.value.map((s) => `${s.c} ${(s.p * 100).toFixed(2)}%`).join(', ')
      return { background: `linear-gradient(90deg, ${stops})` }
    })
    /** 当前选中的色标对象（索引失效时退回第一个，保证取色器总有值） */
    const activeStop = computed(() => list.value[active.value] || list.value[0])

    /**
     * 把新列表交回父组件。
     * 位置保留 4 位小数，避免浮点误差累积；仍然限制为最多 8 个色标。
     * @param {Array<{p:number,c:string}>} next
     */
    function commit(next) {
      emit('update', next.slice(0, 8).map((s) => ({ p: +s.p.toFixed(4), c: s.c })))
    }
    /**
     * 修改当前选中色标的某个字段（颜色或位置）。
     * @param {object} patch 需要合并的字段，如 { c: '#ff0000' } 或 { p: 0.5 }
     */
    function updateActive(patch) {
      const next = list.value.map((s, i) => (i === active.value ? { ...s, ...patch } : s))
      commit(next)
    }
    /**
     * 在色带被点击的位置插入一个新色标，其颜色取该位置在两个相邻色标间的插值结果，
     * 这样新增色标不会让渐变出现突兀的色块。
     * @param {MouseEvent} event 色带上的点击事件
     * @returns {void} 达到 8 个色标上限时直接返回
     */
    function addStop(event) {
      const rect = event.currentTarget.getBoundingClientRect()
      const p = clamp((event.clientX - rect.left) / rect.width, 0, 1)
      if (list.value.length >= 8) return
      // 在位置 p 处对相邻两色标做线性插值，得到新色标的初始颜色
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
    /** 删除当前选中色标；至少保留 2 个（渐变必须有起点和终点） */
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
      <!-- 色带本体：背景即渐变预览，点击空白处新增色标，色标圆点可点击选中 -->
      <div class="grad-bar" :style="barStyle" @click="addStop" :title="$t('grad.barTitle')">
        <div
          v-for="(s, i) in list"
          :key="i"
          class="grad-stop"
          :class="{ active: i === active }"
          :style="{ left: (s.p * 100) + '%' }"
          @click.stop="active = i"
        ></div>
      </div>
      <!-- 控制行：取色器、位置数值框、色标计数、删除与切换到下一个色标 -->
      <div class="grad-controls">
        <input type="color" :value="activeStop.c" @input="updateActive({ c: $event.target.value })" />
        <input
          class="num"
          type="number" min="0" max="1" step="0.01"
          :value="activeStop.p"
          @change="updateActive({ p: Math.min(1, Math.max(0, Number($event.target.value) || 0)) })"
        />
        <span class="dim small" style="flex:1">{{ $t('grad.stops', { n: list.length }) }}</span>
        <button class="mini" @click="removeStop" :title="$t('grad.remove')">−</button>
        <button class="mini" @click="active = (active + 1) % list.length" :title="$t('grad.next')">↻</button>
      </div>
    </div>
  `
})
