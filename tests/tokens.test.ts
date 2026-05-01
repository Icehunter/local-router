import { describe, expect, it } from "vitest";
import { estimateTokens, isOverBudget } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses bytes/4 heuristic, ceiling rounded", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 bytes / 4 = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 bytes / 4 = 1.25 -> 2
  });

  it("counts bytes, not chars (multi-byte safe)", () => {
    // "✓" is 3 bytes in UTF-8
    expect(estimateTokens("✓")).toBe(1); // 3 bytes / 4 = 0.75 -> 1
  });
});

describe("isOverBudget", () => {
  it("returns false when at or under budget", () => {
    expect(isOverBudget("abcd", 1)).toBe(false);
  });

  it("returns true when over budget", () => {
    expect(isOverBudget("abcde", 1)).toBe(true);
  });
});
