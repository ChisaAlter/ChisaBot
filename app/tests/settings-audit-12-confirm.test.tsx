import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  ConfirmHost,
  confirmDialog,
  isConfirmOpen,
  returnFocusTarget,
} from "@/components/ui/confirm";
import { MIN_LATIN_FOR_PLAIN_SLUG, slugFromTitle } from "@/lib/skill-slug";

/** 审查模块 12 复审：确认框 Esc 不再往下传、取消后焦点回输入框、中文夹字母的技能名、保存栏页都接未保存拦截。 */
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3710/settings" });
});
afterEach(() => cleanup());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("确认框里的 Esc 在捕获阶段被吃掉，document 上的监听收不到，关掉后马上就不算开着", async () => {
  const view = render(<ConfirmHost />);
  let documentSaw = 0;
  const onDoc = (event: KeyboardEvent) => {
    if (event.key === "Escape") documentSaw += 1;
  };
  document.addEventListener("keydown", onDoc);
  try {
    const answer = confirmDialog({ title: "放弃这次的改动？" });
    await waitFor(() =>
      expect(view.getByText("放弃这次的改动？")).toBeTruthy(),
    );
    expect(isConfirmOpen()).toBe(true);
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(await answer).toBe(false);
    expect(documentSaw).toBe(0);
    // 不再有「关掉后 150ms 内也算开着」。
    expect(isConfirmOpen()).toBe(false);
    // 关掉以后的 Esc 照常往下传给别的弹窗。
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(documentSaw).toBe(1);
  } finally {
    document.removeEventListener("keydown", onDoc);
  }
});

test("点确认框里的按钮不冒泡到 document（下面弹窗的「点外面」收不到）", async () => {
  const view = render(<ConfirmHost />);
  let documentClicks = 0;
  const onDoc = () => {
    documentClicks += 1;
  };
  document.addEventListener("click", onDoc);
  document.addEventListener("pointerdown", onDoc);
  try {
    const answer = confirmDialog({ title: "确定离开？" });
    await waitFor(() => expect(view.getByText("确定离开？")).toBeTruthy());
    await act(async () => {
      const cancel = view.getByRole("button", { name: "取消" });
      fireEvent.pointerDown(cancel);
      fireEvent.click(cancel);
    });
    expect(await answer).toBe(false);
    expect(documentClicks).toBe(0);
  } finally {
    document.removeEventListener("click", onDoc);
    document.removeEventListener("pointerdown", onDoc);
  }
});

test("取消后焦点回到打开确认框前的输入框", async () => {
  const input = document.createElement("input");
  document.body.append(input);
  try {
    input.focus();
    const view = render(<ConfirmHost />);
    const answer = confirmDialog({ title: "有未保存的更改，确定离开？" });
    await waitFor(() =>
      expect(view.getByText("有未保存的更改，确定离开？")).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "取消" }));
    });
    expect(await answer).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(input));
  } finally {
    input.remove();
  }
});

test("焦点目标：不在页面上或被禁用时交回默认行为", () => {
  const input = document.createElement("input");
  expect(returnFocusTarget({ returnFocus: input })).toBeNull();
  document.body.append(input);
  expect(returnFocusTarget({ returnFocus: input })).toBe(input);
  input.disabled = true;
  expect(returnFocusTarget({ returnFocus: input })).toBeNull();
  expect(returnFocusTarget(null)).toBeNull();
  input.remove();
});

test("中文夹少量字母的标题（周报v2）也加 hash 后缀，不再只剩 v2", () => {
  const slug = slugFromTitle("周报v2");
  expect(slug).toMatch(/^v2-[a-z0-9]{6}$/);
  expect(slugFromTitle("周报v2")).toBe(slug);
  expect(slugFromTitle("月报v2")).not.toBe(slug);
  expect(slugFromTitle("AI 助手")).toMatch(/^ai-[a-z0-9]{6}$/);
  expect(MIN_LATIN_FOR_PLAIN_SLUG).toBe(4);
  // 4 个及以上拉丁字母照旧直接用。
  expect(slugFromTitle("周报 Weekly")).toBe("weekly");
  expect(slugFromTitle("Weekly Report")).toBe("weekly-report");
});

test("技能撞名时服务端回的是中文错误", () => {
  const source = readFileSync(
    new URL("../../server/src/skills-chisa/tools.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain("这个名字已经被");
  expect(source).toContain("占用，换个名字。");
  expect(source).toContain("你已经有一个叫「");
  expect(source).toContain("」的技能了。");
});

test("带保存栏的设置页都接了 useUnsavedGuard", () => {
  const files = [
    "../src/components/settings/standing-instructions.tsx",
    "../src/components/devices/devices.tsx",
    "../src/components/local-agents/device-agents-panel.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).toContain("<SaveBar");
    expect(source).toMatch(/useUnsavedGuard\(/);
  }
});
