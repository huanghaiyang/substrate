/**
 * MCP 自检（浏览器侧）。
 *
 * 检查两个层面：
 * - 页面内：目录与处理器注册表是否双向一致、参数校验是否真的生效、只读工具能否正常返回；
 * - Node 网关：/api/mcp/selfcheck 是否可达、其自身检查是否通过（目录形状、鉴权、桥接、真实往返）。
 *
 * 架构位置：作为 /api/mcp/selfcheck 的互补，覆盖“页面执行侧”的不变量；
 * 结果结构统一为 { ok, apiVersion, generatedAt, checks, totals }，便于 UI 直接渲染。
 */
import { TOOLS, getTool, validateArguments, ERROR_CODES, API_VERSION } from './mcp-catalog.js'
import { HANDLER_NAMES, executeTool } from './mcp-commands.js'
import { fetchMcpSelfcheck } from './llm-client.js'

/**
 * 构造一个报告收集器。
 *
 * add() 只保存“是否通过 + 失败时的说明”，成功项的 info 统一置空，避免输出里塞满无意义信息；
 * result() 自动统计通过/失败数量算出总 ok，并附带生成时间与 API 版本。
 *
 * @returns {{checks: Array<object>, add: Function, result: Function}}
 */
function makeReport() {
  const checks = []
  return {
    checks,
    add(name, ok, info = '') {
      checks.push({ name, ok: !!ok, info: ok ? '' : String(info) })
    },
    result(extra = {}) {
      const failed = checks.filter((c) => !c.ok).length
      return {
        ok: failed === 0,
        apiVersion: API_VERSION,
        generatedAt: new Date().toISOString(),
        checks,
        totals: { passed: checks.length - failed, failed },
        ...extra
      }
    }
  }
}

/**
 * 运行整套浏览器端 MCP 自检。
 *
 * 检查项依次为：目录存在性/唯一性/命名规范/schema 完整性、目录与处理器双向一致、
 * 参数校验的三类否定用例、桥接状态、四个只读工具的真实执行、无效参数是否被拒绝，
 * 最后通过网络请求合并 Node 网关的自检结果。
 *
 * 注意：本函数会真实执行 substrate_evaluate 等只读工具，对当前图做一次求值（有副作用但无破坏性）；
 * 不会修改用户的图结构。网关不可达不会抛错，只会记为一项失败。
 *
 * @returns {Promise<object>} 报告对象 { ok, apiVersion, generatedAt, checks, totals, bridge? }
 */
export async function runMcpSelfCheck() {
  const r = makeReport()
  const names = TOOLS.map((t) => t.name)
  r.add('catalog: tools present', TOOLS.length > 0, String(TOOLS.length))
  r.add('catalog: names unique', new Set(names).size === names.length, names.join(','))
  r.add('catalog: names normalized', names.every((n) => /^substrate_[a-z0-9_]+$/.test(n)), 'bad name')
  r.add('catalog: schemas present', TOOLS.every((t) => t.inputSchema && t.description), 'missing schema/description')
  r.add('catalog: every catalog tool has a handler', names.every((n) => HANDLER_NAMES.includes(n)), names.filter((n) => !HANDLER_NAMES.includes(n)).join(','))
  r.add('catalog: every handler is catalogued', HANDLER_NAMES.every((n) => !!getTool(n)), HANDLER_NAMES.filter((n) => !getTool(n)).join(','))

  // 负向用例：缺少必填参数时应抛 INVALID_ARGUMENT，而不是静默通过
  let invalidOk = false
  try {
    validateArguments('substrate_add_node', {})
  } catch (e) {
    invalidOk = e.code === ERROR_CODES.INVALID_ARGUMENT
  }
  r.add('validation: rejects missing required arguments', invalidOk, 'validation did not throw INVALID_ARGUMENT')
  // 负向用例：未知工具名应抛 UNKNOWN_TOOL
  let unknownOk = false
  try {
    validateArguments('substrate_not_a_tool', {})
  } catch (e) {
    unknownOk = e.code === ERROR_CODES.UNKNOWN_TOOL
  }
  r.add('validation: unknown tool rejected', unknownOk, 'unknown tool was not rejected')
  r.add('validation: enum/range rejected', (() => {
    try {
      validateArguments('substrate_set_resolution', { resolution: 999 })
      return false
    } catch (e) {
      return e.code === ERROR_CODES.INVALID_ARGUMENT
    }
  })(), 'invalid enum accepted')

  // 桥接状态只做“存在性”报告：未启动时说明原因，避免误判为执行侧失败
  r.add('bridge: window.__MCP__ present', !!window.__MCP__, 'MCP bridge not started')
  r.add('bridge: connected to gateway', !!window.__MCP__?.connected, 'bridge not connected')

  // 只选只读工具做真实执行：不会改动图结构，可安全地作为“执行链路是否通畅”的证据
  const safeTools = [
    ['substrate_get_state', {}],
    ['substrate_get_graph', {}],
    ['substrate_list_demos', {}],
    ['substrate_evaluate', {}]
  ]
  for (const [name, args] of safeTools) {
    try {
      const data = await executeTool(name, args)
      r.add('tool: ' + name, data && typeof data === 'object', 'empty result')
    } catch (e) {
      r.add('tool: ' + name, false, e?.message || String(e))
    }
  }
  // 故意传入不存在的示例 id，验证执行前的参数校验能拦住非法枚举值
  try {
    await executeTool('substrate_load_demo', { id: '__invalid__' })
    r.add('errors: invalid arguments rejected', false, 'invalid demo id was accepted')
  } catch (e) {
    r.add('errors: invalid arguments rejected', e?.code === ERROR_CODES.INVALID_ARGUMENT, e?.code + ' ' + e?.message)
  }

  // 合并 Node 网关自检结果；请求失败不抛出，只把“可达性”记为失败并返回已有结果
  try {
    const server = await fetchMcpSelfcheck()
    r.add('gateway: /api/mcp/selfcheck reachable', !!server && typeof server.ok === 'boolean', 'no response')
    r.add('gateway: selfcheck passed', server?.ok === true, JSON.stringify(server?.totals || server))
    for (const c of server?.checks || []) r.add('gateway: ' + c.name, c.ok, c.info)
    return r.result({ bridge: server?.bridge || null })
  } catch (e) {
    r.add('gateway: /api/mcp/selfcheck reachable', false, e?.message || String(e))
    return r.result()
  }
}
