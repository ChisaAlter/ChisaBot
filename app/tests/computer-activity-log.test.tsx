import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { batchCommands, groupActivity } from "@/lib/computers/activity-groups";
import type { ActivityStep } from "@/lib/computers/use-computer-activity";
import {
  refusalText,
  statusText,
  stepVerb,
} from "../../shared/computer-activity-labels";
import { settleReactWork } from "./settle-react-work";

let ActivityLog: typeof import("@/components/computer/activity-log").ActivityLog;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  ({ ActivityLog } = await import("@/components/computer/activity-log"));
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

let n = 0;
function step(partial: Partial<ActivityStep>): ActivityStep {
  n += 1;
  return {
    id: `s${n}`,
    seq: n,
    threadId: "t",
    runId: "r1",
    toolCallId: `c${n}`,
    actorKind: "agent",
    kind: "run_command",
    status: "ok",
    refusalReason: null,
    subject: "ls",
    detail: { exitCode: 0 },
    output: "",
    outputTruncated: false,
    hasFrame: false,
    turnPrompt: "看看目录",
    turnStatus: "completed",
    startedAt: new Date(Date.UTC(2026, 9, 26, 2, 0, n)).toISOString(),
    finishedAt: null,
    durationMs: 120,
    ...partial,
  };
}

test("three successful probe commands in a row merge; a failed one stays on its own", () => {
  const items = batchCommands([
    step({ subject: "ls" }),
    step({ subject: "pwd" }),
    step({ subject: "date" }),
    step({ subject: "cat x", status: "failed", detail: { exitCode: 1 } }),
  ]);
  expect(items.map((item) => item.type)).toEqual(["batch", "step"]);
});

test("two probe commands are not merged", () => {
  expect(
    batchCommands([step({ subject: "ls" }), step({ subject: "pwd" })]).map(
      (i) => i.type,
    ),
  ).toEqual(["step", "step"]);
});

test("steps group by run and human steps form their own group", () => {
  const steps = [
    step({ runId: "r2" }),
    step({ actorKind: "human", kind: "click", runId: null, toolCallId: null }),
    step({ runId: "r1" }),
  ].reverse();
  const turns = groupActivity([...steps].sort((a, b) => b.seq - a.seq));
  expect(turns.map((turn) => turn.actorKind)).toEqual([
    "agent",
    "human",
    "agent",
  ]);
});

test("labels speak to people", () => {
  expect(refusalText("user_in_control")).toBe("已拒绝：电脑当前由你控制");
  expect(
    statusText({
      actorKind: "agent",
      kind: "run_command",
      status: "failed",
      subject: "x",
      detail: { exitCode: 2 },
    }),
  ).toBe("失败 · 退出码 2");
  expect(
    stepVerb({ actorKind: "human", kind: "type", status: "ok", subject: "" }),
  ).toBe("输入了文字");
  expect(
    stepVerb({
      actorKind: "agent",
      kind: "navigate",
      status: "running",
      subject: "",
    }),
  ).toBe("正在打开");
});

test("renders merged commands, the refused state and the human label", async () => {
  const steps = [
    step({ subject: "ls" }),
    step({ subject: "pwd" }),
    step({ subject: "whoami" }),
    step({
      subject: "date",
      status: "refused",
      refusalReason: "user_in_control",
      detail: {},
    }),
    step({
      actorKind: "human",
      kind: "type",
      runId: null,
      toolCallId: null,
      subject: "",
      detail: { humanText: true },
    }),
  ].sort((a, b) => b.seq - a.seq);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ steps, nextCursor: null, retentionDays: 90 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as never;
  const view = render(<ActivityLog computerId="bot" />);
  await waitFor(() =>
    expect(view.container.textContent).toContain("运行了 3 条命令"),
  );
  const text = view.container.textContent ?? "";
  expect(text).toContain("已拒绝：电脑当前由你控制");
  expect(text).not.toContain("接管");
  expect(text).toContain("你");
  expect(text).toContain("输入了文字");
  expect(text).toContain("记录保留 90 天");
});

test("falls back to the in-browser log when the server has no activity endpoint", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as never;
  const view = render(<ActivityLog computerId="bot" />);
  await waitFor(() => expect(view.container.textContent).toContain("暂无"));
});

test("concurrent tool calls each send their own turn and tool call ids", async () => {
  const { bindComputerCallMeta, computerCallHeaders } = await import(
    "@/lib/computers/call-meta"
  );
  const shared = new AbortController().signal;
  const a = bindComputerCallMeta(
    { threadId: "t", runId: "turnA", toolCallId: "callA" },
    shared,
  );
  const b = bindComputerCallMeta(
    { threadId: "t", runId: "turnB", toolCallId: "callB" },
    shared,
  );
  // B 后登记，A 的请求也不能拿到 B 的归属。
  expect(computerCallHeaders(a)).toEqual({
    "x-chisabot-thread": "t",
    "x-chisabot-run": "turnA",
    "x-chisabot-tool-call": "callA",
  });
  expect(computerCallHeaders(b)?.["x-chisabot-tool-call"]).toBe("callB");
  // 没有绑定的请求不带归属（服务端记为未归属），不取「最近一次」。
  expect(computerCallHeaders(undefined)).toBeUndefined();
  expect(computerCallHeaders(new AbortController().signal)).toBeUndefined();
});

test("interleaved turns are grouped by their turn id, unattributed steps are not guessed", () => {
  const turns = groupActivity([
    step({
      id: "4",
      runId: "A",
      toolCallId: "a2",
      startedAt: "2026-10-26T10:00:04Z",
    }),
    step({
      id: "3",
      runId: "B",
      toolCallId: "b1",
      startedAt: "2026-10-26T10:00:03Z",
    }),
    step({
      id: "2",
      runId: "A",
      toolCallId: "a1",
      startedAt: "2026-10-26T10:00:02Z",
    }),
    step({
      id: "1",
      runId: null,
      threadId: "t",
      toolCallId: null,
      startedAt: "2026-10-26T10:00:01Z",
    }),
  ]);
  expect(turns.map((turn) => turn.runId)).toEqual(["A", "B", null]);
  expect(
    turns[0]?.items.map((item) => (item.type === "step" ? item.step.id : "")),
  ).toEqual(["2", "4"]);
});
