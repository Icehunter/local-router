# Claude Qwen Router Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Node floor updated 2026-09-17.** This plan was written against Node 20, which
> reached end of life on 2026-04-30. The three references below now read 22, the
> oldest release still supported, matching `engines` in `package.json`. Nothing else
> in this document has been restated after the fact.

**Goal:** Ship a distributable Claude Code plugin that exposes a local OpenAI-compatible LLM (Qwen on llama.cpp / LM Studio / Ollama / vLLM) as an MCP tool named `qwen_implement`, so Claude Code (running on Max) can delegate code-generation work to a free local model while planning and review stay on Claude.

**Architecture:** Claude Code plugin (`.claude-plugin/plugin.json` + `.mcp.json`) ships a Node-based stdio MCP server. The server has zero filesystem access; it just relays prompt strings to the upstream `/v1/chat/completions` endpoint and returns the response. Config lives in `${CLAUDE_PLUGIN_ROOT}/config.json` with env-var overrides.

**Tech Stack:** TypeScript (ESM, Node 22+), `@modelcontextprotocol/sdk` for MCP server, `zod` for config validation, native `fetch` for HTTP, `vitest` for tests. No build step at runtime — TS is compiled to `dist/` and shipped, so the plugin runs `node dist/server.js`.

---

## File Structure

```
claude-qwen-router/
├── .claude-plugin/
│   └── plugin.json               # plugin manifest (name, description, version)
├── .mcp.json                     # MCP server declaration
├── .gitignore
├── README.md                     # install + config + usage + fallback rule
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── config.example.json           # documented config template
├── src/
│   ├── server.ts                 # MCP server entry + qwen_implement tool registration
│   ├── config.ts                 # config file + env loading + zod validation
│   ├── qwen-client.ts            # POST /v1/chat/completions, parse response
│   ├── prompt.ts                 # build messages array, apply output_format directive
│   └── tokens.ts                 # bytes/4 heuristic + budget check
├── tests/
│   ├── config.test.ts
│   ├── prompt.test.ts
│   ├── tokens.test.ts
│   └── qwen-client.test.ts       # uses fetch mock
└── dist/                          # gitignored at dev time, shipped via release/install
```

**File responsibilities:**

- `tokens.ts` — pure function `estimateTokens(text: string): number` returning `Math.ceil(byteLength(text) / 4)`. One responsibility, easy to test.
- `prompt.ts` — pure function `buildMessages({prompt, system?, output_format}): {role, content}[]`. Knows the default coder system prompt and how to append the format directive. No I/O.
- `config.ts` — `loadConfig(): Config`. Reads `${CLAUDE_PLUGIN_ROOT}/config.json` if present, layers env vars on top, validates via zod, exits with a clear error if invalid.
- `qwen-client.ts` — `callQwen(messages, config): Promise<string>`. Builds request, handles HTTP errors, timeouts, returns assistant text. Uses native `fetch` + `AbortController`.
- `server.ts` — wires the MCP SDK, registers `qwen_implement`, calls `tokens` → `prompt` → `qwen-client`, surfaces errors as MCP tool errors. Top-level glue, minimal logic.

---

## Task 1: Initialize plugin repo

**Files:**
- Create: `claude-qwen-router/.gitignore`
- Create: `claude-qwen-router/package.json`
- Create: `claude-qwen-router/tsconfig.json`
- Create: `claude-qwen-router/vitest.config.ts`

- [ ] **Step 1: Create the project directory and `cd` into it**

```bash
mkdir -p /Volumes/Engineering/Icehunter/claude-qwen-router
cd /Volumes/Engineering/Icehunter/claude-qwen-router
git init
```

Expected: Empty git repo at the new path.

- [ ] **Step 2: Write `.gitignore`**

Create `.gitignore`:

```
node_modules/
dist/
config.json
*.log
.DS_Store
.vitest/
coverage/
```

Note: `config.json` is ignored so users don't accidentally commit their LAN URL. `config.example.json` is committed.

