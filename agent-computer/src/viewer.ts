import { settleWithin } from "./env";
import type { Screencast } from "./screencast";

/**
 * Who is watching a Bot's live screen, and what may act on it.
 *
 * A Bot has one live screen and one cast. Several windows may watch it at the same time — the PC
 * client and a browser tab, two tabs of the same app — and before 2026-10-22 the second connection
 * replaced the first, which told the person in the first window "这块屏幕现在在另一个窗口看着，这边
 * 停下了" and stopped their screen (reported as "用着浏览器还是报错"). A second cast on the same page
 * is still wrong: Chrome would encode every frame twice with both sockets acking independently. So
 * the cast stays single and shared, frames are fanned out to every viewer, and the last frame is
 * replayed to whoever joins later so a newcomer is not left on a black canvas until the page changes.
 *
 * Who may *drive* is not decided here. Input is still gated by the control state in index.ts, so a
 * second window can watch without being able to type into the page unless it takes control.
 *
 * Ownership of the cast is held by the slot, not by a socket: no viewer can be superseded by another,
 * and `leave` only stops the cast when the last viewer has gone. A launch that loses its viewers
 * while the browser was starting has its cast refused and stopped (`install` answers false), which is
 * what keeps a closed socket from leaving a cast and a follow loop behind. Everything the slot starts
 * stops through the same accounting, so `occupied()` and `settled()` never say "nothing" while
 * Chrome is still encoding.
 *
 * Kept out of `index.ts` for the reason `browser-eviction.ts`, `authorisation.ts` and `bot-id.ts` are:
 * `index.ts` imports Playwright at module scope, so anything left there needs Chrome merely to be
 * imported by a test. `Screencast` comes in as a type only, so this module and its tests stay free of
 * the browser.
 */

/** How long a cast gets to stop before the teardown moves on without it. */
const STOP_BUDGET_MS = 5_000;

/**
 * What a socket may do with the screen right now.
 *
 * Three answers, not two. A viewer with no cast yet is mid-launch and its screen is still opening; a
 * socket that is not in the slot has been removed, closed, or never connected. Both own no cast, and
 * collapsing them tells somebody whose screen is still starting that their session ended. The message
 * is the only thing either of them gets, so it has to be the true one.
 */
export type ViewerStanding =
  | { state: "casting"; cast: Screencast }
  | { state: "starting" }
  | { state: "gone" };

/** One window watching the screen. `send` carries frames to it; `notify` only carries an end. */
export type ScreenViewer = {
  socket: unknown;
  notify: (reason: string) => void;
  send: (frame: unknown) => void;
};

export type ViewerSlot = {
  /**
   * Add a viewer. Answers whether this is the first one, so the caller starts the follow loop and
   * the keepalive once per Bot rather than once per socket.
   *
   * The latest frame, when there is one, is sent to the newcomer before this returns.
   */
  join(viewer: ScreenViewer): boolean;
  /** Remove one viewer. Stops the cast and the follow loop only when it was the last one. */
  leave(socket: unknown): Promise<void>;
  /** The browser went away. Tell every viewer why, and stop everything. */
  releaseAll(reason: string): Promise<void>;
  /** What this socket may do with the screen right now. */
  standingOf(socket: unknown): ViewerStanding;
  /** Is anybody watching, or about to be? What the session sweep asks. */
  occupied(): boolean;
  /**
   * Is a screencast installed right now?
   *
   * Stricter than `occupied`: a viewer whose cast is still starting is occupied but not casting.
   * HTTP `/screenshot` only refuses when Chrome is actually encoding frames — that is the CDP fight.
   * A starting viewer does not hold CDP screencast yet, so a card poll may still take a frame while
   * the big screen is connecting.
   */
  casting(): boolean;
  /**
   * Put a cast behind the slot, replacing one already there. Refused (and stopped) with no viewers.
   */
  install(cast: Screencast): Promise<boolean>;
  /**
   * Register the loop that keeps the cast on the Bot's current page.
   *
   * Answers false — and cancels what it was given — when the last viewer left while the browser was
   * still starting. Otherwise an interval registered after everybody had gone would keep asking for
   * a page every second, which is a launch path: the computer somebody stopped would come back up and
   * refresh its own idle timestamp forever.
   */
  setFollow(cancel: () => void): boolean;
  /** Send a frame to every viewer and remember it for the next one. */
  broadcast(frame: unknown): void;
  /** The last frame, for replaying to somebody who joins later. */
  latest(): unknown;
  /** How many windows are watching. */
  viewers(): number;
  /** Settle in-flight teardowns. A test seam; nothing on the acting path waits on this. */
  settled(): Promise<void>;
};

