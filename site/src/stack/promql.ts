/** Reads the names of the series that a PromQL query or a rule expression selects. */

const KEYWORDS = new Set(["by", "without", "on", "ignoring", "group_left", "group_right", "bool", "and", "or", "unless", "offset", "atan2", "inf", "nan"]);

/** This function gives the series names of a query, in order, with no repeats. */
export function seriesOf(query: string): string[] {
  const text = query
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ")
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, " ");
  const names = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*(?![A-Za-z0-9_:])(?!\s*\()/g)) {
    const name = match[0];
    const before = text[match.index - 1] ?? "";
    if (/[0-9.]/.test(before) || KEYWORDS.has(name.toLowerCase())) continue;
    names.add(name);
  }
  return [...names];
}
