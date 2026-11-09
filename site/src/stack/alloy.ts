/**
 * A small reader of the Alloy configuration syntax: blocks, labels and attributes, with their lines. It reads the real
 * `config.alloy` at build time, so the map shows the components and the outputs of the file.
 */

/** An attribute of a block. */
export interface AlloyAttribute {
  readonly name: string;
  /** The source text of the value. */
  readonly raw: string;
  readonly line: number;
  readonly endLine: number;
}

/** A block: `name "label" { ... }`. */
export interface AlloyBlock {
  readonly name: string;
  readonly label: string | undefined;
  readonly line: number;
  readonly endLine: number;
  readonly attributes: readonly AlloyAttribute[];
  readonly blocks: readonly AlloyBlock[];
}

class Reader {
  readonly text: string;
  at = 0;
  line = 1;

  constructor(text: string) {
    this.text = text;
  }

  get done(): boolean {
    return this.at >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text[this.at + offset] ?? "";
  }

  next(): string {
    const char = this.text[this.at] ?? "";
    this.at += 1;
    if (char === "\n") this.line += 1;
    return char;
  }

  skipLine(): void {
    while (!this.done && this.peek() !== "\n") this.next();
  }

  skipBlank(): void {
    for (;;) {
      const char = this.peek();
      if (char === " " || char === "\t" || char === "\r" || char === "\n") this.next();
      else if (char === "/" && this.peek(1) === "/") this.skipLine();
      else if (char === "/" && this.peek(1) === "*") {
        while (!this.done && !(this.peek() === "*" && this.peek(1) === "/")) this.next();
        this.next();
        this.next();
      } else return;
    }
  }

  /** This method reads a quoted text or a raw text, with its quotes. */
  quoted(): string {
    const quote = this.next();
    let out = quote;
    while (!this.done) {
      const char = this.next();
      out += char;
      if (char === "\\" && quote === '"') out += this.next();
      else if (char === quote) break;
    }
    return out;
  }

  name(): string {
    let out = "";
    while (/[A-Za-z0-9_.]/.test(this.peek())) out += this.next();
    if (out === "") throw new Error(`config.alloy, line ${this.line}: a name is necessary here, not "${this.peek()}".`);
    return out;
  }
}

function expression(reader: Reader): string {
  let raw = "";
  let depth = 0;
  while (!reader.done) {
    const char = reader.peek();
    if (char === '"' || char === "`") {
      raw += reader.quoted();
      continue;
    }
    if (char === "/" && reader.peek(1) === "/") {
      reader.skipLine();
      continue;
    }
    if ((char === "\n" || char === "}") && depth === 0) break;
    if (char === "[" || char === "(" || char === "{") depth += 1;
    if (char === "]" || char === ")" || char === "}") depth -= 1;
    raw += reader.next();
  }
  return raw.trimEnd();
}

function body(reader: Reader, closing: boolean): { attributes: AlloyAttribute[]; blocks: AlloyBlock[] } {
  const attributes: AlloyAttribute[] = [];
  const blocks: AlloyBlock[] = [];
  for (;;) {
    reader.skipBlank();
    if (reader.done) {
      if (closing) throw new Error("config.alloy: a block has no end.");
      return { attributes, blocks };
    }
    if (closing && reader.peek() === "}") return { attributes, blocks };
    const line = reader.line;
    const name = reader.name();
    reader.skipBlank();
    if (reader.peek() === "=") {
      reader.next();
      reader.skipBlank();
      const raw = expression(reader);
      attributes.push({ name, raw, line, endLine: reader.line });
      continue;
    }
    let label: string | undefined;
    if (reader.peek() === '"') label = reader.quoted().slice(1, -1);
    reader.skipBlank();
    if (reader.peek() !== "{") throw new Error(`config.alloy, line ${reader.line}: "{" is necessary after ${name}.`);
    reader.next();
    const inner = body(reader, true);
    const endLine = reader.line;
    reader.next();
    blocks.push({ name, label, line, endLine, ...inner });
  }
}

/** This function reads the text of a configuration, and gives its top-level blocks. */
export function parseAlloy(text: string): AlloyBlock[] {
  return body(new Reader(text), false).blocks;
}

/** A component of the pipeline. */
export interface AlloyComponent {
  /** The block name and the label, as other components refer to it: `otelcol.processor.batch.default`. */
  readonly id: string;
  readonly block: AlloyBlock;
  /** The components that each signal goes to, by signal name. */
  readonly outputs: Readonly<Record<string, readonly string[]>>;
  /** The value of `client { endpoint }` of an exporter. */
  readonly endpoint: string | undefined;
}

/** This function gives the components, with the targets of their `output` blocks and the endpoint of each exporter. */
export function components(blocks: readonly AlloyBlock[]): AlloyComponent[] {
  return blocks.map((block) => {
    const outputs: Record<string, string[]> = {};
    for (const attribute of block.blocks.find((child) => child.name === "output")?.attributes ?? []) {
      outputs[attribute.name] = [...attribute.raw.matchAll(/([A-Za-z0-9_.]+)\.input/g)].map((match) => match[1]!);
    }
    const endpoint = block.blocks.find((child) => child.name === "client")?.attributes.find((attribute) => attribute.name === "endpoint");
    return { id: `${block.name}.${block.label ?? ""}`, block, outputs, endpoint: endpoint?.raw.replace(/^"|"$/g, "") };
  });
}

/** This function tells if a component is a connector: it takes one signal and gives another, for example traces to metrics. */
export function isConnector(id: string): boolean {
  return id.startsWith("otelcol.connector.");
}

/**
 * This function gives the components that a signal goes through from a start component, in order, or an empty list.
 * When an output has more than one target, the route goes on to the first target that is not a connector: a connector
 * starts a second route, of another signal.
 */
export function walk(all: readonly AlloyComponent[], start: string, signal: string): string[] {
  const route: string[] = [];
  const byId = new Map(all.map((component) => [component.id, component]));
  let current = byId.get(start);
  if (current?.outputs[signal] === undefined) return route;
  while (current !== undefined && !route.includes(current.id)) {
    route.push(current.id);
    const next: string | undefined = current.outputs[signal]?.find((target) => !isConnector(target));
    current = next === undefined ? undefined : byId.get(next);
  }
  return route;
}

/** This function gives the host of an endpoint: `http://mimir:9009/otlp` and `mimir:9009` give `mimir`. */
export function hostOf(endpoint: string): string {
  return endpoint.replace(/^[a-z]+:\/\//, "").split(/[:/]/)[0]!;
}
