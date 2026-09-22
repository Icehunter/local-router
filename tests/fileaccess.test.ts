import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRequestedFiles, resolveAllowedRoot } from "../src/fileaccess.js";

let projectDir: string;
let outsideDir: string;

beforeEach(() => {
  // realpath'd up front: readRequestedFiles expects the root it's handed to
  // already be the realpath resolveAllowedRoot would have produced (macOS's
  // tmpdir() is under a /var symlink to /private/var, so an un-resolved root
  // would never match a realpath'd file inside it).
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "local-router-fa-project-")));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "local-router-fa-outside-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe("resolveAllowedRoot", () => {
  it("throws when allowedRoots is null", () => {
    expect(() => resolveAllowedRoot(projectDir, null)).toThrow(/not enabled/);
  });

  it("throws when root is missing or empty", () => {
    expect(() => resolveAllowedRoot(undefined, [projectDir])).toThrow(/root.*required/);
    expect(() => resolveAllowedRoot("  ", [projectDir])).toThrow(/root.*required/);
  });

  it("throws when root is relative", () => {
    expect(() => resolveAllowedRoot("relative/path", [projectDir])).toThrow(/absolute/);
  });

  it("throws when root does not exist", () => {
    expect(() => resolveAllowedRoot(join(projectDir, "nope"), [projectDir])).toThrow(/does not exist/);
  });

  it("accepts a root equal to an allowed root", () => {
    expect(resolveAllowedRoot(projectDir, [projectDir])).toBe(resolveAllowedRoot(projectDir, [projectDir]));
  });

  it("accepts a root nested inside an allowed root", () => {
    const nested = join(projectDir, "nested");
    mkdirSync(nested);
    expect(() => resolveAllowedRoot(nested, [projectDir])).not.toThrow();
  });

  it("rejects a root outside every allowed root", () => {
    expect(() => resolveAllowedRoot(outsideDir, [projectDir])).toThrow(/outside the configured allowedRoots/);
  });

  it("rejects a root whose realpath escapes via a symlink", () => {
    const link = join(projectDir, "escape");
    symlinkSync(outsideDir, link);
    expect(() => resolveAllowedRoot(link, [projectDir])).toThrow(/outside the configured allowedRoots/);
  });
});

describe("readRequestedFiles", () => {
  it("reads a file and includes it whole when it fits", () => {
    writeFileSync(join(projectDir, "a.txt"), "hello world");
    const result = readRequestedFiles(projectDir, ["a.txt"], 10000);
    expect(result.included).toEqual(["a.txt"]);
    expect(result.truncated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.text).toContain("--- file: a.txt ---");
    expect(result.text).toContain("hello world");
  });

  it("reads multiple files in order", () => {
    writeFileSync(join(projectDir, "a.txt"), "AAA");
    writeFileSync(join(projectDir, "b.txt"), "BBB");
    const result = readRequestedFiles(projectDir, ["a.txt", "b.txt"], 10000);
    expect(result.included).toEqual(["a.txt", "b.txt"]);
    expect(result.text.indexOf("AAA")).toBeLessThan(result.text.indexOf("BBB"));
  });

  it("skips a path that escapes root via traversal", () => {
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    const result = readRequestedFiles(projectDir, ["../" + outsideDir.split("/").pop() + "/secret.txt"], 10000);
    expect(result.included).toEqual([]);
    expect(result.skipped.some((s) => s.reason === "escapes root" || s.reason.startsWith("not found"))).toBe(true);
  });

  it("skips a path that escapes root via a symlink", () => {
    writeFileSync(join(outsideDir, "secret.txt"), "top secret");
    symlinkSync(join(outsideDir, "secret.txt"), join(projectDir, "link.txt"));
    const result = readRequestedFiles(projectDir, ["link.txt"], 10000);
    expect(result.included).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("escapes root");
  });

  it("skips a nonexistent file with a clear reason", () => {
    const result = readRequestedFiles(projectDir, ["missing.txt"], 10000);
    expect(result.skipped).toEqual([{ path: "missing.txt", reason: expect.stringContaining("not found") }]);
  });

  it("skips a directory", () => {
    mkdirSync(join(projectDir, "adir"));
    const result = readRequestedFiles(projectDir, ["adir"], 10000);
    expect(result.skipped[0]).toEqual({ path: "adir", reason: "not a regular file" });
  });

  it("skips a file over the size cap", () => {
    writeFileSync(join(projectDir, "big.txt"), "x".repeat(3 * 1024 * 1024));
    const result = readRequestedFiles(projectDir, ["big.txt"], 10_000_000);
    expect(result.skipped[0]?.reason).toMatch(/too large/);
  });

  it("truncates a file that doesn't fit the budget, keeping head and tail", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`);
    writeFileSync(join(projectDir, "big.txt"), lines.join("\n"));
    // A budget too small for the whole 200-line file but big enough for a
    // head/tail-truncated version.
    const result = readRequestedFiles(projectDir, ["big.txt"], 200);
    expect(result.truncated).toEqual(["big.txt"]);
    expect(result.text).toContain("line-0");
    expect(result.text).toContain("line-199");
    expect(result.text).toMatch(/\[\.\.\. \d+ lines omitted \.\.\.\]/);
  });

  it("skips files after the budget is exhausted, keeping earlier ones whole", () => {
    writeFileSync(join(projectDir, "a.txt"), "small");
    writeFileSync(join(projectDir, "b.txt"), "also small");
    const result = readRequestedFiles(projectDir, ["a.txt", "b.txt"], 1);
    expect(result.included).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("reports a non-string entry as skipped rather than throwing", () => {
    const result = readRequestedFiles(projectDir, [42 as unknown as string], 10000);
    expect(result.skipped[0]?.reason).toBe("not a non-empty string");
  });
});
