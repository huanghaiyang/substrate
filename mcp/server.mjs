#!/usr/bin/env node
// Substrate MCP server (stdio transport).
//
// A dependency-free Model Context Protocol server that exposes the Substrate Texture Studio as
// normalized tools. It talks to the local studio server (default http://127.0.0.1:3000):
//   GET  /api/mcp/tools   → tool catalog
//   POST /api/mcp/call    → execute one tool in the connected browser tab
// The actual WebGL work happens in the page; this process only translates stdio JSON-RPC.
//
// Usage:  node mcp/server.mjs
// Env:    SUBSTRATE_URL=http://127.0.0.1:3000   SUBSTRATE_MCP_TOKEN=...  (optional)
import readline from 'node:readline'
import { API_VERSION, PROTOCOL_VERSION, ERROR_CODES } from '../src/engine/mcp-catalog.js'

const BASE_URL = (process.env.SUBSTRATE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const TOKEN = String(process.env.SUBSTRATE_MCP_TOKEN || '')
const SERVER_INFO = { name: 'substrate-texture-designer', title: 'Substrate Texture Studio', version: API_VERSION }

function log(...args) {
  console.error('[substrate-mcp]', ...args)
}

function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN
  return h
}

async function fetchJSON(path, opts = {}) {
  const res = await fetch(BASE_URL + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 200)}`)
  }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status} from ${path}`)
    err.code = body?.error?.code || 'HTTP_' + res.status
    throw err
  }
  return body
}

let catalogCache = null
async function loadCatalog() {
  if (catalogCache) return catalogCache
  catalogCache = await fetchJSON('/api/mcp/tools')
  return catalogCache
}

function textResult(envelope) {
  if (envelope.ok) {
    const structured = { ok: true, tool: envelope.tool, data: envelope.data, meta: envelope.meta }
    return {
      content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
      structuredContent: envelope.data,
      isError: false
    }
  }
  const structured = { ok: false, tool: envelope.tool, error: envelope.error }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: { error: envelope.error },
    isError: true
  }
}

async function callTool(name, args) {
  if (!name) {
    return { ok: false, tool: null, error: { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Missing tool name' } }
  }
  try {
    return await fetchJSON('/api/mcp/call', {
      method: 'POST',
      body: JSON.stringify({ name, arguments: args || {} })
    })
  } catch (e) {
    return {
      ok: false,
      tool: name,
      error: { code: e.code || ERROR_CODES.INTERNAL, message: e.message }
    }
  }
}

async function handleMessage(msg) {
  const id = msg.id === undefined ? null : msg.id
  const method = msg.method
  if (!method) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }
  }
  if (method.startsWith('notifications/')) return null
  try {
    switch (method) {
      case 'initialize': {
        const requested = msg.params?.protocolVersion
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions:
              'Drive the Substrate procedural texture studio: inspect/mutate the node graph, paint strokes, evaluate and export standards-compliant PBR packages. Start the studio with `npm start` and keep a browser tab open so the MCP bridge can reach the WebGL engine.'
          }
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list': {
        const catalog = await loadCatalog()
        return { jsonrpc: '2.0', id, result: { tools: catalog.tools } }
      }
      case 'tools/call': {
        const name = msg.params?.name
        const args = msg.params?.arguments || {}
        const envelope = await callTool(name, args)
        return { jsonrpc: '2.0', id, result: textResult(envelope) }
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } }
      case 'resources/templates/list':
        return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } }
      case 'logging/setLevel':
        return { jsonrpc: '2.0', id, result: {} }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } }
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: e?.message || String(e) } }
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export { handleMessage, callTool, loadCatalog, fetchJSON, SERVER_INFO, BASE_URL }

export function startStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  log(`stdio MCP server ready; studio at ${BASE_URL}`)
  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (Array.isArray(msg)) {
      const out = []
      for (const item of msg) {
        const res = await handleMessage(item)
        if (res) out.push(res)
      }
      if (out.length) send(out)
      return
    }
    const res = await handleMessage(msg)
    if (res) send(res)
  })
  rl.on('close', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
}

// only start the STDIO loop when executed directly (not when imported by the test suite)
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('mcp/server.mjs')) {
  startStdio()
}
