# Claude Code Qwen Router Plugin — Design

**Date:** 2026-04-30
**Status:** Approved design, ready for implementation planning

## Problem

The user has Claude Code Max (Opus + Sonnet covered by subscription) and a local the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) instance running a Qwen-class coder model on a separate LAN machine. They want a distributable Claude Code plugin that lets them — and other users — delegate code-writing work to the local Qwen model, while keeping planning and review on the Claude side. No Anthropic API spend; the local Qwen handles implementation work for free.

The previously scaffolded `modelrouter/` Agent SDK app was the wrong shape: it would have billed Opus and Sonnet calls to the Anthropic API, double-charging the user who already pays for Max. The right shape is a Claude Code plugin that exposes Qwen as a tool inside Claude Code itself.

## Goals

1. From within any Claude Code session, the user can ask Claude to implement a feature, and Claude can route the actual code generation to the user's local Qwen model.
2. Distributable. Anyone with Claude Code Max + the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) on their network can install the plugin and configure it for their setup.
3. Zero filesystem access from the plugin. Claude Code's existing permission system gates file reads; the plugin only relays text to Qwen.
4. Stateless tool calls. No session memory, no compaction, no hidden state.

## Non-Goals

- Streaming responses
- Retry logic
- Response caching
- Multi-turn conversation memory with Qwen
- Real tokenizer-based token counting (heuristic is fine)
- Shipping precompiled binaries
- Solving LAN security (HTTPS / auth is the user's responsibility, supported but not enforced)

## Architecture

```
┌────────────────────────────────────────────┐         ┌────────────────────────────┐
│  User's laptop                             │         │  LAN box                   │
│                                            │         │  OpenAI-compatible server  │
│  Claude Code (Opus, planner/orchestrator)  │         │  (llama.cpp / LM Studio /  │
│   - reads files via existing Read tool     │         │   Ollama / vLLM)           │
│   - assembles prompt text                  │         │                            │
│   - dispatches Sonnet subagents via Task   │         │                            │
│         │                                  │         │                            │
│         │ MCP call: qwen_implement(prompt) │         │                            │
│         ▼                                  │         │                            │
│  qwen MCP server (Node subprocess)         │  HTTP   │                            │
│   - NO filesystem access                   │────────►│  /v1/chat/completions      │
│   - relays prompt → Qwen → response text   │         │  Qwen 200K context         │
└────────────────────────────────────────────┘         └────────────────────────────┘
```

**Three responsibilities, three actors:**

- **Opus (Claude Code main loop):** plans the work, decides what files Qwen needs to see, reads those files using its own tools (subject to Claude Code's existing permission prompts), assembles the prompt, calls `qwen_implement`, applies file writes, integrates results.
- **Sonnet subagents:** dispatched via Claude Code's built-in Task tool to review Qwen's output. No plugin work needed for this — Task is already a Claude Code primitive.
- **Qwen (remote, via MCP server):** writes code based on the prompt it receives.

The plugin's MCP server runs as a local subprocess on the user's laptop (standard MCP stdio transport). It has no filesystem access. Its only job is to take a prompt string, send it over HTTP to the configured the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) endpoint, and return Qwen's response text.

## The `qwen_implement` Tool

Single tool. Stateless. One call per implementation chunk.

**Inputs:**

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The complete user-message text being sent to Qwen. Caller (Opus) assembles instruction, file contents, and any running context into this string. |
| `system` | string | no | System message override. Default is a baked-in coder persona suitable for code generation. |
| `output_format` | enum: `"code"` \| `"diff"` \| `"explanation"` | no, default `"code"` | Appended as a directive to the prompt. The server does not parse the response. |

**Behavior:**

1. Estimate token count of `prompt + system` using the heuristic `bytes / 4`. If estimate exceeds `tokenBudget` (configurable, default 180,000), return a tool error containing the estimate. No automatic pruning.
2. POST to `${baseUrl}/v1/chat/completions` with body:
   ```json
   {
     "model": "<configured model>",
     "messages": [
       {"role": "system", "content": "<system or default>"},
       {"role": "user", "content": "<prompt + format directive>"}
     ],
     "max_tokens": 16000
   }
   ```
   Include `Authorization: Bearer <apiKey>` header iff `apiKey` is set.
3. Return the assistant message's text content unmodified.

**Errors surface as MCP tool errors, never silent fallbacks.** See "Failure Modes" below.

## Configuration

**Loading order (later overrides earlier):**

1. `${CLAUDE_PLUGIN_ROOT}/config.json` if it exists (warn but don't fail if missing)
2. Environment variables

**Required after merge:** `baseUrl`, `model`. If either is missing, the MCP server logs a clear error and exits — tool calls don't get to fail mysteriously later.

**`config.json` schema:**

```json
{
  "baseUrl": "http://192.168.1.50:1234",
  "model": "qwen2.5-coder-32b-instruct",
  "apiKey": null,
  "tokenBudget": 180000,
  "requestTimeoutMs": 300000
}
```

| Key | Default | Notes |
|---|---|---|
| `baseUrl` | (required) | the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) host. No trailing slash. The server appends `/v1/chat/completions`. |
| `model` | (required) | Model name as it appears in the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM). |
| `apiKey` | `null` | Usually unused with the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM). Supported for users who put Qwen behind a reverse proxy with auth. |
| `tokenBudget` | `180000` | Max prompt size before the tool errors. Leaves headroom for response inside Qwen's 200K context. |
| `requestTimeoutMs` | `300000` | 5 min. Slow hardware can take minutes for large generations. |

