#!/usr/bin/env node
// End-to-end test for the Substrate MCP integration.
//
// Prerequisites: the studio server (npm start) is running and a browser tab with the studio is
// open so the MCP gateway can execute tools in the WebGL app.
// Run: npm run test:mcp
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { handleMessage } from '../mcp/server.mjs'

const BASE = (process.env.SUBSTRATE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const results = []
let failed = 0
let skipped = 0
function check(name, pass, info = '') {
  results.push({ name, pass: !!pass, info: pass ? '' : String(info) })
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ' — ' + info}`)
}
function skip(name, reason) {
  skipped++
  results.push({ name, pass: true, skip: true })
  console.log(`SKIP  ${name} — ${reason}`)
}

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

// The stdio server logic is imported directly: the sandbox used for development forbids
// child_process.spawn, but handleMessage() is exactly what the stdio transport calls.
let seq = 0
const request = (method, params) => handleMessage({ jsonrpc: '2.0', id: ++seq, method, params })
const toolText = (result) => {
  const text = result?.result?.content?.[0]?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (e) {
    return null
  }
}

async function stdioFramingSmokeTest() {
  // validate the real newline-delimited JSON-RPC framing when spawning is permitted
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
        /* ignore */
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
              /* ignore */
            }
            resolve({ ok: msg.result?.serverInfo?.name === 'substrate-texture-designer', msg })
          }
        } catch (e) {
          /* wait for a complete line */
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
  const health = await httpJSON('/api/health')
  check('health: server reachable', health.body?.ok === true, JSON.stringify(health.body))
  check('health: mcp gateway exposes apiVersion', !!health.body?.mcp?.apiVersion, JSON.stringify(health.body?.mcp))
  const connected = health.body?.mcp?.connectedClients || 0
  check('bridge: app tab connected', connected > 0, `${connected} client(s) — open http://127.0.0.1:3000`)

  const catalog = await httpJSON('/api/mcp/tools')
  check('catalog: tools listed', Array.isArray(catalog.body?.tools) && catalog.body.tools.length >= 25, `${catalog.body?.tools?.length}`)
  check('catalog: api version', catalog.body?.apiVersion === '1.0.0', catalog.body?.apiVersion)
  const names = (catalog.body?.tools || []).map((t) => t.name)
  for (const expected of ['substrate_get_state', 'substrate_get_graph', 'substrate_set_param', 'substrate_export', 'substrate_paint_stroke', 'substrate_run_audit']) {
    check(`catalog: includes ${expected}`, names.includes(expected))
  }

  // ---------------------------------------------------------------- stdio transport logic
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

  // painting needs a material that actually has a paint layer
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
      /* cleanup is best effort */
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

  // real stdio framing (spawn) — skipped automatically where the sandbox forbids child processes
  const framing = await stdioFramingSmokeTest()
  if (framing.skipped) skip('stdio: newline JSON-RPC framing (spawn)', framing.skipped)
  else check('stdio: newline JSON-RPC framing (spawn)', framing.ok, JSON.stringify(framing.msg || framing.error))

  // ---------------------------------------------------------------- HTTP transports
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

  // ---------------------------------------------------------------- MCP self-check endpoint
  const selfcheck = await httpJSON('/api/mcp/selfcheck')
  check('selfcheck: endpoint ok', selfcheck.body?.ok === true, JSON.stringify(selfcheck.body?.totals || selfcheck.body))
  check('selfcheck: reports bridge', (selfcheck.body?.checks || []).some((c) => c.name.includes('bridge') && c.ok), JSON.stringify(selfcheck.body?.checks))

  // ---------------------------------------------------------------- LLM gateway (no secrets in responses)
  const models = await httpJSON('/api/llm/models')
  check('llm: models listed', models.body?.ok === true && (models.body.models || []).length >= 1, JSON.stringify(models.body?.error))
  check('llm: no API key leaked', !/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(models.body)), 'key material found in /api/llm/models')
  check('llm: provider masks key as hasKey', (models.body?.providers || []).every((p) => !('apiKey' in p) && 'hasKey' in p), JSON.stringify(models.body?.providers))
  const chatInvalid = await httpJSON('/api/llm/chat', { method: 'POST', body: JSON.stringify({ modelKey: models.body?.defaultModel, messages: [] }) })
  check('llm: chat validates empty messages', chatInvalid.body?.ok === false && chatInvalid.body.error.code === 'INVALID_ARGUMENT', JSON.stringify(chatInvalid.body))

  // Provider CRUD must not mutate the user's local provider config in a test run: only validate
  // error paths and masking here.
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

  // ---------------------------------------------------------------- AI rules + online asset tools
  const rules = await httpJSON('/api/llm/rules')
  check('ai: rules endpoint', rules.body?.ok === true && (rules.body.rules || []).length >= 5, JSON.stringify(rules.body))
  check(
    'ai: rules forbid source/secrets access',
    (rules.body?.rules || []).some((r) => /source code/i.test(r)) &&
      (rules.body?.rules || []).some((r) => /API keys|environment/i.test(r)),
    JSON.stringify(rules.body?.rules)
  )
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

  // ---------------------------------------------------------------- material library CRUD
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
