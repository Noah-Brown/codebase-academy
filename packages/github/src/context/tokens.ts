/**
 * Documented approximation (about four characters per token). The model tokenizer
 * replaces this in Milestone 3; budgets are relative to this estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Code-unit comparison, so ordering never depends on the runtime locale. */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Truncate to at most `maxChars` UTF-16 units without splitting a surrogate pair. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
