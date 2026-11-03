import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { readSnapshot } from "./src/stack/snapshot.ts";

// The Pages workflow sets SITE_BASE to "/grafana-infra". A local build uses the root.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const base = env["SITE_BASE"] ? `${env["SITE_BASE"].replace(/\/$/, "")}/` : "/";

const MODULE = "virtual:stack";

/** This plugin reads the real files of the repository at build time, so the page has no typed copy of them. */
function stackData(): Plugin {
  const root = fileURLToPath(new URL("..", import.meta.url));
  return {
    name: "stack-data",
    resolveId: (id) => (id === MODULE ? `\0${MODULE}` : undefined),
    load: (id) => (id === `\0${MODULE}` ? `export default ${JSON.stringify(readSnapshot(root))};` : undefined),
  };
}

// The site has one page. The deploy adds `status/` and `releases/`.
export default defineConfig({
  base,
  build: { target: "es2022" },
  plugins: [stackData()],
  define: {
    __BUILD__: JSON.stringify({ sha: (env["GITHUB_SHA"] ?? "local").slice(0, 7), date: new Date().toISOString().slice(0, 10) }),
  },
});
