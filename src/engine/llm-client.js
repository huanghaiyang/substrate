// Browser client for the server-side LLM gateway. API keys never reach this module: the server
// only exposes model/provider metadata and `hasKey` flags.
async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    throw new Error('Invalid JSON from ' + path)
  }
  return body
}

export async function fetchModels() {
  const data = await request('/api/llm/models')
  if (!data || !data.ok) throw new Error(data?.error?.message || 'Failed to load models')
  return data
}

export async function chatWithAssistant({ modelKey, messages, maxSteps = 20, showThinking = true }) {
  return request('/api/llm/chat', {
    method: 'POST',
    body: JSON.stringify({ modelKey, messages, maxSteps, showThinking })
  })
}

export async function saveProvider(provider) {
  return request('/api/llm/providers', { method: 'POST', body: JSON.stringify(provider) })
}

export async function deleteProvider(id) {
  return request('/api/llm/providers/delete', { method: 'POST', body: JSON.stringify({ id }) })
}

export async function testProviderModel(modelKey) {
  return request('/api/llm/test', { method: 'POST', body: JSON.stringify({ modelKey }) })
}

export async function fetchMcpSelfcheck() {
  return request('/api/mcp/selfcheck')
}

export async function fetchAiRules() {
  return request('/api/llm/rules')
}
