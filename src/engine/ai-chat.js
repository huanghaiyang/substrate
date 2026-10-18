// Shared AI conversation state.
//
// Lives outside the AiPanel component so closing the dialog does not interrupt an in-flight
// model request, and the floating mini window can render the same live transcript.
import { reactive } from 'vue'
import { chatWithAssistant } from './llm-client.js'
import { t } from '../i18n/index.js'

const STORAGE_KEY = 'substrate.aiChat.v1'
const MODEL_KEY = 'substrate.llmModel'
const THINKING_KEY = 'substrate.showThinking'
const MAX_MESSAGES = 300

function readSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (!raw || !Array.isArray(raw.messages)) return { messages: [], modelKey: localStorage.getItem(MODEL_KEY) || '' }
    const messages = raw.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-MAX_MESSAGES)
      .map((m) => ({
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
      }))
    return { messages, modelKey: raw.modelKey || localStorage.getItem(MODEL_KEY) || '' }
  } catch (e) {
    return { messages: [], modelKey: localStorage.getItem(MODEL_KEY) || '' }
  }
}

const saved = typeof localStorage !== 'undefined' ? readSaved() : { messages: [], modelKey: '' }

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
  messages: saved.messages,
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

export function persistChatNow() {
  try {
    const messages = aiChat.messages.slice(-MAX_MESSAGES).map((m) => ({
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
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, modelKey: aiChat.modelKey, messages, updatedAt: Date.now() }))
  } catch (e) {
    /* storage may be unavailable */
  }
}

export function persistChat() {
  persistChatNow()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const messages = aiChat.messages.slice(-MAX_MESSAGES).map((m) => ({
        role: m.role,
        content: m.content,
        trace: m.trace,
        reasoning: m.reasoning,
        attachments: m.attachments,
        vision: m.vision,
        error: m.error,
        model: m.model,
        at: m.at,
        pending: undefined,
        interrupted: m.interrupted || undefined,
        hitStepLimit: m.hitStepLimit || undefined
      }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, modelKey: aiChat.modelKey, messages, updatedAt: Date.now() }))
    } catch (e) {
      // storage full: drop the oldest half and retry once
      try {
        aiChat.messages.splice(0, Math.floor(aiChat.messages.length / 2))
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 1, modelKey: aiChat.modelKey, messages: aiChat.messages, updatedAt: Date.now() })
        )
      } catch (err) {
        /* give up quietly */
      }
    }
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
  const attachments = (aiChat.draftAttachments || []).slice(0, 6).map((a) => ({ ...a }))
  const content = String(text || '').trim() || (attachments.length ? '请查看附件。' : '')
  if ((!content && !attachments.length) || aiChat.busy) return false
  aiChat.error = ''
  aiChat.draftAttachments.splice(0, aiChat.draftAttachments.length)
  aiChat.messages.push({ role: 'user', content, attachments: attachments.length ? attachments : undefined, at: Date.now() })
  const pending = { role: 'assistant', content: '', pending: true, trace: [], at: Date.now() }
  aiChat.messages.push(pending)
  aiChat.busy = true
  aiChat.lastActivity = Date.now()
  showFloating()
  persistChat()
  try {
    const recent = aiChat.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending && (m.content || m.attachments?.length)).slice(-12)
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
    const idx = aiChat.messages.indexOf(pending)
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
    if (idx >= 0) aiChat.messages.splice(idx, 1, final)
    else aiChat.messages.push(final)
    if (!result?.ok) aiChat.error = final.error
  } catch (e) {
    const idx = aiChat.messages.indexOf(pending)
    const final = { role: 'assistant', content: '', error: String(e.message || e), pending: false, at: Date.now() }
    if (idx >= 0) aiChat.messages.splice(idx, 1, final)
    else aiChat.messages.push(final)
    aiChat.error = final.error
  } finally {
    aiChat.busy = false
    aiChat.lastActivity = Date.now()
    persistChatNow()
    scheduleFloatingHide()
  }
  return true
}

export function clearChat() {
  aiChat.messages.splice(0, aiChat.messages.length)
  if (Array.isArray(aiChat.draftAttachments)) aiChat.draftAttachments.splice(0, aiChat.draftAttachments.length)
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
  const lines = ['# Substrate AI conversation', '', 'Exported: ' + new Date().toISOString(), 'Model: ' + aiChat.modelKey, '']
  for (const m of aiChat.messages) {
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
  for (const m of aiChat.messages) {
    if (m.pending) {
      m.pending = false
      m.interrupted = true
      m.content = m.content || t('ai.interrupted')
    }
  }
}
markInterruptedFromStorage()
