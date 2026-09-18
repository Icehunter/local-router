# Task Profiles and Tier Declaration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `task` argument to both MCP tools that selects a prompt/sampling profile, and two config fields (`tier`, `tasks`) so each server instance declares which backend it is and which tasks it serves.

**Architecture:** `src/prompt.ts` gains a `TASK_PROFILES` table (system prompt, output directive, wrap default, temperature, maxTokens cap) and few-shot message assembly. `src/config.ts` gains `tier` and `tasks`. `src/server.ts` validates and gates `task`, builds an effective config by spreading sampling overrides onto the loaded config, and derives its published tool schema from `config.tasks`. `src/local-client.ts` is unchanged — it already reads sampling from the config object it is handed.

**Tech Stack:** TypeScript (strict, ESM), zod for config validation, `@modelcontextprotocol/sdk`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-local-router-task-profiles-design.md`

## Global Constraints

- ESM only, TypeScript strict mode. All relative imports use `.js` extensions (`./prompt.js`, not `./prompt`).
- Source in `src/`, tests in `tests/`. Vitest. Run with `npx vitest run`.
- Config fields are camelCase; wire fields sent upstream are snake_case. Translation lives in `local-client.ts` only.
- Env-var branches test `!== undefined`, never truthiness.
- Test env isolation uses explicit `delete` in `beforeEach` and add/restore in `afterEach`. Never `process.env = { ...origEnv }`.
- TDD: write the failing test, run it, see it fail, then implement, then see it pass.
- Atomic commits, one logical change per commit.
- **Commit locally only. Do not push.**
- Precedence rule, applied to every resolved value: **explicit argument > task profile > config / tool default.**
- Omitting `task` must reproduce current behaviour exactly. No existing test may need editing.
- After all tasks: `npm run build` is required before the plugin runs, and Claude Code sessions must restart to pick up new `dist/`.

---

### Task 1: Task profiles in `src/prompt.ts`

**Files:**
- Modify: `src/prompt.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const TASKS: readonly ["implement","fix","review","summarize","extract","explain","classify"]`
  - `export type Task = (typeof TASKS)[number]`
  - `export interface FewShotExample { input: string; output: string }`
  - `export interface TaskProfile { system: string; directive: string; wrap: boolean; temperature?: number; maxTokens?: number }`
  - `export const TASK_PROFILES: Record<Task, TaskProfile>`
  - `buildMessages(input: { prompt: string; system?: string; output_format?: OutputFormat; task?: Task; examples?: FewShotExample[] }): ChatMessage[]`

- [ ] **Step 1: Write the failing tests**

`tests/prompt.test.ts` already imports `buildMessages` and `DEFAULT_SYSTEM_PROMPT`. Extend
that existing import statement rather than adding a second one — a duplicate import of the
same binding is a typecheck error:

```ts
import {
  buildMessages,
  DEFAULT_SYSTEM_PROMPT,
  REVIEW_REMINDER,
  wrapWithReviewReminder,
  TASKS,
  TASK_PROFILES,
} from "../src/prompt.js";
```

Then append to the same file:

```ts
describe("task profiles", () => {
  it("defines a profile for every task", () => {
    for (const task of TASKS) {
      expect(TASK_PROFILES[task]).toBeDefined();
      expect(TASK_PROFILES[task].system.length).toBeGreaterThan(0);
      expect(TASK_PROFILES[task].directive.length).toBeGreaterThan(0);
    }
  });

  it("wraps only implement and fix", () => {
    const wrapping = TASKS.filter((t) => TASK_PROFILES[t].wrap);
    expect(wrapping).toEqual(["implement", "fix"]);
  });

  it("caps output on the short-output tasks only", () => {
    expect(TASK_PROFILES.review.maxTokens).toBe(1500);
    expect(TASK_PROFILES.summarize.maxTokens).toBe(1000);
    expect(TASK_PROFILES.extract.maxTokens).toBe(1000);
    expect(TASK_PROFILES.classify.maxTokens).toBe(50);
    expect(TASK_PROFILES.implement.maxTokens).toBeUndefined();
    expect(TASK_PROFILES.fix.maxTokens).toBeUndefined();
    expect(TASK_PROFILES.explain.maxTokens).toBeUndefined();
  });

  it("sets deterministic temperatures on the extraction-like tasks", () => {
    expect(TASK_PROFILES.implement.temperature).toBe(0.2);
    expect(TASK_PROFILES.fix.temperature).toBe(0.1);
    expect(TASK_PROFILES.review.temperature).toBe(0.2);
    expect(TASK_PROFILES.summarize.temperature).toBe(0);
    expect(TASK_PROFILES.extract.temperature).toBe(0);
    expect(TASK_PROFILES.explain.temperature).toBe(0.6);
    expect(TASK_PROFILES.classify.temperature).toBe(0);
  });

  it("implement reuses the default persona and code directive verbatim", () => {
    expect(TASK_PROFILES.implement.system).toBe(DEFAULT_SYSTEM_PROMPT);
    const withTask = buildMessages({ prompt: "p", task: "implement" });
    const without = buildMessages({ prompt: "p" });
    expect(withTask).toEqual(without);
  });
});

