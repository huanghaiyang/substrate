// Browser ⇄ Node MCP gateway bridge.
//
// The page keeps one Server-Sent-Events connection to /api/mcp/events. External MCP clients
// (stdio server or HTTP JSON-RPC) enqueue a tool call on the Node server; the server pushes it
// down this stream, the page executes it through the shared handler registry and POSTs the
// normalized result back to /api/mcp/result.
import { executeTool } from './mcp-commands.js'
import { API_VERSION } from './mcp-catalog.js'

let source = null
let clientId = ''
let queue = Promise.resolve()
let reconnectTimer = null
let closed = false

function postResult(payload) {
  return fetch('/api/mcp/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((e) => console.warn('[mcp] result post failed', e))
}

async function runJob(job) {
  const started = performance.now()
  let payload
  try {
    const data = await executeTool(job.tool, job.arguments || {})
    payload = { id: job.id, ok: true, data, durationMs: +(performance.now() - started).toFixed(1) }
  } catch (e) {
    payload = {
      id: job.id,
      ok: false,
      durationMs: +(performance.now() - started).toFixed(1),
      error: {
        code: e?.code || 'INTERNAL',
        message: e?.message || String(e),
        details: e?.details || undefined
      }
    }
  }
  if (window.__MCP__) {
    window.__MCP__.lastJob = { id: job.id, tool: job.tool, ok: payload.ok, durationMs: payload.durationMs, at: Date.now() }
    window.__MCP__.lastError = payload.ok ? '' : payload.error.message
  }
  await postResult(payload)
}

function enqueueJob(job) {
  queue = queue
    .then(() => runJob(job))
    .catch((e) => console.warn('[mcp] job failed', e))
  return queue
}

function connect() {
  if (closed) return
  const params = new URLSearchParams({ v: API_VERSION })
  if (clientId) params.set('resume', clientId)
  // optional shared token for installations guarded by MCP_TOKEN (EventSource cannot send headers)
  try {
    const token = localStorage.getItem('substrate.mcpToken')
    if (token) params.set('token', token)
  } catch (e) {
    /* storage may be unavailable */
  }
  source = new EventSource('/api/mcp/events?' + params.toString())

  source.addEventListener('ready', (event) => {
    try {
      const info = JSON.parse(event.data)
      clientId = info.clientId || clientId
      if (window.__MCP__) {
        window.__MCP__.connected = true
        window.__MCP__.clientId = clientId
        window.__MCP__.since = info.serverTime || Date.now()
      }
      console.info('[mcp] bridge connected', clientId)
    } catch (e) {
      console.warn('[mcp] malformed ready event', e)
    }
  })

  source.addEventListener('job', (event) => {
    try {
      const job = JSON.parse(event.data)
      if (!job || !job.id || !job.tool) return
      enqueueJob(job)
    } catch (e) {
      console.warn('[mcp] malformed job', e)
    }
  })

  source.addEventListener('ping', () => {
    if (window.__MCP__) window.__MCP__.lastPing = Date.now()
  })

  source.onerror = () => {
    if (window.__MCP__) window.__MCP__.connected = false
    if (source) {
      source.close()
      source = null
    }
    if (closed) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 1500)
  }
}

export function startMcpBridge(opts = {}) {
  if (typeof EventSource === 'undefined') return null
  const params = new URLSearchParams(location.search)
  if (params.get('mcp') === 'off') return null
  if (window.__MCP__) return window.__MCP__
  closed = false
  clientId = ''
  window.__MCP__ = {
    apiVersion: API_VERSION,
    connected: false,
    clientId: '',
    lastJob: null,
    lastError: '',
    enabled: true
  }
  connect()
  window.addEventListener('beforeunload', () => {
    closed = true
    if (source) source.close()
  })
  return window.__MCP__
}

export function stopMcpBridge() {
  closed = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (source) source.close()
  source = null
  if (window.__MCP__) window.__MCP__.connected = false
}
