import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

let tempDir: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "qwen-cfg-"));
  process.env.CLAUDE_PLUGIN_ROOT = tempDir;
  delete process.env.QWEN_BASE_URL;
  delete process.env.QWEN_MODEL;
  delete process.env.QWEN_API_KEY;
  delete process.env.QWEN_TOKEN_BUDGET;
  delete process.env.QWEN_REQUEST_TIMEOUT_MS;
  delete process.env.QWEN_TEMPERATURE;
  delete process.env.QWEN_TOP_P;
  delete process.env.QWEN_TOP_K;
  delete process.env.QWEN_MIN_P;
  delete process.env.QWEN_REPEAT_PENALTY;
  delete process.env.QWEN_MAX_TOKENS;
  delete process.env.QWEN_DEBUG_LOG_PATH;
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
    process.env.QWEN_BASE_URL = "http://env:1234";
    process.env.QWEN_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("works with env vars only (no config file)", () => {
    process.env.QWEN_BASE_URL = "http://env:1234";
    process.env.QWEN_MODEL = "env-model";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://env:1234");
    expect(cfg.model).toBe("env-model");
  });

  it("strips trailing slash from baseUrl", () => {
    process.env.QWEN_BASE_URL = "http://host:1234/";
    process.env.QWEN_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe("http://host:1234");
  });

  it("throws clearly when baseUrl is missing", () => {
    process.env.QWEN_MODEL = "m";
    expect(() => loadConfig()).toThrow(/baseUrl/);
  });

  it("throws clearly when model is missing", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    expect(() => loadConfig()).toThrow(/model/);
  });

  it("parses numeric env vars", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TOKEN_BUDGET = "100000";
    process.env.QWEN_REQUEST_TIMEOUT_MS = "60000";
    const cfg = loadConfig();
    expect(cfg.tokenBudget).toBe(100000);
    expect(cfg.requestTimeoutMs).toBe(60000);
  });

  it("throws a clear error when QWEN_TOKEN_BUDGET is not numeric", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TOKEN_BUDGET = "abc";
    expect(() => loadConfig()).toThrow(/QWEN_TOKEN_BUDGET must be a number.*"abc"/);
  });

  it("throws a clear error when QWEN_REQUEST_TIMEOUT_MS is not numeric", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_REQUEST_TIMEOUT_MS = "xyz";
    expect(() => loadConfig()).toThrow(/QWEN_REQUEST_TIMEOUT_MS must be a number.*"xyz"/);
  });

  it("includes code-friendly sampling defaults", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.topP).toBe(0.8);
    expect(cfg.topK).toBe(20);
    expect(cfg.minP).toBe(0.05);
    expect(cfg.repeatPenalty).toBe(1.1);
  });

  it("env vars override sampling defaults", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TEMPERATURE = "0.8";
    process.env.QWEN_TOP_P = "0.9";
    process.env.QWEN_TOP_K = "20";
    process.env.QWEN_MIN_P = "0.1";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0.8);
    expect(cfg.topP).toBe(0.9);
    expect(cfg.topK).toBe(20);
    expect(cfg.minP).toBe(0.1);
  });

  it("rejects out-of-range sampling values", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TOP_P = "1.5"; // out of [0,1]
    expect(() => loadConfig()).toThrow(/topP/);
  });

  it("throws clear error when sampling env var is non-numeric", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TEMPERATURE = "hot";
    expect(() => loadConfig()).toThrow(/QWEN_TEMPERATURE must be a number.*"hot"/);
  });

  it("treats QWEN_TOP_K=\"0\" as a real override (not falsy default)", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TOP_K = "0";
    const cfg = loadConfig();
    expect(cfg.topK).toBe(0);
  });

  it("treats QWEN_TEMPERATURE=\"0\" as a real override (not falsy default)", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_TEMPERATURE = "0";
    const cfg = loadConfig();
    expect(cfg.temperature).toBe(0);
  });

  it("env var QWEN_REPEAT_PENALTY overrides default", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_REPEAT_PENALTY = "1.2";
    const cfg = loadConfig();
    expect(cfg.repeatPenalty).toBe(1.2);
  });

  it("rejects out-of-range repeatPenalty", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_REPEAT_PENALTY = "5"; // out of [0, 2]
    expect(() => loadConfig()).toThrow(/repeatPenalty/);
  });

  it("throws clear error when QWEN_REPEAT_PENALTY is non-numeric", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_REPEAT_PENALTY = "high";
    expect(() => loadConfig()).toThrow(/QWEN_REPEAT_PENALTY must be a number.*"high"/);
  });

  it("includes maxTokens default of 16000", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(16000);
  });

  it("env var QWEN_MAX_TOKENS overrides default", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_MAX_TOKENS = "32000";
    const cfg = loadConfig();
    expect(cfg.maxTokens).toBe(32000);
  });

  it("env var QWEN_DEBUG_LOG_PATH sets debugLogPath", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    process.env.QWEN_DEBUG_LOG_PATH = "/tmp/qwen.log";
    const cfg = loadConfig();
    expect(cfg.debugLogPath).toBe("/tmp/qwen.log");
  });

  it("debugLogPath defaults to null", () => {
    process.env.QWEN_BASE_URL = "http://x:1234";
    process.env.QWEN_MODEL = "m";
    const cfg = loadConfig();
    expect(cfg.debugLogPath).toBeNull();
  });
});
