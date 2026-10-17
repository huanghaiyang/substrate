import { defineComponent, computed, ref } from 'vue'
import { NODE_DEFS, CATEGORIES } from '../engine/nodes/index.js'
import { catColor } from '../ui/theme.js'
import { trNode } from '../i18n/index.js'

export default defineComponent({
  name: 'NodePalette',
  emits: ['add'],
  setup(props, { emit }) {
    const query = ref('')
    const groups = computed(() => {
      const q = query.value.trim().toLowerCase()
      const match = (d) => {
        if (!q) return true
        const haystack = [d.name, d.category, d.desc, trNode(d.name), trNode(d.category), trNode(d.desc)]
          .join(' ')
          .toLowerCase()
        return haystack.includes(q)
      }
      return CATEGORIES.map((cat) => ({
        cat,
        defs: NODE_DEFS.filter((d) => d.category === cat && match(d))
      })).filter((g) => g.defs.length)
    })
    const count = computed(() => groups.value.reduce((n, g) => n + g.defs.length, 0))
    return { query, groups, count, catColor, emit }
  },
  template: `
    <div class="palette panel">
      <div class="palette-head">
        <div class="panel-head" style="height:auto;padding:0;border:none">
          <span>{{ $t('palette.title') }}</span>
          <span class="dim">{{ $t('palette.count', { n: count }) }}</span>
        </div>
        <input v-model="query" class="search" :placeholder="$t('palette.search')" />
      </div>
      <div class="palette-scroll">
        <div v-for="group in groups" :key="group.cat" class="pal-group">
          <div class="pal-cat"><span class="cat-dot" :style="{ background: catColor(group.cat) }"></span>{{ $trNode(group.cat) }}</div>
          <button
            v-for="def in group.defs"
            :key="def.type"
            class="pal-item"
            :title="$trNode(def.desc)"
            @click="emit('add', def.type)"
          >
            <span class="pal-name">{{ $trNode(def.name) }}</span>
            <span class="pal-plus">+</span>
          </button>
        </div>
        <div v-if="!groups.length" class="pal-item dim">{{ $t('palette.empty', { q: query }) }}</div>
      </div>
      <div class="palette-foot">{{ $t('palette.foot') }}</div>
    </div>
  `
})
