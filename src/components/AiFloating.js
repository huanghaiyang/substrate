// ============================================================================
// AiFloating —— AI 助手的迷你悬浮窗
//
// 界面位置：主界面右下角。用户把 AiPanel 收起后仍保留的「小窗」，只显示最近几条消息。
// 展开（⤢ 或点击空白处）时 emit('expand')，由父组件切换回完整的 AiPanel。
//
// 与 engine 的交互：不自行请求网络，完全读写 engine/ai-chat.js 导出的单例对象 aiChat
// （messages / busy 由该模块统一维护），关闭时调用同模块的 hideFloating()。
// ============================================================================
import { defineComponent, ref, computed, watch, nextTick, onMounted } from 'vue'
import { aiChat, hideFloating } from '../engine/ai-chat.js'

export default defineComponent({
  name: 'AiFloating',
  emits: ['expand'],
  setup(_props, { emit }) {
    /** 消息列表容器，用于滚动到底部 */
    const listEl = ref(null)
    /** 只取最近 8 条消息，控制小窗高度；aiChat.messages 本身是全量历史 */
    const lastMessages = computed(() => aiChat.messages.slice(-8))
    /**
     * 滚到列表底部，让最新消息可见。
     * 必须等 nextTick：新消息节点先渲染进 DOM，scrollHeight 才是更新后的值。
     * @returns {Promise<void>}
     */
    const scroll = async () => {
      await nextTick()
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    }
    // 监听「消息条数 / 最后一条消息正文 / busy 状态」三者：流式输出时 content 会不断变化，
    // 因此需要持续滚底；busy 变化则用于在“思考中…”占位出现时也滚到底。
    watch(() => [aiChat.messages.length, aiChat.messages[aiChat.messages.length - 1]?.content, aiChat.busy], scroll)
    onMounted(scroll)
    return { messages: lastMessages, busy: computed(() => aiChat.busy), listEl, expand: () => emit('expand'), close: hideFloating }
  },
  template: `
    <div class="ai-float" @click.self="expand">
      <!-- 标题栏：状态文案 + 展开/关闭按钮 -->
      <div class="ai-float-head">
        <span class="ai-float-title">✦ {{ $t('ai.title') }}</span>
        <span class="ai-float-status">{{ busy ? $t('ai.thinking') : $t('ai.floatDone') }}</span>
        <button class="icon-btn" :title="$t('ai.expand')" @click="expand">⤢</button>
        <button class="icon-btn" :title="$t('common.close')" @click="close">✕</button>
      </div>
      <!-- 最近 8 条消息：推理摘要、正文、附件名、工具调用轨迹 -->
      <div class="ai-float-list" ref="listEl">
        <div v-for="(m, i) in messages" :key="i" class="ai-float-msg" :class="m.role">
          <span class="ai-float-role">{{ m.role === 'user' ? $t('ai.you') : 'AI' }}</span>
          <details v-if="m.reasoning && m.reasoning.length" class="ai-reasoning ai-reasoning-float">
            <summary>{{ $t('ai.reasoning') }} · {{ m.reasoning.length }}</summary>
            <pre v-for="(r, ri) in m.reasoning" :key="ri">{{ r.text }}</pre>
          </details>
          <span v-if="m.pending" class="ai-thinking">{{ $t('ai.thinking') }}</span>
          <span v-else class="ai-float-text">{{ m.content || m.error || '' }}</span>
          <span v-if="m.attachments && m.attachments.length" class="ai-float-atts">📎 {{ m.attachments.map(a => a.name).join(', ') }}</span>
          <div v-if="m.hitStepLimit" class="ai-step-limit">{{ $t('ai.stepLimit') }}</div>
          <div v-if="m.trace && m.trace.length" class="ai-float-tools">
            <span v-for="(tr, k) in m.trace.slice(-5)" :key="k" class="ai-float-tool" :class="{ ok: tr.ok, bad: !tr.ok }">
              {{ tr.ok ? '✓' : '✕' }} {{ tr.name }}
            </span>
          </div>
        </div>
      </div>
      <div class="ai-float-foot">{{ $t('ai.floatHint') }}</div>
    </div>
  `
})
