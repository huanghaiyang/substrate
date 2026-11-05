/**
 * AI 对话共享状态（会话持久化 + 发送编排）。
 *
 * 架构位置：本模块位于 UI 组件（AiPanel 及浮动小窗）之外的单例层，被二者共同引用。
 * 关闭对话框因此不会中断进行中的模型请求，浮动小窗也能渲染同一份实时对话记录。
 *
 * 会话隔离：每个会话维护自己的 messages 数组，只有“当前活动会话”会作为上下文发送给模型，
 * 新建会话因此不会把旧上下文泄漏给模型。
 *
 * 主要导出：aiChat（响应式状态）、sendChat（发送编排）、newConversation /
 * switchConversation / deleteConversation（会话管理）、clearChat、exportChatMarkdown、
 * formatAttachmentForModel、persistChat / persistChatNow。
 */
import { reactive } from 'vue'
import { chatWithAssistant } from './llm-client.js'
import { t } from '../i18n/index.js'

// localStorage 键：会话正文（含版本号 v1）、当前模型键、是否显示思考过程
const STORAGE_KEY = 'substrate.aiChat.v1'
const MODEL_KEY = 'substrate.llmModel'
const THINKING_KEY = 'substrate.showThinking'
// 单会话最多保留的消息条数、最多保留的会话数，用于遏制 localStorage 体积增长
const MAX_MESSAGES = 300
const MAX_CONVERSATIONS = 20
// 持久化结构版本：v1 是“单份记录”，v2 起改为显式会话列表
const VERSION = 2

/** 生成会话 id：时间戳（36 进制）+ 随机后缀，避免同一毫秒内多次新建产生重复 id。 */
function uid() {
  return 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

/** 新会话的默认标题，跟随当前界面语言。 */
function defaultTitle() {
  return t('ai.newChat')
}

/**
 * 把 localStorage 里读出的原始消息规整为运行时消息对象。
 *
 * - role 非法的条目返回 null，由调用方 filter(Boolean) 丢弃；
 * - trace / reasoning 截断到 24 条，attachments 仅接受数组，防止脏数据或异常体积撑爆内存；
 * - 关键：落盘时仍处于 pending 的消息在重新加载后不可能继续流式输出，统一转为 interrupted，
 *   避免界面永久显示“生成中”。
 *
 * @param {any} m 存储中的单条消息
 * @returns {object|null} 规整后的消息；无法识别时返回 null
 */
function normalizeStoredMessage(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null
  return {
    role: m.role,
    content: String(m.content || ''),
    trace: Array.isArray(m.trace) ? m.trace.slice(0, 24) : undefined,
    reasoning: Array.isArray(m.reasoning) ? m.reasoning.slice(0, 24) : undefined,
    vision: m.vision && typeof m.vision === 'object' ? m.vision : undefined,
    attachments: Array.isArray(m.attachments) ? m.attachments : undefined,
    error: m.error ? String(m.error) : undefined,
    pending: false,
    interrupted: !!m.pending || !!m.interrupted,
    hitStepLimit: !!m.hitStepLimit,
    model: m.model || undefined,
    at: m.at || Date.now()
  }
}

/** 构造新会话对象；消息只保留最后 MAX_MESSAGES 条，创建/更新时间统一为当前时刻。 */
function makeConversation(title, messages = []) {
  const now = Date.now()
  return {
    id: uid(),
    title: String(title || defaultTitle()),
    messages: messages.slice(-MAX_MESSAGES),
    createdAt: now,
    updatedAt: now
  }
}

/**
 * 由首条用户消息推导会话标题。
 *
 * 优先级：用户文本（压缩空白后取前 40 字）> 首个图片附件的名称 > 任意附件名 > 默认标题。
 *
 * @param {string} text 用户输入
 * @param {Array<object>} attachments 附件列表
 * @returns {string} 会话标题
 */
function deriveTitle(text, attachments) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  // 纯附件发送会使用固定兜底提示语，这类文本不适合当标题，需跳过并改用附件名。
  if (clean && clean !== '请查看附件。' && clean !== 'Please see the attachment.') return clean.slice(0, 40)
  const image = (attachments || []).find((a) => a && a.kind === 'image')
  if (image?.name) return String(image.name).slice(0, 40)
  const file = (attachments || []).find((a) => a && a.name)
  if (file?.name) return String(file.name).slice(0, 40)
  return defaultTitle()
}

