// LLM assistant gateway for the Substrate studio.
//
// API keys live only on this Node process (llm.config.local.json, git-ignored, or the
// DEEPSEEK_API_KEY environment variable). The browser never receives key material: the model
// list exposes only `hasKey` booleans, and every response/error is redacted before leaving the
// server. Chat requests run an OpenAI-compatible tool-calling loop against the shared MCP tool
// catalog, so the assistant can drive exactly the same operations as external MCP clients.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, API_VERSION } from '../src/engine/mcp-catalog.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const LLM_CONFIG_PATH = path.join(ROOT, 'llm.config.local.json')
const ENV_KEY = String(process.env.DEEPSEEK_API_KEY || '')

const DEFAULT_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: ENV_KEY,
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }
    ]
  }
]

const SYSTEM_PROMPT = `You are the built-in assistant of Substrate Texture Studio, a node-based procedural PBR texture authoring app.
You control the open studio through tools (node graph editing, painting, evaluation, previews, export, projects).
Rules:
- Prefer calling tools over describing what the user could do. Verify results with tools before claiming success.
- Use substrate_get_state / substrate_get_graph to understand the current material first when needed.
- Ask the user before destructive actions (deleting nodes/projects, clearing paint, exporting at large resolutions) unless they explicitly requested them.
- Previews are returned as PNG data URLs; you cannot see them, so rely on tool JSON and describe outcomes.
- Keep answers short and practical, and reply in the language the user writes in.
- Never mention API keys, tokens or internal file paths outside the workspace-relative exports/projects folders.`

function sanitizeText(text) {
  let out = String(text == null ? '' : text)
  if (ENV_KEY) out = out.split(ENV_KEY).join('***')
  out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
  return out
}

