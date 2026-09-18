#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { buildMessages, wrapWithReviewReminder, TASKS, TASK_PROFILES } from "./prompt.js";
import type { OutputFormat, Task, TaskProfile, FewShotExample } from "./prompt.js";
import { callLocalModel } from "./local-client.js";
import { estimateTokens } from "./tokens.js";

const TOOL_IMPLEMENT = "local_implement";
const TOOL_DIRECT = "local_direct";

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

const EXAMPLES_PROPERTY = {
  type: "array",
  minItems: 2,
  maxItems: 50,
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

const IMPLEMENT_TOOL_DEFINITION = {
  name: TOOL_IMPLEMENT,
  description:
    "Send a fully-assembled prompt to the configured local model and return its response. " +
    "Use for code generation. Caller is responsible for assembling file contents and instruction into the prompt string. " +
    "By default this wraps the output in <local_output> and appends a provider-neutral review reminder. " +
    "The MCP server has no filesystem access.",
};

const DIRECT_TOOL_DEFINITION = {
  name: TOOL_DIRECT,
  description:
    "Send a prompt to the configured local model and return its response, by default without review wrapping. " +
    "A task whose profile wraps — implement and fix — still wraps unless you override it with `mode` or `include_review_reminder`. " +
    "Use for direct local mode, explanations, and rate-limit escape-hatch queries.",
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

type ToolArgs = {
  prompt?: unknown;
  system?: unknown;
  output_format?: unknown;
  mode?: unknown;
  include_review_reminder?: unknown;
  task?: unknown;
  examples?: unknown;
};

const OUTPUT_FORMATS: readonly OutputFormat[] = ["code", "diff", "explanation"];
const MODES = ["delegate", "direct"] as const;
const KNOWN_ARGS = new Set([
  "prompt", "system", "output_format", "mode", "include_review_reminder",
  "task", "examples",
]);

const EXAMPLES_REQUIRED =
  '`examples` is required when task is "classify" and must contain at least 2 entries. ' +
  "Without examples this model returns the same label for every input.";

// 3000 examples was accepted before this cap and produced a 6002-message request:
// the token-budget check counts content bytes, not per-message chat-template
// overhead, so many tiny examples slip past it.
const MAX_EXAMPLES = 50;

/** Keeps a hostile or accidental multi-KB argument out of the error response. */
function short(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 120 ? s.slice(0, 120) + '…"' : s;
}

/** Suffixes a tool's description so callers can distinguish two instances. */
export function withRoleDescription<T extends { description: string }>(
  tool: T,
  roleDescription: string | null,
): T {
  if (!roleDescription) return tool;
  return { ...tool, description: `${tool.description} THIS INSTANCE: ${roleDescription}` };
}

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

export async function handleToolCall(
  toolName: string,
  rawArgs: unknown,
  config: Config,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (toolName !== TOOL_IMPLEMENT && toolName !== TOOL_DIRECT) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  const args = (rawArgs ?? {}) as ToolArgs;

  // A misspelled key was silently ignored, which is the same class of bug as the
  // unvalidated `mode`: the caller asks for something and quietly does not get it.
  const unknown = Object.keys(args).filter((k) => !KNOWN_ARGS.has(k)).sort();
  if (unknown.length > 0) {
    // `examples` stays in KNOWN_ARGS regardless of gating, so it is still recognized
    // and gets its own "only valid with classify" error — but listing it as valid
    // advice on an instance whose published schema excludes classify is a dead end.
    const examplesUsable = config.tasks === null || config.tasks.includes("classify");
    const listedArgs = [...KNOWN_ARGS].filter((a) => a !== "examples" || examplesUsable);
    throw new Error(
      `Unrecognized argument(s): ${unknown.join(", ")}. ` +
        `Valid arguments: ${listedArgs.join(", ")}.`,
    );
  }

  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw new Error("`prompt` is required and must be a non-empty string");
  }
  // Unlike include_review_reminder, which deliberately ignores a malformed value,
  // a bad mode silently returns the OPPOSITE wrapping from what was asked for.
  if (args.mode !== undefined && !MODES.includes(args.mode as (typeof MODES)[number])) {
    throw new Error(
      `\`mode\` must be one of ${MODES.join(", ")}; got: ${JSON.stringify(args.mode)}`,
    );
  }
  // Previously any non-string was dropped and the default persona used instead,
  // so a caller passing the wrong type silently got different behaviour.
  if (args.system !== undefined && (typeof args.system !== "string" || args.system.trim() === "")) {
    throw new Error(
      `\`system\` must be a string with content when provided; got: ${short(args.system)}`,
    );
  }
  const system = typeof args.system === "string" ? args.system : undefined;
  let output_format: OutputFormat | undefined;
  if (args.output_format !== undefined) {
    if (!OUTPUT_FORMATS.includes(args.output_format as OutputFormat)) {
      throw new Error(
        `\`output_format\` must be one of ${OUTPUT_FORMATS.join(", ")}; got: ${short(args.output_format)}`,
      );
    }
    output_format = args.output_format as OutputFormat;
  }

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
    if (args.examples.length > MAX_EXAMPLES) {
      throw new Error(
        `\`examples\` accepts at most ${MAX_EXAMPLES} entries; got ${args.examples.length}.`,
      );
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
      // Matches the top-level argument check: a key beyond the two recognized
      // ones is silently dropped otherwise, the same class of bug as an
      // unvalidated `mode`.
      const unknownKeys = Object.keys(ex as object).filter((k) => k !== "input" && k !== "output");
      if (unknownKeys.length > 0) {
        throw new Error(
          `\`examples[${i}]\` has unrecognized key(s): ${unknownKeys.join(", ")}. ` +
            `Only \`input\` and \`output\` are valid; got: ${short(ex)}`,
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
  // Appended outside the wrapper so it reads as the plugin's voice, not the model's.
  const text =
    result.finishReason === "length"
      ? `${body}\n\n[local-router] WARNING: the local model stopped at max_tokens ` +
        `(${effectiveConfig.maxTokens}), so the output above is cut off mid-generation. ` +
        `Raise maxTokens or narrow the request before applying it.`
      : body;
  return { content: [{ type: "text", text }] };
}

/**
 * The SDK's Protocol._onerror is `this.onerror?.(error)` with no fallback, so
 * leaving this unassigned drops inbound deserialization failures, stdin errors
 * and outbound send failures with no trace at all. stderr is safe here: the
 * stdio transport uses only stdin/stdout, and Claude Code captures stderr.
 */
export function logProtocolError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[local-router] protocol error: ${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new Server(
    { name: "local-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.onerror = logProtocolError;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(config),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    handleToolCall(req.params.name, req.params.arguments, config, extra?.signal),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * True only when this file is the process entrypoint, so importing it for tests
 * does not start a transport or exit. Both sides go through realpath because
 * import.meta.url resolves symlinks while process.argv[1] does not — on macOS
 * that alone makes /tmp and /private/tmp compare unequal.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    if (realpathSync(entry) === realpathSync(self)) return true;
  } catch {
    // fall through to the extensionless comparison below
  }
  // A bin shim or symlink can present argv[1] without the .js extension, which
  // silently exited 0 with no output and looked exactly like a crash.
  try {
    return realpathSync(entry + ".js") === realpathSync(self);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err) => {
    process.stderr.write(`[local-router] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
