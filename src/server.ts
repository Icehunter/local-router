#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, writesEnabled } from "./config.js";
import type { Config } from "./config.js";
import { buildMessages, wrapWithReviewReminder, TASKS, TASK_PROFILES, buildApplyDirective, WRITABLE_TEXT_REMINDER } from "./prompt.js";
import type { OutputFormat, Task, TaskProfile, FewShotExample, ApplyTargetInfo } from "./prompt.js";
import { callLocalModel } from "./local-client.js";
import type { LocalModelResult } from "./local-client.js";
import type { LocalRouterTrace, TraceCapture } from "./trace.js";
import { estimateTokens } from "./tokens.js";
import { readRequestedFiles, resolveAllowedRoot } from "./fileaccess.js";
import { newCallId, appendUsage } from "./ledger.js";
import type { UsageEntry, UsageFileWritten } from "./ledger.js";
import { prepareTargets, commitChanges, buildDiff } from "./apply.js";
import { parseEditReply, planEdits } from "./editblocks.js";

const TOOL_IMPLEMENT = "local_implement";
const TOOL_DIRECT = "local_direct";

const BASE_TOOL_PROPERTIES = {
  prompt: {
    type: "string",
    description:
      "Complete user-message text to send: the requirement, constraints and conventions to follow. " +
      "There is no separate \"context\" argument, this is the only free-text field. " +
      "On an instance with filesystem access (see the tool description), name files in `files` " +
      "instead of pasting their contents.",
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
  include_trace: {
    type: "boolean",
    description:
      "Opt in to a versioned structured trace of the exact upstream text request and public answer. Inline prompts only; cannot be combined with files, root or targets.",
  },
};

function maxLinesTasksFor(allowed: readonly Task[]): readonly Task[] {
  return TASKS.filter((t) => allowed.includes(t) && TASK_PROFILES[t].acceptsMaxLines);
}

function buildMaxLinesProperty(allowed: readonly Task[]) {
  const tasks = maxLinesTasksFor(allowed);
  const defaultsList = tasks
    .filter((t) => TASK_PROFILES[t].defaultMaxLines !== undefined)
    .map((t) => `"${t}" defaults to ${TASK_PROFILES[t].defaultMaxLines}`)
    .join(", ");
  const trailing = defaultsList.length > 0 ? ` (${defaultsList}).` : ".";
  return {
    type: "integer",
    minimum: 1,
    description:
      `Caps the number of output lines. Valid only with task ${tasks.map((t) => `"${t}"`).join(", ")}. ` +
      `Omitting it uses the task's own default line cap where one exists` + trailing,
  };
}

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

const FILES_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description:
    "Repository paths, relative to `root`, for the server to read itself instead of you inlining their " +
    "content into `prompt`. Requires `root`. Files that don't fit the token budget are truncated or skipped; " +
    "the response notes which.",
};

const ROOT_PROPERTY = {
  type: "string",
  description:
    "Absolute path the `files` entries are read relative to. Must resolve inside this server's configured " +
    "allowed roots. Required when `files` is set.",
};

const TARGETS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 20,
  description:
    "Repository paths, relative to `root`, that the server may write to. When set, the model's reply is " +
    "parsed as search/replace edit blocks (or a whole-file block for a path that does not exist yet) and " +
    "applied to disk directly: the response is a summary and a diff, not code to retype. Requires `root` " +
    "and task \"implement\" or \"fix\". Do not copy code out of a text-mode response by hand when this " +
    "argument is available, call again with `targets` instead.",
};

const IMPLEMENT_TOOL_DEFINITION = {
  name: TOOL_IMPLEMENT,
  description:
    "Send a fully-assembled prompt to the configured local model and return its response. " +
    "Use for code generation. " +
    "By default this wraps the output in <local_output> and appends a provider-neutral review reminder.",
};

