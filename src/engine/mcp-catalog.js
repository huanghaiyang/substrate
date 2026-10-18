// Canonical external tool catalog for the Substrate MCP gateway.
//
// This module is shared by the browser (command validation + execution), the HTTP gateway in
// server/index.js and the stdio MCP server in mcp/server.mjs, so the external interface is
// defined exactly once: stable snake_case tool names, JSON-Schema inputs, annotations,
// timeout hints, an explicit API version and a normalized result envelope.

export const API_VERSION = '1.0.0'
export const PROTOCOL_VERSION = '2025-03-26'

export const ERROR_CODES = {
  APP_NOT_CONNECTED: 'APP_NOT_CONNECTED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  EVAL_FAILED: 'EVAL_FAILED',
  EXPORT_FAILED: 'EXPORT_FAILED',
  TIMEOUT: 'TIMEOUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL: 'INTERNAL',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL'
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

const RESOLUTIONS = [256, 512, 1024, 2048, 4096]
const PRESETS = ['gltf', 'unreal', 'unity', 'vray', 'substance']
const DEMOS = ['weathered-steel', 'mossy-rock', 'painted-sign', 'blank']

const point = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    p: { type: 'number', minimum: 0, maximum: 1, description: 'Pressure (0-1)' }
  },
  required: ['x', 'y']
}

