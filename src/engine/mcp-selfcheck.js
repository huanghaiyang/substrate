// MCP self-check: verifies the external tool interface both in the browser (catalog vs handler
// registry, validation, safe read tools, normalized envelopes) and on the Node gateway
// (/api/mcp/selfcheck: catalog shape, auth, bridge presence, live round-trip).
import { TOOLS, getTool, validateArguments, ERROR_CODES, API_VERSION } from './mcp-catalog.js'
import { HANDLER_NAMES, executeTool } from './mcp-commands.js'
import { fetchMcpSelfcheck } from './llm-client.js'

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

export async function runMcpSelfCheck() {
  const r = makeReport()
  const names = TOOLS.map((t) => t.name)
  r.add('catalog: tools present', TOOLS.length > 0, String(TOOLS.length))
  r.add('catalog: names unique', new Set(names).size === names.length, names.join(','))
  r.add('catalog: names normalized', names.every((n) => /^substrate_[a-z0-9_]+$/.test(n)), 'bad name')
  r.add('catalog: schemas present', TOOLS.every((t) => t.inputSchema && t.description), 'missing schema/description')
  r.add('catalog: every catalog tool has a handler', names.every((n) => HANDLER_NAMES.includes(n)), names.filter((n) => !HANDLER_NAMES.includes(n)).join(','))
  r.add('catalog: every handler is catalogued', HANDLER_NAMES.every((n) => !!getTool(n)), HANDLER_NAMES.filter((n) => !getTool(n)).join(','))

  let invalidOk = false
  try {
    validateArguments('substrate_add_node', {})
  } catch (e) {
    invalidOk = e.code === ERROR_CODES.INVALID_ARGUMENT
  }
  r.add('validation: rejects missing required arguments', invalidOk, 'validation did not throw INVALID_ARGUMENT')
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

  r.add('bridge: window.__MCP__ present', !!window.__MCP__, 'MCP bridge not started')
  r.add('bridge: connected to gateway', !!window.__MCP__?.connected, 'bridge not connected')

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
  try {
    await executeTool('substrate_load_demo', { id: '__invalid__' })
    r.add('errors: invalid arguments rejected', false, 'invalid demo id was accepted')
  } catch (e) {
    r.add('errors: invalid arguments rejected', e?.code === ERROR_CODES.INVALID_ARGUMENT, e?.code + ' ' + e?.message)
  }

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
