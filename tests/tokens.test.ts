import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses bytes/4 heuristic, ceiling rounded", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 bytes / 4 = 1
    expect(estimateTokens("abcde")).toBe(2); // 5 bytes / 4 = 1.25 -> 2
  });

  it("counts bytes, not chars (multi-byte safe)", () => {
    // 4 chars, 12 UTF-8 bytes. A char-length implementation would say 1.
    expect("✓✓✓✓".length).toBe(4);
    expect(estimateTokens("✓✓✓✓")).toBe(3);
  });
});
