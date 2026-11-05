/**
 * WebMCP 工具注册：让外部代理框架能直接驱动并验证这个贴图工作室。
 *
 * 架构位置：与 mcp-catalog / mcp-commands 那套“MCP 网关工具”并行存在——
 * 后者面向外部 MCP 客户端（stdio / HTTP JSON-RPC），本模块面向浏览器内置的
 * WebMCP API（document.modelContext / navigator.modelContext）。
 * 两套工具名互不冲突（本模块用 substrate_state / substrate_paint 等较短的命名），
 * 且统一带 substrate_ 前缀，避免与宿主环境中的其他工具重名。
 *
 * 若宿主浏览器未提供 WebMCP API，则只打印提示并返回 false，
 * 自动化仍可通过 window.__SUBSTRATE__ 走同一批底层能力。
 *
 * 主要导出：registerTools。
 */
import { state, loadDemo, outputNode, requestEval, nodeById, commitStroke, paintCanvasFor } from './store.js'
import { runSelfTest, runExportTest } from './selftest.js'

/**
 * 生成当前工作室的状态摘要（substrate_state 工具的返回体）。
 *
 * 内容：项目名、模式、分辨率、节点/连线数、输出节点配置（材质名、法线约定、alpha 模式、
 * 已连通的输出通道）、求值统计（节点数/pass 数/耗时/缓存命中/错误）、历史标签与撤销重做深度、当前选中。
 *
 * @returns {object} 状态摘要
 */
function summarize() {
  const out = outputNode()
  return {
    demo: state.projectName,
    mode: state.mode,
    resolution: state.resolution,
    nodes: state.graph.nodes.length,
    connections: state.graph.connections.length,
    output: out
      ? {
          id: out.id,
          materialName: out.params.materialName,
          normalConvention: Number(out.params.normalConvention) === 1 ? 'DirectX' : 'OpenGL',
          alphaMode: Number(out.params.alphaMode),
          connected: (OUTPUT_PORTS || []).filter((p) => state.graph.connections.some((c) => c.to.node === out.id && c.to.port === p))
        }
      : null,
    eval: {
      nodes: state.evalNodes,
      passes: state.evalPasses,
      ms: state.lastEvalMs,
      cacheHits: state.cacheHits,
      error: state.error
    },
    history: state.historyLabel,
    undo: state.undoStack.length,
    redo: state.redoStack.length,
    selected: state.selectedIds
  }
}

