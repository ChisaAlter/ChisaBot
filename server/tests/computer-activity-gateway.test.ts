import { describe, expect, test } from "bun:test";
import {
  classifyError,
  withActivityScope,
  withComputerActivity,
} from "../src/computer/activity-recorder";
import type {
  ActivityStore,
  BeginInput,
  FinishInput,
} from "../src/computer/activity-store";
import { CaptureBusyError, HumanHasControlError } from "../src/computer/client";
import { statusText } from "../../shared/computer-activity-labels";
import type { ComputerGateway } from "../src/computer/gateway";

function fakeStore() {
  const begun: (BeginInput & { id: string })[] = [];
  const finished: { id: string; input: FinishInput }[] = [];
  const bumps: { id: string; detail: Record<string, unknown> }[] = [];
  let n = 0;
  const store = {
    async begin(input: BeginInput) {
      const id = `s${++n}`;
      begun.push({ ...input, id });
      return id;
    },
    async finish(id: string, input: FinishInput) {
      finished.push({ id, input });
    },
    async markFrame() {},
    async bump(id: string, detail: Record<string, unknown>) {
      bumps.push({ id, detail });
    },
  } as unknown as ActivityStore;
  return { store, begun, finished, bumps };
}

function fakeGateway(
  overrides: Partial<
    Record<string, (...a: unknown[]) => Promise<unknown>>
  > = {},
) {
  return {
    status: async () => ({ state: "ready" }),
    screenshot: async () => ({ base64: "", url: "" }),
    runCommand: async (
      _b: string,
      _a: unknown,
      input: { command: string },
    ) => ({
      command: input.command,
      exitCode: 0,
      stdout: "a\nb\n",
      stderr: "",
      truncated: false,
      timedOut: false,
      elapsedMs: 3,
    }),
    navigate: async (_b: string, _a: unknown, url: string) => ({
      url,
      title: "Example",
      text: "",
    }),
    type: async () => ({
      action: "type",
      element: { role: "textbox", name: "Password" },
      url: "https://x.dev",
    }),
    humanInput: async () => ({}),
    ...overrides,
  } as unknown as ComputerGateway;
}

const actor = { id: "u1", userId: "u1" };

