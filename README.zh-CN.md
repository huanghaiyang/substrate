# Substrate —— 程序化贴图工作室

**English** · [简体中文](README.zh-CN.md) · [完整中文文档](docs/zh/README.md)

一款 **Substance Designer 风格**的材质创作工具：用节点图在 GPU 上生成 PBR 贴图，手动绘制细节，以受光的 3D 材质球实时预览，并导出符合行业标准的贴图包。

**Vue 3 + Three.js + Node.js** · 零打包器原生 ES Module · WebGL2（RGBA16F）· 运行无需构建步骤。

![节点图与 3D 预览](docs/screenshots/01-graph-3d.png)

---

## 功能亮点

- **节点图编辑器**——画布平移/缩放、拖拽连线（带**吸附输入端口的三次曲线实时预览**）、框选、撤销/重做、使用真实 GPU 结果生成的节点缩略图、右键搜索式快速添加节点。
- **36 个 GPU 节点**——可平铺 fBm Perlin、Worley/细胞噪声、Grunge、图案、SDF 形状、渐变、模糊、扭曲、法线/AO/曲率生成、混合模式、通道合并辅助节点。
- **手绘**——完整绘制工作室，两组共 **16 个内置笔刷**：*基础*（软/硬圆头、铅笔、墨水、喷枪、马克笔、粉笔、喷雾、海绵、平头）与 *自然*（**草、叶、花、树、蕨、树枝**，程序化绘制并带旋转/缩放抖动），由 grain、scatter、flow、spacing 驱动，支持压感大小/流量、硬度/不透明度、橡皮擦、填充、X/Y 对称和整笔撤销。笔触使用 **三次 Bézier 曲线**平滑（Catmull-Rom 经过采样点），可选**笔锋**让笔画两端收细。笔刷及设置跨会话记忆。绘制结果栅格化为 canvas 纹理并参与节点图合成，因此笔触可驱动基色、粗糙度、高度、遮罩等任意通道。
- **实时 PBR 预览**——Three.js `MeshStandardMaterial`，程序化 IBL、ACES 色调映射、五种预览网格、平铺、置换和自动旋转。
- **2D 通道检查**——全部 8 个 PBR 通道，带色彩空间标签，一键全尺寸查看。
- **行业标准导出**——五种预设（glTF/three.js、Unreal、Unity HDRP、V-Ray/Arnold/通用、Substance Painter），正确处理 sRGB/线性空间、ORM / Mask Map 打包、OpenGL↔DirectX 法线翻转、16-bit 高度、自适应滤波 PNG 编码，并由 Node 服务端生成 `manifest.json` + `README.md` + zip 包。
- **MCP / Agent 集成**——标准化外部 MCP 网关**随应用启动**（stdio + HTTP JSON-RPC，32 个工具），内置 **MCP 自检**；同时提供页面内 WebMCP 工具。
- **AI 助手**——顶栏 **✦** 面板，默认接入 DeepSeek，也可切换任意 OpenAI 兼容提供商。助手运行在**服务端**，通过 MCP 工具操作应用（编辑节点图、绘制、求值、导出）。API Key 永不进入浏览器；模型/提供商可在面板中添加和切换。
  聊天支持附件：图片（PNG/JPEG/WebP）会加入素材库，**并发送给支持视觉的模型做真实图像识别**（DeepSeek 端点支持视觉；不支持视觉的提供商会退化为元信息），
  也可通过 `substrate_list_assets`/`substrate_apply_asset` 使用；文本文件随消息发送。工具自带可直接复制的示例，参数错误会返回 `details.example`/`details.availableNodes` 提示。
- **持久化 AI 对话**——完整历史与工具轨迹自动保存、刷新后恢复，可导出 Markdown；关闭对话框**不会中断回复**，对话进行中会在右下角显示半透明浮动窗口（自动滚动、可展开）。强制 AI 规则禁止触碰源码、API Key/环境变量、文件或系统信息。
- **素材库**——导入 PNG/JPEG/WebP 贴图、**联网搜索**开放授权素材、预览/删除，并可作为节点贴图或绘制层图案填充（在线结果保留作者/许可证署名）。
- **自定义笔刷**——从 JSON 导入笔刷定义（完整预设参数），本地保存并显示在“自定义”分组；详见 [docs/zh/brushes.md](docs/zh/brushes.md)。
- **可验证管线**——内置自检审计每个 GLSL 程序、求值节点图、验证法线与无缝平铺并导出贴图包；独立 Node 验证器解码 PNG、校验 CRC、chunk 色彩空间、位深、zip 完整性和接缝。

![绘制工作室](docs/screenshots/03-paint-studio.png)

---

## 双语界面

整个界面提供 **English** 与 **简体中文**——用顶栏 `EN / 中文` 切换，或在 URL 加 `?lang=zh` / `?lang=en`。选择会被记住；首次启动跟随浏览器语言。

节点名称、描述、参数标签、下拉选项、提示、状态栏、历史操作、对话框、错误信息与帮助文本全部已翻译。你的数据（项目名、材质名、自定义节点标题）不会被改写——材质名还会额外保持 ASCII 友好以用于导出文件名。

| 中文界面 · 节点图 | 中文界面 · 导出对话框 |
| --- | --- |
| ![中文节点图](docs/screenshots/05-zh-graph.png) | ![中文导出](docs/screenshots/08-zh-export.png) |

![中文界面 · 2D 通道贴图](docs/screenshots/06-zh-maps.png)

![中文界面 · 绘制工作室](docs/screenshots/07-zh-paint.png)

---

## 文档

