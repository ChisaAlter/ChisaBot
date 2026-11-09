import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeModelConnection, RuntimeModelResolver } from "./conversation-runtime";

type ModelConnectionScope = {
  connection?: Promise<RuntimeModelConnection>;
  agents?: Map<string, Promise<RuntimeModelConnection>>;
};
const modelConnections = new AsyncLocalStorage<ModelConnectionScope>();

/** Every request or headless turn gets its own lazy snapshot; nested turns start a new scope. */
export function withModelConnectionScope<T>(operation: () => T): T {
  return modelConnections.run({}, operation);
}

/** Policy checks, agent construction and tool selection must observe the same model and key. */
export function resolveScopedModelConnection(
  resolve: RuntimeModelResolver,
): Promise<RuntimeModelConnection> {
  const scope = modelConnections.getStore();
  if (!scope) return resolve();
  // Cache the pending promise too, so concurrent consumers cannot start different settings reads.
  scope.connection ??= Promise.resolve().then(resolve);
  return scope.connection;
}

/** Policy and execution share one exact BOT choice without affecting auxiliary global calls. */
export function resolveScopedAgentModelConnection(
  agentId: string,
  resolve: RuntimeModelResolver,
): Promise<RuntimeModelConnection> {
  const scope = modelConnections.getStore();
  if (!scope) return resolve();
  scope.agents ??= new Map();
  let connection = scope.agents.get(agentId);
  if (!connection) {
    connection = Promise.resolve().then(resolve);
    scope.agents.set(agentId, connection);
  }
  return connection;
}
