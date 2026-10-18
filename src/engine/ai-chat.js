// Shared AI conversation state.
//
// Lives outside the AiPanel component so closing the dialog does not interrupt an in-flight
// model request, and the floating mini window can render the same live transcript.
import { reactive } from 'vue'
import { chatWithAssistant } from './llm-client.js'
import { t } from '../i18n/index.js'

const STORAGE_KEY = 'substrate.aiChat.v1'
const MODEL_KEY = 'substrate.llmModel'
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

export const aiChat = reactive({
  messages: saved.messages,
  modelKey: saved.modelKey,
  busy: false,
  error: '',
  lastActivity: 0,
  floatingVisible: false,
  unread: 0,
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
  const content = String(text || '').trim()
  if (!content || aiChat.busy) return false
  aiChat.error = ''
  aiChat.messages.push({ role: 'user', content, at: Date.now() })
  const pending = { role: 'assistant', content: '', pending: true, trace: [], at: Date.now() }
  aiChat.messages.push(pending)
  aiChat.busy = true
  aiChat.lastActivity = Date.now()
  showFloating()
  persistChat()
  try {
    const history = aiChat.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.pending && m.content)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }))
    const result = await chatWithAssistant({ modelKey: aiChat.modelKey, messages: history, maxSteps: 20 })
    const idx = aiChat.messages.indexOf(pending)
    const final = {
      role: 'assistant',
      content: result?.ok ? result.reply || '' : '',
      error: result?.ok ? undefined : result?.error?.message || '请求失败',
      trace: result?.toolCalls || [],
      model: result?.model || undefined,
      hitStepLimit: !!result?.hitStepLimit,
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