- 中文文档索引：[docs/zh/README.md](docs/zh/README.md)
  - [MCP 集成](docs/zh/mcp.md) · [AI 助手与安全](docs/zh/llm.md) · [联网素材搜索](docs/zh/asset-search.md) · [自定义笔刷格式](docs/zh/brushes.md)
- English docs: [`README.md`](README.md) · [`docs/mcp.md`](docs/mcp.md) · [`docs/llm.md`](docs/llm.md) · [`docs/asset-search.md`](docs/asset-search.md) · [`docs/brushes.md`](docs/brushes.md)

要求：**Node.js 18+** 与支持 **WebGL2** 的浏览器（Chrome/Edge/Firefox/Safari 16+）。

```bash
npm install          # 安装 vue + three（应用本身不需要打包器）
npm start            # http://127.0.0.1:3000
```

其他脚本：

```bash
npm run build        # 把应用与 vendor ESM 复制到 dist/
npm run serve:dist   # 在 3000 端口服务构建后的 dist/
PORT=3001 npm start  # 自定义端口
```

首次启动会按浏览器语言加载内置示例材质（可加 `?lang=zh` 或 `?lang=en` 强制）。随时点击 **? → 运行自检** 执行内置 2,227 项审计。编辑、绘制、导出都会被持久化到浏览器（本地自动保存），也可保存为服务端命名项目。

---

## 使用应用

### 语言 / Language

使用顶栏 **EN / 中文**（或 `?lang=zh` / `?lang=en`）。所选语言会被记住：写入 `localStorage` **并**同步到 URL 的 `?lang=` 参数，因此刷新页面（或重新打开同一书签）会保持上次选择，而不是回退到浏览器语言。没有任何已保存偏好时跟随 `navigator.language`。切换即时生效，不重载页面、不影响节点图。

### 节点图编辑

- **添加节点**——点击节点库条目，或右键画布打开可搜索的快速添加菜单。
- **连接**——从节点右侧端口拖到输入点。拖动时曲线预览跟随光标并吸附最近的输入端口（带端点标记）。连线是无类型的 RGBA 流；每个节点返回线性光 RGBA 纹理。

![实时曲线连接预览](docs/screenshots/09-connection-curve.png)

- **选择 / 移动**——单击、Shift 单击或空白画布框选。拖动节点重新布局。
- **删除**——`Del` 删除选中节点或连线。右键节点可复制/断开/删除。
- **撤销 / 重做**——`Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`（工具栏也可）。
- **一键整理**——点击工具栏 **⌗** 自动整理节点图：分层从左到右、重心法减少交叉、按真实节点高度排布且不重叠；整个操作是一步撤销，完成后自动适配视图。Agent 也可调用 `substrate_auto_layout`。

### 编辑参数

选中节点后，属性面板显示 schema 驱动的控件：滑块 + 数值框、开关、下拉菜单、颜色选择器、2D 向量，以及多停靠点渐变编辑器（点击色带添加停靠点，拖动/选中编辑）。

### 绘制

双击 **绘制层（Paint Layer）**节点（或选中后点击 *打开绘制工作室*）。

- **笔刷库**——两组共 16 个内置预设：
  * **基础**——*软圆头*（喷枪衰减）、*硬圆头*、*铅笔*（颗粒、压感）、*墨水*（紧实、不透明）、*喷枪*（低流量、慢慢累积）、*马克笔*（斜平头）、*粉笔*（重颗粒 + 散布）、*喷雾*（散落液滴）、*海绵*（稀疏多孔）和*平头笔刷*。
  * **自然**——*草*（扇形细叶）、*叶*（带叶脉轮廓）、*花*（花瓣 + 花心）、*树*（树干 + 树冠斑点）、*蕨*（带小叶的羽叶）和*树枝*（带叶细枝）。每个植物图案都程序化绘制，逐笔旋转/缩放并按笔刷颜色着色，可铺成草地、树篱、花丛和森林剪影。

![自然笔刷——草、叶、花、树、蕨、树枝](docs/screenshots/10-nature-brushes.png)

- **笔刷动态**——大小、不透明度、硬度、**flow** 与 **spacing** 可逐笔刷调整；颗粒、散布与印章形状来自预设。所有笔刷在合适处响应压感大小/流量。
- **平滑笔触**——指针路径用 Catmull-Rom 样条插值，并沿三次 Bézier 段盖章，因此快速移动会得到干净曲线而非折线。实时预览会在已提交图层之上重新栅格化平滑笔触，所见即最终保存结果。
- **笔锋（可选）**——开关加长度控制，让笔画两端像提笔一样收细；按笔触保存，旧笔触不受影响，撤销/重做保持确定性。
- 选中的笔刷、设置和颜色保存在浏览器中，下次绘制自动恢复。
- **自定义笔刷**——导入 JSON 笔刷定义（`docs/zh/brushes.md`）；显示在 *自定义* 分组，可单独删除，保存在本地。素材库导入的**素材**可在绘制工作室的素材条中作为重复图案填充到绘制层。
- 橡皮擦（destination-out）、填充和 X/Y 镜像对称对所有笔刷生效。
- 笔触以数据形式保存，栅格化到 1024²，作为纹理上传并合成到节点流；下游贴图与 3D 预览实时更新。
- 请把笔触保持在画布边界内——绘制纹理按 wrap 采样以实现无缝平铺。
- 撤销以整笔为单位；填充与清空同样是可撤销操作。

### 2D 通道贴图

把右侧面板切到 **2D 贴图**，查看 8 个 PBR 通道的色彩空间与打包信息，点击任意贴图全尺寸查看。

![通道贴图](docs/screenshots/02-channel-maps.png)

### 导出