// 材质输出节点支持的全部 PBR 通道名，用于判断哪些通道已被连线占用
const OUTPUT_PORTS = ['basecolor', 'height', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity']

/**
 * 生成一组用于测试画笔管线的示例笔迹。
 *
 * 每条笔迹是 21 个采样点的正弦曲线（相位逐条偏移，形成错落的弧线），
 * 压感随 t 呈正弦分布（两端细、中间粗）；颜色/尺寸按序号循环变化，
 * 偶数条开启水平对称，便于同时验证对称绘制逻辑。
 *
 * @param {number} [count=6] 笔迹条数
 * @returns {Array<object>} 可直接传给 commitStroke 的笔迹数组
 */
function demoStrokes(count = 6) {
  const strokes = []
  for (let i = 0; i < count; i++) {
    const pts = []
    const phase = i * 0.9
    for (let k = 0; k <= 20; k++) {
      const t = k / 20
      pts.push({
        x: 0.2 + 0.6 * t,
        y: 0.25 + 0.5 * t + 0.12 * Math.sin(phase + t * 6),
        p: 0.45 + 0.55 * Math.sin(t * Math.PI)
      })
    }
    strokes.push({
      color: ['#e0574a', '#58b7ff', '#f2a541'][i % 3],
      size: 26 + i * 9,
      opacity: 0.85,
      hardness: 0.6,
      erase: false,
      symmetry: { x: i % 2 === 0, y: false },
      points: pts
    })
  }
  return strokes
}

/**
 * 对外暴露的 WebMCP 工具定义列表。
 *
 * 每个工具包含 name / description / inputSchema（WebMCP 约定的 JSON-Schema）/
 * execute(input, engine)；description 会直接交给代理模型，因此保持英文原文不改写。
 * 覆盖的能力：读状态、跑引擎自检、导出材质包、载入示例、程序化绘画。
 */
const TOOLS = [
  {
    name: 'substrate_state',
    description:
      'Return the current Substrate Texture Studio state: material, node/link counts, PBR output wiring, evaluation stats, selection and history.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => summarize()
  },
  {
    name: 'substrate_selftest',
    description:
      'Run the full engine self-test: GLSL compile audit for every node, graph evaluation, per-channel statistics, normal-map validation, seamless-tiling seam ratios and thumbnail generation. Returns a PASS/FAIL report.',
    inputSchema: {
      type: 'object',
      properties: { resolution: { type: 'number', description: 'Working resolution for the test (default 512)' } }
    },
    execute: async (input, engine) => {
      const report = await runSelfTest(engine, { resolution: Number(input?.resolution) || 512 })
      return report
    }
  },
  {
    name: 'substrate_export',
    description:
      'Bake the current graph and export a standards-compliant material package (PNG maps + manifest.json + README.md + zip) to the Node server. Returns file names, sizes, PNG signatures, server folder and zip URL.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['gltf', 'unreal', 'unity', 'vray', 'substance'], description: 'Channel packing preset' },
        resolution: { type: 'number', description: 'Export resolution (default 512 for tests, UI default 2048)' }
      }
    },
    execute: async (input, engine) => {
      const result = await runExportTest(engine, {
        preset: input?.preset || 'gltf',
        resolution: Number(input?.resolution) || 512
      })
      return result
    }
  },
  {
    name: 'substrate_load_demo',
    description: 'Load one of the built-in demo materials (weathered-steel, mossy-rock, painted-sign, blank).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Demo id' } },
      required: ['id']
    },
    execute: async (input) => {
      // 载入示例是同步的，但预览/求值是异步的；固定等待 350ms 后再取状态，避免读到中间态
      loadDemo(input.id)
      await new Promise((r) => setTimeout(r, 350))
      return summarize()
    }
  },
  {
    name: 'substrate_paint',
    description:
      'Programmatically add brush strokes to the paint node of the current material, then re-evaluate. Verifies the painting pipeline (CPU rasterisation → GPU node stream → downstream maps).',
    inputSchema: {
      type: 'object',
      properties: { strokes: { type: 'number', description: 'Number of test strokes to add (default 6)' } }
    },
    execute: async (input) => {
      // 必须已有画笔节点；笔迹数量夹紧到 1..24，防止一次提交过多数据
      const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
      if (!paintNode) return { ok: false, error: 'No paint node in the current material' }
      const before = (paintNode.data.strokes || []).length
      const added = demoStrokes(Math.max(1, Math.min(24, Number(input?.strokes) || 6)))
      for (const stroke of added) commitStroke(paintNode.id, stroke)
      // 提交后重新取画布引用（commitStroke 可能替换画布对象）并强制求值
      paintCanvasFor(paintNode.id)
      requestEval(true)
      await new Promise((r) => setTimeout(r, 450))
      return {
        ok: true,
        nodeId: paintNode.id,
        strokesBefore: before,
        strokesAfter: (paintNode.data.strokes || []).length,
        thumbLength: (paintNode._thumb || '').length,
        eval: summarize().eval
      }
    }
  }
]

/**
 * 把工具列表注册到宿主浏览器的 WebMCP API。
 *
 * 兼容三种历史/变体 API 形态：registerTool（逐个注册）、
 * provideContext({ tools }) 与 provideTools（批量注册）。
 * 找不到任何入口或注册抛错时返回 false，且不会中断页面其余功能。
 *
 * @param {object} engine 引擎实例，会绑定到每个工具的执行上下文
 * @returns {boolean} 是否成功注册
 */
export function registerTools(engine) {
  // WebMCP 的标准入口可能在 document 或 navigator 上，二者都探测一次
  const api =
    (typeof document !== 'undefined' && document.modelContext) ||
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    null
  if (!api) {
    console.info('[substrate] WebMCP API not available — use window.__SUBSTRATE__ for automation')
    return false
  }
  // 统一注入 engine：WebMCP 调用方不传引擎，由注册阶段绑定，
  // 这样同一份 TOOLS 定义可被不同引擎实例复用
  const wrapped = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input) => tool.execute(input || {}, engine)
  }))
  try {
    if (typeof api.registerTool === 'function') {
      for (const tool of wrapped) api.registerTool(tool)
    } else if (typeof api.provideContext === 'function') {
      api.provideContext({ tools: wrapped })
    } else if (typeof api.provideTools === 'function') {
      api.provideTools(wrapped)
    } else {
      return false
    }
    console.info('[substrate] registered', wrapped.length, 'WebMCP tools')
    return true
  } catch (e) {
    console.warn('[substrate] WebMCP registration failed', e)
    return false
  }
}
