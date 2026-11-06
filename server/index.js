// Substrate Texture Studio — 零依赖本地 Node 服务入口。
//
// 职责：
//   1. 静态托管：把零打包 ESM 前端（源码模式为仓库根目录，--dist 时为 dist/）与 /vendor/ 依赖
//      （Vue、Three.js、json-formatter）直接发给浏览器，并做 SPA 回退；
//   2. 工程持久化：projects/*.json 的保存、读取、删除（删除进回收站）；
//   3. 材质导出：exports/ 下按时间戳目录写出贴图、manifest.json、README.md 与 zip 包；
//   4. 素材库：assets/ 位图与 .sbsar 的导入、检索、软删除、回收站与在线图库搜索；
//   5. SBSAR：归档检查报告、通过本机 Adobe SAT（sbsrender）烘焙；
//   6. LLM 代理：模型配置、连通性测试、带工具调用的助手会话（密钥只留在服务端）；
//   7. MCP 网关：浏览器每开一个标签页就建立一条 SSE 连接，服务端把工具调用排队后下发给该标签页，
//      页面执行完再把结果回传；同时提供 HTTP JSON-RPC /mcp 与 /api/mcp/call 两种外部入口。
//
// 对外 HTTP 接口一览（均以 127.0.0.1:PORT 监听，默认 3000）：
//   GET  /api/health                     健康检查与运行统计
//   GET  /api/projects                   工程列表（含 active 标记）
//   POST /api/projects/active            设置当前打开的工程
//   POST /api/projects/save             保存工程（body 为工程 JSON）
//   POST /api/projects/thumbnail        为旧工程补写封面缩略图（静默生成后回写）
//   GET  /api/projects/load?name=        读取工程 JSON
//   POST /api/projects/delete            删除工程（进回收站，当前打开的可被 force 覆盖）
//   POST /api/export                     导出材质包（base64 文件数组 + manifest + readme）
//   GET  /api/exports                    已导出包列表
//   POST /api/debug/report               保存调试报告
//   GET  /api/debug/last?kind=           读取最近一份报告
//   GET  /api/debug/list                 报告文件名列表
//   GET  /api/mcp/tools                  工具目录（含连接信息与鉴权方式）
//   GET  /api/mcp/events                 浏览器 SSE 通道（接收 job、回传 ready/ping）
//   POST /api/mcp/result                 浏览器回传工具执行结果
//   POST /api/mcp/call                   外部直接调用单个工具（阻塞等待结果）
//   POST /mcp                            MCP JSON-RPC 2.0（initialize / tools/list / tools/call …）
//   GET  /mcp                            自述信息与工具名列表
//   GET  /api/mcp/selfcheck              自检报告（目录、参数校验、桥接往返）
//   GET  /api/llm/models                 公开模型/供应商列表（仅 hasKey 布尔，无密钥）
//   GET  /api/llm/rules                  AI 行为规则文本
//   POST /api/llm/providers              新增/更新供应商
//   POST /api/llm/providers/delete       删除供应商
//   POST /api/llm/chat                   运行助手（带 MCP 工具循环）
//   POST /api/llm/test                   测试指定模型
//   GET  /api/assets                     素材列表（附带被哪些工程引用）
//   GET  /api/assets/search?q=&limit=    在线图库搜索
//   POST /api/assets/import-url          从公网 URL 导入图片（含 SSRF 校验）
//   POST /api/assets/import              导入 data URL 图片
//   POST /api/assets/import-sbsar        导入 .sbsar 归档
//   GET  /api/assets/sbsar?id=           读取归档检查报告
//   POST /api/assets/delete              删除素材（被引用时返回 409）
//   GET  /api/sbsar/bake/status          本机 SAT 探测状态
//   POST /api/sbsar/bake                 烘焙归档并导入贴图
//   GET  /api/trash                      回收站列表（工程 + 素材）
//   POST /api/trash/restore              还原一项
//   POST /api/trash/purge                永久删除一项
//   POST /api/trash/empty                清空回收站
//   GET  /assets/<file>                  素材文件（只读，需通过 assetFilePath 过滤）
//   GET  /exports/<dir>/…                导出包浏览 / zip 下载
//   GET  /vendor/…                       第三方依赖
//
// 安全边界：
//   * 所有落盘路径都经过 safeJoin()/assetFilePath() 前缀校验，拒绝 ".." 与绝对路径穿越；
//   * 请求体有上限（全局 320 MB，各接口更小），超限直接断开连接，避免内存耗尽；
//   * 可选 MCP_TOKEN：设置后 /mcp、/api/mcp/* 需要 Bearer / x-mcp-token / ?token= 之一；
//   * LLM 密钥只存在于本进程与 llm.config.local.json，响应与错误日志都会被脱敏；
//   * 只能通过 Adobe 官方 sbsrender 真正烘焙，缺引擎时明确返回 SAT_MISSING 而非伪造结果。
//
// 与其他模块的关系：
//   assets.mjs / trash.mjs / usage.mjs / sbsar*.mjs / llm.mjs 提供各领域实现，本文件只负责
//   HTTP 路由、请求体解析、错误码映射与 MCP 网关调度；工具定义与参数校验来自 src/engine/mcp-catalog.js。
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