/** What a person is told when the browser they were watching went away. */
export const SCREEN_ENDED =
  "This screen is no longer live. Reopen it to carry on watching.";

export function createViewerSlot(): ViewerSlot {
  const watching = new Map<unknown, ScreenViewer>();
  let cast: Screencast | undefined;
  let cancelFollow: (() => void) | undefined;
  let lastFrame: unknown;
  /*
   * Teardowns still running. Occupancy counts them, because a browser whose cast is still stopping is
   * not yet a Bot nobody is watching, and the session sweep reading otherwise would drop the control
   * state out from under a screen that is mid-handover.
   */
  const tearing = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    tearing.add(work);
    void work.finally(() => tearing.delete(work));
  }

  function stopCast(next: Screencast | undefined): Promise<void> {
    if (!next) return Promise.resolve();
    const work = settleWithin(next.stop(), STOP_BUDGET_MS);
    track(work);
    return work;
  }

  /** Nobody is left: cancel the per-Bot loops and stop the one cast. */
  function stopWatching(): Promise<void> {
    cancelFollow?.();
    cancelFollow = undefined;
    lastFrame = undefined;
    const current = cast;
    cast = undefined;
    return stopCast(current);
  }

  /** Best effort: a socket can be gone, and one dead window must not stop the others' frames. */
  function deliver(viewer: ScreenViewer, frame: unknown): void {
    try {
      viewer.send(frame);
    } catch {
      // The close handler would remove it, but a send can fail before that arrives and the last
      // viewer failing must still stop the cast rather than leave it encoding for nobody.
      if (watching.get(viewer.socket) !== viewer) return;
      watching.delete(viewer.socket);
      if (watching.size === 0) void stopWatching();
    }
  }

  return {
    join(viewer) {
      watching.set(viewer.socket, viewer);
      if (lastFrame !== undefined) deliver(viewer, lastFrame);
      return watching.size === 1;
    },

    async leave(socket) {
      if (!watching.has(socket)) return;
      watching.delete(socket);
      // Somebody else is still watching: the cast and the follow loop stay as they are.
      if (watching.size > 0) return;
      await stopWatching();
    },

    async releaseAll(reason) {
      const all = [...watching.values()];
      watching.clear();
      cancelFollow?.();
      cancelFollow = undefined;
      lastFrame = undefined;
      for (const viewer of all) {
        try {
          viewer.notify(reason);
        } catch {
          // The socket is already gone. It cannot be told, and does not need to be.
        }
      }
      const current = cast;
      cast = undefined;
      await stopCast(current);
    },

    standingOf(socket) {
      if (!watching.has(socket)) return { state: "gone" };
      return cast ? { state: "casting", cast } : { state: "starting" };
    },

    occupied() {
      return watching.size > 0 || tearing.size > 0;
    },

    casting() {
      return cast !== undefined;
    },

    async install(next) {
      if (watching.size === 0) {
        // Nobody is left to watch it: the launch lost its viewers while it was starting. Stopped here
        // rather than returned, so a caller cannot leak a cast by forgetting to.
        await stopCast(next);
        return false;
      }
      const previous = cast;
      cast = next;
      // After the replacement is running, so the screen does not blank between the two.
      if (previous) await stopCast(previous);
      return true;
    },

    setFollow(cancel) {
      cancelFollow?.();
      /*
       * Everybody left while the browser was starting. The loop being offered was created after that
       * close and has nobody to cast for; cancelled here rather than returned, so the caller cannot
       * leak an interval by forgetting to check.
       */
      if (watching.size === 0) {
        cancel();
        return false;
      }
      cancelFollow = cancel;
      return true;
    },

    broadcast(frame) {
      if (frame && typeof frame === "object" && (frame as { type?: unknown }).type === "frame")
        lastFrame = frame;
      for (const viewer of [...watching.values()]) deliver(viewer, frame);
    },

    latest() {
      return lastFrame;
    },

    viewers() {
      return watching.size;
    },

    async settled() {
      await Promise.all([...tearing]);
    },
  };
}