const DIRECT_TOOL_DEFINITION = {
  name: TOOL_DIRECT,
  description:
    "Send a prompt to the configured local model and return its response, by default without review wrapping. " +
    "A task whose profile wraps (implement and fix) still wraps unless you override it with `mode` or `include_review_reminder`. " +
    "Use for direct local mode, explanations, and rate-limit escape-hatch queries.",
};

export function servesImplementTool(config: Config): boolean {
  return (config.tasks ?? TASKS).some((t) => TASK_PROFILES[t].wrap);
}

export function buildToolDefinitions(config: Config) {
  const allowed: readonly Task[] = config.tasks ?? TASKS;
  const definitions = servesImplementTool(config)
    ? [IMPLEMENT_TOOL_DEFINITION, DIRECT_TOOL_DEFINITION]
    : [DIRECT_TOOL_DEFINITION];
  const properties: Record<string, unknown> = {
    ...BASE_TOOL_PROPERTIES,
    task: {
      type: "string",
      enum: [...allowed],
      description:
        "Task profile. Sets the system prompt, output directive, review wrapping and sampling. " +
        (config.tasks !== null
          ? "Required on this instance."
          : "Omit for the legacy code-generation default."),
    },
  };
  if (allowed.includes("classify")) {
    properties.examples = EXAMPLES_PROPERTY;
  }
  const maxLinesTasks = maxLinesTasksFor(allowed);
  if (maxLinesTasks.length > 0) {
    properties.max_lines = buildMaxLinesProperty(allowed);
  }
  if (config.allowedRoots !== null) {
    properties.files = FILES_PROPERTY;
    properties.root = ROOT_PROPERTY;
  }

  const tierLine =
    config.tier !== null || config.tasks !== null
      ? ` Tier: ${config.tier ?? "unspecified"}. Accepts: ${allowed.join(", ")}.`
      : "";

  const fileAccessLine =
    config.allowedRoots !== null
      ? " This instance reads files itself: pass repository paths in \"files\" plus an absolute \"root\" instead of inlining their content."
      : " This instance has no filesystem access, inline any file content the model needs into \"prompt\".";

  const writeAccessLine = writesEnabled(config)
    ? " This instance can also write: pass \"targets\" (with \"root\") on local_implement and the server applies the model's edit blocks directly, no retyping."
    : "";

  const promptBudgetTokens = config.tokenBudget - config.maxTokens;
  const promptBudgetKb = Math.floor((promptBudgetTokens * 3) / 1024);
  const budgetLine =
    ` Input budget per call: about ${promptBudgetTokens} tokens (roughly ${promptBudgetKb} KB of code) for the ` +
    `prompt and every file together; the reply can use up to ${config.maxTokens} tokens.`;

  return definitions.map((tool) => {
    const withRole = withRoleDescription(tool, config.toolDescription);
    let description = withRole.description + tierLine + fileAccessLine + budgetLine;
    if (withRole.name === TOOL_IMPLEMENT && writesEnabled(config)) {
      description += writeAccessLine;
    }
    const toolProperties: Record<string, unknown> = { ...properties };
    if (withRole.name === TOOL_IMPLEMENT && writesEnabled(config)) {
      toolProperties.targets = TARGETS_PROPERTY;
      toolProperties.root = ROOT_PROPERTY;
    }
    return { ...withRole, description, inputSchema: { type: "object", properties: toolProperties, required: config.tasks !== null ? ["prompt", "task"] : ["prompt"] } };
  });
}

type ToolArgs = {
  prompt?: unknown;
  system?: unknown;
  output_format?: unknown;
  mode?: unknown;
  include_review_reminder?: unknown;
  include_trace?: unknown;
  task?: unknown;
  examples?: unknown;
  max_lines?: unknown;
  files?: unknown;
  root?: unknown;
  targets?: unknown;
};

