// WebMCP tool registration — lets agent harnesses drive and verify the studio.
import { state, loadDemo, outputNode, requestEval, nodeById, commitStroke, paintCanvasFor } from './store.js'
import { runSelfTest, runExportTest } from './selftest.js'

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

const OUTPUT_PORTS = ['basecolor', 'height', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity']

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
      const paintNode = state.graph.nodes.find((n) => n.type === 'paint')
      if (!paintNode) return { ok: false, error: 'No paint node in the current material' }
      const before = (paintNode.data.strokes || []).length
      const added = demoStrokes(Math.max(1, Math.min(24, Number(input?.strokes) || 6)))
      for (const stroke of added) commitStroke(paintNode.id, stroke)
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

export function registerTools(engine) {
  const api =
    (typeof document !== 'undefined' && document.modelContext) ||
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    null
  if (!api) {
    console.info('[substrate] WebMCP API not available — use window.__SUBSTRATE__ for automation')
    return false
  }
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