describe("activity recorder", () => {
  test("records an agent command with exit code and output", async () => {
    const { store, begun, finished } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), { store: () => store });
    await withActivityScope(
      { threadId: "t", runId: "r", toolCallId: "c1", actorUserId: "u1" },
      () => gateway.runCommand("bot", actor, { command: "ls -la" } as never),
    );
    expect(begun[0]).toMatchObject({
      kind: "run_command",
      actorKind: "agent",
      toolCallId: "c1",
      threadId: "t",
      subject: "ls -la",
    });
    expect(finished[0].input).toMatchObject({
      status: "ok",
      output: "a\nb\n",
      detail: { exitCode: 0, lines: 2 },
    });
  });

  test("masks typed text in a password field", async () => {
    const { store, finished } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), { store: () => store });
    await withActivityScope({ toolCallId: "c2" }, () =>
      gateway.type(
        "bot",
        actor,
        { ref: "e1", text: "hunter2" } as never,
        undefined as never,
      ),
    );
    expect(finished[0].input.subject).toBe("••••");
    expect(JSON.stringify(finished)).not.toContain("hunter2");
  });

  test("a step refused because the person has control is refused, not failed, and keeps no model text", async () => {
    const { store, finished } = fakeStore();
    const gateway = withComputerActivity(
      fakeGateway({
        runCommand: async () => {
          throw new HumanHasControlError(
            "没有执行：这台计算机现在由用户接管着",
          );
        },
      }),
      { store: () => store },
    );
    await expect(
      withActivityScope({ toolCallId: "c3" }, () =>
        gateway.runCommand("bot", actor, { command: "date" } as never),
      ),
    ).rejects.toThrow();
    expect(finished[0].input).toMatchObject({
      status: "refused",
      refusalReason: "user_in_control",
    });
    expect(JSON.stringify(finished)).not.toContain("接管");
  });

  test("masks tokens in navigated URLs", async () => {
    const { store, begun, finished } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), { store: () => store });
    await withActivityScope({ toolCallId: "c4" }, () =>
      gateway.navigate("bot", actor, "https://x.dev/?token=abc", "c4"),
    );
    expect(begun[0].subject).not.toContain("abc");
    expect(String(finished[0].input.subject)).not.toContain("abc");
  });

  test("human typing never stores text and repeats merge into one row", async () => {
    const { store, begun, bumps } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), {
      store: () => store,
      now: () => 1000,
    });
    for (let i = 0; i < 3; i++) {
      await withActivityScope({ human: true, actorUserId: "u1" }, () =>
        gateway.humanInput("bot", {
          kind: "type",
          text: "secret words",
        } as never),
      );
    }
    expect(begun.length).toBe(1);
    expect(begun[0]).toMatchObject({ actorKind: "human", kind: "type" });
    expect(JSON.stringify(begun)).not.toContain("secret words");
    expect(bumps.at(-1)?.detail).toEqual({ count: 3 });
  });

  test("a read without a tool call (live preview polling) is not recorded", async () => {
    const { store, begun } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), { store: () => store });
    await gateway.screenshot("bot");
    expect(begun.length).toBe(0);
  });

  test("concurrent calls each keep the turn and tool call they were sent with", async () => {
    const { store, begun } = fakeStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = withComputerActivity(
      fakeGateway({
        runCommand: async (_b: unknown, _a: unknown, input: unknown) => {
          const command = (input as { command: string }).command;
          if (command === "slow") await gate;
          return {
            command,
            exitCode: 0,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
            elapsedMs: 1,
          };
        },
      }),
      { store: () => store },
    );
    // A 先开始、B 后开始，B 先结束 A 后结束：两次调用交错，各自的归属不能串。
    const a = withActivityScope(
      {
        threadId: "t1",
        runId: "turnA",
        toolCallId: "callA",
        actorUserId: "u1",
      },
      () => gateway.runCommand("bot", actor, { command: "slow" } as never),
    );
    const b = withActivityScope(
      {
        threadId: "t2",
        runId: "turnB",
        toolCallId: "callB",
        actorUserId: "u1",
      },
      () => gateway.runCommand("bot", actor, { command: "fast" } as never),
    );
    await b;
    release();
    await a;
    const bySubject = Object.fromEntries(
      begun.map((step) => [step.subject, step]),
    );
    expect(bySubject.slow).toMatchObject({
      threadId: "t1",
      runId: "turnA",
      toolCallId: "callA",
      actorKind: "agent",
    });
    expect(bySubject.fast).toMatchObject({
      threadId: "t2",
      runId: "turnB",
      toolCallId: "callB",
      actorKind: "agent",
    });
  });

  test("a turn without an explicit tool call id is left unattributed, not guessed", async () => {
    const { store, begun } = fakeStore();
    const gateway = withComputerActivity(fakeGateway(), { store: () => store });
    await withActivityScope(
      { threadId: "t", runId: "r", toolCallId: null, actorUserId: "u1" },
      () => gateway.runCommand("bot", actor, { command: "pwd" } as never),
    );
    expect(begun[0]).toMatchObject({ runId: null, toolCallId: null });
  });
});

/**
 * CB-103：用户接管着电脑时，机器人的截图被让路拒绝（CaptureBusy + userControl）。这一步记成
 * refused / user_in_control（界面显示「已拒绝：电脑当前由你控制」），而不是「失败：大屏正在直播」。
 */
describe("activity while the person holds the computer (CB-103)", () => {
  test("a screenshot refused by a takeover is refused/user_in_control", async () => {
    const { store, finished } = fakeStore();
    const gateway = withComputerActivity(
      fakeGateway({
        screenshot: async () => {
          throw new CaptureBusyError("Live screen is streaming.", true, true);
        },
      }),
      { store: () => store },
    );
    await expect(
      withActivityScope({ toolCallId: "c-shot" }, () =>
        gateway.screenshot("bot", actor as never),
      ),
    ).rejects.toThrow();
    expect(finished[0]?.input).toMatchObject({
      status: "refused",
      refusalReason: "user_in_control",
    });
    expect(
      statusText({
        actorKind: "agent",
        kind: "screenshot",
        status: finished[0].input.status,
        refusalReason: finished[0].input.refusalReason,
        subject: "",
      }),
    ).toBe("已拒绝：电脑当前由你控制");
  });

  test("a live cast without a takeover stays failed/live_cast", () => {
    expect(
      classifyError(new CaptureBusyError("Live screen is streaming.", true)),
    ).toMatchObject({ status: "failed", refusalReason: "live_cast" });
    expect(
      classifyError(new CaptureBusyError("busy", true, true)),
    ).toMatchObject({ status: "refused", refusalReason: "user_in_control" });
  });
});
