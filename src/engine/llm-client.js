/**
 * 服务端 LLM 网关的浏览器端客户端。
 *
 * 架构位置：前端 UI 只与本模块交互，由 Node 服务端（server/index.js）真正持有 API Key；
 * 因此本模块永远拿不到、也不会传递密钥，服务端只下发模型/提供商元数据与 hasKey 标记。
 *
 * 所有请求都走同一条 /api 约定：成功时返回 { ok: true, ...payload }，
 * 失败时返回 { ok: false, error: { code, message } }（由服务端统一封装）。
 */

/**
 * 向服务端发起一次 JSON 请求并解析响应。
 *
 * 设计取舍：即使 HTTP 状态码不是 2xx 也不在此抛错，而是把响应体原样返回，
 * 让上层根据 body.ok / body.error 判断业务成功与否（业务错误统一放在响应体里）。
 * 只有响应体不是合法 JSON 时才抛出异常。
 *
 * @param {string} path 接口路径，例如 /api/llm/models
 * @param {RequestInit} [opts] 额外的 fetch 配置；headers 会被默认 JSON 头覆盖/合并
 * @returns {Promise<any>} 解析后的响应体（空响应为 null）
 * @throws {Error} 响应体不是合法 JSON 时抛出
 */
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

/**
 * 读取可用模型列表（含提供商信息与 hasKey 标记）。
 *
 * @returns {Promise<object>} 服务端返回的完整模型数据（保证 ok 为真）
 * @throws {Error} 请求失败或服务端返回 ok:false 时抛出
 */
export async function fetchModels() {
  const data = await request('/api/llm/models')
  if (!data || !data.ok) throw new Error(data?.error?.message || 'Failed to load models')
  return data
}

/**
 * 发起一次带工具调用的助手对话。
 *
 * 由服务端负责组装提示词、执行工具循环（最多 maxSteps 步）并返回最终回复。
 *
 * @param {object} params
 * @param {string} params.modelKey 选中的模型键（provider:model 形式）
 * @param {Array<object>} params.messages 对话历史（已裁剪，含 role/content/attachments）
 * @param {number} [params.maxSteps=20] 工具调用循环的最大步数，防止无限自调用
 * @param {boolean} [params.showThinking=true] 是否要求/返回思考过程
 * @returns {Promise<object>} 服务端响应体，通常含 ok、reply、toolCalls、reasoning、model
 */
export async function chatWithAssistant({ modelKey, messages, maxSteps = 20, showThinking = true }) {
  return request('/api/llm/chat', {
    method: 'POST',
    body: JSON.stringify({ modelKey, messages, maxSteps, showThinking })
  })
}

/**
 * 新增或更新一个模型提供商配置（API Key 只提交给服务端保存，不会回传到前端）。
 *
 * @param {object} provider 提供商配置（名称、baseUrl、模型列表、密钥等）
 * @returns {Promise<object>} 服务端响应体
 */
export async function saveProvider(provider) {
  return request('/api/llm/providers', { method: 'POST', body: JSON.stringify(provider) })
}

/**
 * 删除指定提供商配置。
 *
 * @param {string} id 提供商 id
 * @returns {Promise<object>} 服务端响应体
 */
export async function deleteProvider(id) {
  return request('/api/llm/providers/delete', { method: 'POST', body: JSON.stringify({ id }) })
}

/**
 * 对指定模型做一次连通性/可用性测试（例如发一个极小的探针请求）。
 *
 * @param {string} modelKey 模型键
 * @returns {Promise<object>} 服务端响应体，一般含 ok / latency / message
 */
export async function testProviderModel(modelKey) {
  return request('/api/llm/test', { method: 'POST', body: JSON.stringify({ modelKey }) })
}

/**
 * 获取服务端 MCP 网关的自检结果（目录结构、鉴权、桥接连接、真实往返调用）。
 *
 * @returns {Promise<object>} 自检报告，含 ok、checks、totals 等字段
 */
export async function fetchMcpSelfcheck() {
  return request('/api/mcp/selfcheck')
}

/**
 * 获取 AI 助手的系统规则文本（用于前端展示与 UI 自检断言）。
 *
 * @returns {Promise<object>} 响应体，含 ok 与 rules 数组
 */
export async function fetchAiRules() {
  return request('/api/llm/rules')
}
