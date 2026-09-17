# Task profiles and tier declaration for claude-local-router

Date: 2026-09-17
Status: approved design, not yet implemented

## Problem

The server exposes two tools, `local_implement` and `local_direct`, that differ
only in whether the response is wrapped for review. Every other difference
between jobs — writing code, fixing a failure, compressing a log, extracting
symbols, classifying a task — has to be expressed by the caller hand-writing a
`system` argument and a set of output constraints on each call. In practice the
caller does not do this, so every job runs under one code-generation persona at
one temperature.

Two consequences:

- A summarization or extraction call runs at `temperature` 0.7 under a persona
  that tells the model to write code.
- The measured requirement that classification needs few-shot examples (without
  them the 4B model returns the same label for every input) lives only in prose
  in CLAUDE.md, where it is skipped.

Separately, when two instances of this server run against different backends —
a 27B GPU coder and a 4B CPU helper — nothing in the protocol says which is
which. The only signal is the free-text `toolDescription`, and nothing stops a
caller asking the 4B to implement a feature.

## Solution

Add a `task` argument carrying a **profile**: a system prompt, an output
directive, a wrapping default, and sampling overrides. Add two config fields,
`tier` and `tasks`, so each server instance declares what it is and which tasks
it accepts, and so the published tool schema offers only the tasks that instance
will serve.

Not a router in the dispatching sense: one server process still talks to one
backend. Tier selection remains "call the right MCP server", now with the
instance declaring itself instead of relying on convention.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Task as enum vs one tool per task | **Enum on the existing two tools** | The plumbing is identical per task; only the prompt and sampling differ. N tools means N descriptions in every session's context. |
| Tier exposure | **One server instance per backend**, each declaring `tier` + `tasks` | No new networking, no breaking config change, tool names stay stable, one backend failure cannot take out the other. |
| `review` task | **In, narrowed to mechanical defects** | Reverses the deferral recorded in CLAUDE.md. It feeds into the caller's configured review path rather than replacing it, and its output is never wrapped so it cannot be mistaken for code to apply. |
| Task set | **All seven**, including `classify` with a required `examples` field | Making examples structurally required turns the measured few-shot lesson into something that cannot be skipped. |

## Precedence rule

One rule, applied to every resolved value:

> **explicit argument > task profile > config / tool default**

```
system    = args.system    ?? profile.system    ?? DEFAULT_SYSTEM_PROMPT
directive = FORMAT_DIRECTIVES[args.output_format] ?? profile.directive ?? FORMAT_DIRECTIVES.code
wrap      = args.include_review_reminder ?? modeWrap(args.mode) ?? profile.wrap ?? (tool === local_implement)
temperature = profile.temperature ?? config.temperature
maxTokens   = min(profile.maxTokens ?? Infinity, config.maxTokens)
```

`maxTokens` resolved this way also feeds the token-budget precondition, which
today hardcodes `config.maxTokens` and would otherwise over-reserve on every
capped task.

Sampling overrides reach the client as a spread copy of the config
(`{ ...config, temperature, maxTokens }`). `local-client.ts` does not change.

## Backward compatibility

Omitting `task` reproduces current behaviour exactly: `DEFAULT_SYSTEM_PROMPT`,
the `code` directive, and wrapping determined by tool name and `mode` as today.
`tasks` absent from config means every task is allowed. No existing test changes
meaning.

## Task profiles

```ts
export type Task =
  | "implement" | "fix" | "review"
  | "summarize" | "extract" | "explain" | "classify";

interface TaskProfile {
  system: string;
  directive: string;   // used when output_format is absent
  wrap: boolean;
  temperature?: number;
  maxTokens?: number;  // only ever lowers config.maxTokens
}
```

| task | wrap | temperature | maxTokens cap |
|---|---|---|---|
| `implement` | yes | 0.2 | — |
| `fix` | yes | 0.1 | — |
| `review` | no | 0.2 | 1500 |
| `summarize` | no | 0.0 | 1000 |
| `extract` | no | 0.0 | 1000 |
| `explain` | no | 0.6 | — |
| `classify` | no | 0.0 | 50 |

### implement

Reuses the existing `DEFAULT_SYSTEM_PROMPT` and the existing `code` directive
unchanged, so `task: "implement"` and no task at all differ only in temperature.