function cleanProvider(p) {
  const provider = {
    id: String(p.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'provider-' + Date.now().toString(36),
    label: sanitizeText(String(p.label || p.id || 'Provider')).slice(0, 60),
    baseUrl: String(p.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, ''),
    apiKey: String(p.apiKey || ''),
    models: []
  }
  const models = Array.isArray(p.models) ? p.models : []
  for (const m of models) {
    const id = String(m.id || m.model || '').trim()
    if (!id) continue
    provider.models.push({ id: id.slice(0, 80), label: sanitizeText(String(m.label || id)).slice(0, 80) })
  }
  return provider
}

function defaultConfig() {
  const providers = JSON.parse(JSON.stringify(DEFAULT_PROVIDERS))
  if (ENV_KEY) providers[0].apiKey = ENV_KEY
  return { providers }
}

export function loadConfig() {
  let config = null
  try {
    if (existsSync(LLM_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(LLM_CONFIG_PATH, 'utf8'))
      if (raw && Array.isArray(raw.providers)) config = { providers: raw.providers.map(cleanProvider).filter((p) => p.models.length) }
    }
  } catch (e) {
    config = null
  }
  if (!config) config = defaultConfig()
  // environment key always wins for the built-in DeepSeek provider (never written by the UI)
  if (ENV_KEY) {
    const deepseek = config.providers.find((p) => p.id === 'deepseek')
    if (deepseek) deepseek.apiKey = ENV_KEY
    else config.providers.unshift(cleanProvider(DEFAULT_PROVIDERS[0]))
  }
  return config
}

export function saveConfig(config) {
  const payload = { version: 1, providers: (config.providers || []).map((p) => ({ ...p, apiKey: String(p.apiKey || '') })) }
  writeFileSync(LLM_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8')
  try {
    chmodSync(LLM_CONFIG_PATH, 0o600)
  } catch (e) {
    /* best effort on platforms without chmod */
  }
  return payload
}

export function publicModels() {
  const config = loadConfig()
  const models = []
  const providers = []
  for (const p of config.providers) {
    providers.push({
      id: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      hasKey: !!p.apiKey,
      models: p.models.map((m) => ({ id: m.id, label: m.label }))
    })
    for (const m of p.models) {
      models.push({
        key: p.id + ':' + m.id,
        providerId: p.id,
        provider: p.label,
        model: m.id,
        label: m.label,
        hasKey: !!p.apiKey,
        builtin: p.id === 'deepseek'
      })
    }
  }
  return {
    ok: true,
    apiVersion: API_VERSION,
    models,
    providers,
    defaultModel: models.find((m) => m.key === 'deepseek:deepseek-chat')?.key || models[0]?.key || null
  }
}

export function upsertProvider(input) {
  const config = loadConfig()
  const existing = config.providers.find((p) => p.id === input.id)
  const provider = existing || cleanProvider({ id: input.id || input.label, label: input.label || input.id, baseUrl: input.baseUrl, models: [] })
  if (input.label !== undefined) provider.label = sanitizeText(String(input.label)).slice(0, 60)
  if (input.baseUrl !== undefined) provider.baseUrl = String(input.baseUrl).replace(/\/+$/, '')
  if (input.apiKey) provider.apiKey = String(input.apiKey)
  if (Array.isArray(input.models)) provider.models = cleanProvider({ models: input.models }).models
  if (!provider.models.length) throw new Error('At least one model id is required')
  if (!/^https?:\/\//.test(provider.baseUrl)) throw new Error('baseUrl must start with http:// or https://')
  if (!existing) config.providers.push(provider)
  saveConfig(config)
  return publicModels()
}

export function removeProvider(id) {
  const config = loadConfig()
  const before = config.providers.length
  config.providers = config.providers.filter((p) => p.id !== id)
  if (config.providers.length === before) throw new Error('Provider not found')
  saveConfig(config)
  return publicModels()
}

function resolveModel(modelKey) {
  const config = loadConfig()
  const key = String(modelKey || '')
  const [providerId, modelId] = key.includes(':') ? key.split(':') : ['deepseek', key || 'deepseek-chat']
  const provider = config.providers.find((p) => p.id === providerId)
  if (!provider) throw Object.assign(new Error('Unknown model provider: ' + providerId), { code: 'INVALID_MODEL' })
  const model = provider.models.find((m) => m.id === modelId) || provider.models[0]
  if (!model) throw Object.assign(new Error('No models configured for provider ' + providerId), { code: 'NO_MODEL' })
  if (!provider.apiKey) throw Object.assign(new Error('No API key configured for provider ' + provider.label), { code: 'NO_API_KEY' })
  return { provider, model }
}

function openAiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } }
  }))
}

/** Keep tool payloads small and free of giant base64 blobs before feeding them back to the model. */
function compactToolEnvelope(envelope, maxChars = 12000) {
  const compact = JSON.parse(JSON.stringify(envelope || {}))
  const scrub = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6) return value
    for (const key of Object.keys(value)) {
      const v = value[key]
      if (typeof v === 'string' && v.startsWith('data:image/')) {
        value[key] = '[image data URL omitted, ' + v.length + ' chars]'
      } else if (v && typeof v === 'object') {
        scrub(v, depth + 1)
      }
    }
    return value
  }
  scrub(compact, 0)
  let text = JSON.stringify(compact)
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…[truncated]'
  return text
}

async function callChatCompletion(provider, modelId, messages, tools, timeoutMs = 90000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.apiKey },
      body: JSON.stringify({
        model: modelId,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens: 1400
      }),
      signal: controller.signal
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(sanitizeText('LLM HTTP ' + res.status + ': ' + text.slice(0, 300)))
      err.code = 'LLM_HTTP_ERROR'
      err.status = res.status
      throw err
    }
    let body
    try {
      body = JSON.parse(text)
    } catch (e) {
      throw Object.assign(new Error('LLM returned invalid JSON'), { code: 'LLM_BAD_RESPONSE' })
    }
    return body
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('LLM request timed out'), { code: 'LLM_TIMEOUT' })
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function normalizeMessages(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const m of input.slice(-24)) {
    if (!m || typeof m !== 'object') continue
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null
    if (!role) continue
    const content = String(m.content || '').slice(0, 6000)
    if (content) out.push({ role, content })
  }
  return out
}

