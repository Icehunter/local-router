# claude-local-router

A Claude Code plugin that routes implementation work to a local OpenAI-compatible LLM running on llama.cpp, LM Studio, Ollama, or vLLM, so an agent can delegate code-writing to a private local model while keeping planning, review, and integration in the main loop.

## Why

If you have a local box with a coder model loaded, you can have your primary agent plan and review while the local model handles focused code generation. The configured model runs on your hardware or private LAN.

## Architecture

- **Primary agent**: planning, file reading, integration, review, and deciding what context to send
- **This plugin's MCP server**: a local Node subprocess with no filesystem access; relays prompts to your upstream LLM over HTTP
- **Your local server (llama.cpp / LM Studio / Ollama / vLLM)**: handles code generation

The plugin exposes up to two MCP tools:

- `local_implement` — delegate mode. Wraps output in `<local_output>` and appends a provider-neutral review reminder.
- `local_direct` — direct mode. Returns raw local-model output for local CLI flows or human-facing answers.

The two differ in one thing only: which way the wrapping decision falls when the caller
names no `task`. Once a task is named, that task's profile decides, and the tool name
changes nothing. So an instance whose `tasks` allowlist contains no wrapping task —
neither `implement` nor `fix` — publishes **only `local_direct`**. On such an instance
`local_implement` would differ from `local_direct` in exactly one reachable way: it would
apply the no-task code-generation default, which is the one behaviour that instance has
declared it does not serve. Calling it directly is rejected for the same reason.

### Tasks

Both tools accept a `task` argument that selects a prompt and sampling profile. It is
optional only when `tasks` is unset; an instance that declares an allowlist has also
declared that the no-task code-generation default is not one of the things it serves, so
`task` is marked required in its published schema and rejected when missing.

| task | what it is for | wrapped for review | temperature | output cap |
|---|---|---|---|---|
| `implement` | writing new code | yes | 0.2 | — |
| `fix` | smallest change that makes failing code correct | yes | 0.1 | — |
| `review` | mechanical defects only, one per line, `NONE` if clean | no | 0.2 | 1500 |
| `summarize` | compressing logs, lists and long output | no | 0.0 | 1000 |
| `extract` | pulling out symbols or items verbatim | no | 0.0 | 1000 |
| `explain` | prose explanation of unfamiliar code | no | 0.6 | — |
| `classify` | one label per input; requires `examples` | no | 0.0 | 50 |

`classify` requires an `examples` array of at least two `{ input, output }` pairs, sent
as alternating user/assistant turns. Without examples a small model returns the same
label for every input, so the argument is required rather than recommended.

`summarize`, `extract` and `review` accept `max_lines`, a positive integer that bounds the
output to that many lines. `summarize` defaults to 10 when you omit it; the other two have
no default, because the number of symbols or defects is whatever it is. Other tasks reject
the argument. The cap reaches the model as a literal count in the last sentence of the
prompt: a small model will not reliably resolve an instruction that refers to a number
stated elsewhere, so the digit has to be in the instruction itself.

The cap is binding on `summarize` and advisory on `extract` and `review`. A summary can
always be made shorter by merging lines, so the model obeys. An extraction or a defect
list cannot: if there are seven symbols and the cap is five, the only way to fit is to
drop two. The model keeps the data and exceeds the cap, which is the failure you want —
an overrun is visible in the output, a silently dropped symbol is not. Treat `max_lines`
on those two as a budget hint, and size the request rather than the cap if you need a
guarantee.

Precedence for every setting is **explicit argument > task profile > config default**.
An output cap only ever lowers `maxTokens`; it never raises it.

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
| `tier` | no | `null` | Free-form label for this instance, e.g. `coder` or `helper`. Appears in the tool description. Does no gating. |
| `tasks` | no | `null` | Tasks this instance accepts. `null` means all of them. Setting it does three things: the published `task` enum lists only these, so a disallowed task is unreachable; `task` becomes required, because the no-task code-generation default is not one of the listed tasks; and `local_implement` is published only if `implement` or `fix` is on the list. Also settable as `LOCAL_LLM_TASKS=summarize,extract`. |

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
- `LOCAL_LLM_TOOL_DESCRIPTION`
- `LOCAL_LLM_TIER`
- `LOCAL_LLM_TASKS` (comma-separated, e.g. `summarize,extract`)

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

