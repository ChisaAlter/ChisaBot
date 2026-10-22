import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, expect, test } from "bun:test";
import { stashDraftFiles, takeDraftFiles } from "@/lib/chat/ui-memory";
import { refreshWouldInterrupt, setBusy, setPendingAttachments } from "./activity";

// The full app tree preloads a DOM (app/tests/preload.ts); this subset may not, so register one here.
if (typeof document === "undefined") GlobalRegistrator.register();

afterEach(() => {
  document.body.innerHTML = "";
  setBusy("t", false);
  setPendingAttachments("t", 0);
  takeDraftFiles("stash:1");
});

test("refresh is safe on an idle page", () => {
  document.body.innerHTML = '<textarea></textarea><div contenteditable="true">  </div>';
  expect(refreshWouldInterrupt()).toBeNull();
});

test("a running reply holds the refresh", () => {
  setBusy("t", true);
  expect(refreshWouldInterrupt()).toEqual({ running: true, attachments: 0, unsent: false });
  setBusy("t", false);
  expect(refreshWouldInterrupt()).toBeNull();
});

test("attachments still on the composer hold the refresh", () => {
  // File 只在内存里（`stashDraftFiles`）：刷新就没了，所以挂着附件时先问一句。
  setPendingAttachments("t", 2);
  expect(refreshWouldInterrupt()).toEqual({ running: false, attachments: 2, unsent: false });
  setPendingAttachments("t", 0);
  expect(refreshWouldInterrupt()).toBeNull();

  // 负数和乱值不能把人永久锁在确认框前面。
  setPendingAttachments("t", -3);
  expect(refreshWouldInterrupt()).toBeNull();
  setPendingAttachments("t", Number.NaN);
  expect(refreshWouldInterrupt()).toBeNull();
});

test("everything that would be lost is reported together", () => {
  setBusy("t", true);
  setPendingAttachments("t", 1);
  document.body.innerHTML = '<textarea data-unsent-watch>改了一半的消息</textarea>';
  expect(refreshWouldInterrupt()).toEqual({ running: true, attachments: 1, unsent: true });
});

test("attachments stashed away from the composer hold it too", () => {
  // 离开对话时收进 `draftFiles` 的那几个也一样会丢：在别的页面点刷新也算数。
  stashDraftFiles("stash:1", [new File(["x"], "a.png"), new File(["y"], "b.pdf")]);
  expect(refreshWouldInterrupt()).toEqual({ running: false, attachments: 2, unsent: false });
  takeDraftFiles("stash:1");
  expect(refreshWouldInterrupt()).toBeNull();
});

test("only inputs marked data-unsent-watch hold the refresh", () => {
  // 卡片里的表单、面板里的文本框、搜索框都不是「没发出去的聊天草稿」。
  // 以前扫整个页面：机器人渲染一个带默认值的输入框，就会在用户明明没打字时弹「输入框里还有没发送的内容」。
  document.body.innerHTML =
    '<input type="text" value="卡片里预填的值"><textarea>面板里的字</textarea><div contenteditable="true">搜索</div>';
  expect(refreshWouldInterrupt()).toBeNull();

  document.body.innerHTML = '<textarea data-unsent-watch>改了一半的消息</textarea>';
  expect(refreshWouldInterrupt()).toEqual({ running: false, attachments: 0, unsent: true });

  // 空的和只剩空白的都不算。
  document.body.innerHTML =
    '<textarea data-unsent-watch></textarea><textarea data-unsent-watch>   </textarea>';
  expect(refreshWouldInterrupt()).toBeNull();

  // 关掉的弹窗 / 折叠面板留下的字，刷新本来也不会让人看见它丢了。
  document.body.innerHTML = '<textarea data-unsent-watch hidden>改了一半的消息</textarea>';
  expect(refreshWouldInterrupt()).toBeNull();

  document.body.innerHTML =
    '<div aria-hidden="true"><input type="text" data-unsent-watch value="藏起来的"></div>';
  expect(refreshWouldInterrupt()).toBeNull();
});