点击 **导出材质**，选择预设、分辨率（512 → 4096）和法线约定。

![导出对话框](docs/screenshots/04-export-dialog.png)

服务端会把贴图包写到 `exports/<material>-<timestamp>/` 并返回 zip。对话框提供逐文件下载、zip 下载，以及可复制的 manifest/README 文本。

---

## 架构

```
┌──────────────────────────── 浏览器（原生 ESM，无打包器） ───────────────────────────────┐
│  Vue 3 UI（运行时模板编译器）                                                              │
│   App · GraphEditor · Inspector · NodePalette · Preview3D · MapPanel · PaintStudio ·        │
│   ExportDialog · AiPanel · AiFloating · AssetLibrary                                       │
│                                                                                           │
│  engine/store.js     响应式图模型、撤销历史、绘制同步、自动保存                              │
│  engine/engine.js    WebGL2 渲染目标图求值器（Three.js RawShaderMaterial）                  │
│  engine/compiler.js  节点定义 → GLSL ES 3.00 片元着色器                                    │
│  engine/nodes/*.js   声明式节点库：输入、参数 schema、GLSL 主体                              │
│  engine/png.js       PNG 编码器：8/16-bit、灰度/RGB/RGBA、自适应行滤波、sRGB                  │
│  engine/exporter.js  通道打包、PNG 规划、manifest/README 生成                              │
│  engine/selftest.js  着色器审计 + 图/法线/接缝校验 + 导出测试                                │
│  engine/paint.js     Catmull-Rom → 三次 Bézier 笔触平滑 + 笔刷印章 + 笔锋                     │
│  engine/brushes.js   内置笔刷预设 + 预览缩略图                                              │
│  engine/mcp-catalog.js 共享 MCP 工具目录 + JSON-Schema 校验                                 │
│  engine/mcp-commands.js 外部工具目录的浏览器 handler                                        │
│  engine/mcp-bridge.js 到 Node 网关的 SSE 桥接（window.__MCP__）                             │
│  engine/ai-chat.js    持久化 AI 对话 store（面板关闭/刷新后仍存活）                           │
│  engine/webmcp.js    供 Agent 驱动验证的 WebMCP 工具面                                       │
│  i18n/                双语 UI 目录 + 本地化节点/参数定义                                     │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                            │ /api（JSON，base64 PNG 负载）
┌───────────────────────────────────────────▼───────────────────────────────────────────────┐
│  Node.js 服务端（node:http，零依赖）                                                       │
│   MCP 网关：SSE 桥接、工具分发、POST /mcp JSON-RPC、/api/mcp/call                           │
│   LLM 代理 + 工具循环 · 素材库存储/搜索/导入 · 项目保存/加载 · 导出写入 · zip（store/deflate）  │
│   自动化自检的调试报告接收端                                                                 │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### 为什么使用零打包器 ESM？

应用以普通 ES Module 提供，**import map** 把 `vue` 和 `three` 指向已安装的 ESM 构建（`/vendor/...`）。`npm install` 只用于获取这两个库——没有转译、打包或 dev-server 层。组件是普通 `.js` 模块 + Vue 模板字符串；`npm run build` 只是把应用和两个 vendor 入口复制到 `dist/` 以便部署。

这让开发与生产运行环境完全一致，消除构建工具故障模式，并让整个应用都能在浏览器网络面板中检查。

### GPU 图求值

- 每个节点把全屏四边形渲染到 **RGBA16F** 渲染目标（`THREE.WebGLRenderTarget`），线性光空间。
- 节点定义是声明式的：输入、参数 schema 和实现 `vec4 nodeColor(vec2 uv)` 的 GLSL 主体。编译器生成完整 GLSL ES 3.00 片元着色器（uniform 声明、渐变采样函数、共享噪声/颜色辅助函数、输出钳制）。
- 多 pass 节点（`Blur`、`Morphology`）通过 `uPrev` 读取上一 pass；可分离滤波运行两个 pass。
- 图从 PBR 输出端做拓扑排序；每个节点获得类型、参数、输入哈希、分辨率、绘制/图片版本组成的**结构哈希**。未变化分支直接走 LRU 缓存，因此拖动滑块只重算下游节点。
- 可平铺生成器使用周期性哈希（`mod(cell, period)`），所有噪声/图案节点都精确环绕。
- 求值按文档分辨率 × 代理倍率运行；导出会在目标分辨率重新烘焙，并以流式模式在最后一个消费者完成后释放中间目标。

### 色彩管理

- 所有处理都在 **RGBA16F** 目标上以**线性光**进行。
- 颜色参数以 sRGB 创作，上传时转为线性（包括渐变停靠点）。
- 基色与自发光在读回/导出时编码为 sRGB；法线、粗糙度、金属度、AO、高度保持线性。
- 3D 预览把基色/自发光纹理标记为 `SRGBColorSpace`，其余标记为线性数据。

### 导出管线

1. 在导出分辨率求值节点图（流式模式，引用计数释放目标）。
2. 每个通道经过编码 pass 读回为 RGBA8（8-bit）或 RGBA32F → unorm16（16-bit）。
3. 按预设打包通道：基色（+alpha）、法线（带 OpenGL↔DirectX 绿色翻转）、ORM、Unity Mask Map，或分离的粗糙度/金属度/AO/高度贴图。
4. 页面内编码 PNG：高度为 16-bit 灰度，其余为 8-bit RGB/RGBA/灰度；使用**自适应逐行滤波**（None/Sub/Up/Average/Paeth）减小体积；颜色贴图写入 `sRGB` chunk；写入 `Software` tEXt 元数据。
5. 把文件与 manifest/README POST 给服务端，服务端写目录并构建 zip（PNG 条目 stored、文本条目 deflate；全程 CRC-32）。

---

## 节点库

| 分类 | 节点 |
| --- | --- |
| **输入** | 纹理输入（位图加载）、常量值（原始数据）、纯色 |
| **噪声** | Perlin 噪声（可平铺 fBm）、细胞噪声（F1/F2/边界）、Grunge |
| **图案** | 波纹图案、棋盘格、砖墙、瓷砖生成器（彩色瓷砖或倒角高度） |
| **形状** | 形状（圆角矩形 / 椭圆 / 多边形 / 星形 SDF） |
| **颜色** | 渐变（多停靠点、4 种模式）、渐变映射、通道合并 |
| **绘制** | 绘制层（笔刷、对称、混合模式、遮罩输入） |
| **滤镜** | 模糊、方向模糊、锐化、高反差保留、浮雕、扭曲、边缘检测、形态学（膨胀/腐蚀）、2D 变换 |
| **混合** | 混合（15 种模式、不透明度、遮罩） |
| **调整** | Levels、直方图扫描、反相、HSL、去饱和、阈值、色调分离 |
| **法线** | 法线（高度 → 切线空间法线，OpenGL/DirectX）、环境光遮蔽、曲率 |
| **输出** | PBR 输出（8 通道、材质名、法线约定、alpha 模式） |

所有生成器与分辨率无关且无缝。跨纹理边缘采样的滤镜继承 wrap，因此管线端到端保持平铺（可用自检接缝比 ≈ 1.0 验证）。

---

## 已实现的行业标准

| 关注点 | 实现 |
| --- | --- |
| **色彩空间** | 线性光处理；仅基色/自发光做 sRGB 编码；数据贴图保持线性（相应存在/不存在 `sRGB` PNG chunk）。 |
| **金属/粗糙度工作流** | 金属度与粗糙度分别导出，并为 glTF/Unreal 打包（`ORM`：R=AO，G=粗糙度，B=金属度）。 |
| **Unity HDRP Mask Map** | R=金属度，G=AO，B=细节(0.5)，A=光滑度（1−粗糙度）。 |
| **法线贴图** | 切线空间、8-bit RGB、着色器中归一化；可选 OpenGL(+Y) 或 DirectX(−Y)，导出时做源→目标转换。 |
| **高度/置换** | 16-bit 灰度 PNG，可选 min/max 归一化用于置换和视差。 |
| **Alpha** | `不透明 / 遮罩 / 混合`——启用时基色导出带 Opacity 通道的 RGBA。 |
| **平铺** | 所有生成器周期性；PNG 接缝比程序化验证。 |
| **打包元数据** | `manifest.json`（分辨率、色彩空间、法线约定、alpha 模式、ORM 打包、逐文件位深）以及含 three.js/Unreal/Unity 导入说明的 `README.md`。 |
| **PNG 正确性** | 合法 IHDR/IDAT/IEND、逐 chunk CRC-32、`CompressionStream` zlib 流（带 stored-deflate 回退）、自适应滤波、8/16-bit 灰度/RGB/RGBA。 |
| **Zip 完整性** | 本地 + 中央目录头、CRC-32、store/deflate 方法，由独立解析器验证。 |

---

## 项目持久化与服务端 API

项目是 JSON 图（`projects/<slug>.json`），通过工具栏 **保存** / **打开** 创建。当前会话还会自动保存到 `localStorage`，刷新即可恢复。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/health` | 服务端模式、版本、项目/导出数量。 |
| `GET /api/projects` | 列出已保存项目（名称、分辨率、节点数、时间戳）。 |
| `POST /api/projects/save` | 保存项目 JSON（`{name, graph, resolution}`）。 |
| `GET /api/projects/load?name=` | 按名称加载项目。 |
| `POST /api/export` | 写入材质包与 zip（`{materialName, files:[{path,data:base64}], manifest, readme}`）。 |
| `GET /api/exports` | 最近导出包。 |
| `POST /api/debug/report` · `GET /api/debug/last?kind=` | 自动化自检报告接收端。 |
| `GET /exports/...` | 已导出包（zip 通过 `Content-Disposition` 提供）。 |

