/** A range of lines of a real file, with its line numbers and a link to the file on GitHub. */

import { h } from "@mark1russell7/site-pages/chrome";
import { snapshot } from "./state.ts";
import type { Source } from "./stack/types.ts";

const REPO = "https://github.com/mark1russell7/grafana-infra";

function isComment(line: string): boolean {
  const start = line.trimStart();
  return start.startsWith("#") || start.startsWith("//");
}

/** This function makes the view of a source. The file text is in the page data, after the redaction. */
export function excerpt(source: Source): HTMLElement {
  const file = snapshot.files.find((entry) => entry.path === source.file);
  const lines = file?.lines.slice(source.start - 1, source.end) ?? [];
  const where = source.start === source.end ? `line ${source.start}` : `lines ${source.start}-${source.end}`;
  return h(
    "figure",
    { class: "excerpt", "data-file": source.file, "data-start": source.start, "data-end": source.end },
    h(
      "figcaption",
      {},
      h("span", { class: "excerpt-label" }, source.label),
      h("a", { class: "excerpt-file", href: `${REPO}/blob/main/${source.file}#L${source.start}-L${source.end}` }, `${source.file.split("/").pop()!}, ${where}`),
    ),
    h(
      "pre",
      { tabindex: 0, "aria-label": `${source.file}, ${where}` },
      h(
        "code",
        {},
        lines.map((line, index) =>
          h("span", { class: isComment(line) ? "ln is-comment" : "ln" }, h("span", { class: "no", "aria-hidden": "true" }, String(source.start + index)), h("span", { class: "tx" }, line === "" ? " " : line)),
        ),
      ),
    ),
  );
}
