import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalArgs,
  SAME_CALL_REPEATS,
  STOP_GRACE_CALLS,
  TOOL_CALLS_PER_TURN,
  ToolLoopGuard,
  toolLoopLimits,
} from "../src/tool-loop-guard.mjs";

test("defaults bound every turn", () => {
  assert.deepEqual(toolLoopLimits(undefined), {
    maxCalls: TOOL_CALLS_PER_TURN,
    maxRepeats: SAME_CALL_REPEATS,
    grace: STOP_GRACE_CALLS,
  });
  assert.ok(TOOL_CALLS_PER_TURN > 0 && SAME_CALL_REPEATS >= 2);
  assert.throws(() => toolLoopLimits({ maxCalls: 0 }), /toolLoop\.maxCalls/);
  assert.throws(
    () => toolLoopLimits({ maxRepeats: 1 }),
    /toolLoop\.maxRepeats/,
  );
  assert.throws(() => toolLoopLimits({ grace: -1 }), /toolLoop\.grace/);
  assert.throws(() => toolLoopLimits({ maxCalls: 1.5 }), /toolLoop\.maxCalls/);
  assert.equal(toolLoopLimits({ grace: 0 }).grace, 0);
});

test("argument order does not hide a repeat", () => {
  assert.equal(
    canonicalArgs({ b: 1, a: [{ y: 2, x: 1 }] }),
    canonicalArgs({ a: [{ x: 1, y: 2 }], b: 1 }),
  );
  assert.notEqual(canonicalArgs({ a: 1 }), canonicalArgs({ a: "1" }));
});

test("the same call repeated: runs maxRepeats-1 times, refuses, then concludes honestly", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 3, grace: 2 });
  const call = () => guard.admit(1, "ima_search", { q: "数据库" });
  assert.equal(call().kind, "run");
  assert.equal(call().kind, "run");
  const stop = call();
  assert.equal(stop.kind, "refuse");
  assert.match(stop.message, /TOOL_LOOP_STOPPED/);
  assert.match(stop.message, /ima_search/);
  assert.match(stop.message, /Do not call any more tools/);
  assert.ok(guard.isStopped(1));
  // Any tool, not only the repeated one, is refused for the rest of the turn.
  assert.equal(guard.admit(1, "web_search", { q: "x" }).kind, "refuse");
  assert.equal(call().kind, "refuse");
  const end = call();
  assert.equal(end.kind, "conclude");
  assert.match(end.text, /ima_search/);
  assert.match(end.text, /实际执行了 2 次工具调用/);
  assert.match(end.text, /不会假装已经完成/);
  assert.doesNotMatch(end.text, /TOOL_LOOP/);
});

test("different calls stop at the per-turn limit", () => {
  const guard = new ToolLoopGuard({ maxCalls: 3, maxRepeats: 3, grace: 0 });
  for (let n = 0; n < 3; n++)
    assert.equal(guard.admit(7, "step", { n }).kind, "run");
  const end = guard.admit(7, "step", { n: 3 });
  assert.equal(end.kind, "conclude");
  assert.match(end.text, /单轮上限（3 次）/);
});

test("a new turn starts with fresh counts", () => {
  const guard = new ToolLoopGuard({ maxCalls: 2, maxRepeats: 2, grace: 1 });
  assert.equal(guard.admit(1, "a", {}).kind, "run");
  assert.equal(guard.admit(1, "a", {}).kind, "refuse");
  assert.ok(guard.isStopped(1));
  assert.equal(guard.admit(2, "a", {}).kind, "run");
  assert.equal(guard.isStopped(1), false);
  assert.equal(guard.isStopped(2), false);
});

test("ordinary work is untouched", () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < TOOL_CALLS_PER_TURN; n++)
    assert.equal(guard.admit(1, n % 2 ? "read" : "search", { n }).kind, "run");
  // Polling the same status a couple of times is fine.
  const poll = new ToolLoopGuard();
  for (let n = 1; n < SAME_CALL_REPEATS; n++)
    assert.equal(poll.admit(1, "status", { id: "job" }).kind, "run");
});
