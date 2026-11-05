#!/usr/bin/env node
/**
 * Substrate MCP 集成的端到端测试。
 *
 * 前提条件：Substrate 服务器（npm start）已运行，并且有一个打开了设计器的浏览器标签页，
 * 这样 MCP 网关才能在 WebGL 应用里执行工具。
 *
 * 覆盖范围：HTTP 健康检查与工具目录、stdio 传输的 JSON-RPC 逻辑、各类工具的调用与错误归一化、
 * HTTP 传输、自检端点、LLM 网关（密钥遮蔽）、在线素材搜索与 SSRF 防护、素材库 CRUD。
 *
 * 运行：npm run test:mcp
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { handleMessage } from '../mcp/server.mjs'
import { sanitizeToolSequence } from '../server/llm.mjs'

// 被测服务器地址（去掉末尾斜杠，方便拼接路径）
const BASE = (process.env.SUBSTRATE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const results = []
let failed = 0
let skipped = 0
/** 记录一条断言；失败时打印原因并累加失败计数。 */
function check(name, pass, info = '') {
  results.push({ name, pass: !!pass, info: pass ? '' : String(info) })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ' — ' + info}`)
}
/** 记录一条「跳过」的用例；跳过不算失败（例如缺少可选环境变量或沙箱禁止子进程）。 */
function skip(name, reason) {
  skipped++
  results.push({ name, pass: true, skip: true })
  console.log(`SKIP  ${name} — ${reason}`)
}

/**
 * 发送 JSON 请求并解析响应。
 * 响应不是合法 JSON 时抛错（测试中这本身就说明服务端行为异常）。
 * @returns {Promise<{status: number, body: any}>}
 */
async function httpJSON(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch (e) {
    throw new Error(`Invalid JSON from ${pathname}: ${text.slice(0, 200)}`)
  }
  return { status: res.status, body }
}

// 直接导入 stdio 服务端逻辑：开发沙箱禁止 child_process.spawn，
// 但 handleMessage() 正是 stdio 传输层实际调用的函数，所以可以直接在进程内测试。
let seq = 0
const request = (method, params) => handleMessage({ jsonrpc: '2.0', id: ++seq, method, params })
/** 从 tools/call 的返回中取出第一段文本并解析为 JSON；失败返回 null。 */
const toolText = (result) => {
  const text = result?.result?.content?.[0]?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

/**
 * 真实 stdio 帧格式的冒烟测试（仅在允许创建子进程时执行）：
 * 启动 mcp/server.mjs，向 stdin 写入一行 initialize 请求，然后从 stdout 逐行解析 JSON，
 * 直到收到 id=1 的响应为止；超过 15 秒未响应则判定为超时。
 * 目的是验证「按行分隔的 JSON-RPC」这一真实传输格式，而不仅是进程内调用。
 */
async function stdioFramingSmokeTest() {
  // 在允许 spawn 的环境中验证真实的换行分隔 JSON-RPC 帧格式
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(process.execPath, [path.resolve('mcp/server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, skipped: 'spawn blocked: ' + e.code })
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch (e) {
        /* 忽略：进程可能已经退出 */
      }
      resolve({ ok: false, error: 'timeout' })
    }, 15000)
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8')
      const lines = out.split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1) {
            clearTimeout(timer)
            try {
              proc.kill()
            } catch (e) {
              /* 忽略：进程可能已经退出 */
            }
            resolve({ ok: msg.result?.serverInfo?.name === 'substrate-texture-designer', msg })
          }
        } catch (e) {
          /* 等待一整行 JSON 收齐后再解析 */
        }
      }
    })
    proc.stderr.on('data', () => {})
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, skipped: 'spawn blocked: ' + e.code })
    })
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } }
      }) + '\n'
    )
  })
}

async function main() {
  // ---- 健康检查：服务器可达、MCP 网关版本、是否有浏览器标签页连上桥接 ----
  const health = await httpJSON('/api/health')
  check('health: server reachable', health.body?.ok === true, JSON.stringify(health.body))
  check('health: mcp gateway exposes apiVersion', !!health.body?.mcp?.apiVersion, JSON.stringify(health.body?.mcp))
  const connected = health.body?.mcp?.connectedClients || 0
  check('bridge: app tab connected', connected > 0, `${connected} client(s) — open http://127.0.0.1:3000`)

  // ---- 工具目录：数量、版本与关键工具是否齐全 ----
  const catalog = await httpJSON('/api/mcp/tools')
  check('catalog: tools listed', Array.isArray(catalog.body?.tools) && catalog.body.tools.length >= 25, `${catalog.body?.tools?.length}`)
  check('catalog: api version', catalog.body?.apiVersion === '1.0.0', catalog.body?.apiVersion)
  const names = (catalog.body?.tools || []).map((t) => t.name)
  for (const expected of ['substrate_get_state', 'substrate_get_graph', 'substrate_set_param', 'substrate_export', 'substrate_paint_stroke', 'substrate_run_audit']) {
    check(`catalog: includes ${expected}`, names.includes(expected))
  }

  // ---------------------------------------------------------------- stdio 传输逻辑
  // 直接在进程内调用 handleMessage，覆盖 initialize / tools/list / tools/call 及各类错误路径
  const init = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'substrate-mcp-test', version: '1.0.0' } })
  check('stdio: initialize', init.result?.serverInfo?.name === 'substrate-texture-designer', JSON.stringify(init))
  check('stdio: capabilities.tools', init.result?.capabilities?.tools !== undefined)
  const list = await request('tools/list', {})
  check('stdio: tools/list', (list.result?.tools || []).length >= 25, `${list.result?.tools?.length}`)

  const stateRes = await request('tools/call', { name: 'substrate_get_state', arguments: {} })
  const state = toolText(stateRes)
  check('stdio: call get_state', stateRes.result?.isError === false && !!state?.data?.material, JSON.stringify(state?.error || state?.data))

  const demo = toolText(await request('tools/call', { name: 'substrate_load_demo', arguments: { id: 'mossy-rock' } }))
  check('stdio: load_demo mossy-rock', demo?.ok === true && demo.data.nodes >= 8, JSON.stringify(demo?.error))

  const added = toolText(await request('tools/call', { name: 'substrate_add_node', arguments: { type: 'perlin', x: 80, y: 80 } }))
  check('stdio: add_node perlin', added?.ok === true && !!added.data.nodeId, JSON.stringify(added?.error))

  if (added?.data?.nodeId) {
    const param = toolText(await request('tools/call', { name: 'substrate_set_param', arguments: { nodeId: added.data.nodeId, key: 'scale', value: 12 } }))
    check('stdio: set_param', param?.ok === true && param.data.value === 12, JSON.stringify(param?.error || param?.data))
    const graph = toolText(await request('tools/call', { name: 'substrate_get_graph', arguments: {} }))
    check('stdio: get_graph reflects node', graph?.ok === true && graph.data.nodes.some((n) => n.id === added.data.nodeId))
    const del = toolText(await request('tools/call', { name: 'substrate_delete_node', arguments: { nodeId: added.data.nodeId } }))
    check('stdio: delete_node', del?.ok === true)
  }

  const evalRes = toolText(await request('tools/call', { name: 'substrate_evaluate', arguments: {} }))
  check('stdio: evaluate', evalRes?.ok === true && !evalRes.data.eval.error, JSON.stringify(evalRes?.data?.eval))

  const thumb = toolText(await request('tools/call', { name: 'substrate_get_thumbnail', arguments: {} }))
  check('stdio: get_thumbnail', thumb?.ok === true && String(thumb.data.dataUrl).startsWith('data:image/png'), JSON.stringify(thumb?.error))

  const preview2d = toolText(await request('tools/call', { name: 'substrate_get_preview', arguments: { view: '2d', channel: 'basecolor', size: 128 } }))
  check('stdio: get_preview 2d', preview2d?.ok === true && String(preview2d.data.dataUrl).startsWith('data:image/png'), JSON.stringify(preview2d?.error))
  const preview3d = toolText(await request('tools/call', { name: 'substrate_get_preview', arguments: { view: '3d', size: 128 } }))
  check('stdio: get_preview 3d', preview3d?.ok === true && String(preview3d.data.dataUrl).startsWith('data:image/png'), JSON.stringify(preview3d?.error))

  const res = toolText(await request('tools/call', { name: 'substrate_set_resolution', arguments: { resolution: 512, proxy: 1 } }))
  check('stdio: set_resolution', res?.ok === true && res.data.resolution === 512, JSON.stringify(res?.data))

  // 绘制需要材质里存在绘制层，所以先切到 painted-sign 示例再落笔
  await request('tools/call', { name: 'substrate_load_demo', arguments: { id: 'painted-sign' } })
  const painted = toolText(
    await request('tools/call', {
      name: 'substrate_paint_stroke',
      arguments: {
        points: [
          { x: 0.3, y: 0.4, p: 0.9 },
          { x: 0.5, y: 0.45, p: 0.8 },
          { x: 0.7, y: 0.4, p: 0.9 }
        ],
        brushId: 'chalk',
        color: '#7fd07f',
        size: 48,
        taper: true
      }
    })
  )
  check('stdio: paint_stroke', painted?.ok === true && painted.data.strokes > 0, JSON.stringify(painted?.error))
  const cleared = toolText(await request('tools/call', { name: 'substrate_clear_paint', arguments: {} }))
  check('stdio: clear_paint', cleared?.ok === true)

  const saved = toolText(await request('tools/call', { name: 'substrate_save_project', arguments: { name: 'MCP Test Project' } }))
  check('stdio: save_project', saved?.ok === true, JSON.stringify(saved?.error))
  const listRes = toolText(await request('tools/call', { name: 'substrate_list_projects', arguments: {} }))
  check('stdio: list_projects', listRes?.ok === true && listRes.data.projects.some((p) => p.name === 'MCP Test Project'), JSON.stringify(listRes?.data))
  const loaded = toolText(await request('tools/call', { name: 'substrate_load_project', arguments: { name: 'MCP Test Project' } }))
  check('stdio: load_project', loaded?.ok === true, JSON.stringify(loaded?.error))
  const deleted = toolText(await request('tools/call', { name: 'substrate_delete_project', arguments: { name: 'MCP Test Project' } }))
  check('stdio: delete_project', deleted?.ok === true, JSON.stringify(deleted?.error))

  const exported = toolText(
    await request('tools/call', { name: 'substrate_export', arguments: { preset: 'gltf', resolution: 256, name: 'MCP Test Export', height16: true } })
  )
  check('stdio: export', exported?.ok === true && !!exported.data.server?.dir && exported.data.files.length >= 4, JSON.stringify(exported?.error || exported?.data?.serverError))
  if (exported?.data?.server?.dir) {
    const dir = path.resolve(exported.data.server.dir)
    check('stdio: export zip written', !!exported.data.server.zip && existsSync(path.join(dir, path.basename(exported.data.server.zip))))
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (e) {
      /* 清理失败不影响测试结论 */
    }
  }

  const unknown = await request('tools/call', { name: 'substrate_does_not_exist', arguments: {} })
  check('stdio: unknown tool error', unknown.result?.isError === true && toolText(unknown)?.error?.code === 'UNKNOWN_TOOL', JSON.stringify(toolText(unknown)))
  const badEnum = toolText(await request('tools/call', { name: 'substrate_load_demo', arguments: { id: 'nope' } }))
  check('stdio: invalid argument error', badEnum?.ok === false && badEnum.error?.code === 'INVALID_ARGUMENT', JSON.stringify(badEnum))
  const missing = toolText(await request('tools/call', { name: 'substrate_add_node', arguments: {} }))
  check('stdio: missing argument error', missing?.ok === false && missing.error?.code === 'INVALID_ARGUMENT', JSON.stringify(missing))
  const notFound = toolText(await request('tools/call', { name: 'substrate_delete_node', arguments: { nodeId: 'nope' } }))
  check('stdio: not-found error', notFound?.ok === false && notFound.error?.code === 'NOT_FOUND', JSON.stringify(notFound))
  const ping = await request('ping', {})
  check('stdio: ping', !!ping.result)

  // 真实 stdio 帧格式（spawn）——沙箱禁止子进程时会自动跳过
  const framing = await stdioFramingSmokeTest()
  if (framing.skipped) skip('stdio: newline JSON-RPC framing (spawn)', framing.skipped)
  else check('stdio: newline JSON-RPC framing (spawn)', framing.ok, JSON.stringify(framing.msg || framing.error))

  // ---------------------------------------------------------------- HTTP 传输
  // 覆盖 /mcp（标准 JSON-RPC）与 /api/mcp/call（简化信封）两条入口，以及未知方法的错误码
  const httpInit = await httpJSON('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) })
  check('http: /mcp initialize', httpInit.body?.result?.serverInfo?.name === 'substrate-texture-designer', JSON.stringify(httpInit.body))
  const httpList = await httpJSON('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })
  check('http: /mcp tools/list', (httpList.body?.result?.tools || []).length >= 25)
  const httpCall = await httpJSON('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'substrate_get_state', arguments: {} } }) })
  check('http: /mcp tools/call', httpCall.body?.result?.isError === false && !!toolText(httpCall.body)?.data?.material, JSON.stringify(httpCall.body))
  const badRpc = await httpJSON('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'nope/nope' }) })
  check('http: /mcp unknown method', badRpc.body?.error?.code === -32601, JSON.stringify(badRpc.body))

  const direct = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_get_state', arguments: {} }) })
  check('http: /api/mcp/call envelope', direct.body?.ok === true && direct.body.apiVersion === '1.0.0' && !!direct.body.meta?.durationMs, JSON.stringify(direct.body))
  const directInvalid = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_load_demo', arguments: { id: 'nope' } }) })
  check('http: /api/mcp/call normalized error', directInvalid.body?.ok === false && directInvalid.body.error.code === 'INVALID_ARGUMENT', JSON.stringify(directInvalid.body))

  // ---------------------------------------------------------------- MCP 自检端点
  const selfcheck = await httpJSON('/api/mcp/selfcheck')
  check('selfcheck: endpoint ok', selfcheck.body?.ok === true, JSON.stringify(selfcheck.body?.totals || selfcheck.body))
  check('selfcheck: reports bridge', (selfcheck.body?.checks || []).some((c) => c.name.includes('bridge') && c.ok), JSON.stringify(selfcheck.body?.checks))

  // ---------------------------------------------------------------- LLM 网关（响应中不得泄露密钥）
  const models = await httpJSON('/api/llm/models')
  check('llm: models listed', models.body?.ok === true && (models.body.models || []).length >= 1, JSON.stringify(models.body?.error))
  check('llm: no API key leaked', !/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(models.body)), 'key material found in /api/llm/models')
  check('llm: provider masks key as hasKey', (models.body?.providers || []).every((p) => !('apiKey' in p) && 'hasKey' in p), JSON.stringify(models.body?.providers))
  const chatInvalid = await httpJSON('/api/llm/chat', { method: 'POST', body: JSON.stringify({ modelKey: models.body?.defaultModel, messages: [] }) })
  check('llm: chat validates empty messages', chatInvalid.body?.ok === false && chatInvalid.body.error.code === 'INVALID_ARGUMENT', JSON.stringify(chatInvalid.body))

  // 供应商 CRUD 在测试中不能改动用户本地配置：这里只验证错误路径与遮蔽逻辑。
  const invalidProvider = await httpJSON('/api/llm/providers', { method: 'POST', body: JSON.stringify({ label: 'No models' }) })
  check('llm: provider validation rejects missing models', invalidProvider.body?.ok === false, JSON.stringify(invalidProvider.body))
  const unknownProviderDelete = await httpJSON('/api/llm/providers/delete', { method: 'POST', body: JSON.stringify({ id: '__does_not_exist__' }) })
  check('llm: unknown provider delete rejected', unknownProviderDelete.body?.ok === false, JSON.stringify(unknownProviderDelete.body))
  const modelsAfter = await httpJSON('/api/llm/models')
  check('llm: provider list stays masked', (modelsAfter.body?.providers || []).every((p) => !('apiKey' in p) && 'hasKey' in p) && !/sk-/.test(JSON.stringify(modelsAfter.body)))

  if (process.env.SUBSTRATE_TEST_LLM === '1') {
    const chat = await httpJSON('/api/llm/chat', {
      method: 'POST',
      body: JSON.stringify({ modelKey: models.body?.defaultModel, messages: [{ role: 'user', content: '只回复 OK，不要调用工具' }], maxSteps: 2 })
    })
    check('llm: live chat call', chat.body?.ok === true, JSON.stringify(chat.body?.error))
  } else {
    skip('llm: live chat call', 'set SUBSTRATE_TEST_LLM=1 to call the configured provider')
  }

  // ---------------------------------------------------------------- AI 规则 + 在线素材工具
  const rules = await httpJSON('/api/llm/rules')
  check('ai: rules endpoint', rules.body?.ok === true && (rules.body.rules || []).length >= 5, JSON.stringify(rules.body))
  check(
    'ai: rules forbid source/secrets access',
    (rules.body?.rules || []).some((r) => /source code/i.test(r)) &&
      (rules.body?.rules || []).some((r) => /API keys|environment/i.test(r)),
    JSON.stringify(rules.body?.rules)
  )
  // 回归用例：assistant 的 tool_calls 中每个调用都必须有对应的 tool 回复，
  // 否则下一次请求会被供应商拒绝（OpenAI 400 "insufficient tool messages"）。
  const incomplete = sanitizeToolSequence([
    { role: 'system', content: 's' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: '{}' }
  ])
  check(
    'llm: incomplete tool turn repaired',
    incomplete.length === 2 && !incomplete.some((m) => m.role === 'tool') && !incomplete[1].tool_calls,
    JSON.stringify(incomplete)
  )
  const complete = sanitizeToolSequence([
    { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
    { role: 'tool', tool_call_id: 'a', content: '{}' },
    { role: 'tool', tool_call_id: 'b', content: '{}' }
  ])
  check('llm: complete tool turn preserved', complete.length === 3 && complete[0].tool_calls?.length === 2, JSON.stringify(complete))

  // 调用约定 / 附件素材相关工具
  const catalogNow = await httpJSON('/api/mcp/tools')
  const toolsNow = catalogNow.body?.tools || []
  check('mcp: 32 tools catalogued', toolsNow.length === 32, String(toolsNow.length))
  check(
    'mcp: tool examples provided',
    toolsNow.find((t) => t.name === 'substrate_paint_stroke')?.examples?.length > 0 &&
      toolsNow.find((t) => t.name === 'substrate_get_thumbnail')?.examples?.length > 0,
    'examples missing'
  )
  check('mcp: list/apply asset tools', toolsNow.some((t) => t.name === 'substrate_list_assets') && toolsNow.some((t) => t.name === 'substrate_apply_asset'))
  const badPaint = await httpJSON('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name: 'substrate_paint_stroke', arguments: { points: [{ x: 0.2 }] } })
  })
  check(
    'mcp: invalid args include example',
    badPaint.body?.ok === false &&
      badPaint.body.error?.code === 'INVALID_ARGUMENT' &&
      !!badPaint.body.error?.details?.example,
    JSON.stringify(badPaint.body)
  )
  const badThumb = await httpJSON('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name: 'substrate_get_thumbnail', arguments: { nodeId: '__missing_node__' } })
  })
  check(
    'mcp: not-found lists available nodes',
    badThumb.body?.ok === false &&
      badThumb.body.error?.code === 'NOT_FOUND' &&
      Array.isArray(badThumb.body.error?.details?.availableNodes),
    JSON.stringify(badThumb.body)
  )
  const layout = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_auto_layout', arguments: {} }) })
  check('mcp: auto layout tool', layout.body?.ok === true && layout.body.data?.moved > 0 && layout.body.data?.layers > 0, JSON.stringify(layout.body?.data || layout.body?.error))
  const graphNow = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_get_graph', arguments: {} }) })
  const graphNodes = graphNow.body?.data?.nodes || []
  check(
    'mcp: inputPorts exposed',
    graphNodes.length > 0 && graphNodes.every((n) => Array.isArray(n.inputPorts)),
    'inputPorts missing'
  )
  const perlinNode = graphNodes.find((n) => n.type === 'perlin')
  const addedTransform = await httpJSON('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name: 'substrate_add_node', arguments: { type: 'transform', x: 40, y: 40 } })
  })
  const transformId = addedTransform.body?.data?.nodeId || addedTransform.body?.data?.id
  const aliasConnect = await httpJSON('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name: 'substrate_connect', arguments: { fromNode: perlinNode?.id, fromPort: 'out', toNode: transformId, toPort: 'in' } })
  })
  check(
    'mcp: connect corrects in alias',
    aliasConnect.body?.ok === true && aliasConnect.body.data?.port === 'input' && /in -> input/.test(aliasConnect.body.data?.correctedPort || ''),
    JSON.stringify(aliasConnect.body)
  )
  const badConnect = await httpJSON('/api/mcp/call', {
    method: 'POST',
    body: JSON.stringify({ name: 'substrate_connect', arguments: { fromNode: perlinNode?.id, fromPort: 'out', toNode: transformId, toPort: 'nope' } })
  })
  check(
    'mcp: connect reports available ports',
    badConnect.body?.ok === false && badConnect.body.error?.code === 'INVALID_ARGUMENT' && (badConnect.body.error?.details?.availablePorts || []).includes('input'),
    JSON.stringify(badConnect.body?.error)
  )
  const assetsNow = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_list_assets', arguments: {} }) })
  check('mcp: list assets tool', assetsNow.body?.ok === true && Array.isArray(assetsNow.body.data?.assets))

  const catalog29 = await httpJSON('/api/mcp/tools')
  const toolNames = (catalog29.body?.tools || []).map((t) => t.name)
  check('mcp: online asset search tool', toolNames.includes('substrate_search_open_assets'))
  check('mcp: online asset import tool', toolNames.includes('substrate_import_asset_url'))
  const search = await httpJSON('/api/assets/search?q=rust%20metal&limit=2')
  check(
    'assets: online search endpoint',
    (search.body?.ok === true && (search.body.results || []).length > 0) ||
      search.body?.error?.code === 'ASSET_SEARCH_UNAVAILABLE',
    JSON.stringify(search.body?.error || search.body?.results?.length)
  )
  check('assets: search results carry license/creator', (search.body?.results || []).every((r) => r.license && r.creator) || !search.body?.ok)
  const ssrf = await httpJSON('/api/assets/import-url', { method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:3000/api/health' }) })
  check('assets: URL import rejects localhost (SSRF guard)', ssrf.body?.ok === false, JSON.stringify(ssrf.body))
  const proto = await httpJSON('/api/assets/import-url', { method: 'POST', body: JSON.stringify({ url: 'file:///etc/passwd' }) })
  check('assets: URL import rejects non-http schemes', proto.body?.ok === false, JSON.stringify(proto.body))

  // ---------------------------------------------------------------- 素材库 CRUD
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
  const assetImport = await httpJSON('/api/assets/import', { method: 'POST', body: JSON.stringify({ name: 'mcp-test.png', dataUrl: tinyPng }) })
  check('assets: import', assetImport.body?.ok === true && !!assetImport.body.asset?.id, JSON.stringify(assetImport.body?.error))
  const assetList = await httpJSON('/api/assets')
  const asset = (assetList.body?.assets || []).find((a) => a.id === assetImport.body?.asset?.id)
  check('assets: list contains imported asset', !!asset && !!asset.url, JSON.stringify(assetList.body?.assets))
  if (asset) {
    const fileRes = await fetch(BASE + asset.url)
    check('assets: file served', fileRes.ok && (await fileRes.arrayBuffer()).byteLength > 0)
    const deleted = await httpJSON('/api/assets/delete', { method: 'POST', body: JSON.stringify({ id: asset.id }) })
    check('assets: delete', deleted.body?.ok === true, JSON.stringify(deleted.body?.error))
  } else {
    check('assets: file served', false, 'asset missing')
    check('assets: delete', false, 'asset missing')
  }
  const badAsset = await httpJSON('/api/assets/import', { method: 'POST', body: JSON.stringify({ name: 'bad.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' }) })
  check('assets: rejects non-image uploads', badAsset.body?.ok === false && badAsset.body.error.code === 'ASSET_IMPORT_FAILED', JSON.stringify(badAsset.body))

  const restore = await httpJSON('/api/mcp/call', { method: 'POST', body: JSON.stringify({ name: 'substrate_load_demo', arguments: { id: 'weathered-steel' } }) })
  check('cleanup: restore demo', restore.body?.ok === true, JSON.stringify(restore.body?.error))

  const passed = results.filter((r) => r.pass && !r.skip).length
  console.log(`\nMCP test ${failed === 0 ? 'PASSED' : 'FAILED'} — ${passed} passed, ${failed} failed, ${skipped} skipped, ${results.length} checks`)
  if (failed > 0) {
    console.log(JSON.stringify(results.filter((r) => !r.pass), null, 2))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[mcp-test] crashed:', e)
  process.exit(1)
})