/**
 * 校验 MCP 请求的鉴权。
 * 未配置 MCP_TOKEN 时完全放行（本地开发默认）；配置后接受三种携带方式：
 * Authorization: Bearer <token>、x-mcp-token 头、URL 查询参数 ?token=（SSE 场景无法自定义头）。
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} [url] 已解析的请求 URL（SSE/GET 场景需要读查询参数）
 * @returns {boolean} 是否允许访问
 */
function mcpAuthorized(req, url) {
  if (!MCP_TOKEN) return true
  const header = String(req.headers.authorization || '')
  const token = String(req.headers['x-mcp-token'] || '')
  const queryToken = url ? String(url.searchParams.get('token') || '') : ''
  return header === 'Bearer ' + MCP_TOKEN || token === MCP_TOKEN || queryToken === MCP_TOKEN
}

/**
 * 统一的 401 响应：错误码 UNAUTHORIZED。
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function mcpUnauthorized(res) {
  return sendJSON(res, 401, {
    ok: false,
    apiVersion: API_VERSION,
    error: { code: ERROR_CODES.UNAUTHORIZED, message: 'Missing or invalid MCP token' }
  })
}

/**
 * 列出当前已连接的浏览器标签页，供 /api/mcp/tools 展示。
 * @returns {{id:string,busy:boolean,connectedAt:number}[]}
 */
function mcpClientInfo() {
  return [...mcpClients.entries()].map(([id, c]) => ({ id, busy: c.busy, connectedAt: c.connectedAt }))
}

/**
 * 调度器：把 mcpQueue 中的任务派发给空闲的浏览器标签页。
 * 每个标签页同一时刻只处理一个任务（busy 标志）；派发用 SSE 事件 `job`，内容为
 * { id, tool, arguments }。写失败时把任务放回队首并继续尝试下一个客户端。
 * 优先选择最新连接的标签页：刷新/关闭页面后旧 SSE 条目可能残留，旧页面也可能跑着过期代码。
 * @returns {void}
 */
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

/**
 * 结束一个 MCP 任务：清定时器、释放标签页 busy 状态、把结果交付给等待的 Promise，并继续调度。
 * @param {string} id 任务 id（形如 mcp_<base36 时间>_<序号>）
 * @param {object} envelope 归一化结果 { ok, data?, error?, meta? }
 * @returns {boolean} 该 id 是否存在（false 表示超时后迟到的结果，调用方应回 202）
 */
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
/**
 * 从工具定义里挑一个适合展示的调用示例（优先带参数的示例，get_thumbnail 首个示例为 {}）。
 * @param {object} tool mcp-catalog 中的工具条目
 * @returns {object|null} 示例参数对象
 */
function toolExample(tool) {
  const examples = Array.isArray(tool?.examples) ? tool.examples : []
  // Prefer an example that actually shows arguments (get_thumbnail's first example is {}).
  return examples.find((e) => e && typeof e === 'object' && Object.keys(e).length) || examples[0] || null
}

