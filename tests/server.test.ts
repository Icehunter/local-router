import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildToolDefinitions,
  createServer,
  handleToolCall,
  logProtocolError,
  shouldWrapOutput,
  withRoleDescription,
} from "../src/server.js";
import type { Config } from "../src/config.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  allowedRoots: null,
  writeRoots: null,
  stateDir: null,
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

describe("handleToolCall — files/root", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "local-router-server-fa-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("rejects files/root when allowedRoots is not configured", async () => {
    writeFileSync(join(projectDir, "a.txt"), "content");
    await expect(
      handleToolCall("local_direct", { prompt: "summarize", files: ["a.txt"], root: projectDir }, baseConfig),
    ).rejects.toThrow(/not enabled/);
  });

  it("requires root when files is given", async () => {
    const cfg: Config = { ...baseConfig, allowedRoots: [projectDir] };
    await expect(
      handleToolCall("local_direct", { prompt: "summarize", files: ["a.txt"] }, cfg),
    ).rejects.toThrow(/root.*required/);
  });

  it("requires files when root is given", async () => {
    const cfg: Config = { ...baseConfig, allowedRoots: [projectDir] };
    await expect(
      handleToolCall("local_direct", { prompt: "summarize", root: projectDir }, cfg),
    ).rejects.toThrow(/`files` must be a non-empty array/);
  });

  it("rejects a root outside allowedRoots", async () => {
    const otherDir = mkdtempSync(join(tmpdir(), "local-router-server-fa-other-"));
    const cfg: Config = { ...baseConfig, allowedRoots: [otherDir] };
    try {
      await expect(
        handleToolCall("local_direct", { prompt: "summarize", files: ["a.txt"], root: projectDir }, cfg),
      ).rejects.toThrow(/outside the configured allowedRoots/);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("reads the file itself and sends its content upstream", async () => {
    writeFileSync(join(projectDir, "notes.txt"), "the important detail");
    const cfg: Config = { ...baseConfig, allowedRoots: [projectDir] };
    const fetchSpy = mockUpstream("summary of notes");
    const res = await handleToolCall(
      "local_direct",
      { prompt: "summarize this", task: "summarize", files: ["notes.txt"], root: projectDir },
      cfg,
    );
    expect(res.content[0].text).toContain("summary of notes");
    const body = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    const sentContent = body.messages.map((m: { content: string }) => m.content).join("\n");
    expect(sentContent).toContain("the important detail");
    expect(sentContent).toContain("--- file: notes.txt ---");
  });

  it("notes truncated/skipped files outside the wrapper, after the review reminder", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    writeFileSync(join(projectDir, "big.txt"), lines.join("\n"));
    writeFileSync(join(projectDir, "missing-sibling.txt"), "x");
    const cfg: Config = {
      ...baseConfig,
      allowedRoots: [projectDir],
      tokenBudget: 400,
      maxTokens: 50,
    };
    mockUpstream("diff --git a/x b/x");
    const res = await handleToolCall(
      "local_implement",
      { prompt: "implement x", files: ["big.txt", "does-not-exist.txt"], root: projectDir },
      cfg,
    );
    const text = res.content[0].text;
    expect(text).toContain("[local-router] NOTE:");
    expect(text.indexOf("</local_output")).toBeLessThan(text.indexOf("[local-router] NOTE:"));
  });

  it("errors clearly when the prompt alone already fills the budget", async () => {
    writeFileSync(join(projectDir, "a.txt"), "content");
    const cfg: Config = { ...baseConfig, allowedRoots: [projectDir], tokenBudget: 20, maxTokens: 15 };
    await expect(
      handleToolCall("local_direct", { prompt: "a".repeat(200), files: ["a.txt"], root: projectDir }, cfg),
    ).rejects.toThrow(/No token budget remains for file content/);
  });

  it("errors when none of the requested files could be read", async () => {
    const cfg: Config = { ...baseConfig, allowedRoots: [projectDir] };
    await expect(
      handleToolCall("local_direct", { prompt: "summarize", files: ["nope.txt"], root: projectDir }, cfg),
    ).rejects.toThrow(/None of the requested files could be read/);
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

describe("createServer — onerror wiring", () => {
  it("is actually assigned to logProtocolError, not merely defined", () => {
    expect(createServer(baseConfig).onerror).toBe(logProtocolError);
  });
});

describe("handleToolCall — task validation and gating", () => {
  it("rejects an unknown task and names the valid ones", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "transpile" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`task` must be one of/);
    expect(err.message).toMatch(/implement, fix, review, summarize, extract, explain, classify/);
  });

  it("allows every task when config.tasks is null", async () => {
    // "summarize" (wrap: false) rather than "implement": this test is about
    // gating, not wrapping, and the implement profile's wrap: true would make
    // a raw-text assertion collide with the wrap-precedence tests below.
    mockUpstream("ok");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "summarize" }, baseConfig);
    expect(res.content[0].text).toBe("ok");
  });

  it("rejects a task this instance does not accept, naming tier and the accepted list", async () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "implement" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      'Task "implement" is not accepted by this instance (tier: helper). ' +
        "Accepted tasks: summarize, extract. " +
        "Route this task to the instance configured for it.",
    );
  });

  it("omits the tier clause when no tier is declared", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "implement" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/not accepted by this instance\. Accepted tasks: summarize\./);
  });

  it("rejects an unknown argument name as before, now including task in the valid list", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", taks: "fix" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Unrecognized argument\(s\): taks/);
    expect(err.message).toMatch(/task/);
    expect(err.message).toMatch(/examples/);
  });

  it("omits examples from the valid-argument list when this instance cannot use it", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", taks: "fix" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).not.toMatch(/examples/);
  });

  it("still lists examples as valid when tasks is null", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", taks: "fix" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/examples/);
  });

  it("still lists examples as valid when classify is among the accepted tasks", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize", "classify"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", taks: "fix" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/examples/);
  });
});

