/**
 * Substrate MCP 网关的权威外部工具目录。
 *
 * 架构位置：本模块被三处共享——浏览器端（参数校验 + 工具执行）、server/index.js 的 HTTP
 * 网关、以及 mcp/server.mjs 的 stdio MCP 服务。因此外部接口只在此定义一次：
 * 稳定的 snake_case 工具名、JSON-Schema 输入、annotations 安全标注、超时提示、
 * 显式 API 版本以及统一的返回信封结构。
 *
 * 注意：各工具的 title / description / inputSchema 会原样下发给外部代理（LLM），
 * 属于对外契约文本，不要随意改写。
 *
 * 主要导出：API_VERSION、PROTOCOL_VERSION、ERROR_CODES、TOOLS、TOOL_EXAMPLES、
 * TOOLS_BY_NAME、getTool、publicCatalog、validateArguments、toolTimeout。
 */

/** 本目录自身的接口版本号；服务端与客户端通过它判断兼容性。 */
export const API_VERSION = '1.0.0'
/** 对外暴露的 MCP 协议版本（与 API 版本独立演进）。 */
export const PROTOCOL_VERSION = '2025-03-26'

/**
 * 全局错误码枚举。所有工具失败时都应使用这里的取值，外部客户端可据此做分支处理。
 */
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

// MCP 工具安全标注的三种预设（供各工具通过 annotations 字段复用）：
// - readOnly：只读、幂等、不破坏数据（查询类工具）
// - write：会修改图/文件，但不删除已有内容、且非幂等（新建、连线、设参数）
// - destructive：会删除已有数据（删除节点/连线/项目、清空画笔层）
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

// 供工具 schema 复用的枚举取值：文档分辨率档位、导出通道打包预设、内置示例材质 id
const RESOLUTIONS = [256, 512, 1024, 2048, 4096]
const PRESETS = ['gltf', 'unreal', 'unity', 'vray', 'substance']
const DEMOS = ['weathered-steel', 'mossy-rock', 'painted-sign', 'blank']

// 画笔轨迹的单个采样点 schema：x/y 为 0..1 的归一化画布坐标，p 为压感（0..1）
const point = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    p: { type: 'number', minimum: 0, maximum: 1, description: 'Pressure (0-1)' }
  },
  required: ['x', 'y']
}

/**
 * 对外暴露的工具清单。
 *
 * 每一项的字段含义：
 * - name：稳定的 snake_case 工具名，作为协议层唯一标识；
 * - title：给人类看的短标题（可用于 UI 展示）；
 * - description：下发给代理的自然语言说明，决定模型何时选用该工具；
 * - inputSchema：仅使用一组受限 JSON-Schema 子集（type / properties / required /
 *   additionalProperties / enum / minimum / maximum / minLength / maxLength /
 *   minItems / maxItems / items），由下方 validateArguments 做零依赖校验；
 * - annotations：MCP 安全标注，帮助客户端判断是否自动执行；
 * - timeoutMs：该工具在网关侧的默认超时上限（求值/导出类工具更长）。
 *
 * 工具按用途大致分区：状态与查询 → 素材库 → 预览/评估 → 自检与审计 →
 * 图编辑（节点/连线/参数）→ 绘制 → 导出与项目管理。
 */
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
      'Return the full node graph (nodes with id, type, position, inputPorts and parameters; connections with ids and ports) plus the output node id. Use inputPorts to choose valid toPort values for substrate_connect. Thumbnails are omitted to keep the payload small.',
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
  // —— 素材库：在线检索开放版权图片、导入 URL、列出/应用本地素材 ——
  {
    name: 'substrate_search_open_assets',
    title: 'Search Online Materials',
    description:
      'Search openly licensed image/texture sources (Openverse, Wikimedia Commons, and optional Pexels/Pixabay/Unsplash providers) for material reference images. Returns title, creator, license, source and thumbnail/download URLs. Attribution must be kept when using a result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Search terms, e.g. "rusty metal plate" or "moss stone"' },
        limit: { type: 'integer', minimum: 1, maximum: 24, description: 'Max results (default 12)' }
      },
      required: ['query'],
      additionalProperties: false
    },
    annotations: readOnly,
    timeoutMs: 45000
  },
  {
    name: 'substrate_list_assets',
    title: 'List Material Assets',
    description:
      'List images in the material library (id, name, url, dimensions, attribution). Use it to find images uploaded in the AI chat or imported by the user, then substrate_apply_asset to use one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    timeoutMs: 15000
  },
  {
    name: 'substrate_apply_asset',
    title: 'Apply Material Asset',
    description:
      'Use an existing material-library asset: target "texture" loads it into a Texture Input node (created if missing), target "paint" fills the paint layer with it as a repeating pattern. Accepts assetId or name.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset id from substrate_list_assets' },
        name: { type: 'string', description: 'Asset name (alternative to assetId)' },
        target: { type: 'string', enum: ['texture', 'paint'], description: 'Where to apply the asset (default texture)' }
      },
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 60000
  },
  {
    name: 'substrate_import_asset_url',
    title: 'Import Online Material',
    description:
      'Download one image URL into the local material library (PNG/JPEG/WebP, max 32 MB, public http(s) only). Pass attribution fields from substrate_search_open_assets so the license/creator is stored with the asset.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 8, description: 'Direct image URL' },
        name: { type: 'string', description: 'Display name for the asset' },
        provider: { type: 'string', description: 'Source provider (e.g. Openverse)' },
        creator: { type: 'string', description: 'Original creator' },
        license: { type: 'string', description: 'License name' },
        licenseUrl: { type: 'string', description: 'License URL' },
        sourceUrl: { type: 'string', description: 'Original source/landing page URL' }
      },
      required: ['url'],
      additionalProperties: false
    },
    annotations: write,
    timeoutMs: 60000
  },
  // —— 视觉反馈：节点缩略图与 2D/3D 预览截图，让代理能“看见”结果 ——
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
  // —— 自检与审计：引擎级自检、应用级审计，用于回归验证 ——
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
      'Add a node of the given type. Common types: perlin, cellular, grunge, waves, checker, bricks, tiles, wood_planks, fur, grass, plastic, burlap, fabric, leather, concrete, shape, gradient, gradient_map, blend, normal, ao, paint, image_input, material_output. Returns the new node id.',
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
      'Connect a source node output to a target node input port. Outputs are RGBA streams; toPort MUST be one of the target node\'s inputPorts from substrate_get_graph (e.g. "basecolor", "height", "a", "b", or "input" for Transform 2D). A common alias like "in" is auto-corrected only for single-input nodes; otherwise the tool returns availablePorts. Returns the connection id.',
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
    name: 'substrate_auto_layout',
    title: 'Auto-Arrange Node Graph',
    description:
      'One-click tidy of the node graph: layered left-to-right layout with barycentre crossing reduction, real node heights and one undo step. Use it after adding/rewiring nodes so the graph is readable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: write,
    timeoutMs: 30000
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
  // —— 导出与项目管理：烘焙导出、保存/载入/回收站 ——
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
    title: 'Move Project to Recycle Bin',
    description: 'Move a saved project to the recycle bin (restorable from the Trash dialog or POST /api/trash/restore).',
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

