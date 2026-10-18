# MCP 集成——外部 Agent 接口

[English](../mcp.md) · **简体中文**

Substrate 通过**标准化工具目录**向 MCP 客户端（Claude Desktop/Code、Codex、Cursor、自定义 Agent）开放创作管线。真正繁重的工作（WebGL 节点求值、绘制、导出烘焙）仍发生在浏览器应用中；本地小网关负责把工具调用转发给已打开的标签页。

```
MCP client (Claude/Codex/…)
        │  stdio JSON-RPC
        ▼
mcp/server.mjs ──HTTP──▶ server/index.js ──SSE──▶ browser tab (WebGL app)
        │                     │                        │
        └── POST /api/mcp/call┘                        └── POST /api/mcp/result
```

同一网关还提供 **HTTP JSON-RPC**（`POST /mcp`，适合支持 URL 传输的客户端），以及简易 JSON 端点 `POST /api/mcp/call`。

> 工作室必须正在运行（`npm start`），并且有浏览器标签页打开应用，因为材质图是在该页面的 GPU 上求值的。

## 随应用启动

MCP 网关是普通工作室服务端的一部分：`npm start` 会在同一端口暴露 `/mcp`、`/api/mcp/*` 和 SSE 桥接。打开工作室后标签页自动连接（可用 `?mcp=off` 在单个标签页禁用）。

内置自检有三个入口：

```bash
curl -s http://127.0.0.1:3000/api/mcp/selfcheck   # 目录 + 校验 + 桥接往返（JSON 报告）
npm run audit:mcp                                # 在审计 runner 中执行同样的检查
```

UI 中对应 AI 面板的 **◎** 按钮和帮助对话框的 **MCP 自检** 按钮。检查内容：目录结构/版本/名称唯一性、浏览器 handler 与目录一致性、参数校验、错误码、桥接连接、实时 `substrate_get_state` 往返以及标准化结果信封。

## 快速开始

```bash
npm install        # 首次
npm start          # 工作室运行在 http://127.0.0.1:3000——保持标签页打开
npm run mcp        # 可选：直接运行 stdio MCP 服务器（手动测试用）
npm run test:mcp   # 端到端 MCP 契约测试（需要标签页打开）
```

### Claude Desktop / Claude Code

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

### Codex

```toml
[mcp_servers.substrate]
command = "node"
args = ["/absolute/path/to/texture-designer/mcp/server.mjs"]
env = { SUBSTRATE_URL = "http://127.0.0.1:3000" }
```

示例文件已包含在 [`mcp/config.claude.json`](../../mcp/config.claude.json) 和 [`mcp/config.codex.toml`](../../mcp/config.codex.toml) 中——请修改路径。

### 仅 HTTP 客户端

```bash
# 发现工具
curl -s http://127.0.0.1:3000/api/mcp/tools | jq '.apiVersion, (.tools|length)'

# JSON-RPC 2.0（Streamable HTTP 风格，请求/响应 JSON）
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"substrate_get_state","arguments":{}}}'

# 简易 JSON 传输
curl -s http://127.0.0.1:3000/api/mcp/call \
  -H 'content-type: application/json' \
  -d '{"name":"substrate_load_demo","arguments":{"id":"mossy-rock"}}'
```

## 标准化契约

| 规则 | 值 |
| --- | --- |
| API 版本 | `1.0.0`（每个响应都带 `apiVersion`；minor 版本内只做增量工具） |
| MCP 协议版本 | `2025-03-26`（回显客户端请求的版本） |
| 工具命名 | `substrate_<verb>_<noun>` snake_case，保持稳定 |
| 输入校验 | 网关与浏览器都使用 JSON-Schema 子集；未知/非法参数在执行前拒绝 |
| 注解 | 每个工具都有 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` |
| 超时 | 每个工具有提示值（读工具 15s … 导出/审计 300s）；超时返回 `TIMEOUT` |
| 成功信封 | `{ ok: true, apiVersion, tool, data, meta: { durationMs, clientId } }` |
| 错误信封 | `{ ok: false, apiVersion, tool, error: { code, message, details? } }` |
| MCP 工具结果 | `content[0].text` = JSON 信封，`structuredContent` = `data`，失败时 `isError` |

错误码：`APP_NOT_CONNECTED`、`INVALID_ARGUMENT`、`NOT_FOUND`、`EVAL_FAILED`、`EXPORT_FAILED`、`TIMEOUT`、`UNAUTHORIZED`、`INTERNAL`、`UNKNOWN_TOOL`。

## 调用规范

工具目录自带可直接复制的 `examples`（`GET /api/mcp/tools` 会返回，也包含在 AI 工具描述中）。参数错误返回
`INVALID_ARGUMENT`，`details` 中包含示例和输入 schema；节点不存在返回 `NOT_FOUND`，`details.availableNodes`
给出当前节点 id 与类型。

```jsonc
// paint_stroke：归一化画布坐标（不是像素）
{ "nodeId": "paint-xxxxx", "points": [{"x":0.25,"y":0.5},{"x":0.75,"y":0.5}],
  "brushId": "soft-round", "color": "#ffffff", "size": 32, "opacity": 1 }

// get_thumbnail：nodeId 可省略（默认输出节点）；id 从 get_graph 获取
{ "nodeId": "material_output-xxxxx" }