export async function runAssistant(dispatch, body = {}) {
  const started = Date.now()
  const { provider, model } = resolveModel(body.modelKey || body.model)
  const userMessages = normalizeMessages(body.messages)
  if (!userMessages.length) {
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'messages must contain at least one user message' } }
  }
  const maxSteps = Math.min(10, Math.max(1, Number(body.maxSteps) || 8))
  const tools = openAiTools()
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...userMessages]
  const toolCalls = []
  let steps = 0
  let usage = null
  let toolsEnabled = true
  let toolsDisabled = false

  try {
    while (steps < maxSteps) {
      steps++
      let response
      try {
        response = await callChatCompletion(provider, model.id, messages, toolsEnabled ? tools : null)
      } catch (e) {
        // some models (e.g. reasoners) reject tool calling; retry once as a plain chat so model
        // switching still works, and tell the UI that app control is unavailable for this model
        if (toolsEnabled && (e.code === 'LLM_HTTP_ERROR' || e.code === 'LLM_BAD_RESPONSE')) {
          toolsEnabled = false
          toolsDisabled = true
          messages.unshift({ role: 'system', content: 'Tool calling is unavailable for this model; answer without using tools.' })
          response = await callChatCompletion(provider, model.id, messages, null)
        } else {
          throw e
        }
      }
      usage = response.usage || usage
      const choice = response.choices?.[0]
      const message = choice?.message
      if (!message) throw Object.assign(new Error('LLM response has no message'), { code: 'LLM_BAD_RESPONSE' })
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (!calls.length) {
        return {
          ok: true,
          reply: sanitizeText(message.content || '').trim() || '(no reply)',
          model: { key: body.modelKey || provider.id + ':' + model.id, provider: provider.label, model: model.id },
          steps,
          toolCalls,
          toolsDisabled,
          usage,
          durationMs: Date.now() - started
        }
      }
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls })
      for (const call of calls.slice(0, 6)) {
        const name = call.function?.name || ''
        let args = {}
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
        } catch (e) {
          args = {}
        }
        const envelope = await dispatch(name, args)
        toolCalls.push({
          name,
          ok: !!envelope?.ok,
          error: envelope?.ok ? undefined : envelope?.error?.code,
          message: envelope?.ok ? undefined : sanitizeText(envelope?.error?.message || '')
        })
        messages.push({
          role: 'tool',
          tool_call_id: call.id || 'call_' + toolCalls.length,
          content: compactToolEnvelope(envelope)
        })
      }
    }
    return {
      ok: false,
      error: { code: 'MAX_STEPS', message: 'The assistant reached the maximum number of tool steps without a final answer.' },
      toolCalls,
      steps,
      toolsDisabled,
      usage,
      durationMs: Date.now() - started
    }
  } catch (e) {
    return {
      ok: false,
      error: { code: e.code || 'LLM_ERROR', message: sanitizeText(e.message || String(e)) },
      toolCalls,
      steps,
      durationMs: Date.now() - started
    }
  }
}

export async function testModel(modelKey) {
  const { provider, model } = resolveModel(modelKey)
  const started = Date.now()
  try {
    const response = await callChatCompletion(provider, model.id, [{ role: 'user', content: 'Reply with exactly: OK' }], null, 30000)
    const reply = sanitizeText(response.choices?.[0]?.message?.content || '').slice(0, 200)
    return { ok: true, model: provider.id + ':' + model.id, reply, durationMs: Date.now() - started }
  } catch (e) {
    return { ok: false, error: { code: e.code || 'LLM_ERROR', message: sanitizeText(e.message || String(e)) }, durationMs: Date.now() - started }
  }
}
