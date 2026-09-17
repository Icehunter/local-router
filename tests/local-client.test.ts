import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, appendFileSync, statSync, writeFileSync, chmodSync } from "node:fs";

// Wraps the real implementation so writes still happen, but calls are observable.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, appendFileSync: vi.fn(actual.appendFileSync) };
});
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
  enableThinking: null,
  toolDescription: null,
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
    expect(result.content).toBe("the answer is 42");
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
    vi.mocked(appendFileSync).mockClear();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok("ok"));
    const result = await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    expect(result.content).toBe("ok");
    expect(appendFileSync).not.toHaveBeenCalled();
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

describe("callLocalModel — response validation", () => {
  const json200 = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("rejects an empty completion instead of reporting success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json200({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] }),
    );
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/empty completion \(finish_reason: stop\)/);
  });

  it("rejects a whitespace-only completion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json200({ choices: [{ message: { content: "   \n\t " } }] }),
    );
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/empty completion/);
  });

  it("rejects a JSON null body without throwing a raw TypeError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json200(null));
    const err = (await callLocalModel([{ role: "user", content: "x" }], baseConfig).catch(
      (e: Error) => e,
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.constructor.name).toBe("Error"); // not TypeError
    expect(err.message).toMatch(/non-object body/);
  });

  it("rejects a JSON array body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json200([1, 2, 3]));
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/no choices\[0\]\.message\.content/);
  });

  it("surfaces finish_reason so a max_tokens truncation is visible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json200({ choices: [{ finish_reason: "length", message: { content: "half a func" } }] }),
    );
    const result = await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    expect(result.content).toBe("half a func");
    expect(result.finishReason).toBe("length");
  });

  it("reports finishReason null when upstream omits it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json200({ choices: [{ message: { content: "done" } }] }),
    );
    expect((await callLocalModel([{ role: "user", content: "x" }], baseConfig)).finishReason)
      .toBeNull();
  });

  it("truncates the debug log on a codepoint boundary, not mid-sequence", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-trunc-"));
    const logPath = join(tempDir, "debug.log");
    try {
      // 3-byte chars: 8192 is not a multiple of 3, so a raw byte cut splits one.
      const wide = "✓".repeat(4000);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json200({ choices: [{ message: { content: wide } }] }));
      await callLocalModel(
        [{ role: "user", content: "x" }],
        { ...baseConfig, debugLogPath: logPath },
      );
      const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
      expect(entry.response.content).not.toContain("�");
      expect(entry.response.content.endsWith("...[truncated]")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates the debug log with owner-only permissions", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "local-mode-"));
    const logPath = join(tempDir, "debug.log");
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json200({ choices: [{ message: { content: "ok" } }] }));
      await callLocalModel(
        [{ role: "user", content: "secret source" }],
        { ...baseConfig, debugLogPath: logPath },
      );
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("callLocalModel — abort during body read", () => {
  function abortError(): Error {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    return e;
  }

  it("reports a timeout when the error body read is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(abortError()),
    } as unknown as Response);
    await expect(
      callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, requestTimeoutMs: 1234 }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });

  it("reports a timeout when the JSON body read is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(abortError()),
    } as unknown as Response);
    await expect(
      callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, requestTimeoutMs: 1234 }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });

  it("a non-abort JSON parse failure is reported as unparseable, not as a timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    } as unknown as Response);
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/returned 200 but unparseable JSON: Unexpected token </);
  });
});

describe("callLocalModel — debug log failure warnings", () => {
  it("warns again after a working stretch, instead of latching for the process", async () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const good = mkdtempSync(join(tmpdir(), "local-relatch-"));
    const goodPath = join(good, "debug.log");
    const badPath = join(good, "missing-dir", "debug.log");
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const call = (p: string) =>
        callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, debugLogPath: p });

      await call(badPath); // fails -> warns, latch set
      await call(badPath); // fails -> silent (warn-once still holds)
      await call(goodPath); // succeeds -> re-arms
      await call(badPath); // fails again -> must warn a second time

      const warnings = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("debug log write failed"));
      expect(warnings).toHaveLength(2);
    } finally {
      warn.mockRestore();
      rmSync(good, { recursive: true, force: true });
    }
  });
});

describe("callLocalModel — enableThinking passthrough", () => {
  const okBody = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("omits chat_template_kwargs entirely when enableThinking is null", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okBody());
    await callLocalModel([{ role: "user", content: "x" }], baseConfig);
    const sent = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(sent).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends enable_thinking false when disabled", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okBody());
    await callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, enableThinking: false });
    const sent = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("sends enable_thinking true when enabled", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => okBody());
    await callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, enableThinking: true });
    const sent = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});

describe("callLocalModel — remaining response and logging defects", () => {
  const json200 = (b: unknown) => new Response(JSON.stringify(b), {
    status: 200, headers: { "Content-Type": "application/json" } });

  it("blames max_tokens, not the prompt, when a truncated completion is whitespace-only", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json200({ choices: [{ finish_reason: "length", message: { content: "   \n " } }] }));
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/stopped at max_tokens .*before producing any output/);
  });

  it("still blames the prompt when an empty completion stopped normally", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json200({ choices: [{ finish_reason: "stop", message: { content: "" } }] }));
    await expect(
      callLocalModel([{ role: "user", content: "x" }], baseConfig),
    ).rejects.toThrow(/produced no output/);
  });

  it("attributes a non-abort failure reading an error body to the upstream", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 503,
      text: () => Promise.reject(new Error("socket hang up")),
    } as unknown as Response);
    const err = (await callLocalModel([{ role: "user", content: "x" }], baseConfig)
      .catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Upstream returned 503/);
    expect(err.message).toMatch(/socket hang up/);
  });

  it("records finish_reason in the debug log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-fr-"));
    const logPath = join(dir, "d.log");
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        json200({ choices: [{ finish_reason: "length", message: { content: "cut" } }] }));
      await callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, debugLogPath: logPath });
      const e = JSON.parse(readFileSync(logPath, "utf8").trim());
      expect(e.response.finishReason).toBe("length");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("tightens permissions on a debug log that already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-mode2-"));
    const logPath = join(dir, "d.log");
    try {
      writeFileSync(logPath, "", { mode: 0o644 });
      chmodSync(logPath, 0o644);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        json200({ choices: [{ message: { content: "ok" } }] }));
      await callLocalModel([{ role: "user", content: "x" }], { ...baseConfig, debugLogPath: logPath });
      expect(statSync(logPath).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("truncates prompt-side content too, not just the response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "local-ptrunc-"));
    const logPath = join(dir, "d.log");
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        json200({ choices: [{ message: { content: "ok" } }] }));
      const huge = "z".repeat(20000);
      await callLocalModel([{ role: "user", content: huge }], { ...baseConfig, debugLogPath: logPath });
      const e = JSON.parse(readFileSync(logPath, "utf8").trim());
      const logged = e.request.messages[0].content as string;
      expect(logged.length).toBeLessThan(huge.length);
      expect(logged.endsWith("...[truncated]")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
