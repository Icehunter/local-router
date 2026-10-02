export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // On 2026-09-26, bytes-per-token was measured against the coder model's own
  // /tokenize endpoint for qwen3.8-27b, giving GLSL 3.11, TOML 3.33, TypeScript
  // 3.85, Markdown 3.94, Java 4.14 bytes per token. bytes/4 under-counted GLSL
  // enough to overflow a 131072-token context at a 120000-prompt/16000-response
  // budget; bytes/3 is a conservative floor across all five measured file types.
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 3);
}
