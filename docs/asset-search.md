# Online material search

**English** · [简体中文](zh/asset-search.md)

The AI assistant and the material library can search the web for reference textures, then import a
result into the local material library (with attribution). The same capability is exposed to
external MCP clients:

| Tool | Purpose |
| --- | --- |
| `substrate_search_open_assets` | search open-license image sources; returns title, creator, license, source and thumbnail/download URLs |
| `substrate_import_asset_url` | download one image URL into `assets/` (PNG/JPEG/WebP, ≤ 32 MB, public http(s) only), storing attribution |

## Providers

Semantic search uses the first reachable provider, in this order:

| Provider | Key | Notes |
| --- | --- | --- |
| **Pexels** | `PEXELS_API_KEY` | best results for textures/reference photos |
| **Unsplash** | `UNSPLASH_ACCESS_KEY` | requires a demo/production access key |
| **Pixabay** | `PIXABAY_API_KEY` | free API key |
| **Openverse** | none | keyless CC search; may be blocked by corporate networks |
| **Wikimedia Commons** | none | keyless media search |

Keys can be set as environment variables or in `asset-search.local.json` (git-ignored via
`*.local.json`):

```json
{
  "pexels": "…",
  "unsplash": "…",
  "pixabay": "…"
}
```

If none of the semantic providers is reachable, the server falls back to **Lorem Picsum** (seeded
online stock photos). This keeps the feature functional on restricted networks, but the results are
**not semantically relevant**; the UI marks them as a fallback and the assistant must say so. Add one
of the API keys above for real texture search.

## Attribution

Every imported online asset stores `provider`, `creator`, `license`, `licenseUrl` and `sourceUrl`.
The material library shows the attribution line on the card; the assistant is instructed to report
creator/license when using a search result. Keep that information when publishing work.

## Security

- Only `http(s)` URLs are accepted; `localhost`, loopback and private network addresses are rejected
  (SSRF guard), and the final redirect target is re-checked.
- Content must be a PNG/JPEG/WebP image and at most 32 MB.
- Search/import runs on the local Node server; no key material reaches the browser.
- The AI rules forbid using any other network/scraping mechanism — online access happens only
  through these two tools.

## UI

Top bar **▦ Material library → search field**: enter a query, press **Search**, then **Import** a
result. Imported assets can immediately be used as graph textures or paint-layer patterns.