describe("buildMessages with a task", () => {
  it("uses the profile system prompt", () => {
    const m = buildMessages({ prompt: "x", task: "summarize" });
    expect(m[0].content).toBe(TASK_PROFILES.summarize.system);
  });

  it("uses the profile directive", () => {
    const m = buildMessages({ prompt: "x", task: "extract" });
    expect(m[m.length - 1].content).toContain(TASK_PROFILES.extract.directive);
  });

  it("explicit system beats the profile system prompt", () => {
    const m = buildMessages({ prompt: "x", task: "review", system: "be terse" });
    expect(m[0].content).toBe("be terse");
  });

  it("explicit output_format beats the profile directive", () => {
    const m = buildMessages({ prompt: "x", task: "review", output_format: "diff" });
    const user = m[m.length - 1].content;
    expect(user).toContain("Return a unified diff");
    expect(user).not.toContain(TASK_PROFILES.review.directive);
  });

  it("with no task, output is byte-identical to the legacy two-message form", () => {
    const m = buildMessages({ prompt: "write hello" });
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ role: "system", content: DEFAULT_SYSTEM_PROMPT });
    expect(m[1].content).toBe(
      "write hello\n\n---\n\nReturn only code. No prose, no fences unless syntactically required by the language.",
    );
  });

  it("renders examples as alternating user/assistant pairs between system and final user", () => {
    const m = buildMessages({
      prompt: "final input",
      task: "classify",
      examples: [
        { input: "a", output: "TRIVIAL" },
        { input: "b", output: "NONTRIVIAL" },
      ],
    });
    expect(m.map((x) => x.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(m[1].content).toBe("a");
    expect(m[2].content).toBe("TRIVIAL");
    expect(m[3].content).toBe("b");
    expect(m[4].content).toBe("NONTRIVIAL");
    expect(m[5].content).toContain("final input");
  });

  it("does not add example turns when examples is absent", () => {
    const m = buildMessages({ prompt: "x", task: "classify" });
    expect(m).toHaveLength(2);
  });

  it("review directive demands the NONE sentinel", () => {
    expect(TASK_PROFILES.review.directive).toContain("NONE");
    expect(TASK_PROFILES.extract.directive).toContain("NONE");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — `TASKS` and `TASK_PROFILES` are not exported from `../src/prompt.js`.

- [ ] **Step 3: Add the types and the profile table**

In `src/prompt.ts`, after the existing `FORMAT_DIRECTIVES` constant, add:

```ts
export const TASKS = [
  "implement",
  "fix",
  "review",
  "summarize",
  "extract",
  "explain",
  "classify",
] as const;

export type Task = (typeof TASKS)[number];

export interface FewShotExample {
  input: string;
  output: string;
}

export interface TaskProfile {
  system: string;
  /** Used in place of FORMAT_DIRECTIVES when the caller sends no output_format. */
  directive: string;
  wrap: boolean;
  temperature?: number;
  /** Only ever lowers config.maxTokens; never raises it. */
  maxTokens?: number;
}

export const TASK_PROFILES: Record<Task, TaskProfile> = {
  implement: {
    system: DEFAULT_SYSTEM_PROMPT,
    directive: FORMAT_DIRECTIVES.code,
    wrap: true,
    temperature: 0.2,
  },
  fix: {
    system:
      "You are a careful debugging assistant. You are given code and a description of how it fails. " +
      "Make the smallest change that makes it correct. " +
      "Do not restructure code that is not implicated in the failure. " +
      "Do not rename, reformat, or add features. " +
      "Do not add defensive checks for conditions the report does not mention. " +
      "Follow the conventions visible in the code you were shown. " +
      "If the cause of the failure is not present in what you were shown, name the file or symbol " +
      "you would need to see and change nothing.",
    directive:
      "Return only the corrected code, complete enough to replace what you were shown. " +
      "No prose, no explanation, no summary of what you changed.",
    wrap: true,
    temperature: 0.1,
  },
  review: {
    system:
      "You are a mechanical-defect reviewer. Report only defects you can point at a specific line for: " +
      "missing or wrong imports, syntax errors, undefined or misspelled symbols, unhandled null or undefined, " +
      "off-by-one and boundary errors, mismatches between a call and the signature it calls, " +
      "and unreachable or duplicated code. " +
      "Do not comment on architecture, naming, style, performance, or test strategy. " +
      "Do not propose rewrites. Do not write replacement code. " +
      "Do not give a verdict on whether the change should be applied — that decision belongs to the caller. " +
      "If you find no defects, output exactly NONE and nothing else.",
    directive:
      "One finding per line, in the form `path:line | severity | what is wrong`, " +
      "where severity is one of high, medium, low. " +
      "No preamble, no summary, no closing remark. " +
      "If there are no findings, output exactly `NONE`.",
    wrap: false,
    temperature: 0.2,
    maxTokens: 1500,
  },
  summarize: {
    system:
      "You are a compression assistant. You restate the input in fewer words. " +
      "Keep every distinct fact, name, number, path and error string. " +
      "Drop repetition, narration, filler, and anything that restates a fact already kept. " +
      "Merge items that say the same thing into one line. " +
      "Do not add information that is not in the input. " +
      "Do not interpret, rank, recommend, or draw conclusions.",
    directive:
      "Output the summary only. No preamble, no heading, no closing remark. " +
      "Do not exceed the line or item count the prompt asks for; if it asks for none, use at most 10 lines.",
    wrap: false,
    temperature: 0,
    maxTokens: 1000,
  },
  extract: {
    system:
      "You are an extraction assistant. You return exactly the items the prompt asks you to find, " +
      "copied from the input verbatim. " +
      "You do not summarize, describe, group, count, or comment on them. " +
      "You do not return items that are not in the input.",
    directive:
      "One item per line. No numbering, no bullets, no headers, no counts, no commentary, no blank lines. " +
      "If there are no matching items, output exactly `NONE`.",
    wrap: false,
    temperature: 0,
    maxTokens: 1000,
  },
  explain: {
    system:
      "You are a technical explainer. Your reader can read code fluently but has not seen this code before. " +
      "Explain what it does, how the pieces fit together, and why it is shaped the way it is " +
      "where the shape is not obvious. " +
      "Ground every claim in the code you were shown; where the reason for something is not visible " +
      "in that code, say so rather than inventing a rationale. " +
      "Do not review, critique, or suggest changes.",
    directive: "Prose. Be concise. No preamble, no closing summary.",
    wrap: false,
    temperature: 0.6,
  },
  classify: {
    system:
      "You are a classifier. The conversation above contains labelled examples. " +
      "Assign the user's final input exactly one label from the label set those examples demonstrate. " +
      "Never use a label that does not appear in the examples. " +
      "Output the label alone, with no explanation, no punctuation, and no surrounding text. " +
      "If the input fits none of the demonstrated labels well, output the closest one — " +
      "do not invent a new label.",
    directive: "Output the label alone. Nothing else.",
    wrap: false,
    temperature: 0,
    maxTokens: 50,
  },
};
```

- [ ] **Step 4: Extend `buildMessages`**

In `src/prompt.ts`, replace the `BuildMessagesInput` interface and the `buildMessages` function with:

```ts
export interface BuildMessagesInput {
  prompt: string;
  system?: string;
  output_format?: OutputFormat;
  task?: Task;
  examples?: FewShotExample[];
}

export function buildMessages(input: BuildMessagesInput): ChatMessage[] {
  const profile = input.task ? TASK_PROFILES[input.task] : undefined;
  const system = input.system ?? profile?.system ?? DEFAULT_SYSTEM_PROMPT;
  // Explicit argument > task profile > "code". Reading output_format directly
  // rather than defaulting it first is what lets the profile win over the default.
  const directive =
    input.output_format !== undefined
      ? FORMAT_DIRECTIVES[input.output_format]
      : (profile?.directive ?? FORMAT_DIRECTIVES.code);

  const messages: ChatMessage[] = [{ role: "system", content: system }];
  // Few-shot pairs go in as real turns rather than inlined text: the chat
  // template exists for exactly this, and the model follows it far more reliably.
  for (const example of input.examples ?? []) {
    messages.push({ role: "user", content: example.input });
    messages.push({ role: "assistant", content: example.output });
  }
  messages.push({ role: "user", content: `${input.prompt}\n\n---\n\n${directive}` });
  return messages;
}
```

Note: `BuildMessagesInput` and `buildMessages` must be declared after `TASK_PROFILES` and `FORMAT_DIRECTIVES`, or move `TASK_PROFILES` above them. `const` declarations are not hoisted.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/prompt.test.ts`
Expected: PASS, including every pre-existing test in the file unchanged.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat: task profiles and few-shot message assembly in prompt.ts"
```

---

### Task 2: `tier` and `tasks` config fields

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `TASKS`, `Task` from `src/prompt.js` (Task 1).
- Produces: `Config` gains `tier: string | null` and `tasks: Task[] | null`. Env vars `LOCAL_LLM_TIER` and `LOCAL_LLM_TASKS`.

- [ ] **Step 1: Write the failing tests**

Add to the `beforeEach` env-clearing block in `tests/config.test.ts`:

```ts
  delete process.env.LOCAL_LLM_TIER;
  delete process.env.LOCAL_LLM_TASKS;
```

Then append:

```ts
describe("tier and tasks", () => {
  function writeBase(extra: Record<string, unknown> = {}) {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://1.2.3.4:1234", model: "m", ...extra }),
    );
  }

  it("defaults both to null, meaning undeclared and all tasks allowed", () => {
    writeBase();
    const cfg = loadConfig();
    expect(cfg.tier).toBeNull();
    expect(cfg.tasks).toBeNull();
  });

  it("reads tier and tasks from config.json", () => {
    writeBase({ tier: "helper", tasks: ["summarize", "extract"] });
    const cfg = loadConfig();
    expect(cfg.tier).toBe("helper");
    expect(cfg.tasks).toEqual(["summarize", "extract"]);
  });

  it("reads tier and tasks from env, overriding the file", () => {
    writeBase({ tier: "coder", tasks: ["implement"] });
    process.env.LOCAL_LLM_TIER = "helper";
    process.env.LOCAL_LLM_TASKS = "summarize,extract";
    const cfg = loadConfig();
    expect(cfg.tier).toBe("helper");
    expect(cfg.tasks).toEqual(["summarize", "extract"]);
  });

  it("tolerates whitespace around comma-separated tasks", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = " summarize , extract ,explain ";
    expect(loadConfig().tasks).toEqual(["summarize", "extract", "explain"]);
  });

  it("rejects an unknown task name in the env list and names the valid ones", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = "summarize,transpile";
    expect(() => loadConfig()).toThrow(/unknown task\(s\): transpile/);
    expect(() => loadConfig()).toThrow(/implement, fix, review, summarize, extract, explain, classify/);
  });

  it("rejects an unknown task name in config.json", () => {
    writeBase({ tasks: ["summarize", "transpile"] });
    expect(() => loadConfig()).toThrow(/tasks/);
  });

  it("rejects an empty tasks array", () => {
    writeBase({ tasks: [] });
    expect(() => loadConfig()).toThrow(/tasks/);
  });

  it("rejects an env task list that is only separators", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = " , , ";
    expect(() => loadConfig()).toThrow(/must list at least one task/);
  });

  it("rejects an empty tier string", () => {
    writeBase({ tier: "" });
    expect(() => loadConfig()).toThrow(/tier/);
  });

  it("does not warn about the new env vars as unrecognized", () => {
    writeBase();
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.env.LOCAL_LLM_TIER = "coder";
    process.env.LOCAL_LLM_TASKS = "implement";
    loadConfig();
    const output = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/LOCAL_LLM_TIER/);
    expect(output).not.toMatch(/LOCAL_LLM_TASKS/);
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.tier` is `undefined`, not `null`.

- [ ] **Step 3: Add the schema fields**

In `src/config.ts`, add the import at the top (after the zod import):

```ts
import { TASKS } from "./prompt.js";
import type { Task } from "./prompt.js";
```

Add to `ConfigSchema`, after `toolDescription`:

```ts
  // Descriptive only — gating is driven entirely by `tasks`, so this stays a
  // free-form string rather than an enum: a third kind of backend should not
  // require a config migration.
  tier: z.string().min(1).nullable().default(null),
  // null = this instance accepts every task. A list makes the published `task`
  // enum smaller, so a disallowed task is unreachable rather than merely rejected.
  tasks: z.array(z.enum(TASKS)).nonempty().nullable().default(null),
```

Add to the `RawConfig` interface:

```ts
  tier?: unknown;
  tasks?: unknown;
```

- [ ] **Step 4: Add env plumbing**

In `src/config.ts`, add after `booleanEnv`:

```ts
/**
 * Comma-separated so a single `.mcp.json` env string can express the list.
 * An unknown name is a hard error rather than a warning: silently dropping it
 * would widen the allowlist, which is the failure direction that matters.
 */
function taskListEnv(name: string): Task[] | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) {
    throw new Error(`${name} must list at least one task, got: "${raw}"`);
  }
  const unknown = parts.filter((p) => !(TASKS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `${name} contains unknown task(s): ${unknown.join(", ")}. ` +
        `Valid tasks: ${TASKS.join(", ")}.`,
    );
  }
  return parts as Task[];
}
```

In `applyEnvOverrides`, add before the `apiKey` block:

```ts
  const tier = envValue("LOCAL_LLM_TIER");
  if (tier !== undefined) out.tier = tier;

  const tasks = taskListEnv("LOCAL_LLM_TASKS");
  if (tasks !== undefined) out.tasks = tasks;
```

In `KNOWN_ENV_VARS`, add:

```ts
  "LOCAL_LLM_TIER",
  "LOCAL_LLM_TASKS",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, all pre-existing tests included.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0. `tests/server.test.ts` will fail to typecheck if `baseConfig` is missing the new required fields — add `tier: null,` and `tasks: null,` to the `baseConfig` literal in `tests/server.test.ts` and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/server.test.ts
git commit -m "feat: tier and tasks config fields with env plumbing"
```

---

### Task 3: `task` and `examples` handling in `handleToolCall`

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `TASKS`, `TASK_PROFILES`, `Task`, `TaskProfile`, `FewShotExample` from `src/prompt.js` (Task 1); `Config.tier`, `Config.tasks` from `src/config.js` (Task 2).
- Produces: `shouldWrapOutput(toolName: string, args: ToolArgs, profile?: TaskProfile): boolean` — third parameter optional, so existing two-argument calls keep working.

- [ ] **Step 1: Write the failing tests**

Append to `tests/server.test.ts`:

```ts
describe("handleToolCall — task validation and gating", () => {
  it("rejects an unknown task and names the valid ones", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "transpile" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`task` must be one of/);
    expect(err.message).toMatch(/implement, fix, review, summarize, extract, explain, classify/);
  });

  it("allows every task when config.tasks is null", async () => {
    mockUpstream("ok");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "implement" }, baseConfig);
    expect(res.content[0].text).toBe("ok");
  });

  it("rejects a task this instance does not accept, naming tier and the accepted list", async () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "implement" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'Task "implement" is not accepted by this instance (tier: helper). ' +
        "Accepted tasks: summarize, extract. " +
        "Route this task to the instance configured for it.",
    );
  });

  it("omits the tier clause when no tier is declared", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "implement" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/not accepted by this instance\. Accepted tasks: summarize\./);
  });

  it("rejects an unknown argument name as before, now including task in the valid list", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", taks: "fix" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Unrecognized argument\(s\): taks/);
    expect(err.message).toMatch(/task/);
    expect(err.message).toMatch(/examples/);
  });
});

describe("handleToolCall — classify examples", () => {
  const twoExamples = [
    { input: "rename a variable", output: "TRIVIAL" },
    { input: "rewrite the scheduler", output: "NONTRIVIAL" },
  ];

  it("rejects classify with no examples", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "classify" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`examples` is required when task is "classify"/);
    expect(err.message).toMatch(/same label for every input/);
  });

  it("rejects classify with fewer than two examples", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", task: "classify", examples: [twoExamples[0]] }, baseConfig,
    )).rejects.toThrow(/at least 2 entries/);
  });

  it("rejects examples on a non-classify task", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", task: "summarize", examples: twoExamples }, baseConfig,
    )).rejects.toThrow(/only valid with task "classify"; got task "summarize"/);
  });

  it("rejects examples with no task at all", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", examples: twoExamples }, baseConfig,
    )).rejects.toThrow(/only valid with task "classify"; got task \(none\)/);
  });

  it("rejects a malformed example entry without echoing an unbounded value", async () => {
    const err = (await handleToolCall(
      "local_direct",
      { prompt: "x", task: "classify", examples: [{ input: "a", output: "" }, { input: "b".repeat(5000), output: "B" }] },
      baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`examples\[0\]` must be an object with non-empty string/);
    expect(err.message.length).toBeLessThan(400);
  });

  it("sends the examples upstream as alternating turns", async () => {
    const fetchSpy = mockUpstream("TRIVIAL");
    await handleToolCall(
      "local_direct", { prompt: "add a log line", task: "classify", examples: twoExamples }, baseConfig,
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "system", "user", "assistant", "user", "assistant", "user",
    ]);
  });
});

describe("handleToolCall — task sampling overrides", () => {
  it("sends the profile temperature instead of the config temperature", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "summarize" }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.temperature).toBe(0);
  });

  it("sends the config temperature when there is no task", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.temperature).toBe(0.7);
  });

  it("lowers max_tokens to the profile cap", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "classify" }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(50);
  });

  it("never raises max_tokens above the configured ceiling", async () => {
    const cfg: Config = { ...baseConfig, maxTokens: 20 };
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "review" }, cfg);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(20);
  });

  it("reserves only the effective maxTokens in the budget precondition", async () => {
    // 1200 budget: the 16000 config ceiling would reject this, the 50 cap does not.
    const cfg: Config = { ...baseConfig, tokenBudget: 1200, maxTokens: 1000 };
    mockUpstream("TRIVIAL");
    const res = await handleToolCall(
      "local_direct",
      { prompt: "x", task: "classify", examples: [
        { input: "a", output: "A" }, { input: "b", output: "B" },
      ] },
      cfg,
    );
    expect(res.content[0].text).toBe("TRIVIAL");
  });

  it("names the effective maxTokens in the truncation warning", async () => {
    mockUpstream("cut off", "length");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "classify", examples: [
      { input: "a", output: "A" }, { input: "b", output: "B" },
    ] }, baseConfig);
    expect(res.content[0].text).toMatch(/stopped at max_tokens \(50\)/);
  });
});

describe("handleToolCall — task wrapping defaults", () => {
  it("wraps a fix on local_direct because the profile says so", async () => {
    mockUpstream("code");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "fix" }, baseConfig);
    expect(res.content[0].text).toContain("<local_output");
  });

  it("does not wrap a review on local_implement because the profile says so", async () => {
    mockUpstream("NONE");
    const res = await handleToolCall("local_implement", { prompt: "x", task: "review" }, baseConfig);
    expect(res.content[0].text).toBe("NONE");
  });

  it("mode still outranks the profile", async () => {
    mockUpstream("NONE");
    const res = await handleToolCall(
      "local_implement", { prompt: "x", task: "review", mode: "delegate" }, baseConfig);
    expect(res.content[0].text).toContain("<local_output");
  });

  it("include_review_reminder still outranks everything", async () => {
    mockUpstream("code");
    const res = await handleToolCall(
      "local_direct",
      { prompt: "x", task: "fix", mode: "delegate", include_review_reminder: false },
      baseConfig,
    );
    expect(res.content[0].text).toBe("code");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — the first failure is `Unrecognized argument(s): task`.

- [ ] **Step 3: Implement validation, gating and effective config**

In `src/server.ts`, update the imports:

```ts
import { buildMessages, wrapWithReviewReminder, TASKS, TASK_PROFILES } from "./prompt.js";
import type { OutputFormat, Task, TaskProfile, FewShotExample } from "./prompt.js";
```

Extend `ToolArgs` and `KNOWN_ARGS`:

```ts
type ToolArgs = {
  prompt?: unknown;
  system?: unknown;
  output_format?: unknown;
  mode?: unknown;
  include_review_reminder?: unknown;
  task?: unknown;
  examples?: unknown;
};

const KNOWN_ARGS = new Set([
  "prompt", "system", "output_format", "mode", "include_review_reminder",
  "task", "examples",
]);

const EXAMPLES_REQUIRED =
  '`examples` is required when task is "classify" and must contain at least 2 entries. ' +
  "Without examples this model returns the same label for every input.";
```

Replace `shouldWrapOutput` with:

```ts
export function shouldWrapOutput(
  toolName: string,
  args: ToolArgs,
  profile?: TaskProfile,
): boolean {
  if (typeof args.include_review_reminder === "boolean") {
    return args.include_review_reminder;
  }
  if (args.mode === "direct") return false;
  if (args.mode === "delegate") return true;
  if (profile !== undefined) return profile.wrap;
  return toolName === TOOL_IMPLEMENT;
}
```

In `handleToolCall`, after the existing `output_format` validation block and before `buildMessages`, insert:

```ts
  let task: Task | undefined;
  if (args.task !== undefined) {
    if (typeof args.task !== "string" || !(TASKS as readonly string[]).includes(args.task)) {
      throw new Error(
        `\`task\` must be one of ${TASKS.join(", ")}; got: ${short(args.task)}`,
      );
    }
    task = args.task as Task;
    if (config.tasks !== null && !config.tasks.includes(task)) {
      throw new Error(
        `Task "${task}" is not accepted by this instance` +
          (config.tier !== null ? ` (tier: ${config.tier})` : "") +
          `. Accepted tasks: ${config.tasks.join(", ")}. ` +
          `Route this task to the instance configured for it.`,
      );
    }
  }

  let examples: FewShotExample[] | undefined;
  if (args.examples !== undefined) {
    if (task !== "classify") {
      throw new Error(
        `\`examples\` is only valid with task "classify"; got task ` +
          `${task !== undefined ? `"${task}"` : "(none)"}.`,
      );
    }
    if (!Array.isArray(args.examples) || args.examples.length < 2) {
      throw new Error(EXAMPLES_REQUIRED);
    }
    args.examples.forEach((ex: unknown, i: number) => {
      const e = ex as Partial<FewShotExample>;
      if (
        ex === null || typeof ex !== "object" || Array.isArray(ex) ||
        typeof e.input !== "string" || e.input.trim() === "" ||
        typeof e.output !== "string" || e.output.trim() === ""
      ) {
        throw new Error(
          `\`examples[${i}]\` must be an object with non-empty string \`input\` and ` +
            `\`output\`; got: ${short(ex)}`,
        );
      }
    });
    examples = args.examples as FewShotExample[];
  }
  // Checked after the shape validation so a caller sending one malformed example
  // gets the specific complaint rather than the generic "required" message.
  if (task === "classify" && examples === undefined) {
    throw new Error(EXAMPLES_REQUIRED);
  }

  const profile = task !== undefined ? TASK_PROFILES[task] : undefined;
  // A spread copy rather than extra parameters: local-client.ts already reads
  // every sampling value off the config object it is handed.
  const effectiveConfig: Config = {
    ...config,
    temperature: profile?.temperature ?? config.temperature,
    maxTokens: Math.min(profile?.maxTokens ?? config.maxTokens, config.maxTokens),
  };
```

Then replace the remainder of the function body (from `const messages = ...` to the `return`) with:

```ts
  const messages = buildMessages({ prompt: args.prompt, system, output_format, task, examples });
  const totalText = messages.map((m) => m.content).join("\n");
  const estimated = estimateTokens(totalText);
  if (estimated + effectiveConfig.maxTokens > effectiveConfig.tokenBudget) {
    throw new Error(
      `Prompt exceeds tokenBudget: estimated ${estimated} prompt tokens + ${effectiveConfig.maxTokens} ` +
        `reserved for the response = ${estimated + effectiveConfig.maxTokens}, over the budget of ${effectiveConfig.tokenBudget}. ` +
        `Reduce scope, lower maxTokens, or raise tokenBudget in config.`,
    );
  }

  const result = await callLocalModel(messages, effectiveConfig, signal);
  const body = shouldWrapOutput(toolName, args, profile)
    ? wrapWithReviewReminder(result.content)
    : result.content;
  const text =
    result.finishReason === "length"
      ? `${body}\n\n[local-router] WARNING: the local model stopped at max_tokens ` +
        `(${effectiveConfig.maxTokens}), so the output above is cut off mid-generation. ` +
        `Raise maxTokens or narrow the request before applying it.`
      : body;
  return { content: [{ type: "text", text }] };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npm run typecheck && npx vitest run`
Expected: exit 0, all files passing.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: task validation, gating, examples and per-task sampling"
```

---

### Task 4: Config-derived tool definitions

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `Config.tasks`, `Config.tier`, `Config.toolDescription`; `TASKS` from `src/prompt.js`.
- Produces: `buildToolDefinitions(config: Config): Array<{ name: string; description: string; inputSchema: object }>` — used by the `ListToolsRequestSchema` handler in `main()`.

- [ ] **Step 1: Write the failing tests**

Add `buildToolDefinitions` to the import at the top of `tests/server.test.ts`, then append:

```ts
describe("buildToolDefinitions", () => {
  // `properties` is typed Record<string, unknown>, so strict mode rejects a bare
  // `.minItems` on a member. Both helpers cast once, here, rather than at each use.
  function prop(tool: { inputSchema: Record<string, any> }, name: string): any {
    return tool.inputSchema.properties[name];
  }
  function taskEnum(tool: { inputSchema: Record<string, any> }): string[] {
    return prop(tool, "task").enum;
  }

  it("publishes every task when config.tasks is null", () => {
    const [implement, direct] = buildToolDefinitions(baseConfig);
    expect(taskEnum(implement)).toEqual([
      "implement", "fix", "review", "summarize", "extract", "explain", "classify",
    ]);
    expect(taskEnum(direct)).toEqual(taskEnum(implement));
  });

  it("publishes only the allowed tasks", () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const [implement] = buildToolDefinitions(cfg);
    expect(taskEnum(implement)).toEqual(["summarize", "extract"]);
  });

  it("omits the examples property when classify is not allowed", () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const [implement] = buildToolDefinitions(cfg);
    expect(prop(implement, "examples")).toBeUndefined();
  });

  it("includes the examples property when classify is allowed", () => {
    const cfg: Config = { ...baseConfig, tasks: ["classify"] };
    const [implement] = buildToolDefinitions(cfg);
    expect(prop(implement, "examples").minItems).toBe(2);
  });

  it("appends the tier line to both descriptions", () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const [implement, direct] = buildToolDefinitions(cfg);
    expect(implement.description).toContain("Tier: helper. Accepts: summarize, extract.");
    expect(direct.description).toContain("Tier: helper. Accepts: summarize, extract.");
  });

  it("appends no tier line when neither tier nor tasks is declared", () => {
    const [implement] = buildToolDefinitions(baseConfig);
    expect(implement.description).not.toContain("Tier:");
    expect(implement.description).not.toContain("Accepts:");
  });

  it("still carries the toolDescription suffix ahead of the tier line", () => {
    const cfg: Config = { ...baseConfig, toolDescription: "the 4B box", tier: "helper" };
    const [implement] = buildToolDefinitions(cfg);
    expect(implement.description).toMatch(/THIS INSTANCE: the 4B box.*Tier: helper\./s);
  });

  it("keeps the two tool names stable", () => {
    const [implement, direct] = buildToolDefinitions(baseConfig);
    expect(implement.name).toBe("local_implement");
    expect(direct.name).toBe("local_direct");
  });
});

describe("ListTools wiring", () => {
  it("serves the config-derived definitions, not the static constants", async () => {
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/tools:\s*buildToolDefinitions\(config\)/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `buildToolDefinitions` is not exported from `../src/server.js`.

- [ ] **Step 3: Implement the builder**

In `src/server.ts`, rename the existing `TOOL_INPUT_SCHEMA` constant to `BASE_TOOL_PROPERTIES` and reduce it to just the properties object (drop the `type`/`required` wrapper):

```ts
const BASE_TOOL_PROPERTIES = {
  prompt: {
    type: "string",
    description:
      "Complete user-message text to send. Include any file contents, instructions, and running context here.",
  },
  system: {
    type: "string",
    description:
      "Optional system message override. Outranks the task profile's system prompt.",
  },
  output_format: {
    type: "string",
    enum: ["code", "diff", "explanation"],
    description:
      "Format directive appended to the prompt. Outranks the task profile's directive. Default 'code'.",
  },
  mode: {
    type: "string",
    enum: ["delegate", "direct"],
    description:
      "delegate wraps output for Claude review; direct returns raw local-model output.",
  },
  include_review_reminder: {
    type: "boolean",
    description:
      "Override whether to wrap output in <local_output> and append the review reminder.",
  },
};
```

Remove `inputSchema` from `IMPLEMENT_TOOL_DEFINITION` and `DIRECT_TOOL_DEFINITION`, leaving each as `{ name, description }`.

Add:

```ts
const EXAMPLES_PROPERTY = {
  type: "array",
  minItems: 2,
  items: {
    type: "object",
    properties: {
      input: { type: "string" },
      output: { type: "string" },
    },
    required: ["input", "output"],
  },
  description:
    'Few-shot label examples, sent as alternating user/assistant turns. Required when task is "classify", rejected with any other task.',
};

/**
 * Built per-config rather than as a constant so the published `task` enum lists
 * only what this instance serves: a disallowed task becomes unreachable instead
 * of being rejected after the caller has already committed to the call.
 */
export function buildToolDefinitions(config: Config) {
  const allowed: readonly Task[] = config.tasks ?? TASKS;
  const properties: Record<string, unknown> = {
    ...BASE_TOOL_PROPERTIES,
    task: {
      type: "string",
      enum: [...allowed],
      description:
        "Task profile. Sets the system prompt, output directive, review wrapping and sampling. " +
        "Omit for the legacy code-generation default.",
    },
  };
  if (allowed.includes("classify")) {
    properties.examples = EXAMPLES_PROPERTY;
  }
  const inputSchema = { type: "object", properties, required: ["prompt"] };

  const tierLine =
    config.tier !== null || config.tasks !== null
      ? ` Tier: ${config.tier ?? "unspecified"}. Accepts: ${allowed.join(", ")}.`
      : "";

  return [IMPLEMENT_TOOL_DEFINITION, DIRECT_TOOL_DEFINITION].map((tool) => {
    const withRole = withRoleDescription(tool, config.toolDescription);
    return { ...withRole, description: withRole.description + tierLine, inputSchema };
  });
}
```

In `main()`, replace the ListTools handler body with:

```ts
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(config),
  }));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, and a real build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: exit 0 on all three.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: derive published tool schema from the instance's task allowlist"
```

---

### Task 5: Documentation and configuration examples

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `.mcp.json`
- Modify: `config.example.json`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no code.

- [ ] **Step 1: Add the two env passthroughs to `.mcp.json`**

Inside the `env` block, after `"LOCAL_LLM_ENABLE_THINKING"`, add:

```json
        "LOCAL_LLM_TIER": "${LOCAL_LLM_TIER:-}",
        "LOCAL_LLM_TASKS": "${LOCAL_LLM_TASKS:-}"
```

Move the existing trailing comma onto the `LOCAL_LLM_ENABLE_THINKING` line so the JSON stays valid.

- [ ] **Step 2: Add the fields to `config.example.json`**

Add:

```json
  "tier": "coder",
  "tasks": ["implement", "fix", "review", "explain"]
```

- [ ] **Step 3: Document the task table in `README.md`**

Add a `### Tasks` section after the tool list, containing:

```markdown
Both tools accept an optional `task` argument that selects a prompt and sampling profile.
Omitting it reproduces the plugin's original code-generation behaviour.

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

Precedence for every setting is **explicit argument > task profile > config default**.
An output cap only ever lowers `maxTokens`; it never raises it.
```

Add `tier` and `tasks` rows to the existing config key table:

```markdown
| `tier` | no | `null` | Free-form label for this instance, e.g. `coder` or `helper`. Appears in the tool description. Does no gating. |
| `tasks` | no | `null` | Tasks this instance accepts. `null` means all of them. The published `task` enum lists only these, so a disallowed task is unreachable. Also settable as `LOCAL_LLM_TASKS=summarize,extract`. |
```

- [ ] **Step 4: Update `CLAUDE.md`**

Replace this line under **Out of scope**:

```
- Adding a `local_review` tool (intentionally deferred — review belongs to the caller's configured review path)
```

with:

```
- A standalone `local_review` tool. Superseded by `task: "review"`, which is deliberately
  narrowed to mechanical defects (missing imports, syntax, undefined symbols, boundary
  errors) and never returns a verdict on whether to apply a change. Its output is never
  wrapped in `<local_output>`, so it cannot be mistaken for code. It feeds into the
  caller's configured review path rather than replacing it.
```

Add a `### Tasks` subsection under **Routing policy** listing the same seven tasks and which tier each belongs to:

```markdown
### Tasks

Both tools take an optional `task`. Coder tier serves `implement`, `fix`, `review`,
`explain`; helper tier serves `summarize`, `extract`, `explain`, `classify`. Each
instance declares its own list in `tasks`, and the published `task` enum reflects it.

`classify` requires at least two `examples` — this is the measured few-shot requirement
from the table above, now enforced by the schema rather than by prose.
```

- [ ] **Step 5: Verify the JSON files still parse**

Run: `node -e "JSON.parse(require('fs').readFileSync('.mcp.json','utf8')); JSON.parse(require('fs').readFileSync('config.example.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 6: Run the whole suite and build one more time**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add README.md CLAUDE.md .mcp.json config.example.json
git commit -m "docs: task profiles, tier declaration, and the review-scope reversal"
```

---

## After the plan

`dist/` is gitignored, so anyone running the server needs `npm run build` after pulling,
and Claude Code sessions must restart to load the new compiled code.

Do not push. Commits stay local until explicitly asked.
