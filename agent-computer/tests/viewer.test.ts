import { describe, expect, test } from "bun:test";
import type { Screencast } from "../src/screencast";
import { createViewerSlot, SCREEN_ENDED } from "../src/viewer";

/**
 * The Bot's live screen, watched by any number of windows.
 *
 * A Bot has one cast. Several windows may watch it (PC client + browser tab, two tabs) and they all
 * get the same frames; before 2026-10-22 the second window replaced the first and told it the screen
 * was being watched somewhere else, which is the reported "用着浏览器还是报错".
 *
 * What has to hold:
 *  - the cast starts once and stops once (when the last viewer leaves), not once per window;
 *  - a newcomer is handed the latest frame instead of a black canvas on a static page;
 *  - a launch that loses its viewers while starting never leaves a cast encoding for nobody;
 *  - one dead socket does not stop the other windows' frames, and the last one dying does stop the cast;
 *  - `occupied()` covers the launch and the teardown, because the session sweep reads it to decide
 *    whether a Bot may be forgotten.
 *
 * The decisions rather than the stopping: these tests use fake casts, so nothing here needs Chrome.
 */

function fakeCast(): Screencast & { stops: number; sent: unknown[] } {
  const cast = {
    stops: 0,
    sent: [] as unknown[],
    async stop() {
      cast.stops += 1;
    },
    async send(message: unknown) {
      cast.sent.push(message);
    },
  };
  return cast as Screencast & { stops: number; sent: unknown[] };
}

/** A cast whose stop hangs until it is let go, so a teardown can be observed mid-flight. */
function pendingCast(): Screencast & { finish: () => void; stops: number } {
  let release = () => {};
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cast = {
    stops: 0,
    async stop() {
      cast.stops += 1;
      await stopped;
    },
    async send() {},
    finish: () => release(),
  };
  return cast as Screencast & { finish: () => void; stops: number };
}

function brokenCast(): Screencast {
  return {
    async stop() {
      throw new Error("the page went away first");
    },
    async send() {},
  } as Screencast;
}

function window_(id: string) {
  const frames: unknown[] = [];
  const said: string[] = [];
  const socket = { id };
  return {
    socket,
    frames,
    said,
    viewer: {
      socket,
      notify: (reason: string) => said.push(reason),
      send: (frame: unknown) => frames.push(frame),
    },
  };
}

describe("several windows watching the same screen", () => {
  test("the first viewer is told it is first; the second is not", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const b = window_("b");

    expect(slot.join(a.viewer)).toBe(true);
    expect(slot.join(b.viewer)).toBe(false);
    expect(slot.viewers()).toBe(2);
    expect(slot.occupied()).toBe(true);
    // Both are mid-launch until the cast exists.
    expect(slot.standingOf(a.socket).state).toBe("starting");
    expect(slot.standingOf(b.socket).state).toBe("starting");
  });

  test("a second window no longer replaces the first", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const b = window_("b");
    const cast = fakeCast();

    slot.join(a.viewer);
    await slot.install(cast);
    slot.join(b.viewer);
    await slot.settled();

    // Nothing is torn down by the newcomer, and nobody is told their screen ended.
    expect(cast.stops).toBe(0);
    expect(a.said).toEqual([]);
    expect(slot.standingOf(a.socket).state).toBe("casting");
    expect(slot.standingOf(b.socket).state).toBe("casting");
  });

  test("one cast's frames reach every window, and the newcomer gets the last one", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    slot.join(a.viewer);
    await slot.install(cast);

    slot.broadcast({ type: "frame", data: "AA" });
    expect(a.frames).toEqual([{ type: "frame", data: "AA" }]);

    const b = window_("b");
    slot.join(b.viewer);
    // Replayed on join, so a static page is not a black canvas for the second window.
    expect(b.frames).toEqual([{ type: "frame", data: "AA" }]);

    slot.broadcast({ type: "frame", data: "BB" });
    expect(a.frames.at(-1)).toEqual({ type: "frame", data: "BB" });
    expect(b.frames.at(-1)).toEqual({ type: "frame", data: "BB" });
    expect(cast.stops).toBe(0);
  });

  test("only frames are kept for replay; keepalives are not", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);
    slot.broadcast({ type: "ping" });

    const b = window_("b");
    slot.join(b.viewer);

    expect(b.frames).toEqual([]);
  });
});

describe("leaving", () => {
  test("one window closing keeps the cast and the follow loop", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const b = window_("b");
    const cast = fakeCast();
    let cancelled = 0;

    slot.join(a.viewer);
    slot.join(b.viewer);
    await slot.install(cast);
    slot.setFollow(() => {
      cancelled += 1;
    });

    await slot.leave(a.socket);

    expect(cast.stops).toBe(0);
    expect(cancelled).toBe(0);
    expect(slot.standingOf(b.socket).state).toBe("casting");
    expect(slot.occupied()).toBe(true);
  });

  test("the last window closing stops the cast once and cancels the loop", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    let cancelled = 0;

    slot.join(a.viewer);
    await slot.install(cast);
    slot.setFollow(() => {
      cancelled += 1;
    });

    await slot.leave(a.socket);

    expect(cast.stops).toBe(1);
    expect(cancelled).toBe(1);
    expect(slot.occupied()).toBe(false);
    expect(slot.casting()).toBe(false);
    expect(slot.latest()).toBeUndefined();
  });

  test("a close for a socket that never joined does nothing", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    slot.join(a.viewer);
    await slot.install(cast);

    await slot.leave({ id: "stranger" });

    expect(cast.stops).toBe(0);
    expect(slot.standingOf(a.socket).state).toBe("casting");
  });

  test("the same socket leaving twice stops the cast once", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    slot.join(a.viewer);
    await slot.install(cast);

    await slot.leave(a.socket);
    await slot.leave(a.socket);

    expect(cast.stops).toBe(1);
  });
});