---

## MCP 集成（外部 Agent）

网关是普通服务端的一部分，**随应用启动**：`npm start` 在同一端口提供工作室与 MCP 端点，打开工作室标签页会自动连接（除非 `?mcp=off`）。内置自检验证接口：

```bash
npm run audit:mcp        # 30 项：目录、校验、桥接往返、网关自检
curl -s localhost:3000/api/mcp/selfcheck
```

Substrate 提供零依赖的 **Model Context Protocol** 网关，让 Agent 通过统一接口驱动工作室。工具目录只在 [`src/engine/mcp-catalog.js`](src/engine/mcp-catalog.js) 定义一次，由浏览器、HTTP 网关与 stdio 服务器共享。

```
MCP client ──stdio──▶ mcp/server.mjs ──HTTP──▶ server/index.js ──SSE──▶ browser tab (WebGL)
```

- **传输方式**——stdio（`node mcp/server.mjs`，配置示例在 [`mcp/`](mcp/)）、`POST /mcp` 的 HTTP JSON-RPC，以及 `POST /api/mcp/call` 的简易 JSON 端点。发现：`GET /api/mcp/tools`。
- **32 个工具**——`substrate_get_state`、`substrate_get_graph`、`substrate_add_node`、`substrate_set_param`、`substrate_connect`、`substrate_paint_stroke`、`substrate_get_preview`（2D 通道 / 3D 材质球 PNG）、`substrate_search_open_assets`、`substrate_import_asset_url`、`substrate_list_assets`、`substrate_apply_asset`、`substrate_export`、`substrate_run_audit`、项目保存/加载……完整列表与调用规范见 [docs/zh/mcp.md](docs/zh/mcp.md)。
- **连线端口安全**——`substrate_get_graph` 返回每个节点的 `inputPorts`；`substrate_connect` 对未知端口返回
  `details.availablePorts`（单输入节点的 `in` 别名会自动纠正），旧项目加载时自动修复，自检新增
  `connectionPortsValid`，避免“连线被静默忽略导致贴图看起来没采样”。