/**
 * 给代理看的规范参数示例（会出现在 /api/mcp/tools 响应与 LLM 工具说明中，
 * 也会附加到参数校验失败/未找到目标的错误里作为提示）。
 *
 * 维护约定：示例必须可直接复制运行，且与 inputSchema 保持内部一致。
 */
export const TOOL_EXAMPLES = {
  substrate_get_thumbnail: [{}, { nodeId: 'material_output-xxxxx' }],
  substrate_get_preview: [
    { view: '2d', channel: 'basecolor', size: 256 },
    { view: '3d', size: 256 }
  ],
  substrate_add_node: [
    { type: 'perlin', x: 320, y: 160 },
    { type: 'paint', x: 640, y: 160 }
  ],
  substrate_connect: [
    { fromNode: 'perlin-xxxxx', fromPort: 'out', toNode: 'material_output-xxxxx', toPort: 'height' },
    { fromNode: 'image_input-xxxxx', fromPort: 'out', toNode: 'transform-xxxxx', toPort: 'input' }
  ],
  substrate_auto_layout: [{}],
  substrate_set_param: [
    { nodeId: 'perlin-xxxxx', key: 'scale', value: 12 },
    { nodeId: 'gradient_map-xxxxx', key: 'gradient', value: [{ p: 0, c: '#1d2a12' }, { p: 1, c: '#9aa84f' }] }
  ],
  substrate_paint_stroke: [
    {
      nodeId: 'paint-xxxxx',
      points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }],
      brushId: 'soft-round',
      color: '#ffffff',
      size: 32,
      opacity: 1
    }
  ],
  substrate_load_demo: [{ id: 'mossy-rock' }],
  substrate_export: [{ preset: 'gltf', resolution: 512 }],
  substrate_save_project: [{ name: 'my-material' }],
  substrate_load_project: [{ name: 'my-material' }],
  substrate_set_locale: [{ locale: 'zh' }],
  substrate_search_open_assets: [{ query: 'rusty metal plate', limit: 6 }],
  substrate_import_asset_url: [{ url: 'https://example.com/texture.jpg', name: 'Rusty plate' }],
  substrate_list_assets: [{}],
  substrate_apply_asset: [{ assetId: 'a1b2c3d4e5f6', target: 'texture' }]
}

// 把示例挂到对应工具条目上（未提供示例的工具默认为空数组，便于统一序列化）
for (const tool of TOOLS) {
  tool.examples = TOOL_EXAMPLES[tool.name] || []
}

/** 工具名 → 工具定义的索引表，供执行侧 O(1) 查找。 */
export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * 按名称取工具定义。
 *
 * @param {string} name 工具名
 * @returns {object|null} 工具定义；未知工具返回 null
 */
