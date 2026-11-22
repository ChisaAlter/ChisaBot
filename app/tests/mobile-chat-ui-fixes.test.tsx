import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { EditAction, WithdrawAction } from "@/components/chat/message-actions";
import { MessageActionsContext } from "@/lib/conversations/regenerate";
import { settleReactWork } from "./settle-react-work";

const readSrc = (rel: string) =>
  readFileSync(path.join(import.meta.dir, "../src", rel), "utf8");

const css = readSrc("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
const composerTsx = readSrc("components/channels/composer/composer.tsx");
const sectionRailTsx = readSrc("components/layout/section-rail.tsx");
const accountMenuTsx = readSrc("components/layout/account-menu.tsx");

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("问题 1：AI 回复中 data-held 动作按钮使用 display:none 收起且保留 26px 动作行高，不穿透孤立撤回图标或拉远引用", () => {
  expect(css).toMatch(
    /\.chat-msg-actions\s*\{[^}]*align-items:\s*center;[^}]*min-height:\s*26px;/,
  );
  expect(css).toMatch(
    /\.chat-msg-action\[data-held\]\s*\{\s*display:\s*none;\s*\}/,
  );
  expect(css).not.toMatch(
    /\.chat-msg-action\[data-held\]\s*\{\s*visibility:\s*hidden;\s*\}/,
  );

  const view = render(
    <MessageActionsContext.Provider
      value={{
        canAct: false,
        regenerate: async () => {},
        edit: async () => {},
        withdraw: async () => {},
      }}
    >
      <div className="chat-msg-actions" data-align="end">
        <EditAction onEdit={() => {}} />
        <WithdrawAction messageId="msg-user-1" />
      </div>
    </MessageActionsContext.Provider>,
  );

  const editBtn = view.getByLabelText("编辑这条消息") as HTMLButtonElement;
  const withdrawBtn = view.getByLabelText("撤回") as HTMLButtonElement;
  expect(editBtn.getAttribute("data-held")).toBe("true");
  expect(withdrawBtn.getAttribute("data-held")).toBe("true");
  expect(editBtn.disabled).toBe(true);
  expect(withdrawBtn.disabled).toBe(true);
});

test("问题 2：手机窄屏输入框工具栏允许整齐换行且模型药丸不收缩溢出重叠", () => {
  expect(composerTsx).toContain("glass-composer-toolbar-start");
  expect(composerTsx).toContain("glass-composer-toolbar-end");
  expect(composerTsx).toContain("busy-send-pill");

  expect(css).toMatch(
    /\.model-pill\s*\{[^}]*flex-shrink:\s*0;[^}]*overflow:\s*hidden;/,
  );
  expect(css).toMatch(
    /@container \(max-width:\s*480px\)\s*\{[\s\S]*?\.glass-composer-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/,
  );
  expect(css).toMatch(
    /@container \(max-width:\s*480px\)\s*\{[\s\S]*?\.glass-composer-toolbar-end\s*\{[^}]*margin-left:\s*auto;/,
  );
  expect(css).toMatch(
    /html\[data-phone\] \.glass-composer:not\(\.glass-composer-pill\)\s*\{[^}]*padding:\s*10px 10px 8px;/,
  );
});

test("问题 3：手机端开启触控路由预加载、轻量无位移切页与合成层优化", () => {
  expect(sectionRailTsx).toContain("useRouter");
  expect(sectionRailTsx).toMatch(/onPointerDown=\{\(\) => void router\.preloadRoute/);
  expect(accountMenuTsx).toContain('router.preloadRoute({ to: "/approvals" })');
  expect(accountMenuTsx).toContain(
    'router.preloadRoute({ to: "/settings/schedules" })',
  );

  expect(css).toMatch(
    /html\[data-phone\] :is\(a, button, \[role="button"\], \[role="menuitem"\], \[role="tab"\]\)\s*\{\s*touch-action:\s*manipulation;\s*\}/,
  );
  expect(css).toMatch(
    /@keyframes page-in-phone\s*\{\s*from\s*\{\s*opacity:\s*0;\s*\}\s*to\s*\{\s*opacity:\s*1;\s*\}\s*\}/,
  );
  expect(css).toMatch(
    /html\[data-phone\] \.page,\s*html\[data-phone\] \.magpie-console\s*\{\s*animation:\s*page-in-phone 140ms var\(--ease-out\);\s*\}/,
  );
  expect(css).toMatch(
    /html\[data-phone\] \.kept-chat\[data-switching="true"\]\s*\{[^}]*opacity:\s*1;[^}]*transition:\s*none;/,
  );
  expect(css).toMatch(
    /\[data-slot="sidebar"\]\.hk-drawer\s*\{[^}]*will-change:\s*transform;/,
  );
});