/**
 * 从 localStorage 恢复会话数据，并兼容旧版本结构。
 *
 * 迁移策略：
 * - 无数据 / 解析失败：直接新建一个空会话；
 * - v2（raw.conversations 为数组）：逐会话规整消息、裁剪条数，并校正 activeId 指向；
 * - v1（raw.messages 为单份记录）：用第一条用户消息推导标题，包装成一个会话；
 * - 模型选择优先取存档内的 modelKey，否则回退到独立的 MODEL_KEY。
 *
 * @returns {{conversations: object[], activeId: string, modelKey: string}} 恢复后的初始状态
 */
function readSaved() {
  const fallbackModel = (() => {
    try {
      return localStorage.getItem(MODEL_KEY) || ''
    } catch (e) {
      return ''
    }
  })()
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!raw) {
      const conv = makeConversation()
      return { conversations: [conv], activeId: conv.id, modelKey: fallbackModel }
    }

    // v2：显式的会话列表结构
    if (Array.isArray(raw.conversations)) {
      const conversations = raw.conversations
        .slice(0, MAX_CONVERSATIONS)
        .map((c) => {
          const messages = (Array.isArray(c.messages) ? c.messages : []).map(normalizeStoredMessage).filter(Boolean).slice(-MAX_MESSAGES)
          return {
            id: String(c.id || uid()),
            title: String(c.title || defaultTitle()),
            messages,
            createdAt: Number(c.createdAt) || Date.now(),
            updatedAt: Number(c.updatedAt) || Number(c.createdAt) || Date.now()
          }
        })
      if (!conversations.length) conversations.push(makeConversation())
      const activeId = conversations.some((c) => c.id === raw.activeId) ? raw.activeId : conversations[0].id
      return { conversations, activeId, modelKey: raw.modelKey || fallbackModel }
    }

    // v1 兼容迁移：整份记录只有一条对话
    if (Array.isArray(raw.messages)) {
      const messages = raw.messages.map(normalizeStoredMessage).filter(Boolean).slice(-MAX_MESSAGES)
      const firstUser = messages.find((m) => m.role === 'user')
      const conv = makeConversation(deriveTitle(firstUser?.content, firstUser?.attachments), messages)
      return { conversations: [conv], activeId: conv.id, modelKey: raw.modelKey || fallbackModel }
    }
  } catch (e) {
    /* 存档损坏：直接从头开始 */
  }
  const conv = makeConversation()
  return { conversations: [conv], activeId: conv.id, modelKey: fallbackModel }
}

// 模块加载时立即读取存档，得到初始会话；无 localStorage 的环境（如 SSR/测试）退化为内存态
const saved = typeof localStorage !== 'undefined' ? readSaved() : { conversations: [makeConversation()], activeId: '', modelKey: '' }
const initialConversation = saved.conversations.find((c) => c.id === saved.activeId) || saved.conversations[0]

/**
 * 把单个附件转成给模型看的纯文本描述。
 *
 * 图片不内联像素，只描述它在素材库中的位置（assetId / url），引导模型改用
 * substrate_list_assets / substrate_apply_asset 工具取用；文本附件截断到 6000 字符后内联。
 *
 * @param {{kind?:string, name?:string, assetId?:string, url?:string, text?:string, bytes?:number}} att
 * @returns {string} 拼接好的文本；att 为空时返回空串
 */
export function formatAttachmentForModel(att) {
  if (!att) return ''
  if (att.kind === 'image') {
    return (
      '[Image attachment "' +
      att.name +
      '" is stored in the material library' +
      (att.assetId ? ' (assetId: ' + att.assetId + ')' : '') +
      (att.url ? ', url: ' + att.url : '') +
      '. Use substrate_list_assets / substrate_apply_asset to use it.]'
    )
  }
  const text = String(att.text || '').slice(0, 6000)
  return '[Text attachment "' + att.name + '" (' + (att.bytes || 0) + ' bytes)]\n' + text
}

