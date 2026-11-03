/**
 * The variable rules of Docker Compose, as pure functions: the `.env` file and the `${VAR}` forms of the Compose
 * specification. The build reads the real files with these functions, and the editor of the page runs them in the browser.
 */

/** The text that the site shows in place of a hidden value. */
export const HIDDEN = "hidden";

/** This function tells if the site hides the value of a variable. The name contains PASSWORD, SECRET or TOKEN. */
export function isSecretName(name: string): boolean {
  return /PASSWORD|SECRET|TOKEN/i.test(name);
}

/** One variable of a `.env` file. */
export interface DotEnvEntry {
  readonly name: string;
  readonly value: string;
  /** The line of the file, from 1. */
  readonly line: number;
}

/** This function reads a `.env` file: `NAME=value` lines, `export`, quotes and comments. */
export function parseDotEnv(text: string): DotEnvEntry[] {
  const entries: DotEnvEntry[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (match === null || raw.trimStart().startsWith("#")) return;
    entries.push({ name: match[1]!, value: dotEnvValue(match[2]!), line: index + 1 });
  });
  return entries;
}

function dotEnvValue(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(text);
  if (quoted !== null) return quoted[2]!;
  return text.replace(/\s+#.*$/, "");
}

/** The result of a substitution. */
export interface Substitution {
  readonly text: string;
  /** The messages of the `${VAR:?message}` forms with no value. */
  readonly errors: readonly string[];
  /** The names that the text uses, in order, with no repeats. */
  readonly names: readonly string[];
}

/** One reference to a variable. */
export interface VariableReference {
  readonly name: string;
  /** The operator: `""`, `:-`, `-`, `:+`, `+`, `:?` or `?`. */
  readonly operator: string;
  /** The text after the operator. */
  readonly operand: string;
}

const REFERENCE = /\$(?:(\$)|([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\+|\+|:\?|\?)([^}]*))?\})/g;

/** This function lists the variable references of a text. `$$` is an escape, so it gives no reference. */
export function references(text: string): VariableReference[] {
  const found: VariableReference[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    if (match[1] !== undefined) continue;
    found.push({ name: match[2] ?? match[3]!, operator: match[4] ?? "", operand: match[5] ?? "" });
  }
  return found;
}

/** The values of the variables. A missing name is a variable that is not set. */
export type Values = Readonly<Record<string, string | undefined>>;

/**
 * This function substitutes the variables of a text as Compose does.
 *
 * - `$VAR` and `${VAR}` give the value, or an empty text.
 * - `${VAR:-default}` gives the default when the variable is not set or is empty. `${VAR-default}` only when it is not set.
 * - `${VAR:+other}` gives the other text when the variable has a value. `${VAR+other}` when it is set.
 * - `${VAR:?message}` is an error when the variable is not set or is empty. `${VAR?message}` only when it is not set.
 * - `$$` gives one `$`.
 */
export function substitute(text: string, vars: Values): Substitution {
  const errors: string[] = [];
  const names = new Set<string>();
  const result = text.replace(REFERENCE, (_all, escape: string | undefined, bare: string | undefined, braced: string | undefined, operator: string | undefined, operand: string | undefined) => {
    if (escape !== undefined) return "$";
    const name = (bare ?? braced)!;
    names.add(name);
    const value = vars[name];
    const isSet = value !== undefined;
    const hasValue = isSet && value !== "";
    const other = operand ?? "";
    switch (operator) {
      case ":-":
        return hasValue ? value : other;
      case "-":
        return isSet ? value : other;
      case ":+":
        return hasValue ? other : "";
      case "+":
        return isSet ? other : "";
      case ":?":
      case "?":
        if (operator === ":?" ? hasValue : isSet) return value ?? "";
        errors.push(`${name}: ${other === "" ? "required variable" : other}`);
        return "";
      default:
        return value ?? "";
    }
  });
  return { text: result, errors, names: [...names] };
}

/** One line of the Compose file that a change of the values changes. */
export interface ChangedLine {
  /** The line of the file, from 1. */
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

/**
 * This function substitutes each line of a Compose file. Compose substitutes the values of the YAML document, so a comment
 * stays as it is.
 */
export function resolveLines(lines: readonly string[], vars: Values): string[] {
  return lines.map((line) => (line.trimStart().startsWith("#") ? line : substitute(line, vars).text));
}

/** This function compares the lines of two sets of values, and gives the lines that differ. */
export function changedLines(lines: readonly string[], before: Values, after: Values): ChangedLine[] {
  const from = resolveLines(lines, before);
  const to = resolveLines(lines, after);
  const changed: ChangedLine[] = [];
  from.forEach((text, index) => {
    if (text !== to[index]) changed.push({ line: index + 1, before: text, after: to[index]! });
  });
  return changed;
}
