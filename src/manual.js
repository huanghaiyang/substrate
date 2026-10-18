// Built-in product manual + technical glossary.
//
// This module is the single source for the in-app Help panel (`?` in the top bar). It is *not* a
// translation key list: every entry carries its own {en, zh} pair, so the panel switches language
// reactively and the content stays next to the thing it documents.
//
// Shape:
//   MANUAL_SECTIONS: [{ id, title:{en,zh}, blocks:[{ type:'p'|'ul'|'steps'|'code'|'table', ... }] }]
//   GLOSSARY:        [{ id, term:{en,zh}, tag, desc:{en,zh}, app:{en,zh} }]
// `app` answers "where do I meet this term in THIS application?" — that is the part a generic
// glossary cannot tell you.
//
// Rules for editing: keep EN and ZH in sync, keep sections task-oriented (how to do X), and keep
// every glossary `app` pointer anchored to a real node / parameter / channel / UI element name.

const T = (en, zh) => ({ en, zh })

export const MANUAL_TAGS = [
  { id: 'all', label: T('All', '全部') },
  { id: 'color', label: T('Colour', '颜色') },
  { id: 'data', label: T('Data maps', '数据贴图') },
  { id: 'node', label: T('Nodes & noise', '节点与噪声') },
  { id: 'pipeline', label: T('GPU pipeline', 'GPU 管线') },
  { id: 'export', label: T('Export & packaging', '导出与打包') }
]

