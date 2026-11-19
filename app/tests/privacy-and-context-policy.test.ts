import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { evaluateContextPolicyDraft } from "@/components/settings/context-policy-panel";
import { getHotkey, matchesHotkey } from "@/lib/hotkeys/hotkeys";
import {
  getPrivacyMask,
  PRIVACY_MASK_STORAGE_KEY,
  resetPrivacyMaskForTest,
  setPrivacyMask,
  syncPrivacyMaskFromStorage,
  togglePrivacyMask,
} from "@/lib/privacy-mask";
import { findEntry } from "@/lib/settings/registry";
import {
  formatTokenShorthand,
  parseTokenShorthand,
  validateContextPolicy,
} from "../../shared/context-policy";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings" });
});

afterEach(() => {
  window.localStorage.clear();
  resetPrivacyMaskForTest();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("一键隐私遮罩模式（data-private + Ctrl+Shift+P）", () => {
  test("开启/切换状态持久化到 localStorage 并写入 documentElement.dataset.privacyMask", () => {
    expect(getPrivacyMask()).toBe(false);
    expect(document.documentElement.dataset.privacyMask).toBeUndefined();

    setPrivacyMask(true);
    expect(getPrivacyMask()).toBe(true);
    expect(window.localStorage.getItem(PRIVACY_MASK_STORAGE_KEY)).toBe("1");
    expect(document.documentElement.dataset.privacyMask).toBe("1");

    const toggled = togglePrivacyMask();
    expect(toggled).toBe(false);
    expect(window.localStorage.getItem(PRIVACY_MASK_STORAGE_KEY)).toBe("0");
    expect(document.documentElement.dataset.privacyMask).toBeUndefined();
  });

  test("跨标签页 storage 事件同步隐私遮罩状态", () => {
    window.localStorage.setItem(PRIVACY_MASK_STORAGE_KEY, "1");
    syncPrivacyMaskFromStorage(PRIVACY_MASK_STORAGE_KEY);
    expect(getPrivacyMask()).toBe(true);
    expect(document.documentElement.dataset.privacyMask).toBe("1");

    window.localStorage.removeItem(PRIVACY_MASK_STORAGE_KEY);
    syncPrivacyMaskFromStorage(null);
    expect(getPrivacyMask()).toBe(false);
    expect(document.documentElement.dataset.privacyMask).toBeUndefined();
  });

  test("快捷键注册为 Ctrl/Cmd+Shift+P 且样式表包含非 :has 的 data-private 模糊规则", () => {
    const hotkey = getHotkey("privacy-mask");
    expect(hotkey.combo).toEqual({ key: "p", mod: true, shift: true });

    const event = new KeyboardEvent("keydown", {
      key: "P",
      code: "KeyP",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(matchesHotkey(event, hotkey.combo)).toBe(true);

    const css = readFileSync(
      path.join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    const maskStart = css.indexOf('[data-privacy-mask="1"] [data-private]');
    expect(maskStart).toBeGreaterThan(-1);
    const maskBlock = css.slice(maskStart);
    expect(maskBlock).not.toMatch(/blur\(/);
    expect(maskBlock).not.toContain(":has(");
  });
});

describe("模型上下文容量与摘要阈值前端解析与实时校验", () => {
  test("支持 1M / 400K / 128000 简写解析与表单实时校验", () => {
    expect(parseTokenShorthand("1M")).toBe(1_000_000);
    expect(parseTokenShorthand("400K")).toBe(400_000);
    expect(parseTokenShorthand("128000")).toBe(128_000);
    expect(formatTokenShorthand(1_000_000)).toBe("1M");
    expect(formatTokenShorthand(400_000)).toBe("400K");

    const okDraft = evaluateContextPolicyDraft({
      modelId: "claude-sonnet-4",
      contextWindowRaw: "1M",
      summaryThresholdRaw: "400K",
    });
    expect(okDraft.valid).toBe(true);
    expect(okDraft.error).toBeNull();
    expect(okDraft.contextWindowTokens).toBe(1_000_000);
    expect(okDraft.summaryThresholdTokens).toBe(400_000);

    const invalidThreshold = evaluateContextPolicyDraft({
      modelId: "claude-sonnet-4",
      contextWindowRaw: "128K",
      summaryThresholdRaw: "200K",
    });
    expect(invalidThreshold.valid).toBe(false);
    expect(invalidThreshold.error).toContain("严格小于");

    const invalidSyntax = evaluateContextPolicyDraft({
      modelId: "claude-sonnet-4",
      contextWindowRaw: "not-a-number",
      summaryThresholdRaw: "",
    });
    expect(invalidSyntax.valid).toBe(false);

    expect(
      validateContextPolicy({
        contextWindowTokens: 128_000,
        summaryThresholdTokens: 90_000,
      }).ok,
    ).toBe(true);
  });

  test("设置搜索注册表已登记新增的 4 个 Wave 3 锚点项", () => {
    expect(findEntry("general.privacy-mask")?.item?.find).toBe("隐私遮罩模式");
    expect(findEntry("models.context-policy")?.item?.find).toBe(
      "上下文容量与摘要阈值",
    );
    expect(findEntry("models.web-search")?.item?.find).toBe("联网搜索");
    expect(findEntry("schedules.webhooks")?.item?.find).toBe("入站 Webhook");
  });
});
