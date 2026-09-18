import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tempDir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "local-cfg-"));
  process.env.CLAUDE_PLUGIN_ROOT = tempDir;
  delete process.env.LOCAL_LLM_BASE_URL;
  delete process.env.LOCAL_LLM_MODEL;
  delete process.env.LOCAL_LLM_API_KEY;
  delete process.env.LOCAL_LLM_TOKEN_BUDGET;
  delete process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS;
  delete process.env.LOCAL_LLM_TEMPERATURE;
  delete process.env.LOCAL_LLM_TOP_P;
  delete process.env.LOCAL_LLM_TOP_K;
  delete process.env.LOCAL_LLM_MIN_P;
  delete process.env.LOCAL_LLM_REPEAT_PENALTY;
  delete process.env.LOCAL_LLM_MAX_TOKENS;
  delete process.env.LOCAL_LLM_DEBUG_LOG_PATH;
  delete process.env.LOCAL_LLM_ENABLE_THINKING;
  delete process.env.LOCAL_LLM_TOOL_DESCRIPTION;
  delete process.env.LOCAL_LLM_TIER;
  delete process.env.LOCAL_LLM_TASKS;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  Object.assign(process.env, origEnv);
});

describe("loadConfig", () => {
  it("loads config.json when present", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        baseUrl: "http://1.2.3.4:1234",
        model: "qwen3-coder",
      }),
    );
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://1.2.3.4:1234");
    expect(cfg.model).toBe("qwen3-coder");
    expect(cfg.tokenBudget).toBe(180000); // default
    expect(cfg.requestTimeoutMs).toBe(300000); // default
    expect(cfg.apiKey).toBeNull();
  });

  it("env vars override config file", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://file:1234", model: "file-model" }),
    );
    process.env.LOCAL_LLM_BASE_URL = "http://env:1234";
    process.env.LOCAL_LLM_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("works with env vars only (no config file)", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://env:1234";
    process.env.LOCAL_LLM_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("strips trailing slash from baseUrl", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://host:1234/";
    process.env.LOCAL_LLM_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://host:1234");
  });

  it("throws clearly when baseUrl is missing", () => {
    process.env.LOCAL_LLM_MODEL = "m";
    expect(() => loadConfig()).toThrow(/baseUrl/);
  });

  it("throws clearly when model is missing", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    expect(() => loadConfig()).toThrow(/model/);
  });

  it("parses numeric env vars", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOKEN_BUDGET = "100000";
    process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS = "60000";
    const cfg = loadConfig();
    expect(cfg.tokenBudget).toBe(100000);
    expect(cfg.requestTimeoutMs).toBe(60000);
  });

  it("throws a clear error when LOCAL_LLM_TOKEN_BUDGET is not numeric", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOKEN_BUDGET = "abc";
    expect(() => loadConfig()).toThrow(/LOCAL_LLM_TOKEN_BUDGET must be a number.*"abc"/);
  });

  it("throws a clear error when LOCAL_LLM_REQUEST_TIMEOUT_MS is not numeric", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS = "xyz";
    expect(() => loadConfig()).toThrow(/LOCAL_LLM_REQUEST_TIMEOUT_MS must be a number.*"xyz"/);
  });

  it("includes code-friendly sampling defaults", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.topP).toBe(0.8);
    expect(cfg.topK).toBe(20);
    expect(cfg.minP).toBe(0.05);
    expect(cfg.repeatPenalty).toBe(1.1);
  });

  it("env vars override sampling defaults", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TEMPERATURE = "0.8";
    process.env.LOCAL_LLM_TOP_P = "0.9";
    process.env.LOCAL_LLM_TOP_K = "40"; // distinct from the default of 20
    process.env.LOCAL_LLM_MIN_P = "0.1";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0.8);
    expect(cfg.topP).toBe(0.9);
    expect(cfg.topK).toBe(40);
    expect(cfg.minP).toBe(0.1);
  });

  it("rejects out-of-range sampling values", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOP_P = "1.5"; // out of [0,1]
    expect(() => loadConfig()).toThrow(/topP/);
  });

  it("throws clear error when sampling env var is non-numeric", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TEMPERATURE = "hot";
    expect(() => loadConfig()).toThrow(/LOCAL_LLM_TEMPERATURE must be a number.*"hot"/);
  });

  it("treats LOCAL_LLM_TOP_K=\"0\" as a real override (not falsy default)", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOP_K = "0";
    const cfg = loadConfig();
    expect(cfg.topK).toBe(0);
  });

  it("treats LOCAL_LLM_TEMPERATURE=\"0\" as a real override (not falsy default)", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TEMPERATURE = "0";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0);
  });

  it("env var LOCAL_LLM_REPEAT_PENALTY overrides default", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REPEAT_PENALTY = "1.2";
    const cfg = loadConfig();
    expect(cfg.repeatPenalty).toBe(1.2);
  });

  it("rejects out-of-range repeatPenalty", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REPEAT_PENALTY = "5"; // out of [0, 2]
    expect(() => loadConfig()).toThrow(/repeatPenalty/);
  });

  it("throws clear error when LOCAL_LLM_REPEAT_PENALTY is non-numeric", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REPEAT_PENALTY = "high";
    expect(() => loadConfig()).toThrow(/LOCAL_LLM_REPEAT_PENALTY must be a number.*"high"/);
  });

  it("includes maxTokens default of 16000", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(16000);
  });

  it("env var LOCAL_LLM_MAX_TOKENS overrides default", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_MAX_TOKENS = "32000";
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(32000);
  });

  it("env var LOCAL_LLM_DEBUG_LOG_PATH sets debugLogPath", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_DEBUG_LOG_PATH = "/tmp/local.log";
    const cfg = loadConfig();
    expect(cfg.debugLogPath).toBe("/tmp/local.log");
  });

  it("debugLogPath defaults to null", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.debugLogPath).toBeNull();
  });
});