describe("handleToolCall — tool gating", () => {
  const helper: Config = {
    ...baseConfig, tier: "helper", tasks: ["summarize", "extract", "explain", "classify"],
  };

  it("rejects local_implement on an instance that publishes only local_direct", async () => {
    const err = (await handleToolCall(
      "local_implement", { prompt: "x", task: "summarize" }, helper,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "Tool local_implement is not served by this instance (tier: helper). " +
        "No accepted task wraps its output, so local_implement and local_direct would " +
        "behave identically. Call local_direct instead.",
    );
  });

  it("omits the tier clause when no tier is declared", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const err = (await handleToolCall(
      "local_implement", { prompt: "x", task: "summarize" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/not served by this instance\. No accepted task wraps/);
  });

  it("rejects local_implement before validating its arguments", async () => {
    // The call target is wrong regardless of what the arguments say; reporting a
    // bad argument first would send the caller to fix the wrong thing.
    const err = (await handleToolCall(
      "local_implement", { prompt: "" }, helper,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/not served by this instance/);
  });

  it("still serves local_implement when config.tasks is null", async () => {
    mockUpstream("ok");
    const res = await handleToolCall("local_implement", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).toContain("ok");
  });

  it("still serves local_implement when an accepted task wraps", async () => {
    mockUpstream("ok");
    const cfg: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "explain"] };
    const res = await handleToolCall("local_implement", { prompt: "x", task: "implement" }, cfg);
    expect(res.content[0].text).toContain("ok");
  });

  it("always serves local_direct", async () => {
    mockUpstream("ok");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "summarize" }, helper);
    expect(res.content[0].text).toBe("ok");
  });
});

