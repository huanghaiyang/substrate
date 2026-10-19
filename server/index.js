// Substrate Texture Studio — dependency-free Node server.
// Serves the zero-bundler ESM app, project persistence and material package export.
import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import {
  API_VERSION,
  PROTOCOL_VERSION,
  ERROR_CODES,
  publicCatalog,
  getTool,
  validateArguments,
  toolTimeout
} from '../src/engine/mcp-catalog.js'
import { initAssets, listAssets, importAsset, importSbsarAsset, readSbsarInspection, deleteAsset, trashAsset, restoreAsset, listTrashedAssets, assetIndexEntries, assetFilePath, assetsCount, searchAssets, importAssetFromUrl, ASSETS_DIR } from './assets.mjs'
import { trashProject, listTrashedProjects, restoreProject, purgeProject, emptyProjectsTrash, trashProjectBytes, TRASH_DIR } from './trash.mjs'
import { scanAssetUsage, usageForAsset, assetsInGraph } from './usage.mjs'
import { bakeStatus, bakeSbsar, readBakedFile, cleanupBake } from './sbsar-bake.mjs'
import {
  loadConfig as loadLlmConfig,
  saveConfig as saveLlmConfig,
  publicModels,
  upsertProvider,
  removeProvider,
  runAssistant,
  testModel,
  getAiRules
} from './llm.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USE_DIST = process.argv.includes('--dist')
const WWW = USE_DIST ? path.join(ROOT, 'dist') : ROOT
const PORT = Number(process.env.PORT || 3000)
const PROJECTS_DIR = path.join(ROOT, 'projects')
const EXPORTS_DIR = path.join(ROOT, 'exports')
const DEBUG_DIR = path.join(ROOT, 'debug')
const BODY_LIMIT = 320 * 1024 * 1024

for (const dir of [PROJECTS_DIR, EXPORTS_DIR, DEBUG_DIR]) mkdirSync(dir, { recursive: true })
initAssets()

// ------------------------------------------------------------------- MCP gateway
// The browser page keeps one SSE connection per tab. External clients (stdio MCP server or
// HTTP JSON-RPC /mcp) enqueue tool calls; the page executes them and posts the result back.
const MCP_TOKEN = String(process.env.MCP_TOKEN || '')
const mcpClients = new Map() // clientId -> { res, busy, connectedAt, heartbeat }
const mcpQueue = []
const mcpJobs = new Map() // jobId -> { resolve, timer, tool, clientId }
let mcpJobSeq = 0

function mcpAuthorized(req, url) {
  if (!MCP_TOKEN) return true
  const header = String(req.headers.authorization || '')
  const token = String(req.headers['x-mcp-token'] || '')
  const queryToken = url ? String(url.searchParams.get('token') || '') : ''
  return header === 'Bearer ' + MCP_TOKEN || token === MCP_TOKEN || queryToken === MCP_TOKEN
}

function mcpUnauthorized(res) {
  return sendJSON(res, 401, {
    ok: false,
    apiVersion: API_VERSION,
    error: { code: ERROR_CODES.UNAUTHORIZED, message: 'Missing or invalid MCP token' }
  })
}

function mcpClientInfo() {
  return [...mcpClients.entries()].map(([id, c]) => ({ id, busy: c.busy, connectedAt: c.connectedAt }))
}

function pumpMcpQueue() {
  if (!mcpQueue.length) return
  // Prefer the most recently connected tab: reloads/closed pages can leave stale SSE entries
  // behind until the socket is reaped, and an older page may run outdated tool code.
  const clients = [...mcpClients.entries()].sort((x, y) => (y[1].connectedAt || 0) - (x[1].connectedAt || 0))
  for (const [id, client] of clients) {
    if (client.busy) continue
    const job = mcpQueue.shift()
    if (!job) return
    client.busy = true
    job.clientId = id
    const waiter = mcpJobs.get(job.id)
    if (waiter) waiter.clientId = id
    const payload = JSON.stringify({ id: job.id, tool: job.tool, arguments: job.args })
    try {
      client.res.write('event: job\ndata: ' + payload + '\n\n')
      console.log('[mcp] dispatch', job.tool, job.id, '→', id)
    } catch (e) {
      client.busy = false
      mcpQueue.unshift(job)
      continue
    }
    return
  }
}

function finishMcpJob(id, envelope) {
  const job = mcpJobs.get(id)
  if (!job) return false
  mcpJobs.delete(id)
  clearTimeout(job.timer)
  if (job.clientId && mcpClients.has(job.clientId)) mcpClients.get(job.clientId).busy = false
  job.resolve(envelope)
  pumpMcpQueue()
  return true
}

/**
 * Dispatch one normalized tool call to a connected browser client.
 * Resolves to the external envelope { ok, tool, data, meta } or { ok:false, error }.
 */
function toolExample(tool) {
  const examples = Array.isArray(tool?.examples) ? tool.examples : []
  // Prefer an example that actually shows arguments (get_thumbnail's first example is {}).
  return examples.find((e) => e && typeof e === 'object' && Object.keys(e).length) || examples[0] || null
}