/** 把消息正文与全部附件描述拼成最终请求文本；无附件时原样返回正文。 */
function messageContentForModel(m) {
  const base = String(m.content || '')
  if (!Array.isArray(m.attachments) || !m.attachments.length) return base
  return base + (base ? '\n\n' : '') + m.attachments.map(formatAttachmentForModel).join('\n\n')
}

/**
 * 全局响应式聊天状态。字段含义：
 * - conversations / activeConversationId：全部会话与当前活动会话 id；
 * - messages：当前会话消息数组的引用（切换会话时整体替换而非清空重建）；
 * - draftAttachments：输入框里尚未发送的附件草稿；
 * - modelKey：当前选中的模型键；
 * - busy：是否有请求在途（禁用发送、控制浮动窗隐藏）；
 * - error：当前会话最近一次失败原因；
 * - lastActivity：最近活动时间戳；
 * - floatingVisible / unread：浮动小窗是否显示、未读计数；
 * - showThinking：是否展示思考过程（默认开启，存储值为 '0' 时关闭）；
 * - loadedAt：状态初始化时间，供调试/排序使用。
 */
export const aiChat = reactive({
  conversations: saved.conversations,
  activeConversationId: initialConversation.id,
  messages: initialConversation.messages,
  draftAttachments: [],
  modelKey: saved.modelKey,
  busy: false,
  error: '',
  lastActivity: 0,
  floatingVisible: false,
  unread: 0,
  showThinking: (() => {
    try {
      return localStorage.getItem(THINKING_KEY) !== '0'
    } catch (e) {
      return true
    }
  })(),
  loadedAt: Date.now()
})

// 防抖落盘定时器 / 浮动小窗自动隐藏定时器
let saveTimer = null
let hideTimer = null

/** 取当前活动会话；id 失效时退化为列表首个会话，列表为空则返回 null。 */
export function activeConversation() {
  return (
    aiChat.conversations.find((c) => c.id === aiChat.activeConversationId) ||
    aiChat.conversations[0] ||
    null
  )
}

/** 挑选需要落盘的字段；pending 是瞬态不保存，只记录 interrupted / hitStepLimit 等终态标记。 */
function serializeMessage(m) {
  return {
    role: m.role,
    content: m.content,
    trace: m.trace,
    reasoning: m.reasoning,
    attachments: m.attachments,
    vision: m.vision,
    error: m.error,
    model: m.model,
    at: m.at,
    interrupted: m.interrupted || undefined,
    hitStepLimit: m.hitStepLimit || undefined
  }
}

/**
 * 把当前状态整体写入 localStorage（结构见文件头的 VERSION 说明）。
 *
 * 配额不足时的降级顺序：先删除最旧的“非当前”会话，再对当前会话从中间砍掉一半更早的消息，
 * 递归重试直到写入成功或已无可删；仍失败则返回 false，由调用方静默忽略。
 *
 * @returns {boolean} 是否成功写入
 */
function writeStorage() {
  const conversations = aiChat.conversations.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messages: c.messages.slice(-MAX_MESSAGES).map(serializeMessage)
  }))
  const payload = JSON.stringify({
    version: VERSION,
    activeId: aiChat.activeConversationId,
    conversations,
    modelKey: aiChat.modelKey,
    updatedAt: Date.now()
  })
  try {
    localStorage.setItem(STORAGE_KEY, payload)
    return true
  } catch (e) {
    // 配额不足：优先淘汰最旧的“非当前”会话，其次削减当前会话的历史消息。
    try {
      if (aiChat.conversations.length > 1) {
        const active = activeConversation()
        const victim = [...aiChat.conversations].reverse().find((c) => c.id !== active?.id)
        if (victim) aiChat.conversations.splice(aiChat.conversations.indexOf(victim), 1)
        return writeStorage()
      }
      const active = activeConversation()
      if (active && active.messages.length > 2) {
        active.messages.splice(0, Math.floor(active.messages.length / 2))
        return writeStorage()
      }
    } catch (err) {
      /* 放弃，静默失败 */
    }
    return false
  }
}

