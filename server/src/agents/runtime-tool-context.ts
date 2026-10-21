import { AsyncLocalStorage } from "node:async_hooks";
import type { HeadlessTool } from "../computer/headless-tools";

// Headless contributors are already bound to the actor and turn that assembled them.
// Carry their executors through middleware instead of reconstructing a second tool list.
const surfaceTools = new AsyncLocalStorage<readonly HeadlessTool[]>();

export function withRuntimeSurfaceTools<T>(tools: readonly HeadlessTool[], run: () => T): T {
  const combined = new Map(currentRuntimeSurfaceTools().map((tool) => [tool.definition.name, tool]));
  for (const tool of tools) combined.set(tool.definition.name, tool);
  return surfaceTools.run([...combined.values()], run);
}

export function currentRuntimeSurfaceTools(): readonly HeadlessTool[] {
  return surfaceTools.getStore() ?? [];
}
