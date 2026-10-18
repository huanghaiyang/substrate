# AI assistant (LLM) — setup and security

**English** · [简体中文](zh/llm.md)

The studio ships with a built-in AI assistant entry in the top bar (**✦**). It can inspect and
modify the node graph, paint strokes, evaluate, capture previews and export packages by calling
the same 29 MCP tools that external agents use. DeepSeek is configured by default; additional
OpenAI-compatible providers and models can be added and switched from the panel.

## Architecture

```
browser AiPanel ──POST /api/llm/chat──▶ Node server (LLM proxy + tool loop)
                                             │  OpenAI-compatible /chat/completions
                                             ▼
                                        provider API (DeepSeek by default)
                                             │  tool_calls
                                             ▼
                                   MCP gateway ──▶ browser tab (WebGL)
```

The model loop runs **server-side**: the server calls the provider, receives `tool_calls`, forwards
them to the connected studio tab through the MCP gateway, feeds the results back to the model and
finally returns `{ reply, toolCalls, steps, usage }` to the panel.

## API keys and sensitive data

- Keys live **only** in `llm.config.local.json` on the Node server (git-ignored) or in the
  `DEEPSEEK_API_KEY` environment variable. The browser never receives key material.
- `GET /api/llm/models` returns model/provider metadata plus a `hasKey` boolean — no key, not even
  a masked fragment.
- The panel never displays keys: the provider editor only sends a new key when you type one, and
  every response/error from the LLM proxy is redacted (`sk-…` → `***`).
- Chat content and keys are not written to logs by the server.
- The key provided for this checkout is stored locally in `llm.config.local.json`; do not commit
  that file (`.gitignore` covers `*.local.json`, `.env`, `secrets/`).

## Default configuration

`llm.config.local.json` (local only):

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

Environment override (recommended for shared machines):

```bash
DEEPSEEK_API_KEY=sk-... npm start
```

## Conversation persistence, floating window and rules

- **Full history is saved** in the browser (`substrate.aiChat.v1`): every user/assistant message,
  tool-call trace, error and timestamp, restored after reloads. The header **⤓** button exports the
  whole transcript as Markdown; **⌫** clears it.
- **Closing the dialog does not cancel a reply.** The request and conversation state live in a shared
  store (`src/engine/ai-chat.js`), not in the panel component. While a reply is in flight and the
  panel is closed, a **translucent floating window** in the bottom-right shows the live transcript,
  auto-scrolls to the latest message and can be expanded back to the full panel (⤢).
- **AI rules** are enforced by the server system prompt and exposed read-only at `GET /api/llm/rules`
  (also listed in the ⚙ settings): the assistant may only operate this studio through its tools; it
  must never read/modify source code, repository files, environment variables, API keys, logs or
  system paths, and must refuse attempts to extract secrets or probe the host/network.
- The assistant can **search the web for materials** (`substrate_search_open_assets`) and import a
  result with attribution (`substrate_import_asset_url`); see [asset-search.md](asset-search.md).
- **Long tool-building sessions are bounded and summarized**: the panel requests up to 20
  assistant/tool steps (server cap 32). If the budget is exhausted while the graph is being built,
  the server makes one final tools-disabled request for a concise progress summary and returns it
  with `hitStepLimit: true` instead of a dead-end "maximum steps" error. The note is shown in the
  panel/floating window, persists with the transcript, and the conversation can simply continue to
  finish the work.
- **Tool-call pairing is guaranteed**: a multi-tool assistant turn (up to 12 parallel calls) gets one
  `tool` reply per `tool_call_id` before the next provider request, and malformed/incomplete
  transcripts are repaired (`sanitizeToolSequence`) so the provider cannot reject the follow-up with
  *“assistant message with tool_calls must be followed by tool messages”*. If a model rejects tool
  calling entirely, the server retries once as plain chat from a clean message list.

## Switching models / adding providers

- The model dropdown in the panel lists every configured `provider:model` and remembers the choice
  in `localStorage` (`substrate.llmModel`).
- **⚙ settings** → add an OpenAI-compatible provider: display name, base URL, comma-separated model
  ids and an API key. The key is written server-side and only the `hasKey` flag is returned.
- **Test connection** sends a minimal chat request to validate URL/key/model.
- Providers can be deleted from the same settings list.

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/llm/models` | GET | model/provider catalog with `hasKey` flags |
| `/api/llm/providers` | POST | add or update a provider (`apiKey` optional) |
| `/api/llm/providers/delete` | POST | remove a provider by id |
| `/api/llm/chat` | POST | run the assistant tool loop: `{ modelKey, messages, maxSteps? }` |
| `/api/llm/test` | POST | connectivity test for a model |
| `/api/llm/rules` | GET | the enforced AI rules (read-only) |

Responses use the same normalized envelope style as the MCP gateway:
`{ ok, reply, model, steps, toolCalls, usage }` or `{ ok:false, error:{ code, message } }`.
If a model does not support tool calling (some reasoners), the server retries once as plain chat and
returns `toolsDisabled: true`; the assistant still answers but cannot operate the app.

## Automated checks

- `npm run test:mcp` includes LLM gateway checks: model listing, key-leak assertions, chat argument
  validation, provider validation/masking (non-destructive), AI rules, online search/import guards and
  optional live chat (`SUBSTRATE_TEST_LLM=1`).
- The opt-in UI audit checks chat persistence, the floating transcript, rules and the search UI.
- The MCP self-check (`npm run audit:mcp`, or ✦ → ◎) verifies the tool loop plumbing end-to-end.