describe("loadConfig — empty and unexpanded env values", () => {
  const NUMERIC_VARS = [
    ["LOCAL_LLM_TOKEN_BUDGET", "tokenBudget", 180000],
    ["LOCAL_LLM_REQUEST_TIMEOUT_MS", "requestTimeoutMs", 300000],
    ["LOCAL_LLM_MAX_TOKENS", "maxTokens", 16000],
    ["LOCAL_LLM_TEMPERATURE", "temperature", 0.7],
    ["LOCAL_LLM_TOP_P", "topP", 0.8],
    ["LOCAL_LLM_TOP_K", "topK", 20],
    ["LOCAL_LLM_MIN_P", "minP", 0.05],
    ["LOCAL_LLM_REPEAT_PENALTY", "repeatPenalty", 1.1],
  ] as const;

  for (const [envVar, key, expected] of NUMERIC_VARS) {
    it(`treats ${envVar}="" as unset, not as 0`, () => {
      process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
      process.env.LOCAL_LLM_MODEL = "m";
      process.env[envVar] = "";
      expect(loadConfig()[key]).toBe(expected);
    });

    it(`treats ${envVar}="   " as unset, not as 0`, () => {
      process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
      process.env.LOCAL_LLM_MODEL = "m";
      process.env[envVar] = "   ";
      expect(loadConfig()[key]).toBe(expected);
    });

    it(`still rejects an unexpanded \${${envVar}} placeholder`, () => {
      process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
      process.env.LOCAL_LLM_MODEL = "m";
      process.env[envVar] = `\${${envVar}}`;
      expect(() => loadConfig()).toThrow(
        new RegExp(`${envVar} looks like an unexpanded placeholder`),
      );
    });
  }

  it("treats LOCAL_LLM_BASE_URL=\"\" as unset so config.json still applies", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://file:1234", model: "file-model" }),
    );
    process.env.LOCAL_LLM_BASE_URL = "";
    process.env.LOCAL_LLM_MODEL = "";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://file:1234");
    expect(cfg.model).toBe("file-model");
  });
});

describe("loadConfig — config.json discovery diagnostics", () => {
  it("says CLAUDE_PLUGIN_ROOT is unset rather than naming a file it never read", () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;
    let message = "";
    try {
      loadConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/CLAUDE_PLUGIN_ROOT is not set/);
    expect(message).not.toMatch(/undefined\/config\.json/);
  });

  it("names the path it checked when CLAUDE_PLUGIN_ROOT is set but no file exists", () => {
    let message = "";
    try {
      loadConfig();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(join(tempDir, "config.json"));
  });
});

