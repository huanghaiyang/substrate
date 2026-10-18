# MCP integration — external agent interface

**English** · [简体中文](zh/mcp.md)

Substrate exposes its authoring pipeline to MCP clients (Claude Desktop/Code, Codex, Cursor, custom
agents) through a **normalized tool catalog**. The heavy lifting (WebGL graph evaluation, painting,
export baking) still happens in the browser app; a small local gateway relays tool calls to the
open tab.

```
MCP client (Claude/Codex/…)
        │  stdio JSON-RPC
        ▼
mcp/server.mjs ──HTTP──▶ server/index.js ──SSE──▶ browser tab (WebGL app)
        │                     │                        │
        └── POST /api/mcp/call┘                        └── POST /api/mcp/result
```

The same gateway also speaks **HTTP JSON-RPC** at `POST /mcp` for clients that support a URL
transport, and a plain JSON convenience endpoint at `POST /api/mcp/call`.

> The studio must be running (`npm start`) and a browser tab showing the app must be open, because
> the material graph is evaluated on the GPU in that page.

## Starts with the app

The MCP gateway is part of the normal studio server: `npm start` exposes `/mcp`, `/api/mcp/*` and the SSE
bridge on the same port. Opening the studio connects the tab automatically (disable per tab with `?mcp=off`).

A built-in self-check is available in three places:

```bash
curl -s http://127.0.0.1:3000/api/mcp/selfcheck   # catalog + validation + bridge round-trip (JSON report)
npm run audit:mcp                                # same checks inside the audit runner
```

In the UI it is the **◎** button in the AI panel and the **MCP self-check** button in the help dialog. The
check verifies: catalog shape/version/unique names, browser handlers ↔ catalog parity, argument validation,
error codes, bridge connection, a live `substrate_get_state` round-trip and the normalized result envelope.

## Quick start

```bash
npm install        # once
npm start          # studio at http://127.0.0.1:3000 — keep a tab open
npm run mcp        # optional: run the stdio MCP server directly (for a manual test)
npm run test:mcp   # end-to-end MCP contract test (needs the tab to be open)
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

Copies are included as [`mcp/config.claude.json`](../mcp/config.claude.json) and
[`mcp/config.codex.toml`](../mcp/config.codex.toml) — adjust the path.

### HTTP-only clients

```bash
# discover tools
curl -s http://127.0.0.1:3000/api/mcp/tools | jq '.apiVersion, (.tools|length)'

# JSON-RPC 2.0 (Streamable HTTP style, request/response JSON)
curl -s http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"substrate_get_state","arguments":{}}}'

# plain JSON convenience transport
curl -s http://127.0.0.1:3000/api/mcp/call \
  -H 'content-type: application/json' \
  -d '{"name":"substrate_load_demo","arguments":{"id":"mossy-rock"}}'
```

## Normalized contract

| Rule | Value |
| --- | --- |
| API version | `1.0.0` (`apiVersion` on every response; additive tools within a minor) |
| MCP protocol version | `2025-03-26` (client-requested version is echoed back) |
| Tool names | `substrate_<verb>_<noun>` snake_case, stable |
| Input validation | JSON-Schema subset on both gateway and browser; unknown/malformed arguments are rejected before execution |
| Annotations | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on every tool |
| Timeouts | per-tool hints (15 s read tools … 300 s export/audit); the gateway returns `TIMEOUT` |
| Success envelope | `{ ok: true, apiVersion, tool, data, meta: { durationMs, clientId } }` |
| Error envelope | `{ ok: false, apiVersion, tool, error: { code, message, details? } }` |
| MCP tool result | `content[0].text` = JSON envelope, `structuredContent` = `data`, `isError` for failures |

Error codes: `APP_NOT_CONNECTED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `EVAL_FAILED`, `EXPORT_FAILED`,
`TIMEOUT`, `UNAUTHORIZED`, `INTERNAL`, `UNKNOWN_TOOL`.

## Tools (29)