const OUTPUT_FORMATS: readonly OutputFormat[] = ["code", "diff", "explanation"];
const MODES = ["delegate", "direct"] as const;
const KNOWN_ARGS = new Set([
  "prompt", "system", "output_format", "mode", "include_review_reminder", "include_trace",
  "task", "examples", "max_lines", "files", "root", "targets",
]);

const EXAMPLES_REQUIRED =
  '`examples` is required when task is "classify" and must contain at least 2 entries. ' +
  "Without examples this model returns the same label for every input.";

const MAX_EXAMPLES = 50;

function short(value: unknown): string {
  const s = JSON.stringify(value) ?? String(value);
  return s.length > 120 ? s.slice(0, 120) + '…"' : s;
}

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

async function runToolCall(
  toolName: string,
  rawArgs: unknown,
  config: Config,
  signal?: AbortSignal,
  onUpstreamCall?: () => void,
  onUpstreamResult?: (result: LocalModelResult) => void,
  onFilesRead?: (info: { included: string[]; truncated: string[]; skipped: string[]; bytes: number }) => void,
  onUpstreamTiming?: (ms: number) => void,
  onFilesWritten?: (files: Array<{ rel: string; created: boolean; added: number; removed: number }>) => void,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (toolName !== TOOL_IMPLEMENT && toolName !== TOOL_DIRECT) {
    throw new Error(`Unknown tool: ${toolName}`);
  }
  if (toolName === TOOL_IMPLEMENT && !servesImplementTool(config)) {
    throw new Error(
      `Tool ${TOOL_IMPLEMENT} is not served by this instance` +
        (config.tier !== null ? ` (tier: ${config.tier})` : "") +
        `. No accepted task wraps its output, so ${TOOL_IMPLEMENT} and ${TOOL_DIRECT} ` +
        `would behave identically. Call ${TOOL_DIRECT} instead.`,
    );
  }
  const args = (rawArgs ?? {}) as ToolArgs;

  const unknown = Object.keys(args).filter((k) => !KNOWN_ARGS.has(k)).sort();
  if (unknown.length > 0) {
    const examplesUsable = config.tasks === null || config.tasks.includes("classify");
    const filesUsable = config.allowedRoots !== null;
    const listedArgs = [...KNOWN_ARGS].filter(
      (a) => (a !== "examples" || examplesUsable) && (a !== "files" && a !== "root" || filesUsable),
    );
    throw new Error(
      `Unrecognized argument(s): ${unknown.join(", ")}. ` +
        `Valid arguments: ${listedArgs.join(", ")}.`,
    );
  }

  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw new Error("`prompt` is required and must be a non-empty string");
  }
  if (args.include_trace !== undefined && typeof args.include_trace !== "boolean") {
    throw new Error("`include_trace` must be a boolean");
  }
  if (args.include_trace === true && (args.files !== undefined || args.root !== undefined || args.targets !== undefined)) {
    throw new Error("`include_trace` supports inline prompts only; omit files, root and targets");
  }
  if (args.mode !== undefined && !MODES.includes(args.mode as (typeof MODES)[number])) {
    throw new Error(
      `\`mode\` must be one of ${MODES.join(", ")}; got: ${JSON.stringify(args.mode)}`,
    );
  }
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

  if (task === undefined && config.tasks !== null) {
    throw new Error(
      "`task` is required on this instance" +
        (config.tier !== null ? ` (tier: ${config.tier})` : "") +
        `. Accepted tasks: ${config.tasks.join(", ")}. ` +
        `This instance does not serve the no-task default, which uses a ` +
        `code-generation system prompt.`,
    );
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
      const unknownKeys = Object.keys(ex as object).filter((k) => k !== "input" && k !== "output");
      if (unknownKeys.length > 0) {
        throw new Error(
          `\`examples[${i}]\` has unrecognized key(s): ${short(unknownKeys.join(", "))}. ` +
            `Only \`input\` and \`output\` are valid; got: ${short(ex)}`,
        );
      }
    });
    examples = args.examples as FewShotExample[];
  }
  if (task === "classify" && examples === undefined) {
    throw new Error(EXAMPLES_REQUIRED);
  }

  let max_lines: number | undefined;
  if (args.max_lines !== undefined) {
    if (
      typeof args.max_lines !== "number" ||
      !Number.isInteger(args.max_lines) ||
      args.max_lines < 1
    ) {
      throw new Error(`\`max_lines\` must be a positive integer; got: ${short(args.max_lines)}`);
    }
    if (task === undefined || !TASK_PROFILES[task].acceptsMaxLines) {
      const acceptedHere = maxLinesTasksFor(config.tasks ?? TASKS);
      throw new Error(
        `\`max_lines\` is only valid with task ${acceptedHere.map((t) => `"${t}"`).join(", ")}; got task ` +
          `${task !== undefined ? `"${task}"` : "(none)"}.`,
      );
    }
    max_lines = args.max_lines;
  }

  const profile = task !== undefined ? TASK_PROFILES[task] : undefined;
  const effectiveConfig: Config = {
    ...config,
    temperature: profile?.temperature ?? config.temperature,
    maxTokens: Math.min(profile?.maxTokens ?? config.maxTokens, config.maxTokens),
  };

  if (args.targets !== undefined) {
    if (toolName !== TOOL_IMPLEMENT || !writesEnabled(config)) {
      throw new Error(
        "`targets` is only accepted by local_implement on an instance with writeRoots configured.",
      );
    }
    if (
      !Array.isArray(args.targets) ||
      args.targets.length === 0 ||
      args.targets.length > 20 ||
      args.targets.some((t) => typeof t !== "string" || t.trim() === "")
    ) {
      throw new Error("`targets` must be a non-empty array of 1 to 20 non-empty string paths");
    }
    if (args.root === undefined) {
      throw new Error("`root` is required when `targets` is provided");
    }
    if (task !== "implement" && task !== "fix") {
      throw new Error(
        `\`targets\` requires task "implement" or "fix", got task ${task !== undefined ? `"${task}"` : "(none)"}.`,
      );
    }
    const targetRels = args.targets as string[];
    const realRoot = resolveAllowedRoot(args.root, config.allowedRoots);
    const prepared = prepareTargets(realRoot, targetRels, config.writeRoots ?? []);
    const directive = buildApplyDirective(prepared.map((p) => ({ rel: p.rel, exists: p.exists })));
    // `files` must reach the model in apply mode too, otherwise it edits without the spec.
    let applyPrompt = args.prompt;
    if (Array.isArray(args.files) && args.files.length > 0 && args.files.every((f) => typeof f === "string")) {
      const baseEstimate = estimateTokens(buildMessages({ prompt: args.prompt, system, task, examples, directive }).map((m) => m.content).join("\n"));
      const headroom = effectiveConfig.tokenBudget - effectiveConfig.maxTokens - baseEstimate;
      if (headroom <= 0) {
        throw new Error(`No token budget remains for file content: prompt alone is estimated at ${baseEstimate} tokens against a budget of ${effectiveConfig.tokenBudget}.`);
      }
      const filesResult = readRequestedFiles(realRoot, args.files as string[], headroom);
      onFilesRead?.({ included: filesResult.included, truncated: filesResult.truncated, skipped: filesResult.skipped.map((s) => s.path), bytes: Buffer.byteLength(filesResult.text, "utf8") });
      if (filesResult.included.length === 0 && filesResult.truncated.length === 0) {
        throw new Error(`None of the requested files could be read: ${filesResult.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}`);
      }
      applyPrompt = `${args.prompt}\n\n${filesResult.text}`;
    }
    const applyMessages = buildMessages({ prompt: applyPrompt, system, task, examples, directive });
    const applyText = applyMessages.map((m) => m.content).join("\n");
    const applyEstimated = estimateTokens(applyText);
    if (applyEstimated + effectiveConfig.maxTokens > effectiveConfig.tokenBudget) {
      throw new Error(
        `Prompt exceeds tokenBudget: estimated ${applyEstimated} prompt tokens + ${effectiveConfig.maxTokens} ` +
          `reserved for the response = ${applyEstimated + effectiveConfig.maxTokens}, over the budget of ${effectiveConfig.tokenBudget}. ` +
          `Reduce the number of targets, lower maxTokens, or raise tokenBudget in config.`,
      );
    }
    onUpstreamCall?.();
    const beforeUpstream = Date.now();
    const applyResult = await callLocalModel(applyMessages, effectiveConfig, signal);
    onUpstreamResult?.(applyResult);
    onUpstreamTiming?.(Date.now() - beforeUpstream);

    if (applyResult.finishReason === "length") {
      return {
        content: [{
          type: "text",
          text: `[local-router] REFUSED: the local model stopped at max_tokens (${effectiveConfig.maxTokens}) before finishing its edit blocks. Split the change across fewer targets or raise maxTokens. No file was written.`,
        }],
        isError: true,
      };
    }

    const parsed = parseEditReply(applyResult.content);
    if (parsed.need !== null) {
      return {
        content: [{ type: "text", text: `[local-router] NO_CHANGE: the model needs more context: ${parsed.need}. No file was written.` }],
      };
    }
    if (parsed.errors.length > 0) {
      return {
        content: [{ type: "text", text: `[local-router] REFUSED: could not parse the model's reply: ${parsed.errors.join("; ")}. No file was written.` }],
        isError: true,
      };
    }

    if (parsed.sections.length === 0) {
      const excerpt = applyResult.content.trim().slice(0, 300);
      return {
        content: [{
          type: "text",
          text: `[local-router] REFUSED: the model's reply had no FILE or EDIT blocks (${parsed.strayLines} unparsed line(s)). ` +
            `Reply began: ${JSON.stringify(excerpt)}. No file was written.`,
        }],
        isError: true,
      };
    }

    const plan = planEdits(parsed, prepared);
    if (plan.errors.length > 0) {
      return {
        content: [{ type: "text", text: `[local-router] REFUSED: ${plan.errors.join("; ")}. No file was written.` }],
        isError: true,
      };
    }
    if (plan.changes.length === 0) {
      return {
        content: [{ type: "text", text: "[local-router] NO_CHANGE: the requested edits would not change any file. No file was written." }],
      };
    }

    const commit = commitChanges(plan.changes, prepared, realRoot, config.writeRoots ?? []);
    if (!commit.ok) {
      return {
        content: [{ type: "text", text: `[local-router] REFUSED: ${(commit.errors ?? []).join("; ")}. No file was written.` }],
        isError: true,
      };
    }

    onFilesWritten?.(commit.files);
    const { diff, added, removed } = buildDiff(plan.changes);
    const fileList = commit.files.map((f) => f.rel).join(", ");
    return {
      content: [{ type: "text", text: `[local-router] APPLIED: wrote ${commit.files.length} file(s) (${fileList}), ${added} added, ${removed} removed.\n\n${diff}` }],
    };
  }

  let effectivePrompt = args.prompt;
  let fileDiagnostics = "";
  if (args.files !== undefined || args.root !== undefined) {
    if (!Array.isArray(args.files) || args.files.length === 0) {
      throw new Error("`files` must be a non-empty array of paths when `root` is provided (and vice versa)");
    }
    if (args.files.some((f) => typeof f !== "string")) {
      throw new Error("`files` entries must all be strings");
    }
    const realRoot = resolveAllowedRoot(args.root, config.allowedRoots);
    const baseMessages = buildMessages({ prompt: args.prompt, system, output_format, task, examples, max_lines });
    const baseEstimated = estimateTokens(baseMessages.map((m) => m.content).join("\n"));
    const headroom = effectiveConfig.tokenBudget - effectiveConfig.maxTokens - baseEstimated;
    if (headroom <= 0) {
      throw new Error(
        `No token budget remains for file content: prompt alone is estimated at ${baseEstimated} tokens ` +
          `against a budget of ${effectiveConfig.tokenBudget} (reserving ${effectiveConfig.maxTokens} for the ` +
          `response). Shrink the prompt, request fewer files, or raise tokenBudget.`,
      );
    }
    const filesResult = readRequestedFiles(realRoot, args.files, headroom);
    onFilesRead?.({ included: filesResult.included, truncated: filesResult.truncated, skipped: filesResult.skipped.map((s) => s.path), bytes: Buffer.byteLength(filesResult.text, "utf8") });
    if (filesResult.included.length === 0 && filesResult.truncated.length === 0) {
      const reasons = filesResult.skipped.map((s) => `${s.path} (${s.reason})`).join("; ");
      throw new Error(`None of the requested files could be read: ${reasons}`);
    }
    effectivePrompt = `${args.prompt}\n\n${filesResult.text}`;
    const notes: string[] = [];
    if (filesResult.truncated.length > 0) {
      notes.push(`truncated to fit the token budget: ${filesResult.truncated.join(", ")}`);
    }
    if (filesResult.skipped.length > 0) {
      notes.push(`skipped: ${filesResult.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}`);
    }
    if (notes.length > 0) {
      fileDiagnostics = `\n\n[local-router] NOTE: ${notes.join("; ")}`;
    }
  }

  const messages = buildMessages({ prompt: effectivePrompt, system, output_format, task, examples, max_lines });
  const totalText = messages.map((m) => m.content).join("\n");
  const estimated = estimateTokens(totalText);
  if (estimated + effectiveConfig.maxTokens > effectiveConfig.tokenBudget) {
    throw new Error(
      `Prompt exceeds tokenBudget: estimated ${estimated} prompt tokens + ${effectiveConfig.maxTokens} ` +
        `reserved for the response = ${estimated + effectiveConfig.maxTokens}, over the budget of ${effectiveConfig.tokenBudget}. ` +
        `Reduce scope, lower maxTokens, or raise tokenBudget in config.`,
    );
  }

  onUpstreamCall?.();
  const beforeUpstream = Date.now();
  const result = await callLocalModel(messages, effectiveConfig, signal, args.include_trace === true);
  const afterUpstream = Date.now();
  onUpstreamResult?.(result);
  onUpstreamTiming?.(afterUpstream - beforeUpstream);
  let body = shouldWrapOutput(toolName, args, profile)
    ? wrapWithReviewReminder(result.content)
    : result.content;
  if (writesEnabled(config) && toolName === TOOL_IMPLEMENT && (task === "implement" || task === "fix") && shouldWrapOutput(toolName, args, profile)) {
    body = `${body}\n\n${WRITABLE_TEXT_REMINDER}`;
  }
  const text =
    result.finishReason === "length"
      ? `${body}\n\n[local-router] WARNING: the local model stopped at max_tokens ` +
        `(${effectiveConfig.maxTokens}), so the output above is cut off mid-generation. ` +
        `Raise maxTokens or narrow the request before applying it.`
      : body;
  return { content: [{ type: "text", text: text + fileDiagnostics }] };
}

