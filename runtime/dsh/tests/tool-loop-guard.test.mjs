import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalArgs,
  isMutatingTool,
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

test("mutating tool names cover write / edit / shell / test runners", () => {
  for (const name of [
    "write_file",
    "edit_file",
    "apply_patch",
    "run_tests",
    "shell",
    "bash",
    "exec",
  ])
    assert.equal(isMutatingTool(name), true, name);
  for (const name of ["read_file", "web_search", "ima_search", "status"])
    assert.equal(isMutatingTool(name), false, name);
});

test("the same call repeated: runs maxRepeats-1 times, refuses, then concludes honestly", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 3, grace: 2 });
  const call = () => {
    const v = guard.admit(1, "ima_search", { q: "数据库" });
    if (v.kind === "run") guard.observe({ result: { content: "no rows yet" } });
    return v;
  };
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
  assert.match(end.text, /成功 2 次/);
  assert.match(end.text, /不会假装已经完成/);
  assert.doesNotMatch(end.text, /TOOL_LOOP/);
});

test("different calls stop at the per-turn limit", () => {
  const guard = new ToolLoopGuard({ maxCalls: 3, maxRepeats: 3, grace: 0 });
  for (let n = 0; n < 3; n++) {
    assert.equal(guard.admit(7, "step", { n }).kind, "run");
    guard.observe({ result: { content: `ok${n}` } });
  }
  const end = guard.admit(7, "step", { n: 3 });
  assert.equal(end.kind, "conclude");
  assert.match(end.text, /单轮上限（3 次）/);
});

test("a new turn starts with fresh counts", () => {
  const guard = new ToolLoopGuard({ maxCalls: 2, maxRepeats: 2, grace: 1 });
  assert.equal(guard.admit(1, "a", {}).kind, "run");
  guard.observe({ result: { content: "x" } });
  assert.equal(guard.admit(1, "a", {}).kind, "refuse");
  assert.ok(guard.isStopped(1));
  assert.equal(guard.admit(2, "a", {}).kind, "run");
  assert.equal(guard.isStopped(1), false);
  assert.equal(guard.isStopped(2), false);
});

test("ordinary work is untouched", () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < TOOL_CALLS_PER_TURN; n++) {
    assert.equal(guard.admit(1, n % 2 ? "read" : "search", { n }).kind, "run");
    guard.observe({ result: { content: `r${n}` } });
  }
  // Polling the same status a couple of times is fine.
  const poll = new ToolLoopGuard();
  for (let n = 1; n < SAME_CALL_REPEATS; n++) {
    assert.equal(poll.admit(1, "status", { id: "job" }).kind, "run");
    poll.observe({ result: { content: "pending" } });
  }
});

test("QA513 P2: multi-step coding (read → write → test) is not blocked by the same path", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 4, grace: 1 });
  for (let round = 1; round <= 5; round++) {
    assert.equal(
      guard.admit(1, "read_file", { path: "src/a.ts" }).kind,
      "run",
      `read round ${round}`,
    );
    guard.observe({ result: { content: `source v${round}` } });
    assert.equal(
      guard.admit(1, "write_file", {
        path: "src/a.ts",
        content: `fixed ${round}`,
      }).kind,
      "run",
      `write round ${round}`,
    );
    guard.observe({ result: { content: "wrote" } });
    assert.equal(
      guard.admit(1, "run_tests", { cmd: "bun test a.test.ts" }).kind,
      "run",
      `test round ${round}`,
    );
    guard.observe({
      result: { content: round === 5 ? "pass" : `fail ${round}` },
    });
  }
  assert.equal(guard.succeeded + guard.failed, 15);
  assert.equal(guard.isStopped(1), false);
});