**Env var overrides** (any of these wins over the config file):
`QWEN_BASE_URL`, `QWEN_MODEL`, `QWEN_API_KEY`, `QWEN_TOKEN_BUDGET`, `QWEN_REQUEST_TIMEOUT_MS`.

**Caveat to verify during implementation:** `${CLAUDE_PLUGIN_ROOT}` is the assumed path the harness exposes to plugin processes. If current Claude Code plugin conventions differ, adjust to match documented practice and update this spec.

## Plugin Layout

```
claude-qwen-router/
├── plugin.json                 # plugin manifest declaring the MCP server
├── README.md                   # installation, configuration, usage
├── config.example.json         # documented config template
├── .gitignore                  # ignores config.json so users don't commit their LAN URL
├── package.json                # @modelcontextprotocol/sdk, zod
├── tsconfig.json
├── src/
│   ├── server.ts               # MCP server entry, registers qwen_implement
│   ├── config.ts               # config file + env var loading & validation
│   ├── qwen-client.ts          # HTTP client for the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM)
│   ├── prompt.ts               # assembles system + user messages, applies output_format directive
│   └── tokens.ts               # bytes/4 heuristic
└── tests/
    ├── config.test.ts
    ├── prompt.test.ts
    └── tokens.test.ts
```

`plugin.json` declares the MCP server entry point so Claude Code spawns it on session start. Communication is stdio (standard MCP transport).

**Distribution:** GitHub repo. Users install via Claude Code's plugin install flow (specific command to verify during implementation). README covers:

1. Prerequisites: the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) running with a Qwen-class coder model loaded; Node.js installed
2. Install command
3. Copy `config.example.json` to `config.json`, edit `baseUrl` and `model`
4. Restart Claude Code
5. Verify with a test prompt

## Workflow (How a User Uses It)

1. User asks Claude Code: "Add a `parseConfig` function to `src/config.ts` that validates against this schema."
2. Opus plans the change.
3. Opus reads `src/config.ts` and any related files using its existing Read tool. Claude Code's permission system gates these reads as it normally does.
4. Opus assembles a prompt containing the instruction, the file contents, and any running context (e.g., "we already added the schema in the previous step").
5. Opus calls `qwen_implement(prompt=<assembled>, output_format="code")`.
6. The MCP server relays the prompt to the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) over HTTP and returns Qwen's text.
7. Opus parses Qwen's response and applies the resulting writes using its own Edit/Write tools.
8. Opus optionally dispatches a Sonnet subagent via the Task tool to review the changes.
9. Opus reports back to the user.

**Cost model:** No Anthropic API spend beyond what Max already covers. Opus and Sonnet calls are billed under the user's Max subscription. Qwen calls are local/free.

**Trade-off accepted:** When Opus needs Qwen to see N files, Opus reads all N into its own context first. This costs Opus tokens (covered by Max). It's the price of keeping the plugin filesystem-free and trusting Claude Code's existing permission system rather than building a second one.