function enrichToolError(error, tool) {
  const e = error && typeof error === 'object' ? { ...error } : { code: ERROR_CODES.INTERNAL, message: String(error || 'Tool failed') }
  const specific = e.details && e.details.example
  const example = specific || toolExample(tool)
  if (example) {
    e.details = { ...(e.details || {}), example, tool: tool.name }
    if (!e.hint && !e.details?.availablePorts) e.hint = 'Expected argument shape: ' + JSON.stringify(example)
  }
  return e
}

function dispatchMcpTool(name, args, requestedTimeout) {
  const tool = getTool(name)
  const base = { apiVersion: API_VERSION }
  if (!tool) {
    return Promise.resolve({ ...base, ok: false, error: { code: ERROR_CODES.UNKNOWN_TOOL, message: 'Unknown tool: ' + name } })
  }
  let validated
  try {
    validated = validateArguments(name, args || {})
  } catch (e) {
    return Promise.resolve({
      ...base,
      ok: false,
      tool: name,
      error: {
        code: e.code || ERROR_CODES.INVALID_ARGUMENT,
        message: e.message + (toolExample(tool) ? ' — example: ' + JSON.stringify(toolExample(tool)) : ''),
        details: { tool: name, example: toolExample(tool), inputSchema: tool.inputSchema }
      }
    })
  }
  const timeoutMs = toolTimeout(name, requestedTimeout)
  const id = 'mcp_' + Date.now().toString(36) + '_' + ++mcpJobSeq
  const started = Date.now()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finishMcpJob(id, {
        ...base,
        ok: false,
        tool: name,
        error: { code: ERROR_CODES.TIMEOUT, message: 'Tool call timed out after ' + timeoutMs + ' ms' },
        meta: { durationMs: Date.now() - started }
      })
    }, timeoutMs)
    const waiter = {
      resolve: (data) =>
        resolve({
          ...base,
          tool: name,
          ok: data.ok,
          data: data.data,
          error: data.ok ? data.error : enrichToolError(data.error, tool),
          meta: data.meta
        }),
      timer,
      tool: name,
      clientId: null
    }
    mcpJobs.set(id, waiter)
    mcpQueue.push({ id, tool: name, args: validated })
    if (mcpClients.size === 0) {
      // give a freshly loaded tab a moment to connect before reporting APP_NOT_CONNECTED
      setTimeout(() => {
        if (mcpJobs.has(id) && mcpClients.size === 0) {
          finishMcpJob(id, {
            ...base,
            ok: false,
            tool: name,
            error: {
              code: ERROR_CODES.APP_NOT_CONNECTED,
              message: 'No Substrate app tab is connected. Open the studio in a browser (and keep this server running).'
            },
            meta: { durationMs: Date.now() - started }
          })
        }
      }, 2500)
    }
    pumpMcpQueue()
  })
}

function handleMcpEvents(req, res, url) {
  if (!mcpAuthorized(req, url)) return mcpUnauthorized(res)
  const clientId = 'tab_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write('event: ready\ndata: ' + JSON.stringify({ clientId, apiVersion: API_VERSION, serverTime: Date.now() }) + '\n\n')
  const heartbeat = setInterval(() => {
    try {
      res.write('event: ping\ndata: ' + Date.now() + '\n\n')
    } catch (e) {
      /* cleaned up below */
    }
  }, 20000)
  if (heartbeat.unref) heartbeat.unref()
  const client = { res, busy: false, connectedAt: Date.now(), heartbeat, clientId }
  mcpClients.set(clientId, client)
  console.log('[mcp] browser connected', clientId, '(' + mcpClients.size + ' tab(s))')
  pumpMcpQueue()
  req.on('close', () => {
    clearInterval(heartbeat)
    if (mcpClients.get(clientId) === client) mcpClients.delete(clientId)
    console.log('[mcp] browser disconnected', clientId, '(' + mcpClients.size + ' tab(s))')
    pumpMcpQueue()
  })
}

function handleMcpResult(req, res) {
  if (!mcpAuthorized(req)) return mcpUnauthorized(res)
  return readBody(req, 64 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8'))
      if (!payload || !payload.id) return sendJSON(res, 400, { ok: false, error: { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Missing job id' } })
      const envelope = {
        ok: !!payload.ok,
        data: payload.data,
        error: payload.error || null,
        meta: { durationMs: payload.durationMs || null, clientId: payload.clientId || null }
      }
      const known = finishMcpJob(payload.id, envelope)
      console.log('[mcp] result', String(payload.id), payload.ok ? 'ok' : 'error', known ? '' : '(unknown job)')
      sendJSON(res, known ? 200 : 202, { ok: true, accepted: known })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: ERROR_CODES.INVALID_ARGUMENT, message: e.message } }))
}

function handleMcpCall(req, res) {
  if (!mcpAuthorized(req)) return mcpUnauthorized(res)
  return readBody(req, 8 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8'))
      const name = String(payload?.name || payload?.tool || '')
      const args = payload?.arguments ?? payload?.args ?? {}
      const timeout = payload?.timeoutMs
      if (!name) {
        return sendJSON(res, 200, {
          ok: false,
          apiVersion: API_VERSION,
          error: { code: ERROR_CODES.INVALID_ARGUMENT, message: 'Missing tool name' }
        })
      }
      return dispatchMcpTool(name, args, timeout).then((envelope) => sendJSON(res, 200, envelope))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, apiVersion: API_VERSION, error: { code: ERROR_CODES.INVALID_ARGUMENT, message: e.message } }))
}

