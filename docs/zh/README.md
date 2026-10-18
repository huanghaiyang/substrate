# Substrate 文档（简体中文）

[English](../../README.md) · **简体中文** · [中文 README](../../README.zh-CN.md)

这是 Substrate 程序化贴图工作室的中文文档索引。界面本身支持中英双语（顶栏 `EN / 中文` 或 `?lang=zh` / `?lang=en`）。

## 文档列表

| 文档 | 内容 |
| --- | --- |
| [README.zh-CN.md](../../README.zh-CN.md) | 完整中文项目说明：功能、使用、架构、行业标准、导出、性能、测试与限制 |
| [mcp.md](mcp.md) | MCP 集成：传输方式、标准化契约、32 个工具、认证、Agent 配置示例 |
| [llm.md](llm.md) | AI 助手：架构、Key 安全、对话持久化/浮动窗、AI 规则、模型切换、接口与测试 |
| [asset-search.md](asset-search.md) | 联网素材搜索：提供商与 Key、声明式兜底、署名要求、SSRF 安全与 UI |
| [brushes.md](brushes.md) | 自定义笔刷 JSON 导入格式与全部字段说明 |

英文文档：

- [README.md](../../README.md)
- [docs/mcp.md](../mcp.md) · [docs/llm.md](../llm.md) · [docs/asset-search.md](../asset-search.md) · [docs/brushes.md](../brushes.md)

## 快速开始

```bash
npm install
npm start          # http://127.0.0.1:3000
```

打开页面后在顶栏切换 **中文**，或直接访问 `http://127.0.0.1:3000/?lang=zh`。语言选择会被记住。

## 常用功能入口

| 功能 | 位置 |
| --- | --- |
| 节点图 / 属性 / 3D 预览 / 2D 贴图 | 主界面三栏与右侧面板 |
| 绘制工作室 | 双击/选中 Paint Layer → 打开绘制工作室 |
| AI 助手 | 顶栏 **✦**；关闭面板时进行中的对话会显示在右下角浮动窗 |
| 素材库与联网搜索 | 顶栏 **▦** |
| 导出贴图包 | 顶栏 **导出材质** |
| MCP 自检 | AI 面板 **◎** 或帮助对话框 → MCP 自检；`GET /api/mcp/selfcheck` |
| 完整自检 | 帮助 **?** → 运行自检；或 `?audit=1` |

## 文档维护约定

- 中英文文档成对维护：英文文件位于 `docs/*.md`，中文对应文件位于 `docs/zh/*.md`。
- 每篇文档顶部提供 `English · 简体中文` 切换链接。
- 修改功能后请同步更新两种语言版本，并运行 `npm run test:docs` 检查文档链接、图片引用和中英文文件配对。
