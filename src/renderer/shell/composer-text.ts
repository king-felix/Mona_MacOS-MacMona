/**
 * R10. Insert reusable text into a composer draft without losing what the user
 * already wrote. Trailing whitespace is preserved: the previous version
 * `trimEnd()`-ed it, which silently changed the user's own text. Only a
 * whitespace-only draft is replaced, and the caller is told when that happens.
 */
export function insertPromptText(
  current: string,
  insertion: string,
): { text: string; kept: boolean; replacedUnsent: boolean } {
  if (current.length === 0) return { text: insertion, kept: false, replacedUnsent: false };
  if (current.trim().length === 0) {
    return { text: insertion, kept: false, replacedUnsent: true };
  }
  // A draft that already ends its own line is not given another blank one.
  const separator = current.endsWith("\n") ? "" : "\n\n";
  return { text: `${current}${separator}${insertion}`, kept: true, replacedUnsent: false };
}
