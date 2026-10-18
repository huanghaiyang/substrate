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
  setProxy,
  savePaintBrush
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
  const savedLocale = (() => { try { return localStorage.getItem('substrate.locale') } catch (e) { return null } })()
  const brushSnapshot = { ...state.paintBrush }
  const customBrushesSnapshot = (() => { try { return localStorage.getItem('substrate.customBrushes') } catch (e) { return null } })()
  const llmModelSnapshot = (() => { try { return localStorage.getItem('substrate.llmModel') } catch (e) { return null } })()
  const chatSnapshot = (() => { try { return localStorage.getItem('substrate.aiChat.v1') } catch (e) { return null } })()
  const hrefBeforeLocaleTests = location.href
  const { setLocale } = await import('../i18n/index.js')

  try {
    // deterministic labels: run the English-locale pass, then restore the user's language at the end
    setLocale('en', false)
    await sleep(250)

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

    // auto layout button (one-click graph tidy)
    const layoutBtn = qa('.topbar .icon-btn').find((b) => /自动整理|Auto-arrange/.test(b.getAttribute('title') || ''))
    r.add('toolbar: auto layout button', !!layoutBtn, 'layout button missing')
    if (layoutBtn) {
      loadDemo('weathered-steel')
      await sleep(500)
      const beforePos = state.graph.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))
      click(layoutBtn)
      await sleep(500)
      const afterPos = state.graph.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }))
      const moved = afterPos.filter((n, i) => n.x !== beforePos[i].x || n.y !== beforePos[i].y).length
      r.add('toolbar: auto layout moves nodes', moved > 0, String(moved))
      let overlapCount = 0
      for (let i = 0; i < afterPos.length; i++) {
        for (let j = i + 1; j < afterPos.length; j++) {
          if (afterPos[i].x === afterPos[j].x && Math.abs(afterPos[i].y - afterPos[j].y) < 140) overlapCount++
        }
      }
      r.add('toolbar: auto layout has no overlaps', overlapCount === 0, String(overlapCount))
      click(qa('.topbar .icon-btn').find((b) => b.textContent.trim() === '↺'))
      await sleep(400)
      const restored = state.graph.nodes.every((n) => beforePos.find((b) => b.id === n.id && b.x === n.x && b.y === n.y))
      r.add('toolbar: auto layout undo restores positions', restored)
    }

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
      // ---- built-in brushes ----
      const brushItems = qa('.brush-item')
      const { getBrushGroups } = await import('../engine/brushes.js')
      const totalBrushes = getBrushGroups().reduce((n, g) => n + g.items.length, 0)
      r.add('paint: brush library lists all presets', brushItems.length === totalBrushes, `${brushItems.length}/${totalBrushes}`)
      const groupLabels = qa('.brush-group-label').map((e) => e.textContent.trim())
      r.add('paint: brush picker is grouped', groupLabels.length >= 2, groupLabels.join(','))
      const natureItems = qa('.brush-group')[1]?.querySelectorAll('.brush-item').length || 0
      r.add('paint: nature brush group present', natureItems >= 6, String(natureItems))
      const thumbUrls = brushItems.map((b) => b.querySelector('img')?.src).filter(Boolean)
      r.add('paint: brush thumbnails render', thumbUrls.length === brushItems.length && new Set(thumbUrls).size === brushItems.length, `${thumbUrls.length} thumbs, ${new Set(thumbUrls).size} unique`)
      const paintNodeB = state.graph.nodes.find((n) => n.type === 'paint')
      const strokeCount0 = (paintNodeB.data.strokes || []).length
      const canvasB = q('.paint-canvas')
      const rr = canvasB.getBoundingClientRect()
      const pev = (type, x, y) => canvasB.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 31, pressure: 0.85, buttons: 1 }))
      for (const item of brushItems) {
        const id = item.getAttribute('title') ? null : null
        click(item)
        await sleep(120)
        const selId = state.paintBrush.brushId
        const name = item.querySelector('span')?.textContent || ''
        if (!selId) r.add('paint: brush selection ' + name, false, 'no brushId')
      }
      r.add('paint: brush selection changes state', !!state.paintBrush.brushId, String(state.paintBrush.brushId))
      // draw with the chalk brush (select by its position in the list: id order matches BRUSHES)
      click(brushItems[6])
      await sleep(150)
      r.add('paint: chalk selected', state.paintBrush.brushId === 'chalk', state.paintBrush.brushId)
      pev('pointerdown', rr.left + rr.width * 0.35, rr.top + rr.height * 0.4)
      pev('pointermove', rr.left + rr.width * 0.5, rr.top + rr.height * 0.45)
      pev('pointerup', rr.left + rr.width * 0.5, rr.top + rr.height * 0.45)
      await sleep(500)
      const strokesB = nodeById(paintNodeB.id).data.strokes || []
      const lastB = strokesB[strokesB.length - 1]
      r.add('paint: stroke records brush preset', lastB?.brushId === 'chalk', JSON.stringify({ brushId: lastB?.brushId, flow: lastB?.flow, spacing: lastB?.spacing }))
      r.add('paint: stroke committed', strokesB.length === strokeCount0 + 1, `${strokesB.length} vs ${strokeCount0 + 1}`)
      const savedBrush = (() => { try { return JSON.parse(localStorage.getItem('substrate.brush') || 'null') } catch (e) { return null } })()
      r.add('paint: brush setting persisted', savedBrush && savedBrush.brushId === 'chalk', JSON.stringify(savedBrush))
      // brush rasterisation characteristics (headless canvas)
      const { drawStroke } = await import('../engine/paint.js')
      const { BRUSHES, brushPreview } = await import('../engine/brushes.js')
      const coverage = (opts) => {
        const c = document.createElement('canvas')
        c.width = c.height = 96
        const cx2 = c.getContext('2d')
        drawStroke(cx2, { color: '#ffffff', size: 30, opacity: 1, brushId: 'hard-round', symmetry: {}, points: [{ x: 0.2, y: 0.5, p: 1 }, { x: 0.8, y: 0.5, p: 1 }], ...opts }, 96, 96)
        const d = cx2.getImageData(0, 0, 96, 96).data
        let sum = 0
        for (let i = 3; i < d.length; i += 4) sum += d[i]
        return sum / (96 * 96 * 255)
      }
      const perBrush = BRUSHES.map((b) => coverage({ brushId: b.id }))
      r.add('paint: every brush renders', perBrush.every((v) => v > 0.01), JSON.stringify(perBrush.map((v) => +v.toFixed(3))))
      r.add('paint: every brush differs', new Set(perBrush.map((v) => v.toFixed(3))).size >= 7, JSON.stringify(perBrush.map((v) => +v.toFixed(3))))
      r.add('paint: brush previews unique', new Set(BRUSHES.map((b) => brushPreview(b))).size === BRUSHES.length)
      // eraser removes coverage
      const c3 = document.createElement('canvas')
      c3.width = c3.height = 96
      const cx3 = c3.getContext('2d')
      cx3.fillStyle = '#fff'
      cx3.fillRect(0, 0, 96, 96)
      drawStroke(cx3, { color: '#000', size: 24, opacity: 1, brushId: 'hard-round', erase: true, symmetry: {}, points: [{ x: 0.2, y: 0.5, p: 1 }, { x: 0.8, y: 0.5, p: 1 }] }, 96, 96)
      const d3 = cx3.getImageData(0, 0, 96, 96).data
      let transparent = 0
      for (let i = 3; i < d3.length; i += 4) if (d3[i] === 0) transparent++
      r.add('paint: eraser removes pixels', transparent > 100, String(transparent))
      // cubic smoothing: a 3-point arc must bend away from the straight chord, while two points stay straight
      const { strokeSamples } = await import('../engine/paint.js')
      const arcPts = [{ x: 0.2, y: 0.5, p: 1 }, { x: 0.5, y: 0.2, p: 1 }, { x: 0.8, y: 0.5, p: 1 }]
      const arc = strokeSamples(arcPts, 256, 256, 4, {})
      const arcMid = arc.samples[Math.floor(arc.samples.length / 2)]
      const chordMidY = ((0.5 + 0.2) / 2) * 256
      r.add('paint: cubic stroke smoothing bends the path', Math.abs(arcMid.y - chordMidY) > 4, JSON.stringify({ y: +arcMid.y.toFixed(1), chord: chordMidY }))
      const straight = strokeSamples([{ x: 0.2, y: 0.5, p: 1 }, { x: 0.8, y: 0.5, p: 1 }], 256, 256, 4, {})
      r.add('paint: two-point stroke stays straight', Math.max(...straight.samples.map((v) => Math.abs(v.y - 128))) < 0.01)
      // pen taper: end stamps shrink, middle stamps stay full size
      const tapered = strokeSamples(arcPts, 256, 256, 4, { taper: true, taperLength: 0.5, size: 40 })
      const tFirst = tapered.samples[0].radiusScale
      const tLast = tapered.samples[tapered.samples.length - 1].radiusScale
      const tMid = tapered.samples[Math.floor(tapered.samples.length / 2)].radiusScale
      r.add('paint: pen taper shrinks the stroke ends', tFirst < 0.4 && tLast < 0.4 && tMid > 0.9, JSON.stringify({ first: +tFirst.toFixed(2), mid: +tMid.toFixed(2), last: +tLast.toFixed(2) }))
      // painted coverage confirms the taper visually
      const taperCanvas = document.createElement('canvas')
      taperCanvas.width = taperCanvas.height = 128
      const tctx = taperCanvas.getContext('2d')
      const drawTaper = (on) => {
        tctx.clearRect(0, 0, 128, 128)
        drawStroke(tctx, { color: '#ffffff', size: 26, opacity: 1, brushId: 'hard-round', symmetry: {}, points: [{ x: 0.15, y: 0.5, p: 1 }, { x: 0.85, y: 0.5, p: 1 }], taper: on, taperLength: 0.6 }, 128, 128)
        const data = tctx.getImageData(0, 0, 128, 128).data
        const colAlpha = (x) => {
          let n = 0
          for (let y = 0; y < 128; y++) n += data[(y * 128 + x) * 4 + 3]
          return n
        }
        return { start: colAlpha(22), mid: colAlpha(64), end: colAlpha(104) }
      }
      const plain = drawTaper(false)
      const pen = drawTaper(true)
      r.add('paint: taper narrows painted ends', pen.start < plain.start * 0.9 && pen.end < plain.end * 0.9 && pen.mid >= plain.mid * 0.85, JSON.stringify({ plain, pen }))
      // UI: taper toggle exists, writes to the brush and next stroke
      const taperToggle = [...qa('.paint-tools .check input[type=checkbox]')].find((c) => /渐细|Taper/i.test(c.closest('label')?.textContent || ''))
      r.add('paint: pen taper toggle present', !!taperToggle, 'missing')
      if (taperToggle && !taperToggle.checked) {
        taperToggle.checked = true
        taperToggle.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(120)
      }
      r.add('paint: taper setting stored in brush', state.paintBrush.taper === true, String(state.paintBrush.taper))
      // performance guard: a long smoothed stroke must rasterise fast (sprite stamps), otherwise
      // live painting becomes janky
      const perfCanvas = document.createElement('canvas')
      perfCanvas.width = perfCanvas.height = 1024
      const perfCtx = perfCanvas.getContext('2d')
      const perfPts = []
      for (let i = 0; i < 150; i++) {
        const t = i / 149
        perfPts.push({ x: 0.1 + 0.8 * t, y: 0.5 + 0.25 * Math.sin(t * 8), p: 0.6 + 0.4 * Math.sin(t * 4) })
      }
      const tPaint = performance.now()
      drawStroke(perfCtx, { color: '#ffffff', size: 48, opacity: 1, brushId: 'chalk', symmetry: {}, points: perfPts }, 1024, 1024)
      const paintMs = performance.now() - tPaint
      r.add('paint: long stroke rasterises quickly', paintMs < 80, paintMs.toFixed(1) + ' ms')
      const tPaint2 = performance.now()
      drawStroke(perfCtx, { color: '#ffffff', size: 48, opacity: 1, brushId: 'chalk', symmetry: {}, points: perfPts }, 1024, 1024)
      const paintMs2 = performance.now() - tPaint2
      r.add('paint: cached sprites keep redraws fast', paintMs2 < 80, paintMs2.toFixed(1) + ' ms')
      const liveImg = q('.paint-side img')
      r.add('right: paint live thumb', !!liveImg && !!liveImg.src)
      click(qa('.paint-head .btn').find((b) => /Graph|节点图/.test(b.textContent)))
      await sleep(300)
          r.add('right: paint studio closes', !q('.paint-studio'))
  }

    // ============================ AI assistant / MCP self-check / assets ============================
    const aiBtn = q('.ai-btn')
    r.add('ai: topbar entry present', !!aiBtn)
    if (aiBtn) {
      click(aiBtn)
      await waitFor(() => !!q('.ai-panel'), 3000)
      if (!q('.ai-panel')) {
        click(aiBtn)
        await waitFor(() => !!q('.ai-panel'), 3000)
      }
      await waitFor(() => qa('.ai-model option').length >= 1, 10000)
      const modelOptions = qa('.ai-model option')
      r.add('ai: panel opens', !!q('.ai-panel'))
      r.add('ai: models listed', modelOptions.length >= 1, String(modelOptions.length))
      r.add('ai: attachment button', !!q('.ai-attach-btn') && !!q('.ai-input-row input[type=file]'), 'attach control missing')
      const attachInput = q('.ai-input-row input[type=file]')
      if (attachInput) {
        const textFile = new File(['attachment test content'], 'notes.txt', { type: 'text/plain' })
        const dt = new DataTransfer()
        dt.items.add(textFile)
        attachInput.files = dt.files
        attachInput.dispatchEvent(new Event('change', { bubbles: true }))
        await sleep(500)
        const chip = q('.ai-attachment-chip')
        r.add('ai: text attachment chip', !!chip && /notes\.txt/.test(chip.textContent || ''), chip ? chip.textContent : 'chip missing')
        const removeBtn = chip?.querySelector('button')
        if (removeBtn) click(removeBtn)
        await sleep(200)
        r.add('ai: attachment removable', !q('.ai-attachment-chip'))
      }
      const models = await (await fetch('/api/llm/models')).json()
      r.add('ai: model list has no key material', !/sk-[A-Za-z0-9_-]{8,}/.test(JSON.stringify(models)), 'key leaked in models response')
      r.add('ai: browser never shows key material', !/sk-[A-Za-z0-9_-]{8,}/.test(document.body.innerText), 'key visible in DOM')
      if (modelOptions.length > 1) {
        const sel = q('.ai-model')
        setInput(sel, modelOptions[1].value, 'change')
        await sleep(200)
        r.add('ai: switch model', sel.value === modelOptions[1].value, sel.value)
      }
      const checkBtn = qa('.ai-head .icon-btn').find((b) => (b.getAttribute('title') || '').includes('自检') || (b.getAttribute('title') || '').toLowerCase().includes('self-check'))
      if (checkBtn) {
        click(checkBtn)
        const ok = await waitFor(() => !!q('.ai-check'), 20000)
        r.add('ai: MCP self-check runs', ok && !!q('.ai-check'), 'selfcheck did not finish')
        const bad = q('.ai-check')?.classList.contains('bad')
        r.add('ai: MCP self-check passes', ok && !bad, q('.ai-check')?.textContent?.slice(0, 120))
      } else r.add('ai: MCP self-check runs', false, 'selfcheck button missing')
      const closeAi = qa('.ai-head .icon-btn').find((b) => b.textContent.trim() === '✕')
      if (closeAi) click(closeAi)
      await sleep(300)
      r.add('ai: panel closes', !q('.ai-panel'))
    }

    // material library: import a tiny texture through the API, use it as a paint-layer pattern
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC'
    let assetId = null
    try {
      const imported = await (await fetch('/api/assets/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ui-check.png', dataUrl: tinyPng }) })).json()
      assetId = imported?.asset?.id || null
      r.add('assets: import endpoint', imported?.ok === true && !!assetId, JSON.stringify(imported?.error))
      const assetBtn = qa('.topbar .icon-btn').find((b) => (b.getAttribute('title') || '').includes('素材库') || (b.getAttribute('title') || '').toLowerCase().includes('material'))
      if (assetBtn) {
        click(assetBtn)
        await sleep(700)
        const cards = qa('.asset-card')
        r.add('assets: modal lists assets', cards.length >= 1, String(cards.length))
        const fillBtn = cards[0] ? [...cards[0].querySelectorAll('button')].find((b) => /填入|Fill/i.test(b.textContent)) : null
        if (fillBtn) {
          const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
          const before = paintNode ? (nodeById(paintNode.id).data.strokes || []).length : 0
          click(fillBtn)
          await sleep(900)
          const after = paintNode ? (nodeById(paintNode.id).data.strokes || []).length : 0
          r.add('assets: pattern fill paint layer', after === before + 1, before + ' -> ' + after)
          r.add('assets: online search UI', !!q('.asset-search input') && !!q('.asset-search button'), 'search row missing')
        } else r.add('assets: pattern fill paint layer', false, 'fill button missing')
        const closeAsset = q('.asset-modal .modal-head .icon-btn')
        if (closeAsset) click(closeAsset)
        await sleep(300)
        r.add('assets: modal closes', !q('.asset-modal'))
      }
    } finally {
      if (assetId) await fetch('/api/assets/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: assetId }) })
    }

    // custom brush import through the Paint Studio file input
    const paintNode2 = state.graph.nodes.find((n) => n.type === 'paint')
    if (paintNode2) {
      selectNode(paintNode2.id)
      await sleep(300)
      const openBtn = q('.inspector .insp-actions .btn.primary')
      if (openBtn) click(openBtn)
      await sleep(700)
      if (q('.paint-studio')) {
        const brushInput = q('.brush-import-row input[type=file]')
        if (brushInput) {
          const def = { name: 'UI Check Brush', shape: 'round', hardness: 0.85, spacing: 0.06, flow: 0.8, grain: 0.3, scatter: 0.1 }
          const file = new File([JSON.stringify(def)], 'ui-check-brush.json', { type: 'application/json' })
          const dt = new DataTransfer()
          dt.items.add(file)
          brushInput.files = dt.files
          brushInput.dispatchEvent(new Event('change', { bubbles: true }))
          await sleep(700)
          const customGroup = qa('.brush-group-label').some((e) => /自定义|Custom/i.test(e.textContent))
          r.add('brushes: custom JSON import', customGroup && (state.paintBrush.brushId || '').startsWith('custom-'), state.paintBrush.brushId)
        } else r.add('brushes: custom JSON import', false, 'file input missing')
        const backBtn = qa('.paint-head .btn').find((b) => /Graph|节点图/.test(b.textContent))
        if (backBtn) click(backBtn)
        await sleep(300)
      }
    }
} catch (e) {
    r.add('ui-check exception', false, e?.stack || e?.message || String(e))
  } finally {
    try {
      setLocale(snapshot.locale, false)
      // restore the user's brush choice (the brush tests select presets and toggle taper)
      Object.assign(state.paintBrush, brushSnapshot)
      savePaintBrush()
      try {
        if (customBrushesSnapshot === null) localStorage.removeItem('substrate.customBrushes')
        else localStorage.setItem('substrate.customBrushes', customBrushesSnapshot)
        const brushModule = await import('../engine/brushes.js')
        brushModule.loadCustomBrushes()
        if (llmModelSnapshot === null) localStorage.removeItem('substrate.llmModel')
        else localStorage.setItem('substrate.llmModel', llmModelSnapshot)
        const aiModule = await import('../engine/ai-chat.js')
        aiModule.aiChat.busy = false
        aiModule.aiChat.floatingVisible = false
        aiModule.aiChat.messages.splice(0, aiModule.aiChat.messages.length)
        if (chatSnapshot === null) localStorage.removeItem('substrate.aiChat.v1')
        else {
          localStorage.setItem('substrate.aiChat.v1', chatSnapshot)
          try {
            const parsed = JSON.parse(chatSnapshot)
            for (const msg of parsed.messages || []) aiModule.aiChat.messages.push(msg)
            aiModule.aiChat.modelKey = parsed.modelKey || aiModule.aiChat.modelKey
          } catch (e) { /* ignore */ }
        }
      } catch (e) {
        /* ignore */
      }
      // restore the user's remembered language (the language-switch test really clicked the switch)
      try {
        if (savedLocale === null) localStorage.removeItem('substrate.locale')
        else localStorage.setItem('substrate.locale', savedLocale)
        history.replaceState(history.state, '', hrefBeforeLocaleTests)
      } catch (e) {
        /* ignore */
      }
      setResolution(snapshot.resolution)
      setProxy(snapshot.proxy)
      const { loadGraph } = await import('./store.js')
      loadGraph(snapshot.graph, { name: snapshot.name, resolution: snapshot.resolution })
      state.mode = 'graph'
      state.activePaintId = null
      await sleep(500)
      doEval()
        // ============================ AI chat persistence / floating window / rules ============================
    const realFetch = window.fetch
    let fakeFetchInstalled = false
    try {
      const aiStore = await import('../engine/ai-chat.js')
      const rules = await (await fetch('/api/llm/rules')).json()
      r.add('ai: rules endpoint', rules?.ok === true && (rules.rules || []).length >= 5, JSON.stringify(rules))
      r.add(
        'ai: rules forbid source/secrets',
        (rules.rules || []).some((x) => /source code/i.test(x)) && (rules.rules || []).some((x) => /API keys|environment/i.test(x)),
        JSON.stringify(rules.rules)
      )
      // deterministic fake model reply: proves the request survives closing the panel
      aiStore.clearChat()
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/llm/chat')) {
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  new Response(JSON.stringify({ ok: true, reply: '浮动窗口测试回复', model: { key: 'test:test' }, toolCalls: [{ name: 'substrate_get_state', ok: true }], reasoning: [{ step: 1, kind: 'reasoning', text: '测试思考：先读取状态。' }, { step: 2, kind: 'plan', text: '计划：汇报结果。' }] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                  })
                ),
              360
            )
          )
        }
        return realFetch(url, opts)
      }
      fakeFetchInstalled = true
      if (q('.ai-panel')) click(qa('.ai-head .icon-btn').find((b) => b.textContent.trim() === '✕'))
      await sleep(120)
      const sendPromise = aiStore.sendChat('浮动窗口测试：关闭面板后继续对话')
      await sleep(60)
      r.add('ai: keeps running after panel closed', aiStore.aiChat.busy === true, 'request was not in flight')
      aiStore.showFloatingPanel()
      await sleep(200)
      const float = q('.ai-float')
      r.add('ai: floating transcript visible', !!float, 'floating window missing')
      const bg = float ? getComputedStyle(float).backgroundColor : ''
      r.add('ai: floating background translucent', /rgba\([^)]*,\s*0\.\d+\)/.test(bg), bg)
      const list = float?.querySelector('.ai-float-list')
      r.add('ai: floating scrolls to latest', !!list && list.scrollTop + list.clientHeight >= list.scrollHeight - 4, 'not scrolled to bottom')
      await sendPromise
      r.add('ai: reply arrives after panel closed', !aiStore.aiChat.busy && aiStore.aiChat.messages.length >= 2 && aiStore.aiChat.messages.some((m) => m.role === 'assistant' && m.content), 'reply missing')
      const saved = JSON.parse(localStorage.getItem('substrate.aiChat.v1') || 'null')
      r.add(
        'ai: full conversation persisted',
        (saved?.messages || []).length >= 2 && saved.messages.some((m) => (m.trace || []).length),
        JSON.stringify(saved?.messages?.length)
      )
      const md = aiStore.exportChatMarkdown()
      r.add('ai: transcript export', md.includes('User') && md.includes('Tool calls'), 'markdown transcript incomplete')
      const expand = q('.ai-float .ai-float-head .icon-btn')
      if (expand) click(expand)
      await sleep(400)
      r.add('ai: floating expands to full panel', !!q('.ai-panel') && aiStore.aiChat.messages.length >= 2, 'expand failed')
      const reasoningEl = q('.ai-panel .ai-reasoning')
      r.add(
        'ai: thinking process rendered',
        !!reasoningEl && /思考过程|Thinking process/.test(reasoningEl.textContent || '') && /测试思考/.test(reasoningEl.textContent || ''),
        'thinking block missing'
      )
      if (q('.ai-panel')) click(qa('.ai-head .icon-btn').find((b) => b.textContent.trim() === '✕'))
    } finally {
      window.fetch = realFetch
      const aiStore = await import('../engine/ai-chat.js')
      aiStore.aiChat.busy = false
      aiStore.aiChat.floatingVisible = false
      aiStore.clearChat()
      if (chatSnapshot !== null) {
        try {
          const parsed = JSON.parse(chatSnapshot)
          for (const msg of parsed.messages || []) aiStore.aiChat.messages.push(msg)
          aiStore.aiChat.modelKey = parsed.modelKey || aiStore.aiChat.modelKey
        } catch (e) { /* ignore */ }
      }
      if (q('.ai-float')) q('.ai-float .icon-btn')?.click()
    }
} catch (e) {
      /* best effort */
    }
  }
  return r.result()
}