export const TOOLS = [
  {
    name: 'substrate_get_state',
    title: 'Get Studio State',
    description:
      'Read the current studio state: material name, mode, resolution/proxy, node and link counts, PBR output wiring, evaluation statistics, selection, undo/redo depth and the active locale.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    timeoutMs: 15000
  },
  {
    name: 'substrate_get_graph',
    title: 'Get Node Graph',
    description:
      'Return the full node graph (nodes with id, type, position and parameters; connections with ids and ports) plus the output node id. Thumbnails are omitted to keep the payload small.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    timeoutMs: 15000
  },
  {
    name: 'substrate_list_demos',
    title: 'List Demo Materials',
    description: 'List the built-in demo materials that can be loaded with substrate_load_demo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    timeoutMs: 10000
  },
  {
    name: 'substrate_list_projects',
    title: 'List Saved Projects',
    description: 'List the user projects saved on the local Node server (name, resolution, modification time).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    timeoutMs: 15000
  },
  {
    name: 'substrate_get_thumbnail',
    title: 'Get Node Thumbnail',
    description:
      'Return a node thumbnail as a PNG data URL (96 px). Defaults to the output node so agents can visually inspect the current material.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node id (defaults to the output node)' }
      },
      additionalProperties: false
    },
    annotations: readOnly,
    timeoutMs: 15000
  },
  {
    name: 'substrate_get_preview',
    title: 'Get Material Preview',
    description:
      'Capture a PNG data URL of the preview: view="2d" renders one PBR channel (basecolor, height, normal, roughness, metallic, ao, emissive, opacity); view="3d" renders the shaded material ball viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['2d', '3d'], description: 'Preview kind (default 2d)' },
        channel: {
          type: 'string',
          enum: ['basecolor', 'height', 'normal', 'roughness', 'metallic', 'ao', 'emissive', 'opacity'],
          description: 'Channel for view="2d" (default basecolor)'
        },
        size: { type: 'integer', minimum: 64, maximum: 512, description: 'Output size in pixels (default 256)' }
      },
      additionalProperties: false
    },
    annotations: readOnly,
    timeoutMs: 30000
  },
  {
    name: 'substrate_evaluate',
    title: 'Re-evaluate Graph',
    description: 'Force a full graph evaluation and return timing/pass/cache statistics plus any evaluation error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { ...readOnly, readOnlyHint: false, idempotentHint: true },
    timeoutMs: 60000
  },
  {
    name: 'substrate_run_selftest',
    title: 'Run Engine Self-Test',
    description:
      'Run the shader/graph/export self-test (GLSL compilation for every node, per-channel checks, normal validity, seamless tiling, thumbnail generation). Returns pass/fail counts and failures; use resolution 256 for a fast check.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: { type: 'integer', enum: [256, 512], description: 'Working resolution (default 512)' }
      },
      additionalProperties: false
    },
    annotations: readOnly,
    timeoutMs: 240000
  },
  {
    name: 'substrate_run_audit',
    title: 'Run Application Audit',
    description:
      'Run the in-app audit suite (node schemas, rendering, value semantics, store actions, DOM interactions, i18n). Returns per-section pass/fail counts. Sections: all, schema, render, values, actions, dom, i18n, ui.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'schema', 'render', 'values', 'actions', 'dom', 'i18n', 'ui'],
          description: 'Audit section (default all)'
        }
      },
      additionalProperties: false
    },
    annotations: readOnly,
    timeoutMs: 360000
  },
  {
    name: 'substrate_load_demo',
    title: 'Load Demo Material',
    description: 'Load a built-in demo material (replaces the current graph).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', enum: DEMOS, description: 'Demo id' } },
      required: ['id'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_new_project',
    title: 'New Material',
    description: 'Start a new empty material graph (output node only).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_add_node',
    title: 'Add Node',
    description:
      'Add a node of the given type (see the node library types such as perlin, blend, gradient_map, normal, ao, paint, material_output). Returns the new node id.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Node type, e.g. "perlin" or "blend"' },
        x: { type: 'number', description: 'Optional graph x position' },
        y: { type: 'number', description: 'Optional graph y position' }
      },
      required: ['type'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_delete_node',
    title: 'Delete Node',
    description: 'Delete a node and all of its connections.',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'Node id' } },
      required: ['nodeId'],
      additionalProperties: false
    },
    annotations: destructive,
    timeoutMs: 30000
  },
  {
    name: 'substrate_duplicate_node',
    title: 'Duplicate Node',
    description: 'Duplicate a node (parameters, title and connections are preserved for the copy where valid).',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'Node id' } },
      required: ['nodeId'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_move_node',
    title: 'Move Node',
    description: 'Set a node position in graph coordinates (does not change the material).',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node id' },
        x: { type: 'number' },
        y: { type: 'number' }
      },
      required: ['nodeId', 'x', 'y'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 15000
  },
  {
    name: 'substrate_connect',
    title: 'Connect Nodes',
    description:
      'Connect a source node output to a target node input port. Outputs are RGBA streams; toPort is the input port name (e.g. "basecolor", "height", "roughness", "a", "b"). Returns the connection id.',
    inputSchema: {
      type: 'object',
      properties: {
        fromNode: { type: 'string', description: 'Source node id' },
        fromPort: { type: 'string', description: 'Source output port (default "out")' },
        toNode: { type: 'string', description: 'Target node id' },
        toPort: { type: 'string', description: 'Target input port name' }
      },
      required: ['fromNode', 'toNode', 'toPort'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 15000
  },
  {
    name: 'substrate_disconnect',
    title: 'Disconnect Link',
    description: 'Remove a connection by id.',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string', description: 'Connection id' } },
      required: ['connectionId'],
      additionalProperties: false
    },
    annotations: destructive,
    timeoutMs: 15000
  },
  {
    name: 'substrate_set_param',
    title: 'Set Node Parameter',
    description:
      'Set any node parameter by key (numbers, strings, colors "#rrggbb", vectors as objects [x,y,z], gradients as stop arrays). Triggers an evaluation.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node id' },
        key: { type: 'string', description: 'Parameter key' },
        value: { description: 'Parameter value (number, string, boolean, array or object)' }
      },
      required: ['nodeId', 'key', 'value'],
      additionalProperties: false
    },
    annotations: { ...write, idempotentHint: true },
    timeoutMs: 60000
  },
  {
    name: 'substrate_set_resolution',
    title: 'Set Resolution / Proxy',
    description: 'Set the document resolution (256-4096) and/or the evaluation proxy factor (0.5, 0.75, 1).',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: { type: 'integer', enum: RESOLUTIONS, description: 'Document resolution' },
        proxy: { type: 'number', enum: [0.5, 0.75, 1], description: 'Evaluation proxy' }
      },
      additionalProperties: false
    },
    annotations: { ...write, idempotentHint: true },
    timeoutMs: 30000
  },
  {
    name: 'substrate_set_locale',
    title: 'Set Interface Language',
    description: 'Switch the UI language to English or Chinese without changing the stored user preference.',
    inputSchema: {
      type: 'object',
      properties: { locale: { type: 'string', enum: ['en', 'zh'] } },
      required: ['locale'],
      additionalProperties: false
    },
    annotations: { ...write, idempotentHint: true },
    timeoutMs: 15000
  },
  {
    name: 'substrate_history',
    title: 'Undo / Redo',
    description: 'Apply one undo or redo step to the graph.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['undo', 'redo'] } },
      required: ['action'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_paint_stroke',
    title: 'Paint Stroke',
    description:
      'Commit a brush stroke to a paint layer node (default: the first paint node). Points are normalized canvas coordinates. Returns the stroke count and the paint node id.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Paint node id (optional)' },
        points: { type: 'array', items: point, minItems: 1, maxItems: 4096 },
        brushId: { type: 'string', description: 'Brush preset id, e.g. soft-round, chalk, grass, leaf, flower, tree, fern, branch' },
        color: { type: 'string', description: 'Stroke color "#rrggbb"' },
        size: { type: 'number', minimum: 1, maximum: 256 },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        hardness: { type: 'number', minimum: 0, maximum: 1 },
        flow: { type: 'number', minimum: 0.01, maximum: 1 },
        spacing: { type: 'number', minimum: 0.01, maximum: 1 },
        taper: { type: 'boolean', description: 'Enable pen taper on this stroke' },
        taperLength: { type: 'number', minimum: 0.05, maximum: 1 },
        erase: { type: 'boolean', description: 'Erase instead of paint' },
        symmetry: {
          type: 'object',
          properties: { x: { type: 'boolean' }, y: { type: 'boolean' } },
          additionalProperties: false
        }
      },
      required: ['points'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 60000
  },
  {
    name: 'substrate_clear_paint',
    title: 'Clear Paint Layer',
    description: 'Remove all strokes from a paint layer node.',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'Paint node id (optional)' } },
      additionalProperties: false
    },
    annotations: destructive,
    timeoutMs: 30000
  },
  {
    name: 'substrate_export',
    title: 'Export Material',
    description:
      'Bake and export a standards-compliant material package (PNG maps + manifest + README + zip) to the local exports/ folder. Returns the server folder, zip path, manifest and per-file sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: PRESETS, description: 'Channel packing preset (default gltf)' },
        resolution: { type: 'integer', enum: RESOLUTIONS, description: 'Export resolution (default 1024)' },
        name: { type: 'string', description: 'Material name (defaults to the output node material name)' },
        height16: { type: 'boolean', description: '16-bit height map (default true)' },
        normalConvention: { type: 'string', enum: ['gl', 'dx'], description: 'Normal map convention (default from the output node)' },
        alphaMode: { type: 'integer', enum: [0, 1, 2], description: 'Alpha mode: 0 opaque, 1 masked, 2 blended' }
      },
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 300000
  },
  {
    name: 'substrate_save_project',
    title: 'Save Project',
    description: 'Save the current graph to a project file on the local server.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name (defaults to the current material name)' } },
      additionalProperties: false
    },
    annotations: { ...write, idempotentHint: true },
    timeoutMs: 30000
  },
  {
    name: 'substrate_load_project',
    title: 'Load Project',
    description: 'Load a saved project by name (see substrate_list_projects).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 30000
  },
  {
    name: 'substrate_delete_project',
    title: 'Delete Project',
    description: 'Delete a saved project by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    },
    annotations: destructive,
    timeoutMs: 15000
  }
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