describe("handleToolCall — task required when gated", () => {
  const coder: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "review"] };

  it("rejects a missing task, naming the tier and the accepted list", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x" }, coder,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      "`task` is required on this instance (tier: coder). " +
        "Accepted tasks: implement, review. " +
        "This instance does not serve the no-task default, which uses a " +
        "code-generation system prompt.",
    );
  });

  it("omits the tier clause when no tier is declared", async () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const err = (await handleToolCall(
      "local_direct", { prompt: "x" }, cfg,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/^`task` is required on this instance\. Accepted tasks: summarize\./);
  });

  it("rejects local_implement for a missing task too", async () => {
    const err = (await handleToolCall(
      "local_implement", { prompt: "x" }, coder,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`task` is required on this instance/);
  });

  it("reports an unknown task as unknown rather than as missing", async () => {
    // A caller who named a task has a different mistake from one who named none;
    // collapsing both into "required" sends the first to the wrong fix.
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "transpile" }, coder,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`task` must be one of/);
  });

  it("reports a disallowed task as disallowed rather than as missing", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "summarize" }, coder,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/is not accepted by this instance/);
  });

  it("accepts a named task on a gated instance", async () => {
    mockUpstream("ok");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "review" }, coder);
    expect(res.content[0].text).toBe("ok");
  });

  it("still serves a missing task when config.tasks is null", async () => {
    mockUpstream("ok");
    const res = await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    expect(res.content[0].text).toBe("ok");
  });
});

