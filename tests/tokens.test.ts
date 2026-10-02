import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses bytes/3 heuristic, ceiling rounded", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 bytes / 3 = 1
    expect(estimateTokens("abcd")).toBe(2); // 4 bytes / 3 = 1.33 -> 2
    expect(estimateTokens("abcde")).toBe(2); // 5 bytes / 3 = 1.67 -> 2
  });

  it("counts bytes, not chars (multi-byte safe)", () => {
    // 4 chars, 12 UTF-8 bytes. A char-length implementation would say 1.
    expect("✓✓✓✓".length).toBe(4);
    expect(estimateTokens("✓✓✓✓")).toBe(4); // 12 bytes / 3 = 4
  });
});