/** 立即同步落盘；用于请求结束等必须保住数据的时机，存储不可用时静默忽略。 */
export function persistChatNow() {
  try {
    writeStorage()
  } catch (e) {
    /* 存储可能不可用（隐私模式 / 配额 / 非浏览器环境） */
  }
}

/** 先立即落盘一次，再安排 250ms 防抖写入，避免高频更新时反复整份序列化。 */
export function persistChat() {
  persistChatNow()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeStorage()
  }, 250)
}

/** 设置是否展示思考过程，并写回 localStorage（默认开启，显式关闭时存为 '0'）。 */
export function setShowThinking(value) {
  aiChat.showThinking = !!value
  try {
    localStorage.setItem(THINKING_KEY, aiChat.showThinking ? '1' : '0')
  } catch (e) {
    /* 忽略：存储不可用 */
  }
}

/** 切换当前模型：写入独立存储键并触发一次会话持久化（模型键随会话数据一起保存）。 */
export function setChatModel(key) {
  aiChat.modelKey = key || ''
  try {
    localStorage.setItem(MODEL_KEY, aiChat.modelKey)
  } catch (e) {
    /* 忽略：存储不可用 */
  }
  persistChat()
}

/** 清空输入框附件草稿（原地 splice，保持响应式数组引用不变）。 */
function clearDraft() {
  if (Array.isArray(aiChat.draftAttachments)) aiChat.draftAttachments.splice(0, aiChat.draftAttachments.length)
}

/** 激活某个会话：同步 messages 引用、清空草稿与错误、收起浮动小窗（持久化由调用方负责）。 */
function activate(conversation) {
  aiChat.activeConversationId = conversation.id
  aiChat.messages = conversation.messages
  clearDraft()
  aiChat.error = ''
  aiChat.floatingVisible = false
}

/**
 * 新建一个干净会话；若当前会话本身就是空草稿则直接复用，避免产生大量空会话。
 *
 * 新会话插入列表头部；超出 MAX_CONVERSATIONS 时从尾部淘汰，若被淘汰的恰好是活动会话则
 * 改为指向新会话，保证 activeConversationId 始终有效。
 *
 * @returns {string} 新（或复用）会话的 id
 */
export function newConversation() {
  const active = activeConversation()
  if (active && active.messages.length === 0) {
    activate(active)
    persistChat()
    return active.id
  }
  const conv = makeConversation()
  aiChat.conversations.unshift(conv)
  while (aiChat.conversations.length > MAX_CONVERSATIONS) {
    const victim = aiChat.conversations[aiChat.conversations.length - 1]
    aiChat.conversations.pop()
    if (victim.id === aiChat.activeConversationId) aiChat.activeConversationId = conv.id
  }
  activate(conv)
  persistChat()
  return conv.id
}

/**
 * 切换到指定会话；切换后该会话的记录成为模型的唯一上下文。
 *
 * @param {string} id 目标会话 id
 * @returns {boolean} 是否切换成功（id 不存在时返回 false，已在该会话则直接返回 true）
 */
export function switchConversation(id) {
  const conv = aiChat.conversations.find((c) => c.id === id)
  if (!conv) return false
  if (conv.id === aiChat.activeConversationId) return true
  activate(conv)
  persistChat()
  return true
}

/**
 * 删除一个会话；若删的是活动会话，则自动落到“原位置或其后的最新会话”。
 * 仅剩最后一个会话时不清空列表，改为原地清空该会话内容。
 *
 * @param {string} id 要删除的会话 id
 * @returns {boolean} 是否执行了删除
 */
export function deleteConversation(id) {
  const index = aiChat.conversations.findIndex((c) => c.id === id)
  if (index < 0) return false
  if (aiChat.conversations.length <= 1) {
    clearChat()
    return true
  }
  const wasActive = aiChat.conversations[index].id === aiChat.activeConversationId
  aiChat.conversations.splice(index, 1)
  if (wasActive) activate(aiChat.conversations[Math.min(index, aiChat.conversations.length - 1)])
  persistChat()
  return true
}