describe("handleToolCall — classify examples", () => {
  const twoExamples = [
    { input: "rename a variable", output: "TRIVIAL" },
    { input: "rewrite the scheduler", output: "NONTRIVIAL" },
  ];

  it("rejects classify with no examples", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "classify" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`examples` is required when task is "classify"/);
    expect(err.message).toMatch(/same label for every input/);
  });

  it("rejects classify with fewer than two examples", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", task: "classify", examples: [twoExamples[0]] }, baseConfig,
    )).rejects.toThrow(/at least 2 entries/);
  });

  it("rejects examples on a non-classify task", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", task: "summarize", examples: twoExamples }, baseConfig,
    )).rejects.toThrow(/only valid with task "classify"; got task "summarize"/);
  });

  it("rejects examples with no task at all", async () => {
    await expect(handleToolCall(
      "local_direct", { prompt: "x", examples: twoExamples }, baseConfig,
    )).rejects.toThrow(/only valid with task "classify"; got task \(none\)/);
  });

  it("rejects a malformed example entry without echoing an unbounded value", async () => {
    // The 5000-char payload sits at examples[0], the entry that actually fails
    // validation first — otherwise the short() truncation this test names never
    // fires and the length assertion passes trivially.
    const err = (await handleToolCall(
      "local_direct",
      { prompt: "x", task: "classify", examples: [{ input: "b".repeat(5000), output: "" }, { input: "a", output: "B" }] },
      baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`examples\[0\]` must be an object with non-empty string/);
    expect(err.message.length).toBeLessThan(400);
  });

  it("sends the examples upstream as alternating turns", async () => {
    const fetchSpy = mockUpstream("TRIVIAL");
    await handleToolCall(
      "local_direct", { prompt: "add a log line", task: "classify", examples: twoExamples }, baseConfig,
    );
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      "system", "user", "assistant", "user", "assistant", "user",
    ]);
    expect(body.messages[1].content).toBe(twoExamples[0].input);
    expect(body.messages[2].content).toBe(twoExamples[0].output);
    expect(body.messages[3].content).toBe(twoExamples[1].input);
    expect(body.messages[4].content).toBe(twoExamples[1].output);
  });

  it("accepts exactly 50 examples", async () => {
    mockUpstream("TRIVIAL");
    const fifty = Array.from({ length: 50 }, (_, i) => ({ input: `in ${i}`, output: `out ${i}` }));
    await expect(handleToolCall(
      "local_direct", { prompt: "x", task: "classify", examples: fifty }, baseConfig,
    )).resolves.toBeDefined();
  });

  it("rejects 51 examples, naming the cap", async () => {
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ input: `in ${i}`, output: `out ${i}` }));
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "classify", examples: fiftyOne }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/at most 50 entries/);
    expect(err.message).toMatch(/got 51/);
  });

  it("rejects an example entry with an unrecognized key", async () => {
    const err = (await handleToolCall(
      "local_direct",
      { prompt: "x", task: "classify", examples: [{ ...twoExamples[0], extra: 1 }, twoExamples[1]] },
      baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`examples\[0\]`/);
    expect(err.message).toMatch(/extra/);
  });

  it("does not echo unbounded example key names in the error", async () => {
    const hostileKey = "x".repeat(5000);
    const err = (await handleToolCall(
      "local_direct",
      { prompt: "x", task: "classify", examples: [{ ...twoExamples[0], [hostileKey]: "value" }, twoExamples[1]] },
      baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toMatch(/`examples\[0\]`/);
    expect(err.message).toMatch(/has unrecognized key/);
  });
});

describe("handleToolCall — max_lines", () => {
  it("rejects max_lines on implement, naming the accepting tasks", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "implement", max_lines: 3 }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      '`max_lines` is only valid with task "review", "summarize", "extract"; got task "implement".',
    );
  });

  it("rejects max_lines on fix", async () => {
    await expect(
      handleToolCall("local_direct", { prompt: "x", task: "fix", max_lines: 3 }, baseConfig),
    ).rejects.toThrow(/`max_lines` is only valid with task "review", "summarize", "extract"; got task "fix"\./);
  });

  it("rejects max_lines on explain", async () => {
    await expect(
      handleToolCall("local_direct", { prompt: "x", task: "explain", max_lines: 3 }, baseConfig),
    ).rejects.toThrow(/got task "explain"\./);
  });

  it("rejects max_lines on classify", async () => {
    await expect(
      handleToolCall(
        "local_direct",
        { prompt: "x", task: "classify", max_lines: 3, examples: [
          { input: "a", output: "A" }, { input: "b", output: "B" },
        ] },
        baseConfig,
      ),
    ).rejects.toThrow(/got task "classify"\./);
  });

  it("rejects max_lines with no task at all", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", max_lines: 3 }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toBe(
      '`max_lines` is only valid with task "review", "summarize", "extract"; got task (none).',
    );
  });

  it.each([0, -1, 1.5, NaN])("rejects max_lines = %s", async (bad) => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "summarize", max_lines: bad }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`max_lines` must be a positive integer/);
  });

  it("rejects a string max_lines", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "summarize", max_lines: "3" }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`max_lines` must be a positive integer/);
  });

  it("rejects Infinity", async () => {
    const err = (await handleToolCall(
      "local_direct", { prompt: "x", task: "summarize", max_lines: Infinity }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/`max_lines` must be a positive integer/);
  });

  it("accepts a valid max_lines on summarize and sends it through to the prompt", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "summarize", max_lines: 4 }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    const userMsg = body.messages[body.messages.length - 1].content as string;
    expect(userMsg.endsWith("Output at most 4 lines. Count them before you answer.")).toBe(true);
  });

  it("accepts a valid max_lines on extract and review", async () => {
    mockUpstream("ok");
    await expect(
      handleToolCall("local_direct", { prompt: "x", task: "extract", max_lines: 2 }, baseConfig),
    ).resolves.toBeDefined();
    await expect(
      handleToolCall("local_direct", { prompt: "x", task: "review", max_lines: 2 }, baseConfig),
    ).resolves.toBeDefined();
  });
});