// 自动整理：无需参数，一键整理整个节点图（可撤销）
{}

// connect：toPort 是目标输入端口名
{ "fromNode": "perlin-xxxxx", "fromPort": "out", "toNode": "material_output-xxxxx", "toPort": "height" }
```

## 工具（32 个）

| 工具 | 类型 | 作用 |
| --- | --- | --- |
| `substrate_get_state` | read | 材质、分辨率/代理、节点/连接数、输出接线、求值统计、历史、选择 |
| `substrate_get_graph` | read | 完整图 JSON（节点/参数、连接、输出 id） |
| `substrate_list_demos` | read | 内置示例材质 |
| `substrate_list_projects` | read | 本地服务端保存的项目 |
| `substrate_get_thumbnail` | read | 节点的 96px PNG data URL（默认输出节点） |
| `substrate_search_open_assets` | read | 搜索开放授权在线素材（作者/许可证/来源链接） |
| `substrate_import_asset_url` | write | 下载在线图片到素材库并保存署名 |
| `substrate_list_assets` | read | 列出素材库图片（id、名称、URL、尺寸、署名） |
| `substrate_apply_asset` | write | 把素材库图片用作纹理输入或绘制层图案 |
| `substrate_get_preview` | read | 单个 2D 通道或 3D 材质球的 PNG data URL |
| `substrate_evaluate` | read/write | 强制求值并返回耗时/pass/缓存统计 |
| `substrate_run_selftest` | read | GPU 管线自检（着色器、通道、法线、接缝） |
| `substrate_run_audit` | read | 应用审计（schema/render/values/actions/dom/i18n/ui） |
| `substrate_load_demo` | write | 加载示例图 |
| `substrate_new_project` | write | 空材质图 |
| `substrate_add_node` | write | 按类型添加节点，返回节点 id |
| `substrate_delete_node` | destructive | 删除节点及其连线 |
| `substrate_duplicate_node` | write | 复制节点 |
| `substrate_move_node` | write | 设置节点位置 |
| `substrate_auto_layout` | write | 一键分层整理节点图（减少交叉、按真实节点高度排布、可撤销） |
| `substrate_connect` | write | 连接输出 → 输入端口 |
| `substrate_disconnect` | destructive | 按 id 删除连线 |
| `substrate_set_param` | write | 设置任意节点参数（数值、颜色、向量、渐变） |
| `substrate_set_resolution` | write | 文档分辨率和/或代理系数 |
| `substrate_set_locale` | write | 切换 UI 语言（不改变保存的偏好） |
| `substrate_history` | write | 撤销 / 重做 |
| `substrate_paint_stroke` | write | 提交一笔笔触（10 个基础 + 6 个自然笔刷、笔锋、对称、擦除） |
| `substrate_clear_paint` | destructive | 清空绘制层的全部笔触 |
| `substrate_export` | write | 烘焙 + 导出符合行业标准的贴图包（PNG 贴图、manifest、README、zip） |
| `substrate_save_project` | write | 保存图到项目文件 |
| `substrate_load_project` | write | 加载已保存项目 |
| `substrate_delete_project` | destructive | 删除已保存项目 |

## 认证

默认网关仅本地可访问且无认证。在服务端设置 `MCP_TOKEN` 可要求 MCP 端点携带令牌：

```bash
MCP_TOKEN=secret-token npm start
```

外部客户端发送 `Authorization: Bearer secret-token`（或 `X-MCP-Token`）。由于浏览器 `EventSource` 不能发送请求头，可在应用标签页执行 `localStorage.setItem('substrate.mcpToken', 'secret-token')`，桥接会给事件流追加 `?token=`。

## 自动化测试

`npm run test:mcp` 覆盖：网关可用性/目录、stdio 传输逻辑（initialize、tools/list、tools/call、ping）、图读取/修改、求值、缩略图、在线素材搜索/导入、2D/3D 预览截图、绘制、项目保存/加载/删除、导出 + zip、标准化错误信封、HTTP JSON-RPC（`/mcp`）、简易 JSON 端点、AI 规则和素材库 API。输出 PASS/FAIL 摘要并恢复示例材质。

扩展测试还覆盖 MCP 自检端点、LLM 模型/提供商 API（Key 泄漏断言、提供商校验/脱敏）、AI 规则、素材库 API 与在线搜索/导入 SSRF 防护。stdio 分帧本身是换行分隔 JSON-RPC：把 `initialize` 请求通过管道传给 `node mcp/server.mjs` 可返回服务器信息行（在允许子进程的 CI 环境中验证）。

## 限制

- 每个浏览器标签页同一时间执行一个工具；多个标签页会轮询使用（优先最新连接的标签页）。
- 工具执行要求 WebGL 应用标签页打开且处于唤醒状态（后台标签页的定时器节流可能拖慢长操作；审计时工作室会通过 `scripts/cdp.mjs` 主动聚焦）。
- `substrate_export` 会把贴图包写入服务端 `exports/` 目录；高分辨率需要浏览器机器的 GPU 内存。
- 接口是本地优先的：把服务端绑定到 `127.0.0.1`，如果其他本地进程不应驱动工作室，请启用 `MCP_TOKEN`。