/** 显示浮动小窗，并取消尚未触发的自动隐藏。 */
function showFloating() {
  if (hideTimer) clearTimeout(hideTimer)
  aiChat.floatingVisible = true
}
/** 安排 6 秒后自动隐藏浮动小窗；若此时仍有请求在途（busy）则保持可见。 */
function scheduleFloatingHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!aiChat.busy) aiChat.floatingVisible = false
  }, 6000)
}

/**
 * 发送用户输入并维护整段对话状态。
 *
 * 流程：取当前会话 → 快照草稿附件（最多 6 个）→ 插入 user 消息（首轮自动生成标题）
 * → 插入 pending 占位消息 → 组装最近 12 条有效上下文并调用 chatWithAssistant
 * → 用最终结果替换占位消息（异常时替换为错误消息）→ finally 收尾（清 busy、落盘、安排浮动窗隐藏）。
 *
 * 上下文裁剪的两个要点：
 * - 只取最近 12 条“有内容”的用户/助手消息，避免长对话把 token 撑爆；
 * - 额外保留最近一条带图片的用户消息（lastImageUser），否则用户追问后模型会丢失图片。
 *
 * 副作用：修改当前会话的消息数组、标题、updatedAt，写 localStorage，操作浮动窗计时器。
 *
 * @param {string} text 用户输入；可为空，此时依赖附件内容
 * @returns {Promise<boolean>} 未发送（空输入 / 正在忙 / 无会话）时返回 false
 */
export async function sendChat(text) {
  const conv = activeConversation()
  if (!conv) return false
  const messages = conv.messages
  const attachments = (aiChat.draftAttachments || []).slice(0, 6).map((a) => ({ ...a }))
  const content = String(text || '').trim() || (attachments.length ? '请查看附件。' : '')
  if ((!content && !attachments.length) || aiChat.busy) return false
  aiChat.error = ''
  clearDraft()
  messages.push({ role: 'user', content, attachments: attachments.length ? attachments : undefined, at: Date.now() })
  // 首轮用户消息写入时自动生成标题，让会话列表可读；仅在标题仍是默认文案时才覆盖。
  if (!conv.title || conv.title === defaultTitle() || conv.messages.filter((m) => m.role === 'user').length === 1) {
    conv.title = deriveTitle(content, attachments)
  }
  const pending = { role: 'assistant', content: '', pending: true, trace: [], at: Date.now() }
  messages.push(pending)
  conv.updatedAt = Date.now()
  aiChat.busy = true
  aiChat.lastActivity = Date.now()
  showFloating()
  persistChat()
  try {
    const recent = messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending && (m.content || m.attachments?.length))
      .slice(-12)
    const lastUser = recent.map((m) => m.role).lastIndexOf('user')
    // 即使用户随后只发了追问文字，也要把最近一条带图片的用户消息保留在请求里，
    // 否则模型在下一轮就“看不到”此前上传的图片了。
    let lastImageUser = -1
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].role === 'user' && Array.isArray(recent[i].attachments) && recent[i].attachments.some((a) => a && a.kind === 'image')) {
        lastImageUser = i
        break
      }
    }
    const history = recent.map((m, i) => ({
      role: m.role,
      content: m.content,
      // 仅“最后一条用户消息”和“最后一条带图用户消息”携带附件：
      // 服务端会据此从素材库读取图片并拼装多模态内容，其余历史消息只发文本以省带宽。
      attachments:
        m.role === 'user' && (i === lastUser || i === lastImageUser) && Array.isArray(m.attachments) && m.attachments.length
          ? m.attachments
          : undefined
    }))
    const result = await chatWithAssistant({ modelKey: aiChat.modelKey, messages: history, maxSteps: 20, showThinking: aiChat.showThinking })
    const idx = messages.indexOf(pending)
    const final = {
      role: 'assistant',
      content: result?.ok ? result.reply || '' : '',
      error: result?.ok ? undefined : result?.error?.message || '请求失败',
      trace: result?.toolCalls || [],
      reasoning: Array.isArray(result?.reasoning) ? result.reasoning : [],
      model: result?.model || undefined,
      hitStepLimit: !!result?.hitStepLimit,
      vision: result?.vision,
      pending: false,
      at: Date.now()
    }
    if (idx >= 0) messages.splice(idx, 1, final)
    else messages.push(final)
    conv.updatedAt = Date.now()
    if (aiChat.activeConversationId === conv.id && !result?.ok) aiChat.error = final.error
  } catch (e) {
    const idx = messages.indexOf(pending)
    const final = { role: 'assistant', content: '', error: String(e.message || e), pending: false, at: Date.now() }
    if (idx >= 0) messages.splice(idx, 1, final)
    else messages.push(final)
    conv.updatedAt = Date.now()
    if (aiChat.activeConversationId === conv.id) aiChat.error = final.error
  } finally {
    aiChat.busy = false
    aiChat.lastActivity = Date.now()
    persistChatNow()
    scheduleFloatingHide()
  }
  return true
}

