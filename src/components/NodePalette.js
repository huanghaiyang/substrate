// ============================================================================
// NodePalette —— 左侧「节点库」面板
//
// 界面位置：主界面左侧，列出所有可添加的节点，按分类分组，供用户点击或拖拽到图中。
// 本组件只负责「展示 + 过滤 + 发出 add 事件」，真正的建节点由 GraphEditor/父组件调用 store。
//
// 与 engine 的交互：NODE_DEFS / CATEGORIES 来自 engine/nodes/index.js（节点定义表）；
// trNode 来自 i18n，用于把节点名/分类/描述翻译成当前语言。
// ============================================================================
import { defineComponent, computed, ref } from 'vue'
import { NODE_DEFS, CATEGORIES } from '../engine/nodes/index.js'
import { catColor } from '../ui/theme.js'
import { trNode } from '../i18n/index.js'

export default defineComponent({
  name: 'NodePalette',
  emits: ['add'],
  setup(props, { emit }) {
    /** 搜索框关键词（已去除首尾空白的原始输入） */
    const query = ref('')
    /**
     * 按分类分组后的节点列表。
     * 匹配规则：关键词同时匹配原始名称/分类/描述与翻译后的名称/分类/描述，
     * 这样中英文输入都能搜到；空分组会被过滤掉。
     */
    const groups = computed(() => {
      const q = query.value.trim().toLowerCase()
      /**
       * 判断某节点定义是否命中当前搜索词。
       * @param {object} d 节点定义（含 name/category/desc 字段）
       * @returns {boolean}
       */
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
    /** 当前可见（过滤后）的节点总数，显示在面板标题右侧 */
    const count = computed(() => groups.value.reduce((n, g) => n + g.defs.length, 0))
    // emit 直接暴露给模板：点击条目时由父组件真正创建节点
    return { query, groups, count, catColor, emit }
  },
  template: `
    <div class="palette panel">
      <!-- 面板头：标题、可见数量与搜索框 -->
      <div class="palette-head">
        <div class="panel-head" style="height:auto;padding:0;border:none">
          <span>{{ $t('palette.title') }}</span>
          <span class="dim">{{ $t('palette.count', { n: count }) }}</span>
        </div>
        <input v-model="query" class="search" :placeholder="$t('palette.search')" />
      </div>
      <div class="palette-scroll">
        <!-- 单个分类分组：分类色点 + 分类名，下面是该分类的节点按钮 -->
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