System: *You are a careful, focused code-generation assistant. You produce
correct, minimal, well-structured code. You follow the conventions visible in
any code the user shows you. You do not invent APIs you have not seen. If the
request is ambiguous, you state your assumption briefly and proceed.*

Directive: *Return only code. No prose, no fences unless syntactically required
by the language.*

### fix

System: *You are a careful debugging assistant. You are given code and a
description of how it fails. Make the smallest change that makes it correct. Do
not restructure code that is not implicated in the failure. Do not rename,
reformat, or add features. Do not add defensive checks for conditions the report
does not mention. Follow the conventions visible in the code you were shown. If
the cause of the failure is not present in what you were shown, name the file or
symbol you would need to see and change nothing.*

Directive: *Return only the corrected code, complete enough to replace what you
were shown. No prose, no explanation, no summary of what you changed.*

### review

System: *You are a mechanical-defect reviewer. Report only defects you can point
at a specific line for: missing or wrong imports, syntax errors, undefined or
misspelled symbols, unhandled null or undefined, off-by-one and boundary errors,
mismatches between a call and the signature it calls, and unreachable or
duplicated code. Do not comment on architecture, naming, style, performance, or
test strategy. Do not propose rewrites. Do not write replacement code. Do not
give a verdict on whether the change should be applied — that decision belongs
to the caller. If you find no defects, output exactly NONE and nothing else.*

Directive: *One finding per line, in the form `path:line | severity | what is
wrong`, where severity is one of high, medium, low. No preamble, no summary, no
closing remark. If there are no findings, output exactly `NONE`.*

The `NONE` sentinel is load-bearing: without an explicit way to report nothing,
a small model pads the output to look useful.

### summarize

System: *You are a compression assistant. You restate the input in fewer words.
Keep every distinct fact, name, number, path and error string. Drop repetition,
narration, filler, and anything that restates a fact already kept. Merge items
that say the same thing into one line. Do not add information that is not in the
input. Do not interpret, rank, recommend, or draw conclusions.*

Directive: *Output the summary only. No preamble, no heading, no closing remark.
Do not exceed the line or item count the prompt asks for; if it asks for none,
use at most 10 lines.*

### extract

System: *You are an extraction assistant. You return exactly the items the
prompt asks you to find, copied from the input verbatim. You do not summarize,
describe, group, count, or comment on them. You do not return items that are not
in the input.*

Directive: *One item per line. No numbering, no bullets, no headers, no counts,
no commentary, no blank lines. If there are no matching items, output exactly
`NONE`.*

### explain

System: *You are a technical explainer. Your reader can read code fluently but
has not seen this code before. Explain what it does, how the pieces fit
together, and why it is shaped the way it is where the shape is not obvious.
Ground every claim in the code you were shown; where the reason for something is
not visible in that code, say so rather than inventing a rationale. Do not
review, critique, or suggest changes.*

Directive: *Prose. Be concise. No preamble, no closing summary.*

### classify

System: *You are a classifier. The conversation above contains labelled
examples. Assign the user's final input exactly one label from the label set
those examples demonstrate. Never use a label that does not appear in the
examples. Output the label alone, with no explanation, no punctuation, and no
surrounding text. If the input fits none of the demonstrated labels well, output
the closest one — do not invent a new label.*

Directive: *Output the label alone. Nothing else.*

## The `examples` argument

```ts
examples?: Array<{ input: string; output: string }>
```

- Required when `task === "classify"`, minimum 2 entries.
- Rejected when passed with any other task, consistent with the existing
  unknown-argument strictness.
- Rendered as alternating `user` / `assistant` message pairs between the system
  message and the final user message — not inlined into the prompt text. The
  chat template exists for this.

Resulting message sequence for a classify call:

```
system    <classify profile system prompt>
user      examples[0].input
assistant examples[0].output
...
user      <prompt> \n\n---\n\n <directive>
```

Every other task produces the existing two-message sequence.

Error text:

- `` `examples` is required when task is "classify" and must contain at least 2 entries. Without examples this model returns the same label for every input. ``
- `` `examples` is only valid with task "classify"; got task "<task>". ``

## Tier declaration

Two new config fields:

```jsonc
// coder instance
{ "tier": "coder",  "tasks": ["implement", "fix", "review", "explain"] }
// helper instance
{ "tier": "helper", "tasks": ["summarize", "extract", "explain", "classify"] }
```

- `tier`: free-form non-empty string, nullable, default `null`. Purely
  descriptive — it appears in the tool description and does no gating. Kept
  free-form rather than an enum because gating is driven entirely by `tasks`,
  so an enum would add a migration cost for no checking benefit.
- `tasks`: non-empty array of `Task` values, nullable, default `null`.
  `null` means every task is allowed.
- Env: `LOCAL_LLM_TIER`, and `LOCAL_LLM_TASKS` as a comma-separated list. Both
  added to the `.mcp.json` env block following the existing `${VAR:-}` pattern.
  An unknown name in `LOCAL_LLM_TASKS` is a hard error naming the valid values.

### Effect on the published schema

Tool definitions become a function of config rather than module constants:

- The `task` property's `enum` lists only the tasks this instance accepts, so a
  disallowed task is not reachable rather than being rejected at call time.
- The description gains `Tier: helper. Accepts: summarize, extract, explain,
  classify.` appended after the existing `THIS INSTANCE:` suffix.

The runtime check remains as a backstop for a caller that ignores the schema:

- `` Task "implement" is not accepted by this instance (tier: helper). Accepted tasks: summarize, extract, explain, classify. Route this task to the instance configured for it. ``

## Files

| File | Change |
|---|---|
| `src/prompt.ts` | `Task` type, `TASK_PROFILES`, directive precedence, few-shot message assembly |
| `src/config.ts` | `tier` and `tasks` fields, `LOCAL_LLM_TIER` / `LOCAL_LLM_TASKS` env plumbing |
| `src/server.ts` | config-derived tool definitions, `task` / `examples` validation, task gating, effective sampling and budget |
| `src/local-client.ts` | unchanged — receives a spread config copy |
| `tests/prompt.test.ts` | profile and precedence coverage |
| `tests/config.test.ts` | tier/tasks parsing and env coverage |
| `tests/server.test.ts` | schema, gating, validation, budget coverage |
| `README.md` | task table, tier config keys, two-instance example |
| `CLAUDE.md` | replace the `local_review` out-of-scope line with the narrowed-review rationale; add the task/tier table |
| `.mcp.json` | two new env passthroughs |

## Testing

TDD, red before green, per repo convention.

`tests/prompt.test.ts`
- One case per profile asserting system prompt, directive, wrap flag, temperature.
- Explicit `system` beats the profile's system prompt.
- Explicit `output_format` beats the profile's directive.
- No `task` produces today's exact two-message output.
- Few-shot pairs appear in order, between system and the final user message.

`tests/config.test.ts`
- `tier` and `tasks` parse from config.json and from env.
- `LOCAL_LLM_TASKS` comma-splitting, including surrounding whitespace.
- Unknown task name in `tasks` is rejected, error names the valid values.
- `tasks` absent means all tasks allowed.
- Empty `tasks` array is rejected.
- Env isolation via explicit add/restore, never whole-object replacement.

`tests/server.test.ts`
- Published `task` enum equals `config.tasks`, and is the full set when null.
- Tool description carries the tier line.
- Disallowed task produces the backstop error with the exact text above.
- `classify` without `examples` errors; `examples` with a non-classify task errors.
- Profile `maxTokens` cap is used in the budget precondition, not `config.maxTokens`.
- Profile `maxTokens` never raises a lower `config.maxTokens`.
- A call with no `task` is byte-identical to current behaviour.

## Out of scope

- Dispatching between backends from one process. Tier selection stays "call the
  right MCP server".
- Auto-selecting a task when the caller omits one. Omitting `task` keeps the
  legacy path deliberately.
- Per-task `topP` / `topK` / `minP` / `repeatPenalty` overrides. Temperature and
  maxTokens cover the observed need; add others when a measurement calls for it.
- Changing `enableThinking` per task.

## Deviations from the approved outline

`tier` is specified here as a free-form string rather than the
`"coder" | "helper"` enum shown during the design discussion, because it does no
gating — `tasks` does all of it — and an enum would make adding a third kind of
backend a config migration for no checking benefit.