| Tool | Kind | Purpose |
| --- | --- | --- |
| `substrate_get_state` | read | material, resolution/proxy, node/link counts, output wiring, eval stats, history, selection |
| `substrate_get_graph` | read | full graph JSON (nodes/params, connections, output id) |
| `substrate_list_demos` | read | built-in demo materials |
| `substrate_list_projects` | read | saved projects on the local server |
| `substrate_get_thumbnail` | read | 96 px PNG data URL of a node (default: output) |
| `substrate_search_open_assets` | read | search open-license online materials (creator/license/source URLs) |
| `substrate_import_asset_url` | write | download an online image into the material library with attribution |
| `substrate_get_preview` | read | PNG data URL of one 2D channel or the shaded 3D material ball |
| `substrate_evaluate` | read/write | force evaluation and return timing/passes/cache stats |
| `substrate_run_selftest` | read | GPU pipeline self-test (shaders, channels, normals, seams) |
| `substrate_run_audit` | read | application audit (schema/render/values/actions/dom/i18n/ui) |
| `substrate_load_demo` | write | load a demo graph |
| `substrate_new_project` | write | empty material graph |
| `substrate_add_node` | write | add a node by type, returns node id |
| `substrate_delete_node` | destructive | delete a node and its links |
| `substrate_duplicate_node` | write | duplicate a node |
| `substrate_move_node` | write | set node position |
| `substrate_connect` | write | connect output → input port |
| `substrate_disconnect` | destructive | remove a link by id |
| `substrate_set_param` | write | set any node parameter (numbers, colours, vectors, gradients) |
| `substrate_set_resolution` | write | document resolution and/or proxy factor |
| `substrate_set_locale` | write | switch UI language (does not change the stored preference) |
| `substrate_history` | write | undo / redo |
| `substrate_paint_stroke` | write | commit a brush stroke (10 basic + 6 nature brushes, taper, symmetry, erase) |
| `substrate_clear_paint` | destructive | remove all strokes from a paint layer |
| `substrate_export` | write | bake + export a standards-compliant package (PNG maps, manifest, README, zip) |
| `substrate_save_project` | write | save the graph to a project file |
| `substrate_load_project` | write | load a saved project |
| `substrate_delete_project` | destructive | delete a saved project |

## Authentication

By default the gateway is local-only without authentication. Set `MCP_TOKEN` on the server to require
a token on the MCP endpoints:

```bash
MCP_TOKEN=secret-token npm start
```

External clients send `Authorization: Bearer secret-token` (or `X-MCP-Token`). Because the browser's
`EventSource` cannot send headers, set `localStorage.setItem('substrate.mcpToken', 'secret-token')` in
the app tab so the bridge appends `?token=` to its event stream.

## Automated tests

`npm run test:mcp` exercises: gateway availability/catalog, stdio transport logic (initialize,
tools/list, tools/call, ping), graph reads/mutations, evaluation, thumbnails, online material search/import,
2D/3D preview capture, painting, project save/load/delete, export + zip, normalized error envelopes, HTTP JSON-RPC
(`/mcp`), the plain JSON endpoint, AI rules and the material-library API. It prints a PASS/FAIL summary and
restores the demo material.

The extended test also covers the MCP self-check endpoint, the LLM model/provider API (key-leak assertions,
provider validation/masking), AI rules and the material-library API + online search/import SSRF guards. The stdio framing itself is a newline-delimited JSON-RPC loop: piping an `initialize` request into
`node mcp/server.mjs` returns the server info line (validated in CI environments that allow child
processes).

## Limitations

- One tool executes at a time per browser tab; multiple open tabs are used round-robin.
- Tool execution requires the WebGL app tab to be open and awake (background-tab timer throttling may
  slow long operations; the studio focuses itself for audits via `scripts/cdp.mjs`).
- `substrate_export` writes packages to the server's `exports/` folder; large resolutions need GPU
  memory on the browser machine.
- The interface is local-first: bind the server to `127.0.0.1` and use `MCP_TOKEN` if other local
  processes should not be able to drive the studio.