describe("handleToolCall — task sampling overrides", () => {
  it("sends the profile temperature instead of the config temperature", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "summarize" }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.temperature).toBe(0);
  });

  it("sends the config temperature and maxTokens when there is no task", async () => {
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x" }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(16000);
  });

  it("lowers max_tokens to the profile cap", async () => {
    // classify requires >= 2 examples (see "classify examples" above); this
    // test is about the max_tokens override, so it supplies the minimum valid set.
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "classify", examples: [
      { input: "a", output: "A" }, { input: "b", output: "B" },
    ] }, baseConfig);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(50);
  });

  it("never raises max_tokens above the configured ceiling", async () => {
    const cfg: Config = { ...baseConfig, maxTokens: 20 };
    const fetchSpy = mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x", task: "review" }, cfg);
    const body = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(20);
  });

  it("reserves only the effective maxTokens in the budget precondition", async () => {
    // 510000 bytes of ASCII puts estimateTokens (ceil(bytes/3)) at ~170K on
    // baseConfig's stock tokenBudget/maxTokens (180000/16000) — a pair loadConfig
    // actually accepts, unlike an inflated maxTokens >= tokenBudget config.
    // No task: ~170K + config.maxTokens (16000) clears the 180000 budget → rejected.
    // task "review": the profile caps maxTokens at 1500, so ~170K + 1500 fits → accepted.
    const bigPrompt = "a".repeat(510000);
    const err = (await handleToolCall(
      "local_direct", { prompt: bigPrompt }, baseConfig,
    ).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/Prompt exceeds tokenBudget/);

    mockUpstream("NONE");
    const res = await handleToolCall(
      "local_direct", { prompt: bigPrompt, task: "review" }, baseConfig,
    );
    expect(res.content[0].text).toBe("NONE");
  });

  it("names the effective maxTokens in the truncation warning", async () => {
    mockUpstream("cut off", "length");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "classify", examples: [
      { input: "a", output: "A" }, { input: "b", output: "B" },
    ] }, baseConfig);
    expect(res.content[0].text).toMatch(/stopped at max_tokens \(50\)/);
  });
});

describe("handleToolCall — task wrapping defaults", () => {
  it("wraps a fix on local_direct because the profile says so", async () => {
    mockUpstream("code");
    const res = await handleToolCall("local_direct", { prompt: "x", task: "fix" }, baseConfig);
    expect(res.content[0].text).toContain("<local_output");
  });

  it("does not wrap a review on local_implement because the profile says so", async () => {
    mockUpstream("NONE");
    const res = await handleToolCall("local_implement", { prompt: "x", task: "review" }, baseConfig);
    expect(res.content[0].text).toBe("NONE");
  });

  it("mode still outranks the profile", async () => {
    mockUpstream("NONE");
    const res = await handleToolCall(
      "local_implement", { prompt: "x", task: "review", mode: "delegate" }, baseConfig);
    expect(res.content[0].text).toContain("<local_output");
  });

  it("include_review_reminder still outranks everything", async () => {
    mockUpstream("code");
    const res = await handleToolCall(
      "local_direct",
      { prompt: "x", task: "fix", mode: "delegate", include_review_reminder: false },
      baseConfig,
    );
    expect(res.content[0].text).toBe("code");
  });
});