function mcpToolResult(envelope) {
  if (envelope.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: envelope.tool, data: envelope.data, meta: envelope.meta }, null, 2) }],
      structuredContent: envelope.data,
      isError: false
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, tool: envelope.tool, error: envelope.error }, null, 2) }],
    structuredContent: { error: envelope.error },
    isError: true
  }
}

function handleMcpJsonRpc(req, res) {
  if (!mcpAuthorized(req)) return mcpUnauthorized(res)
  return readBody(req, 8 * 1024 * 1024)
    .then(async (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString('utf8'))
      } catch (e) {
        return sendJSON(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const id = msg.id === undefined ? null : msg.id
      if (!msg.method) {
        return sendJSON(res, 200, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } })
      }
      if (msg.method.startsWith('notifications/')) {
        res.writeHead(202)
        return res.end()
      }
      let result
      try {
        switch (msg.method) {
          case 'initialize': {
            const requested = msg.params?.protocolVersion
            result = {
              protocolVersion: requested || PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } },
              serverInfo: { name: 'substrate-texture-designer', title: 'Substrate Texture Studio', version: API_VERSION },
              instructions:
                'Drive the Substrate procedural texture studio: inspect/mutate the node graph, paint strokes, evaluate and export standards-compliant PBR packages. The studio must be open in a browser tab connected to this server.'
            }
            break
          }
          case 'ping':
            result = {}
            break
          case 'tools/list':
            result = { tools: publicCatalog({ connectedClients: mcpClients.size }).tools }
            break
          case 'tools/call': {
            const name = msg.params?.name
            const args = msg.params?.arguments || {}
            const envelope = await dispatchMcpTool(name, args)
            result = mcpToolResult(envelope)
            break
          }
          case 'resources/list':
            result = { resources: [] }
            break
          case 'resources/templates/list':
            result = { resourceTemplates: [] }
            break
          case 'prompts/list':
            result = { prompts: [] }
            break
          default:
            return sendJSON(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + msg.method } })
        }
      } catch (e) {
        return sendJSON(res, 200, { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } })
      }
      return sendJSON(res, 200, { jsonrpc: '2.0', id, result })
    })
    .catch((e) => sendJSON(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }))
}
if (USE_DIST && !existsSync(path.join(WWW, 'index.html'))) {
  console.error('[substrate] dist/ not found — run: npm run build')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.zip': 'application/zip',
  '.sbs': 'application/octet-stream'
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.sep + String(rel || '').replace(/^[/\\]+/, ''))
  if (!target.startsWith(base + path.sep) && target !== base) return null
  return target
}

function slugify(name, fallback = 'material') {
  const clean = String(name || '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  return clean || fallback
}

// Filenames must stay ASCII, but two different non-ASCII names must not collide,
// so append a short stable hash whenever characters had to be stripped.
function nameSlug(name, fallback = 'material') {
  const base = slugify(name, fallback)
  const normalized = String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
  if (base === normalized) return base
  const hash = createHash('sha1').update(String(name || '')).digest('hex').slice(0, 6)
  return `${base}-${hash}`
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ------------------------------------------------------------------ zip writer
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

function zipStore(entries) {
  // entries: [{ name, data: Buffer, compress?: boolean }]
  const localParts = []
  const centralParts = []
  let offset = 0
  const { time, day } = dosTime()
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(entry.data)
    const compress = entry.compress !== false
    const body = compress ? deflateRawSync(entry.data, { level: 9 }) : entry.data
    const method = compress ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, cd, eocd])
}

// ------------------------------------------------------------------- projects
// the material currently open in the editor: it cannot be deleted until another one is opened
let activeProject = ''

function setActiveProject(name) {
  activeProject = String(name || '')
  return activeProject
}

