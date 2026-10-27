import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ActiveBotProvider, bindAgentBot, botForAgent, useActiveBot, useActiveBotHolder, withRunBot } from "@/lib/copilot/active-bot";
import { settleReactWork } from "./settle-react-work";

/**
 * 工具调用打到「这次调用所属对话的机器人」（DESIGN.md §101）。
 * 2026-10-17 生产：Asuna 的对话里调用的 computer_navigate 打到了星灵的浏览器（holder 指着后挂载的那段对话）。
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a tool call routes to its own conversation's bot, not the one on screen", () => {
  let holder: { current: string } | null = null;
  function Chat({ bot }: { bot: string }) {
    useActiveBot(bot);
    holder = useActiveBotHolder();
    return null;
  }
  render(
    <ActiveBotProvider>
      <Chat bot="agent_xingling" />
    </ActiveBotProvider>,
  );
  expect(holder!.current).toBe("agent_xingling");

  const asunaAgent = {};
  bindAgentBot(asunaAgent, "agent_asuna");
  expect(botForAgent(asunaAgent)).toBe("agent_asuna");
  expect(botForAgent({})).toBeUndefined();
  expect(botForAgent(undefined)).toBeUndefined();

  // 处理函数同步读 holder.current：在 withRunBot 里读到的是这次调用的机器人，之后立刻还原
  const seen = withRunBot(holder!, botForAgent(asunaAgent), () => holder!.current);
  expect(seen).toBe("agent_asuna");
  expect(holder!.current).toBe("agent_xingling");

  // 不知道属于谁：照旧用 holder
  expect(withRunBot(holder!, undefined, () => holder!.current)).toBe("agent_xingling");
});
