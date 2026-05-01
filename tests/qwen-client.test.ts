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
