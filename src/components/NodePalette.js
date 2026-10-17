import { defineComponent, computed, ref } from 'vue'
import { NODE_DEFS, CATEGORIES } from '../engine/nodes/index.js'
import { catColor } from '../ui/theme.js'

export default defineComponent({
  name: 'NodePalette',
  emits: ['add'],
  setup(props, { emit }) {
    const query = ref('')
    const groups = computed(() => {
      const q = query.value.trim().toLowerCase()
      return CATEGORIES.map((cat) => ({
        cat,
        defs: NODE_DEFS.filter(
          (d) =>
            d.category === cat &&
            (!q || d.name.toLowerCase().includes(q) || d.type.includes(q) || (d.desc || '').toLowerCase().includes(q))
        )
      })).filter((g) => g.defs.length)
    })
    return { query, groups, catColor, emit }
  },
  template: `
    <div class="palette panel">
      <div class="palette-head">
        <div class="panel-head" style="height:auto;padding:0;border:none">
          <span>Node Library</span>
          <span class="dim">{{ groups.reduce((n, g) => n + g.defs.length, 0) }} nodes</span>
        </div>
        <input v-model="query" class="search" placeholder="Search generators, filters…" />
      </div>
      <div class="palette-scroll">
        <div v-for="group in groups" :key="group.cat" class="pal-group">
          <div class="pal-cat"><span class="cat-dot" :style="{ background: catColor(group.cat) }"></span>{{ group.cat }}</div>
          <button
            v-for="def in group.defs"
            :key="def.type"
            class="pal-item"
            :title="def.desc"
            @click="emit('add', def.type)"
          >
            <span class="pal-name">{{ def.name }}</span>
            <span class="pal-plus">+</span>
          </button>
        </div>
        <div v-if="!groups.length" class="pal-item dim">No nodes match "{{ query }}"</div>
      </div>
      <div class="palette-foot">Click a node to add it at the view centre, or right-click the graph for quick add.</div>
    </div>
  `
})
