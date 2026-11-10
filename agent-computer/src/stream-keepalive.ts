/**
 * Live-screen keepalive across the viewer ↔ proxy ↔ computer hop.
 *
 * Chrome only pushes a screencast frame when the page changes. A static page with an idle
 * viewer therefore produces no data frames. Bun's WebSocket `idleTimeout` (default 120s) closes
 * a socket that has seen neither messages nor protocol pings; nginx and the app-server proxy
 * similarly treat a quiet connection as dead. Protocol `sendPings` help on a direct socket, but
 * the product stream is proxied as data frames only — control frames do not cross the proxy —
 * so the computer also emits an application `{type:"ping"}` on a timer. That JSON travels as a
 * data frame through the proxy and resets every idle clock on the path.
 *
 * A client `{type:"ping"}` is answered with `{type:"pong"}` before ownership / control checks, so
 * heartbeat never requires holding the wheel and never fails while the cast is still starting.
 */

export const STREAM_KEEPALIVE_MS = 30_000;

/** Match Bun's default websocket idleTimeout; documented here so the product decision is explicit. */
export const STREAM_IDLE_TIMEOUT_S = 120;

export function isKeepAlivePing(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "ping"
  );
}

export function isKeepAlivePong(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "pong"
  );
}

export function keepAlivePingPayload(now = Date.now()): { type: "ping"; t: number } {
  return { type: "ping", t: now };
}

export function keepAlivePongPayload(): { type: "pong" } {
  return { type: "pong" };
}