- **标准化契约**——稳定的 `substrate_<verb>_<noun>` 命名、JSON-Schema 参数校验（含嵌套的绘制点）、工具目录内置示例、可操作的错误提示：`INVALID_ARGUMENT` 返回 `details.example` 与输入 schema，`NOT_FOUND` 返回 `details.availableNodes`；包含 `readOnlyHint`/`destructiveHint`/`idempotentHint` 注解、逐工具超时、`apiVersion`，以及统一信封：`{ ok, apiVersion, tool, data, meta }` 或 `{ ok:false, error:{ code, message } }`。
- **要求**——工作室必须运行且浏览器标签页打开（图在那里由 GPU 求值）。设置 `MCP_TOKEN` 可要求外部端点携带 Bearer Token。

```json
{
  "mcpServers": {
    "substrate": {
      "command": "node",
      "args": ["/absolute/path/to/texture-designer/mcp/server.mjs"],
      "env": { "SUBSTRATE_URL": "http://127.0.0.1:3000" }
    }
  }
}
```

完整参考、curl 示例、认证、自检与限制：[docs/zh/mcp.md](docs/zh/mcp.md)。在线素材：[docs/zh/asset-search.md](docs/zh/asset-search.md)。
用 `npm run test:mcp` 测试（需要应用标签页打开；79 项接口检查，覆盖 LLM Key 脱敏、AI 规则、联网搜索防护和素材库 API）。

## AI 助手

从顶栏打开 **✦ AI 助手** 面板。默认连接 **DeepSeek Chat**（配置的 Key 只存在于 Node 服务端），可在 ⚙ 设置中切换到 **DeepSeek Reasoner** 或任意额外 OpenAI 兼容提供商/模型。

- 用自然语言对话；助手调用与外部 Agent 相同的 32 个 MCP 工具，并在回复下方显示每次工具调用（✓/✕）。
- 从顶部下拉切换模型；添加提供商需填写显示名、Base URL、模型 ID 和 API Key。Key 只写服务端，永不返回浏览器或显示。
- **完整对话历史持久化**，刷新后恢复；**⤓** 导出 Markdown。回复进行中关闭面板会保持请求继续运行，并在右下角半透明浮动窗口显示实时记录（自动滚动，**⤢** 展开回完整面板）。
- **AI 规则**（服务端强制执行）：助手只能通过工具操作本工作室，不能读取/修改源码、文件、环境变量、API Key 或系统信息。规则在 ⚙ 设置中只读展示，并由 `GET /api/llm/rules` 提供。
- **联网素材搜索**：助手可调用 `substrate_search_open_assets` / `substrate_import_asset_url` 查找并导入开放授权图片，并报告作者与许可证。配置 `PEXELS_API_KEY`、`PIXABAY_API_KEY` 或 `UNSPLASH_ACCESS_KEY`（环境变量或 `asset-search.local.json`）可获得语义搜索；详见 [docs/zh/asset-search.md](docs/zh/asset-search.md)。
- **思考过程可见**——服务端捕获 DeepSeek Reasoner 的 `reasoning_content` 以及普通对话模型的计划文本，按步骤显示在回复上方的可折叠**思考过程**中，并随对话持久化、写入 Markdown 导出。
- **长时间工具任务有步数保护并会给出汇总**：搭图过程若耗尽工具步数预算，助手会返回进度汇总（标记 `hitStepLimit`）而不是直接报错；该提示随对话保存，回复“继续”即可接着完成。
- **◎** 运行 MCP 自检；帮助对话框也有同样入口。
- 配置、接口与安全模型：[docs/zh/llm.md](docs/zh/llm.md)。

![AI 助手通过 MCP 工具驱动工作室](docs/screenshots/11-ai-assistant.png)

面板关闭但回复仍在生成时，对话会继续在右下角半透明浮动窗口显示：

![浮动 AI 对话窗口](docs/screenshots/13-ai-floating.png)

## 素材库

顶栏 **▦** 打开素材库。可导入 PNG/JPEG/WebP 贴图（或拖入对话框）；每个素材可预览、删除，并用于：

- **节点贴图**——创建/更新 *纹理输入* 节点（图片嵌入项目，项目保持自包含），或
- **绘制图案**——把图片作为重复图案填充到绘制层（绘制工作室内的素材条也可操作）。

素材保存在本地服务端 `assets/`（git 忽略），图案通过 URL 引用。

使用对话框中的**搜索框**联网查找开放授权素材（`substrate_search_open_assets`），再点击结果的 **导入**：图片由服务端下载、校验（公网 http(s)、PNG/JPEG/WebP、≤32MB），并保存 **作者 / 许可证 / 来源署名**。提供商配置与兜底行为见 [docs/zh/asset-search.md](docs/zh/asset-search.md)。

![带联网搜索的素材库](docs/screenshots/12-material-library.png)

## 快捷键

