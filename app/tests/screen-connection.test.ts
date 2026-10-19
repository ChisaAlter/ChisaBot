import { expect, test } from "bun:test";
import {
  connectScreen,
  type ScreenSocket,
} from "../src/lib/computers/screen-connection";

function rig() {
  const sockets: ScreenSocket[] = [];
  const timers: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const statuses: string[] = [];
  let stopped = 0;
  const control = connectScreen({
    open: () => {
      const socket: ScreenSocket = {
        onopen: null,
        onclose: null,
        onerror: null,
        onmessage: null,
        close: () => undefined,
      };
      sockets.push(socket);
      return socket;
    },
    schedule: (run, delay) => {
      const timer = { run, delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    onReady: (ready) => statuses.push(ready ? "ready" : "blocked"),
    onProblem: (problem) => {
      if (problem) statuses.push(problem);
    },
    onDisconnect: () => {
      stopped++;
    },
    onMessage: () => undefined,
  });
  return {
    sockets,
    timers,
    statuses,
    control,
    stopped: () => stopped,
  };
}

test("connection loss disables input, retries boundedly, then asks for Retry", async () => {
  const r = rig();
  r.sockets[0]?.onopen?.();
  r.sockets[0]?.onclose?.();
  expect(r.statuses.at(-2)).toBe("blocked");
  for (let i = 0; i < 5; i++) {
    r.timers[i]?.run();
    r.sockets[i + 1]?.onclose?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 1000, 2000, 4000, 8000]);
  expect(r.statuses.at(-1)).toContain("重试");
  expect(r.stopped()).toBe(6);
  r.control.stop();
});

test("a reconnect that shows the screen again restores the whole retry budget", async () => {
  const r = rig();
  const frame = { data: JSON.stringify({ type: "frame", data: "AA==" }) };
  await r.sockets[0]?.onopen?.();
  for (let i = 0; i < 6; i++) {
    r.sockets[i]?.onmessage?.(frame);
    r.sockets[i]?.onclose?.();
    r.timers[i]?.run();
    await r.sockets[i + 1]?.onopen?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 500, 500, 500, 500, 500]);
  expect(r.statuses.some((status) => status.includes("重试"))).toBe(false);
  // The screen is back, so input is ready again without asking anybody anything.
  expect(r.statuses.at(-1)).toBe("ready");
  r.control.stop();
});


test("application keepalive ping also restores the retry budget (static page, CR-P2-12)", async () => {
  const r = rig();
  const ping = { data: JSON.stringify({ type: "ping", t: 1 }) };
  await r.sockets[0]?.onopen?.();
  for (let i = 0; i < 6; i++) {
    r.sockets[i]?.onmessage?.(ping);
    r.sockets[i]?.onclose?.();
    r.timers[i]?.run();
    await r.sockets[i + 1]?.onopen?.();
  }
  expect(r.timers.map((t) => t.delay)).toEqual([500, 500, 500, 500, 500, 500]);
  expect(r.statuses.some((status) => status.includes("重试"))).toBe(false);
  expect(r.statuses.at(-1)).toBe("ready");
  r.control.stop();
});

test("a reconnect makes input ready again without waiting on the control state", async () => {
  // The bug this replaces: on a reconnect the module also asked who held the wheel, and reported
  // input ready only if that read said "a person does". When the read failed — a deploy, a busy
  // computer, a laptop waking up — input stayed blocked for the rest of the session while frames
  // kept arriving: the picture was live and every click, keystroke and wheel turn was dropped with
  // nothing said. Whether the person may drive is the control state's answer and the computer's to
  // refuse; the screen coming back is the transport's.
  const r = rig();
  r.sockets[0]?.onclose?.();
  r.timers[0]?.run();
  await r.sockets[1]?.onopen?.();
  expect(r.statuses.at(-1)).toBe("ready");
  r.control.stop();
});

test("a superseded viewer stays stopped until explicit Retry", () => {
  const r = rig();
  r.sockets[0]?.onmessage?.({
    data: JSON.stringify({
      type: "error",
      error:
        "This screen is now being watched somewhere else, so it stopped here.",
    }),
  });
  r.sockets[0]?.onclose?.();
  expect(r.timers).toHaveLength(0);
  expect(r.statuses.at(-1)).toContain("watched somewhere else");
  r.control.stop();
});

test("unmount cancels a pending reconnect and ignores old socket callbacks", () => {
  const r = rig();
  r.sockets[0]?.onclose?.();
  r.control.stop();
  r.timers[0]?.run();
  expect(r.timers[0]?.cancelled).toBe(true);
  expect(r.sockets).toHaveLength(1);
});
