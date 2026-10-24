import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildToolDefinitions, createServer, handleToolCall } from "../src/server.js";
import type { Config } from "../src/config.js";

const config: Config = {
  baseUrl: "http://test-host:1234", model: "local-coder", apiKey: "private-bearer",
  tokenBudget: 180000, requestTimeoutMs: 5000, maxTokens: 16000,
  temperature: 0.7, topP: 0.8, topK: 20, minP: 0.05, repeatPenalty: 1.1,
  debugLogPath: null, enableThinking: null, toolDescription: null, tier: null,
  tasks: null, allowedRoots: null, writeRoots: null, stateDir: null,
};

function upstream(value: unknown = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "answer" } }] }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(value), { status: 200 }));
}

afterEach(() => vi.restoreAllMocks());

describe("opt-in request traces", () => {
  it("advertises an optional boolean on both tools", () => {
    for (const tool of buildToolDefinitions(config)) {
      expect(tool.inputSchema.properties.include_trace).toMatchObject({ type: "boolean" });
      expect(tool.inputSchema.required).not.toContain("include_trace");
    }
  });

  it("keeps default and explicitly disabled replies unchanged", async () => {
    upstream();
    for (const args of [{ prompt: "x" }, { prompt: "x", include_trace: false }]) {
      const reply = await handleToolCall("local_direct", args, config);
      expect(reply).toEqual({ content: [{ type: "text", text: "answer" }] });
    }
  });

  it("captures the exact wire request and ledger ID without recording trace bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-trace-"));
    try {
      const fetch = upstream({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "private-answer" } }], usage: { prompt_tokens: 123, completion_tokens: 45 } });
      const cfg = { ...config, enableThinking: false, stateDir: dir };
      const reply = await handleToolCall("local_implement", { prompt: "private-task", task: "fix", output_format: "code", include_trace: true, include_review_reminder: false }, cfg);
      const wire = JSON.parse(String(fetch.mock.calls[0][1]?.body));
      const { model, messages, ...parameters } = wire;
      const trace = reply.structuredContent?.local_router_trace;
      expect(trace).toMatchObject({ version: 1, complete: true, request: { model, messages, parameters }, response: { content: "private-answer", finish_reason: "stop", usage: { prompt_tokens: 123, completion_tokens: 45 } } });
      expect(trace?.request).toEqual({ model, messages, parameters });
      expect(parameters.temperature).toBe(0.1);
      expect(parameters.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(messages[1].content).not.toBe("private-task");
      const ledger = readFileSync(join(dir, "usage.jsonl"), "utf8");
      expect(trace?.request_id).toBe(JSON.parse(ledger).call_id);
      expect(ledger).not.toMatch(/private-task|private-answer|local_router_trace|messages|parameters/);
      expect(JSON.stringify(trace)).not.toContain("private-bearer");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps absent optional wire fields absent and usage null", async () => {
    upstream();
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, config);
    const trace = reply.structuredContent?.local_router_trace;
    expect(trace?.request.parameters).not.toHaveProperty("chat_template_kwargs");
    expect(trace?.response.usage).toBeNull();
  });

  it("hashes the upstream URL without credentials, query or fragment", async () => {
    const fetch = upstream();
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, { ...config, baseUrl: "http://user:private-password@test-host:1234/path?token=private-query#private-fragment" });
    const endpoint = new URL(String(fetch.mock.calls[0][0]));
    endpoint.username = ""; endpoint.password = ""; endpoint.search = ""; endpoint.hash = "";
    const trace = reply.structuredContent?.local_router_trace;
    expect(trace?.endpoint_id).toBe("sha256:" + createHash("sha256").update(endpoint.toString()).digest("hex"));
    expect(JSON.stringify(trace)).not.toMatch(/private-password|private-query|private-fragment|test-host/);
  });

  it.each([null, "true", 1])("rejects nonboolean include_trace %j before transport", async (include_trace) => {
    const fetch = upstream();
    await expect(handleToolCall("local_direct", { prompt: "x", include_trace }, config)).rejects.toThrow(/include_trace.*boolean/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["files", "root", "targets"])("rejects traced %s before upstream or file effects", async (field) => {
    const dir = mkdtempSync(join(tmpdir(), "router-trace-no-files-"));
    try {
      writeFileSync(join(dir, "private.txt"), "private-file-content");
      const fetch = upstream();
      const cfg = { ...config, allowedRoots: [dir], writeRoots: [dir] };
      await expect(handleToolCall("local_implement", { prompt: "x", task: "fix", include_trace: true, [field]: field === "root" ? dir : ["private.txt"] }, cfg)).rejects.toThrow(/include_trace.*inline/);
      expect(fetch).not.toHaveBeenCalled();
      expect(readFileSync(join(dir, "private.txt"), "utf8")).toBe("private-file-content");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([null, "length", "tool_calls", "unexpected"])("does not certify finish reason %j", async (finish_reason) => {
    upstream({ choices: [{ finish_reason, message: { role: "assistant", content: "answer" } }] });
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, config);
    expect(reply.structuredContent?.local_router_trace.complete).toBe(false);
  });

  it.each([
    { role: "assistant", content: "answer", reasoning_content: "private-reasoning" },
    { role: "assistant", content: "answer", tool_calls: [{ function: { arguments: "private-tool" } }] },
    { role: "assistant", content: "answer", unfamiliar: "private-extra" },
    { role: "assistant", content: [{ type: "text", text: "private-nontext" }] },
    { role: "assistant", content: "<think>private-inline</think>answer" },
  ])("withholds unsupported response material from incomplete traces", async (message) => {
    upstream({ choices: [{ finish_reason: "stop", message }] });
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, config);
    expect(reply.structuredContent?.local_router_trace.complete).toBe(false);
    expect(JSON.stringify(reply.structuredContent)).not.toMatch(/private-(reasoning|tool|extra|nontext|inline)/);
  });

  it.each([{ choices: [] }, { choices: [{ finish_reason: "stop", message: { content: "one" } }, { finish_reason: "stop", message: { content: "two" } }] }])("does not certify unknown or multiple choices", async (response) => {
    upstream(response);
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, config);
    expect(reply.structuredContent?.local_router_trace.complete).toBe(false);
  });

  it.each([
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "answer" } }], reasoning_content: "private-root-reasoning" },
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "answer" } }], unfamiliar_shape: true },
  ])("does not certify unknown top-level response material", async (response) => {
    upstream(response);
    const reply = await handleToolCall("local_direct", { prompt: "x", include_trace: true }, config);
    expect(reply.structuredContent?.local_router_trace.complete).toBe(false);
    expect(JSON.stringify(reply.structuredContent)).not.toContain("private-root-reasoning");
  });

  it("preserves structured content through the actual MCP protocol", async () => {
    upstream();
    const server = createServer(config);
    const client = new Client({ name: "trace-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const reply = await client.callTool({ name: "local_direct", arguments: { prompt: "x", include_trace: true } });
      expect(reply.structuredContent).toMatchObject({ local_router_trace: { version: 1, complete: true, response: { content: "answer" } } });
    } finally { await client.close(); await server.close(); }
  });
});
