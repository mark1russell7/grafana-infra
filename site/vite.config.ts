import { fileURLToPath } from "node:url";
import { siteShell } from "@mark1russell7/site-pages/vite";
import { defineConfig, type Plugin } from "vite";
import { readSnapshot } from "./src/stack/snapshot.ts";

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
  plugins: [siteShell({ themeKey: "grafana-infra-theme", packageFile: false }), stackData()],
});
