# AI 助手（LLM）——配置与安全

[English](../llm.md) · **简体中文**

工作室内置顶栏 AI 助手入口（**✦**）。它可以通过与外部 Agent 相同的 **29 个 MCP 工具**检查/修改节点图、绘制笔触、执行求值、截取预览和导出贴图包。默认接入 DeepSeek，也可以在面板中增加并切换任意 OpenAI 兼容提供商/模型。

## 架构

```
浏览器 AiPanel ──POST /api/llm/chat──▶ Node 服务端（LLM 代理 + 工具循环）
                                             │  OpenAI 兼容 /chat/completions
                                             ▼
                                       提供商 API（默认 DeepSeek）
                                             │  tool_calls
                                             ▼
                                   MCP 网关 ──▶ 浏览器标签页（WebGL）
```

模型循环完全运行在**服务端**：服务端调用提供商，收到 `tool_calls` 后通过 MCP 网关转发给已连接的工作室标签页，把工具结果回传给模型，最后向面板返回 `{ reply, toolCalls, steps, usage }`。

## API Key 与敏感数据

- Key **只**保存在 Node 服务端的 `llm.config.local.json`（已被 git 忽略）或 `DEEPSEEK_API_KEY` 环境变量中，浏览器永远拿不到 Key 内容。
- `GET /api/llm/models` 只返回模型/提供商元数据和 `hasKey` 布尔值——不返回 Key，连掩码片段都没有。
- 面板从不显示 Key：提供商编辑器只在你主动输入时发送新 Key；LLM 代理的所有响应/错误都会脱敏（`sk-…` → `***`）。
- 服务端不会把聊天内容或 Key 写入日志。
- 本仓库的本地 Key 存放在 `llm.config.local.json`；不要提交该文件（`.gitignore` 已覆盖 `*.local.json`、`.env`、`secrets/`）。

## 默认配置

`llm.config.local.json`（仅本地）：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "<your key>",
      "models": [
        { "id": "deepseek-chat", "label": "DeepSeek Chat" },
        { "id": "deepseek-reasoner", "label": "DeepSeek Reasoner" }
      ]
    }
  ]
}
```

环境变量覆盖（共享机器推荐）：

```bash
DEEPSEEK_API_KEY=sk-... npm start
```

## 对话保存、浮动窗口与 AI 规则

- **完整历史会保存**在浏览器中（`substrate.aiChat.v1`）：每条用户/助手消息、工具调用轨迹、错误和时间戳，刷新后自动恢复。顶栏 **⤓** 导出完整 Markdown 记录；**⌫** 清空。
- **关闭对话框不会中断回复**。请求与对话状态位于独立 store（`src/engine/ai-chat.js`），不属于面板组件。回复进行中关闭面板时，右下角会显示**半透明浮动窗口**，实时展示对话、自动滚动到最新消息，并可点击 **⤢** 展开回完整面板。
- **AI 规则**由服务端系统提示词强制执行，并通过 `GET /api/llm/rules` 只读暴露（⚙ 设置中也会列出）：助手只能通过工具操作本工作室；禁止读取/修改应用源码、仓库文件、环境变量、API Key、日志或系统路径，遇到刺探密钥/主机/网络等请求必须拒绝。
- 助手可**联网搜索素材**（`substrate_search_open_assets`）并带署名导入（`substrate_import_asset_url`）；详见 [asset-search.md](asset-search.md)。
- **长时间搭图有步数上限且会给出汇总**：面板默认最多 20 个助手/工具步骤（服务端上限 32）。若在搭图过程中耗尽步数预算，服务端会最后发起一次禁用工具的请求，生成简明的进度汇总并返回 `hitStepLimit: true`，而不是直接报“已达最大工具步数”错误。面板/浮动窗会显示提示，该标记随对话持久化，继续对话即可接着完成。
- **工具调用配对有保证**：一轮多工具调用（最多 12 个并行）会在下一次请求前为每个 `tool_call_id` 写入一条 `tool` 回复；不完整/损坏的工具记录会被 `sanitizeToolSequence` 自动修复，避免提供商返回 *“assistant message with tool_calls must be followed by tool messages”*。如果模型完全不支持工具调用，服务端会从干净的消息列表降级为普通对话重试一次。

## 切换模型 / 添加提供商

- 面板的模型下拉列出所有已配置的 `provider:model`，选择结果保存在 `localStorage`（`substrate.llmModel`）。
- **⚙ 设置** → 添加 OpenAI 兼容提供商：显示名称、Base URL、逗号分隔的模型 ID 和 API Key。Key 只写入服务端，接口只返回 `hasKey`。
- **测试连通性**会发送一条最小聊天请求，验证 URL/Key/模型。
- 可在同一列表中删除提供商。

## 接口

| 接口 | 方法 | 作用 |
| --- | --- | --- |
| `/api/llm/models` | GET | 模型/提供商列表，含 `hasKey` 标记 |
| `/api/llm/providers` | POST | 添加或更新提供商（`apiKey` 可选） |
| `/api/llm/providers/delete` | POST | 按 id 删除提供商 |
| `/api/llm/chat` | POST | 运行助手工具循环：`{ modelKey, messages, maxSteps? }` |
| `/api/llm/test` | POST | 测试某个模型的连通性 |
| `/api/llm/rules` | GET | 当前生效的 AI 规则（只读） |

响应使用与 MCP 网关一致的信封格式：`{ ok, reply, model, steps, toolCalls, usage }` 或 `{ ok:false, error:{ code, message } }`。若模型不支持工具调用（部分 reasoner），服务端会降级为普通对话并返回 `toolsDisabled: true`；助手仍能回答，但不能操作应用。

## 自动化检查

- `npm run test:mcp` 包含 LLM 网关检查：模型列表、Key 泄漏断言、聊天参数校验、提供商校验/脱敏（非破坏性）、AI 规则、联网搜索/导入防护，以及可选的在线聊天（`SUBSTRATE_TEST_LLM=1`）。
- 可选的 UI 深度自检会检查对话持久化、浮动记录、规则和搜索 UI。
- MCP 自检（`npm run audit:mcp` 或 ✦ → ◎）端到端验证工具循环链路。
