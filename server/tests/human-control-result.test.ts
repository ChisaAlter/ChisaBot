import { expect, test } from "bun:test";
import { HumanHasControlError } from "../src/computer/client";
import {
  type suspendsOnHumanControl,
  takeHumanControlBlock,
} from "../src/computer/control-blocks";
import * as headless from "../src/computer/headless-tools";

// 2026-10-13 生产事故：聊天 / 面板刷新碰到「有人接管」不能挂起（挂起后没有东西接上这一轮）。
function toolsFor(initiator: Parameters<typeof suspendsOnHumanControl>[0]) {
  const gateway = {
    runCommand: async () => {
      throw new HumanHasControlError(
        "A person has control or has been asked to take control.",
      );
    },
  } as unknown as Parameters<
    typeof headless.createHeadlessComputerTools
  >[0]["gateway"];
  return headless.createHeadlessComputerTools({
    gateway,
    botId: "bot",
    actor: {
      id: "owner",
      userId: "owner",
      ...(initiator ? { initiator } : {}),
    },
  });
}
const run = (tools: headless.HeadlessTool[]) =>
  tools
    .find((t) => t.definition.name === "computer_run_command")!
    .execute(
      { command: "uptime" },
      { toolCallId: "c1", signal: new AbortController().signal },
    );

test("a conversation gets a Chinese result instead of a silent suspension", async () => {
  const result = (await run(toolsFor({ kind: "person" }))) as Record<
    string,
    unknown
  >;
  expect(result).toMatchObject({ ok: false, humanHasControl: true });
  expect(String(result.reason)).toContain("交还");
});

test("a live panel refresh is not suspended and leaves a note for the refresh service", async () => {
  const since = Date.now();
  const result = (await run(
    toolsFor({ kind: "routine", id: "lp_test" }),
  )) as Record<string, unknown>;
  expect(result).toMatchObject({ ok: false, humanHasControl: true });
  expect(takeHumanControlBlock("lp_test", since)).toBe(true);
  expect(takeHumanControlBlock("lp_test", since)).toBe(false);
});

test("a real workflow still waits for the hand-back", async () => {
  await expect(
    run(toolsFor({ kind: "routine", id: "routine-1" })),
  ).rejects.toMatchObject({
    name: "HeadlessToolSuspension",
  });
});
