import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createHudLogicController,
  formatHudCapsuleText,
} from "../src/content/hud-logic";

describe("页内 HUD 浮层、人机礼让与截前隐身逻辑", () => {
  test("CDP 合成输入窗口内不误触发真人礼让，窗口外 isTrusted 输入触发礼让", () => {
    let clock = 10_000;
    const hud = createHudLogicController({ now: () => clock });

    hud.update({
      state: "controlling",
      botName: "鲸鱼娘",
      stepLabel: "正在查看 CPU 图表",
    });

    // 非合成窗口内的真人原生点击 -> 立即触发礼让
    expect(
      hud.shouldYieldOnInput({ isTrusted: true, fromHudHost: false }),
    ).toBe(true);

    // 合成窗口内（CDP 注入鼠标/键盘期间）-> 抑制礼让
    hud.markSyntheticWindow(500);
    expect(hud.isInSyntheticWindow()).toBe(true);
    expect(
      hud.shouldYieldOnInput({ isTrusted: true, fromHudHost: false }),
    ).toBe(false);

    // 合成窗口过期后恢复真人礼让检测
    clock += 600;
    expect(hud.isInSyntheticWindow()).toBe(false);
    expect(
      hud.shouldYieldOnInput({ isTrusted: true, fromHudHost: false }),
    ).toBe(true);

    // 非原生事件（页面脚本 dispatchEvent）与 HUD 自身按钮点击绝不误触发礼让
    expect(
      hud.shouldYieldOnInput({ isTrusted: false, fromHudHost: false }),
    ).toBe(false);
    expect(hud.shouldYieldOnInput({ isTrusted: true, fromHudHost: true })).toBe(
      false,
    );
  });

  test("截屏隐身支持嵌套引用计数，恢复后显示正常", () => {
    const hud = createHudLogicController();
    hud.update({
      state: "controlling",
      botName: "鲸鱼娘",
      stepLabel: "准备截图",
    });

    expect(hud.getModel().hiddenForCapture).toBe(false);
    hud.hideForCapture();
    expect(hud.getModel().hiddenForCapture).toBe(true);
    hud.hideForCapture();
    hud.restoreAfterCapture();
    expect(hud.getModel().hiddenForCapture).toBe(true);
    hud.restoreAfterCapture();
    expect(hud.getModel().hiddenForCapture).toBe(false);
  });

  test("胶囊文案根据运行态 / 礼让暂停态 / 等待确认态正确格式化", () => {
    const hud = createHudLogicController();
    const controlling = formatHudCapsuleText(
      hud.update({
        state: "controlling",
        botName: "鲸鱼娘",
        stepLabel: "继续向下查看内存与流量图表",
      }),
    );
    expect(controlling.title).toBe("鲸鱼娘");
    expect(controlling.subtitle).toContain("内存与流量图表");
    expect(controlling.showResumeButton).toBe(false);

    const yielded = formatHudCapsuleText(
      hud.update({
        state: "yielded_to_human",
        botName: "鲸鱼娘",
      }),
    );
    expect(yielded.title).toBe("已暂停 · 点击继续交给 鲸鱼娘");
    expect(yielded.showResumeButton).toBe(true);

    const removed = hud.remove();
    expect(removed.visible).toBe(false);
    expect(removed.state).toBe("detached");
  });

  test("content/hud.ts 源码严格使用 Closed Shadow DOM 与非阻塞蓝光边框", () => {
    const source = readFileSync(
      path.join(import.meta.dir, "../src/content/hud.ts"),
      "utf8",
    );
    expect(source).toContain('attachShadow({ mode: "closed" })');
    expect(source).toContain("pointer-events: none");
    expect(source).toContain("HUD_HIDE_FOR_CAPTURE");
    expect(source).toContain("HUD_RESTORE_AFTER_CAPTURE");
    expect(source).toContain("HUD_USER_ABORT");
    expect(source).toContain("HUD_USER_RESUME");
  });
});