- [ ] **Step 3: Write `package.json`**

Create `package.json`:

```json
{
  "name": "claude-qwen-router",
  "version": "0.1.0",
  "description": "Claude Code plugin that routes implementation work to a local OpenAI-compatible LLM (Qwen, etc.) over the LAN.",
  "type": "module",
  "private": false,
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 4: Write `tsconfig.json`**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 5: Write `vitest.config.ts`**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 6: Install deps and verify**

```bash
npm install
npm run typecheck
```

Expected: `npm install` completes, `tsc --noEmit` runs successfully (no source files yet, so it passes trivially).

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: initialize plugin repo with TypeScript + vitest setup"
```

---

## Task 2: Token estimator (TDD)

**Files:**
- Create: `tests/tokens.test.ts`
- Create: `src/tokens.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { estimateTokens, isOverBudget } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses bytes/4 heuristic, ceiling rounded", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 bytes / 4 = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 bytes / 4 = 1.25 → 2
  });

  it("counts bytes, not chars (multi-byte safe)", () => {
    // "✓" is 3 bytes in UTF-8
    expect(estimateTokens("✓")).toBe(1); // 3 bytes / 4 = 0.75 → 1
  });
});

describe("isOverBudget", () => {
  it("returns false when at or under budget", () => {
    expect(isOverBudget("abcd", 1)).toBe(false);
  });

  it("returns true when over budget", () => {
    expect(isOverBudget("abcde", 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tokens`
Expected: FAIL — module `../src/tokens.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/tokens.ts`:

```ts
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 4);
}

export function isOverBudget(text: string, budget: number): boolean {
  return estimateTokens(text) > budget;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tokens`
Expected: PASS, all 5 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/tokens.ts tests/tokens.test.ts
git commit -m "feat: token estimator using bytes/4 heuristic"
```

---

## Task 3: Prompt builder (TDD)

**Files:**
- Create: `tests/prompt.test.ts`
- Create: `src/prompt.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMessages, DEFAULT_SYSTEM_PROMPT } from "../src/prompt.js";

