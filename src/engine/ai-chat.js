// Shared AI conversation state.
//
// Lives outside the AiPanel component so closing the dialog does not interrupt an in-flight
// model request, and the floating mini window can render the same live transcript.
//
// Conversations are isolated: every chat keeps its own message array and only the active
// conversation is sent to the model, so starting a new chat never leaks prior context.
import { reactive } from 'vue'
import { chatWithAssistant } from './llm-client.js'
import { t } from '../i18n/index.js'

const STORAGE_KEY = 'substrate.aiChat.v1'
const MODEL_KEY = 'substrate.llmModel'
const THINKING_KEY = 'substrate.showThinking'
const MAX_MESSAGES = 300
const MAX_CONVERSATIONS = 20
const VERSION = 2

function uid() {
  return 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

function defaultTitle() {
  return t('ai.newChat')
}

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

function deriveTitle(text, attachments) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  // The attachment-only fallback prompt is not a useful title.
  if (clean && clean !== '请查看附件。' && clean !== 'Please see the attachment.') return clean.slice(0, 40)
  const image = (attachments || []).find((a) => a && a.kind === 'image')
  if (image?.name) return String(image.name).slice(0, 40)
  const file = (attachments || []).find((a) => a && a.name)
  if (file?.name) return String(file.name).slice(0, 40)
  return defaultTitle()
}

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

    // v2: explicit conversation list
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

    // v1 migration: one transcript
    if (Array.isArray(raw.messages)) {
      const messages = raw.messages.map(normalizeStoredMessage).filter(Boolean).slice(-MAX_MESSAGES)
      const firstUser = messages.find((m) => m.role === 'user')
      const conv = makeConversation(deriveTitle(firstUser?.content, firstUser?.attachments), messages)
      return { conversations: [conv], activeId: conv.id, modelKey: raw.modelKey || fallbackModel }
    }
  } catch (e) {
    /* corrupt storage — start fresh */
  }
  const conv = makeConversation()
  return { conversations: [conv], activeId: conv.id, modelKey: fallbackModel }
}

const saved = typeof localStorage !== 'undefined' ? readSaved() : { conversations: [makeConversation()], activeId: '', modelKey: '' }
const initialConversation = saved.conversations.find((c) => c.id === saved.activeId) || saved.conversations[0]

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

function messageContentForModel(m) {
  const base = String(m.content || '')
  if (!Array.isArray(m.attachments) || !m.attachments.length) return base
  return base + (base ? '\n\n' : '') + m.attachments.map(formatAttachmentForModel).join('\n\n')
}

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

let saveTimer = null
let hideTimer = null

export function activeConversation() {
  return (
    aiChat.conversations.find((c) => c.id === aiChat.activeConversationId) ||
    aiChat.conversations[0] ||
    null
  )
}

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
    // Quota: drop the oldest non-active conversation first, then trim the active transcript.
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
      /* give up quietly */
    }
    return false
  }
}

export function persistChatNow() {
  try {
    writeStorage()
  } catch (e) {
    /* storage may be unavailable */
  }
}

export function persistChat() {
  persistChatNow()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeStorage()
  }, 250)
}

export function setShowThinking(value) {
  aiChat.showThinking = !!value
  try {
    localStorage.setItem(THINKING_KEY, aiChat.showThinking ? '1' : '0')
  } catch (e) {
    /* ignore */
  }
}

export function setChatModel(key) {
  aiChat.modelKey = key || ''
  try {
    localStorage.setItem(MODEL_KEY, aiChat.modelKey)
  } catch (e) {
    /* ignore */
  }
  persistChat()
}

function clearDraft() {
  if (Array.isArray(aiChat.draftAttachments)) aiChat.draftAttachments.splice(0, aiChat.draftAttachments.length)
}

function activate(conversation) {
  aiChat.activeConversationId = conversation.id
  aiChat.messages = conversation.messages
  clearDraft()
  aiChat.error = ''
  aiChat.floatingVisible = false
}

/** Start a clean conversation. If the current one is already an empty draft, reuse it. */
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

/** Switch to another conversation; its transcript becomes the only context for the AI. */
export function switchConversation(id) {
  const conv = aiChat.conversations.find((c) => c.id === id)
  if (!conv) return false
  if (conv.id === aiChat.activeConversationId) return true
  activate(conv)
  persistChat()
  return true
}

/** Remove one conversation; the active transcript falls back to the next newest. */
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

function showFloating() {
  if (hideTimer) clearTimeout(hideTimer)
  aiChat.floatingVisible = true
}
function scheduleFloatingHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!aiChat.busy) aiChat.floatingVisible = false
  }, 6000)
}

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
  // Auto-title on the first user turn so the conversation list is readable.
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
    // Keep the most recent image-bearing user turn in the request even when the user has sent
    // follow-up text in the meantime. Otherwise the model loses the pixels on the next question.
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
      // the server reads image files from the material library and builds multimodal content
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

export function hideFloating() {
  aiChat.floatingVisible = false
}

export function showFloatingPanel() {
  aiChat.floatingVisible = true
}

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

export function markInterruptedFromStorage() {
  // messages loaded from a previous session cannot still be streaming
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
markInterruptedFromStorage()