export const MANUAL_SECTIONS = [
  {
    id: 'overview',
    title: T('What this app does', '这个应用做什么'),
    blocks: [
      {
        type: 'p',
        en: 'Substrate is a Substance-Designer-style **material authoring tool**. You build a node graph that generates the eight PBR channels on the GPU, paint on top of it by hand, inspect the result on a lit 3D ball, and export a standards-compliant texture package.',
        zh: 'Substrate 是 Substance Designer 风格的**材质制作工具**。你搭一张节点图在 GPU 上生成 8 个 PBR 通道，可以手工在上面绘制，在受光的 3D 球上检查效果，最后导出一套符合行业规范的贴图包。'
      },
      {
        type: 'ul',
        en: [
          'Every node renders to an RGBA16F render target in **linear light**; only Base Color and Emissive are sRGB-encoded when read back.',
          'The graph is evaluated from the PBR Output backwards, so only ancestors of the output cost anything — orphan nodes are free but still clutter the file.',
          'Exports are baked in the same browser page, then zipped by the local Node server.'
        ],
        zh: [
          '每个节点都渲染到 **RGBA16F** 渲染目标，全程**线性光**；只有 Base Color 与 Emissive 在回读时做 sRGB 编码。',
          '图是从 PBR Output 反向求值的，所以只有输出的祖先节点有成本——孤立节点不花 GPU，但会撑大工程文件。',
          '导出在同一个浏览器页面里烘焙，再由本地 Node 服务器打包成 zip。'
        ]
      }
    ]
  },
  {
    id: 'quickstart',
    title: T('Quick start', '快速开始'),
    blocks: [
      {
        type: 'steps',
        en: [
          'Click a node in the **Node Library** (left) — it lands in the middle of the canvas.',
          'Drag from a node\'s right-hand **out** port onto another node\'s **input** dot to connect. While dragging, the link preview snaps to the nearest valid port.',
          'Select a node and edit its parameters in the **Properties** panel (right).',
          'Watch the **3D View** update; switch to **2D Maps** to check channels one by one.',
          'Press **Export Material**, pick a preset and resolution, and download the zip.'
        ],
        zh: [
          '在左侧**节点库**点一个节点，它会落在画布中央。',
          '从节点右侧 **out** 端口拖到另一个节点的输入圆点上建立连接；拖动时连线预览会自动吸附最近的合法端口。',
          '选中节点，在右侧**属性**面板改参数。',
          '看**3D 视图**实时变化；切到 **2D 贴图**逐个检查通道。',
          '点**导出材质**，选预设与分辨率，下载 zip。'
        ]
      },
      {
        type: 'p',
        en: 'A valid material is simply: some generator node(s) → **PBR Output**. Nothing else is required; unconnected channels fall back to their neutral default.',
        zh: '一个合法材质只需要：某个生成节点 → **PBR Output**。其余通道不接也行，会回退到各自的中性默认值。'
      }
    ]
  },
  {
    id: 'graph',
    title: T('Editing the graph', '编辑节点图'),
    blocks: [
      {
        type: 'ul',
        en: [
          '**Pan / zoom** — drag empty canvas, mouse wheel to zoom.',
          '**Select** — click, Shift-click to add, or marquee-drag on empty canvas.',
          '**Move** — drag a selected node; nodes keep their positions in the project.',
          '**Delete** — `Del`/`Backspace` removes selected nodes or the selected link.',
          '**Duplicate** — `Ctrl/Cmd+D`. Right-click a node for duplicate / disconnect / delete.',
          '**Undo / redo** — `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (also toolbar ↶ ↷).',
          '**Auto-arrange** — the ⌗ toolbar button tidies the whole graph in one undoable step.'
        ],
        zh: [
          '**平移 / 缩放** — 拖动空白画布，滚轮缩放。',
          '**选择** — 单击、Shift 加选，或在空白处框选。',
          '**移动** — 拖动选中节点；位置会随工程保存。',
          '**删除** — `Del`/`Backspace` 删除选中节点或选中的连线。',
          '**复制** — `Ctrl/Cmd+D`；右键节点可复制 / 断开 / 删除。',
          '**撤销 / 重做** — `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`（工具栏 ↶ ↷ 同效）。',
          '**自动整理** — 工具栏 ⌗ 一键布局，整体算一步撤销。'
        ]
      },
      {
        type: 'p',
        en: 'Links are **type-less RGBA streams**: any output can drive any input. The meaning lives in the node that consumes it — feeding a colour into `height` simply uses its luminance.',
        zh: '连线是**无类型的 RGBA 数据流**：任何输出都能接任何输入。含义由下游节点决定——把彩色接到 `height`，它只会取亮度。'
      }
    ]
  },
  {
    id: 'nodes',
    title: T('Node library & data flow', '节点库与数据流'),
    blocks: [
      {
        type: 'table',
        head: [T('Category', '分类'), T('Nodes', '节点')],
        rows: [
          [T('Input', '输入'), T('Texture Input (bitmap), Constant Value, Flat Color', '纹理输入（位图）、常量值、纯色')],
          [T('Noise', '噪声'), T('Perlin (fBm, Billow), Cellular (F1/F2/borders), Grunge', '柏林（fBm、团块折叠）、细胞（F1/F2/边界）、污渍')],
          [T('Pattern', '图案'), T('Waves, Checker, Brick Wall, Tile Generator, Wood Planks, Fur, Grass, Plastic, Burlap, Fabric, Leather, Concrete', '波纹、棋盘、砖墙、瓷砖生成器、木板、毛发、草地、塑料、麻布、布匹、皮革、混凝土')],
          [T('Shape / Color', '形状 / 颜色'), T('SDF Shape, Gradient, Gradient Map, Channel Combine', 'SDF 形状、渐变、渐变映射、通道组合')],
          [T('Filter', '滤镜'), T('Blur, Directional Blur, Sharpen, High Pass, Emboss, Warp, Edge Detect, Morphology, Transform 2D', '模糊、方向模糊、锐化、高通、浮雕、扰动、边缘检测、形态学、2D 变换')],
          [T('Blend / Adjust', '混合 / 调整'), T('Blend (15 modes + mask), Levels, Histogram Scan, Invert, HSL, Desaturate, Threshold, Posterize', '混合（15 模式+遮罩）、色阶、直方图扫描、反相、HSL、去色、阈值、色调分离')],
          [T('Normal', '法线'), T('Normal (height→tangent), Ambient Occlusion, Curvature', '法线（高度→切线空间）、环境光遮蔽、曲率')],
          [T('Paint / Output', '绘制 / 输出'), T('Paint Layer, PBR Output', '绘制层、PBR 输出')]
        ]
      },
      {
        type: 'p',
        en: 'Every node returns **one RGBA stream**. Multi-input nodes name their ports (e.g. Blend has `base`, `blend`, `mask`). An unconnected **mask** defaults to white (1.0), an unconnected **colour/height input** to mid grey (0.5) — check the port tooltip.',
        zh: '每个节点都只输出**一条 RGBA 流**。多输入节点会命名端口（例如混合的 `base`、`blend`、`mask`）。**遮罩**未连接时默认为白（1.0），**颜色/高度输入**未连接时默认为中灰（0.5）——看端口提示。'
      },
      {
        type: 'p',
        en: 'Seamless requirement: only generators are periodic. If you stretch a noise with Transform 2D you keep tiling only because the sampler wraps; anything that samples outside 0–1 (Warp, Blur, Morphology) inherits wrap, so the pipeline stays tileable end to end.',
        zh: '接缝要求：生成器本身是周期的。用 2D 变换拉伸噪声后之所以还能平铺，是因为采样器用环绕；任何会采样到 0–1 之外的操作（扰动、模糊、形态学）都继承环绕，所以整条管线保持可平铺。'
      }
    ]
  },
  {
    id: 'params',
    title: T('Parameter editing', '参数编辑'),
    blocks: [
      {
        type: 'ul',
        en: [
          'Widgets are schema-driven: sliders + numeric fields (float/int), toggles (bool), select menus, colour pickers, 2D vectors, and a multi-stop **gradient editor** (click the ramp to add a stop, drag/select to edit).',
          '**Angles are authored in degrees** and converted to radians on upload.',
          '**Colours are authored in sRGB** and converted to linear before evaluation, so what you pick is what you see in the export.',
          'Gradient stops are sampled in linear light; up to 8 stops per gradient.'
        ],
        zh: [
          '控件由参数 schema 生成：滑块+数字框（float/int）、开关（bool）、下拉、取色器、2D 向量，以及多停靠点**渐变编辑器**（点色带加停靠点，拖动/选中编辑）。',
          '**角度按“度”填写**，上传时转弧度。',
          '**颜色按 sRGB 填写**，求值前转线性，所以选色即所得。',
          '渐变停靠点在**线性光**下采样，每条渐变最多 8 个停靠点。'
        ]
      },
      {
        type: 'p',
        en: 'Careful with **Levels → Gamma**: the shader applies `pow(x, 1/gamma)`, so gamma **greater than 1 brightens** and lower than 1 darkens. It is the opposite of some image editors\' label direction, hence the tooltip.',
        zh: '注意**色阶 → 伽马**：着色器执行 `pow(x, 1/gamma)`，所以 gamma **大于 1 是提亮**，小于 1 是压暗。方向与部分图像软件的直觉相反，所以提示里写明了。'
      }
    ]
  },
  {
    id: 'preview',
    title: T('3D view & 2D maps', '3D 视图与 2D 贴图'),
    blocks: [
      {
        type: 'ul',
        en: [
          '**3D View** shades a `MeshStandardMaterial` with a procedural IBL and ACES tone mapping; five preview meshes, tiling, displacement and auto-spin are toggles at the bottom.',
          '**2D Maps** shows every channel with its colour-space label (sRGB for Base Color/Emissive, linear for the rest) and its packing/bit-depth metadata; click a map for full size.',
          'Node thumbnails in the graph are rendered from the actual GPU result (96 px), which is enough to spot a broken link but not to judge a 1024² texture — use 2D Maps or an export for that.'
        ],
        zh: [
          '**3D 视图**用 `MeshStandardMaterial` + 程序化 IBL + ACES 色调映射着色；底部可切换 5 种预览网格、平铺、置换、自动旋转。',
          '**2D 贴图**显示每个通道，带色彩空间标签（Base Color/Emissive 为 sRGB，其余线性）以及打包/位深元数据；点开可看全尺寸。',
          '图里的节点缩略图由真实 GPU 结果渲染（96px），够用来发现断线，但不足评判 1024² 材质——那要看 2D 贴图或导出。'
        ]
      }
    ]
  },
  {
    id: 'paint',
    title: T('Paint Studio', '绘制工作室'),
    blocks: [
      {
        type: 'p',
        en: 'Double-click a **Paint Layer** node (or select it and press *Open Paint Studio*). 16 built-in brushes in two groups: **Basic** (soft/hard round, pencil, ink, airbrush, marker, chalk, spray, sponge, flat) and **Nature** (grass, leaf, flower, tree, fern, branch — procedurally drawn, rotated/scaled per dab).',
        zh: '双击**绘制层**节点（或选中后点*打开绘制工作室*）。16 个内置笔刷分两组：**基础**（软/硬圆、铅笔、墨水、喷枪、马克笔、粉笔、喷溅、海绵、平头）与**自然**（草、叶、花、树、蕨、枝——程序化绘制，每一下随机旋转缩放）。'
      },
      {
        type: 'ul',
        en: [
          'Dynamics: size, opacity, hardness, **flow** and **spacing**; pressure drives size/flow where supported.',
          'Strokes are smoothed with Catmull-Rom → cubic Bézier, and an optional **pen taper** thins both ends.',
          'Eraser (destination-out), fill, and X/Y **symmetry** work with every brush; undo removes whole strokes.',
          'Strokes are stored as data, rasterised at 1024² and uploaded as a texture, so painted pixels can drive base colour, roughness, height, masks — anything downstream.',
          'Materials imported in the asset library can be painted in as a repeating **pattern fill**.'
        ],
        zh: [
          '动态：大小、不透明度、硬度、**流量**、**间距**；支持压感的笔刷由压力驱动大小/流量。',
          '笔画用 Catmull-Rom → 三次贝塞尔平滑，可选**笔锋**让两端变细。',
          '橡皮（destination-out）、填充、X/Y **对称**对所有笔刷有效；撤销按整笔回退。',
          '笔画以数据保存，按 1024² 栅格化后作为贴图上传，因此画上去的像素可以驱动底色、粗糙度、高度、遮罩等任何下游。',
          '素材库里导入的材质可以作为**图案填充**刷进图层。'
        ]
      }
    ]
  },
  {
    id: 'assets',
    title: T('Material library', '素材库'),
    blocks: [
      {
        type: 'ul',
        en: [
          'Top-bar **▦** imports PNG/JPEG/WebP (or drop files on the dialog). Assets live on the local server under `assets/`.',
          'An asset can become a **Texture Input** in the graph (the project embeds the image, so the file stays self-contained) or a **paint pattern**.',
          'The search field finds open-license material online and shows creator/license/source; importing stores attribution with the file.'
        ],
        zh: [
          '顶栏 **▦** 导入 PNG/JPEG/WebP（也可以把文件拖到弹窗里）。素材存在本地服务器的 `assets/` 下。',
          '素材可以变成图里的**纹理输入**（图片会嵌入工程，文件自包含），也可以作为**绘制图案**。',
          '搜索框可在线找开放授权素材并显示作者/许可/来源；导入时会把出处一起存下来。'
        ]
      }
    ]
  },
  {
    id: 'export',
    title: T('Export presets', '导出预设'),
    blocks: [
      {
        type: 'table',
        head: [T('Preset', '预设'), T('Packs', '打包内容')],
        rows: [
          [T('glTF / three.js', 'glTF / three.js'), T('BaseColor (sRGB), Normal, **ORM** = R:AO G:Roughness B:Metallic, Height (16-bit)', 'BaseColor（sRGB）、Normal、**ORM** = R:AO G:粗糙度 B:金属度、Height（16 位）')],
          [T('Unreal', '虚幻'), T('BC / N (DirectX) / ORM / H (16-bit)', 'BC / N（DirectX）/ ORM / H（16 位）')],
          [T('Unity HDRP/URP', 'Unity HDRP/URP'), T('Albedo+Alpha, Normal (DirectX), **Mask Map** = R:Metallic G:AO B:Detail A:Smoothness, Height', 'Albedo+Alpha、Normal（DirectX）、**Mask Map** = R:金属度 G:AO B:细节 A:光滑度、Height')],
          [T('V-Ray / Arnold / generic', 'V-Ray / Arnold / 通用'), T('Separate BaseColor, Roughness, Metallic, AO, Normal, Height, Emissive', '分离的 BaseColor、粗糙度、金属度、AO、法线、高度、自发光')],
          [T('Substance Painter', 'Substance Painter'), T('Lower-case channel names matching Substance conventions', '符合 Substance 习惯的小写通道名')]
        ]
      },
      {
        type: 'ul',
        en: [
          'Resolution 512 → 4096; the export re-bakes at that size (streaming mode releases intermediates as their last consumer finishes).',
          '**Normal convention** OpenGL (+Y) ↔ DirectX (−Y) is converted on export, not by re-authoring the graph.',
          'Height is 16-bit greyscale; "Normalize Height" stretches the used range to full 0–1 (turn it off when you need the absolute displacement range, e.g. when stacking with other height maps).',
          'PNG uses adaptive per-row filters, CRC-32 chunks, an `sRGB` chunk only on colour maps, and 8/16-bit colour types as required.',
          'The server writes `manifest.json` (resolution, colour spaces, normal convention, alpha mode, ORM packing, per-file bit depth) and a `README.md` with import instructions for three.js / Unreal / Unity, then zips the folder.'
        ],
        zh: [
          '分辨率 512 → 4096；导出会按该尺寸重新烘焙（流式模式在最后一个消费者完成后释放中间结果）。',
          '**法线约定** OpenGL (+Y) ↔ DirectX (−Y) 在导出时转换，不需要重画图。',
          'Height 为 16 位灰度；“归一化高度”会把实际范围拉伸到 0–1（需要绝对置换范围时关掉它，比如与其他高度图叠加）。',
          'PNG 使用自适应逐行滤波、CRC-32 分块、只有颜色图带 `sRGB` 块、按需选 8/16 位颜色类型。',
          '服务器写出 `manifest.json`（分辨率、色彩空间、法线约定、Alpha 模式、ORM 打包、每文件位深）和 `README.md`（three.js / Unreal / Unity 的导入说明），再打包成 zip。'
        ]
      }
    ]
  },
  {
    id: 'projects',
    title: T('Projects & persistence', '工程与持久化'),
    blocks: [
      {
        type: 'ul',
        en: [
          'The current session **autosaves to the browser** (`localStorage`), so a refresh restores your work.',
          '**Save / Open** write JSON projects to the server under `projects/`; opening a project replaces the current graph.',
          'A saved project is the authoritative copy: if the canvas and a project disagree after heavy experimenting, open the project to get back to the known-good graph.'
        ],
        zh: [
          '当前会话会**自动保存到浏览器**（`localStorage`），刷新可恢复。',
          '**保存 / 打开** 把 JSON 工程写到服务器的 `projects/` 下；打开会替换当前图。',
          '保存的工程是权威副本：反复试验后如果画布与工程不一致，打开工程即可回到已知良好状态。'
        ]
      }
    ]
  },
  {
    id: 'ai-mcp',
    title: T('AI assistant & MCP', 'AI 助手与 MCP'),
    blocks: [
      {
        type: 'ul',
        en: [
          'The top-bar **✦** panel talks to DeepSeek (default) or any OpenAI-compatible provider. Requests run **server-side**, so API keys never reach the browser.',
          'The assistant drives this same studio through the MCP tool catalog (graphs, paint, evaluate, export). It is bound by server-enforced rules: it may only operate the studio, not read source code, files or keys.',
          '**◎** runs the MCP self-check (catalog shape, argument validation, bridge round-trip).',
          'External agents use the same gateway: stdio (`node mcp/server.mjs`), HTTP JSON-RPC at `POST /mcp`, or plain JSON at `POST /api/mcp/call`. A browser tab running the studio must be open — the graph is evaluated there.'
        ],
        zh: [
          '顶栏 **✦** 面板接 DeepSeek（默认）或任何 OpenAI 兼容服务。请求在**服务端**执行，API Key 不进浏览器。',
          '助手通过 MCP 工具目录驱动这个工作室（建图、绘制、求值、导出）。它受服务端强制规则约束：只能操作工作室，不能读源码、文件或密钥。',
          '**◎** 运行 MCP 自检（目录结构、参数校验、桥接往返）。',
          '外部 agent 走同一个网关：stdio（`node mcp/server.mjs`）、HTTP JSON-RPC `POST /mcp`，或纯 JSON `POST /api/mcp/call`。必须有一个打开着工作室的浏览器标签页——图在那里求值。'
        ]
      }
    ]
  },
  {
    id: 'shortcuts',
    title: T('Keyboard shortcuts', '快捷键'),
    blocks: [
      {
        type: 'table',
        head: [T('Keys', '按键'), T('Action', '动作')],
        rows: [
          [T('Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z', 'Ctrl/Cmd + Z / Ctrl/Cmd + Shift + Z'), T('Undo / redo', '撤销 / 重做')],
          [T('Ctrl/Cmd + D', 'Ctrl/Cmd + D'), T('Duplicate selected nodes', '复制选中节点')],
          [T('Del / Backspace', 'Del / Backspace'), T('Delete selection or link', '删除选中节点或连线')],
          [T('Ctrl/Cmd + S', 'Ctrl/Cmd + S'), T('Save project', '保存工程')],
          [T('Ctrl/Cmd + E', 'Ctrl/Cmd + E'), T('Open export dialog', '打开导出面板')],
          [T('Esc', 'Esc'), T('Leave Paint Studio / close dialogs', '退出绘制工作室 / 关闭弹窗')]
        ]
      }
    ]
  },
  {
    id: 'faq',
    title: T('Troubleshooting', '常见问题'),
    blocks: [
      {
        type: 'ul',
        en: [
          '**Nothing renders / black view** — open the browser console; a shader compile error is reported per node. Run **Run self-test** in this dialog: it compiles every node\'s GLSL and reports the first failure.',
          '**MCP tools answer APP_NOT_CONNECTED** — no studio tab is open or it is asleep (background tab throttling). Focus the tab and retry.',
          '**A link seems ignored** — ports are validated: `substrate_get_graph` returns `inputPorts` and the self-test reports `connectionPortsValid`. A link to a non-existent port is rejected instead of being silently dropped.',
          '**Seams appear when tiling** — the self-test prints seam ratios per channel; a ratio near 0 means clean edges. Common causes: a generated pattern that is not periodic, or an image input whose border does not wrap.',
          '**Graph got messy after experimenting** — use ⌗ auto-arrange, and open the saved project to discard dead nodes left behind by rewiring.',
          '**Export is slow or fails** — large resolutions need GPU memory; 2048² with many multi-pass nodes is the practical limit on integrated GPUs.'
        ],
        zh: [
          '**不出图 / 视图全黑** — 打开浏览器控制台，着色器编译错误会按节点报出来。点本弹窗里的**运行自检**：它会编译每个节点的 GLSL 并报出第一个失败。',
          '**MCP 工具返回 APP_NOT_CONNECTED** — 没有打开工作室标签页，或标签页休眠了（后台节流）。聚焦该标签页重试。',
          '**连线好像没生效** — 端口是有校验的：`substrate_get_graph` 会返回 `inputPorts`，自检会报告 `connectionPortsValid`。接到不存在的端口会被拒绝，而不是被静默丢弃。',
          '**平铺时有接缝** — 自检会打印每个通道的接缝比值，接近 0 表示边缘干净。常见原因：生成器本身不周期，或位图输入的边缘不环绕。',
          '**试验后图很乱** — 用 ⌗ 自动整理；打开已保存的工程可以丢掉改接线后遗留的死节点。',
          '**导出很慢或失败** — 大分辨率吃 GPU 显存；集成显卡上 2048² 加上多 pass 节点基本是上限。'
        ]
      }
    ]
  }
]