export async function handleToolCall(
  toolName: string,
  rawArgs: unknown,
  config: Config,
  signal?: AbortSignal,
  clientVersion?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: { local_router_trace: LocalRouterTrace } }> {
  const callId = newCallId();
  const startedAt = Date.now();
  let cwd = "";
  try { cwd = process.cwd(); } catch { /* best effort */ }
  const args = (rawArgs ?? {}) as { prompt?: unknown; task?: unknown; root?: unknown; targets?: unknown };
  const promptBytes =
    typeof args.prompt === "string" ? Buffer.byteLength(args.prompt, "utf8") : 0;
  const task = typeof args.task === "string" ? args.task : null;
  const root = typeof args.root === "string" ? args.root : null;
  const targets = Array.isArray(args.targets) ? args.targets.filter((t): t is string => typeof t === "string") : [];

  const entry: UsageEntry = {
    v: 1,
    ts: new Date(startedAt).toISOString(),
    call_id: callId,
    pid: process.pid,
    cwd,
    client: clientVersion ?? null,
    tier: config.tier,
    model: config.model,
    tool: toolName === TOOL_IMPLEMENT ? "local_implement" : "local_direct",
    task,
    mode: targets.length > 0 ? "apply" : "text",
    outcome: "ok",
    root,
    files_read: [],
    files_truncated: [],
    files_skipped: [],
    targets,
    files_written: [],
    prompt_bytes: promptBytes,
    file_bytes: 0,
    bytes_in: promptBytes,
    bytes_out: 0,
    prompt_tokens: null,
    completion_tokens: null,
    attempts: 1,
    finish_reason: null,
    stray_lines: 0,
    upstream_ms: null,
    duration_ms: 0,
    reasons: [],
  };

  let filesReadInfo: { included: string[]; truncated: string[]; skipped: string[]; bytes: number } | null = null;
  let filesWritten: UsageFileWritten[] = [];

  let upstreamAttempted = false;
  let trace: TraceCapture | undefined;
  try {
    const result = await runToolCall(
      toolName,
      rawArgs,
      config,
      signal,
      () => {
        upstreamAttempted = true;
      },
      (upstream: LocalModelResult) => {
        trace = upstream.trace;
        entry.finish_reason = upstream.finishReason;
        if (upstream.usage) {
          entry.prompt_tokens = upstream.usage.promptTokens;
          entry.completion_tokens = upstream.usage.completionTokens;
        }
      },
      (info) => {
        filesReadInfo = info;
      },
      (ms) => {
        entry.upstream_ms = ms;
      },
      (files) => {
        filesWritten = files.map((f) => ({ path: f.rel, created: f.created, added: f.added, removed: f.removed }));
      },
    );
    const text = result.content.map((c) => c.text).join("");
    entry.bytes_out = Buffer.byteLength(text, "utf8");
    entry.outcome = "ok";
    const readInfo = filesReadInfo as { included: string[]; truncated: string[]; skipped: string[]; bytes: number } | null;
    if (readInfo !== null) {
      entry.files_read = readInfo.included;
      entry.files_truncated = readInfo.truncated;
      entry.files_skipped = readInfo.skipped;
      entry.file_bytes = readInfo.bytes;
    }
    if (entry.mode === "apply") {
      entry.outcome = result.isError ? "refused" : text.startsWith("[local-router] NO_CHANGE") ? "no_change" : text.startsWith("[local-router] APPLIED") ? "applied" : "ok";
      entry.files_written = filesWritten;
    }
    return trace ? { ...result, structuredContent: { local_router_trace: { version: 1, request_id: callId, ...trace } } } : result;
  } catch (err) {
    const message = (err as Error).message;
    entry.outcome = upstreamAttempted ? "error" : "rejected";
    entry.reasons = [message.slice(0, 200)];
    throw err;
  } finally {
    entry.duration_ms = Date.now() - startedAt;
    appendUsage(config, entry);
  }
}

export function logProtocolError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[local-router] protocol error: ${message}\n`);
}

export function createServer(config: Config): Server {
  const server = new Server(
    { name: "local-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.onerror = logProtocolError;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions(config),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const client = server.getClientVersion();
    const clientVersion = client ? `${client.name} ${client.version}` : undefined;
    return handleToolCall(req.params.name, req.params.arguments, config, extra?.signal, clientVersion);
  });

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    if (realpathSync(entry) === realpathSync(self)) return true;
  } catch {
  }
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
