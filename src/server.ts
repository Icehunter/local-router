#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
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

function shouldWrapOutput(toolName: string, args: ToolArgs): boolean {
  if (typeof args.include_review_reminder === "boolean") {
    return args.include_review_reminder;
  }
  if (args.mode === "direct") return false;
  if (args.mode === "delegate") return true;
  return toolName === TOOL_IMPLEMENT;
}

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new Server(
    { name: "local-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [IMPLEMENT_TOOL_DEFINITION, DIRECT_TOOL_DEFINITION],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== TOOL_IMPLEMENT && req.params.name !== TOOL_DIRECT) {
      throw new Error(`Unknown tool: ${req.params.name}`);
    }
    const args = req.params.arguments as ToolArgs;
    if (typeof args.prompt !== "string" || args.prompt.length === 0) {
      throw new Error("`prompt` is required and must be a non-empty string");
    }
    const system = typeof args.system === "string" && args.system !== "" ? args.system : undefined;
    const output_format =
      args.output_format === "diff" ||
      args.output_format === "explanation" ||
      args.output_format === "code"
        ? (args.output_format as OutputFormat)
        : undefined;

    const messages = buildMessages({ prompt: args.prompt, system, output_format });
    const totalText = messages.map((m) => m.content).join("\n");
    const estimated = estimateTokens(totalText);
    if (estimated + config.maxTokens > config.tokenBudget) {
      throw new Error(
        `Prompt exceeds tokenBudget (estimated ${estimated} tokens, budget ${config.tokenBudget}). ` +
          `Reduce scope or raise tokenBudget in config.`,
      );
    }

    const text = await callLocalModel(messages, config);
    return {
      content: [{
        type: "text",
        text: shouldWrapOutput(req.params.name, args)
          ? wrapWithReviewReminder(text)
          : text,
      }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[local-router] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