// tag: one of MANUAL_TAGS ids (colour / data / node / pipeline / export)
export const GLOSSARY = [
  {
    id: 'pbr',
    term: T('PBR (physically based rendering)', 'PBR（基于物理的渲染）'),
    tag: 'data',
    desc: T('A shading model that describes a surface with a small set of physically meaningful maps (base colour, roughness, metallic, normal, AO) instead of hand-tuned specular colours, so the same texture looks right under different lighting.',
      '用少量具有物理含义的贴图（底色、粗糙度、金属度、法线、AO）来描述表面的着色模型，而不是手调高光颜色，因此同一套贴图在不同光照下都合理。'),
    app: T('This is exactly the eight channels of the PBR Output node: basecolor, height, normal, roughness, metallic, ao, emissive, opacity.',
      '这正是 PBR Output 节点的八个通道：basecolor、height、normal、roughness、metallic、ao、emissive、opacity。')
  },
  {
    id: 'albedo',
    term: T('Base colour / albedo', '底色 / 反照率'),
    tag: 'color',
    desc: T('The diffuse colour of the surface: how much of each wavelength is reflected, with no lighting information baked in. Must not contain shadows or highlights.',
      '表面的漫反射颜色：各波长被反射的比例，不应包含阴影或高光信息。'),
    app: T('PBR Output `basecolor`. Exported as sRGB PNG (8-bit RGB/RGBA); everything upstream of it is linear light.',
      'PBR Output 的 `basecolor`。导出为 sRGB PNG（8 位 RGB/RGBA）；它在图里的上游全程是线性光。')
  },
  {
    id: 'roughness',
    term: T('Roughness', '粗糙度'),
    tag: 'data',
    desc: T('How micro-rough the surface is: 0 = mirror-like, 1 = fully diffuse. Drives the width of the specular highlight.',
      '表面微观粗糙程度：0 = 镜面，1 = 完全漫反射。决定高光宽度。'),
    app: T('PBR Output `roughness`. Packed into ORM.G (glTF/Unreal) or Mask Map.A as smoothness (Unity = 1 − roughness).',
      'PBR Output 的 `roughness`。在 ORM.G（glTF/虚幻）里，或在 Unity Mask Map 的 A 通道里以“光滑度”（1 − 粗糙度）出现。')
  },
  {
    id: 'metallic',
    term: T('Metallic / metalness', '金属度'),
    tag: 'data',
    desc: T('Whether the surface is a metal. In the metallic/roughness workflow it is a 0/1 mask; metals have no diffuse reflection and take their reflection colour from the base colour.',
      '表面是否为金属。在金属/粗糙度工作流里通常是 0/1 遮罩；金属没有漫反射，反射颜色取自底色。'),
    app: T('PBR Output `metallic`. Packed into ORM.B (and Unity Mask Map.R).',
      'PBR Output 的 `metallic`。打进 ORM.B（以及 Unity Mask Map 的 R 通道）。')
  },
  {
    id: 'ao',
    term: T('Ambient occlusion (AO)', '环境光遮蔽（AO）'),
    tag: 'data',
    desc: T('A 0–1 mask approximating how much of the ambient sky light reaches a point: crevices and cavities are darker. It is a *lighting* cheat, not surface colour.',
      '近似表示某个点能接收多少环境光的 0–1 遮罩：缝隙、凹陷更暗。它是**光照**近似，不是表面颜色。'),
    app: T('Ambient Occlusion node (height-based, Poisson spiral) → PBR Output `ao` → ORM.R / Mask Map.G. A common trick is to multiply AO into the albedo for self-shadowing.',
      '环境光遮蔽节点（基于高度、泊松螺旋采样）→ PBR Output `ao` → ORM.R / Mask Map.G。常见技巧是把 AO 乘进底色以获得自阴影。')
  },
  {
    id: 'normal-map',
    term: T('Normal map', '法线贴图'),
    tag: 'data',
    desc: T('An RGB image that stores a surface normal as a vector (xyz → RGB, each remapped from −1..1 to 0..1). Gives lighting detail without extra geometry; the flat direction is the blue-ish (128,128,255).',
      '把表面法线存成向量的 RGB 贴图（xyz → RGB，从 −1..1 映射到 0..1）。不增加几何就能有光照细节；平坦方向是偏蓝的 (128,128,255)。'),
    app: T('Normal node (height → tangent-space normal). OpenGL/DirectX convention is selectable on the output and converted at export time.',
      '法线节点（高度 → 切线空间法线）。OpenGL/DirectX 约定可在输出节点选择，导出时转换。')
  },
  {
    id: 'tangent-space',
    term: T('Tangent space', '切线空间'),
    tag: 'data',
    desc: T('A coordinate frame local to each triangle (tangent / bitangent / normal), so a normal map stays valid when the mesh is rotated or deformed.',
      '每个三角形局部的坐标系（切线/副切线/法线），因此网格旋转或形变后法线贴图依然有效。'),
    app: T('The Normal and Preview3D nodes work in tangent space; export writes tangent-space normal maps.',
      '法线节点与 3D 预览都按切线空间处理；导出写切线空间法线图。')
  },
  {
    id: 'opengl-directx',
    term: T('OpenGL vs DirectX normal convention', 'OpenGL 与 DirectX 法线约定'),
    tag: 'export',
    desc: T('The two differ in the sign of the green (Y) channel. glTF/three.js/Blender use OpenGL (+Y up); Unreal and Unity use DirectX (−Y up). Using the wrong one inverts the apparent bump direction.',
      '两者差别在绿色（Y）通道符号。glTF/three.js/Blender 用 OpenGL（+Y 向上），虚幻与 Unity 用 DirectX（−Y 向上）。用错会让凹凸方向看起来是反的。'),
    app: T('PBR Output → “Normal Map” parameter; Export dialog converts (green flip) instead of re-authoring the graph.',
      'PBR Output 的“法线贴图”参数；导出面板会做转换（翻转绿通道），不需要重画图。')
  },
  {
    id: 'height',
    term: T('Height / displacement', '高度 / 置换'),
    tag: 'data',
    desc: T('A greyscale map where brightness = surface height. Used for parallax, tessellation displacement, or as the source of normal/AO/curvature.',
      '亮度代表表面高度的灰度图。用于视差、曲面细分置换，或作为法线/AO/曲率的来源。'),
    app: T('PBR Output `height`, exported as **16-bit** greyscale. “Normalize Height” stretches the used range to 0–1, so turn it off when you need absolute values.',
      'PBR Output 的 `height`，导出为 **16 位**灰度。“归一化高度”会把实际范围拉伸到 0–1，需要绝对值时关掉。')
  },
  {
    id: 'orm',
    term: T('ORM packing', 'ORM 打包'),
    tag: 'export',
    desc: T('Packing three one-channel maps into the RGB channels of one image: **R=AO, G=Roughness, B=Metallic**. Saves texture fetches and files; used by glTF and Unreal.',
      '把三张单通道图打进一张图的 RGB：**R=AO，G=粗糙度，B=金属度**。省采样和文件数；glTF 与虚幻都用它。'),
    app: T('Choose the glTF or Unreal preset; the exporter packs from the wired `ao`/`roughness`/`metallic` channels.',
      '选 glTF 或虚幻预设，导出器会从接好的 `ao`/`roughness`/`metallic` 通道打包。')
  },
  {
    id: 'mask-map',
    term: T('Mask Map (Unity)', '遮罩图（Unity）'),
    tag: 'export',
    desc: T('Unity HDRP/URP\'s packed map: **R=Metallic, G=AO, B=Detail (0.5 by default), A=Smoothness**. Note that A is smoothness, i.e. 1 − roughness.',
      'Unity HDRP/URP 的打包图：**R=金属度、G=AO、B=细节（默认 0.5）、A=光滑度**。注意 A 是光滑度（1 − 粗糙度）。'),
    app: T('The Unity preset writes it, including the smoothness inversion.',
      'Unity 预设会生成它，并自动做光滑度取反。')
  },
  {
    id: 'srgb-linear',
    term: T('sRGB vs linear', 'sRGB 与线性'),
    tag: 'color',
    desc: T('sRGB is a perceptual encoding of light intensity; maths on it is wrong for physical operations (add, multiply, blur). Rendering therefore works in linear light and only encodes sRGB when displaying/storing colour.',
      'sRGB 是对光强的感知编码；在它上面做物理运算（相加、相乘、模糊）是错的。所以渲染在线性光下进行，只在显示/存储颜色时编码回 sRGB。'),
    app: T('All node maths is linear on RGBA16F; only Base Color and Emissive are sRGB-encoded at readback. Data maps (roughness, normal, AO…) stay linear and get no `sRGB` PNG chunk.',
      '所有节点运算都在 RGBA16F 线性光下；只有 Base Color 与 Emissive 在回读时做 sRGB 编码。数据贴图（粗糙度、法线、AO…）保持线性，PNG 里也不写 `sRGB` 块。')
  },
  {
    id: 'rgba16f',
    term: T('RGBA16F render target', 'RGBA16F 渲染目标'),
    tag: 'pipeline',
    desc: T('A 16-bit-per-channel floating point WebGL2 texture used as a node\'s output. Much more headroom than 8-bit, so intermediate maths does not band or clip.',
      '每个通道 16 位浮点的 WebGL2 纹理，作为节点的输出。比 8 位有更多余量，中间运算不会出色带或截断。'),
    app: T('Every node renders into one; that is why a stream can hold values outside 0–1 (they are clamped at the node output and again at export).',
      '每个节点都渲染到它里面；这也是数据流能暂时超出 0–1 的原因（节点输出与导出时都会 clamp）。')
  },
  {
    id: 'pass',
    term: T('Pass / multi-pass node', 'Pass / 多 pass 节点'),
    tag: 'pipeline',
    desc: T('One draw of a fragment shader into a render target. Separable filters (Blur, Morphology) run two passes — horizontal then vertical — reading the previous pass via `uPrev`.',
      '一次把片元着色器画进渲染目标。可分离滤镜（模糊、形态学）跑两遍——先横后竖，第二遍通过 `uPrev` 读上一遍结果。'),
    app: T('The status bar shows `N passes` per evaluation; multi-pass nodes cost twice.',
      '状态栏显示每次求值的 `passes` 数量；多 pass 节点成本翻倍。')
  },
  {
    id: 'cache-hash',
    term: T('Structural hash / evaluation cache', '结构哈希 / 求值缓存'),
    tag: 'pipeline',
    desc: T('A fingerprint of a node\'s type, parameters, input fingerprints, resolution and paint/image versions. Unchanged nodes are served from an LRU cache, so dragging one slider only recomputes its descendants.',
      '由节点类型、参数、输入指纹、分辨率、绘制/图片版本组成的指纹。没变的节点直接走 LRU 缓存，所以拖动一个滑块只重算它的下游。'),
    app: T('Status bar `cache N hits`; the numbers are also returned by `substrate_evaluate`.',
      '状态栏的 `cache N hits`；`substrate_evaluate` 也会返回这些数字。')
  },
  {
    id: 'proxy',
    term: T('Proxy resolution', '代理分辨率'),
    tag: 'pipeline',
    desc: T('Evaluating at a fraction of the document resolution while editing, for responsiveness; the export always re-bakes at full resolution.',
      '编辑时按文档分辨率的比例求值以保证流畅；导出始终按完整分辨率重新烘焙。'),
    app: T('Top-bar “Proxy 50 / 75 / 100 %”; `substrate_set_resolution` takes the same proxy values.',
      '顶栏“代理 50/75/100%”；`substrate_set_resolution` 使用同样的代理值。')
  },
  {
    id: 'tileable',
    term: T('Tileable / seamless', '可平铺 / 无缝'),
    tag: 'node',
    desc: T('The texture wraps without a visible seam, so a surface can repeat it. Requires every operation to be periodic — a plain non-periodic noise breaks it.',
      '纹理环绕后没有可见接缝，表面可以重复它。要求每个操作都是周期的——非周期噪声会破坏它。'),
    app: T('Generators use periodic hashing (`mod(cell, period)`); filters that sample across the border rely on the sampler\'s wrap. The self-test reports seam ratios per channel.',
      '生成器使用周期哈希（`mod(cell, period)`）；跨边界采样的滤镜依赖采样器环绕。自检会按通道报告接缝比值。')
  },
  {
    id: 'fbm',
    term: T('fBm (fractal Brownian motion)', 'fBm（分形布朗运动）'),
    tag: 'node',
    desc: T('Summing several octaves of noise, each finer and lower-amplitude. Gives natural-looking multi-scale detail from one generator.',
      '把多个倍频的噪声叠加，每层更细、振幅更低。一个生成器就能得到自然的多尺度细节。'),
    app: T('Perlin Noise / Grunge / most pattern nodes. Controlled by `Octaves`, `Persistence`, `Lacunarity`.',
      '柏林噪声 / 污渍 / 多数图案节点。由 `倍频数`、`持续度`、`间隙度` 控制。')
  },
  {
    id: 'octaves',
    term: T('Octaves', '倍频数'),
    tag: 'node',
    desc: T('How many fBm layers are summed. More octaves = more fine detail, linearly more cost.',
      '叠加多少层 fBm。倍频越多细节越细，成本线性增加。'),
    app: T('`Octaves` on Perlin/Grunge (1–8). Frequencies double per octave when `Lacunarity` = 2.',
      '柏林/污渍节点的 `倍频数`（1–8）。`间隙度`=2 时每层频率翻倍。')
  },
  {
    id: 'persistence',
    term: T('Persistence', '持续度'),
    tag: 'node',
    desc: T('The amplitude factor between octaves. High = rougher/noisier, low = smoother/softer.',
      '相邻倍频之间的振幅系数。高 = 更粗糙嘈杂，低 = 更平滑柔和。'),
    app: T('`Persistence` on Perlin/Grunge (0.15–0.9).',
      '柏林/污渍节点的 `持续度`（0.15–0.9）。')
  },
  {
    id: 'lacunarity',
    term: T('Lacunarity', '间隙度'),
    tag: 'node',
    desc: T('The frequency factor between octaves — 2 doubles detail frequency each step.',
      '相邻倍频之间的频率系数——取 2 表示每层频率翻倍。'),
    app: T('`Lacunarity` on Perlin/Grunge (1.2–3).',
      '柏林/污渍节点的 `间隙度`（1.2–3）。')
  },
  {
    id: 'billow',
    term: T('Billow / ridged noise', '团块折叠 / 脊状噪声'),
    tag: 'node',
    desc: T('Noise that folds |n| at every octave instead of summing signed values. Mid-values become thin grooves and extremes become rounded blobs — the primitive for granular organic surfaces (moss, lichen, bark, soil crumbs).',
      '每个倍频都取 |n| 折叠而不是累加有符号值。中值变成细沟、极值变成圆团——颗粒状有机表面（苔藓、地衣、树皮、土粒）的基本原语。'),
    app: T('`Billow` toggle on Perlin Noise. Output stays centred on 0.5 so it is safe to feed into any blend mode; raw |fBm| would quietly darken every Overlay.',
      '柏林噪声的 `Billow` 开关。输出仍以 0.5 为中心，可安全接进任何混合模式；裸 |fBm| 均值偏低会悄悄压暗 Overlay。')
  },
  {
    id: 'worley',
    term: T('Cellular / Worley (Voronoi) noise', '细胞 / Worley（Voronoi）噪声'),
    tag: 'node',
    desc: T('Scatters feature points and measures distance to them. F1 = distance to nearest (rounded cells), F2 = second nearest, F2−F1 = cell borders (cracks, foam lines, pebbles).',
      '撒特征点并计算到它们的距离。F1 = 最近距离（圆润单元），F2 = 次近距离，F2−F1 = 单元边界（裂纹、泡沫线、卵石）。'),
    app: T('Cellular Noise node with `Mode` F1/F2/Borders. Contrast-boosted F1 saturates to ~1 over most of a cell, so it makes a poor *sparse* mask — use a thresholded fBm peak instead.',
      '细胞噪声节点的 `模式` F1/F2/边界。加过对比的 F1 在单元内大部分区域已饱和到 ~1，不适合做**稀疏**遮罩——那种场合应用阈值化 fBm 峰值。')
  },
  {
    id: 'grunge',
    term: T('Grunge / dirt mask', '污渍 / 脏污遮罩'),
    tag: 'node',
    desc: T('A layered noise preset with threshold and contrast, tuned to read as dirt, wear and patchy deposits.',
      '带阈值与对比控制的层叠噪声预设，用于表现脏污、磨损、斑驳沉积。'),
    app: T('Grunge node with `Threshold` + `Contrast`; very often used as a coverage mask before a Blend.',
      '污渍节点的 `阈值` + `对比`；常被用作混合前的覆盖遮罩。')
  },
  {
    id: 'gradient-map',
    term: T('Gradient map', '渐变映射'),
    tag: 'color',
    desc: T('Re-maps the luminance of an input through a colour ramp. The standard way to turn a noise mask into a colour, keeping palette control in one place.',
      '把输入的亮度重映射到一条颜色渐变上。把噪声遮罩变成彩色的标准做法，调色集中在一处。'),
    app: T('Gradient Map node (`Colors`, `Contrast`, `Offset`, `Invert`). Sample the ramp from the reference image\'s luminance quantiles to match a photo\'s palette.',
      '渐变映射节点（`颜色`、`对比`、`偏移`、`反转`）。用参考图亮度分位数生成色标可以复刻照片的调色板。')
  },
  {
    id: 'levels',
    term: T('Levels', '色阶'),
    tag: 'color',
    desc: T('Input black/white points, gamma and output range. Used to set the contrast window of a stream.',
      '输入黑/白点、伽马、输出范围。用于设置一条数据流的对比窗口。'),
    app: T('Levels node. Gamma is `pow(x, 1/gamma)` so **>1 brightens**. Also: the window must be set to the stream\'s *actual* value range, otherwise the mask saturates to 0 or 1.',
      '色阶节点。伽马按 `pow(x, 1/gamma)`，所以 **>1 是提亮**。另外：窗口必须落在这条数据流的**实际**值域上，否则遮罩会饱和成 0 或 1。')
  },
  {
    id: 'histogram-scan',
    term: T('Histogram scan', '直方图扫描'),
    tag: 'color',
    desc: T('A smooth threshold: “position” sets the pivot, “contrast” the width of the transition. Unlike a hard threshold it keeps a controllable soft edge.',
      '平滑阈值：`位置` 设枢轴，`对比` 设过渡宽度。与硬阈值不同，它保留可控的软边。'),
    app: T('Histogram Scan node — the usual way to mask a blend softly.',
      '直方图扫描节点——给混合做软遮罩的常用手段。')
  },
  {
    id: 'blend-modes',
    term: T('Blend modes', '混合模式'),
    tag: 'color',
    desc: T('How two streams combine: Copy, Add, Subtract, Multiply, Screen, Min/Max, Difference, Divide, Overlay, Soft Light, Exclusion…',
      '两条数据流如何合并：复制、相加、相减、相乘、滤色、取最小/最大、差值、除法、叠加、柔光、排除……'),
    app: T('Blend node (15 modes + `mask` + `opacity`). **All maths is linear light**, so Overlay/Screen with a mid-grey input is *not* neutral the way it is in Photoshop: Screen with 0.5 adds roughly half white, and Overlay with a bright mask pushes colour toward white. Prefer Multiply (hue-preserving) or narrow the mask first.',
      '混合节点（15 模式 + `mask` + `opacity`）。**全部在线性光下运算**，所以中灰输入下的叠加/滤色并不像 Photoshop 那样中性：0.5 的滤色约等于加半白，叠加遇到亮遮罩会把颜色推向白。优先用乘法（保色相）或先把遮罩压窄。')
  },
  {
    id: 'warp',
    term: T('Warp / distortion', '扰动 / 形变'),
    tag: 'node',
    desc: T('Displaces a stream by the RG vector of a warper input — the standard way to break a regular pattern into an organic one.',
      '用扰动输入的 RG 向量偏移数据流——把规则图案打散成有机形态的标准手段。'),
    app: T('Warp node (`input`, `warper`, `Intensity`). A greyscale warper displaces diagonally; feed an RG built with Channel Combine for independent X/Y. Also the cure for Tile Generator\'s lattice.',
      '扰动节点（`input`、`warper`、`强度`）。灰度扰动会沿对角偏移；需要独立 X/Y 时用通道组合拼一个 RG。也是打散瓷砖生成器晶格的办法。')
  },
  {
    id: 'morphology',
    term: T('Morphology (dilate / erode)', '形态学（膨胀 / 腐蚀）'),
    tag: 'node',
    desc: T('Grows (dilate) or shrinks (erode) bright shapes by a radius — useful for wearing edges, chipped paint, moss overhang.',
      '按半径生长（膨胀）或收缩（腐蚀）亮部图形——用于边缘磨损、掉漆、苔藓外溢。'),
    app: T('Morphology node, separable two-pass dilate/erode.',
      '形态学节点，可分离两遍的膨胀/腐蚀。')
  },
  {
    id: 'curvature',
    term: T('Curvature', '曲率'),
    tag: 'data',
    desc: T('A laplacian measure of how convex or concave a height field is at each point: edges catch light, cavities shadow.',
      '用拉普拉斯算子衡量高度场每点的凸凹：边缘受光、凹处变暗。'),
    app: T('Curvature node (`Both` / `Convex only` / `Concave only`) — great for edge wear masks.',
      '曲率节点（`双向` / `仅凸` / `仅凹`）——做边缘磨损遮罩很好用。')
  },
  {
    id: 'sdf',
    term: T('SDF (signed distance field)', 'SDF（有符号距离场）'),
    tag: 'node',
    desc: T('A field storing the distance to the nearest shape boundary, negative inside. Gives crisp anti-aliased shapes at any resolution.',
      '存储到最近形状边界距离的场，内部为负。任意分辨率下都能得到干净的抗锯齿形状。'),
    app: T('Shape node (rounded box / ellipse / polygon / star, with softness and invert).',
      '形状节点（圆角矩形 / 椭圆 / 多边形 / 星形，可调柔化与反转）。')
  },
  {
    id: 'tiles-node',
    term: T('Tile / brick generators', '瓷砖 / 砖块生成器'),
    tag: 'node',
    desc: T('Lay out cellular patterns (running-bond bricks, tiles with per-cell offset/rotation/scale). Their per-cell randomisation is the closest thing the library has to scattering objects.',
      '排布单元图案（错缝砖、带逐单元偏移/旋转/缩放的瓷砖）。它们的逐单元随机化是库里最接近“散布物件”的东西。'),
    app: T('Brick Wall (`cols`×`rows`, mortar, bevel, variation) and Tile Generator (`Count X/Y`, `Gap`, `Randomness`, `Random Rotation`). Caveat: with `Randomness` high, neighbouring cells are pushed apart, which can widen the gaps far beyond `Gap`; and the cells are still on a lattice, so add a Warp to break it. Use `count N×1` for full-height strips (e.g. wooden planks).',
      '砖墙（`列`×`行`、灰缝、倒角、变化）与瓷砖生成器（`X/Y 数量`、`缝隙`、`随机程度`、`随机旋转`）。注意：`随机程度` 高时相邻单元会被推开，缝隙可能远超 `缝隙` 参数；而且单元仍在晶格上，需要再加扰动打散。要整高条带（如木板）时用 `数量 N×1`。')
  },
  {
    id: 'paint-layer',
    term: T('Paint layer', '绘制层'),
    tag: 'node',
    desc: T('A hand-painted RGBA layer composited into the graph, with blend mode, opacity and an optional mask input.',
      '手绘的 RGBA 图层，混合进节点图，可设混合模式、不透明度与可选遮罩输入。'),
    app: T('Paint Layer node (`input`, `mask`, `Opacity`, `Blend`, `Use Mask Input`). Strokes are stored as data and rasterised to a texture.',
      '绘制层节点（`input`、`mask`、`不透明度`、`混合`、`使用蒙版输入`）。笔画以数据保存并栅格化为贴图。')
  },
  {
    id: 'alpha-mode',
    term: T('Alpha mode: opaque / masked / blended', 'Alpha 模式：不透明 / 遮罩 / 混合'),
    tag: 'export',
    desc: T('Opaque ignores alpha; Masked cuts out pixels below a cutoff (foliage, grates); Blended uses alpha for translucency. The mode is recorded in the manifest so importers set up the material correctly.',
      '不透明忽略 Alpha；遮罩按阈值抠掉像素（植被、格栅）；混合用 Alpha 表现半透明。模式会写进 manifest，导入方可正确设置材质。'),
    app: T('PBR Output → “Alpha Mode” + `Alpha Cutoff`; only Base Color gets an alpha channel in the export.',
      'PBR Output 的“Alpha 模式” + `Alpha Cutoff`；导出时只有 Base Color 带 Alpha 通道。')
  },
  {
    id: 'manifest',
    term: T('manifest.json', 'manifest.json'),
    tag: 'export',
    desc: T('Machine-readable description of the exported package: resolution, per-channel colour space, bit depth, normal convention, alpha mode, packing layout.',
      '导出包的机器可读描述：分辨率、各通道色彩空间、位深、法线约定、Alpha 模式、打包布局。'),
    app: T('Written by the server next to the PNGs and inside the zip; the Export dialog shows the same text.',
      '由服务器写在 PNG 旁边并放进 zip；导出面板里显示同样的文本。')
  },
  {
    id: 'ibi-aces',
    term: T('IBL & ACES tone mapping', 'IBL 与 ACES 色调映射'),
    tag: 'pipeline',
    desc: T('Image-based lighting lights the preview from a (procedural) environment instead of point lights; ACES is a filmic tone curve that keeps highlights from clipping.',
      'IBL 用（程序化）环境光照亮预览而不是点光源；ACES 是电影感色调曲线，避免高光硬切。'),
    app: T('The 3D View uses procedural IBL + ACES; it is a *preview* — your exported maps do not contain any lighting.',
      '3D 视图用程序化 IBL + ACES；它只是**预览**——导出的贴图里没有任何光照信息。')
  },
  {
    id: 'mcp',
    term: T('MCP (Model Context Protocol)', 'MCP（模型上下文协议）'),
    tag: 'pipeline',
    desc: T('A standard JSON-RPC protocol that lets an AI agent call a tool catalog. The agent sees tool names, input schemas and annotations; the app executes and returns structured results.',
      '一种标准 JSON-RPC 协议，让 AI agent 调用工具目录。agent 看到工具名、输入 schema 与注解；应用执行并返回结构化结果。'),
    app: T('32 `substrate_*` tools (graph, paint, evaluate, export…), reachable over stdio, `POST /mcp` or `POST /api/mcp/call`. The browser tab must be open because the GPU work happens there.',
      '32 个 `substrate_*` 工具（建图、绘制、求值、导出……），可通过 stdio、`POST /mcp` 或 `POST /api/mcp/call` 调用。浏览器标签页必须开着，因为 GPU 运算在那边。')
  },
  {
    id: 'ssse-bridge',
    term: T('SSE bridge', 'SSE 桥接'),
    tag: 'pipeline',
    desc: T('The Node server holds a Server-Sent Events stream to the open studio tab and forwards tool calls down it; the tab posts results back. That is how an external process drives an in-browser GPU app.',
      'Node 服务器与打开的工作室标签页保持一条 Server-Sent Events 连接，把工具调用推下去，标签页把结果回传。外部进程就是这样驱动浏览器里的 GPU 应用的。'),
    app: T('`connectedClients` / `pendingJobs` in `/api/health`. Note the gateway dispatches per SSE client, so several open tabs round-robin — keep a single tab when scripting.',
      '`/api/health` 里的 `connectedClients` / `pendingJobs`。注意网关按 SSE 客户端派发，多个标签页会轮询——用脚本驱动时只留一个标签页。')
  },
  {
    id: 'dead-node',
    term: T('Dead node (unreachable)', '死节点（不可达）'),
    tag: 'pipeline',
    desc: T('A node that is not an ancestor of the PBR Output. It costs no GPU time but stays in the project file and on the canvas, which makes a graph hard to review.',
      '不是 PBR Output 祖先的节点。它不耗 GPU，但会留在工程文件和画布上，让图难以复核。'),
    app: T('Symptoms of rewiring: you changed a link and the old branch stayed. Diagnosis: walk the graph backwards from the output (agents can do this via `substrate_get_graph`); fix: delete them, or reopen the saved project. The built-in self-test does not flag them.',
      '改接线后旧分支留在原地的典型产物。诊断：从输出反向遍历（agent 可用 `substrate_get_graph` 做）；处理：删掉，或重新打开已保存的工程。内置自检不会报告它们。')
  }
]