describe("buildToolDefinitions", () => {
  // `properties` is typed Record<string, unknown>, so strict mode rejects a bare
  // `.minItems` on a member. Both helpers cast once, here, rather than at each use.
  function prop(tool: { inputSchema: Record<string, any> }, name: string): any {
    return tool.inputSchema.properties[name];
  }
  function taskEnum(tool: { inputSchema: Record<string, any> }): string[] {
    return prop(tool, "task").enum;
  }

  it("publishes every task when config.tasks is null", () => {
    const [implement, direct] = buildToolDefinitions(baseConfig);
    expect(taskEnum(implement)).toEqual([
      "implement", "fix", "review", "summarize", "extract", "explain", "classify",
    ]);
    expect(taskEnum(direct)).toEqual(taskEnum(implement));
  });

  it("publishes only the allowed tasks", () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const [implement] = buildToolDefinitions(cfg);
    expect(taskEnum(implement)).toEqual(["summarize", "extract"]);
  });

  it("omits the examples property from every published tool when classify is not allowed", () => {
    const cfg: Config = { ...baseConfig, tasks: ["summarize"] };
    const tools = buildToolDefinitions(cfg);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(prop(tool, "examples")).toBeUndefined();
  });

  it("includes the examples property on every published tool when classify is allowed", () => {
    const cfg: Config = { ...baseConfig, tasks: ["classify"] };
    const tools = buildToolDefinitions(cfg);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(prop(tool, "examples").minItems).toBe(2);
  });

  it("appends the tier line to every published tool description", () => {
    const cfg: Config = { ...baseConfig, tier: "helper", tasks: ["summarize", "extract"] };
    const tools = buildToolDefinitions(cfg);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.description).toContain("Tier: helper. Accepts: summarize, extract.");
    }
  });

  it("appends the tier line to both descriptions when both tools are published", () => {
    const cfg: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "review"] };
    const [implement, direct] = buildToolDefinitions(cfg);
    expect(implement.description).toContain("Tier: coder. Accepts: implement, review.");
    expect(direct.description).toContain("Tier: coder. Accepts: implement, review.");
  });

  it("appends no tier line when neither tier nor tasks is declared", () => {
    const [implement] = buildToolDefinitions(baseConfig);
    expect(implement.description).not.toContain("Tier:");
    expect(implement.description).not.toContain("Accepts:");
  });

  it("still carries the toolDescription suffix ahead of the tier line", () => {
    const cfg: Config = { ...baseConfig, toolDescription: "the 4B box", tier: "helper" };
    const [implement] = buildToolDefinitions(cfg);
    expect(implement.description).toMatch(/THIS INSTANCE: the 4B box.*Tier: helper\./s);
  });

  it("marks task required in the schema when this instance is gated", () => {
    const cfg: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "review"] };
    for (const tool of buildToolDefinitions(cfg)) {
      expect(tool.inputSchema.required).toEqual(["prompt", "task"]);
      expect(prop(tool, "task").description).toMatch(/Required on this instance\./);
      expect(prop(tool, "task").description).not.toMatch(/Omit for/);
    }
  });

  it("leaves task optional in the schema when config.tasks is null", () => {
    for (const tool of buildToolDefinitions(baseConfig)) {
      expect(tool.inputSchema.required).toEqual(["prompt"]);
      expect(prop(tool, "task").description).toMatch(/Omit for the legacy code-generation default\./);
    }
  });

  it("keeps the two tool names stable", () => {
    const [implement, direct] = buildToolDefinitions(baseConfig);
    expect(implement.name).toBe("local_implement");
    expect(direct.name).toBe("local_direct");
  });

  it("publishes max_lines when config.tasks is null", () => {
    const [implement, direct] = buildToolDefinitions(baseConfig);
    expect(prop(implement, "max_lines")).toEqual({
      type: "integer",
      minimum: 1,
      description: expect.any(String),
    });
    expect(prop(direct, "max_lines")).toBeDefined();
  });

  it("publishes max_lines when at least one accepting task is allowed", () => {
    const cfg: Config = { ...baseConfig, tasks: ["implement", "summarize"] };
    const [implement] = buildToolDefinitions(cfg);
    expect(prop(implement, "max_lines")).toBeDefined();
  });

  it("omits max_lines from every published tool when the allowlist has no accepting task", () => {
    const cfg: Config = { ...baseConfig, tasks: ["classify"] };
    const tools = buildToolDefinitions(cfg);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(prop(tool, "max_lines")).toBeUndefined();
  });

  it("publishes both tools when config.tasks is null", () => {
    expect(buildToolDefinitions(baseConfig).map((t) => t.name)).toEqual([
      "local_implement", "local_direct",
    ]);
  });

  it("publishes both tools when an accepted task wraps", () => {
    const cfg: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "review"] };
    expect(buildToolDefinitions(cfg).map((t) => t.name)).toEqual([
      "local_implement", "local_direct",
    ]);
  });

  it("publishes only local_direct when no accepted task wraps", () => {
    // local_implement's only remaining job is its wrapping default. With every
    // accepted task non-wrapping, the two tools are identical for every call
    // that names a task, and the name selects nothing but the no-task
    // code-generation default — the wrong default on a tier serving no code task.
    const cfg: Config = {
      ...baseConfig, tier: "helper", tasks: ["summarize", "extract", "explain", "classify"],
    };
    expect(buildToolDefinitions(cfg).map((t) => t.name)).toEqual(["local_direct"]);
  });

  it("publishes only local_direct when fix is the sole wrapping task excluded", () => {
    const cfg: Config = { ...baseConfig, tasks: ["review", "explain"] };
    expect(buildToolDefinitions(cfg).map((t) => t.name)).toEqual(["local_direct"]);
  });

  it("does not promise local_direct unconditional raw output", () => {
    // shouldWrapOutput ranks profile.wrap above the tool name, so local_direct
    // with task "implement" or "fix" still wraps unless overridden.
    const [, direct] = buildToolDefinitions(baseConfig);
    expect(direct.description).toContain("by default without review wrapping");
    expect(direct.description).not.toContain("return the raw response without review wrapping");
  });

  it("omits files/root from the schema and appends the no-FS line when allowedRoots is null", () => {
    const [implement] = buildToolDefinitions(baseConfig);
    expect(prop(implement, "files")).toBeUndefined();
    expect(prop(implement, "root")).toBeUndefined();
    expect(implement.description).toContain("has no filesystem access");
  });

  it("publishes files/root and appends the FS-enabled line when allowedRoots is set", () => {
    const cfg: Config = { ...baseConfig, allowedRoots: ["/repo"] };
    const tools = buildToolDefinitions(cfg);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(prop(tool, "files")).toBeDefined();
      expect(prop(tool, "root")).toBeDefined();
      expect(tool.description).toContain("reads files itself");
    }
  });

  it("the max_lines description only lists tasks this instance actually accepts", () => {
    const cfg: Config = { ...baseConfig, tasks: ["review", "explain"] };
    const tools = buildToolDefinitions(cfg);
    const tool = tools[0];
    const p = prop(tool, "max_lines");
    expect(p.description).toContain('task "review"');
    expect(p.description).not.toContain('task "summarize"');
    expect(p.description).not.toContain('task "extract"');
  });

  it("appends a budget line stating the real per-call input budget in tokens and KB", () => {
    const tools = buildToolDefinitions(baseConfig);
    for (const tool of tools) {
      expect(tool.description).toContain("about 164000 tokens");
      expect(tool.description).toContain("480 KB");
      expect(tool.description).toContain("up to 16000 tokens");
    }
  });
});

