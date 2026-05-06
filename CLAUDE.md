# claude-local-router — Workflow

This repo is the home of the `claude-local-router` plugin itself. It also dogfoods its own workflow: when working in this repo, route implementation through the plugin you're building.

## The loop

For any non-trivial code change:

1. **Plan** — read the relevant files yourself, decide the approach. Present it briefly for the user to approve.
2. **Delegate writing** — call `mcp__local-router__local_implement` with the file contents the model needs to see plus the instruction. Get code back as text.
3. **Review** — use the configured review path for this environment. If a Task/subagent tool is available, use the configured review or planning model to check the local model output against:
   - the requirements from step 1
   - the project conventions in this file and the README
   - obvious bugs / missing imports / syntax errors
4. **Apply** — write the result to disk yourself with Edit/Write.
5. **Loop** if review surfaces issues — go back to step 2 with the feedback baked into the prompt, or fix it yourself if it's small.

## When to skip the loop

- Trivial one-line edits, typo fixes, file moves, config tweaks
- Anything where assembling a local model prompt costs more time than just doing it
- Edits to this `CLAUDE.md` file itself
- README/docs work where local model has no context advantage
- Tasks the user explicitly tells you to do directly

## Fallback behavior (local model errors)

If `local_implement` errors (network down, model not loaded, timeout, etc.):

1. Announce the failure out loud to the user — don't hide it.
   > "local model timed out. Falling back to handling this step myself."
2. Do the step yourself.
3. The next step still tries local model first; per-call fallback, not per-session.

After **two consecutive** failures, pause on the third and ask:
> "local model has failed three times in a row. Want me to keep going without delegation or pause so you can check the upstream?"

The counter resets after a successful local model call.

## Repo conventions

- ESM only, TypeScript strict mode
- ESM imports use `.js` extensions
- Tests in `tests/`, source in `src/`. Vitest.
- Camel-case in `Config`, snake-case on the wire (translation in `local-client.ts`)
- Numeric env-var branches use `if (process.env.LOCAL_LLM_X !== undefined)` — never truthy check
- NaN guard pattern: `if (!Number.isFinite(n)) throw new Error(\`LOCAL_LLM_X must be a number, got: "${raw}"\`)`
- Test env isolation uses explicit add/restore, never `process.env = { ...origEnv }`
- TDD when feasible: tests first, verify red, then implementation, verify green
- Atomic commits, one logical change per commit

## After source changes

`dist/` is committed-out (gitignored). Anyone running the server needs to `npm run build` after pulling, and Claude Code sessions need to restart to pick up the new compiled code.

## Out of scope

- Adding a `local_review` tool (intentionally deferred — review belongs to the caller's configured review path)
- `enable_thinking` flag (deferred until A/B testing shows it helps)
- Streaming, retries, response caching, multi-turn session state — see spec for rationale
