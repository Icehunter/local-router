export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // utf8 bytes / 4 ≈ tokens for Latin text; CJK/emoji chars are ~2–4 bytes each
  // but tokenize as 1–2 tokens, so this under-estimates CJK by ~2×. The guard
  // is therefore permissive (not conservative) for CJK-heavy prompts.
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 4);
}