export function getTool(name) {
  return TOOLS_BY_NAME.get(name) || null
}

export function publicCatalog(extra = {}) {
  return {
    ok: true,
    apiVersion: API_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    service: 'substrate-texture-designer',
    ...extra,
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      timeoutMs: t.timeoutMs
    }))
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/** Strict, dependency-free validation of the small JSON-Schema subset used above. */
export function validateArguments(name, args) {
  const tool = getTool(name)
  if (!tool) {
    const err = new Error('Unknown tool: ' + name)
    err.code = ERROR_CODES.UNKNOWN_TOOL
    throw err
  }
  if (args === undefined || args === null) args = {}
  if (typeOf(args) !== 'object') {
    const err = new Error('arguments must be an object')
    err.code = ERROR_CODES.INVALID_ARGUMENT
    throw err
  }
  const schema = tool.inputSchema || { type: 'object', properties: {} }
  const required = schema.required || []
  for (const key of required) {
    if (args[key] === undefined) {
      const err = new Error(`Missing required argument "${key}" for ${name}`)
      err.code = ERROR_CODES.INVALID_ARGUMENT
      throw err
    }
  }
  const props = schema.properties || {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const prop = props[key]
    if (!prop) {
      if (schema.additionalProperties === false) {
        const err = new Error(`Unknown argument "${key}" for ${name}`)
        err.code = ERROR_CODES.INVALID_ARGUMENT
        throw err
      }
      continue
    }
    const t = prop.type
    if (t) {
      const actual = typeOf(value)
      if (t === 'integer') {
        if (actual !== 'number' || !Number.isInteger(value)) {
          const err = new Error(`Argument "${key}" must be an integer`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
      } else if (t === 'number') {
        if (actual !== 'number' || !Number.isFinite(value)) {
          const err = new Error(`Argument "${key}" must be a finite number`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
      } else if (t === 'array') {
        if (actual !== 'array') {
          const err = new Error(`Argument "${key}" must be an array`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
        if (prop.minItems !== undefined && value.length < prop.minItems) {
          const err = new Error(`Argument "${key}" needs at least ${prop.minItems} items`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
        if (prop.maxItems !== undefined && value.length > prop.maxItems) {
          const err = new Error(`Argument "${key}" has too many items (max ${prop.maxItems})`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
      } else if (t === 'object') {
        if (actual !== 'object') {
          const err = new Error(`Argument "${key}" must be an object`)
          err.code = ERROR_CODES.INVALID_ARGUMENT
          throw err
        }
      } else if (actual !== t) {
        const err = new Error(`Argument "${key}" must be of type ${t}`)
        err.code = ERROR_CODES.INVALID_ARGUMENT
        throw err
      }
    }
    if (prop.type === 'number' || prop.type === 'integer') {
      if (prop.minimum !== undefined && value < prop.minimum) {
        const err = new Error(`Argument "${key}" must be >= ${prop.minimum}`)
        err.code = ERROR_CODES.INVALID_ARGUMENT
        throw err
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        const err = new Error(`Argument "${key}" must be <= ${prop.maximum}`)
        err.code = ERROR_CODES.INVALID_ARGUMENT
        throw err
      }
    }
    if (prop.enum && !prop.enum.includes(value)) {
      const err = new Error(`Argument "${key}" must be one of ${prop.enum.join(', ')}`)
      err.code = ERROR_CODES.INVALID_ARGUMENT
      throw err
    }
  }
  return args
}

export function toolTimeout(name, requested) {
  const tool = getTool(name)
  const max = tool?.timeoutMs || 30000
  const requestedMs = Number(requested)
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return max
  return Math.min(max, Math.max(1000, Math.round(requestedMs)))
}