/**
 * 给工具错误补充 details.example / details.tool 与 hint，便于 MCP 客户端自我修正参数。
 * @param {unknown} error 原始错误对象或字符串
 * @param {object} tool 工具定义
 * @returns {object} 新错误对象（不修改入参）
 */
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

/**
 * 把一个工具调用规范化、校验、入队并等待浏览器执行结果。
 * 流程：查工具 → validateArguments（失败返回 INVALID_ARGUMENT 并附示例）→ 计算超时
 * → 建立 waiter 与定时器 → 入队并触发调度 → 无标签页时 2.5 秒后返回 APP_NOT_CONNECTED。
 * @param {string} name 工具名（如 substrate_add_node）
 * @param {object} [args] 参数对象
 * @param {number} [requestedTimeout] 调用方希望的超时（会被 toolTimeout 收敛到合法范围）
 * @returns {Promise<{apiVersion:string,ok:boolean,tool?:string,data?:any,error?:object,meta?:object}>}
 *          超时错误码 TIMEOUT；未知工具 UNKNOWN_TOOL；参数非法 INVALID_ARGUMENT；无页面 APP_NOT_CONNECTED
 */
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

/**
 * GET /api/mcp/events：浏览器端 SSE 长连接。
 * 打开时下发 `ready`（clientId / apiVersion / serverTime），之后每 20 秒发一次 `ping`；
 * 服务端通过此连接派发 `job` 事件。`close` 时清理心跳与客户端记录。
 * 注意：SSE 事件不是 JSON-RPC，仅内部使用；鉴权可用 ?token=。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {void}
 */
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

/**
 * POST /api/mcp/result：浏览器回传工具执行结果。
 * 请求体 { id, ok, data?, error?, durationMs?, clientId? }，上限 64 MB（缩略图/预览可能是大 base64）。
 * 响应：200 { ok:true, accepted:true }；id 已超时不在表里时 202 { ok:true, accepted:false }；
 * 请求体非法/JSON 解析失败 400（INVALID_ARGUMENT）；缺 id 400。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * POST /api/mcp/call：同步调用单个工具（mcp/server.mjs 与内部助手都走这里）。
 * 请求体 { name|tool, arguments|args, timeoutMs? }，上限 8 MB。
 * 响应恒为 200 的归一化 envelope；缺工具名返回 INVALID_ARGUMENT；请求体解析失败 400。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * 把内部 envelope 转成 MCP `tools/call` 的 result 结构：
 * { content:[{type:'text',text}], structuredContent, isError }。
 * @param {object} envelope dispatchMcpTool 的结果
 * @returns {object} MCP 工具结果
 */
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

/**
 * POST /mcp：MCP JSON-RPC 2.0 over HTTP（无状态，单次请求/响应）。
 * 支持 initialize、ping、tools/list、tools/call、resources/*、prompts/*；notifications/* 回 202 空体。
 * 错误码遵循 JSON-RPC：-32700 解析失败、-32600 非法请求、-32601 方法不存在、-32603 内部错误。
 * 请求体上限 8 MB，鉴权同 mcpAuthorized。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * 按扩展名查 MIME；未知扩展名回退 application/octet-stream。
 * @param {string} file 文件名或路径
 * @returns {string}
 */
function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/**
 * 把用户提供的相对路径拼到受控根目录下，并做路径穿越防护。
 * 先剥离开头的分隔符，再 path.resolve；若结果不在 base + sep 之下（且不等于 base）则判为非法。
 * @param {string} base 受控根目录（绝对路径）
 * @param {string} rel 用户输入（如 "exports/xxx/manifest.json" 的子路径）
 * @returns {string|null} 绝对路径；非法路径返回 null（调用方应回 400）
 */
function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.sep + String(rel || '').replace(/^[/\\]+/, ''))
  if (!target.startsWith(base + path.sep) && target !== base) return null
  return target
}

