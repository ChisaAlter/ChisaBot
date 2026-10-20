import { beforeEach, expect, test } from "bun:test";
import {
  beginFrontendTool,
  frontendToolProgressAt,
  frontendToolsRunning,
  noteFrontendToolActivity,
  resetFrontendToolActivity,
} from "../src/lib/copilot/frontend-tool-activity";

beforeEach(() => resetFrontendToolActivity());

test("a running frontend tool counts as progress, so a 600s command is not a hung turn", () => {
  const at = 1_000;
  const done = beginFrontendTool(at);
  expect(frontendToolsRunning()).toBe(1);
  // 命令跑了 5 分钟，聊天这头一个事件都没有；进展时刻是「现在」。
  expect(frontendToolProgressAt(at + 300_000)).toBe(at + 300_000);
  done();
  expect(frontendToolsRunning()).toBe(0);
});

test("when the tool finishes, progress freezes at the moment it ended", () => {
  const done = beginFrontendTool(1_000);
  done(2_000);
  // 结束后不再替它作证：静默从结束那一刻开始算。
  expect(frontendToolProgressAt(2_500)).toBe(2_000);
  expect(frontendToolProgressAt(999_999)).toBe(2_000);
});

test("two tools at once stay running until the last one ends", () => {
  const a = beginFrontendTool(10);
  const b = beginFrontendTool(20);
  expect(frontendToolsRunning()).toBe(2);
  a();
  expect(frontendToolsRunning()).toBe(1);
  a();
  expect(frontendToolsRunning()).toBe(1);
  b();
  expect(frontendToolsRunning()).toBe(0);
});

test("a tool that never returns stops vouching after the cap, so the watchdog can fire", () => {
  const started = 1_000;
  beginFrontendTool(started);
  const cap = started + 15 * 60_000;
  // 15 分钟之后就停在那一刻，静默重新累计；否则挂死的工具会让输入框永远转。
  expect(frontendToolProgressAt(cap + 200_000)).toBe(cap);
});

test("manual activity pings move the progress mark", () => {
  noteFrontendToolActivity(5_000);
  expect(frontendToolProgressAt(5_000)).toBe(5_000);
});
