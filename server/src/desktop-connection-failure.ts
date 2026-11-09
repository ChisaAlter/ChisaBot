import { readCompatibleHeader } from "../../shared/legacy-headers";
import { PREVIOUS_MODEL_AUTH_ERROR } from "./legacy/protocol";
import { timingSafeEqual } from "node:crypto";
import type { BaseEvent } from "@ag-ui/client";
import type { Env, Hono } from "hono";
import { type Observable, tap } from "rxjs";

export type DesktopConnectionFailure =
  | { connection: "model"; code: "provider_authentication_failed" }
  | { connection: "intelligence"; code: "intelligence_authentication_failed" }
  | { connection: "organization"; code: "organization_authentication_failed" };

const failures = new Map<
  DesktopConnectionFailure["connection"],
  DesktopConnectionFailure
>();

/** Session-only signal for the native host. Never retains provider messages or credentials. */
export function recordDesktopConnectionFailure(
  failure: DesktopConnectionFailure,
): void {
  failures.set(failure.connection, failure);
}

export function clearDesktopConnectionFailure(
  connection: DesktopConnectionFailure["connection"],
): void {
  failures.delete(connection);
}

export function mountDesktopConnectionFailure<T extends Env>(
  app: Hono<T>,
  hostToken: string | undefined,
): void {
  const expected = hostToken?.trim();
  if (!expected) return;
  app.get("/api/desktop/connection-failure", (context) => {
    const offered = readCompatibleHeader(context.req.raw.headers, "x-chisabot-desktop-host-token") ??
      "";
    const a = Buffer.from(offered),
      b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return context.json({ error: "unauthorised" }, 401);
    context.header("Cache-Control", "no-store");
    return context.json(failures.values().next().value ?? null);
  });
}

/** Only provider SDK errors qualify; a harness HTTP 401 is a different credential.
 * A provider 403 can mean missing project/resource permission, not expired credentials.
 */
export function isModelAuthenticationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChisaBotModelAuthenticationError") return true;
  if (
    error.name === "AI_APICallError" &&
    "statusCode" in error &&
    error.statusCode === 401
  )
    return true;
  return (
    error.cause !== error &&
    error.cause instanceof Error &&
    isModelAuthenticationError(error.cause)
  );
}

export function observeModelConnection(
  stream: Observable<BaseEvent>,
): Observable<BaseEvent> {
  return stream.pipe(
    tap({
      next: (event) => {
        if (
          event.type === "RUN_ERROR" &&
          (event.code === "CHISABOT_MODEL_AUTH_REQUIRED" || event.code === PREVIOUS_MODEL_AUTH_ERROR)
        ) {
          recordDesktopConnectionFailure({
            connection: "model",
            code: "provider_authentication_failed",
          });
        } else if (
          event.type === "TEXT_MESSAGE_CONTENT" ||
          event.type === "TOOL_CALL_START"
        ) {
          clearDesktopConnectionFailure("model");
        }
      },
      error: (error: unknown) => {
        if (isModelAuthenticationError(error))
          recordDesktopConnectionFailure({
            connection: "model",
            code: "provider_authentication_failed",
          });
      },
    }),
  );
}
