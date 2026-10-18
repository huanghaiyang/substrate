import { defineComponent, ref, computed, onMounted, nextTick } from 'vue'
import { fetchModels, chatWithAssistant, saveProvider, deleteProvider, testProviderModel } from '../engine/llm-client.js'
import { runMcpSelfCheck } from '../engine/mcp-selfcheck.js'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'AiPanel',
  emits: ['close'],
  setup(_props, { emit }) {
    const models = ref([])
    const providers = ref([])
    const modelKey = ref(localStorage.getItem('substrate.llmModel') || '')
    const messages = ref([])
    const input = ref('')
    const busy = ref(false)
    const error = ref('')
    const showSettings = ref(false)
    const selfcheck = ref(null)
    const checking = ref(false)
    const testing = ref(false)
    const testResult = ref('')
    const chatEl = ref(null)
    const form = ref({ id: '', label: '', baseUrl: 'https://api.deepseek.com', models: 'deepseek-chat', apiKey: '' })

    const currentModel = computed(() => models.value.find((m) => m.key === modelKey.value) || models.value[0] || null)
    const quickPrompts = computed(() => [
      { titleKey: 'ai.quick1', text: '给我当前材质加一点锈迹和苔藓' },
      { titleKey: 'ai.quick2', text: '把分辨率设为 512 并检查材质状态' },
      { titleKey: 'ai.quick3', text: '生成一套锈蚀金属质感的节点连接' },
      { titleKey: 'ai.quick4', text: '导出当前材质为 Unity 贴图包（512）' }
    ])

    async function loadModels() {
      try {
        const data = await fetchModels()
        models.value = data.models || []
        providers.value = data.providers || []
        if (!modelKey.value || !models.value.some((m) => m.key === modelKey.value)) {
          modelKey.value = data.defaultModel || models.value[0]?.key || ''
        }
      } catch (e) {
        error.value = String(e.message || e)
      }
    }
    function selectModel(event) {
      modelKey.value = event.target.value
      localStorage.setItem('substrate.llmModel', modelKey.value)
    }
    async function scrollChat() {
      await nextTick()
      if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
    }
    async function send(text) {
      const content = String(text ?? input.value).trim()
      if (!content || busy.value) return
      if (!currentModel.value) {
        error.value = t('ai.noModel')
        return
      }
      if (!currentModel.value.hasKey) {
        error.value = t('ai.noKey')
        return
      }
      input.value = ''
      error.value = ''
      messages.value.push({ role: 'user', content })
      await scrollChat()
      busy.value = true
      try {
        const history = messages.value
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content }))
        const result = await chatWithAssistant({ modelKey: modelKey.value, messages: history, maxSteps: 8 })
        if (result?.ok) {
          messages.value.push({ role: 'assistant', content: result.reply || '', trace: result.toolCalls || [], model: result.model })
        } else {
          messages.value.push({ role: 'assistant', content: '', error: result?.error?.message || '请求失败', trace: result?.toolCalls || [] })
        }
      } catch (e) {
        messages.value.push({ role: 'assistant', content: '', error: String(e.message || e) })
      } finally {
        busy.value = false
        await scrollChat()
      }
    }
    function onKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        send()
      }
    }
    async function runCheck() {
      checking.value = true
      try {
        selfcheck.value = await runMcpSelfCheck()
      } catch (e) {
        selfcheck.value = { ok: false, totals: { passed: 0, failed: 1 }, checks: [{ name: 'selfcheck', ok: false, info: String(e.message || e) }] }
      } finally {
        checking.value = false
      }
    }
    async function saveProviderForm() {
      testResult.value = ''
      try {
        const modelIds = String(form.value.models || '')
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean)
          .map((id) => ({ id, label: id }))
        const data = await saveProvider({
          id: form.value.id || undefined,
          label: form.value.label || form.value.id || 'Custom',
          baseUrl: form.value.baseUrl,
          models: modelIds,
          apiKey: form.value.apiKey || undefined
        })
        if (!data?.ok) throw new Error(data?.error?.message || 'save failed')
        models.value = data.models || []
        providers.value = data.providers || []
        form.value = { id: '', label: '', baseUrl: 'https://api.deepseek.com', models: 'deepseek-chat', apiKey: '' }
        if (!models.value.some((m) => m.key === modelKey.value)) {
          modelKey.value = data.defaultModel || models.value[0]?.key || ''
          localStorage.setItem('substrate.llmModel', modelKey.value)
        }
        testResult.value = '✓ 已保存（密钥只保存在本机服务端）'
      } catch (e) {
        testResult.value = '✕ ' + (e.message || String(e))
      }
    }
    async function removeProviderEntry(p) {
      if (!p) return
      try {
        const data = await deleteProvider(p.id)
        if (!data?.ok) throw new Error(data?.error?.message || 'delete failed')
        models.value = data.models || []
        providers.value = data.providers || []
        if (!models.value.some((m) => m.key === modelKey.value)) {
          modelKey.value = models.value[0]?.key || ''
          localStorage.setItem('substrate.llmModel', modelKey.value)
        }
        testResult.value = '✓ 已删除提供商 ' + p.label
      } catch (e) {
        testResult.value = '✕ ' + (e.message || String(e))
      }
    }
    async function testCurrent() {
      if (!currentModel.value) return
      testing.value = true
      testResult.value = ''
      try {
        const data = await testProviderModel(currentModel.value.key)
        testResult.value = data?.ok ? '✓ 连通性正常：' + (data.reply || 'OK') + ' · ' + data.durationMs + ' ms' : '✕ ' + (data?.error?.message || '失败')
      } catch (e) {
        testResult.value = '✕ ' + (e.message || String(e))
      } finally {
        testing.value = false
      }
    }

    onMounted(async () => {
      await loadModels()
      await scrollChat()
    })

    return {
      models,
      providers,
      modelKey,
      currentModel,
      messages,
      input,
      busy,
      error,
      showSettings,
      selfcheck,
      checking,
      testing,
      testResult,
      chatEl,
      form,
      quickPrompts,
      selectModel,
      send,
      onKeydown,
      runCheck,
      saveProviderForm,
      removeProviderEntry,
      testCurrent,
      close: () => emit('close')
    }
  },
  template: `
    <div class="ai-panel">
      <div class="ai-head">
        <span class="ai-title">✦ {{ $t('ai.title') }}</span>
        <select class="top-select ai-model" :value="modelKey" @change="selectModel" :title="$t('ai.model')">
          <option v-for="m in models" :key="m.key" :value="m.key">{{ m.label }} · {{ m.provider }}</option>
        </select>
        <button class="icon-btn" :title="$t('ai.selfcheck')" @click="runCheck" :disabled="checking">{{ checking ? '…' : '◎' }}</button>
        <button class="icon-btn" :title="$t('ai.settings')" @click="showSettings = !showSettings">⚙</button>
        <button class="icon-btn" @click="close">✕</button>
      </div>

      <div v-if="showSettings" class="ai-settings">
        <div class="side-title">{{ $t('ai.providers') }}</div>
        <div v-for="p in providers" :key="p.id" class="ai-provider">
          <div class="ai-provider-main">
            <strong>{{ p.label }}</strong>
            <span class="dim small">{{ p.baseUrl }}</span>
            <span class="dim small">{{ p.models.map(m => m.id).join(', ') }}</span>
            <span class="ai-key-state" :class="{ ok: p.hasKey }">{{ p.hasKey ? $t('ai.keySet') : $t('ai.keyMissing') }}</span>
          </div>
          <button class="icon-btn" :title="$t('ai.delete')" @click="removeProviderEntry(p)">✕</button>
        </div>
        <div class="side-title">{{ $t('ai.addProvider') }}</div>
        <div class="ai-form">
          <input v-model="form.label" :placeholder="$t('ai.providerLabel')" />
          <input v-model="form.baseUrl" :placeholder="$t('ai.providerUrl')" />
          <input v-model="form.models" :placeholder="$t('ai.providerModels')" />
          <input v-model="form.apiKey" type="password" autocomplete="off" :placeholder="$t('ai.providerKey')" />
          <div class="ai-form-row">
            <button class="btn" @click="saveProviderForm">{{ $t('ai.save') }}</button>
            <button class="btn" :disabled="testing" @click="testCurrent">{{ testing ? '…' : $t('ai.test') }}</button>
          </div>
        </div>
        <div v-if="testResult" class="ai-test">{{ testResult }}</div>
        <div class="hint small">{{ $t('ai.keyHint') }}</div>
      </div>

      <div v-if="selfcheck" class="ai-check" :class="selfcheck.ok ? 'ok' : 'bad'">
        <div>{{ selfcheck.ok ? $t('ai.selfcheckPass') : $t('ai.selfcheckFail') }} · {{ selfcheck.totals.passed }}/{{ selfcheck.totals.passed + selfcheck.totals.failed }}</div>
        <div v-for="c in selfcheck.checks.filter(c => !c.ok).slice(0, 6)" :key="c.name" class="dim small">✕ {{ c.name }} {{ c.info }}</div>
      </div>

      <div class="ai-messages" ref="chatEl">
        <div v-if="!messages.length" class="ai-empty">
          <div class="ai-empty-title">✦ {{ $t('ai.emptyTitle') }}</div>
          <div class="hint">{{ $t('ai.emptyHint') }}</div>
          <div class="ai-quick">
            <button v-for="q in quickPrompts" :key="q.titleKey" class="btn tiny" @click="send(q.text)">{{ q.titleKey ? $t(q.titleKey) : q.text }}</button>
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
          <div v-if="m.role === 'user'" class="ai-bubble user">{{ m.content }}</div>
          <div v-else class="ai-bubble assistant">
            <div v-if="m.content" class="ai-text">{{ m.content }}</div>
            <div v-if="m.error" class="ai-error">✕ {{ m.error }}</div>
            <div v-if="m.trace && m.trace.length" class="ai-trace">
              <div v-for="(t, k) in m.trace" :key="k" class="ai-tool" :class="{ ok: t.ok, bad: !t.ok }">
                <span class="ai-tool-name">{{ t.ok ? '✓' : '✕' }} {{ t.name }}</span>
                <span v-if="t.error" class="dim small">{{ t.error }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="busy" class="ai-bubble assistant ai-thinking">{{ $t('ai.thinking') }}</div>
      </div>

      <div v-if="error" class="ai-error ai-error-bar">{{ error }}</div>
      <div class="ai-input-row">
        <textarea
          v-model="input"
          :placeholder="$t('ai.placeholder')"
          rows="2"
          @keydown="onKeydown"
          :disabled="busy"
        ></textarea>
        <button class="btn primary" :disabled="busy || !input.trim()" @click="send()">{{ $t('ai.send') }}</button>
      </div>
      <div class="hint small ai-foot">{{ $t('ai.hint') }}</div>
    </div>
  `
})
