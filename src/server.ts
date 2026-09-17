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
import { buildMessages, wrapWithReviewReminder } from "./prompt.js";
import type { OutputFormat } from "./prompt.js";
import { callLocalModel } from "./local-client.js";
import { estimateTokens } from "./tokens.js";

const TOOL_IMPLEMENT = "local_implement";
const TOOL_DIRECT = "local_direct";

const TOOL_INPUT_SCHEMA = {
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
  },
  required: ["prompt"],
};

const IMPLEMENT_TOOL_DEFINITION = {
  name: TOOL_IMPLEMENT,
  description:
    "Send a fully-assembled prompt to the configured local model and return its response. " +
    "Use for code generation. Caller is responsible for assembling file contents and instruction into the prompt string. " +
    "By default this wraps the output in <local_output> and appends a provider-neutral review reminder. " +
    "The MCP server has no filesystem access.",
  inputSchema: TOOL_INPUT_SCHEMA,
};

const DIRECT_TOOL_DEFINITION = {
  name: TOOL_DIRECT,
  description:
    "Send a prompt to the configured local model and return the raw response without review wrapping. " +
    "Use for direct local mode, explanations, and rate-limit escape-hatch queries.",
  inputSchema: TOOL_INPUT_SCHEMA,
};

type ToolArgs = {
  prompt?: unknown;
  system?: unknown;
  output_format?: unknown;
  mode?: unknown;
  include_review_reminder?: unknown;
};

const OUTPUT_FORMATS: readonly OutputFormat[] = ["code", "diff", "explanation"];
const MODES = ["delegate", "direct"] as const;
const KNOWN_ARGS = new Set([
  "prompt", "system", "output_format", "mode", "include_review_reminder",
]);

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

export function shouldWrapOutput(toolName: string, args: ToolArgs): boolean {
  if (typeof args.include_review_reminder === "boolean") {
    return args.include_review_reminder;
  }
  if (args.mode === "direct") return false;
  if (args.mode === "delegate") return true;
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
    throw new Error(
      `Unrecognized argument(s): ${unknown.join(", ")}. ` +
        `Valid arguments: ${[...KNOWN_ARGS].join(", ")}.`,
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

  const messages = buildMessages({ prompt: args.prompt, system, output_format });
  const totalText = messages.map((m) => m.content).join("\n");
  const estimated = estimateTokens(totalText);
  if (estimated + config.maxTokens > config.tokenBudget) {
    throw new Error(
      `Prompt exceeds tokenBudget: estimated ${estimated} prompt tokens + ${config.maxTokens} ` +
        `reserved for the response = ${estimated + config.maxTokens}, over the budget of ${config.tokenBudget}. ` +
        `Reduce scope, lower maxTokens, or raise tokenBudget in config.`,
    );
  }

  const result = await callLocalModel(messages, config, signal);
  const body = shouldWrapOutput(toolName, args)
    ? wrapWithReviewReminder(result.content)
    : result.content;
  // Appended outside the wrapper so it reads as the plugin's voice, not the model's.
  const text =
    result.finishReason === "length"
      ? `${body}\n\n[local-router] WARNING: the local model stopped at max_tokens ` +
        `(${config.maxTokens}), so the output above is cut off mid-generation. ` +
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
    tools: [
      withRoleDescription(IMPLEMENT_TOOL_DEFINITION, config.toolDescription),
      withRoleDescription(DIRECT_TOOL_DEFINITION, config.toolDescription),
    ],
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