test("QA513 P2: an in-place repeat of the same call is still stopped", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 4, grace: 1 });
  for (let n = 0; n < 3; n++) {
    assert.equal(
      guard.admit(1, "run_tests", { cmd: "bun test a.test.ts" }).kind,
      "run",
    );
    guard.observe({ result: { content: "fail" } });
  }
  const stop = guard.admit(1, "run_tests", { cmd: "bun test a.test.ts" });
  assert.equal(stop.kind, "refuse");
  assert.match(stop.message, /TOOL_LOOP_STOPPED/);
});

test("QA513 P2: a changing result for the same call resets the repeat streak", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 4, grace: 1 });
  for (const status of [
    "pending",
    "pending",
    "running",
    "done",
    "done",
    "done",
  ]) {
    assert.equal(guard.admit(1, "status", { id: "job" }).kind, "run");
    guard.observe({ result: { content: status } });
  }
  // Three identical "done" already ran; the fourth identical "done" is refused.
  const stop = guard.admit(1, "status", { id: "job" });
  assert.equal(stop.kind, "refuse");
});

test("QA513 P3: conclusion separates success / failure / gateway rejects", () => {
  const guard = new ToolLoopGuard({ maxCalls: 5, maxRepeats: 10, grace: 0 });
  assert.equal(guard.admit(1, "web_search", { q: "a" }).kind, "run");
  guard.observe({ result: { content: "hits" } });
  assert.equal(guard.admit(1, "web_search", { q: "b" }).kind, "run");
  guard.observe({ result: { content: "Error: upstream 503" } });
  assert.equal(guard.admit(1, "web_search", { q: "c" }).kind, "run");
  guard.observe({ rejected: true });
  assert.equal(guard.admit(1, "web_search", { q: "d" }).kind, "run");
  guard.observe({ result: { content: "ok" } });
  assert.equal(guard.admit(1, "web_search", { q: "e" }).kind, "run");
  guard.observe({ result: { content: "ok2" } });
  const end = guard.admit(1, "web_search", { q: "f" });
  assert.equal(end.kind, "conclude");
  assert.match(end.text, /实际执行了 4 次工具调用/);
  assert.match(end.text, /成功 3 次/);
  assert.match(end.text, /失败 1 次/);
  assert.match(end.text, /另有 1 次调用被网关拒绝、未执行/);
  assert.match(end.text, /已有部分结果/);
  assert.doesNotMatch(end.text, /没有拿到可以确认的结果/);
});

test("QA513 P3: a deferred approval does not count as a gateway reject", () => {
  const guard = new ToolLoopGuard({ maxCalls: 40, maxRepeats: 4, grace: 1 });
  assert.equal(guard.admit(1, "send", { to: "a" }).kind, "run");
  guard.observe({ deferred: true });
  assert.equal(guard.rejected, 0);
  assert.equal(guard.succeeded, 0);
});

test("QA513 P3: ensureLoopGuard keeps counts across rebind of the same run", async () => {
  const { ensureLoopGuard } = await import("../src/tool-loop-guard.mjs");
  const limits = { maxCalls: 40, maxRepeats: 4, grace: 1 };
  const state = { binding: { runId: "run-1" } };
  const first = ensureLoopGuard(state, limits);
  assert.equal(first.admit(1, "ima_search", { q: "x" }).kind, "run");
  first.observe({ result: { content: "a" } });
  assert.equal(first.admit(1, "ima_search", { q: "x" }).kind, "run");
  first.observe({ result: { content: "a" } });
  // Simulate compose on approval resume: same runId.
  const again = ensureLoopGuard(state, limits);
  assert.equal(again, first);
  assert.equal(again.admit(1, "ima_search", { q: "x" }).kind, "run");
  again.observe({ result: { content: "a" } });
  assert.equal(again.admit(1, "ima_search", { q: "x" }).kind, "refuse");
  // A new run replaces the guard.
  state.binding = { runId: "run-2" };
  const next = ensureLoopGuard(state, limits);
  assert.notEqual(next, first);
  assert.equal(next.admit(1, "ima_search", { q: "x" }).kind, "run");
});