describe("loadConfig — empty means disabled for optional paths", () => {
  it("treats LOCAL_LLM_DEBUG_LOG_PATH=\"\" as an explicit disable, overriding config.json", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        baseUrl: "http://x:1234",
        model: "m",
        debugLogPath: "/tmp/from-file.log",
      }),
    );
    process.env.LOCAL_LLM_DEBUG_LOG_PATH = "";
    expect(loadConfig().debugLogPath).toBeNull();
  });

  it("treats LOCAL_LLM_API_KEY=\"\" as an explicit disable, overriding config.json", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({
        baseUrl: "http://x:1234",
        model: "m",
        apiKey: "from-file",
      }),
    );
    process.env.LOCAL_LLM_API_KEY = "";
    expect(loadConfig().apiKey).toBeNull();
  });
});

describe("loadConfig — baseUrl normalization", () => {
  it.each([
    ["http://host:1234", "http://host:1234"],
    ["http://host:1234/", "http://host:1234"],
    ["http://host:1234/v1", "http://host:1234"],
    ["http://host:1234/v1/", "http://host:1234"],
  ])("normalizes %s to %s", (input, expected) => {
    process.env.LOCAL_LLM_BASE_URL = input;
    process.env.LOCAL_LLM_MODEL = "m";
    expect(loadConfig().baseUrl).toBe(expected);
  });

  it("does not strip a path segment that merely ends in v1", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://host:1234/api/openaiv1";
    process.env.LOCAL_LLM_MODEL = "m";
    expect(loadConfig().baseUrl).toBe("http://host:1234/api/openaiv1");
  });
});

describe("loadConfig — malformed config.json", () => {
  it("reports the file and the parse error rather than silently ignoring it", () => {
    writeFileSync(join(tempDir, "config.json"), '{"baseUrl": "http://x:1234",,}');
    expect(() => loadConfig()).toThrow(
      new RegExp(`Failed to parse ${join(tempDir, "config.json").replace(/[/\\]/g, "\\$&")}`),
    );
  });

  it("does not fall back to env vars when config.json is malformed", () => {
    writeFileSync(join(tempDir, "config.json"), "not json at all");
    process.env.LOCAL_LLM_BASE_URL = "http://env:1234";
    process.env.LOCAL_LLM_MODEL = "env-model";
    expect(() => loadConfig()).toThrow(/Failed to parse/);
  });
});

describe("loadConfig — requestTimeoutMs overflow guard", () => {
  it("rejects a value that would overflow setTimeout", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS = "9999999999";
    expect(() => loadConfig()).toThrow(/requestTimeoutMs.*at most 2147483647/s);
  });

  it("accepts the largest safe value", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_REQUEST_TIMEOUT_MS = "2147483647";
    expect(loadConfig().requestTimeoutMs).toBe(2147483647);
  });

  it("rejects an overflowing value from config.json too", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", requestTimeoutMs: 86400000000 }),
    );
    expect(() => loadConfig()).toThrow(/requestTimeoutMs.*at most 2147483647/s);
  });
});

describe("loadConfig — unrecognized config.json keys", () => {
  it("warns naming the dropped keys instead of silently discarding them", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", max_tokens: 99, temp: 1.5 }),
    );
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(16000); // still dropped, but no longer silently
    const msg = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("max_tokens");
    expect(msg).toContain("temp");
    expect(msg).toContain(join(tempDir, "config.json"));
    warn.mockRestore();
  });

  it("stays quiet when every key is recognized", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", maxTokens: 99 }),
    );
    expect(loadConfig().maxTokens).toBe(99);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("loadConfig — enableThinking", () => {
  it("defaults to null so nothing is sent on the wire", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    expect(loadConfig().enableThinking).toBeNull();
  });

  it.each([
    ["true", true], ["TRUE", true], ["1", true],
    ["false", false], ["False", false], ["0", false],
  ])("parses LOCAL_LLM_ENABLE_THINKING=%s as %s", (raw, expected) => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_ENABLE_THINKING = raw as string;
    expect(loadConfig().enableThinking).toBe(expected);
  });

  it("rejects a non-boolean value rather than guessing", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_ENABLE_THINKING = "yes";
    expect(() => loadConfig()).toThrow(/LOCAL_LLM_ENABLE_THINKING must be true or false, got: "yes"/);
  });

  it("treats a blank value as unset so config.json still applies", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", enableThinking: false }),
    );
    process.env.LOCAL_LLM_ENABLE_THINKING = "";
    expect(loadConfig().enableThinking).toBe(false);
  });

  it("still rejects an unexpanded ${LOCAL_LLM_ENABLE_THINKING} placeholder", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_ENABLE_THINKING = "${LOCAL_LLM_ENABLE_THINKING}";
    expect(() => loadConfig()).toThrow(/looks like an unexpanded placeholder/);
  });
});

