import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TASKS } from "./prompt.js";
import type { Task } from "./prompt.js";

const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    // Strip a trailing "/v1" from the PATH only: the client appends
    // "/v1/chat/completions". Done via URL so a host like "http://v1" keeps its
    // authority intact — a plain regex on the string would eat it.
    .transform((u) => {
      const url = new URL(u);
      url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      return url.toString().replace(/\/+$/, "");
    }),
  model: z.string().min(1),
  apiKey: z.string().nullable().default(null),
  tokenBudget: z.number().int().positive().default(180000),
  // Capped at 2^31-1: setTimeout silently coerces a larger delay to 1ms, which
  // turns "disable the timeout" into "abort every request instantly".
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(2147483647, {
      message: "must be at most 2147483647 (24.8 days); larger values overflow setTimeout and abort every request after 1ms",
    })
    .default(300000),
  maxTokens: z.number().int().positive().default(16000),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(0.8),
  topK: z.number().int().nonnegative().default(20),
  minP: z.number().min(0).max(1).default(0.05),
  repeatPenalty: z.number().min(0).max(2).default(1.1),
  debugLogPath: z.string().nullable().default(null),
  // null = omit chat_template_kwargs entirely (backend default). Only set this
  // when the model is a reasoning model whose thinking you want to control:
  // with thinking on, a low maxTokens is spent reasoning and the completion
  // comes back empty.
  enableThinking: z.boolean().nullable().default(null),
  // Appended to both tool descriptions. With two instances of this server
  // pointed at different backends, this is the only thing that lets the caller
  // tell a 27B coder from a 0.8B summarizer.
  toolDescription: z.string().nullable().default(null),
  // Descriptive only — gating is driven entirely by `tasks`, so this stays a
  // free-form string rather than an enum: a third kind of backend should not
  // require a config migration.
  tier: z.string().min(1).nullable().default(null),
  // null = this instance accepts every task. A list makes the published `task`
  // enum smaller, so a disallowed task is unreachable rather than merely rejected.
  // Duplicates are rejected rather than silently de-duplicated, matching
  // taskListEnv's stance on an unknown name below: a list that doesn't say what
  // it means is a config bug, not something to paper over. A duplicate here would
  // otherwise reach the published JSON Schema `enum` with a repeated member.
  tasks: z
    .array(z.enum(TASKS))
    .nonempty()
    .refine(
      (arr) => findDuplicates(arr).length === 0,
      (arr) => ({ message: `tasks contains duplicate value(s): ${findDuplicates(arr).join(", ")}` }),
    )
    .nullable()
    .default(null),
});

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

export type Config = z.infer<typeof ConfigSchema>;

interface RawConfig {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  tokenBudget?: unknown;
  requestTimeoutMs?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  topP?: unknown;
  topK?: unknown;
  minP?: unknown;
  repeatPenalty?: unknown;
  debugLogPath?: unknown;
  enableThinking?: unknown;
  toolDescription?: unknown;
  tier?: unknown;
  tasks?: unknown;
}

type ConfigSource =
  | { kind: "loaded"; path: string }
  | { kind: "missing"; path: string }
  | { kind: "no-root" };

/**
 * An unset `${VAR}` with no `:-` default is passed through by the MCP host as
 * this literal text. Numeric vars catch it via the NaN guard, but a free-form
 * string would otherwise accept it: an unexpanded LOCAL_LLM_API_KEY became the
 * literal bearer token `${LOCAL_LLM_API_KEY}`.
 */
const UNEXPANDED_PLACEHOLDER = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:-[\s\S]*)?\}$/;

function assertExpanded(name: string, raw: string): void {
  if (UNEXPANDED_PLACEHOLDER.test(raw.trim())) {
    throw new Error(
      `${name} looks like an unexpanded placeholder: "${raw.trim()}". ` +
        `The variable it refers to is not set. Give it a value, or use a ` +
        `"\${${name}:-}" default so a missing value reads as "not provided".`,
    );
  }
}

/**
 * A declared-but-empty env var means "not provided", so a `.mcp.json` env block
 * can list every setting as `"${LOCAL_LLM_X:-}"` without clobbering config.json.
 */
function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  assertExpanded(name, raw);
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Like envValue, but a declared-and-blank value means "explicitly disabled"
 * rather than "not provided", so it overrides config.json instead of deferring
 * to it. Used for the two optional fields whose absence is meaningful.
 */
function disableableEnv(name: string): string | null | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  assertExpanded(name, raw);
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function numericEnv(name: string): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got: "${raw}"`);
  }
  return n;
}

function booleanEnv(name: string): boolean | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${name} must be true or false, got: "${raw}"`);
}

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

const NUMERIC_ENV_VARS: ReadonlyArray<readonly [keyof RawConfig, string]> = [
  ["tokenBudget", "LOCAL_LLM_TOKEN_BUDGET"],
  ["requestTimeoutMs", "LOCAL_LLM_REQUEST_TIMEOUT_MS"],
  ["maxTokens", "LOCAL_LLM_MAX_TOKENS"],
  ["temperature", "LOCAL_LLM_TEMPERATURE"],
  ["topP", "LOCAL_LLM_TOP_P"],
  ["topK", "LOCAL_LLM_TOP_K"],
  ["minP", "LOCAL_LLM_MIN_P"],
  ["repeatPenalty", "LOCAL_LLM_REPEAT_PENALTY"],
];

