# claude-local-router

A Claude Code plugin that routes implementation work to a local OpenAI-compatible LLM running on llama.cpp, LM Studio, Ollama, or vLLM, so an agent can delegate code-writing to a private local model while keeping planning, review, and integration in the main loop.

## Why

If you have a local box with a coder model loaded, you can have your primary agent plan and review while the local model handles focused code generation. The configured model runs on your hardware or private LAN.

## Architecture

- **Primary agent**: planning, file reading, integration, review, and deciding what context to send
- **This plugin's MCP server**: a local Node subprocess with no filesystem access; relays prompts to your upstream LLM over HTTP
- **Your local server (llama.cpp / LM Studio / Ollama / vLLM)**: handles code generation

The plugin exposes two MCP tools:

- `local_implement` — delegate mode. Wraps output in `<local_output>` and appends a provider-neutral review reminder.
- `local_direct` — direct mode. Returns raw local-model output for local CLI flows or human-facing answers.

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
/plugin install claude-local-router@<marketplace-name>
```

Or install from a git URL via the `/plugin` UI's Discover tab. (Exact command depends on your marketplace setup. See the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins.md).)

After install, build the plugin's TypeScript output:

```bash
cd ~/.claude/plugins/claude-local-router
npm install
npm run build
```

## Configure

Copy the example config:

```bash
cp ~/.claude/plugins/claude-local-router/config.example.json ~/.claude/plugins/claude-local-router/config.json
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
| `baseUrl` | yes | — | Your server's host. The plugin appends `/v1/chat/completions`; a trailing `/` or `/v1` is stripped first, so `http://host:1234` and `http://host:1234/v1` both work. |
| `model` | yes | — | Model name (or alias) as your server reports it. |
| `apiKey` | no | `null` | Bearer token if your server is behind auth. |
| `tokenBudget` | no | `180000` | Max prompt size before the tool errors. Leaves headroom for response inside a 200K context. |
| `requestTimeoutMs` | no | `300000` | 5 min. Local generation can be slow. |
| `maxTokens` | no | `16000` | Max tokens the model may generate per response. Most servers cap higher than this; raise if you need long completions. |
| `temperature` | no | `0.7` | Sampling temperature. Lower = more deterministic but can amplify repetition loops without `repeatPenalty`. |
| `topP` | no | `0.8` | Nucleus sampling. Probability mass cutoff for candidate tokens. |
| `topK` | no | `20` | Top-K sampling. Max number of candidate tokens at each step. 0 disables. |
| `minP` | no | `0.05` | Min-P sampling. Cuts low-probability token tails; many coder-model guides recommend this for code. |
| `repeatPenalty` | no | `1.1` | Penalty applied to recently-emitted tokens to suppress repetition loops. 1.0 = no penalty, 1.1 = standard, > 1.3 = often too suppressive. Sent as `repeat_penalty`, which llama.cpp and Ollama honour; vLLM and LM Studio ignore the field rather than erroring. |
| `enableThinking` | no | `null` | Sends `chat_template_kwargs: {enable_thinking: …}`. `null` omits the field entirely, leaving the backend's default. Set `false` for a reasoning model (Qwen3 and similar): with thinking on, the model spends `maxTokens` on `reasoning_content` and can return an **empty** `content`, which this plugin then correctly rejects as a failed generation. Measured on qwen3.8-27b: thinking on at `maxTokens: 2500` returned 2500 reasoning tokens and zero content; thinking off returned a complete answer in 1268 tokens. |
| `debugLogPath` | no | `null` | When set to a file path, the plugin appends a JSONL entry per call (request + response, bodies truncated at 8KB) to that file. The file is created `0600` because entries contain full prompt bodies. Default `null` disables logging. |

### Environment variable overrides

Configuration resolves in this order, first match wins:

1. Environment variables (including anything declared in the `env` block of your `.mcp.json`)
2. `config.json` at `$CLAUDE_PLUGIN_ROOT/config.json`
3. The built-in defaults in the table above

