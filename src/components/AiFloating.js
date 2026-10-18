import { defineComponent, ref, computed, watch, nextTick, onMounted } from 'vue'
import { aiChat, hideFloating } from '../engine/ai-chat.js'

export default defineComponent({
  name: 'AiFloating',
  emits: ['expand'],
  setup(_props, { emit }) {
    const listEl = ref(null)
    const lastMessages = computed(() => aiChat.messages.slice(-8))
    const scroll = async () => {
      await nextTick()
      if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
    }
    watch(() => [aiChat.messages.length, aiChat.messages[aiChat.messages.length - 1]?.content, aiChat.busy], scroll)
    onMounted(scroll)
    return { messages: lastMessages, busy: computed(() => aiChat.busy), listEl, expand: () => emit('expand'), close: hideFloating }
  },
  template: `
    <div class="ai-float" @click.self="expand">
      <div class="ai-float-head">
        <span class="ai-float-title">✦ {{ $t('ai.title') }}</span>
        <span class="ai-float-status">{{ busy ? $t('ai.thinking') : $t('ai.floatDone') }}</span>
        <button class="icon-btn" :title="$t('ai.expand')" @click="expand">⤢</button>
        <button class="icon-btn" :title="$t('common.close')" @click="close">✕</button>
      </div>
      <div class="ai-float-list" ref="listEl">
        <div v-for="(m, i) in messages" :key="i" class="ai-float-msg" :class="m.role">
          <span class="ai-float-role">{{ m.role === 'user' ? $t('ai.you') : 'AI' }}</span>
          <span v-if="m.pending" class="ai-thinking">{{ $t('ai.thinking') }}</span>
          <span v-else class="ai-float-text">{{ m.content || m.error || '' }}</span>
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
