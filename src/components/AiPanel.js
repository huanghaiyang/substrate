// ============================================================================
// AiPanel —— AI 助手完整对话面板
//
// 界面位置：主界面右侧可展开的 AI 侧栏（与右下角迷你窗 AiFloating 互为两种形态）。
// 结构自上而下：标题栏（模型选择/导出/清空/自检/设置）→ 会话切换条 → 设置区（可折叠）
// → 自检结果 → 消息列表 → 错误条 → 待发送附件 → 输入区。
//
// 与 engine 的交互：
//  - 对话状态全部托管在 engine/ai-chat.js 的 aiChat 单例（messages / busy / 会话列表 /
//    草稿附件 / 模型选择），本组件只是它的视图层；
//  - 模型与提供商管理调用 engine/llm-client.js（fetchModels / saveProvider / testProviderModel）；
//  - 自检调用 engine/mcp-selfcheck.js；API Key 只提交给本机服务端，前端从不持久化。
// ============================================================================
import { defineComponent, ref, computed, onMounted, nextTick, watch } from 'vue'
import { fetchModels, saveProvider, deleteProvider, testProviderModel, fetchAiRules } from '../engine/llm-client.js'
import { runMcpSelfCheck } from '../engine/mcp-selfcheck.js'
import { aiChat, sendChat, clearChat, newConversation, switchConversation, deleteConversation, setChatModel, setShowThinking, exportChatMarkdown } from '../engine/ai-chat.js'
import { t } from '../i18n/index.js'