| 按键 | 操作 |
| --- | --- |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` | 撤销 / 重做 |
| `Ctrl/Cmd + D` | 复制选中节点 |
| `Del` / `Backspace` | 删除选中节点或连线 |
| `Ctrl/Cmd + S` | 保存项目 |
| `Ctrl/Cmd + E` | 打开导出对话框 |
| `Esc` | 离开绘制工作室 / 关闭对话框 |
| 滚轮 | 缩放节点图 · Alt/中键拖动平移 |

---

## 验证与测试

项目包含三层独立验证。

### 1. 应用内自检（GPU 管线）

打开 `http://127.0.0.1:3000/?selftest=1&export=1`（可加 `&demo=mossy-rock&res=512`）。页面会：

- 直接针对 WebGL 上下文编译**每个节点的 GLSL**（报告在 `window.__SELFTEST__.shaders`），
- 求值节点图，检查 GL 错误与缩略图生成，
- 读回每个通道并验证颜色方差、法线单位长度与朝外方向（法线按渲染分辨率采样，避免高频但合法的法线因降采样而“失单位”；过度陡峭的法线会给出警告而不是判定失败），
- 用内部相邻步进的 99 百分位衡量环绕边缘不连续度（对平滑渐变和棋盘格等高频率图案都稳健），验证无缝平铺，
- 可选烘焙并导出完整贴图包。

结果显示在页面，并 POST 到 `/api/debug/last?kind=selftest`。

也可以通过页面注册在 `document.modelContext` 上的 **WebMCP** 工具运行：

| 工具 | 作用 |
| --- | --- |
| `substrate_state` | 材质、节点/连接数、接线、求值统计、撤销状态。 |
| `substrate_selftest` | 着色器审计 + 求值 + 通道/法线/接缝校验。 |
| `substrate_export` | 烘焙 + 导出贴图包；返回文件、大小、PNG 签名、服务端路径。 |
| `substrate_load_demo` | 切换内置示例。 |
| `substrate_paint` | 程序化添加笔触并重新求值（绘制管线测试）。 |

### URL 参数

| 参数 | 作用 |
| --- | --- |
| `?lang=zh` / `?lang=en` | 设置界面语言；选择保存在 `localStorage` 并保留在 URL 中。 |
| `?demo=<id>` | 加载示例：`weathered-steel`、`mossy-rock`、`painted-sign`、`blank`。 |
| `?fresh=1` | 跳过会话恢复，加载默认示例。 |
| `?selftest=1[&export=1][&res=512]` | 加载时执行自动自检（并导出）。 |
| `?redact=1` | 隐藏状态栏中的 GPU/驱动指纹（文档截图使用）。 |
| `?audit=1[&auditsection=render]` | 加载时运行完整自检套件（全部或单节）。 |
| `?mcp=off` | 为此标签页禁用 MCP 桥接（外部工具调用会返回 `APP_NOT_CONNECTED`）。 |

### 2. 独立贴图包验证器（Node）

```bash
npm run verify                       # exports/ 中最新的贴图包
node scripts/verify-export.mjs exports/<package>
```

它用 `node:zlib` 重新实现 PNG 解码（chunk CRC、inflate、扫描线反滤波），检查：分辨率、逐通道位深与颜色类型、sRGB chunk 存在规则、`Software` tEXt 元数据、环绕边缘接缝比、manifest 结构、README 段落，以及每个 zip 条目与磁盘文件的一致性。

审计修复后的最近一次运行：**4/4 示例包通过**（所有 PNG CRC 合法、色彩空间正确、百分位接缝比远低于 1.0、zip 条目干净）。

### 3. 完整应用审计（2,227 项 + 143 项可选 UI）

`src/engine/audit.js` 是浏览器端测试框架，覆盖整个产品而不只是导出：

| 分节 | 检查 |
| --- | --- |
| **schema** | 每个节点定义、参数 schema（范围、默认值、步进、下拉索引、渐变停靠点）、着色器 uniform/输入一致性、全部 37 个片元程序编译 |
| **render** | 每个节点默认设置渲染、**每个下拉选项**、**每个数值参数的 min 与 max**、颜色极值、8 停靠点渐变：输出有限、范围合理、预期变化、无缝平铺、单位法线 |
| **values** | 对照黄金值的数值语义——sRGB→线性转换、反相、阈值、levels/gamma、色调分离、灰度权重、HSL 色相旋转、全部混合算子（copy/add/multiply/screen/subtract/lighten/darken + 不透明度 + 遮罩）、法线/AO/曲率/边缘常量、模糊恒等、扭曲/变换恒等、通道选取、渐变重复/偏移、渐变映射反转、空绘制层恒等 |
| **actions** | 添加所有节点类型、删除/复制/撤销/重做、环路拒绝、输出唯一性、参数合并、移动/重命名、分辨率与代理切换、加载全部示例、项目保存/加载/删除（含非 ASCII 名称）、图像输入往返、绘制笔触/撤销/清空、全部五种导出预设、DirectX 法线翻转、16-bit 高度与 alpha 方案 |
| **dom** | 真实 UI 交互：节点库搜索（EN+ZH）、添加、图右键菜单、节点右键菜单、节点拖动 + 撤销、框选、Delete/Undo/Redo 键、帮助/项目/导出对话框、示例下拉、贴图缩放、预览形状与滑块、绘制工作室绘制 + 撤销、语言切换、新建按钮、控制台错误监听。包含实时预览回归测试：切换示例和编辑参数后 3D 材质与 2D 贴图面板必须刷新 |
| **i18n** | EN/ZH key 一致性、节点/参数/选项字典覆盖、运行时语言切换、原始 key/缺失 key 扫描 |
| **ui** *(可选)* | 143 项工具栏/右面板/绘制/AI 深度检查：项目名编辑、新建、全部四个示例切换、保存/打开往返、撤销/重做按钮、分辨率与代理下拉、帮助对话框、语言切换、导出默认值/高度开关/真实导出；预览形状、平铺与置换滑块、暂停/重置、badge、8 个贴图卡片 + 法线约定说明 + 缩放、属性控件（滑块↔数字、布尔、渐变增删停靠点）、绘制工作室开关、笔刷库（两组 16 个预设含自然图案、缩略图唯一性、逐笔刷渲染覆盖、笔触记录预设、笔刷持久化、橡皮擦、flow/spacing 滑块）、三次平滑、两点直线性、笔锋两端收缩（几何 + 绘制覆盖 + UI 开关）、绘制性能守卫与实况缩略图；**AI 面板**（模型列表、模型切换、DOM/API 中无 Key 材料、MCP 自检、**对话持久化**、**关闭面板后回复继续**、**半透明浮动窗 + 自动滚动 + 展开**、**AI 规则**、**对话导出**）、**素材库**（导入、列表、图案填充、联网搜索 UI）和**自定义笔刷 JSON 导入** |