function readConfigFile(): { raw: RawConfig; source: ConfigSource } {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return { raw: {}, source: { kind: "no-root" } };
  const path = join(root, "config.json");
  if (!existsSync(path)) return { raw: {}, source: { kind: "missing", path } };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // A directory, a permissions problem or an unreadable device is not a
    // syntax error, and saying "failed to parse" sends the user to the wrong place.
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  // null, arrays and scalars all reach Object.keys() later and would throw a
  // bare TypeError, losing the diagnostic entirely.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${path} must contain a JSON object, got ${Array.isArray(parsed) ? "an array" : parsed === null ? "null" : typeof parsed}.`,
    );
  }

  return { raw: parsed as RawConfig, source: { kind: "loaded", path } };
}

function applyEnvOverrides(raw: RawConfig): RawConfig {
  const out: RawConfig = { ...raw };

  const baseUrl = envValue("LOCAL_LLM_BASE_URL");
  if (baseUrl !== undefined) out.baseUrl = baseUrl;

  const model = envValue("LOCAL_LLM_MODEL");
  if (model !== undefined) out.model = model;

  for (const [key, envVar] of NUMERIC_ENV_VARS) {
    const n = numericEnv(envVar);
    if (n !== undefined) out[key] = n;
  }

  const enableThinking = booleanEnv("LOCAL_LLM_ENABLE_THINKING");
  if (enableThinking !== undefined) out.enableThinking = enableThinking;

  const toolDescription = envValue("LOCAL_LLM_TOOL_DESCRIPTION");
  if (toolDescription !== undefined) out.toolDescription = toolDescription;

  const tier = envValue("LOCAL_LLM_TIER");
  if (tier !== undefined) out.tier = tier;

  const tasks = taskListEnv("LOCAL_LLM_TASKS");
  if (tasks !== undefined) out.tasks = tasks;

  // A blank value here means "explicitly disabled", not "not provided".
  const apiKey = disableableEnv("LOCAL_LLM_API_KEY");
  if (apiKey !== undefined) out.apiKey = apiKey;

  const debugLogPath = disableableEnv("LOCAL_LLM_DEBUG_LOG_PATH");
  if (debugLogPath !== undefined) out.debugLogPath = debugLogPath;

  return out;
}

const KNOWN_KEYS = Object.keys(ConfigSchema.shape);

const KNOWN_ENV_VARS = new Set<string>([
  "LOCAL_LLM_BASE_URL",
  "LOCAL_LLM_MODEL",
  "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_DEBUG_LOG_PATH",
  "LOCAL_LLM_ENABLE_THINKING",
  "LOCAL_LLM_TOOL_DESCRIPTION",
  "LOCAL_LLM_TIER",
  "LOCAL_LLM_TASKS",
  ...NUMERIC_ENV_VARS.map(([, envVar]) => envVar),
]);

/**
 * A typo'd key in config.json already warns; a typo'd env var was silently
 * ignored, which is the harder one to spot because nothing echoes it back.
 */
function warnUnknownEnvVars(): void {
  const unknown = Object.keys(process.env)
    .filter((k) => k.startsWith("LOCAL_LLM_") && !KNOWN_ENV_VARS.has(k))
    .sort();
  if (unknown.length === 0) return;
  process.stderr.write(
    `[local-router] ignoring unrecognized environment variable(s): ${unknown.join(", ")}. ` +
      `Recognized: ${[...KNOWN_ENV_VARS].sort().join(", ")}\n`,
  );
}

/**
 * Warns rather than rejects: config.json outlives any single build, so an older
 * build meeting a newer file's key should keep working. Silently dropping the key
 * is the real problem — a typo'd "max_tokens" left maxTokens at its default with
 * no indication the file had said otherwise.
 */
function warnUnknownKeys(raw: RawConfig, source: ConfigSource): void {
  if (source.kind !== "loaded") return;
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length === 0) return;
  process.stderr.write(
    `[local-router] ignoring unrecognized key(s) in ${source.path}: ${unknown.join(", ")}. ` +
      `Recognized keys: ${KNOWN_KEYS.join(", ")}\n`,
  );
}

function describeSource(source: ConfigSource): string {
  switch (source.kind) {
    case "loaded":
      return `Read config.json from ${source.path}.`;
    case "missing":
      return `No config.json at ${source.path}.`;
    case "no-root":
      return "CLAUDE_PLUGIN_ROOT is not set, so no config.json was read.";
  }
}

export function loadConfig(): Config {
  const { raw, source } = readConfigFile();
  warnUnknownKeys(raw, source);
  warnUnknownEnvVars();
  const result = ConfigSchema.safeParse(applyEnvOverrides(raw));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid local model plugin config:\n${issues}\n\n` +
        `${describeSource(source)}\n` +
        `Set baseUrl and model via the env vars LOCAL_LLM_BASE_URL and LOCAL_LLM_MODEL ` +
        `(these can be declared in the "env" block of your .mcp.json), or in a config.json ` +
        `alongside the plugin with CLAUDE_PLUGIN_ROOT pointing at it.`,
    );
  }
  const config = result.data;
  // Caught here rather than at call time: server.ts rejects a prompt when
  // estimated + maxTokens exceeds tokenBudget, so a maxTokens at or above the
  // budget rejects EVERY prompt while blaming the prompt for being too long.
  if (config.maxTokens >= config.tokenBudget) {
    throw new Error(
      `Invalid local model plugin config:\n` +
        `  - maxTokens (${config.maxTokens}) must be less than tokenBudget (${config.tokenBudget}); ` +
        `otherwise every request is rejected before it is sent.\n\n` +
        `${describeSource(source)}`,
    );
  }
  return config;
}