describe("buildMessages", () => {
  it("uses default system prompt when none provided", () => {
    const messages = buildMessages({ prompt: "write hello" });
    expect(messages[0]).toEqual({
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
    });
  });

  it("uses provided system prompt when given", () => {
    const messages = buildMessages({ prompt: "x", system: "custom system" });
    expect(messages[0].content).toBe("custom system");
  });

  it("appends 'code' format directive by default", () => {
    const messages = buildMessages({ prompt: "write a fn" });
    const user = messages[1].content;
    expect(user).toContain("write a fn");
    expect(user).toContain("Return only code");
  });

  it("appends 'diff' format directive when output_format='diff'", () => {
    const messages = buildMessages({ prompt: "fix bug", output_format: "diff" });
    expect(messages[1].content).toContain("Return a unified diff");
  });

  it("appends 'explanation' format directive when output_format='explanation'", () => {
    const messages = buildMessages({ prompt: "explain x", output_format: "explanation" });
    expect(messages[1].content).toContain("Explain in prose");
  });

  it("returns exactly two messages, system then user", () => {
    const messages = buildMessages({ prompt: "x" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- prompt`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/prompt.ts`:

```ts
export type OutputFormat = "code" | "diff" | "explanation";

export interface BuildMessagesInput {
  prompt: string;
  system?: string;
  output_format?: OutputFormat;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a careful, focused code-generation assistant. " +
  "You produce correct, minimal, well-structured code. " +
  "You follow the conventions visible in any code the user shows you. " +
  "You do not invent APIs you have not seen. " +
  "If the request is ambiguous, you state your assumption briefly and proceed.";

const FORMAT_DIRECTIVES: Record<OutputFormat, string> = {
  code: "Return only code. No prose, no fences unless syntactically required by the language.",
  diff: "Return a unified diff. Use `--- a/path` and `+++ b/path` headers. No prose.",
  explanation: "Explain in prose. Be concise.",
};

export function buildMessages(input: BuildMessagesInput): ChatMessage[] {
  const system = input.system ?? DEFAULT_SYSTEM_PROMPT;
  const format = input.output_format ?? "code";
  const directive = FORMAT_DIRECTIVES[format];
  const userContent = `${input.prompt}\n\n---\n\n${directive}`;
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- prompt`
Expected: PASS, all 6 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts tests/prompt.test.ts
git commit -m "feat: prompt builder with default coder system prompt and format directives"
```

---

## Task 4: Config loader with zod validation (TDD)

**Files:**
- Create: `tests/config.test.ts`
- Create: `src/config.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tempDir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qwen-cfg-"));
  process.env.CLAUDE_PLUGIN_ROOT = tempDir;
  delete process.env.QWEN_BASE_URL;
  delete process.env.QWEN_MODEL;
  delete process.env.QWEN_API_KEY;
  delete process.env.QWEN_TOKEN_BUDGET;
  delete process.env.QWEN_REQUEST_TIMEOUT_MS;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...origEnv };
});

describe("loadConfig", () => {
  it("loads config.json when present", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        baseUrl: "http://1.2.3.4:1234",
        model: "qwen3-coder",
      }),
    );
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://1.2.3.4:1234");
    expect(cfg.model).toBe("qwen3-coder");
    expect(cfg.tokenBudget).toBe(180000); // default
    expect(cfg.requestTimeoutMs).toBe(300000); // default
    expect(cfg.apiKey).toBeNull();
  });

  it("env vars override config file", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://file:1234", model: "file-model" }),
    );
    process.env.QWEN_BASE_URL = "http://env:1234";
    process.env.QWEN_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("works with env vars only (no config file)", () => {
    process.env.QWEN_BASE_URL = "http://env:1234";
    process.env.QWEN_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("strips trailing slash from baseUrl", () => {
    process.env.QWEN_BASE_URL = "http://host:1234/";
    process.env.QWEN_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://host:1234");
  });

  it("throws clearly when baseUrl is missing", () => {
    process.env.QWEN_MODEL = "m";
    expect(() => loadConfig()).toThrow(/baseUrl/);
  });

  it("throws clearly when model is missing", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    expect(() => loadConfig()).toThrow(/model/);
  });

  it("parses numeric env vars", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TOKEN_BUDGET = "100000";
    process.env.QWEN_REQUEST_TIMEOUT_MS = "60000";
    const cfg = loadConfig();
    expect(cfg.tokenBudget).toBe(100000);
    expect(cfg.requestTimeoutMs).toBe(60000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/config.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  model: z.string().min(1),
  apiKey: z.string().nullable().default(null),
  tokenBudget: z.number().int().positive().default(180000),
  requestTimeoutMs: z.number().int().positive().default(300000),
});

export type Config = z.infer<typeof ConfigSchema>;

interface RawConfig {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  tokenBudget?: unknown;
  requestTimeoutMs?: unknown;
}

function readConfigFile(): RawConfig {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return {};
  const path = join(root, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${(err as Error).message}`,
    );
  }
}

function applyEnvOverrides(raw: RawConfig): RawConfig {
  const out: RawConfig = { ...raw };
  if (process.env.QWEN_BASE_URL) out.baseUrl = process.env.QWEN_BASE_URL;
  if (process.env.QWEN_MODEL) out.model = process.env.QWEN_MODEL;
  if (process.env.QWEN_API_KEY) out.apiKey = process.env.QWEN_API_KEY;
  if (process.env.QWEN_TOKEN_BUDGET) {
    out.tokenBudget = Number(process.env.QWEN_TOKEN_BUDGET);
  }
  if (process.env.QWEN_REQUEST_TIMEOUT_MS) {
    out.requestTimeoutMs = Number(process.env.QWEN_REQUEST_TIMEOUT_MS);
  }
  return out;
}

export function loadConfig(): Config {
  const merged = applyEnvOverrides(readConfigFile());
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid Qwen plugin config:\n${issues}\n\n` +
        `Set baseUrl and model via config.json (\${CLAUDE_PLUGIN_ROOT}/config.json) or env vars QWEN_BASE_URL and QWEN_MODEL.`,
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS, all 7 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config loader with file + env vars + zod validation"
```

---

## Task 5: Qwen HTTP client (TDD)

**Files:**
- Create: `tests/qwen-client.test.ts`
- Create: `src/qwen-client.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/qwen-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callQwen } from "../src/qwen-client.js";
import type { Config } from "../src/config.js";

const baseConfig: Config = {
  baseUrl: "http://test-host:1234",
  model: "test-model",
  apiKey: null,
  tokenBudget: 180000,
  requestTimeoutMs: 5000,
};

const ok = (text: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("callQwen", () => {
  it("POSTs to /v1/chat/completions with the configured model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("hi"));
    await callQwen(
      [{ role: "user", content: "say hi" }],
      baseConfig,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://test-host:1234/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
    expect(body.max_tokens).toBe(16000);
  });

  it("includes Authorization header when apiKey is set", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callQwen(
      [{ role: "user", content: "x" }],
      { ...baseConfig, apiKey: "sk-secret" },
    );
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret");
  });

  it("omits Authorization header when apiKey is null", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callQwen([{ role: "user", content: "x" }], baseConfig);
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns the assistant message text on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("the answer is 42"));
    const result = await callQwen([{ role: "user", content: "x" }], baseConfig);
    expect(result).toBe("the answer is 42");
  });

  it("throws on non-2xx with status and body in message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("model not found", { status: 404 }),
    );
    await expect(
      callQwen([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/404.*model not found/);
  });

  it("throws a clear error when the network fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    await expect(
      callQwen([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/Cannot reach.*test-host:1234.*ECONNREFUSED/);
  });

  it("throws a timeout error when the request takes too long", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      callQwen(
        [{ role: "user", content: "x" }],
        { ...baseConfig, requestTimeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it("throws when response shape is unexpected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      callQwen([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/Unexpected response/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- qwen-client`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/qwen-client.ts`:

```ts
import type { Config } from "./config.js";
import type { ChatMessage } from "./prompt.js";

const MAX_TOKENS = 16000;

export async function callQwen(
  messages: ChatMessage[],
  config: Config,
): Promise<string> {
  const url = `${config.baseUrl}/v1/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Qwen request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
      );
    }
    throw new Error(
      `Cannot reach upstream at ${config.baseUrl}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Upstream returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Unexpected response from upstream (no choices[0].message.content): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return content;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- qwen-client`
Expected: PASS, all 8 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/qwen-client.ts tests/qwen-client.test.ts
git commit -m "feat: qwen HTTP client with timeout and clear error surfaces"
```

---

## Task 6: MCP server entry point

**Files:**
- Create: `src/server.ts`

This task wires the MCP SDK and registers `qwen_implement`. It composes the units we built (config, prompt, tokens, qwen-client). No new logic, just glue.

- [ ] **Step 1: Read MCP SDK quickstart to confirm current API surface**

Run: `ls node_modules/@modelcontextprotocol/sdk/dist/`

Expected: directory listing showing the SDK's compiled output.

Then check the SDK's README for the current stdio server registration pattern:

Run: `cat node_modules/@modelcontextprotocol/sdk/README.md | head -200`

Expected: documentation showing `Server` class and `setRequestHandler` for `tools/list` and `tools/call`. (If the SDK API has shifted, adjust the implementation in step 2 to match — the structure below assumes the v1.x stable API.)

- [ ] **Step 2: Write the server**

Create `src/server.ts`:

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { buildMessages } from "./prompt.js";
import type { OutputFormat } from "./prompt.js";
import { callQwen } from "./qwen-client.js";
import { estimateTokens } from "./tokens.js";

const TOOL_NAME = "qwen_implement";

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Send a fully-assembled prompt to the local Qwen model and return its response. " +
    "Use for code generation. Caller is responsible for assembling file contents and instruction into the prompt string. " +
    "The plugin has no filesystem access.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Complete user-message text to send. Include any file contents, instructions, and running context here.",
      },
      system: {
        type: "string",
        description:
          "Optional system message override. Default is a baked-in coder persona.",
      },
      output_format: {
        type: "string",
        enum: ["code", "diff", "explanation"],
        description:
          "Format directive appended to the prompt. Default 'code'.",
      },
    },
    required: ["prompt"],
  },
};

async function main(): Promise<void> {
  // Fail fast if config is invalid; the error message tells the user how to fix it.
  const config = loadConfig();

  const server = new Server(
    { name: "claude-qwen-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [TOOL_DEFINITION],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_NAME) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    const args = req.params.arguments as {
      prompt?: unknown;
      system?: unknown;
      output_format?: unknown;
    };
    if (typeof args.prompt !== "string" || args.prompt.length === 0) {
      throw new Error("`prompt` is required and must be a non-empty string");
    }
    const system = typeof args.system === "string" ? args.system : undefined;
    const output_format =
      args.output_format === "diff" ||
      args.output_format === "explanation" ||
      args.output_format === "code"
        ? (args.output_format as OutputFormat)
        : undefined;

    const messages = buildMessages({ prompt: args.prompt, system, output_format });
    const totalText = messages.map((m) => m.content).join("\n");
    const estimated = estimateTokens(totalText);
    if (estimated > config.tokenBudget) {
      throw new Error(
        `Prompt exceeds tokenBudget (estimated ${estimated} tokens, budget ${config.tokenBudget}). ` +
          `Reduce scope or raise tokenBudget in config.`,
      );
    }

    const text = await callQwen(messages, config);
    return {
      content: [{ type: "text", text }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // MCP servers communicate over stdout; errors must go to stderr.
  process.stderr.write(`[claude-qwen-router] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: Build and run a smoke test**

```bash
npm run build
ls dist/
```

Expected: `dist/server.js`, `dist/config.js`, etc.

Then verify the binary at least starts up and complains about missing config (since `CLAUDE_PLUGIN_ROOT` is unset in this shell):

```bash
unset QWEN_BASE_URL QWEN_MODEL CLAUDE_PLUGIN_ROOT
node dist/server.js
```

Expected: process exits with stderr message like `[claude-qwen-router] fatal: Invalid Qwen plugin config: ...`. This proves the fail-fast path works.

Then verify it boots when given valid config:

```bash
QWEN_BASE_URL=http://localhost:9999 QWEN_MODEL=test node dist/server.js
```

Expected: process hangs (it's a stdio server waiting for input). Send EOF with `Ctrl+D` to exit. No errors before EOF.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: MCP server registering qwen_implement tool"
```

---

## Task 7: Plugin manifest, MCP server declaration, and example config

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`
- Create: `config.example.json`

- [ ] **Step 1: Write the plugin manifest**

Create `.claude-plugin/plugin.json`:

```json
{
  "name": "claude-qwen-router",
  "description": "Route implementation work to a local OpenAI-compatible LLM (Qwen on llama.cpp / LM Studio / Ollama / vLLM) so Claude Code can delegate code-writing while planning and review stay on Claude.",
  "version": "0.1.0"
}
```

- [ ] **Step 2: Write the MCP server declaration**

Create `.mcp.json`:

```json
{
  "mcpServers": {
    "qwen-router": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]
    }
  }
}
```

- [ ] **Step 3: Write the example config**

Create `config.example.json`:

```json
{
  "baseUrl": "http://192.168.1.50:1234",
  "model": "qwen3-coder",
  "apiKey": null,
  "tokenBudget": 180000,
  "requestTimeoutMs": 300000
}
```

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .mcp.json config.example.json
git commit -m "feat: plugin manifest, MCP declaration, example config"
```

---

## Task 8: README

**Files:**
- Create: `README.md`

The README is the user's only path to correct setup. Make it complete.

- [ ] **Step 1: Write the README**

Create `README.md`:

````markdown
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
- Node.js 22+ on the machine running Claude Code
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

Or install from a git URL via the `/plugin` UI's Discover tab. (Exact command depends on your marketplace setup. See [Claude Code plugin docs](https://code.claude.com/docs/en/plugins.md).)

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
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with install, config, fallback behavior, troubleshooting"
```

---

## Task 9: End-to-end smoke test (manual, with real upstream)

**Files:** none (manual verification)

This task verifies the whole thing works against a real local server. If you don't have one running, skip and document this as TODO.

- [ ] **Step 1: Start your local server**

Per your llama.cpp config, on the LAN box:

```bat
.\llama-server.exe ^
  -m <path-to-model> ^
  --gpu-layers 99 ^
  --ctx-size 200000 ^
  --host 0.0.0.0 ^
  --port 1234 ^
  --alias qwen3-coder
```

- [ ] **Step 2: Verify reachability from laptop**

```bash
curl http://<lan-ip>:1234/v1/models
```

Expected: JSON listing models, with one having id `qwen3-coder`.

- [ ] **Step 3: Run the MCP server directly with a hand-crafted JSON-RPC message**

```bash
cd /Volumes/Engineering/Icehunter/claude-qwen-router
QWEN_BASE_URL=http://<lan-ip>:1234 QWEN_MODEL=qwen3-coder \
  node dist/server.js < <(printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"qwen_implement","arguments":{"prompt":"Write a Python one-liner that prints the numbers 1 to 10."}}}')
```

Expected: two JSON-RPC responses on stdout. The first lists `qwen_implement`. The second returns Qwen's text output, something like `print(*range(1, 11))`.

- [ ] **Step 4: Install and test inside Claude Code**

In a fresh Claude Code session, with the plugin installed:

> "Use qwen_implement to write a Python one-liner that prints 1 to 10."

Expected: Claude calls the tool and reports back Qwen's output. If it doesn't, check Claude Code's MCP startup logs for errors.

- [ ] **Step 5: Test the fallback behavior**

Stop your local server. In Claude Code:

> "Use qwen_implement to write a hello-world function."

Expected: Claude calls the tool, gets a "Cannot reach upstream" error, announces the fallback, writes the function itself.

- [ ] **Step 6: Commit any fixes discovered**

If E2E surfaced bugs, fix them and commit per-fix. If everything worked:

```bash
git tag v0.1.0
```

---

## Self-review

**Spec coverage check:**

- Architecture: Tasks 6 + 7 (server entry + plugin/MCP manifests) ✓
- `qwen_implement` tool inputs (`prompt`, `system`, `output_format`): Task 6 ✓
- Token budget guard with no auto-pruning: Tasks 2 + 6 ✓
- Config from `config.json` with env overrides: Task 4 ✓
- All 5 env vars: Task 4 (config tests cover the numeric ones, string ones are trivial) ✓
- Plugin layout (`.claude-plugin/`, `.mcp.json`, `config.example.json`): Task 7 ✓
- Failure modes (network, 4xx/5xx, timeout, prompt-too-big, weird response): Task 5 (8 tests) ✓
- README documents fallback rule, concurrency, security: Task 8 ✓
- Single-request concurrency note: Task 8 ✓

**Placeholder scan:** None. Every step has concrete code or commands.

**Type consistency:** `Config` defined in Task 4, used in Task 5 and Task 6. `ChatMessage` and `OutputFormat` defined in Task 3, used in Task 5 and Task 6. `loadConfig`, `buildMessages`, `estimateTokens`, `callQwen` — names match across tasks.

**One thing the plan deliberately defers:** the exact MCP SDK API surface in Task 6 step 1. The SDK is at v1.x and stable, but I want the implementer to confirm the import paths and request schema names against the installed package's README rather than trust this plan's snapshot. Step 1 of that task makes that explicit.

---
