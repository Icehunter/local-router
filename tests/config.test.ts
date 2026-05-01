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
});
