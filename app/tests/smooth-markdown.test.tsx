import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import { settleReactWork } from "./settle-react-work";

if (typeof document === "undefined") GlobalRegistrator.register();

afterEach(() => cleanup());

// 2026-10-20 清基线：注册过就要收回来，否则后面的文件会撞「already been globally registered」。
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

function Probe({ text }: { text: string }) {
  return <p data-testid="out">{useSmoothText(text)}</p>;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("text that is already there when the message mounts (history) shows whole, no replay", () => {
  const view = render(<Probe text="历史消息的完整内容。" />);
  expect(view.getByTestId("out").textContent).toBe("历史消息的完整内容。");
});

test("text that grows after mount is revealed gradually, then completely", async () => {
  const view = render(<Probe text="" />);
  const full = "这是一段流式到达的回答，".repeat(6);
  await act(async () => {
    view.rerender(<Probe text={full} />);
  });
  // 同一帧里不会整段蹦出来。
  expect((view.getByTestId("out").textContent ?? "").length).toBeLessThan(full.length);
  await act(async () => {
    await wait(700);
  });
  expect(view.getByTestId("out").textContent).toBe(full);
});

test("reduced motion shows new text immediately", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  try {
    const view = render(<Probe text="" />);
    await act(async () => {
      view.rerender(<Probe text="立刻显示的文字" />);
    });
    expect(view.getByTestId("out").textContent).toBe("立刻显示的文字");
  } finally {
    window.matchMedia = original;
  }
});