- `LOCAL_LLM_BASE_URL`
- `LOCAL_LLM_MODEL`
- `LOCAL_LLM_API_KEY`
- `LOCAL_LLM_TOKEN_BUDGET`
- `LOCAL_LLM_REQUEST_TIMEOUT_MS`
- `LOCAL_LLM_MAX_TOKENS`
- `LOCAL_LLM_TEMPERATURE`
- `LOCAL_LLM_TOP_P`
- `LOCAL_LLM_TOP_K`
- `LOCAL_LLM_MIN_P`
- `LOCAL_LLM_REPEAT_PENALTY`
- `LOCAL_LLM_DEBUG_LOG_PATH`
- `LOCAL_LLM_ENABLE_THINKING` (`true` / `false` / `1` / `0`)

A variable that is set but blank counts as *not provided*, so resolution falls through
to `config.json` and then to the default. This is what makes the bundled `.mcp.json`
safe: it declares every tuning variable as `"${LOCAL_LLM_X:-}"`, which expands to an
empty string when you have not set it, leaving `config.json` in charge.

Two exceptions, where blank means *explicitly off* rather than *not provided*:
`LOCAL_LLM_API_KEY=` sends no bearer token even if `config.json` sets one, and
`LOCAL_LLM_DEBUG_LOG_PATH=` disables logging the same way. Because declaring these in
an `env` block would permanently override `config.json`, the bundled `.mcp.json` leaves
them out; add them yourself only if you want that override.

> **After pulling, run `npm run build`.** `dist/` is gitignored, so a pull never updates
> the compiled server.
>
> **If Claude Code reports `CONNECTION_CLOSED`,** run `claude mcp list`. A warning of
> `Missing environment variables: CLAUDE_PLUGIN_ROOT` means the launch path did not
> expand: `CLAUDE_PLUGIN_ROOT` is set only for plugin-provided MCP servers, and an unset
> `${VAR}` with no default is passed through as literal text, so node is handed a path
> that does not exist. Use a `:-` default (as the bundled `.mcp.json` now does) or an
> absolute path.

### How a configuration value is resolved

Configuration values are resolved in strict order of precedence: environment variable,
then `config.json`, then the built-in default. The first source that provides a value wins.

1. **Environment variable** — including anything declared in an `.mcp.json` `env` block.
2. **`config.json`** — at `$CLAUDE_PLUGIN_ROOT/config.json`.
3. **Built-in default** — the values in the table above.

| Value | Meaning |
| :--- | :--- |
| Unset | Falls through to `config.json`, then the default. |
| Blank or whitespace-only | Treated as *not provided*; falls through to `config.json`, then the default. This is what lets an `.mcp.json` env block declare every variable as `"${LOCAL_LLM_X:-}"` without clobbering `config.json`. |
| Blank, for `LOCAL_LLM_API_KEY` or `LOCAL_LLM_DEBUG_LOG_PATH` | Treated as *explicitly disabled*, and overrides `config.json`. |
| A literal `${LOCAL_LLM_X}` | Rejected with an error naming the variable. This happens when an `.mcp.json` references a variable that is not set and gives no `:-` default. |

**Normalization and limits.** `baseUrl` has a trailing slash and a trailing `/v1` stripped,
because the client appends `/v1/chat/completions`; a path merely ending in the letters `v1`
(for example `/api/openaiv1`) is left alone. `requestTimeoutMs` must be at most
`2147483647` — larger values overflow `setTimeout` and abort every request after 1ms.
Unrecognized keys in `config.json` produce a stderr warning naming the key and the file
and are then ignored, not treated as fatal, because `config.json` outlives any single build.

### Configuring without a config.json

If you install this as a plugin and would rather not keep a `config.json` in the plugin
root, put the values straight into the `env` block of your MCP server definition:

```json
{
  "mcpServers": {
    "local-router": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"],
      "env": {
        "LOCAL_LLM_BASE_URL": "http://192.168.1.50:1234",
        "LOCAL_LLM_MODEL": "qwen3-coder"
      }
    }
  }
}
```

This is the more reliable path on macOS, where an app launched from Finder does not
inherit the exports in your shell profile. The `env` block is additive: the server
still inherits your shell environment on top of whatever you list here.

### How the tools handle upstream responses

