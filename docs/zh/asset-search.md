# 联网素材搜索

[English](../asset-search.md) · **简体中文**

AI 助手与素材库都可以联网搜索参考贴图，并把结果导入本地素材库（保留署名信息）。同样能力也通过 MCP 工具暴露给外部客户端：

| 工具 | 作用 |
| --- | --- |
| `substrate_search_open_assets` | 搜索开放授权图库；返回标题、作者、许可证、来源以及缩略图/下载链接 |
| `substrate_import_asset_url` | 下载单个图片 URL 到 `assets/`（仅 PNG/JPEG/WebP、≤32MB、公网 http(s)），并保存署名 |

## 搜索源

语义搜索按以下顺序使用第一个可访问的提供商：

| 提供商 | Key | 说明 |
| --- | --- | --- |
| **Pexels** | `PEXELS_API_KEY` | 贴图/参考照片效果最好 |
| **Unsplash** | `UNSPLASH_ACCESS_KEY` | 需要 demo 或 production access key |
| **Pixabay** | `PIXABAY_API_KEY` | 免费 API Key |
| **Openverse** | 无 | 无需 Key 的 CC 搜索；部分企业网络可能无法访问 |
| **Wikimedia Commons** | 无 | 无需 Key 的媒体搜索 |

Key 可用环境变量设置，或写入 `asset-search.local.json`（已被 `*.local.json` 规则 git 忽略）：

```json
{
  "pexels": "…",
  "unsplash": "…",
  "pixabay": "…"
}
```

若所有语义搜索源都不可达，服务端会回退到 **Lorem Picsum**（按种子返回在线图库照片）。这能保证受限网络下功能仍可用，但结果**与查询语义无关**；UI 会标记为兜底来源，助手也必须如实说明。需要真实贴图搜索时，请配置上面的任意 API Key。

## 署名

每个导入的在线素材都会保存 `provider`、`creator`、`license`、`licenseUrl`、`sourceUrl`。素材库卡片会显示署名行；助手也被要求在引用搜索结果时报告作者与许可证。公开发布作品时请保留这些信息。

## 安全

- 仅接受 `http(s)` URL；`localhost`、回环地址和私有网段会被拒绝（SSRF 防护），重定向后的最终地址也会再次校验。
- 内容必须是 PNG/JPEG/WebP，且不超过 32MB。
- 搜索/导入在本地 Node 服务端执行；浏览器拿不到任何 Key 内容。
- AI 规则禁止使用其他网络/爬虫手段——联网访问只能通过这两个工具。

## 界面

顶栏 **▦ 素材库 → 搜索框**：输入关键词，点击**搜索**，再点击结果上的**导入**。导入后即可作为节点贴图或绘制层图案使用。