describe("loadConfig — toolDescription", () => {
  it("defaults to null", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    expect(loadConfig().toolDescription).toBeNull();
  });

  it("is set from LOCAL_LLM_TOOL_DESCRIPTION", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOOL_DESCRIPTION = "0.8B CPU helper. Summarizing only.";
    expect(loadConfig().toolDescription).toBe("0.8B CPU helper. Summarizing only.");
  });

  it("treats a blank value as unset", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", toolDescription: "from file" }),
    );
    process.env.LOCAL_LLM_TOOL_DESCRIPTION = "";
    expect(loadConfig().toolDescription).toBe("from file");
  });
});

describe("loadConfig — unexpanded ${VAR} placeholders", () => {
  const PLACEHOLDER_VARS = [
    "LOCAL_LLM_MODEL",
    "LOCAL_LLM_API_KEY",
    "LOCAL_LLM_DEBUG_LOG_PATH",
    "LOCAL_LLM_TOOL_DESCRIPTION",
    "LOCAL_LLM_TIER",
    "LOCAL_LLM_TASKS",
  ] as const;

  for (const v of PLACEHOLDER_VARS) {
    it(`rejects a literal \${${v}} instead of using it as a value`, () => {
      process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
      process.env.LOCAL_LLM_MODEL = "m";
      process.env[v] = `\${${v}}`;
      expect(() => loadConfig()).toThrow(
        new RegExp(`${v} looks like an unexpanded`),
      );
    });
  }

  it("still treats an explicit empty API key as disabled, not as a placeholder", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", apiKey: "from-file" }),
    );
    process.env.LOCAL_LLM_API_KEY = "";
    expect(loadConfig().apiKey).toBeNull();
  });

  it("treats a whitespace-only API key as disabled rather than sending it", () => {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://x:1234", model: "m", apiKey: "from-file" }),
    );
    process.env.LOCAL_LLM_API_KEY = "   ";
    expect(loadConfig().apiKey).toBeNull();
  });

  it("treats a whitespace-only debug log path as disabled rather than a real path", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_DEBUG_LOG_PATH = "   ";
    expect(loadConfig().debugLogPath).toBeNull();
  });

  it("keeps a real API key untouched", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_API_KEY = "sk-real-key";
    expect(loadConfig().apiKey).toBe("sk-real-key");
  });
});

describe("loadConfig — hostile config.json shapes", () => {
  it.each(["null", '"a string"', "[1,2,3]", "42", "true"])(
    "reports a non-object config.json (%s) instead of throwing a TypeError",
    (body) => {
      writeFileSync(join(tempDir, "config.json"), body);
      const err = (() => { try { loadConfig(); return null; } catch (e) { return e as Error; } })();
      expect(err).not.toBeNull();
      expect(err!.constructor.name).toBe("Error");
      expect(err!.message).toMatch(/must contain a JSON object/);
    },
  );

  it("reports a directory at config.json as a read failure, not a parse failure", () => {
    mkdirSync(join(tempDir, "config.json"));
    expect(() => loadConfig()).toThrow(/Failed to read/);
  });
});

describe("loadConfig — cross-field validation", () => {
  it("rejects maxTokens that leaves no room inside tokenBudget", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOKEN_BUDGET = "8000";
    process.env.LOCAL_LLM_MAX_TOKENS = "8000";
    expect(() => loadConfig()).toThrow(/maxTokens \(8000\) must be less than tokenBudget \(8000\)/);
  });

  it("rejects maxTokens larger than tokenBudget", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOKEN_BUDGET = "4000";
    process.env.LOCAL_LLM_MAX_TOKENS = "16000";
    expect(() => loadConfig()).toThrow(/maxTokens \(16000\) must be less than tokenBudget \(4000\)/);
  });

  it("accepts a maxTokens that leaves room", () => {
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_TOKEN_BUDGET = "30000";
    process.env.LOCAL_LLM_MAX_TOKENS = "8000";
    expect(loadConfig().maxTokens).toBe(8000);
  });
});

