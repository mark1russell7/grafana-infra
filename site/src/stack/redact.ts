/**
 * The redaction of the text that the site shows. The site never holds the value of a variable whose name contains PASSWORD,
 * SECRET or TOKEN, so the build removes the value before a line goes into the page.
 */

import { HIDDEN, isSecretName, parseDotEnv, references } from "./compose-vars.ts";

const ASSIGNMENT = /(?<![A-Za-z0-9_.{-])([A-Za-z0-9_.-]*(?:PASSWORD|SECRET|TOKEN)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?!\$\{)("[^"]*"|'[^']*'|[^\s#]+)/gi;
const WITH_OPERAND = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-|-|:\+|\+|:\?|\?)([^}]*)\}/g;

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** This function gives the secret values of the files: the values in `.env`, and the defaults in `${NAME:-default}` forms. */
export function secretValues(texts: readonly string[]): string[] {
  const values = new Set<string>();
  for (const text of texts) {
    for (const entry of parseDotEnv(text)) if (isSecretName(entry.name) && entry.value !== "") values.add(entry.value);
    for (const reference of references(text)) if (isSecretName(reference.name) && reference.operand !== "") values.add(reference.operand);
  }
  return [...values];
}

/** This function removes the secret values from the lines of a file. A comment loses each word that is a secret value. */
export function redactLines(lines: readonly string[], secrets: readonly string[]): string[] {
  const words = secrets.map((secret) => new RegExp(`(?<![A-Za-z0-9_-])${escaped(secret)}(?![A-Za-z0-9_-])`, "g"));
  return lines.map((line) => {
    let out = line.replace(ASSIGNMENT, `$1$2${HIDDEN}`);
    out = out.replace(WITH_OPERAND, (all: string, name: string, operator: string) => (isSecretName(name) ? `\${${name}${operator}${HIDDEN}}` : all));
    const start = out.trimStart();
    if (start.startsWith("#") || start.startsWith("//") || start.startsWith(";")) {
      for (const word of words) out = out.replace(word, HIDDEN);
    }
    return out;
  });
}
