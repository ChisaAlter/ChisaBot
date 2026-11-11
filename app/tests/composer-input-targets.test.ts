import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resetBotsLocationMemory } from "@/lib/bots-location";
import {
  type ComposerInput,
  clearComposerInputs,
  composerTargetPath,
  dispatchComposerPrefill,
  dispatchComposerQuote,
  receiveComposerInputs,
  sendPromptToChat,
  transferComposerInputs,
} from "@/lib/chat/quote-event";

const cleanups: (() => void)[] = [];
beforeAll(() =>
  GlobalRegistrator.register({ url: "https://chat.example.test/channel/a" }),
);
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  clearComposerInputs();
  resetBotsLocationMemory();
});
afterAll(() => GlobalRegistrator.unregister());
function recipient(targetPath: string, active: () => boolean = () => true) {
  const received: ComposerInput[] = [];
  const receiver = receiveComposerInputs({
    targetPath,
    active,
    consume: (value) => received.push(value),
  });
  cleanups.push(receiver.dispose);
  return { received, flush: receiver.flush };
}
function navigate(path: string) {
  window.history.replaceState({}, "", path);
}

test("hidden retained composers cannot consume another channel's quote or prefill", () => {
  navigate("/channel/b");
  const hidden = recipient("/channel/a", () => false);
  const current = recipient("/channel/b");
  dispatchComposerQuote({ text: "引用 B", prompt: "解释这段" });
  dispatchComposerPrefill("继续 B");
  current.flush();
  hidden.flush();
  expect(hidden.received).toEqual([]);
  expect(current.received).toEqual([
    { kind: "quote", quote: { text: "引用 B", prompt: "解释这段" } },
    { kind: "prefill", text: "继续 B" },
  ]);
});

test("landing inputs follow the selected redirects rather than the next arbitrary chat", () => {
  navigate("/settings/memory");
  const destinations: unknown[] = [];
  sendPromptToChat((target) => {
    destinations.push(target);
  }, "带去聊天");
  expect(destinations).toEqual([{ to: "/" }]);
  navigate("/channel/unrelated");
  const unrelated = recipient("/channel/unrelated");
  expect(unrelated.received).toEqual([]);
  navigate("/");
  const newTarget = composerTargetPath(undefined, "new:bot-a");
  transferComposerInputs("/", newTarget);
  navigate(newTarget);
  transferComposerInputs(newTarget, "/channel/empty-a");
  navigate("/channel/empty-a");
  const selected = recipient("/channel/empty-a");
  selected.flush();
  expect(selected.received).toEqual([{ kind: "prefill", text: "带去聊天" }]);
  expect(unrelated.received).toEqual([]);
});

test("bare new-topic route transfers its quote exactly once to the selected Bot", () => {
  navigate("/channel/new");
  dispatchComposerQuote({ text: "无指定 Bot 的引文" });
  transferComposerInputs("/channel/new", "/channel/new?agent=bot-b");
  navigate("/channel/new?agent=bot-b");
  const selected = recipient(composerTargetPath(undefined, "new:bot-b"));
  selected.flush();
  expect(selected.received).toHaveLength(1);
  transferComposerInputs("/channel/new", "/channel/another");
  navigate("/channel/another");
  expect(recipient("/channel/another").received).toEqual([]);
});

test("account clear prevents a delayed navigation from restoring previous account input", () => {
  navigate("/settings");
  sendPromptToChat(() => {}, "上一账号的输入");
  clearComposerInputs();
  navigate("/");
  transferComposerInputs("/", "/channel/new?agent=new-owner");
  navigate("/channel/new?agent=new-owner");
  expect(
    recipient(composerTargetPath(undefined, "new:new-owner")).received,
  ).toEqual([]);
});