可从应用内帮助对话框（**运行自检**）、URL 或命令行运行：

```bash
node scripts/cdp.mjs audit all        # 或：npm run audit   （2,227 项，约 40 秒）
npm run audit:ui                      # 工具栏/右面板/绘制/AI 深度检查（143 项）
npm run audit:quick                   # 仅 schema
```

它输出逐节 PASS/FAIL 汇总，失败时返回非零退出码。最近一次运行：**2,227 项，0 失败**（schema 1,278 · render 628 · values 46 · actions 198 · dom 56 · i18n 21），外加 143 项可选 UI 检查和 30 项 MCP 自检。也可通过 `?audit=1`（全部）、`?audit=1&auditsection=render` 或 `?audit=1&auditsection=ui` 运行，报告可在 `window.__AUDIT__` 获取并 POST 到 `/api/debug/report` 供 CI 使用。

### 4. MCP 契约测试

```bash
npm run test:mcp
```

外部接口端到端验证（69 通过 / 2 跳过）：网关可用性/目录、stdio JSON-RPC 逻辑（initialize / tools/list / tools/call / ping）、图读取与修改、求值、缩略图、2D/3D 预览截图、绘制、项目保存/加载/删除、导出 + zip、标准化错误信封、HTTP JSON-RPC（`/mcp`）、简易 JSON 端点、`/api/mcp/selfcheck`、LLM 模型/提供商端点（Key 泄漏断言、提供商校验/脱敏）、**AI 规则**、素材库 CRUD 和**在线搜索/导入 SSRF 防护**。它输出 PASS/FAIL 汇总，清理测试项目/导出/素材并恢复示例材质。（stdio 行分帧通过把 `initialize` 请求管道给 `node mcp/server.mjs` 验证；在禁止子进程的沙箱中自动测试会跳过该项。）

专用 MCP 自检也可作为审计分节：

```bash
npm run audit:mcp        # 30 项，含实时网关往返
```

### 5. 浏览器自动化辅助

`scripts/cdp.mjs` 通过 Node 原生 WebSocket 连接 Chrome DevTools Protocol——适合在运行中的应用里求值表达式、截图和收集控制台日志：

```bash
node scripts/cdp.mjs list
node scripts/cdp.mjs eval "window.__SUBSTRATE__.state.lastEvalMs"
node scripts/cdp.mjs shot docs/screenshots/01-graph-3d.png
node scripts/cdp.mjs logs 3000
```

### 6. 文档一致性

```bash
npm run test:docs
```

检查每篇英文文档都有配对的中文翻译、双方都带 `English · 简体中文` 切换链接、所有文档相对链接和截图引用可解析、中文文档确实包含译文且章节结构匹配，以及中文文档索引链接了全部文档。

---

## 性能说明

在 Chrome + NVIDIA 笔记本 GPU（ANGLE/D3D11 后端）与 WebGL2、RGBA16F 目标下实测：

| 场景 | 结果 |
| --- | --- |
| 24 节点风化彩绘钢板图 @1024²（23 pass） | 完整求值约 120–200ms，缓存热时约 5–30ms |
| 拖动滑块（代理 100%） | 仅下游节点重算（结构哈希缓存） |
| 绘制 @1024²，90 点粉笔笔触 | **约 80fps**，中位帧 16.7ms，p95 19.2ms，无长任务；绘制中图 pass 约 47ms（半分辨率、无缩略图） |
| 绘制，200 点平滑笔触重栅格 | 使用缓存印章 sprite 后 3–6ms（此前 15–18ms） |
| 绘制 @1024²，绘制中引擎更新 | 节流到约 9Hz、半分辨率；笔触结束时刷新缩略图与 3D/2D 预览 |
| 2K 导出（4 张贴图 + zip） | 含 PNG 编码与打包约 5.5 秒 |
| 着色器审计（37 个片元程序） | < 150ms |

绘制经过优化，画布不会阻塞 GPU：
- 笔刷印章预渲染到 sprite canvas（3 种颗粒变体）后 blit，而不是每个笔点重建渐变和数百个颗粒圆；
- 笔刷光标通过直接 DOM 写入移动（不会每次 pointermove 触发 Vue 重渲染）；
- 实时笔触最多每帧在纹理快照上重栅格化一次；
- 绘制中图求值使用半分辨率、跳过节点缩略图/预览重建并节流；松开笔刷触发全质量求值与预览刷新。

文档分辨率上限 4096²；4K 导出约需 1–2GB GPU 内存用于流式烘焙。

---

## 项目结构

