import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCallId, appendUsage } from "../src/ledger.js";
import type { UsageEntry } from "../src/ledger.js";
import type { Config } from "../src/config.js";

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
  stateDir: null, // overridden per test
};

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    call_id: "20260926T141502Z-3f9a1c",
    pid: process.pid,
    cwd: "/tmp",
    client: null,
    tier: null,
    model: "test-model",
    tool: "local_direct",
    task: null,
    mode: "text",
    outcome: "ok",
    root: null,
    files_read: [],
    files_truncated: [],
    files_skipped: [],
    targets: [],
    files_written: [],
    prompt_bytes: 0,
    file_bytes: 0,
    bytes_in: 0,
    bytes_out: 0,
    prompt_tokens: null,
    completion_tokens: null,
    attempts: 1,
    finish_reason: null,
    stray_lines: 0,
    upstream_ms: null,
    duration_ms: 1,
    reasons: [],
    ...overrides,
  };
}

const EXPECTED_KEYS = [
  "v",
  "ts",
  "call_id",
  "pid",
  "cwd",
  "client",
  "tier",
  "model",
  "tool",
  "task",
  "mode",
  "outcome",
  "root",
  "files_read",
  "files_truncated",
  "files_skipped",
  "targets",
  "files_written",
  "prompt_bytes",
  "file_bytes",
  "bytes_in",
  "bytes_out",
  "prompt_tokens",
  "completion_tokens",
  "attempts",
  "finish_reason",
  "stray_lines",
  "upstream_ms",
  "duration_ms",
  "reasons",
].sort();

describe("newCallId", () => {
  it("matches the expected format exactly", () => {
    const id = newCallId();
    expect(id).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  });

  it("returns a fixed date/time prefix with a 6-char lowercase hex suffix for a given Date", () => {
    const fixed = new Date(Date.UTC(2026, 8, 26, 14, 15, 2));
    const id = newCallId(fixed);
    expect(id.startsWith("20260926T141502Z-")).toBe(true);
    const suffix = id.slice("20260926T141502Z-".length);
    expect(suffix).toMatch(/^[0-9a-f]{6}$/);
  });

  it("two calls with the same fixed Date differ only after the dash", () => {
    const fixed = new Date(Date.UTC(2026, 8, 26, 14, 15, 2));
    const prefix = "20260926T141502Z-";
    const a = newCallId(fixed);
    const b = newCallId(fixed);
    expect(a.slice(0, prefix.length)).toBe(prefix);
    expect(b.slice(0, prefix.length)).toBe(prefix);
    expect(a).not.toBe(b);
  });
});

describe("appendUsage", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("does not throw and creates no file when stateDir is null", () => {
    expect(() => appendUsage(baseConfig, makeEntry())).not.toThrow();
  });

  it("creates the directory with mode 0700 and usage.jsonl with mode 0600", () => {
    dir = mkdtempSync(join(tmpdir(), "local-router-ledger-"));
    const stateDir = join(dir, "state");
    appendUsage({ ...baseConfig, stateDir }, makeEntry());

    expect(existsSync(join(stateDir, "usage.jsonl"))).toBe(true);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "usage.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("round-trips the entry exactly", () => {
    dir = mkdtempSync(join(tmpdir(), "local-router-ledger-"));
    const stateDir = join(dir, "state");
    const entry = makeEntry();
    appendUsage({ ...baseConfig, stateDir }, entry);

    const line = readFileSync(join(stateDir, "usage.jsonl"), "utf8").trim().split("\n")[0];
    expect(JSON.parse(line)).toEqual(entry);
  });

  it("appends two separate lines in call order", () => {
    dir = mkdtempSync(join(tmpdir(), "local-router-ledger-"));
    const stateDir = join(dir, "state");
    const entry1 = makeEntry({ call_id: "first" });
    const entry2 = makeEntry({ call_id: "second" });

    appendUsage({ ...baseConfig, stateDir }, entry1);
    appendUsage({ ...baseConfig, stateDir }, entry2);

    const lines = readFileSync(join(stateDir, "usage.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(entry1);
    expect(JSON.parse(lines[1])).toEqual(entry2);
  });

  it("the written line contains exactly the interface's field names and no others", () => {
    dir = mkdtempSync(join(tmpdir(), "local-router-ledger-"));
    const stateDir = join(dir, "state");
    appendUsage({ ...baseConfig, stateDir }, makeEntry());

    const line = readFileSync(join(stateDir, "usage.jsonl"), "utf8").trim().split("\n")[0];
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed).sort()).toEqual(EXPECTED_KEYS);
  });

  it("warns once to stderr when stateDir cannot be created and does not throw", () => {
    dir = mkdtempSync(join(tmpdir(), "local-router-ledger-"));
    // Create a FILE at the path where stateDir would go, so mkdirSync fails.
    const brokenPath = join(dir, "blocker");
    writeFileSync(brokenPath, "not a directory", "utf8");

    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(() => appendUsage({ ...baseConfig, stateDir: brokenPath }, makeEntry())).not.toThrow();
      expect(() => appendUsage({ ...baseConfig, stateDir: brokenPath }, makeEntry())).not.toThrow();

      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0];
      const text = typeof arg === "string" ? arg : Buffer.from(arg as Uint8Array).toString("utf8");
      expect(text).toContain("usage ledger write failed");
    } finally {
      spy.mockRestore();
    }
  });
});
