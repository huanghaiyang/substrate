/**
 * 浏览器 ⇄ Node MCP 网关桥接。
 *
 * 架构位置：外部 MCP 客户端（stdio server 或 HTTP JSON-RPC）把工具调用排入 Node 服务端队列，
 * 服务端再通过 SSE（/api/mcp/events）把任务推给浏览器页面；页面用统一的工具处理器执行后，
 * 把规范化结果 POST 回 /api/mcp/result。这样外部客户端无需直接访问 GPU 引擎，
 * 由页面负责真正的贴图计算。
 *
 * 页面与网关始终保持一条 SSE 长连接，断线后自动重连（可凭 clientId 续传）。
 *
 * 主要导出：startMcpBridge（启动桥接并暴露 window.__MCP__）、stopMcpBridge（停止并断开）。
 */
import { executeTool } from './mcp-commands.js'
import { API_VERSION } from './mcp-catalog.js'

// source：当前 SSE 连接；clientId：服务端分配/续传用的客户端标识
// queue：用于把任务串行化的 Promise 链（GPU 引擎不允许多个求值并发）
// reconnectTimer：断线重连定时器；closed：用户/页面已主动关闭，禁止再重连
let source = null
let clientId = ''
let queue = Promise.resolve()
let reconnectTimer = null
let closed = false

/**
 * 把工具执行结果回传给服务端。
 *
 * 注意：这里刻意吞掉网络错误，只打印警告——网关侧有超时兜底，
 * 页面不应因为一次回传失败而阻断后续任务。
 *
 * @param {object} payload 规范化结果信封 { id, ok, data | error, durationMs }
 * @returns {Promise<void>}
 */
function postResult(payload) {
  return fetch('/api/mcp/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch((e) => console.warn('[mcp] result post failed', e))
}

/**
 * 执行单个 MCP 任务并以统一信封回传结果。
 *
 * 无论成功或失败都补齐 durationMs，失败时把错误规范化为 { code, message, details }，
 * 以便网关与外部客户端按同一套 ERROR_CODES 处理。执行过程中的异常不会向上抛出。
 *
 * @param {{id:string, tool:string, arguments?:object}} job 服务端下发的任务
 * @returns {Promise<void>}
 */
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
  // 记录最近一次任务/错误，供页面内自检与调试面板读取
  if (window.__MCP__) {
    window.__MCP__.lastJob = { id: job.id, tool: job.tool, ok: payload.ok, durationMs: payload.durationMs, at: Date.now() }
    window.__MCP__.lastError = payload.ok ? '' : payload.error.message
  }
  await postResult(payload)
}

/**
 * 把任务追加到串行队列。
 *
 * 通过 Promise 链保证同一时刻只有一个任务在执行：GPU 资源与全局 store 都不是并发安全的，
 * 并行求值会互相覆盖渲染目标。链上任何失败都会被 catch 掉，避免污染后续任务。
 *
 * @param {object} job 任务对象
 * @returns {Promise} 队列尾部 Promise
 */
function enqueueJob(job) {
  queue = queue
    .then(() => runJob(job))
    .catch((e) => console.warn('[mcp] job failed', e))
  return queue
}

/**
 * 建立（或在断线后重建）SSE 连接并注册事件处理器。
 *
 * 连接参数：
 * - v：接口版本，服务端据此拒绝不兼容的客户端；
 * - resume：已有 clientId 时用于续传，避免重连期间排队任务丢失；
 * - token：可选的共享令牌（EventSource 无法自定义请求头，只能走查询参数）。
 *
 * 事件：ready（拿到 clientId）、job（待执行任务）、ping（心跳）；onerror 时关闭旧连接并延后重连。
 */
function connect() {
  if (closed) return
  const params = new URLSearchParams({ v: API_VERSION })
  if (clientId) params.set('resume', clientId)
  // 可选共享令牌：适用于启用了 MCP_TOKEN 的部署（EventSource 不支持自定义请求头）
  try {
    const token = localStorage.getItem('substrate.mcpToken')
    if (token) params.set('token', token)
  } catch (e) {
    /* 存储可能不可用 */
  }
  source = new EventSource('/api/mcp/events?' + params.toString())

  // ready：服务端分配（或续传）clientId，并回显服务器时间
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

  // job：丢弃结构不完整的任务（必须同时具备 id 与 tool），其余进入串行队列
  source.addEventListener('job', (event) => {
    try {
      const job = JSON.parse(event.data)
      if (!job || !job.id || !job.tool) return
      enqueueJob(job)
    } catch (e) {
      console.warn('[mcp] malformed job', e)
    }
  })

  // ping：仅刷新心跳时间，用于自检判断连接是否还活着
  source.addEventListener('ping', () => {
    if (window.__MCP__) window.__MCP__.lastPing = Date.now()
  })

  // onerror：断开旧连接，1.5 秒后重试；若已被主动关闭则不再重连
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

/**
 * 启动 MCP 桥接（幂等：重复调用直接返回已有实例）。
 *
 * 跳过条件：运行环境没有 EventSource（如部分 SSR/测试环境），或 URL 显式带 `?mcp=off`。
 * 启动后会把状态挂在 window.__MCP__ 上，供页面自检、调试面板与 UI 自检脚本读取。
 *
 * @param {object} [opts] 预留参数（当前未使用）
 * @returns {object|null} window.__MCP__ 状态对象；未启动时返回 null
 */
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
  // 页面卸载时置位 closed 并关闭连接，避免浏览器关闭过程里触发重连
  window.addEventListener('beforeunload', () => {
    closed = true
    if (source) source.close()
  })
  return window.__MCP__
}

/** 停止桥接：标记已关闭、清理重连计时器并断开 SSE，window.__MCP__ 保留但标记为未连接。 */
export function stopMcpBridge() {
  closed = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (source) source.close()
  source = null
  if (window.__MCP__) window.__MCP__.connected = false
}
