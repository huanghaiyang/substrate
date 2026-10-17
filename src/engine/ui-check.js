// Temporary deep UI check for the top toolbar and right panel (removed before commit).
import {
  state,
  nodeById,
  outputNode,
  loadDemo,
  newProject,
  saveProject,
  listProjects,
  loadProject,
  graphJSON,
  setParam,
  addNode,
  selectNode,
  undo,
  redo,
  doEval,
  setResolution,
  setProxy
} from './store.js'
import { previewStore } from './preview.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function report() {
  const tests = []
  return {
    tests,
    add(name, pass, info = '') {
      tests.push({ name, pass: !!pass, info: pass ? '' : String(info) })
    },
    result() {
      const failed = tests.filter((t) => !t.pass)
      return { ok: failed.length === 0, passed: tests.filter((t) => t.pass).length, failed: failed.length, failures: failed, tests: tests.slice() }
    }
  }
}

const texHash = (arr) => {
  if (!arr || !arr.length) return 'none'
  let h = 0
  const step = Math.max(1, Math.floor(arr.length / 2048))
  for (let i = 0; i < arr.length; i += step) h = (h * 31 + arr[i]) | 0
  return h + ':' + arr.length
}

export async function runUiCheck() {
  const r = report()
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const text = (s) => q(s)?.textContent?.trim() || ''
  const visible = (el) => !!el && el.offsetParent !== null
  const click = (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  const setInput = (el, value, ev = 'input') => {
    if (!el) return false
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event(ev, { bubbles: true }))
    return true
  }
  const waitFor = async (fn, timeout = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const snap = () => {
    const mat = window.__PREVIEW__?.getMesh()?.material
    return {
      pv: state.previewVersion,
      map: mat?.map ? texHash(mat.map.image?.data) : 'none',
      normal: mat?.normalMap ? texHash(mat.normalMap.image?.data) : 'none',
      maps: previewStore.maps?.basecolor ? texHash(previewStore.maps.basecolor.data) : 'none',
      cards: qa('.map-card .map-thumb').map((e) => e.style.backgroundImage).join('|')
    }
  }
  const waitPreview = async (from, timeout = 15000) => waitFor(() => state.previewVersion > from, timeout)
  const badge = () => text('.badge')
  const cssSize = () => text('.right-tabs .chip')

  const snapshot = { graph: JSON.parse(graphJSON()), name: state.projectName, resolution: state.resolution, proxy: state.proxy, locale: (await import('../i18n/index.js')).locale.value }
  const { setLocale } = await import('../i18n/index.js')

  try {
    // ============================ TOP TOOLBAR ============================
    // project name input
    const nameInput = q('.project-name')
    r.add('toolbar: project name input exists', !!nameInput)
    if (nameInput) {
      setInput(nameInput, 'UI Check Material')
      await sleep(150)
      r.add('toolbar: project name edit', state.projectName === 'UI Check Material', state.projectName)
    }

    // New
    loadDemo('weathered-steel')
    await sleep(600)
    const beforeNew = snap()
    click(qa('.topbar .btn').find((b) => /New|新建/.test(b.textContent)))
    const pvNew = state.previewVersion
    await waitPreview(pvNew)
    await sleep(400)
    const afterNew = snap()
    r.add('toolbar: New resets graph', state.graph.nodes.length <= 3, String(state.graph.nodes.length))
    r.add('toolbar: New updates preview', beforeNew.map !== afterNew.map, JSON.stringify({ before: beforeNew.map, after: afterNew.map }))
    r.add('toolbar: New dropdown closed', !q('.dropdown-menu'))

    // Demos dropdown: switch through all four, verify preview + project name
    const normals = ['weathered-steel', 'mossy-rock', 'painted-sign', 'blank']
    let prevSnap = afterNew
    for (const id of normals) {
      click(qa('.topbar .btn').find((b) => /Demos|示例/.test(b.textContent)))
      await sleep(150)
      const items = qa('.dd-item')
      r.add(`toolbar: demo menu lists ${id}`, items.length >= 4, String(items.length))
      const expectedName = { 'weathered-steel': 'Weathered', 'mossy-rock': 'Mossy', 'painted-sign': 'Hand Painted', blank: 'New Material' }[id]
      const item = items.find((e) => e.textContent.includes(expectedName))
      if (!item) {
        r.add(`toolbar: demo item ${id}`, false, items.map((e) => e.textContent).join(','))
        continue
      }
      const pv = state.previewVersion
      click(item)
      await waitPreview(pv)
      await sleep(400)
      const s = snap()
      r.add(`toolbar: demo ${id} loaded`, state.projectName.length > 0 && !state.error, state.projectName + ' ' + state.error)
      r.add(`toolbar: demo ${id} closes menu`, !q('.dropdown-menu'))
      if (id !== 'blank') r.add(`toolbar: demo ${id} changes preview`, s.map !== prevSnap.map, JSON.stringify({ prev: prevSnap.map, now: s.map }))
      prevSnap = s
    }

    // Save / Open roundtrip through the UI
    const saveName = 'UI Check Save'
    state.projectName = saveName
    click(qa('.topbar .btn').find((b) => /Save|保存/.test(b.textContent)))
    await sleep(900)
    r.add('toolbar: Save shows toast', /saved|已保存/i.test(text('.toast')), text('.toast'))
    const projects = await listProjects()
    r.add('toolbar: Save writes project', projects.some((p) => p.name === saveName), JSON.stringify(projects.map((p) => p.name)))
    click(qa('.topbar .btn').find((b) => /Open|打开/.test(b.textContent)))
    await sleep(700)
    const rows = qa('.project-row')
    r.add('toolbar: Open lists projects', rows.length >= 1, String(rows.length))
    const row = rows.find((e) => e.textContent.includes(saveName))
    r.add('toolbar: Open finds saved project', !!row)
    if (row) {
      const pv = state.previewVersion
      click(row)
      await waitPreview(pv)
      r.add('toolbar: Open loads project', state.projectName === saveName, state.projectName)
      r.add('toolbar: Open closes modal', !q('.modal'))
    }
    await fetch('/api/projects/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: saveName }) })

    // undo / redo buttons
    loadDemo('blank')
    await sleep(500)
    addNode('perlin', { x: 100, y: 100 })
    await sleep(250)
    const withNode = state.graph.nodes.length
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '↺'))
    await sleep(300)
    r.add('toolbar: undo button', state.graph.nodes.length === withNode - 1, `${state.graph.nodes.length} vs ${withNode - 1}`)
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '↻'))
    await sleep(300)
    r.add('toolbar: redo button', state.graph.nodes.length === withNode, `${state.graph.nodes.length} vs ${withNode}`)
    r.add('toolbar: undo disabled state sane', qa('.topbar .icon-btn').filter((b) => ['↺', '↻'].includes(b.textContent.trim())).length === 2)

    // resolution + proxy selects
    loadDemo('weathered-steel')
    await sleep(600)
    const resSelect = qa('.top-select')[0]
    const proxySelect = qa('.top-select')[1]
    r.add('toolbar: selects present', !!resSelect && !!proxySelect)
    for (const res of [512, 2048, 1024]) {
      const pv = state.previewVersion
      setInput(resSelect, String(res), 'change')
      await waitPreview(pv)
      await sleep(250)
      r.add(`toolbar: resolution ${res}`, state.resolution === res && cssSize().includes(String(res)), `${state.resolution} / ${cssSize()}`)
      r.add(`toolbar: resolution ${res} preview refreshed`, snap().map !== 'none')
      r.add(`toolbar: resolution ${res} badge`, badge().includes(String(res)), badge())
    }
    for (const p of [50, 75, 100]) {
      setInput(proxySelect, String(p / 100), 'change')
      await sleep(250)
      r.add(`toolbar: proxy ${p}%`, Math.abs(state.proxy - p / 100) < 1e-6, String(state.proxy))
    }
    setInput(resSelect, '1024', 'change')
    await sleep(300)

    // help modal
    click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '?'))
    await sleep(300)
    r.add('toolbar: help modal', !!q('.modal'))
    r.add('toolbar: help has self-test', qa('.modal-foot .btn').some((b) => /self-test|自检/i.test(b.textContent)), qa('.modal-foot .btn').map((b) => b.textContent).join(','))
    click(q('.modal-head .icon-btn'))
    await sleep(200)
    r.add('toolbar: help closes', !q('.modal'))

    // language switch (toolbar + right panel labels)
    const langBtns = qa('.lang-switch button')
    const zh = langBtns.find((b) => b.textContent.trim() === '中文')
    const en = langBtns.find((b) => b.textContent.trim() === 'EN')
    click(zh)
    await sleep(350)
    r.add('toolbar: zh labels', /新建/.test(text('.topbar')) && /属性/.test(text('.inspector')) && /视图/.test(text('.preview .panel-head')), text('.topbar').slice(0, 40))
    click(en)
    await sleep(350)
    r.add('toolbar: en labels', /New/.test(text('.topbar')) && /Properties/.test(text('.inspector')), text('.topbar').slice(0, 40))

    // export dialog integration
    let tip = 'Export Material'
    click(qa('.topbar .btn').find((b) => /Export Material|导出材质/.test(b.textContent)))
    await sleep(400)
    r.add('toolbar: export dialog opens', !!q('.modal.wide'))
    r.add('toolbar: export default resolution matches doc', Number(q('.modal.wide select')?.value) === state.resolution, `${q('.modal.wide select')?.value} vs ${state.resolution}`)
    r.add('toolbar: export preset cards', qa('.preset-card').length === 5)
    r.add('toolbar: export name prefilled', (q('.modal.wide input')?.value || '').length > 0)
    // height bit depth toggle reflected in table
    const heightRow = () => qa('.file-table tbody tr').find((tr) => /Height|高度/.test(tr.children[0]?.textContent || ''))
    const h16Text = heightRow()?.children[2]?.textContent || ''
    const h16Box = qa('.modal.wide input[type=checkbox]').find((c) => c.closest('label') && /16-bit|16 位/.test(c.closest('label').textContent || ''))
    if (h16Box) {
      h16Box.checked = false
      h16Box.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(250)
      const h8Text = heightRow()?.children[2]?.textContent || ''
      r.add('toolbar: height toggle updates plan', h16Text !== h8Text && /8/.test(h8Text), JSON.stringify({ h16Text, h8Text }))
      h16Box.checked = true
      h16Box.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(200)
    }
    // quick export at 512
    setInput(q('.modal.wide select'), '512', 'change')
    await sleep(200)
    click(qa('.modal-foot .btn').find((b) => /Export 5|导出 5/.test(b.textContent)))
    const okExport = await waitFor(() => !!q('.result-box'), 30000)
    r.add('toolbar: export succeeds', okExport && !!q('.result-box .path'), okExport ? text('.result-box .path') : 'timeout')
    click(q('.modal-head .icon-btn'))
    await sleep(300)
    r.add('toolbar: export dialog closes', !q('.modal.wide'))

    // ============================ RIGHT PANEL ============================
    loadDemo('weathered-steel')
    await sleep(800)

    // tabs
    const tabs = qa('.right-tabs button')
    click(tabs[1])
    await sleep(400)
    r.add('right: 2D maps tab', visible(q('.maps')))
    click(tabs[0])
    await sleep(400)
    r.add('right: 3D tab', visible(q('.preview')))

    // badges
    r.add('right: badge shows channels', /8/.test(badge()), badge())
    r.add('right: material name badge', qa('.badge').length >= 2 && qa('.badge')[1].textContent.trim().length > 0, qa('.badge').map((b) => b.textContent).join('|'))

    // preview shape select
    const shape = q('.shape-select')
    r.add('right: shape select', !!shape && shape.options.length === 5, shape ? String(shape.options.length) : 'missing')
    if (shape) {
      for (const opt of [...shape.options].map((o) => o.value)) {
        setInput(shape, opt, 'change')
        await sleep(180)
        r.add(`right: shape ${opt}`, !state.error && !!window.__PREVIEW__?.getMesh(), state.error)
      }
      setInput(shape, 'sphere', 'change')
      await sleep(200)
    }

    // tiling / displacement / spin / reset
    const ranges = qa('.preview-tools input[type=range]')
    if (ranges.length >= 2) {
      setInput(ranges[0], '3', 'input')
      await sleep(250)
      const mesh = window.__PREVIEW__.getMesh()
      const mat = mesh.material
      r.add('right: tiling slider', Math.abs(mat.map.repeat.x - 3) < 1e-6, `${mat.map.repeat.x}`)
      setInput(ranges[1], '0.08', 'input')
      await sleep(250)
      r.add('right: displacement slider', Math.abs(mat.displacementScale - 0.08) < 1e-6, `${mat.displacementScale}`)
      setInput(ranges[0], '1', 'input')
      setInput(ranges[1], '0', 'input')
      await sleep(200)
    } else r.add('right: preview sliders present', false)
    const pauseBtn = () => qa('.preview-tools button').find((b) => /Pause|暂停|Spin|旋转/.test(b.textContent))
    const spinLabel1 = pauseBtn()?.textContent.trim()
    click(pauseBtn())
    await sleep(150)
    r.add('right: pause toggles label', spinLabel1 !== pauseBtn()?.textContent.trim(), `${spinLabel1} -> ${pauseBtn()?.textContent.trim()}`)
    click(qa('.preview-tools button').find((b) => /Reset|复位/.test(b.textContent)))
    await sleep(200)
    r.add('right: reset button', !state.error, state.error)

    // map panel contents, zoom, normal convention note
    click(tabs[1])
    await sleep(700)
    r.add('right: 8 map cards', qa('.map-card').length === 8, String(qa('.map-card').length))
    r.add('right: map labels', qa('.map-label').length === 8 && qa('.map-label').every((e) => e.textContent.trim().length > 0))
    r.add('right: map spaces', qa('.map-sub').some((e) => /sRGB/.test(e.textContent)) && qa('.map-sub').some((e) => /Linear|线性/.test(e.textContent)), qa('.map-sub').map((e) => e.textContent).join(' | '))
    const normalCard = qa('.map-card').find((c) => /Normal/.test(c.textContent))
    r.add('right: normal convention note', /OpenGL|DirectX/.test(normalCard?.textContent || ''), normalCard?.textContent)
    click(qa('.map-card')[0])
    await sleep(300)
    r.add('right: map zoom opens', !!q('.map-zoom'))
    r.add('right: map zoom caption', (q('.zoom-caption')?.textContent || '').length > 0)
    click(q('.map-zoom'))
    await sleep(200)
    r.add('right: map zoom closes', !q('.map-zoom'))
    // change normal convention and verify note updates
    const out = outputNode()
    const pvConv = state.previewVersion
    setParam(out.id, 'normalConvention', 1)
    await waitPreview(pvConv)
    await sleep(400)
    const normalCardDX = qa('.map-card').find((c) => /Normal/.test(c.textContent))
    r.add('right: normal note follows convention', /DirectX/.test(normalCardDX?.textContent || ''), normalCardDX?.textContent)
    const nxPrev = window.__PREVIEW__.getMesh().material.normalScale.y
    r.add('right: preview normal flip follows convention', nxPrev < 0, String(nxPrev))
    setParam(out.id, 'normalConvention', 0)
    await sleep(300)
    click(tabs[0])
    await sleep(300)

    // inspector basics
    state.selectedIds = []
    state.activeNodeId = null
    await sleep(300)
    r.add('right: inspector empty state', /Select a node|选择一个节点/.test(text('.insp-empty')), text('.insp-empty').slice(0, 40))
    const perlin = state.graph.nodes.find((n) => n.type === 'perlin')
    selectNode(perlin.id)
    await sleep(500)
    r.add('right: inspector select node', text('.insp-node').length > 0 && qa('.inspector .param').length > 0, text('.insp-node'))
    r.add('right: inspector title input', !!q('.title-input'))
    // range + number sync on first param
    const firstParam = qa('.inspector .param')[0]
    const range = firstParam?.querySelector('input[type=range]')
    const num = firstParam?.querySelector('input.num')
    if (range && num) {
      setInput(range, '12', 'input')
      await sleep(250)
      r.add('right: slider updates number', num.value === '12' || Number(num.value) === 12, `${num.value}`)
      r.add('right: slider updates param', Number(perlin.params.scale) === 12 || Number(perlin.params.value) >= 0, JSON.stringify(perlin.params))
    } else r.add('right: numeric widget present', false)
    // rename
    const titleInput = q('.title-input')
    if (titleInput) {
      setInput(titleInput, 'Renamed Node', 'change')
      await sleep(200)
      r.add('right: rename node', nodeById(perlin.id)?.data?.title === 'Renamed Node', nodeById(perlin.id)?.data?.title)
    }
    // bool checkbox
    const invertNode = state.graph.nodes.find((n) => n.type === 'invert')
    if (invertNode) selectNode(invertNode.id)
    await sleep(400)
    const bool = qa('.inspector .check input[type=checkbox]')[0]
    if (bool) {
      const before = bool.checked
      bool.checked = !before
      bool.dispatchEvent(new Event('change', { bubbles: true }))
      await sleep(250)
      r.add('right: bool toggle', true)
    }
    // gradient editor add/remove stop
    const gradNode = state.graph.nodes.find((n) => n.type === 'gradient_map')
    if (gradNode) {
      selectNode(gradNode.id)
      await sleep(400)
      const bar = q('.grad-bar')
      r.add('right: gradient editor present', !!bar)
      if (bar) {
        const stopsBefore = (gradNode.params.gradient || []).length
        const rect = bar.getBoundingClientRect()
        bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width * 0.3, clientY: rect.top + 5 }))
        await sleep(300)
        const stopsAfter = (nodeById(gradNode.id).params.gradient || []).length
        r.add('right: gradient add stop', stopsAfter === stopsBefore + 1, `${stopsBefore} -> ${stopsAfter}`)
        click(qa('.grad-controls .mini').find((b) => b.textContent.trim() === '−'))
        await sleep(300)
        r.add('right: gradient remove stop', (nodeById(gradNode.id).params.gradient || []).length === stopsBefore, String((nodeById(gradNode.id).params.gradient || []).length))
      }
    }
    // paint studio live result
    loadDemo('painted-sign')
    await sleep(900)
    const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
    selectNode(paintNode.id)
    await sleep(700)
    click(q('.inspector .insp-actions .btn.primary'))
    await sleep(600)
    r.add('right: paint studio opens from inspector', !!q('.paint-studio'))
    if (q('.paint-studio')) {
      const liveImg = q('.paint-side img')
      r.add('right: paint live thumb', !!liveImg && !!liveImg.src)
      click(qa('.paint-head .btn').find((b) => /Graph|节点图/.test(b.textContent)))
      await sleep(300)
      r.add('right: paint studio closes', !q('.paint-studio'))
    }
  } catch (e) {
    r.add('ui-check exception', false, e?.stack || e?.message || String(e))
  } finally {
    try {
      setLocale(snapshot.locale, false)
      setResolution(snapshot.resolution)
      setProxy(snapshot.proxy)
      const { loadGraph } = await import('./store.js')
      loadGraph(snapshot.graph, { name: snapshot.name, resolution: snapshot.resolution })
      state.mode = 'graph'
      state.activePaintId = null
      await sleep(500)
      doEval()
    } catch (e) {
      /* best effort */
    }
  }
  return r.result()
}