function projectList() {
  const out = []
  for (const file of readdirSync(PROJECTS_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const full = path.join(PROJECTS_DIR, file)
      const data = JSON.parse(readFileSync(full, 'utf8'))
      const st = statSync(full)
      const displayName = data.name || file.replace(/\.json$/, '')
      out.push({
        name: displayName,
        file,
        savedAt: data.savedAt || st.mtimeMs,
        resolution: data.resolution || 1024,
        nodes: data.graph?.nodes?.length || 0,
        bytes: st.size,
        active: !!activeProject && displayName === activeProject
      })
    } catch (e) {
      /* ignore broken project */
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

function handleProjectSave(req, res) {
  readBody(req)
    .then((buf) => {
      const data = JSON.parse(buf.toString('utf8'))
      if (!data || !data.graph) throw new Error('Invalid project payload')
      const name = String(data.name || 'Untitled').slice(0, 120)
      const file = `${nameSlug(name, 'untitled')}.json`
      const payload = { ...data, name, savedAt: Date.now() }
      writeFileSync(path.join(PROJECTS_DIR, file), JSON.stringify(payload, null, 2), 'utf8')
      sendJSON(res, 200, { ok: true, file, name, path: path.join('projects', file) })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
}

function handleProjectLoad(res, name) {
  // accept either the display name or the already-hashed file slug returned by /api/projects
  let file = `${nameSlug(name, 'untitled')}.json`
  if (!/^[A-Za-z0-9 _-]+\.json$/.test(file)) file = `${slugify(name, 'untitled')}.json`
  let full = safeJoin(PROJECTS_DIR, file)
  if (!full || !existsSync(full)) {
    const alt = `${slugify(name, 'untitled')}.json`
    if (alt !== file) {
      const altFull = safeJoin(PROJECTS_DIR, alt)
      if (altFull && existsSync(altFull)) {
        full = altFull
        file = alt
      }
    }
  }
  if (!full || !existsSync(full)) return sendJSON(res, 404, { ok: false, error: 'Project not found' })
  const body = readFileSync(full)
  try {
    // opening a material makes it the active one → it is now protected from deletion
    setActiveProject(JSON.parse(body.toString('utf8')).name || file.replace(/\.json$/, ''))
  } catch (e) {
    /* ignore parse problems; the client will still mark it active */
  }
  send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' })
}

// -------------------------------------------------------------------- exports
function handleExport(req, res) {
  readBody(req)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8'))
      if (!payload || !Array.isArray(payload.files)) throw new Error('Invalid export payload')
      const name = String(payload.materialName || 'Material').slice(0, 120)
      let dirName = `${slugify(name)}-${stamp()}`
      let suffix = 2
      while (existsSync(path.join(EXPORTS_DIR, dirName))) dirName = `${slugify(name)}-${stamp()}-${suffix++}`
      const dir = path.join(EXPORTS_DIR, dirName)
      mkdirSync(dir, { recursive: true })
      const entries = []
      const written = []
      for (const file of payload.files) {
        const rel = String(file.path || '').replace(/\\/g, '/')
        if (rel.includes('..') || rel.startsWith('/')) throw new Error('Illegal file path')
        const target = safeJoin(dir, rel)
        if (!target) throw new Error('Illegal file path')
        mkdirSync(path.dirname(target), { recursive: true })
        const data = Buffer.from(String(file.data || ''), 'base64')
        writeFileSync(target, data)
        entries.push({ name: rel, data, compress: false })
        written.push({ path: rel, bytes: data.length })
      }
      const manifestBuf = Buffer.from(JSON.stringify(payload.manifest || {}, null, 2), 'utf8')
      const readmeBuf = Buffer.from(String(payload.readme || ''), 'utf8')
      writeFileSync(path.join(dir, 'manifest.json'), manifestBuf)
      writeFileSync(path.join(dir, 'README.md'), readmeBuf)
      entries.push({ name: 'manifest.json', data: manifestBuf, compress: true })
      entries.push({ name: 'README.md', data: readmeBuf, compress: true })
      const zipBuf = zipStore(entries)
      const zipName = `${slugify(name)}.zip`
      writeFileSync(path.join(dir, zipName), zipBuf)
      pruneExports()
      sendJSON(res, 200, {
        ok: true,
        dir: 'exports/' + dirName,
        url: `/exports/${dirName}/`,
        zip: `/exports/${dirName}/${zipName}`,
        zipBytes: zipBuf.length,
        files: written
      })
    })
    .catch((e) => {
      console.error('[export]', e)
      sendJSON(res, 400, { ok: false, error: e.message })
    })
}

function exportList() {
  const out = []
  if (!existsSync(EXPORTS_DIR)) return out
  const dirs = readdirSync(EXPORTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
  for (const d of dirs) {
    const dir = path.join(EXPORTS_DIR, d.name)
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    } catch (e) {
      /* skip */
    }
    const files = readdirSync(dir).filter((f) => f !== 'manifest.json' && f !== 'README.md')
    const zip = files.find((f) => f.endsWith('.zip'))
    out.push({
      dir: d.name,
      url: `/exports/${d.name}/`,
      zip: zip ? `/exports/${d.name}/${zip}` : null,
      mtime: statSync(dir).mtimeMs,
      manifest,
      files
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function pruneExports(max = 40) {
  try {
    const dirs = readdirSync(EXPORTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, mtime: statSync(path.join(EXPORTS_DIR, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const old of dirs.slice(max)) rmSync(path.join(EXPORTS_DIR, old.name), { recursive: true, force: true })
  } catch (e) {
    /* ignore */
  }
}

// --------------------------------------------------------------------- static
const VENDOR_FILES = {
  'vue.esm-browser.prod.js': 'node_modules/vue/dist/vue.esm-browser.prod.js',
  'vue.esm-browser.js': 'node_modules/vue/dist/vue.esm-browser.js',
  'three.module.js': 'node_modules/three/build/three.module.js',
  // third-party JSON pretty-printer vendored as UMD (MIT, json-formatter-js 2.3.4)
  'json-formatter.umd.js': 'vendor/json-formatter.umd.js'
}

function serveFile(res, file, download = false) {
  if (!existsSync(file) || statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  }
  const headers = { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-cache' }
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

function serveVendor(res, rel) {
  const clean = rel.replace(/^[/\\]+/, '')
  if (VENDOR_FILES[clean]) return serveFile(res, path.join(ROOT, VENDOR_FILES[clean]))
  if (clean.startsWith('addons/')) {
    const sub = clean.slice('addons/'.length)
    const full = safeJoin(path.join(ROOT, 'node_modules/three/examples/jsm'), sub)
    if (full) return serveFile(res, full)
  }
  send(res, 404, 'vendor not found', { 'Content-Type': 'text/plain' })
}

function serveApp(res, urlPath) {
  // vendor always resolves from node_modules (works for source and dist builds alike)
  if (urlPath.startsWith('/vendor/')) return serveVendor(res, urlPath.slice('/vendor/'.length))
  if (urlPath.startsWith('/exports/')) {
    const full = safeJoin(EXPORTS_DIR, urlPath.slice('/exports/'.length))
    if (!full) return send(res, 400, 'Bad path')
    if (urlPath.endsWith('.zip')) return serveFile(res, full, true)
    if (urlPath.endsWith('/')) {
      // directory index listing (useful when opening the export folder in a browser)
      const dir = full
      if (!existsSync(dir)) return send(res, 404, 'Not found')
      const rows = readdirSync(dir)
        .map((f) => `<li><a href="${encodeURIComponent(f)}">${f}</a></li>`)
        .join('')
      return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Export</title><body style="font:14px system-ui;background:#14161a;color:#ddd;padding:24px"><h2>Export package</h2><ul>${rows}</ul></body>`, {
        'Content-Type': 'text/html; charset=utf-8'
      })
    }
    return serveFile(res, full)
  }
  let rel = urlPath
  if (rel === '/' || rel === '') rel = '/index.html'
  const full = safeJoin(WWW, rel)
  if (!full) return send(res, 400, 'Bad path')
  if (existsSync(full) && statSync(full).isFile()) return serveFile(res, full)
  // SPA fallback
  return serveFile(res, path.join(WWW, 'index.html'))
}

// ----------------------------------------------------------------------- main
function handleLlmModels(req, res) {
  return sendJSON(res, 200, publicModels())
}

function handleLlmProviderSave(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const result = upsertProvider(payload || {})
      return sendJSON(res, 200, { ok: true, ...result })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'LLM_CONFIG_ERROR', message: String(e.message || e) } }))
}

function handleLlmProviderDelete(req, res) {
  return readBody(req, 256 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      if (!payload.id) throw new Error('Missing provider id')
      const result = removeProvider(String(payload.id))
      return sendJSON(res, 200, { ok: true, ...result })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'LLM_CONFIG_ERROR', message: String(e.message || e) } }))
}

function handleLlmChat(req, res) {
  return readBody(req, 4 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return runAssistant((name, args) => dispatchMcpTool(name, args), payload).then((result) => sendJSON(res, 200, result))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: String(e.message || e) } }))
}

function handleLlmTest(req, res) {
  return readBody(req, 256 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return testModel(payload.modelKey || payload.model).then((result) => sendJSON(res, 200, result))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: String(e.message || e) } }))
}

function handleAssetsList(req, res) {
  // annotate every asset with the saved projects that reference it (the UI locks those against deletion)
  let usage = new Map()
  try {
    usage = scanAssetUsage(PROJECTS_DIR).usage
  } catch (e) {
    usage = new Map()
  }
  const index = assetIndexEntries()
  const assets = listAssets().map((a) => {
    const entry = index.find((e) => e.id === a.id)
    const usedBy = usageForAsset(usage, entry, index)
    return { ...a, usage: usedBy }
  })
  return sendJSON(res, 200, { ok: true, assets, dir: 'assets/' })
}

function handleAssetImport(req, res) {
  return readBody(req, 40 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const asset = importAsset({ name: payload.name, dataUrl: payload.dataUrl || payload.data })
      return sendJSON(res, 200, { ok: true, asset })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'ASSET_IMPORT_FAILED', message: String(e.message || e) } }))
}

function handleAssetImportSbsar(req, res) {
  return readBody(req, 90 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const result = importSbsarAsset({ name: payload.name, data: payload.data || payload.dataUrl })
      return sendJSON(res, 200, { ok: true, ...result })
    })
    .catch((e) =>
      sendJSON(res, 400, { ok: false, error: { code: 'SBSAR_IMPORT_FAILED', message: String(e.message || e) } })
    )
}

function handleAssetSbsarInspect(req, res, url) {
  try {
    const id = url.searchParams.get('id')
    if (!id) throw new Error('Missing asset id')
    return sendJSON(res, 200, { ok: true, inspection: readSbsarInspection(String(id)) })
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: { code: 'SBSAR_INSPECT_FAILED', message: String(e.message || e) } })
  }
}

function handleTrashList(req, res) {
  const projects = listTrashedProjects().map((item) => {
    // bindings survive the bin: report how many assets this material still holds
    let boundAssets = 0
    try {
      const stored = path.join(TRASH_DIR, item.stored || '')
      if (item.stored && existsSync(stored)) {
        boundAssets = assetsInGraph(JSON.parse(readFileSync(stored, 'utf8')).graph).size
      }
    } catch (e) {
      boundAssets = 0
    }
    return { ...item, boundAssets }
  })
  return sendJSON(res, 200, {
    ok: true,
    projects,
    assets: listTrashedAssets(),
    projectBytes: trashProjectBytes()
  })
}

/** restore one binned item; kind picks the store (project file vs asset library entry) */
function handleTrashRestore(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const id = String(payload.id || '')
      if (!id) throw Object.assign(new Error('Missing id'), { code: 'INVALID_ARGUMENT' })
      const restored = payload.kind === 'asset' ? restoreAsset(id) : restoreProject(id, PROJECTS_DIR)
      sendJSON(res, 200, { ok: true, restored })
    })
    .catch((e) => sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: { code: e.code || 'RESTORE_FAILED', message: String(e.message || e) } }))
}

function handleTrashPurge(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const id = String(payload.id || '')
      if (!id) throw Object.assign(new Error('Missing id'), { code: 'INVALID_ARGUMENT' })
      const purged = payload.kind === 'asset' ? deleteAsset(id) : purgeProject(id)
      sendJSON(res, 200, { ok: true, purged })
    })
    .catch((e) => sendJSON(res, e.code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: { code: e.code || 'PURGE_FAILED', message: String(e.message || e) } }))
}

/** empty the whole bin: every binned project file and every soft-deleted asset */
function handleTrashEmpty(req, res) {
  try {
    const projects = emptyProjectsTrash()
    const assets = []
    for (const a of listTrashedAssets()) {
      try {
        deleteAsset(a.id)
        assets.push(a.id)
      } catch (e) {
        /* keep going; report what we could remove */
      }
    }
    return sendJSON(res, 200, { ok: true, purged: { projects: projects.purged, assets: assets.length } })
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: { code: 'EMPTY_FAILED', message: String(e.message || e) } })
  }
}

function handleSbsarBakeStatus(req, res) {
  return sendJSON(res, 200, { ok: true, ...bakeStatus() })
}

/**
 * Bake a stored .sbsar through the locally installed Adobe engine (SAT) and import the resulting maps
 * into the asset library. Nothing is emulated: if the engine is absent this returns SAT_MISSING with
 * install guidance instead of pretending to bake.
 */
function handleSbsarBake(req, res) {
  return readBody(req, 1024 * 1024)
    .then(async (buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const id = String(payload.assetId || '')
      if (!id) throw Object.assign(new Error('Missing assetId'), { code: 'INVALID_ARGUMENT' })
      const entry = listAssets().find((a) => a.id === id)
      if (!entry || entry.kind !== 'sbsar') throw Object.assign(new Error('Archive asset not found: ' + id), { code: 'NOT_FOUND' })
      const file = entry.file ? path.join(ASSETS_DIR, String(entry.file)) : null
      if (!file || !existsSync(file)) throw Object.assign(new Error('Archive file is missing on disk'), { code: 'NOT_FOUND' })
      const resolution = Math.min(4096, Math.max(256, Number(payload.res) || 2048))
      // parameter overrides are validated against the interface we parsed from the archive
      let inspection = {}
      try {
        inspection = readSbsarInspection(id) || {}
      } catch (e) {
        inspection = {}
      }
      const baked = await bakeSbsar({
        file,
        res: resolution,
        graph: payload.graph || null,
        params: payload.params || null,
        parameters: inspection.parameters || []
      })
      try {
        const assets = []
        for (const f of baked.files) {
          const buffer = readBakedFile(f.path)
          const asset = importAsset({ name: f.name, dataUrl: 'data:image/png;base64,' + buffer.toString('base64') })
          assets.push({ ...asset, channel: f.channel })
        }
        return sendJSON(res, 200, { ok: true, resolution, assets, log: baked.log, applied: baked.applied || [], skipped: baked.skipped || [] })
      } finally {
        cleanupBake(baked.dir)
      }
    })
    .catch((e) => {
      const status = e.code === 'SAT_MISSING' ? 503 : e.code === 'NOT_FOUND' ? 404 : 500
      return sendJSON(res, status, {
        ok: false,
        error: { code: e.code || 'BAKE_FAILED', message: String(e.message || e) },
        ...(e.code === 'SAT_MISSING' ? { install: { url: bakeStatus().installUrl } } : {})
      })
    })
}

function handleAssetSearch(req, res, url) {
  return searchAssets(url.searchParams.get('q') || '', Math.min(24, Math.max(1, Number(url.searchParams.get('limit')) || 12)))
    .then((result) => sendJSON(res, 200, result))
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: e.code || 'ASSET_SEARCH_FAILED', message: String(e.message || e) } }))
}

function handleAssetImportUrl(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return importAssetFromUrl(payload).then((asset) => sendJSON(res, 200, { ok: true, asset }))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'ASSET_IMPORT_FAILED', message: String(e.message || e) } }))
}

function handleAssetDelete(req, res) {
  return readBody(req, 256 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      if (!payload.id) throw new Error('Missing asset id')
      const id = String(payload.id)
      const entry = assetIndexEntries().find((a) => a.id === id)
      if (!entry) throw new Error('Asset not found')
      const usedBy = usageForAsset(scanAssetUsage(PROJECTS_DIR).usage, entry, assetIndexEntries())
      if (usedBy.length && !payload.force) {
        const label = (u) => (u.trashed ? u.project + ' (in recycle bin)' : u.project)
        return sendJSON(res, 409, {
          ok: false,
          error: {
            code: 'ASSET_IN_USE',
            message:
              'This asset is bound to ' +
              usedBy.length +
              ' material(s) and cannot be deleted: ' +
              usedBy.map(label).join(', ') +
              '. Bindings are released only when a binned material is permanently deleted.',
            usage: usedBy
          }
        })
      }
      // deletion is reversible: the entry is flagged and stays on disk until purged from the bin
      return sendJSON(res, 200, { ok: true, ...trashAsset(id), usedBy })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'ASSET_DELETE_FAILED', message: String(e.message || e) } }))
}

async function mcpSelfcheckReport() {
  const checks = []
  const add = (name, ok, info = '') => checks.push({ name, ok: !!ok, info: ok ? '' : String(info) })
  const catalog = publicCatalog({ connectedClients: mcpClients.size })
  add('catalog: apiVersion present', catalog.apiVersion === API_VERSION, catalog.apiVersion)
  add('catalog: tools present', Array.isArray(catalog.tools) && catalog.tools.length > 0, String(catalog.tools?.length))
  const names = catalog.tools.map((t) => t.name)
  add('catalog: tool names unique', new Set(names).size === names.length, names.length + ' tools')
  add('catalog: tools have schemas', catalog.tools.every((t) => t.inputSchema && t.description), 'missing schema/description')
  add('catalog: names normalized', names.every((n) => /^substrate_[a-z0-9_]+$/.test(n)), 'bad tool name')
  add('catalog: server knows every tool', names.every((n) => !!getTool(n)), 'unknown tool id')
  let validationOk = false
  try {
    validateArguments('substrate_add_node', {})
  } catch (e) {
    validationOk = e.code === ERROR_CODES.INVALID_ARGUMENT
  }
  add('validation: rejects missing arguments', validationOk, 'missing-argument validation did not fire')
  add('validation: unknown tool rejected', getTool('substrate_nope') === null)
  add('bridge: app tab connected', mcpClients.size > 0, 'no browser tab connected')
  if (mcpClients.size > 0) {
    const envelope = await dispatchMcpTool('substrate_get_state', {}, 10000)
    add('bridge: live round-trip (get_state)', !!envelope.ok, JSON.stringify(envelope.error || {}))
    add('bridge: normalized envelope', envelope.apiVersion === API_VERSION && 'ok' in envelope && !!envelope.meta, JSON.stringify(envelope))
  }
  const failed = checks.filter((c) => !c.ok).length
  return {
    ok: failed === 0,
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    checks,
    totals: { passed: checks.length - failed, failed },
    bridge: { connectedClients: mcpClients.size },
    auth: MCP_TOKEN ? 'token' : 'none'
  }
}

const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch (e) {
    return send(res, 400, 'Bad request')
  }
  const p = decodeURIComponent(url.pathname)
  const method = req.method || 'GET'

  if (p === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'substrate-texture-designer',
      version: '1.0.0',
      mode: USE_DIST ? 'dist' : 'source',
      node: process.version,
      projects: projectList().length,
      exports: exportList().length,
      mcp: {
        apiVersion: API_VERSION,
        connectedClients: mcpClients.size,
        pendingJobs: mcpJobs.size,
        auth: MCP_TOKEN ? 'token' : 'none',
        transports: ['stdio', 'http-jsonrpc']
      },
      assets: { count: assetsCount() },
      llm: {
        providers: loadLlmConfig().providers.length,
        models: publicModels().models.length,
        configured: loadLlmConfig().providers.some((p) => !!p.apiKey)
      }
    })
  }
  if (p === '/api/projects' && method === 'GET') return sendJSON(res, 200, { ok: true, projects: projectList(), active: activeProject })
  if (p === '/api/projects/active' && method === 'POST') {
    return readBody(req, 256 * 1024)
      .then((buf) => {
        const payload = JSON.parse(buf.toString('utf8') || '{}')
        return sendJSON(res, 200, { ok: true, active: setActiveProject(payload.name) })
      })
      .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: String(e.message || e) } }))
  }
  if (p === '/api/projects/save' && method === 'POST') return handleProjectSave(req, res)
  if (p === '/api/projects/load' && method === 'GET') return handleProjectLoad(res, url.searchParams.get('name') || '')
  if (p === '/api/projects/delete' && method === 'POST') {
    return readBody(req, 1024 * 1024)
      .then((buf) => {
        const data = JSON.parse(buf.toString('utf8'))
        const file = `${nameSlug(data.name || '', 'untitled')}.json`
        const full = safeJoin(PROJECTS_DIR, file)
        if (!full || !existsSync(full)) {
          return sendJSON(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Project not found: ' + file } })
        }
        const name = data.name || file.replace(/\.json$/, '')
        // the material that is open in the editor is locked: deleting its file would desync the editor
        if (!data.force && activeProject && name === activeProject) {
          return sendJSON(res, 409, {
            ok: false,
            error: { code: 'PROJECT_ACTIVE', message: 'This material is currently open and cannot be deleted: ' + name }
          })
        }
        // deletion is now reversible: the file moves into trash/
        const trashed = trashProject({ file: full, name })
        sendJSON(res, 200, { ok: true, trashed })
      })
      .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
  }
  if (p === '/api/export' && method === 'POST') return handleExport(req, res)
  if (p === '/api/exports' && method === 'GET') return sendJSON(res, 200, { ok: true, exports: exportList() })
  if (p === '/api/debug/report' && method === 'POST') {
    return readBody(req, 32 * 1024 * 1024)
      .then((buf) => {
        const payload = JSON.parse(buf.toString('utf8'))
        const kind = slugify(payload.kind || 'report', 'report')
        const file = kind + '.json'
        const body = JSON.stringify({ kind, receivedAt: Date.now(), ...payload }, null, 2)
        writeFileSync(path.join(DEBUG_DIR, file), body, 'utf8')
        sendJSON(res, 200, { ok: true, file: '/api/debug/last?kind=' + kind })
      })
      .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
  }
  if (p === '/api/debug/last' && method === 'GET') {
    const kind = slugify(url.searchParams.get('kind') || 'selftest', 'selftest')
    const full = path.join(DEBUG_DIR, kind + '.json')
    if (!existsSync(full)) return sendJSON(res, 404, { ok: false, error: 'No report yet' })
    return send(res, 200, readFileSync(full), { 'Content-Type': 'application/json; charset=utf-8' })
  }
  if (p === '/api/debug/list' && method === 'GET') {
    const files = readdirSync(DEBUG_DIR).filter((f) => f.endsWith('.json'))
    return sendJSON(res, 200, { ok: true, reports: files })
  }
  if (p === '/api/mcp/tools' && method === 'GET') {
    return sendJSON(
      res,
      200,
      publicCatalog({
        connectedClients: mcpClients.size,
        clients: mcpClientInfo(),
        transports: ['stdio (mcp/server.mjs)', 'http-jsonrpc POST /mcp', 'http POST /api/mcp/call'],
        auth: MCP_TOKEN ? 'token' : 'none'
      })
    )
  }
  if (p === '/api/mcp/events' && method === 'GET') return handleMcpEvents(req, res, url)
  if (p === '/api/mcp/result' && method === 'POST') return handleMcpResult(req, res)
  if (p === '/api/mcp/call' && method === 'POST') return handleMcpCall(req, res)
  if (p === '/mcp' && method === 'POST') return handleMcpJsonRpc(req, res)
  if (p === '/mcp' && method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      apiVersion: API_VERSION,
      transport: 'http-jsonrpc',
      message: 'POST JSON-RPC 2.0 messages (initialize / tools/list / tools/call) to this endpoint',
      tools: publicCatalog({ connectedClients: mcpClients.size }).tools.map((t) => t.name)
    })
  }
  if (p === '/api/mcp/selfcheck' && method === 'GET') {
    return mcpSelfcheckReport()
      .then((report) => sendJSON(res, 200, report))
      .catch((e) => sendJSON(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(e.message || e) } }))
  }
  if (p === '/api/llm/models' && method === 'GET') return handleLlmModels(req, res)
  if (p === '/api/llm/rules' && method === 'GET') return sendJSON(res, 200, getAiRules())
  if (p === '/api/llm/providers' && method === 'POST') return handleLlmProviderSave(req, res)
  if (p === '/api/llm/providers/delete' && method === 'POST') return handleLlmProviderDelete(req, res)
  if (p === '/api/llm/chat' && method === 'POST') return handleLlmChat(req, res)
  if (p === '/api/llm/test' && method === 'POST') return handleLlmTest(req, res)
  if (p === '/api/assets' && method === 'GET') return handleAssetsList(req, res)
  if (p === '/api/assets/search' && method === 'GET') return handleAssetSearch(req, res, url)
  if (p === '/api/assets/import-url' && method === 'POST') return handleAssetImportUrl(req, res)
  if (p === '/api/assets/import' && method === 'POST') return handleAssetImport(req, res)
  if (p === '/api/assets/import-sbsar' && method === 'POST') return handleAssetImportSbsar(req, res)
  if (p === '/api/sbsar/bake/status' && method === 'GET') return handleSbsarBakeStatus(req, res)
  if (p === '/api/sbsar/bake' && method === 'POST') return handleSbsarBake(req, res)
  if (p === '/api/assets/sbsar' && method === 'GET') return handleAssetSbsarInspect(req, res, url)
  if (p === '/api/assets/delete' && method === 'POST') return handleAssetDelete(req, res)
  if (p === '/api/trash' && method === 'GET') return handleTrashList(req, res)
  if (p === '/api/trash/restore' && method === 'POST') return handleTrashRestore(req, res)
  if (p === '/api/trash/purge' && method === 'POST') return handleTrashPurge(req, res)
  if (p === '/api/trash/empty' && method === 'POST') return handleTrashEmpty(req, res)
  if (p.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
    const file = assetFilePath(p)
    if (!file) return send(res, 404, 'Not found')
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    })
    if (method === 'HEAD') return res.end()
    return createReadStream(file).pipe(res)
  }
  if (p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, error: 'Unknown endpoint' })

  if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'Method not allowed')
  return serveApp(res, p)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[substrate] http://127.0.0.1:${PORT}  (${USE_DIST ? 'dist' : 'source'}, node ${process.version})`)
  console.log('[mcp] gateway ready — POST /mcp (JSON-RPC) · POST /api/mcp/call · GET /api/mcp/tools · GET /api/mcp/selfcheck')
  const models = publicModels()
  console.log('[llm] ' + models.models.length + ' model(s) configured' + (models.models.some((m) => m.hasKey) ? '' : ' — no API key yet (set DEEPSEEK_API_KEY or add a provider in the AI panel)'))
})