/** 清空当前会话的全部消息并把标题恢复为默认，同时清空草稿与错误状态。 */
export function clearChat() {
  const conv = activeConversation()
  if (!conv) return
  conv.messages.splice(0, conv.messages.length)
  conv.title = defaultTitle()
  conv.updatedAt = Date.now()
  clearDraft()
  aiChat.error = ''
  aiChat.floatingVisible = false
  persistChat()
}

/** 收起浮动小窗（不会中断进行中的请求）。 */
export function hideFloating() {
  aiChat.floatingVisible = false
}

/** 手动展开浮动小窗（例如用户点击顶部提示条时）。 */
export function showFloatingPanel() {
  aiChat.floatingVisible = true
}

/**
 * 把当前会话导出为 Markdown 文本（只返回字符串，下载/保存由调用方决定）。
 *
 * 内容包含会话标题、导出时间、模型，以及每条消息的时间、正文、错误、
 * 附件清单（文本附件最多内联 4000 字符）、思考过程与工具调用结果。
 *
 * @returns {string} Markdown 文本
 */
export function exportChatMarkdown() {
  const conv = activeConversation()
  const lines = [
    '# Substrate AI conversation',
    '',
    'Title: ' + (conv?.title || ''),
    'Exported: ' + new Date().toISOString(),
    'Model: ' + aiChat.modelKey,
    ''
  ]
  for (const m of conv?.messages || []) {
    lines.push('## ' + (m.role === 'user' ? 'User' : 'Assistant') + ' · ' + new Date(m.at || Date.now()).toISOString())
    if (m.content) lines.push('', m.content)
    if (m.error) lines.push('', '> Error: ' + m.error)
    if (m.attachments && m.attachments.length) {
      lines.push('', '**Attachments**')
      for (const att of m.attachments) {
        lines.push('- ' + (att.kind === 'image' ? 'image' : 'file') + ': ' + att.name + (att.url ? ' — ' + att.url : ''))
        if (att.kind === 'text' && att.text) lines.push('', '  ' + String(att.text).slice(0, 4000).replace(/\n/g, '\n  '))
      }
    }
    if (m.reasoning && m.reasoning.length) {
      lines.push('', '**Thinking / plan**')
      for (const r of m.reasoning) lines.push('- [' + (r.kind || 'thought') + ' · step ' + (r.step || '?') + '] ' + r.text)
    }
    if (m.hitStepLimit) lines.push('', '> Tool-step limit reached; this is a progress summary.')
    if (m.trace && m.trace.length) {
      lines.push('', '**Tool calls**')
      for (const tr of m.trace) lines.push('- ' + (tr.ok ? '✓' : '✕') + ' ' + tr.name)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 把从上一会话恢复出来的 pending 消息标记为“已中断”。
 *
 * 内存中的 pending 只可能来自流式响应，而重新加载页面后流早已不存在；
 * 若不清理，界面会一直停留在加载态，用户也误以为请求仍在进行。
 */
export function markInterruptedFromStorage() {
  // 从上一会话载入的消息不可能仍在流式输出
  for (const conv of aiChat.conversations) {
    for (const m of conv.messages) {
      if (m.pending) {
        m.pending = false
        m.interrupted = true
        m.content = m.content || t('ai.interrupted')
      }
    }
  }
}
// 模块加载末尾立即执行一次，确保恢复出来的界面不残留“生成中”状态。
markInterruptedFromStorage()
