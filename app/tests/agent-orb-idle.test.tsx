import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { settleReactWork } from "./settle-react-work";

/**
 * 卡顿修复（2026-10-30，4 倍降速实测）：头像球 idle 且没标 active 时停住，不跑旋转 / 漂移，
 * 只摆着一个球的页面（登录页、频道头）不再每帧重算样式。
 */
beforeAll(() =>
  GlobalRegistrator.register({
    url: "http://localhost/",
    width: 1280,
    height: 800,
  }),
);
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

test("an idle orb holds still; a busy or active one animates", async () => {
  const { default: AgentOrb } = await import(
    "@/components/agents/orb/agent-orb"
  );
  const orb = () => document.querySelector(".agent-orb");
  const r = render(<AgentOrb size="56px" />);
  expect(orb()?.getAttribute("data-ambient")).toBe("off");
  expect(orb()?.classList.contains("is-still")).toBe(true);
  r.rerender(<AgentOrb size="56px" state="thinking" />);
  expect(orb()?.getAttribute("data-ambient")).toBe("on");
  r.rerender(<AgentOrb active size="56px" />);
  expect(orb()?.classList.contains("is-still")).toBe(false);
});