describe("a window whose socket is already dead", () => {
  test("a failing send removes that window but keeps the others watching", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    slot.join(a.viewer);
    await slot.install(cast);

    const dead = {
      socket: { id: "dead" },
      notify: () => {},
      send: () => {
        throw new Error("socket closed");
      },
    };
    slot.join(dead);

    slot.broadcast({ type: "frame", data: "AA" });

    expect(slot.viewers()).toBe(1);
    expect(cast.stops).toBe(0);
    expect(a.frames).toEqual([{ type: "frame", data: "AA" }]);
  });

  test("the last window failing to take a frame stops the cast", async () => {
    const slot = createViewerSlot();
    const cast = fakeCast();
    slot.join({
      socket: { id: "dead" },
      notify: () => {},
      send: () => {
        throw new Error("socket closed");
      },
    });
    await slot.install(cast);

    slot.broadcast({ type: "frame", data: "AA" });
    await slot.settled();

    expect(cast.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
  });
});

describe("a launch that loses its viewers", () => {
  test("the cast it produced is refused and stopped, not installed", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);
    await slot.leave(a.socket);

    const late = fakeCast();
    expect(await slot.install(late)).toBe(false);
    expect(late.stops).toBe(1);
    expect(slot.occupied()).toBe(false);
  });

  test("a viewer that joins during the launch keeps the cast", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);
    await slot.leave(a.socket);

    // A reconnect lands before the launch's cast is installed: somebody is watching again.
    const b = window_("b");
    slot.join(b.viewer);
    const cast = fakeCast();

    expect(await slot.install(cast)).toBe(true);
    expect(cast.stops).toBe(0);
    expect(slot.standingOf(b.socket).state).toBe("casting");
  });
});

describe("the browser closing under every window", () => {
  test("everybody is told, the cast stops, the loops end", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const b = window_("b");
    const cast = fakeCast();
    let cancelled = 0;

    slot.join(a.viewer);
    slot.join(b.viewer);
    await slot.install(cast);
    slot.setFollow(() => {
      cancelled += 1;
    });

    await slot.releaseAll("the computer was stopped");

    expect(cast.stops).toBe(1);
    expect(cancelled).toBe(1);
    expect(a.said).toEqual(["the computer was stopped"]);
    expect(b.said).toEqual(["the computer was stopped"]);
    expect(slot.occupied()).toBe(false);
    expect(slot.standingOf(a.socket).state).toBe("gone");
  });

  test("an empty slot tells nobody and does nothing", async () => {
    const slot = createViewerSlot();
    await slot.releaseAll(SCREEN_ENDED);
    expect(slot.occupied()).toBe(false);
  });
});

describe("standing", () => {
  test("identity, not shape", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);

    expect(slot.standingOf({ id: "a" }).state).toBe("gone");
  });

  test("casting hands that socket the shared cast", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = fakeCast();
    slot.join(a.viewer);
    await slot.install(cast);

    const standing = slot.standingOf(a.socket);
    expect(standing.state === "casting" && standing.cast).toBe(cast);
  });
});

describe("the follow loop", () => {
  test("registering a new one cancels the one it replaces", () => {
    const slot = createViewerSlot();
    let cancelled = 0;
    slot.join(window_("a").viewer);
    expect(
      slot.setFollow(() => {
        cancelled += 1;
      }),
    ).toBe(true);
    slot.setFollow(() => {});

    expect(cancelled).toBe(1);
  });

  test("a loop offered after the last viewer left is cancelled and refused", async () => {
    // The close can land while the browser is still starting; the loop is created after that await.
    // Installing it anyway is what used to relaunch a stopped computer once a second.
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);
    await slot.leave(a.socket);

    let cancelled = 0;
    expect(
      slot.setFollow(() => {
        cancelled += 1;
      }),
    ).toBe(false);
    expect(cancelled).toBe(1);
  });
});

describe("the session sweep asking whether anybody is watching", () => {
  test("a Bot is watched from the join, not from the first frame", () => {
    const slot = createViewerSlot();
    slot.join(window_("a").viewer);
    expect(slot.occupied()).toBe(true);
    expect(slot.casting()).toBe(false);
  });

  test("a Bot stays watched while its cast is stopping", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    const cast = pendingCast();
    slot.join(a.viewer);
    await slot.install(cast);

    const leaving = slot.leave(a.socket);
    await Promise.resolve();

    expect(slot.occupied()).toBe(true);

    cast.finish();
    await leaving;

    expect(slot.occupied()).toBe(false);
  });
});

describe("casts that fail to stop", () => {
  test("a rejecting stop does not break leaving", async () => {
    const slot = createViewerSlot();
    const a = window_("a");
    slot.join(a.viewer);
    await slot.install(brokenCast());

    await slot.leave(a.socket);

    expect(slot.occupied()).toBe(false);
  });

  test("a rejecting stop does not break the browser going away", async () => {
    const slot = createViewerSlot();
    slot.join(window_("a").viewer);
    await slot.install(brokenCast());

    await slot.releaseAll("the computer was stopped");

    expect(slot.occupied()).toBe(false);
  });

  test("a notify that throws does not stop the others being told", async () => {
    const slot = createViewerSlot();
    const ok = window_("ok");
    slot.join({
      socket: { id: "bad" },
      notify: () => {
        throw new Error("that socket is closed");
      },
      send: () => {},
    });
    slot.join(ok.viewer);

    await slot.releaseAll("the computer was stopped");

    expect(ok.said).toEqual(["the computer was stopped"]);
    expect(slot.occupied()).toBe(false);
  });
});