describe("loadConfig — baseUrl /v1 stripping is path-scoped", () => {
  it.each([
    ["http://host:1234/v1", "http://host:1234"],
    ["http://host:1234/api/v1", "http://host:1234/api"],
    ["http://v1", "http://v1"],
    ["http://host/v1", "http://host"],
  ])("normalizes %s to %s", (input, expected) => {
    process.env.LOCAL_LLM_BASE_URL = input;
    process.env.LOCAL_LLM_MODEL = "m";
    expect(loadConfig().baseUrl).toBe(expected);
  });
});

describe("loadConfig — misspelled env vars", () => {
  it("warns about a LOCAL_LLM_* variable that is not recognized", () => {
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.env.LOCAL_LLM_BASE_URL = "http://x:1234";
    process.env.LOCAL_LLM_MODEL = "m";
    process.env.LOCAL_LLM_MAXTOKENS = "4000"; // missing underscore
    loadConfig();
    const msg = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("LOCAL_LLM_MAXTOKENS");
    warn.mockRestore();
    delete process.env.LOCAL_LLM_MAXTOKENS;
  });
});

describe("tier and tasks", () => {
  function writeBase(extra: Record<string, unknown> = {}) {
    writeFileSync(
      join(tempDir, "config.json"),
      JSON.stringify({ baseUrl: "http://1.2.3.4:1234", model: "m", ...extra }),
    );
  }

  it("defaults both to null, meaning undeclared and all tasks allowed", () => {
    writeBase();
    const cfg = loadConfig();
    expect(cfg.tier).toBeNull();
    expect(cfg.tasks).toBeNull();
  });

  it("reads tier and tasks from config.json", () => {
    writeBase({ tier: "helper", tasks: ["summarize", "extract"] });
    const cfg = loadConfig();
    expect(cfg.tier).toBe("helper");
    expect(cfg.tasks).toEqual(["summarize", "extract"]);
  });

  it("reads tier and tasks from env, overriding the file", () => {
    writeBase({ tier: "coder", tasks: ["implement"] });
    process.env.LOCAL_LLM_TIER = "helper";
    process.env.LOCAL_LLM_TASKS = "summarize,extract";
    const cfg = loadConfig();
    expect(cfg.tier).toBe("helper");
    expect(cfg.tasks).toEqual(["summarize", "extract"]);
  });

  it("tolerates whitespace around comma-separated tasks", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = " summarize , extract ,explain ";
    expect(loadConfig().tasks).toEqual(["summarize", "extract", "explain"]);
  });

  it("rejects an unknown task name in the env list and names the valid ones", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = "summarize,transpile";
    expect(() => loadConfig()).toThrow(/unknown task\(s\): transpile/);
    expect(() => loadConfig()).toThrow(/implement, fix, review, summarize, extract, explain, classify/);
  });

  it("rejects an unknown task name in config.json", () => {
    writeBase({ tasks: ["summarize", "transpile"] });
    expect(() => loadConfig()).toThrow(/tasks/);
  });

  it("rejects an empty tasks array", () => {
    writeBase({ tasks: [] });
    expect(() => loadConfig()).toThrow(/tasks/);
  });

  it("rejects duplicate task names in config.json, naming the duplicate", () => {
    writeBase({ tasks: ["summarize", "summarize"] });
    expect(() => loadConfig()).toThrow(/tasks contains duplicate value\(s\): summarize/);
  });

  it("rejects duplicate task names in the env list, naming the duplicate", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = "summarize,extract,summarize";
    expect(() => loadConfig()).toThrow(/tasks contains duplicate value\(s\): summarize/);
  });

  it("rejects an env task list that is only separators", () => {
    writeBase();
    process.env.LOCAL_LLM_TASKS = " , , ";
    expect(() => loadConfig()).toThrow(/must list at least one task/);
  });

  it("rejects an empty tier string", () => {
    writeBase({ tier: "" });
    expect(() => loadConfig()).toThrow(/tier/);
  });

  it("does not warn about the new env vars as unrecognized", () => {
    writeBase();
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    process.env.LOCAL_LLM_TIER = "coder";
    process.env.LOCAL_LLM_TASKS = "implement";
    loadConfig();
    const output = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/LOCAL_LLM_TIER/);
    expect(output).not.toMatch(/LOCAL_LLM_TASKS/);
    warn.mockRestore();
  });
});
