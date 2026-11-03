/** The commit and the date of the build. Vite writes it at build time. */
declare const __BUILD__: { readonly sha: string; readonly date: string };

/** The data that the build reads from the real files of the stack. See `src/stack/snapshot.ts`. */
declare module "virtual:stack" {
  const snapshot: import("./stack/types.ts").Snapshot;
  export default snapshot;
}