Delegation is **opt-in**. Your agent does the work itself unless you ask for the local
model, so nothing silently leaves your machine because a change looked big.

### Say it in plain English

You never type a tool name or a JSON argument. You say what you want and which box
should do it; the agent picks the tool and the `task`.

| Say something like | Tool the agent calls | `task` |
|---|---|---|
| "have the local model write the retry wrapper for `client.ts`" | `local_implement` (coder) | `implement` |
| "let the local model fix this failing test" | `local_implement` (coder) | `fix` |
| "have the local model check that diff for missing imports and typos" | `local_direct` (coder) | `review` |
| "get the local model to explain what `server.ts` is doing" | `local_direct` (coder) | `explain` |
| "squash this 400-line log down with the helper" | `local_direct` (helper) | `summarize` |
| "use the helper to list every exported function in these files" | `local_direct` (helper) | `extract` |
| "have the helper label each of these tickets trivial or not — here are four examples" | `local_direct` (helper) | `classify` |

The words that matter are **which model** ("the local model", "the helper", "the 27B",
"the small one") and **what kind of job**. Everything else is ordinary English.

Useful phrasings:

- **Pick the tier explicitly.** "Use the *helper* for this, not the 27B" — the 4B is much
  faster and the GPU box serializes its calls.
- **Turn it on for a stretch.** "For the rest of this session, route all summarizing and
  log compression to the helper." The agent keeps doing it until you say stop.
- **Ask for a bound.** "Summarize that in at most 5 lines" becomes `max_lines: 5`.
- **Hand over the review.** "Have the local model write it, then you review it before
  applying" — this is the intended loop, and it is what the plugin nudges toward anyway.

### What comes back

`implement` and `fix` return their output wrapped in a `<local_output id="…">` block with
a review reminder attached. That is deliberate: the wrapper marks the text as untrusted
model output rather than instructions, and the reminder tells your agent to review before
writing anything to disk. You will usually see the agent read the result, check it, and
only then edit your files.

Everything else — `review`, `explain`, `summarize`, `extract`, `classify` — comes back as
plain text with no wrapper, because none of it is code you are about to apply.

### Two boxes, two jobs

A typical setup runs two instances of this plugin against two different models: a large
one for writing code and a small fast one for text chores. Point them at different
backends and give each a `tasks` allowlist, and the agent can no longer send a
summarization job to the expensive model or ask the 4B to write code — the wrong task
is not in the published schema, so it is unreachable rather than merely a bad idea.

```jsonc
// coder: the big model
"LOCAL_LLM_TIER": "coder",
"LOCAL_LLM_TASKS": "implement,fix,review,explain",
"LOCAL_LLM_TOOL_DESCRIPTION": "27B GPU model. Use for writing and refactoring code."

// helper: the small model
"LOCAL_LLM_TIER": "helper",
"LOCAL_LLM_TASKS": "summarize,extract,explain,classify",
"LOCAL_LLM_TOOL_DESCRIPTION": "4B CPU model, fast. Use for summaries, extraction, classification."
```

`LOCAL_LLM_TOOL_DESCRIPTION` is what the agent reads to tell the two apart, so write it
as advice to the agent, not as a label.

### Calling it from something other than Claude Code

It is an ordinary stdio MCP server, so any MCP client can drive it. One required argument,
`prompt`, plus `task` on any instance that declares a `tasks` allowlist:

```json
{
  "name": "local_direct",
  "arguments": {
    "task": "summarize",
    "max_lines": 5,
    "prompt": "Summarize the following build log, keeping every error string.\n\n<log text>"
  }
}
```

The server has no filesystem access — whatever the model needs to see has to be in
`prompt`. Assembling that context is the calling agent's job.

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
