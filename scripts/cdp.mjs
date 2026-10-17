// Tiny Chrome DevTools Protocol helper (Node 22 native WebSocket, no deps).
// usage:
//   node scripts/cdp.mjs list
//   node scripts/cdp.mjs eval "<expression>" [targetId]
//   node scripts/cdp.mjs shot <out.png> [targetId]
//   node scripts/cdp.mjs logs [ms] [targetId]
import { writeFileSync } from 'node:fs'

const ENDPOINT = process.env.CDP || 'http://127.0.0.1:9333'
const args = process.argv.slice(2)
const cmd = args[0] || 'list'

async function getTargets() {
  const res = await fetch(ENDPOINT + '/json/list')
  return res.json()
}

function pickTarget(targets, targetId) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (targetId) return pages.find((t) => t.id === targetId) || pages[0]
  // never grab an unrelated page: prefer the Substrate app tab (dev or dist server), then by title
  return (
    pages.find((t) => /:3000\//.test(t.url || '')) ||
    pages.find((t) => /:3001\//.test(t.url || '')) ||
    pages.find((t) => /Substrate|程序化贴图/.test(t.title || '')) ||
    pages[0]
  )
}

function connect(wsUrl, onEvent) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let id = 0
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
      } else if (msg.method && onEvent) {
        onEvent(msg)
      }
    }
    ws.onerror = (e) => reject(new Error('ws error: ' + (e.message || 'unknown')))
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id
            pending.set(msgId, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ id: msgId, method, params }))
          })
        },
        close() {
          try {
            ws.close()
          } catch (e) {
            /* ignore */
          }
        }
      })
  })
}

async function main() {
  const targets = await getTargets()
  if (cmd === 'list') {
    console.log(
      JSON.stringify(
        targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
        null,
        2
      )
    )
    return
  }
  const target = pickTarget(targets, args[2])
  if (!target) {
    console.error('no page target found')
    process.exit(1)
  }
  const events = []
  const client = await connect(target.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ')
      events.push({ type: 'console.' + msg.params.type, text: text.slice(0, 1200) })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {}
      events.push({ type: 'exception', text: (d.exception && (d.exception.description || d.exception.value)) || d.text })
    } else if (msg.method === 'Log.entryAdded') {
      events.push({ type: 'log.' + msg.params.entry.level, text: msg.params.entry.text })
    }
  })
  try {
    if (cmd === 'audit') {
      // foreground the page: background tabs throttle timers, which stalls the in-page suite
      try {
        await client.send('Page.enable')
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await client.send('Page.setWebLifecycleState', { state: 'active' })
      } catch (e) {
        /* focus is best effort */
      }
      const section = args[1] || 'all'
      const expr =
        "(async()=>{const m=await import('/src/engine/audit.js');const r=await m.runAudit(window.__SUBSTRATE__.engine," +
        JSON.stringify(section) +
        ");return JSON.stringify(r)})()"
      const res = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
      if (res.exceptionDetails) {
        console.error(JSON.stringify(res.exceptionDetails, null, 2))
        process.exitCode = 2
      } else {
        const raw = res.result && res.result.value
        const report = typeof raw === 'string' ? JSON.parse(raw) : raw
        const sections = report.sections || [report]
        const totalPassed = sections.reduce((n, s) => n + (s.passed || 0), 0)
        const totalFailed = sections.reduce((n, s) => n + (s.failed || 0), 0)
        for (const s of sections) {
          console.log(
            (s.ok ? 'PASS' : 'FAIL') + '  ' + (s.section || section) + '  passed=' + s.passed + ' failed=' + s.failed
          )
          for (const f of s.failures || []) console.log('   - ' + f.name + '  ' + f.info)
        }
        console.log('---')
        console.log('audit ' + (report.ok ? 'PASSED' : 'FAILED') + '  total=' + (totalPassed + totalFailed) + ' failed=' + totalFailed)
        process.exitCode = report.ok ? 0 : 1
      }
    } else if (cmd === 'focus') {
      try {
        await client.send('Page.enable')
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await client.send('Page.setWebLifecycleState', { state: 'active' })
      } catch (e) {
        console.error('focus failed:', e.message)
      }
      const state = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify({ visibility: document.visibilityState, focused: document.hasFocus() })',
        returnByValue: true
      })
      console.log(state.result && state.result.value)
    } else if (cmd === 'eval') {
      // keep the page foregrounded: background tabs get their timers throttled, which stalls in-page audits
      try {
        await client.send('Page.enable')
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await client.send('Page.setWebLifecycleState', { state: 'active' })
      } catch (e) {
        /* focus is best effort */
      }
      const expression = args[1]
      const result = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      })
      if (result.exceptionDetails) {
        console.error(JSON.stringify(result.exceptionDetails, null, 2))
        process.exitCode = 2
      } else {
        console.log(
          JSON.stringify(result.result && result.result.value !== undefined ? result.result.value : result.result, null, 2)
        )
      }
    } else if (cmd === 'shot') {
      const out = args[1] || 'shot.png'
      try {
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch (e) {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 350))
      const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(out, Buffer.from(result.data, 'base64'))
      console.log('wrote ' + out)
    } else if (cmd === 'logs') {
      const ms = Number(args[1]) || 3000
      await client.send('Runtime.enable')
      await client.send('Log.enable')
      await new Promise((r) => setTimeout(r, ms))
      console.log(JSON.stringify(events, null, 2))
    } else if (cmd === 'reloadlogs') {
      const ms = Number(args[1]) || 6000
      await client.send('Runtime.enable')
      await client.send('Log.enable')
      await client.send('Page.enable')
      await client.send('Page.reload', { ignoreCache: true })
      await new Promise((r) => setTimeout(r, ms))
      console.log(JSON.stringify(events, null, 2))
    } else {
      console.error('unknown command ' + cmd)
      process.exitCode = 1
    }
  } finally {
    client.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
