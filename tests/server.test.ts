import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolCall, logProtocolError, shouldWrapOutput, withRoleDescription } from "../src/server.js";
import type { Config } from "../src/config.js";
import { readFileSync } from "node:fs";

const baseConfig: Config = {
  baseUrl: "http://test-host:1234",
  model: "test-model",
  apiKey: null,
  tokenBudget: 180000,
  requestTimeoutMs: 300000,
  maxTokens: 16000,
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0.05,
  repeatPenalty: 1.1,
  debugLogPath: null,
  enableThinking: null,
  toolDescription: null,
  tier: null,
  tasks: null,
};

function mockUpstream(content: string, finish_reason: string | null = "stop") {
  // A fresh Response per call: a body can only be read once.
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldWrapOutput", () => {
  it("wraps for local_implement and not for local_direct by default", () => {
    expect(shouldWrapOutput("local_implement", {})).toBe(true);
    expect(shouldWrapOutput("local_direct", {})).toBe(false);
  });

  it("mode overrides the per-tool default", () => {
    expect(shouldWrapOutput("local_direct", { mode: "delegate" })).toBe(true);
    expect(shouldWrapOutput("local_implement", { mode: "direct" })).toBe(false);
  });

  it("include_review_reminder outranks mode", () => {
    expect(shouldWrapOutput("local_direct", { mode: "direct", include_review_reminder: true })).toBe(true);
    expect(shouldWrapOutput("local_implement", { mode: "delegate", include_review_reminder: false })).toBe(false);
  });

  it("ignores a non-boolean include_review_reminder", () => {
    expect(shouldWrapOutput("local_implement", { include_review_reminder: "yes" })).toBe(true);
  });
});

describe("handleToolCall — argument validation", () => {
  it("rejects an unknown tool name", async () => {
    await expect(handleToolCall("nope", { prompt: "x" }, baseConfig)).rejects.toThrow(
      /Unknown tool: nope/,
    );
  });

  it("reports a missing arguments object as a validation error, not a TypeError", async () => {
    const err = (await handleToolCall("local_implement", undefined, baseConfig).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.constructor.name).toBe("Error");
    expect(err.message).toMatch(/`prompt` is required/);
  });

  it("rejects a whitespace-only prompt", async () => {
    await expect(
      handleToolCall("local_implement", { prompt: "   \n\t " }, baseConfig),
    ).rejects.toThrow(/`prompt` is required/);
  });

  it("rejects an unrecognized output_format instead of silently using 'code'", async () => {
    await expect(
      handleToolCall("local_implement", { prompt: "x", output_format: "markdown" }, baseConfig),
    ).rejects.toThrow(/`output_format` must be one of code, diff, explanation; got: "markdown"/);
  });

  it("accepts each valid output_format", async () => {
    mockUpstream("ok");
    for (const f of ["code", "diff", "explanation"]) {
      await expect(
        handleToolCall("local_direct", { prompt: "x", output_format: f }, baseConfig),
      ).resolves.toBeDefined();
    }
  });
});

describe("handleToolCall — token budget", () => {
  it("counts the reserved response tokens in the error it reports", async () => {
    const cfg = { ...baseConfig, tokenBudget: 20000, maxTokens: 16000 };
    const err = (await handleToolCall("local_implement", { prompt: "a".repeat(20000) }, cfg).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toMatch(/\+ 16000 reserved for the response/);
    expect(err.message).toMatch(/over the budget of 20000/);
    const [, estimated, total] = /estimated (\d+) prompt tokens \+ \d+ reserved for the response = (\d+)/
      .exec(err.message)!;
    expect(Number(estimated) + 16000).toBe(Number(total));
    expect(Number(total)).toBeGreaterThan(20000);
    expect(Number(estimated)).toBeLessThan(20000);
  });

  it("allows a prompt that fits with the reservation", async () => {
    mockUpstream("fine");
    await expect(
      handleToolCall("local_direct", { prompt: "small" }, baseConfig),
    ).resolves.toBeDefined();
  });
});

describe("handleToolCall — output shaping", () => {
  it("wraps local_implement output in the review wrapper", async () => {
    mockUpstream("const x = 1;");
    const res = await handleToolCall("local_implement", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).toMatch(/^<local_output id="[0-9a-f]{16}">/);
    expect(res.content[0].text).toContain("const x = 1;");
  });

  it("returns local_direct output raw", async () => {
    mockUpstream("const x = 1;");
    const res = await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).toBe("const x = 1;");
  });

  it("appends a truncation warning when the model hit max_tokens", async () => {
    mockUpstream("half a func", "length");
    const res = await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).toContain("half a func");
    expect(res.content[0].text).toMatch(/\[local-router\] WARNING: the local model stopped at max_tokens \(16000\)/);
  });

  it("puts the truncation warning outside the review wrapper", async () => {
    mockUpstream("half a func", "length");
    const res = await handleToolCall("local_implement", { prompt: "x" }, baseConfig);
    const text = res.content[0].text;
    const id = /^<local_output id="([0-9a-f]{16})">/.exec(text)![1];
    expect(text.indexOf(`</local_output id="${id}">`)).toBeLessThan(
      text.indexOf("[local-router] WARNING"),
    );
  });

  it("adds no warning on a normal stop", async () => {
    mockUpstream("done", "stop");
    const res = await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).not.toContain("[local-router] WARNING");
  });

  it("propagates an empty completion as an error", async () => {
    mockUpstream("");
    await expect(handleToolCall("local_implement", { prompt: "x" }, baseConfig)).rejects.toThrow(
      /empty completion/,
    );
  });
});

