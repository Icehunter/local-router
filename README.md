# claude-qwen-router

A Claude Code plugin that routes implementation work to a local OpenAI-compatible LLM (e.g., Qwen running on llama.cpp, LM Studio, Ollama, or vLLM) so Claude Code (Opus / Sonnet on Max) can delegate code-writing to a free local model while keeping planning and review on Claude.

## Why

If you have a Claude Max subscription and a local box with a coder model loaded, you can have Claude Code plan and review while the local model handles the bulk of code generation. No Anthropic API spend beyond what Max already covers; Qwen runs on your hardware for free.

## Architecture

- **Claude Code (Opus, Sonnet)**: planning, file reading, integration, review (via the built-in Task subagent tool)
- **This plugin's MCP server**: a local Node subprocess with no filesystem access; relays prompts to your upstream LLM over HTTP
- **Your local server (llama.cpp / LM Studio / Ollama / vLLM)**: handles code generation

The plugin exposes one MCP tool: `qwen_implement`. Claude Code calls it with a fully-assembled prompt, the plugin POSTs to your `/v1/chat/completions` endpoint, response comes back as text.

## Prerequisites

- Claude Code (any subscription that can use plugins)
- Node.js 20+ on the machine running Claude Code
- An OpenAI-compatible chat-completions server reachable from your laptop. Tested against:
  - **llama.cpp** (`llama-server`)
  - **LM Studio**
  - **Ollama** (`/v1/chat/completions` endpoint)
  - **vLLM**

## Install

In Claude Code:

```
/plugin install claude-qwen-router@<marketplace-name>
```

Or install from a git URL via the `/plugin` UI's Discover tab. (Exact command depends on your marketplace setup. See the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins.md).)

After install, build the plugin's TypeScript output:

```bash
cd ~/.claude/plugins/claude-qwen-router
npm install
npm run build
```

## Configure

Copy the example config:

```bash
cp ~/.claude/plugins/claude-qwen-router/config.example.json ~/.claude/plugins/claude-qwen-router/config.json
```

Edit `config.json`:

```json
{
  "baseUrl": "http://192.168.1.50:1234",
  "model": "qwen3-coder",
  "apiKey": null,
  "tokenBudget": 180000,
  "requestTimeoutMs": 300000
}
```

| Key | Required | Default | Notes |
|---|---|---|---|
| `baseUrl` | yes | — | Your server's host. No trailing slash. The plugin appends `/v1/chat/completions`. |
| `model` | yes | — | Model name (or alias) as your server reports it. |
| `apiKey` | no | `null` | Bearer token if your server is behind auth. |
| `tokenBudget` | no | `180000` | Max prompt size before the tool errors. Leaves headroom for response inside a 200K context. |
| `requestTimeoutMs` | no | `300000` | 5 min. Local generation can be slow. |

### Environment variable overrides

Any of these wins over `config.json`:

- `QWEN_BASE_URL`
- `QWEN_MODEL`
- `QWEN_API_KEY`
- `QWEN_TOKEN_BUDGET`
- `QWEN_REQUEST_TIMEOUT_MS`

### Example: starting llama.cpp for this plugin

```bash
llama-server \
  -m /path/to/your/model.gguf \
  --gpu-layers 99 \
  --ctx-size 200000 \
  --host 0.0.0.0 \
  --port 1234 \
  --alias qwen3-coder
```

Then `model` in your config should be `qwen3-coder`.

## Use

In any Claude Code session, just ask Claude to do something. Claude decides when to delegate to Qwen — typically for the actual code-writing step of a multi-step task.

You can also nudge it explicitly: "Have Qwen implement this part."

## Fallback behavior

If the upstream server fails (network down, model not loaded, timeout, etc.), Claude announces the failure out loud and falls back to handling the step itself. After **two consecutive** failures, Claude will pause on the third and ask you whether to keep going Opus-only or stop and check the upstream. The counter resets after a successful Qwen call.

This is a behavioral rule, not enforced by plugin code. Claude follows it because the README documents it.

## Security notes

- **Filesystem:** The plugin's MCP server cannot read your files. Claude Code reads files using its own tools, subject to its existing permission prompts.
- **Network:** Plain HTTP over your LAN by default. If you don't trust your network, put your server behind a reverse proxy with TLS and use `apiKey`.
- **Secrets in prompts:** If Claude reads a `.env` and includes it in a Qwen prompt, those secrets cross the LAN. The plugin doesn't filter content; that's on Claude Code's permission flow + your judgement.

## Concurrency

Most local servers default to single-request handling (e.g. llama.cpp's `--parallel 1`). The plugin makes one request at a time per tool call. If you want concurrency, configure your upstream for it.

## Troubleshooting

**"Cannot reach upstream at ..."** — The host/port in `baseUrl` is wrong, or the server isn't running, or a firewall is blocking it. Test from your laptop: `curl http://<host>:<port>/v1/models`.

**"Upstream returned 404: model not found"** — `model` in config doesn't match what your server has loaded. Check with `curl http://<host>:<port>/v1/models`.

**"Prompt exceeds tokenBudget"** — Claude tried to send too much in one call. Either Claude needs to chunk the work smaller, or you can raise `tokenBudget` if your server's context is bigger than 200K.

**"Qwen request timed out after Nms"** — Generation is slow on your hardware. Raise `requestTimeoutMs` or use a smaller model.

**Plugin doesn't show up in Claude Code** — Check Claude Code's session-startup logs; if the MCP server failed to start, the error message will tell you what's wrong (usually missing config).

## License

MIT.