## Fallback Behavior

Qwen can fail mid-task: LAN hiccup, the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) crashed, model not loaded, timeout, etc. Without a fallback, multi-step work loses progress every time. With a careless fallback, broken Qwen goes unnoticed and the user silently pays full Opus context for everything.

The plugin's MCP server itself does not implement fallback — it has no way to call Opus. Fallback is a **behavioral rule** for the orchestrator (Opus) when `qwen_implement` returns a tool error.

**Rule (loud automatic fallback):**

1. When `qwen_implement` returns an error, Opus announces it explicitly to the user, in plain language. Example:
   > "Qwen timed out after 5 min on this step. Falling back to handling it myself."
2. Opus then performs the implementation step using its own tools (Read/Edit/Write), so progress is preserved.
3. Opus continues with the next step. The next step still tries Qwen first; the fallback is per-call, not per-session.

**Consecutive-failure escalation:**

After **two consecutive** `qwen_implement` failures within the same session, Opus pauses on the third failure instead of falling back automatically:

> "Qwen has failed three times in a row (errors: X, Y, Z). This usually means the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) isn't reachable or the model isn't loaded. Want me to keep going with Opus-only, or pause so you can check?"

The counter resets after a successful Qwen call.

**Where this rule lives:** README documents it as the expected workflow. Plugin code does not enforce it (it cannot — only Opus can decide what to do when a tool errors). This is trusting the orchestrator, same as the existing "Opus reads files" boundary.

## Failure Modes

| Failure | How it surfaces |
|---|---|
| Config missing required keys at startup | MCP server fails to start; Claude Code surfaces the failure in session startup output |
| `baseUrl` unreachable | Tool error: `"Cannot reach the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) at <url>: <network error>"` |
| the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM) returns 4xx/5xx | Tool error with status code and response body |
| Model name doesn't match a loaded model | the local OpenAI-compatible server (llama.cpp / LM Studio / Ollama / vLLM)'s own 4xx error bubbles up via the path above |
| Request times out | Tool error: `"Qwen request timed out after <N>s"` |
| Prompt exceeds `tokenBudget` | Tool error with the estimated size |
| Qwen returns garbled or non-code output | Not the tool's problem. Returns whatever Qwen returned. Opus evaluates it. |

**Not handled (deliberate):**

- No retries. Transient failures bubble up; Opus decides whether to retry.
- No streaming. One request, one response.
- No response caching.
- No real tokenizer. The `bytes/4` heuristic is a guard, not an accountant.
- No multi-turn session state.
- No prompt/response logging to disk. (May be reconsidered post-v1 if debugging warrants it; not in v1 scope.)

## Security

**Filesystem:** Plugin has none. The MCP server cannot read user files. All file access goes through Opus's existing Claude Code tools, which are subject to Claude Code's existing permission prompts.

**Network:** the upstream server over LAN HTTP is plaintext by default. The plugin supports HTTPS URLs and bearer auth via `apiKey`, but does not enforce them. README documents this: users who don't trust their network should put the upstream server behind a reverse proxy with TLS.

**Secrets in prompts:** If Opus reads a `.env` file (with user permission) and includes its contents in a Qwen prompt, those secrets cross the LAN to the upstream server. This is the user's call, mediated by Claude Code's normal permission flow. The plugin makes no decisions about file content.

**Concurrency:** Most local servers default to single-request handling (e.g. llama.cpp's `--parallel 1`). The plugin makes one request at a time per tool call; it does not assume the upstream supports concurrent requests. README notes this so users don't expect parallelism unless they configure their upstream for it.

## Open Questions for Implementation

These are deferred to the implementation plan, not blockers for this spec:

1. **Exact Claude Code plugin manifest format and install command.** The plugin ecosystem evolves; verify against current docs when writing code.
2. **`CLAUDE_PLUGIN_ROOT` availability.** Confirm the env var name and that it's set when the MCP server starts.
3. **Default system prompt wording.** A short coder persona is fine; tune during implementation based on what produces clean output from Qwen-class models.

## Out of Scope

The previously scaffolded `modelrouter/` Agent SDK app is not the target of this spec. It can be removed or repurposed once the plugin works. The plugin replaces it.