/**
 * 生成只含 ASCII 的文件名片段：去掉非法字符、空格转连字符、转小写。
 * 结果为空时用 fallback。
 * @param {string} name 原始名称
 * @param {string} [fallback='material']
 * @returns {string}
 */
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
/**
 * 生成稳定的 ASCII 文件名 slug。若原文被剥离了非 ASCII 字符，则追加 6 位 SHA-1 短哈希，
 * 避免「材质A」「材质B」都变成同一文件名而互相覆盖。
 * @param {string} name 原始名称
 * @param {string} [fallback='material']
 * @returns {string} 形如 material 或 material-3f2a1b
 */
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

/**
 * 生成导出目录用时间戳：YYYYMMDD-HHMMSS（本地时区）。
 * @returns {string}
 */
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 发送原始响应体，默认禁用缓存（no-store）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP 状态码
 * @param {string|Buffer} body 响应体
 * @param {Record<string,string>} [headers] 额外响应头（如 Content-Type）
 * @returns {void}
 */
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

/**
 * 发送 JSON 响应（自动序列化并设置 UTF-8 Content-Type）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} obj
 * @returns {void}
 */
function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

/**
 * 读取完整请求体，超出 limit 立即 reject 并销毁连接（防内存耗尽）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit=BODY_LIMIT] 字节上限（默认 320 MB）
 * @returns {Promise<Buffer>} 失败时 reject Error('Request body too large') 或底层错误
 */
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

/**
 * 计算 ZIP 所需的 CRC-32（IEEE 多项式，反射实现）。
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 无符号 32 位校验值
 */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 把 Date 转成 ZIP 头使用的 DOS 日期/时间（秒精度为 2 秒，年份基准 1980）。
 * @param {Date} [date=new Date()]
 * @returns {{time:number,day:number}} 16 位时间字与日期字
 */
function dosTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

/**
 * 在内存里拼出一个标准 ZIP 包（写入本地文件头 + 中央目录 + EOCD）。
 * 仅支持 deflate 与 store 两种方式，不写加密/zip64，足够导出材质包使用。
 * @param {{name:string,data:Buffer,compress?:boolean}[]} entries 条目列表；compress=false 时原样存储
 * @returns {Buffer} 完整 zip 字节
 */
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

/**
 * 记录「编辑器中当前打开」的材质名；该材质受删除保护（除非 force）。
 * @param {string} name 材质/工程显示名
 * @returns {string} 记录后的名称
 */
function setActiveProject(name) {
  activeProject = String(name || '')
  return activeProject
}

/**
 * 扫描 projects/ 下所有 *.json，返回按保存时间倒序的摘要列表。
 * 损坏的工程文件会被跳过（不影响其余条目）。
 * 缩略图由客户端保存时写入（`thumbnail`，192² JPEG data URL）；旧工程没有该字段时返回空串，
 * 由界面显示占位封面。
 * @returns {{name:string,file:string,savedAt:number,resolution:number,nodes:number,bytes:number,thumbnail:string,active:boolean}[]}
 */
