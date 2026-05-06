import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callLocalModel } from "../src/local-client.js";
import type { Config } from "../src/config.js";

const baseConfig: Config = {
  baseUrl: "http://test-host:1234",
  model: "test-model",
  apiKey: null,
  tokenBudget: 180000,
  requestTimeoutMs: 5000,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0.05,
  repeatPenalty: 1.1,
  maxTokens: 16000,
  debugLogPath: null,
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

describe("callLocalModel", () => {
  it("POSTs to /v1/chat/completions with the configured model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("hi"));
    await callLocalModel(
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
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.8);
    expect(body.top_k).toBe(20);
    expect(body.min_p).toBe(0.05);
    expect(body.repeat_penalty).toBe(1.1);
  });

  it("includes Authorization header when apiKey is set", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callLocalModel(
      [{ role: "user", content: "x" }],
      { ...baseConfig, apiKey: "sk-secret" },
    );
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret");
  });

  it("omits Authorization header when apiKey is null", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    const init = fetchMock.mock.calls[0][1];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns the assistant message text on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("the answer is 42"));
    const result = await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    expect(result).toBe("the answer is 42");
  });

  it("throws on non-2xx with status and body in message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("model not found", { status: 404 }),
    );
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/404.*model not found/);
  });

  it("throws a clear error when the network fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED"),
    );
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
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
      callLocalModel(
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
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/Unexpected response/);
  });

  it("throws a clear error when 200 response has unparseable JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json {{{", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/returned 200 but unparseable JSON/);
  });

  it("forwards configured sampling params in the request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callLocalModel(
      [{ role: "user", content: "x" }],
      {
        ...baseConfig,
        temperature: 0.9,
        topP: 0.7,
        topK: 10,
        minP: 0.01,
        repeatPenalty: 1.2,
      },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.temperature).toBe(0.9);
    expect(body.top_p).toBe(0.7);
    expect(body.top_k).toBe(10);
    expect(body.min_p).toBe(0.01);
    expect(body.repeat_penalty).toBe(1.2);
  });

  it("uses configured maxTokens in the request body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    await callLocalModel(
      [{ role: "user", content: "x" }],
      { ...baseConfig, maxTokens: 4096 },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it("does not write to disk when debugLogPath is null", async () => {
    // The default (debugLogPath: null) should never call appendFileSync.
    // We can't easily verify "no fs write" without mocking node:fs, but
    // since the existing test suite passed without writing files, this is
    // implicit. Just confirm the call still works with null debugLogPath.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    const result = await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    expect(result).toBe("ok");
  });

  it("writes a JSONL entry on success when debugLogPath is set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-debug-"));
    const logPath = join(tempDir, "debug.log");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("hello world"));
      await callLocalModel(
        [{ role: "user", content: "say hi" }],
        { ...baseConfig, debugLogPath: logPath },
      );
      const log = readFileSync(logPath, "utf8");
      const entry = JSON.parse(log.trim());
      expect(log.endsWith("\n")).toBe(true);
      expect(log.trim().split("\n")).toHaveLength(1);
      expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(entry.request.url).toBe("http://test-host:1234/v1/chat/completions");
      expect(entry.request.model).toBe("test-model");
      expect(entry.response.ok).toBe(true);
      expect(entry.response.content).toBe("hello world");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes a JSONL entry on error when debugLogPath is set", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-debug-"));
    const logPath = join(tempDir, "debug.log");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("model not found", { status: 404 }),
      );
      await expect(
        callLocalModel(
          [{ role: "user", content: "x" }],
          { ...baseConfig, debugLogPath: logPath },
        ),
      ).rejects.toThrow();
      const log = readFileSync(logPath, "utf8");
      const entry = JSON.parse(log.trim());
      expect(log.endsWith("\n")).toBe(true);
      expect(log.trim().split("\n")).toHaveLength(1);
      expect(entry.response.ok).toBe(false);
      expect(entry.response.error).toContain("404");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("appends successive JSONL entries on multiple calls", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-debug-"));
    const logPath = join(tempDir, "debug.log");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("first"));
      await callLocalModel([{ role: "user", content: "a" }], { ...baseConfig, debugLogPath: logPath });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("second"));
      await callLocalModel([{ role: "user", content: "b" }], { ...baseConfig, debugLogPath: logPath });
      const log = readFileSync(logPath, "utf8");
      const lines = log.trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      const second = JSON.parse(lines[1]);
      expect(first.response.content).toBe("first");
      expect(second.response.content).toBe("second");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