describe("createServer — ListTools wiring", () => {
  // Connects a real Client to createServer(config) over an in-memory transport
  // and calls the actual listTools request, rather than asserting on server.ts's
  // source text: a source-regex test stays green even if the handler stops
  // calling buildToolDefinitions(config) and starts serving something stale.
  async function listToolsOver(config: Config) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(config);
    const client = new Client({ name: "test-client", version: "0.1.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    return tools;
  }

  it("publishes the full task enum and no tier line when config.tasks is null", async () => {
    const tools = await listToolsOver(baseConfig);
    const implement = tools.find((t) => t.name === "local_implement")!;
    expect((implement.inputSchema.properties as Record<string, any>).task.enum).toEqual([
      "implement", "fix", "review", "summarize", "extract", "explain", "classify",
    ]);
    expect(implement.description).not.toContain("Tier:");
  });

  it("lists only local_direct over the wire for a non-wrapping instance", async () => {
    const cfg: Config = {
      ...baseConfig, tier: "helper", tasks: ["summarize", "extract", "explain", "classify"],
    };
    const tools = await listToolsOver(cfg);
    expect(tools.map((t) => t.name)).toEqual(["local_direct"]);
  });

  it("publishes only the allowlisted tasks and the tier line for a narrow config", async () => {
    const cfg: Config = { ...baseConfig, tier: "coder", tasks: ["implement", "review"] };
    const tools = await listToolsOver(cfg);
    const implement = tools.find((t) => t.name === "local_implement")!;
    const direct = tools.find((t) => t.name === "local_direct")!;
    expect((implement.inputSchema.properties as Record<string, any>).task.enum).toEqual([
      "implement", "review",
    ]);
    expect(implement.description).toContain("Tier: coder. Accepts: implement, review.");
    expect(direct.description).toContain("Tier: coder. Accepts: implement, review.");
  });
});

describe("handleToolCall — usage ledger", () => {
  let stateDir: string;

  function readLedgerLines(dir: string): any[] {
    const path = join(dir, "usage.jsonl");
    const text = readFileSync(path, "utf8");
    return text.trim().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "local-router-ledger-int-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes exactly one line with outcome 'ok' on a successful call", async () => {
    mockUpstream("hello");
    const cfg: Config = { ...baseConfig, stateDir, tier: "coder" };
    await handleToolCall("local_direct", { prompt: "x" }, cfg, undefined, "test-client 1.0");

    const lines = readLedgerLines(stateDir);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.outcome).toBe("ok");
    expect(entry.tool).toBe("local_direct");
    expect(entry.tier).toBe("coder");
    expect(entry.client).toBe("test-client 1.0");
    expect(entry.bytes_out).toBeGreaterThan(0);
  });

  it("writes outcome 'rejected' for a validation error that never reaches the upstream, without calling fetch", async () => {
    const fetchSpy = mockUpstream("unused");
    await handleToolCall("local_direct", { prompt: "x", output_format: "bogus" }, { ...baseConfig, stateDir }).catch(() => {});

    expect(fetchSpy).not.toHaveBeenCalled();
    const lines = readLedgerLines(stateDir);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("rejected");
  });

  it("writes outcome 'error' for a failure that happens after the upstream call was attempted", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    await handleToolCall("local_direct", { prompt: "x" }, { ...baseConfig, stateDir }).catch(() => {});

    const lines = readLedgerLines(stateDir);
    expect(lines).toHaveLength(1);
    expect(lines[0].outcome).toBe("error");
  });

  it("writes no file at all when stateDir is null", async () => {
    mockUpstream("ok");
    await handleToolCall("local_direct", { prompt: "x" }, baseConfig);

    expect(existsSync(join(stateDir, "usage.jsonl"))).toBe(false);
  });

  it("the ledger line's prompt_bytes reflects the caller's prompt", async () => {
    mockUpstream("ok");
    const prompt = "a".repeat(37);
    await handleToolCall("local_direct", { prompt }, { ...baseConfig, stateDir });

    const lines = readLedgerLines(stateDir);
    expect(lines).toHaveLength(1);
    expect(lines[0].prompt_bytes).toBe(37);
  });

  it("records upstream prompt_tokens/completion_tokens and finish_reason when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 55, completion_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await handleToolCall("local_direct", { prompt: "x" }, { ...baseConfig, stateDir });

    const lines = readLedgerLines(stateDir);
    expect(lines).toHaveLength(1);
    expect(lines[0].prompt_tokens).toBe(55);
    expect(lines[0].completion_tokens).toBe(7);
    expect(lines[0].finish_reason).toBe("stop");
  });
});

describe("handleToolCall — apply mode reply parsing", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "lr-apply-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const applyConfig = () => ({ ...baseConfig, allowedRoots: [root], writeRoots: [root] });
  const applyArgs = () => ({ prompt: "write it", task: "implement", root, targets: ["scripts/a.sh"] });

  it("refuses with an excerpt when the reply has no FILE or EDIT blocks", async () => {
    mockUpstream("```bash\n#!/usr/bin/env bash\necho hi\n```");
    const res = await handleToolCall("local_implement", applyArgs(), applyConfig());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("REFUSED: the model's reply had no FILE or EDIT blocks");
    expect(res.content[0].text).toContain("echo hi");
    expect(existsSync(join(root, "scripts/a.sh"))).toBe(false);
  });

  it("writes a new file from a FILE block", async () => {
    mockUpstream("=== FILE: scripts/a.sh ===\necho hi\n=== END FILE ===");
    const res = await handleToolCall("local_implement", applyArgs(), applyConfig());
    expect(res.content[0].text).toContain("APPLIED");
    expect(readFileSync(join(root, "scripts/a.sh"), "utf8")).toContain("echo hi");
  });
});