```
index.html                  import map + 启动
package.json                依赖（vue、three）与脚本
server/index.js             零依赖 Node 服务端（静态、API、zip 写入）
server/llm.mjs              服务端 LLM 代理 + 工具调用 Agent 循环
server/assets.mjs           素材库存储/搜索/导入/校验
scripts/build.mjs           把应用与 vendor ESM 复制到 dist/
scripts/verify-export.mjs   独立贴图包验证器
scripts/cdp.mjs             Chrome DevTools Protocol 辅助（求值/截图/日志）
scripts/mcp-test.mjs        端到端 MCP 契约测试
scripts/check-docs.mjs      中英文文档一致性 + 链接检查
mcp/server.mjs              stdio MCP 服务器（把 JSON-RPC 转为 HTTP 网关）
mcp/config.claude.json      Claude Desktop/Code 配置示例
mcp/config.codex.toml       Codex 配置示例
docs/mcp.md                 MCP 集成参考
docs/llm.md                 AI 助手 / 提供商配置与 Key 安全
docs/asset-search.md        联网素材提供商、署名与 SSRF 策略
docs/brushes.md             自定义笔刷 JSON 格式
docs/zh/                    上述文档的中文版本 + 中文索引
src/main.js                 启动：挂载应用、创建引擎、恢复会话、自检钩子
src/App.js                  布局、工具栏、对话框、快捷键、预览调度
src/styles.css              深色工作室主题
src/styles-ai.css           AI 面板 / 浮动窗 / 素材库 / 搜索样式
src/i18n/                   双语 UI：messages.js（UI 文案）、text.zh.js（节点/参数/选项字典）、
                            index.js（locale 状态、t()/tr() 辅助、本地化节点定义）
src/components/             GraphEditor、Inspector、NodePalette、Preview3D、MapPanel、
                            PaintStudio、ExportDialog、GradientEditor、AiPanel、AiFloating、AssetLibrary
src/engine/engine.js        WebGL2 图求值器、缓存、读回、缩略图
src/engine/compiler.js      节点定义 → GLSL
src/engine/glsl.js          共享 GLSL 辅助（可平铺噪声、颜色、预览着色）
src/engine/nodes/           生成器、滤镜、输出节点定义
src/engine/store.js         响应式模型、历史、绘制同步、求值调度
src/engine/demos.js         三个手工示例图 + 绘制笔触
src/engine/png.js           PNG 编码器（自适应滤波、8/16-bit）
src/engine/exporter.js      预设、通道打包、manifest/README
src/engine/selftest.js      自动管线验证
src/engine/paint.js         笔触栅格化：Catmull-Rom → 三次 Bézier 平滑、笔刷印章、笔锋
src/engine/brushes.js       16 个内置笔刷预设（基础 + 自然图案）+ 预览缩略图
src/engine/webmcp.js        WebMCP 工具注册
src/engine/mcp-catalog.js   共享 MCP 工具目录 + schema 校验
src/engine/mcp-commands.js  外部工具的浏览器 handler
src/engine/mcp-bridge.js    页面与 MCP 网关之间的 SSE 桥接
src/engine/mcp-selfcheck.js 浏览器 + 网关 MCP 自检
src/engine/llm-client.js    模型代理的浏览器客户端（不接触 Key）
src/engine/ai-chat.js       持久化 AI 对话 store（面板关闭/刷新后仍存活）
src/components/AiPanel.js   AI 助手面板
src/components/AiFloating.js 半透明浮动对话窗口
src/components/AssetLibrary.js 素材库 + 联网搜索对话框
src/engine/audit.js         浏览器端完整审计：节点、数值、动作、DOM、i18n
src/engine/ui-check.js      工具栏 / 右面板 / 绘制 / AI 深度检查
exports/                    生成的贴图包（git 忽略；由导出产生）
docs/screenshots/           文档图片
```

---

## 限制与后续方向

- **AI 助手需要配置 Key**（本地 `llm.config.local.json` 或 `DEEPSEEK_API_KEY`），只保存在服务端。模型提供商必须兼容 OpenAI；不支持工具调用的模型可以聊天但不能操作应用。
- **素材库引用是 URL。** 图案填充引用 `/assets/<file>`；删除素材会导致这些填充失效（图像节点嵌入图片，不受影响）。
- **MCP 调用需要打开工作室标签页。** 网关把工具调用转发给 WebGL 应用；没有连接标签页会返回 `APP_NOT_CONNECTED`。用 `npm start` 启动并保持页面打开（可选用 `MCP_TOKEN` 认证）。
- **导出文件名是 ASCII。** 材质名会为可移植文件名做清理（丢弃非 ASCII 字符），因此中文材质名会导出为 `Material_BaseColor.png`；界面标签本身仍是本地化的。
- **需要 WebGL2 + 浮点渲染目标。** 没有 `EXT_color_buffer_float` 时引擎回退到 8-bit 目标（状态栏有警告），16-bit 高度导出会从 8-bit 上采样。
- **暂无节点组/函数节点**——大型节点图保持扁平。子图节点是自然的下一步。
- **绘制是 2D 笔触式的**，不是完整图层栈；可以串联多个绘制层节点实现多层。
- **图像输入会加载进节点图**，但不以文件路径保存到项目中（会以内嵌 data URL 写入保存的 JSON，让项目自包含，代价是体积）。
- **自定义着色器节点**（用户 GLSL）实现起来很直接：编译器只需要 `nodeColor` 主体和参数 schema。
- 导出已做到色彩空间正确，但尚未针对引擎导入器做端到端验证；manifest 的设计使一个小型导入脚本（Unity/Unreal/three）可以直接消费。

---

## 许可证

MIT——可自由使用、修改和发布。
