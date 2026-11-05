/**
 * 极简 Chrome DevTools Protocol 客户端（依赖 Node 内置 WebSocket，无需第三方库）。
 *
 * 用途：在没有浏览器自动化框架的情况下，对已启动的 Substrate 页面执行表达式、截图、抓控制台日志，
 * 以及运行页面内的自检套件（audit）。前提是浏览器以 --remote-debugging-port 启动。
 *
 * 用法：
 *   node scripts/cdp.mjs list                         列出所有可调试页面
 *   node scripts/cdp.mjs eval "<expression>" [id]     在页面中求值并打印结果
 *   node scripts/cdp.mjs shot <out.png> [id]          截图到文件
 *   node scripts/cdp.mjs logs [ms] [id]               收集指定时长的控制台/异常/日志
 *   node scripts/cdp.mjs reloadlogs [ms] [id]         刷新页面后再收集日志
 *   node scripts/cdp.mjs viewport [w] [h] [dpr]       设置固定截图视口
 *   node scripts/cdp.mjs focus                        把页面切到前台并打印可见性状态
 *   node scripts/cdp.mjs audit [section]              运行页面内审计套件
 *
 * 可通过环境变量 CDP 指定调试端点（默认 http://127.0.0.1:9333）。
 */
import { writeFileSync } from 'node:fs'

const ENDPOINT = process.env.CDP || 'http://127.0.0.1:9333'
const args = process.argv.slice(2)
const cmd = args[0] || 'list'

/** 请求调试端点的页面列表（/json/list）。 */
async function getTargets() {
  const res = await fetch(ENDPOINT + '/json/list')
  return res.json()
}

/**
 * 选中要操作的页面 target。
 * 指定 targetId 时精确匹配；否则按优先级挑「Substrate 应用页」，
 * 避免误连到用户其他无关标签页：先看 3000/3001 端口，再看页面标题。
 */
function pickTarget(targets, targetId) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (targetId) return pages.find((t) => t.id === targetId) || pages[0]
  // 不要抓到无关页面：优先开发/构建服务器上的 Substrate 标签页，其次按标题匹配
  return (
    pages.find((t) => /:3000\//.test(t.url || '')) ||
    pages.find((t) => /:3001\//.test(t.url || '')) ||
    pages.find((t) => /Substrate|程序化贴图/.test(t.title || '')) ||
    pages[0]
  )
}

/**
 * 建立 WebSocket 连接并返回一个简易 RPC 客户端。
 *
 * 实现要点：CDP 的响应通过消息 id 与请求配对，这里用 pending Map 保存每个请求的
 * resolve/reject；同时把没有 id 的事件消息交给 onEvent 回调（用于收集 console/exception/log）。
 *
 * @param {string} wsUrl 页面 target 的 webSocketDebuggerUrl
 * @param {(msg: object) => void} [onEvent] 事件回调
 * @returns {Promise<{send: (method: string, params?: object) => Promise<object>, close: () => void}>}
 */
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
            /* 关闭失败可以忽略 */
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
      // 把 console 参数统一转成可读文本（对象类型退化为 description/type），并截断超长内容
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
    if (cmd === 'viewport') {
      // 设置固定的截图视口，保证不同机器上截图尺寸一致：node scripts/cdp.mjs viewport 1920 937 2
      const width = Number(args[1]) || 1920
      const height = Number(args[2]) || 937
      const dpr = Number(args[3]) || 2
      await client.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile: false,
        screenWidth: width,
        screenHeight: height
      })
      console.log('viewport', width + 'x' + height + ' @' + dpr)
      return
    }

    if (cmd === 'audit') {
      // 先把页面切到前台：后台标签页会被浏览器节流定时器，导致页面内自检套件卡住
      try {
        await client.send('Page.enable')
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await client.send('Page.setWebLifecycleState', { state: 'active' })
      } catch (e) {
        /* 前台化是尽力而为，失败不影响后续操作 */
      }
      const section = args[1] || 'all'
      // 在页面内动态 import 审计模块并调用 runAudit，结果以 JSON 字符串返回，
      // 这样可以把复杂的页面状态（WebGL 统计、节点图等）跨进程取回。
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
      // 保持页面在前台：后台标签页的定时器会被节流，会让页面内的审计流程卡住
      try {
        await client.send('Page.enable')
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
        await client.send('Page.setWebLifecycleState', { state: 'active' })
      } catch (e) {
        /* 前台化是尽力而为，失败不影响后续操作 */
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
      // 截图前先强制前台化并等待两小段稳定时间（排版/WebGL 首帧），
      // 然后临时切到 1920×937@2x 视口，使截图尺寸可复现。
      const out = args[1] || 'shot.png'
      try {
        await client.send('Page.bringToFront')
        await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch (e) {
        /* 已在前台时可能失败，可忽略 */
      }
      await new Promise((r) => setTimeout(r, 350))
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: 1920,
        height: 937,
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: 1920,
        screenHeight: 937
      }).catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
      const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      writeFileSync(out, Buffer.from(result.data, 'base64'))
      console.log('wrote ' + out)
    } else if (cmd === 'logs') {
      // 先启用 Runtime/Log 两个域，再等待指定时长，让页面产生的日志事件累积到 events
      const ms = Number(args[1]) || 3000
      await client.send('Runtime.enable')
      await client.send('Log.enable')
      await new Promise((r) => setTimeout(r, ms))
      console.log(JSON.stringify(events, null, 2))
    } else if (cmd === 'reloadlogs') {
      // 忽略缓存强制刷新页面，再从零开始收集指定时长的日志（适合排查首屏加载问题）
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