export function getTool(name) {
  return TOOLS_BY_NAME.get(name) || null
}

/**
 * 生成对外公开的目录快照（剥离内部字段，只保留协议需要的信息）。
 *
 * @param {object} [extra] 需要合并进响应的附加字段（例如 gateways、server 信息）
 * @returns {object} 形如 { ok, apiVersion, protocolVersion, service, ...extra, tools }
 */
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
      timeoutMs: t.timeoutMs,
      examples: t.examples || []
    }))
  }
}

// JSON-Schema 里的 "integer" 不能直接用 typeof 判断，故单独把数组/null 归一化后再比较
function typeOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * 严格、零依赖地校验上面用到的 JSON-Schema 子集（递归处理嵌套对象与数组元素）。
 *
 * 之所以不引入 ajv 等库：浏览器与服务端都要用，且 schema 子集很小，自己实现可避免打包体积
 * 与版本不一致问题。失败时抛出带 INVALID_ARGUMENT 错误码的 Error，消息包含出错路径与工具名。
 *
 * @param {any} value 待校验值
 * @param {object} schema 目标 schema
 * @param {string} path 当前路径（用于错误提示，如 "points[0].x"）
 * @param {string} name 工具名（用于错误提示）
 */
function validateNestedValue(value, schema, path, name) {
  if (!schema) return
  const fail = (message) => {
    const err = new Error(path + ' ' + message + ' (tool ' + name + ')')
    err.code = ERROR_CODES.INVALID_ARGUMENT
    throw err
  }
  const actual = typeOf(value)
  if (schema.type === 'integer') {
    if (actual !== 'number' || !Number.isInteger(value)) fail('must be an integer')
  } else if (schema.type === 'number') {
    if (actual !== 'number' || !Number.isFinite(value)) fail('must be a finite number')
  } else if (schema.type === 'array') {
    if (actual !== 'array') fail('must be an array')
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('needs at least ' + schema.minItems + ' items')
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('has too many items (max ' + schema.maxItems + ')')
    if (schema.items) value.forEach((item, i) => validateNestedValue(item, schema.items, path + '[' + i + ']', name))
    return
  } else if (schema.type === 'object') {
    if (actual !== 'object') fail('must be an object')
    for (const key of schema.required || []) {
      if (value[key] === undefined) fail('is missing required property "' + key + '"')
    }
    const props = schema.properties || {}
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue
      const child = props[key]
      if (!child) {
        if (schema.additionalProperties === false) fail('has unknown property "' + key + '"')
        continue
      }
      validateNestedValue(v, child, path + '.' + key, name)
    }
    return
  } else if (schema.type && actual !== schema.type) {
    fail('must be of type ' + schema.type)
  }
  if (schema.enum && !schema.enum.includes(value)) fail('must be one of ' + JSON.stringify(schema.enum))
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('must be >= ' + schema.minimum)
    if (schema.maximum !== undefined && value > schema.maximum) fail('must be <= ' + schema.maximum)
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('must be at least ' + schema.minLength + ' chars')
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('must be at most ' + schema.maxLength + ' chars')
  }
}

/**
 * 校验一次工具调用的参数（入口函数）。
 *
 * 分两遍处理：
 * 1. 先做顶层必填、未知字段、基础类型与取值范围/枚举检查（错误信息更直观）；
 * 2. 再递归校验嵌套对象与数组元素（例如画笔 points 的每个采样点）。
 *
 * @param {string} name 工具名
 * @param {object} args 调用参数
 * @returns {object} 校验通过的参数对象（便于调用方直接使用）
 * @throws {Error} 工具不存在（UNKNOWN_TOOL）或参数非法（INVALID_ARGUMENT）
 */
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
  // 递归校验嵌套对象属性与数组元素 schema（例如画笔轨迹点）。
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const prop = (schema.properties || {})[key]
    if (!prop) continue
    if (prop.type === 'array' && prop.items) {
      value.forEach((item, i) => validateNestedValue(item, prop.items, key + '[' + i + ']', name))
    } else if (prop.type === 'object') {
      validateNestedValue(value, prop, key, name)
    }
  }
  return args
}

/**
 * 计算某次调用的实际超时时间。
 *
 * 规则：以工具自带的 timeoutMs 为上限（缺省 30 秒），把客户端请求值限制在 [1000ms, 上限]
 * 区间；请求值缺失或非法时直接使用工具默认上限。这样可以防止调用方传入过长超时把网关挂住，
 * 同时也给慢工具（导出、自检）留出足够时间。
 *
 * @param {string} name 工具名
 * @param {number} [requested] 调用方请求的超时（毫秒）
 * @returns {number} 最终生效的超时毫秒数
 */
export function toolTimeout(name, requested) {
  const tool = getTool(name)
  const max = tool?.timeoutMs || 30000
  const requestedMs = Number(requested)
  if (!Number.isFinite(requestedMs) || requestedMs <= 0) return max
  return Math.min(max, Math.max(1000, Math.round(requestedMs)))
}