- **Empty completions are errors.** If the model returns `content: ""`, the call fails
  rather than reporting a successful delegation with nothing in it.
- **Truncated completions are flagged.** If the upstream reports
  `finish_reason: "length"`, the response still comes back, followed by a
  `[local-router] WARNING` line noting it was cut off at `maxTokens`. The warning sits
  outside the `<local_output>` block so it cannot be confused with model output.
- **The output block is id-tagged.** Output is wrapped as
  `<local_output id="…">` … `</local_output id="…">` with a fresh random id per call.
  Model output containing a literal `</local_output>` therefore cannot end the block
  early and pose as the plugin's own instructions.
- **`output_format` is validated.** An unrecognized value is rejected instead of being
  silently treated as `code`.

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

In any Claude Code session, just ask Claude to do something. Claude decides when to delegate to the local model — typically for the actual code-writing step of a multi-step task.

You can also nudge it explicitly: "Have the local model implement this part."

## Fallback behavior

If the upstream server fails (network down, model not loaded, timeout, etc.), Claude announces the failure out loud and falls back to handling the step itself. After **two consecutive** failures, Claude will pause on the third and ask you whether to keep going Opus-only or stop and check the upstream. The counter resets after a successful local model call.

This is a behavioral rule, not enforced by plugin code. Claude follows it because the README documents it.

## Security notes

- **Filesystem:** The plugin's MCP server cannot read your files. Claude Code reads files using its own tools, subject to its existing permission prompts.
- **Network:** Plain HTTP over your LAN by default. If you don't trust your network, put your server behind a reverse proxy with TLS and use `apiKey`.
- **Secrets in prompts:** If Claude reads a `.env` and includes it in a local model prompt, those secrets cross the LAN. The plugin doesn't filter content; that's on Claude Code's permission flow + your judgement.

## Concurrency

Most local servers default to single-request handling (e.g. llama.cpp's `--parallel 1`). The plugin makes one request at a time per tool call. If you want concurrency, configure your upstream for it.

## Troubleshooting

**"Cannot reach upstream at ..."** — The host/port in `baseUrl` is wrong, or the server isn't running, or a firewall is blocking it. Test from your laptop: `curl http://<host>:<port>/v1/models`.

**"Upstream returned 404: model not found"** — `model` in config doesn't match what your server has loaded. Check with `curl http://<host>:<port>/v1/models`.

**"Prompt exceeds tokenBudget"** — Claude tried to send too much in one call. Either Claude needs to chunk the work smaller, or you can raise `tokenBudget` if your server's context is bigger than 200K.

**"Local model request timed out after Nms"** — Generation is slow on your hardware. Raise `requestTimeoutMs` or use a smaller model. If the error appears *instantly* and N is very large, you have not hit a real timeout: `requestTimeoutMs` is capped at 2147483647 (24.8 days) because anything larger overflows `setTimeout` and aborts after 1ms. There is no "disable the timeout" value — pick a real duration.

**"Unexpected response from upstream (no choices[0].message.content)"** — The LLM returned a valid HTTP 200 with JSON, but the response body is missing expected content fields, often due to the model hitting an internal stop condition or a misconfigured chat template. Verify your model's output by testing the endpoint directly with `curl` and inspecting the raw JSON response.

**"Upstream at <url> returned 200 but unparseable JSON"** — The server responded with HTTP 200, but the body isn't valid JSON, likely because a reverse proxy injected an error page or the upstream timed out mid-response. Confirm your endpoint is correctly configured and not being intercepted by middleware; test the raw URL with `curl` to inspect the actual response body.

**Plugin doesn't show up in Claude Code** — Check Claude Code's session-startup logs; if the MCP server failed to start, the error message will tell you what's wrong (usually missing config).

**Don't know why a delegation went wrong** — Set `debugLogPath` (or `LOCAL_LLM_DEBUG_LOG_PATH=/path/to/file.log`) and re-run. The plugin appends a JSONL entry per call with the prompt sent and the response received. Tail the file with `tail -f <path>`. Logging is off by default; remember to disable it after debugging if the file is in a sensitive location.

## License

MIT.
