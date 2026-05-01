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
      content: [{ type: "text", text: wrapWithReviewReminder(text) }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[claude-qwen-router] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
