/**
 * Coordinates HTTP `/screenshot` with LiveScreen screencast (DOG-05 root cause, 0.1.41).
 *
 * Playwright `page.screenshot` and CDP `Page.startScreencast` share one page. When both run at once
 * the HTTP path times out or 502s; the gateway maps that to opaque 503 while the live panel still
 * looks healthy. This gate refuses the fight with a clear busy, and serialises concurrent HTTP
 * captures so poll + tool do not pile CDP calls under load.
 *
 * Own module (like `viewer.ts`): decisions stay testable without launching Chromium.
 */

export class CaptureBusyError extends Error {
  readonly captureBusy = true as const;
  constructor(
    message: string,
    readonly liveCast: boolean,
  ) {
    super(message);
    this.name = "CaptureBusyError";
  }
}

/** English body the gateway keeps; the web UI localises via `captureBusy` / `liveCast`. */
export const CAPTURE_BUSY_LIVE_CAST =
  "Live screen is streaming; HTTP screenshot paused so they do not fight.";
export const CAPTURE_BUSY_IN_FLIGHT =
  "Another screenshot is already in progress.";

export type CaptureGate = {
  /**
   * Admit one HTTP capture, or throw CaptureBusyError.
   * `liveCast` is true when a viewer has an installed screencast on this Bot.
   */
  enter(liveCast: boolean): () => void;
  /** How many captures are holding the gate (0 or 1). Tests / diagnostics. */
  pending(): number;
};

export function createCaptureGate(): CaptureGate {
  let inFlight = false;
  return {
    enter(liveCast) {
      if (liveCast) {
        throw new CaptureBusyError(CAPTURE_BUSY_LIVE_CAST, true);
      }
      if (inFlight) {
        throw new CaptureBusyError(CAPTURE_BUSY_IN_FLIGHT, false);
      }
      inFlight = true;
      let released = false;
      return () => {
        // Idempotent: a stale second release must not clear a later admit.
        if (released) return;
        released = true;
        inFlight = false;
      };
    },
    pending() {
      return inFlight ? 1 : 0;
    },
  };
}
