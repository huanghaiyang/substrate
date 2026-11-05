#!/usr/bin/env node
// Substrate MCP 服务（stdio 传输）。
//
// 零依赖的 Model Context Protocol 服务，把 Substrate Texture Studio 暴露为标准化工具。
// 它本身不碰 WebGL，只做「stdio JSON-RPC ↔ 本地工作室 HTTP 桥」的翻译：
//   GET  /api/mcp/tools   → 工具目录（名称/描述/JSON Schema/示例，前端 catalog 的镜像）
//   POST /api/mcp/call    → 在已连接的浏览器标签页里执行一个工具，阻塞等待结果
// 真正的绘制/求值发生在页面（WebGL）里，因此必须保持工作室与至少一个浏览器标签页打开。
//
// 工具注册流程：
//   1. 工具定义唯一来源是 src/engine/mcp-catalog.js（服务端 /api/mcp/tools 也由它生成）；
//   2. 本进程首次 tools/list 时拉取一次目录并缓存（catalogCache），之后不再重复请求；
//      因此新增工具需要重启本进程（工具集合在会话生命周期内视为静态）；
//   3. initialize 声明 capabilities.tools.listChanged=false，与「缓存不刷新」的行为一致。
//
// 生命周期：
//   * 由 MCP 客户端以子进程方式启动（node mcp/server.mjs），stdin 逐行读取 JSON-RPC；
//   * 支持单条或批量请求；通知类（notifications/*）不产生响应；
//   * stdin 关闭 / SIGTERM / SIGINT → process.exit(0)；
//   * 作为模块被测试导入时不会自动启动（见文件末尾的 argv 判断）。
//
// 环境变量：SUBSTRATE_URL（默认 http://127.0.0.1:3000）、SUBSTRATE_MCP_TOKEN（可选 Bearer 令牌）。
// 安全边界：令牌只存在本进程内存，作为 Authorization 头发给本机工作室；日志写 stderr，绝不污染 stdout
// （stdout 是 JSON-RPC 通道，任何多余输出都会让客户端解析失败）。
import readline from 'node:readline'
import { API_VERSION, PROTOCOL_VERSION, ERROR_CODES } from '../src/engine/mcp-catalog.js'

const BASE_URL = (process.env.SUBSTRATE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const TOKEN = String(process.env.SUBSTRATE_MCP_TOKEN || '')
const SERVER_INFO = { name: 'substrate-texture-designer', title: 'Substrate Texture Studio', version: API_VERSION }

/**
 * 写 stderr 日志（stdout 专用于 JSON-RPC，绝不能混入日志）。
 * @param {...unknown} args
 * @returns {void}
 */
function log(...args) {
  console.error('[substrate-mcp]', ...args)
}

/**
 * 构造请求头：始终 JSON；配置了令牌时附加 Bearer 鉴权。
 * @returns {Record<string,string>}
 */
function headers() {
  const h = { 'Content-Type': 'application/json' }
  if (TOKEN) h.Authorization = 'Bearer ' + TOKEN
  return h
}

/**
 * 向本地工作室发起 HTTP 请求并解析 JSON。
 * 非 2xx 时抛带 code 的 Error（code 取自服务端 error.code，缺省 HTTP_<status>）；
 * 响应不是合法 JSON 时抛错并附前 200 字符，便于定位（例如把 HTML 页面当成 API）。
 * @param {string} path 以 / 开头的路径
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 * @throws {Error} 网络错误 / 非 JSON / 非 2xx
 */
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

// 工具目录缓存：整个进程生命周期只拉取一次。工具集合变化（升级/新增工具）需重启 MCP 进程。
let catalogCache = null
/**
 * 获取工具目录（带进程内缓存）。
 * @returns {Promise<{tools:object[]}>}
 */
async function loadCatalog() {
  if (catalogCache) return catalogCache
  catalogCache = await fetchJSON('/api/mcp/tools')
  return catalogCache
}

/**
 * 把工作室 envelope 转成 MCP tools/call 的 result：
 * 成功 → isError:false，structuredContent 为 data；失败 → isError:true，structuredContent 为 { error }。
 * 同时提供 JSON 文本 content，兼容只读文本的客户端。
 * @param {object} envelope { ok, tool, data?, error?, meta? }
 * @returns {{content:object[],structuredContent:object,isError:boolean}}
 */
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

/**
 * 调用一个工具：POST /api/mcp/call，失败时归一化为 envelope（不让异常冒泡到 JSON-RPC 层）。
 * @param {string} name 工具名
 * @param {object} [args] 参数
 * @returns {Promise<object>} { ok, tool, data?, error?, meta? }
 */
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

/**
 * 处理一条 JSON-RPC 消息（单条或批量中的一项）。
 * 支持 initialize / ping / tools/list / tools/call / resources/list / resources/templates/list /
 * prompts/list / logging/setLevel；其余方法返回 -32601。
 * notifications/* 返回 null（不回应）；无 method 返回 -32600；内部异常返回 -32603。
 * @param {object} msg JSON-RPC 请求
 * @returns {Promise<object|null>} 响应对象；通知返回 null
 */
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

/**
 * 向 stdout 写一行 JSON-RPC 响应（NDJSON 协议）。
 * @param {object|object[]} obj
 * @returns {void}
 */
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export { handleMessage, callTool, loadCatalog, fetchJSON, SERVER_INFO, BASE_URL }

/**
 * 启动 stdio 主循环：逐行读取 stdin 的 JSON-RPC。
 * 单条消息直接处理；数组按批量处理（按顺序 await，只回非 null 响应）；
 * 解析失败回 -32700 Parse error。stdin 关闭或收到 SIGTERM/SIGINT 时退出进程。
 * @returns {void}
 */
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

// 只在「作为脚本直接执行」时启动 stdio 循环；被测试 import 时不应占用 stdin/进程生命周期。
// 兼容 Windows 反斜杠路径：先统一成 / 再判断后缀。
// only start the STDIO loop when executed directly (not when imported by the test suite)
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('mcp/server.mjs')) {
  startStdio()
}