export default defineComponent({
  name: 'AiPanel',
  emits: ['close'],
  setup(_props, { emit }) {
    /** 可用模型列表（由服务端接口返回，含 key/label/provider/hasKey） */
    const models = ref([])
    /** 是否在消息中展示推理过程（设置项，读自 aiChat） */
    const showThinking = computed(() => aiChat.showThinking)
    /** 已配置的提供商列表（用于设置区展示与删除） */
    const providers = ref([])
    /** 当前选中的模型 key */
    const modelKey = computed(() => aiChat.modelKey)
    /** 输入框内容 */
    const input = ref('')
    /** 是否展开设置区 */
    const showSettings = ref(false)
    /** 最近一次 MCP 自检结果；null 表示未运行 */
    const selfcheck = ref(null)
    /** 服务端下发的 AI 行为规则（用于提示用户当前约束） */
    const aiRules = ref([])
    /** 自检进行中 */
    const checking = ref(false)
    /** 连通性测试进行中 */
    const testing = ref(false)
    /** 设置区的操作反馈文案（✓ 成功 / ✕ 失败） */
    const testResult = ref('')
    /** 消息列表容器，用于自动滚底 */
    const chatEl = ref(null)
    /** 会话列表：按 updatedAt 倒序，最近活跃的排前面 */
    const conversations = computed(() => [...aiChat.conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)))
    /** 当前会话 id */
    const activeConversationId = computed(() => aiChat.activeConversationId)
    /** 隐藏的文件选择框 */
    const attachInput = ref(null)
    /** 附件上传错误提示 */
    const attachError = ref('')
    /** 附件上传中标记（上传期间禁止发送） */
    const uploading = ref(false)
    /** 尚未发送的附件（直接引用 aiChat 的草稿数组） */
    const pendingAttachments = computed(() => aiChat.draftAttachments || [])
    /** 新增提供商的表单：id/label/baseUrl/models（逗号分隔）/apiKey */
    const form = ref({ id: '', label: '', baseUrl: 'https://api.deepseek.com', models: 'deepseek-chat', apiKey: '' })

    /** 当前选中的模型对象；找不到时退回列表第一项 */
    const currentModel = computed(() => models.value.find((m) => m.key === modelKey.value) || models.value[0] || null)
    /** 空状态下的快捷提问模板；text 是真正发给模型的中文指令 */
    const quickPrompts = computed(() => [
      { titleKey: 'ai.quick1', text: '给我当前材质加一点锈迹和苔藓' },
      { titleKey: 'ai.quick2', text: '把分辨率设为 512 并检查材质状态' },
      { titleKey: 'ai.quick3', text: '生成一套锈蚀金属质感的节点连接' },
      { titleKey: 'ai.quick4', text: '导出当前材质为 Unity 贴图包（512）' }
    ])

    /**
     * 从本地服务端加载模型清单、提供商列表与 AI 规则；
     * 若当前选中的模型已不存在，则自动切到服务端默认模型。
     * 失败时把错误写进 aiChat.error（由底部错误条显示）。
     * @returns {Promise<void>}
     */
    async function loadModels() {
      try {
        const data = await fetchModels()
        models.value = data.models || []
        providers.value = data.providers || []
        // 规则接口失败不致命，降级为空列表即可
        try {
          const rules = await fetchAiRules()
          aiRules.value = rules?.rules || []
        } catch (e) {
          aiRules.value = []
        }
        if (!modelKey.value || !models.value.some((m) => m.key === modelKey.value)) {
          setChatModel(data.defaultModel || models.value[0]?.key || '')
        }
      } catch (e) {
        aiChat.error = String(e.message || e)
      }
    }
    /**
     * 顶部模型下拉框切换：写入 aiChat 的当前模型。
     * @param {Event} event change 事件
     */
    function selectModel(event) {
      setChatModel(event.target.value)
    }
    /** 把当前会话导出为 Markdown 文件下载；文件名带 ISO 时间戳便于区分 */
    function downloadChat() {
      const blob = new Blob([exportChatMarkdown()], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'substrate-ai-chat-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.md'
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }
    /** 允许作为文本附件上传的扩展名 */
    const TEXT_FILE = /\.(txt|md|markdown|json|csv|log|ya?ml)$/i
    /** 点击回形针按钮时打开隐藏的文件选择框 */
    function openAttach() {
      attachInput.value?.click()
    }
    /**
     * 把本地图片上传到素材库接口，返回附件描述对象。
     * 先读成 dataURL 再以 JSON 提交，避免 multipart 表单。
     * @param {File} file 图片文件
     * @returns {Promise<{kind:'image',name:string,bytes:number,assetId:string,url:string}>}
     * @throws {Error} 读取或上传失败时抛出
     */
    async function uploadImage(file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
      const res = await fetch('/api/assets/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, dataUrl })
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error?.message || 'upload failed')
      return { kind: 'image', name: data.asset.name, bytes: data.asset.bytes || file.size, assetId: data.asset.id, url: data.asset.url }
    }
    /**
     * 批量添加附件：一次最多 6 个、总数不超过 6 个。
     * 图片走上传接口（限 32MB）；文本类文件直接内联读取（限 256KB，正文截断到 6 万字符）；
     * 其它类型报「不支持」。任一文件出错会中断并显示错误，已添加的保留。
     * @param {FileList|File[]} files 用户选择/拖入/粘贴的文件
     * @returns {Promise<void>}
     */
    async function addFiles(files) {
      attachError.value = ''
      uploading.value = true
      try {
        for (const file of [...files].slice(0, 6)) {
          if (pendingAttachments.value.length >= 6) break
          if (/^image\/(png|jpeg|webp)$/i.test(file.type)) {
            if (file.size > 32 * 1024 * 1024) throw new Error(t('ai.attachTooBig'))
            aiChat.draftAttachments.push(await uploadImage(file))
          } else if (TEXT_FILE.test(file.name) || /^text\//.test(file.type)) {
            if (file.size > 256 * 1024) throw new Error(t('ai.attachTooBig'))
            const text = await file.text()
            aiChat.draftAttachments.push({ kind: 'text', name: file.name, bytes: file.size, text: text.slice(0, 60000) })
          } else {
            throw new Error(t('ai.attachUnsupported'))
          }
        }
      } catch (e) {
        attachError.value = String(e.message || e)
      } finally {
        uploading.value = false
      }
    }
    /**
     * 文件选择框 change：取出文件后立即重置 input，保证再次选择同一文件也能触发。
     * @param {Event} event
     */
    function onAttachFile(event) {
      const files = [...(event.target?.files || [])]
      event.target.value = ''
      addFiles(files)
    }
    /** 拖拽释放到输入区：阻止浏览器默认的「打开文件」行为并转为附件 */
    function onDrop(event) {
      event.preventDefault()
      addFiles(event.dataTransfer?.files || [])
    }
    /** 在输入框粘贴文件（如截图）：仅当剪贴板里真的有文件时才拦截默认粘贴 */
    function onPaste(event) {
      const files = [...(event.clipboardData?.files || [])]
      if (files.length) {
        event.preventDefault()
        addFiles(files)
      }
    }
    /** 移除第 index 个待发送附件 */
    function removeAttachment(index) {
      aiChat.draftAttachments.splice(index, 1)
    }
    /** 新建会话并滚动到底部 */
    function startConversation() {
      newConversation()
      nextTick(() => scrollChat())
    }
    /** 切换到指定会话（下拉框值为会话 id） */
    function selectConversation(event) {
      switchConversation(event.target.value)
      nextTick(() => scrollChat())
    }
    /** 删除当前会话；模板保证至少保留 1 个会话 */
    function removeConversation() {
      deleteConversation(aiChat.activeConversationId)
      nextTick(() => scrollChat())
    }
    /** 把消息列表滚到底部（等待 DOM 更新后再取 scrollHeight） */
    async function scrollChat() {
      await nextTick()
      if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
    }
    /**
     * 发送消息：优先使用传入文本（快捷提问），否则取输入框内容。
     * 空内容且无附件、正在请求、正在上传、无模型或模型未配置密钥时都不发送，并给出提示。
     * @param {string} [text] 可选；不传则读取 input
     * @returns {Promise<void>}
     */
    async function send(text) {
      const content = String(text ?? input.value).trim()
      if ((!content && !pendingAttachments.value.length) || aiChat.busy || uploading.value) return
      if (!currentModel.value) {
        aiChat.error = t('ai.noModel')
        return
      }
      if (!currentModel.value.hasKey) {
        aiChat.error = t('ai.noKey')
        return
      }
      input.value = ''
      await sendChat(content)
    }
    /** 输入框快捷键：Ctrl/Cmd + Enter 发送，普通 Enter 保留换行 */
    function onKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        send()
      }
    }
    /**
     * 运行 MCP 自检：展示通过/失败计数与失败项详情；
     * 自检本身抛错时构造一个「失败 1 项」的结果，保证界面仍能给出反馈。
     * @returns {Promise<void>}
     */
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
    /**
     * 保存提供商表单：把逗号分隔的模型 id 转成 [{id,label}] 提交；
     * 成功后刷新模型/提供商列表、清空表单，并在当前模型失效时切默认模型。
     * @returns {Promise<void>}
     */
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
        if (!models.value.some((m) => m.key === modelKey.value)) setChatModel(data.defaultModel || models.value[0]?.key || '')
        testResult.value = '✓ 已保存（密钥只保存在本机服务端）'
      } catch (e) {
        testResult.value = '✕ ' + (e.message || String(e))
      }
    }
    /**
     * 删除一个提供商；若因此导致当前模型失效则退回第一个可用模型。
     * @param {{id:string,label:string}} p 提供商对象
     * @returns {Promise<void>}
     */
    async function removeProviderEntry(p) {
      if (!p) return
      try {
        const data = await deleteProvider(p.id)
        if (!data?.ok) throw new Error(data?.error?.message || 'delete failed')
        models.value = data.models || []
        providers.value = data.providers || []
        if (!models.value.some((m) => m.key === modelKey.value)) setChatModel(models.value[0]?.key || '')
        testResult.value = '✓ 已删除提供商 ' + p.label
      } catch (e) {
        testResult.value = '✕ ' + (e.message || String(e))
      }
    }
    /**
     * 对当前模型做一次真实调用测试，显示回复片段与耗时。
     * @returns {Promise<void>}
     */
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

    // 流式输出时最后一条消息的 content 持续增长、pending 才会结束，
    // 因此监听三者任意变化都滚到底部，保证用户始终看到最新内容。
    watch(
      () => [aiChat.messages.length, aiChat.messages[aiChat.messages.length - 1]?.content, aiChat.messages[aiChat.messages.length - 1]?.pending],
      () => scrollChat()
    )

    onMounted(async () => {
      await loadModels()
      await scrollChat()
    })

    // 对外暴露：大部分状态直接映射 aiChat 单例，清空/思考开关等以薄包装函数形式交给模板
    return {
      models,
      providers,
      modelKey,
      aiRules,
      currentModel,
      messages: computed(() => aiChat.messages),
      busy: computed(() => aiChat.busy),
      error: computed(() => aiChat.error),
      input,
      showSettings,
      selfcheck,
      checking,
      testing,
      testResult,
      chatEl,
      attachInput,
      attachError,
      uploading,
      pendingAttachments,
      conversations,
      activeConversationId,
      startConversation,
      selectConversation,
      removeConversation,
      openAttach,
      onAttachFile,
      onDrop,
      onPaste,
      removeAttachment,
      form,
      quickPrompts,
      selectModel,
      send,
      onKeydown,
      runCheck,
      saveProviderForm,
      removeProviderEntry,
      testCurrent,
      clearAll: clearChat,
      showThinking,
      toggleThinking: (e) => setShowThinking(e.target.checked),
      downloadChat,
      close: () => emit('close')
    }
  },
  template: `
    <div class="ai-panel">
      <!-- 标题栏：模型下拉、导出、清空、自检、设置、关闭 -->
      <div class="ai-head">
        <span class="ai-title">✦ {{ $t('ai.title') }}</span>
        <select class="top-select ai-model" :value="modelKey" @change="selectModel" :title="$t('ai.model')">
          <option v-for="m in models" :key="m.key" :value="m.key">{{ m.label }} · {{ m.provider }}</option>
        </select>
        <button class="icon-btn" :title="$t('ai.export')" @click="downloadChat">⤓</button>
        <button class="icon-btn" :title="$t('ai.clear')" @click="clearAll">⌫</button>
        <button class="icon-btn" :title="$t('ai.selfcheck')" @click="runCheck" :disabled="checking">{{ checking ? '…' : '◎' }}</button>
        <button class="icon-btn" :title="$t('ai.settings')" @click="showSettings = !showSettings">⚙</button>
        <button class="icon-btn" @click="close">✕</button>
      </div>

      <!-- 会话条：新建会话、切换会话、删除当前会话 -->
      <div class="ai-conv-bar">
        <button class="btn tiny ai-new-conv" :title="$t('ai.newConversation')" @click="startConversation">＋ {{ $t('ai.newConversation') }}</button>
        <select class="top-select ai-conv-select" :value="activeConversationId" @change="selectConversation" :title="$t('ai.conversations')">
          <option v-for="c in conversations" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select>
        <button class="icon-btn" :title="$t('ai.deleteConversation')" :disabled="conversations.length <= 1" @click="removeConversation">🗑</button>
      </div>

      <!-- 设置区（可折叠）：提供商列表、新增表单、连通性测试、推理展示开关与规则提示 -->
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
        <label class="ai-toggle"><input type="checkbox" :checked="showThinking" @change="toggleThinking" /> {{ $t('ai.showThinking') }}</label>
        <div class="hint small">{{ $t('ai.showThinkingHint') }}</div>
        <div class="hint small">{{ $t('ai.keyHint') }}</div>
        <div class="hint small">{{ $t('ai.rulesHint') }}</div>
        <div v-if="aiRules.length" class="ai-rules">
          <div v-for="(r, i) in aiRules" :key="i">• {{ r }}</div>
        </div>
      </div>

      <!-- 自检结果卡片：通过/失败合计 + 前 6 条失败项 -->
      <div v-if="selfcheck" class="ai-check" :class="selfcheck.ok ? 'ok' : 'bad'">
        <div>{{ selfcheck.ok ? $t('ai.selfcheckPass') : $t('ai.selfcheckFail') }} · {{ selfcheck.totals.passed }}/{{ selfcheck.totals.passed + selfcheck.totals.failed }}</div>
        <div v-for="c in selfcheck.checks.filter(c => !c.ok).slice(0, 6)" :key="c.name" class="dim small">✕ {{ c.name }} {{ c.info }}</div>
      </div>

      <!-- 消息列表：空状态快捷提问；用户气泡（含附件）；助手气泡（推理/正文/工具轨迹） -->
      <div class="ai-messages" ref="chatEl">
        <div v-if="!messages.length" class="ai-empty">
          <div class="ai-empty-title">✦ {{ $t('ai.emptyTitle') }}</div>
          <div class="hint">{{ $t('ai.emptyHint') }}</div>
          <div class="ai-quick">
            <button v-for="q in quickPrompts" :key="q.titleKey" class="btn tiny" @click="send(q.text)">{{ $t(q.titleKey) }}</button>
          </div>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="ai-msg" :class="m.role">
          <div v-if="m.role === 'user'" class="ai-bubble user">
            <div>{{ m.content }}</div>
            <div v-if="m.attachments && m.attachments.length" class="ai-msg-atts">
              <span v-for="(att, ai) in m.attachments" :key="ai" class="ai-msg-att">
                <img v-if="att.kind === 'image' && att.url" :src="att.url" :alt="att.name" />
                {{ att.kind === 'image' ? '🖼' : '📎' }} {{ att.name }}
              </span>
            </div>
          </div>
          <div v-else class="ai-bubble assistant">
            <details v-if="m.reasoning && m.reasoning.length" class="ai-reasoning">
              <summary>{{ $t('ai.reasoning') }} · {{ m.reasoning.length }}</summary>
              <div v-for="(r, ri) in m.reasoning" :key="ri" class="ai-reasoning-step">
                <div class="ai-reasoning-kind">{{ r.kind === 'plan' ? $t('ai.plan') : $t('ai.thought') }} · {{ r.step }}</div>
                <pre>{{ r.text }}</pre>
              </div>
            </details>
            <div v-if="m.pending" class="ai-thinking">{{ $t('ai.thinking') }}</div>
            <div v-else-if="m.content" class="ai-text">{{ m.content }}</div>
            <div v-if="m.interrupted" class="ai-error">{{ $t('ai.interrupted') }}</div>
            <div v-if="m.hitStepLimit" class="ai-step-limit">{{ $t('ai.stepLimit') }}</div>
            <div v-if="m.vision && m.vision.requested > 0 && (!m.vision.sent || m.vision.fallback)" class="ai-vision-warn">
              {{ $t('ai.visionFallbackNote') }}
            </div>
            <div v-if="m.error" class="ai-error">✕ {{ m.error }}</div>
            <div v-if="m.trace && m.trace.length" class="ai-trace">
              <div v-for="(tr, k) in m.trace" :key="k" class="ai-tool" :class="{ ok: tr.ok, bad: !tr.ok }">
                <span class="ai-tool-name">{{ tr.ok ? '✓' : '✕' }} {{ tr.name }}</span>
                <span v-if="tr.error" class="dim small">{{ tr.error }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="busy && !messages.length" class="ai-bubble assistant ai-thinking">{{ $t('ai.thinking') }}</div>
      </div>

      <div v-if="error" class="ai-error ai-error-bar">{{ error }}</div>
      <!-- 待发送附件缩略条：可逐个移除，上传中/出错时给出提示 -->
      <div v-if="pendingAttachments.length || attachError" class="ai-attachments">
        <div v-for="(att, i) in pendingAttachments" :key="i" class="ai-attachment-chip">
          <img v-if="att.kind === 'image'" :src="att.url" :alt="att.name" />
          <span>{{ att.kind === 'image' ? '🖼' : '📎' }} {{ att.name }}</span>
          <button class="icon-btn" :title="$t('ai.removeAttachment')" @click="removeAttachment(i)">✕</button>
        </div>
        <div v-if="uploading" class="hint small">{{ $t('ai.attachUploading') }}</div>
        <div v-if="attachError" class="ai-error">{{ attachError }}</div>
      </div>
      <!-- 输入区：附件按钮 + 隐藏文件选择框 + 文本框（Ctrl/Cmd+Enter 发送）+ 发送按钮 -->
      <div class="ai-input-row" @dragover.prevent @drop.prevent="onDrop">
        <button class="icon-btn ai-attach-btn" :title="$t('ai.attach')" @click="openAttach">📎</button>
        <input ref="attachInput" type="file" multiple accept="image/png,image/jpeg,image/webp,.txt,.md,.markdown,.json,.csv,.log,.yaml,.yml" style="display: none" @change="onAttachFile" />
        <textarea v-model="input" :placeholder="$t('ai.placeholder')" rows="2" @keydown="onKeydown" @paste="onPaste" :disabled="busy"></textarea>
        <button class="btn primary" :disabled="busy || uploading || (!input.trim() && !pendingAttachments.length)" @click="send()">{{ $t('ai.send') }}</button>
      </div>
      <div class="hint small ai-foot">{{ $t('ai.attachHint') }}</div>
      <div class="hint small ai-foot">{{ $t('ai.hint') }}</div>
      <div class="hint small ai-foot">{{ $t('ai.reasoningHint') }}</div>
    </div>
  `
})
