/** The one state of the page. The map and the editor share the values, so a new port shows on the map at once. */

import snapshot from "virtual:stack";
import { baseValues } from "./model.ts";
import type { Values } from "./stack/compose-vars.ts";
import type { Signal } from "./stack/types.ts";

export { snapshot };

/** The state that more than one view reads. */
export interface PageState {
  signal: Signal;
  node: string;
  values: Values;
}

const listeners: (() => void)[] = [];

/** The current state. Only `update` changes it. */
export const state: PageState = { signal: "metrics", node: "", values: baseValues(snapshot.variables) };

/** This function changes the state, and tells each view. */
export function update(change: Partial<PageState>): void {
  Object.assign(state, change);
  for (const listener of listeners) listener();
}

/** This function adds a view that follows the state. */
export function subscribe(listener: () => void): void {
  listeners.push(listener);
}