function projectList() {
  const out = []
  for (const file of readdirSync(PROJECTS_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const full = path.join(PROJECTS_DIR, file)
      const data = JSON.parse(readFileSync(full, 'utf8'))
      const st = statSync(full)
      const displayName = data.name || file.replace(/\.json$/, '')
      // 只把合法的 data:image 字符串透传给前端，避免被塞入任意 URL/脚本
      const thumbnail =
        typeof data.thumbnail === 'string' && data.thumbnail.startsWith('data:image/') ? data.thumbnail : ''
      out.push({
        name: displayName,
        file,
        savedAt: data.savedAt || st.mtimeMs,
        resolution: data.resolution || 1024,
        nodes: data.graph?.nodes?.length || 0,
        bytes: st.size,
        thumbnail,
        active: !!activeProject && displayName === activeProject
      })
    } catch (e) {
      /* ignore broken project */
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * 找出某个工程对应的磁盘文件。
 * 优先使用客户端传来的 file 名（列表接口返回的精确文件名），做 safeJoin 防止路径穿越；
 * 没有或不匹配时按工程显示名扫描所有 *.json，返回第一个名字匹配的文件。
 * @param {string} file 列表接口返回的文件名（可空）
 * @param {string} name 工程显示名（可空）
 * @returns {string|null} 绝对路径；找不到返回 null
 */
function resolveProjectFile(file, name) {
  if (file && file.endsWith('.json')) {
    const full = safeJoin(PROJECTS_DIR, file)
    if (full && existsSync(full)) return full
  }
  if (!name) return null
  for (const entry of readdirSync(PROJECTS_DIR)) {
    if (!entry.endsWith('.json')) continue
    try {
      const full = path.join(PROJECTS_DIR, entry)
      const data = JSON.parse(readFileSync(full, 'utf8'))
      if ((data.name || entry.replace(/\.json$/, '')) === name) return full
    } catch (e) {
      /* 跳过损坏文件 */
    }
  }
  return null
}

/**
 * POST /api/projects/thumbnail：为已存在的工程补写封面缩略图。
 *
 * 由「打开材质」面板的静默生成流程调用：客户端用临时引擎渲染出封面后回写，
 * 服务端只负责校验与落盘，下次列表面板即可直接读取。
 * 请求体：{ name, file?, thumbnail }；thumbnail 必须是 data:image 前缀且 ≤ 300 KB。
 * 响应 200 { ok:true, file }；缩略图不合法 400 INVALID_THUMBNAIL；找不到工程 404 NOT_FOUND。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleProjectThumbnail(req, res) {
  readBody(req, 1024 * 1024)
    .then((buf) => {
      const data = JSON.parse(buf.toString('utf8') || '{}')
      const thumb = data.thumbnail
      if (typeof thumb !== 'string' || !thumb.startsWith('data:image/') || thumb.length > 300 * 1024) {
        return sendJSON(res, 400, {
          ok: false,
          error: { code: 'INVALID_THUMBNAIL', message: 'thumbnail must be a data:image URL under 300 KB' }
        })
      }
      const full = resolveProjectFile(data.file, data.name ? String(data.name).slice(0, 120) : '')
      if (!full) {
        return sendJSON(res, 404, {
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Project not found: ' + (data.file || data.name || '') }
        })
      }
      // 只改动 thumbnail 一个字段，其余内容（包括 savedAt）保持原样
      const project = JSON.parse(readFileSync(full, 'utf8'))
      project.thumbnail = thumb
      writeFileSync(full, JSON.stringify(project, null, 2), 'utf8')
      sendJSON(res, 200, { ok: true, file: path.basename(full) })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'THUMBNAIL_FAILED', message: String(e.message || e) } }))
}

/**
 * POST /api/projects/save：把工程 JSON 写入 projects/<slug>.json。
 * 请求体：工程对象，必须含 graph；name 截断到 120 字符；服务端补 savedAt。
 * 响应 200 { ok:true, file, name, path }；非法负载 400 { ok:false, error }。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleProjectSave(req, res) {
  readBody(req)
    .then((buf) => {
      const data = JSON.parse(buf.toString('utf8'))
      if (!data || !data.graph) throw new Error('Invalid project payload')
      const name = String(data.name || 'Untitled').slice(0, 120)
      const file = `${nameSlug(name, 'untitled')}.json`
      const payload = { ...data, name, savedAt: Date.now() }
      // 校验封面缩略图：只允许 data:image 前缀且不超过 300 KB 的字符串；
      // 不合法就删除该字段，避免把任意内容写进工程文件并被列表接口透传
      const thumb =
        typeof data.thumbnail === 'string' &&
        data.thumbnail.startsWith('data:image/') &&
        data.thumbnail.length <= 300 * 1024
          ? data.thumbnail
          : ''
      if (thumb) payload.thumbnail = thumb
      else delete payload.thumbnail
      writeFileSync(path.join(PROJECTS_DIR, file), JSON.stringify(payload, null, 2), 'utf8')
      sendJSON(res, 200, { ok: true, file, name, path: path.join('projects', file) })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: e.message }))
}

/**
 * GET /api/projects/load?name=：读取工程文件（支持显示名或已哈希的文件 slug）。
 * 先试 nameSlug，再回退 slugify；两处都找不到回 404；命中后把该材质设为 active（受删除保护）。
 * @param {import('node:http').ServerResponse} res
 * @param {string} name 工程显示名或文件名（不含 .json）
 * @returns {void}
 */
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
/**
 * POST /api/export：写出一次材质导出包。
 * 请求体 { materialName, files:[{path,data(base64)}], manifest?, readme? }。
 * 每个文件路径都会拒绝 ".."、绝对路径并通过 safeJoin 二次校验；目录名带时间戳且自动去重。
 * 输出 <dir>/manifest.json、README.md 与 <slug>.zip，并触发 pruneExports 保留最近 40 个包。
 * 响应 200 { ok, dir, url, zip, zipBytes, files }；非法负载 400。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * 列出 exports/ 下的导出目录（按目录 mtime 倒序），附带 manifest 与文件清单。
 * @returns {{dir:string,url:string,zip:string|null,mtime:number,manifest:object|null, files:string[]}[]}
 */
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

/**
 * 只保留最近 max 个导出目录，删除更早的（按目录 mtime 排序）。
 * 失败静默忽略：清理失败不应让导出请求失败。
 * @param {number} [max=40]
 * @returns {void}
 */
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

/**
 * 以流的方式返回一个磁盘文件；目录或不存在时回 404。
 * @param {import('node:http').ServerResponse} res
 * @param {string} file 绝对路径
 * @param {boolean} [download=false] 为 true 时加 Content-Disposition: attachment
 * @returns {void}
 */
function serveFile(res, file, download = false) {
  if (!existsSync(file) || statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' })
  }
  const headers = { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-cache' }
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

/**
 * 解析 /vendor/ 请求：白名单文件直接映射，addons/* 走 three/examples/jsm 并经 safeJoin 防护。
 * 未命中回 404 text/plain。
 * @param {import('node:http').ServerResponse} res
 * @param {string} rel /vendor/ 之后的相对路径
 * @returns {void}
 */
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

/**
 * 静态托管主流程：
 *   /vendor/…   → serveVendor（始终从 node_modules 取，源码与 dist 模式一致）
 *   /exports/…  → 导出包目录浏览、zip 下载（attachment）或单文件
 *   其他路径    → 相对 WWW 解析；命中文件即返回，否则回退 index.html（SPA 路由）
 * 路径非法（safeJoin 返回 null）回 400；不存在的文件回 404（SPA 回退除外）。
 * @param {import('node:http').ServerResponse} res
 * @param {string} urlPath 已解码的 pathname
 * @returns {void}
 */
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
/**
 * GET /api/llm/models：返回公开模型/供应商信息（只含 hasKey 布尔，绝不含密钥）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleLlmModels(req, res) {
  return sendJSON(res, 200, publicModels())
}

/**
 * POST /api/llm/providers：新增或更新供应商配置（写入 llm.config.local.json，权限 0600）。
 * 请求体 { id?, label?, baseUrl?, apiKey?, models? }，上限 1 MB。
 * 成功响应 200 { ok:true, ...publicModels() }；校验失败 400，错误码 LLM_CONFIG_ERROR。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleLlmProviderSave(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const result = upsertProvider(payload || {})
      return sendJSON(res, 200, { ok: true, ...result })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'LLM_CONFIG_ERROR', message: String(e.message || e) } }))
}

/**
 * POST /api/llm/providers/delete：删除供应商。请求体 { id }，上限 256 KB。
 * 缺 id 或找不到供应商均回 400，错误码 LLM_CONFIG_ERROR。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * POST /api/llm/chat：运行内置助手（OpenAI 兼容工具循环），工具执行复用 dispatchMcpTool，
 * 因此助手与外部 MCP 客户端拥有完全相同的操作能力。请求体上限 4 MB。
 * 响应 200 为 runAssistant 结果（ok/reply/toolCalls/reasoning/usage/vision/...）；
 * 解析失败 400，错误码 INVALID_ARGUMENT。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleLlmChat(req, res) {
  return readBody(req, 4 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return runAssistant((name, args) => dispatchMcpTool(name, args), payload).then((result) => sendJSON(res, 200, result))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: String(e.message || e) } }))
}

/**
 * POST /api/llm/test：向指定模型发一条最短请求验证连通性。请求体 { modelKey|model }，上限 256 KB。
 * 响应 200 为 testModel 结果（ok/reply/durationMs 或 error）；解析失败 400 INVALID_ARGUMENT。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleLlmTest(req, res) {
  return readBody(req, 256 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return testModel(payload.modelKey || payload.model).then((result) => sendJSON(res, 200, result))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'INVALID_ARGUMENT', message: String(e.message || e) } }))
}

/**
 * GET /api/assets：列出素材库（隐藏回收站条目），并为每条附上 usage（被哪些工程/回收站材质引用）。
 * usage 扫描失败时降级为空 Map，不影响列表本身。
 * 响应 200 { ok:true, assets:[{...publicAsset, usage}], dir:'assets/' }。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * POST /api/assets/import：导入一张位图。请求体 { name, dataUrl|data }（PNG/JPEG/WebP 的 data URL），
 * 上限 40 MB（解码后单图上限 32 MB，由 assets.mjs 校验签名与大小）。
 * 响应 200 { ok:true, asset }；失败 400，错误码 ASSET_IMPORT_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleAssetImport(req, res) {
  return readBody(req, 40 * 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      const asset = importAsset({ name: payload.name, dataUrl: payload.dataUrl || payload.data })
      return sendJSON(res, 200, { ok: true, asset })
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'ASSET_IMPORT_FAILED', message: String(e.message || e) } }))
}

/**
 * POST /api/assets/import-sbsar：导入 .sbsar 归档（保留原文件、抽取内嵌位图、缓存检查报告）。
 * 请求体 { name, data|dataUrl }（data URL 或裸 base64），上限 90 MB（解码后上限 64 MB）。
 * 响应 200 { ok:true, asset, inspection }；失败 400，错误码 SBSAR_IMPORT_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * GET /api/assets/sbsar?id=：返回归档的完整检查报告（缓存文件优先，缺失时回退索引摘要）。
 * 缺 id 或读取失败回 400，错误码 SBSAR_INSPECT_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {void}
 */
function handleAssetSbsarInspect(req, res, url) {
  try {
    const id = url.searchParams.get('id')
    if (!id) throw new Error('Missing asset id')
    return sendJSON(res, 200, { ok: true, inspection: readSbsarInspection(String(id)) })
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: { code: 'SBSAR_INSPECT_FAILED', message: String(e.message || e) } })
  }
}

/**
 * GET /api/trash：回收站总览。
 * 对每个已删除工程额外计算 boundAssets（其节点图仍引用的素材数——绑定在进回收站后依然生效）。
 * 响应 200 { ok:true, projects, assets, projectBytes }。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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
/**
 * POST /api/trash/restore：还原一项。请求体 { id, kind? }（kind='asset' 走素材库，否则按工程）。
 * 响应 200 { ok:true, restored }；未知 id 404（NOT_FOUND），参数缺失/失败 400（INVALID_ARGUMENT/RESTORE_FAILED）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * POST /api/trash/purge：永久删除一项（唯一真正 unlink 字节的路径）。
 * 请求体 { id, kind? }；响应 200 { ok:true, purged }；未知 id 404，其他失败 400（PURGE_FAILED）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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
/**
 * POST /api/trash/empty：清空回收站（所有工程文件与所有软删除素材）。
 * 逐个删除并统计成功数量；响应 200 { ok:true, purged:{projects,assets} }，异常 500 EMPTY_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * GET /api/sbsar/bake/status：报告本机是否可用 Adobe SAT（sbsrender），以及 Player 探测结果。
 * 响应 200 { ok:true, ...bakeStatus() }（available/sbsrender/source/player/platform/installUrl/reason）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleSbsarBakeStatus(req, res) {
  return sendJSON(res, 200, { ok: true, ...bakeStatus() })
}

/**
 * Bake a stored .sbsar through the locally installed Adobe engine (SAT) and import the resulting maps
 * into the asset library. Nothing is emulated: if the engine is absent this returns SAT_MISSING with
 * install guidance instead of pretending to bake.
 */
/**
 * POST /api/sbsar/bake：调用本机 sbsrender 烘焙归档，并把产出的 PNG 逐张导入素材库。
 * 请求体 { assetId, res?(256..4096，默认 2048), graph?, params? }，上限 1 MB。
 * 参数覆盖会先用归档解析出的 parameters 做校验，非法值跳过而非报错。
 * 响应 200 { ok:true, resolution, assets, log, applied, skipped }；
 *   SAT 缺失 503（错误码 SAT_MISSING，附 install.url）；素材/文件不存在 404（NOT_FOUND）；其他 500（BAKE_FAILED）。
 * 烘焙用的临时目录在 finally 中清理，避免残留。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
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

/**
 * GET /api/assets/search?q=&limit=：在线图库搜索（limit 收敛到 1..24，默认 12）。
 * 响应 200 为 searchAssets 结果（可能带 fallback 标记）；失败 400（ASSET_SEARCH_FAILED）。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @returns {void}
 */
function handleAssetSearch(req, res, url) {
  return searchAssets(url.searchParams.get('q') || '', Math.min(24, Math.max(1, Number(url.searchParams.get('limit')) || 12)))
    .then((result) => sendJSON(res, 200, result))
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: e.code || 'ASSET_SEARCH_FAILED', message: String(e.message || e) } }))
}

