export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const bytes = Buffer.byteLength(text, "utf8");
  return Math.ceil(bytes / 4);
}

export function isOverBudget(text: string, budget: number): boolean {
  return estimateTokens(text) > budget;
}