describe("handleToolCall — mode validation", () => {
  it.each(["raw", "Direct", "DELEGATE", 3, null])("rejects mode %p", async (mode) => {
    await expect(
      handleToolCall("local_implement", { prompt: "x", mode }, baseConfig),
    ).rejects.toThrow(/`mode` must be one of delegate, direct/);
  });

  it("still accepts the two valid modes", async () => {
    mockUpstream("out");
    expect(
      (await handleToolCall("local_implement", { prompt: "x", mode: "direct" }, baseConfig))
        .content[0].text,
    ).toBe("out");
    expect(
      (await handleToolCall("local_direct", { prompt: "x", mode: "delegate" }, baseConfig))
        .content[0].text,
    ).toMatch(/^<local_output id=/);
  });
});

describe("logProtocolError", () => {
  it("writes transport and protocol errors to stderr", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logProtocolError(new Error("Invalid literal value, expected \"2.0\""));
    expect(String(warn.mock.calls[0][0])).toBe(
      '[local-router] protocol error: Invalid literal value, expected "2.0"\n',
    );
    warn.mockRestore();
  });

  it("handles a non-Error value without throwing", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logProtocolError("raw string failure");
    expect(String(warn.mock.calls[0][0])).toContain("raw string failure");
    warn.mockRestore();
  });
});

describe("withRoleDescription", () => {
  const tool = { name: "local_implement", description: "Base description." };

  it("returns the tool untouched when no role is configured", () => {
    expect(withRoleDescription(tool, null)).toBe(tool);
    expect(withRoleDescription(tool, "")).toBe(tool);
  });

  it("appends the role so two instances are distinguishable", () => {
    const coder = withRoleDescription(tool, "27B GPU coder. Use for writing code.");
    const helper = withRoleDescription(tool, "0.8B CPU helper. Summarizing only.");
    expect(coder.description).toBe(
      "Base description. THIS INSTANCE: 27B GPU coder. Use for writing code.",
    );
    expect(coder.description).not.toBe(helper.description);
  });

  it("does not mutate the shared tool definition", () => {
    withRoleDescription(tool, "something");
    expect(tool.description).toBe("Base description.");
  });
});

describe("handleToolCall — remaining argument defects", () => {
  it("rejects a non-string system instead of silently dropping it", async () => {
    await expect(
      handleToolCall("local_implement", { prompt: "x", system: 42 }, baseConfig),
    ).rejects.toThrow(/`system` must be a string/);
  });

  it("rejects a whitespace-only system instead of silently using the default persona", async () => {
    await expect(
      handleToolCall("local_implement", { prompt: "x", system: "   " }, baseConfig),
    ).rejects.toThrow(/`system` must be a string/);
  });

  it("rejects a misspelled argument key rather than ignoring it", async () => {
    await expect(
      handleToolCall("local_implement", { prompt: "x", out_format: "diff" }, baseConfig),
    ).rejects.toThrow(/Unrecognized argument\(s\): out_format/);
  });

  it("names every unrecognized key", async () => {
    const err = (await handleToolCall(
      "local_implement", { prompt: "x", modes: "direct", format: "diff" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/format/);
    expect(err.message).toMatch(/modes/);
  });

  it("does not echo an unbounded caller value back in the error", async () => {
    const huge = "q".repeat(5000);
    const err = (await handleToolCall(
      "local_implement", { prompt: "x", output_format: huge }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toMatch(/`output_format` must be one of/);
  });

  it("accepts a real system override", async () => {
    mockUpstream("ok");
    const res = await handleToolCall(
      "local_direct", { prompt: "x", system: "be terse" }, baseConfig);
    expect(res.content[0].text).toBe("ok");
  });
});

describe("handleToolCall — cancellation", () => {
  it("aborts the upstream request when the caller cancels", async () => {
    const ac = new AbortController();
    let upstreamSawAbort = false;
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          upstreamSawAbort = true;
          const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        });
      }));
    const p = handleToolCall("local_direct", { prompt: "x" }, baseConfig, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled by the caller/);
    expect(upstreamSawAbort).toBe(true);
  });

  it("fails immediately when handed an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) =>
      new Promise((_r, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        });
      }));
    await expect(
      handleToolCall("local_direct", { prompt: "x" }, baseConfig, ac.signal),
    ).rejects.toThrow(/cancelled by the caller/);
  });
});

describe("server.onerror wiring", () => {
  it("is actually assigned to logProtocolError, not merely defined", async () => {
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src).toMatch(/server\.onerror\s*=\s*logProtocolError/);
  });
});