/**
 * POST /api/assets/import-url：从公网 URL 下载图片并入库（含 SSRF 防护：仅 http(s)、禁止内网/回环
 * 主机，重定向后的最终地址会二次校验）。请求体 { url|downloadUrl, name?, provider?, creator?,
 * license?, licenseUrl?, sourceUrl? }，上限 1 MB。
 * 响应 200 { ok:true, asset }；失败 400，错误码 ASSET_IMPORT_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleAssetImportUrl(req, res) {
  return readBody(req, 1024 * 1024)
    .then((buf) => {
      const payload = JSON.parse(buf.toString('utf8') || '{}')
      return importAssetFromUrl(payload).then((asset) => sendJSON(res, 200, { ok: true, asset }))
    })
    .catch((e) => sendJSON(res, 400, { ok: false, error: { code: 'ASSET_IMPORT_FAILED', message: String(e.message || e) } }))
}

/**
 * POST /api/assets/delete：把素材移入回收站（软删除，文件仍留在磁盘）。
 * 请求体 { id, force? }，上限 256 KB。
 * 若素材仍被工程（含回收站中的工程）引用且未 force，返回 409 ASSET_IN_USE 并附 usage 明细；
 * 成功 200 { ok:true, ...trashAsset(id), usedBy }；失败 400 ASSET_DELETE_FAILED。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
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

/**
 * GET /api/mcp/selfcheck：自检报告，用于排查 MCP 集成问题。
 * 检查项：工具目录（apiVersion/数量/重名/schema/命名规范）、参数校验是否真的拒绝缺参、
 * 未知工具是否被拒、是否有标签页连接，以及一次真实的 get_state 往返。
 * @returns {Promise<{ok:boolean,apiVersion:string,generatedAt:string,checks:{name:string,ok:boolean,info:string}[],totals:{passed:number,failed:number},bridge:{connectedClients:number},auth:string}>}
 */
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

// 路由总入口：先解析 URL 与 pathname，再按「精确 /api/* 接口 → /mcp → /assets/* → 静态资源」顺序匹配。
// 未匹配的 /api/* 统一回 404 JSON；非 GET/HEAD 的静态请求回 405；其余交给 serveApp（含 SPA 回退）。
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
  if (p === '/api/projects/thumbnail' && method === 'POST') return handleProjectThumbnail(req, res)
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

// 只监听回环地址：本服务无鉴权即可写本地文件，绝不能暴露到局域网/公网。
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[substrate] http://127.0.0.1:${PORT}  (${USE_DIST ? 'dist' : 'source'}, node ${process.version})`)
  console.log('[mcp] gateway ready — POST /mcp (JSON-RPC) · POST /api/mcp/call · GET /api/mcp/tools · GET /api/mcp/selfcheck')
  const models = publicModels()
  console.log('[llm] ' + models.models.length + ' model(s) configured' + (models.models.some((m) => m.hasKey) ? '' : ' — no API key yet (set DEEPSEEK_API_KEY or add a provider in the AI panel)'))
})
