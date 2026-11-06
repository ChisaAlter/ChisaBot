import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { HarkActionPill } from "@/components/chat/bot-bubbles";
import { settleReactWork } from "./settle-react-work";

/**
 * DESIGN.md §53：GitHub 连接卡在对话里就地连接——点了不跳设置页，原地弹设置里同一个令牌弹窗；
 * 令牌只发往服务器，不进对话。其它链接卡照常是站内链接。
 */
beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const wrap = (children: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

test("GitHub 链接卡渲染成按钮，点开就地出令牌弹窗", async () => {
  const view = render(
    wrap(
      <HarkActionPill
        href="/settings/connected-accounts/github"
        label="连接 GitHub"
      />,
    ),
  );
  const pill = view.getByTestId("hark-action-pill");
  expect(pill.tagName).toBe("BUTTON");
  fireEvent.click(pill);
  await waitFor(() => {
    expect(document.querySelector("#github-token")).toBeTruthy();
    expect(document.body.textContent).toContain("连接 GitHub");
  });
});

test("其它链接卡照常是站内链接", () => {
  const view = render(
    wrap(
      <HarkActionPill
        href="/settings/connected-accounts"
        label="打开账号连接"
      />,
    ),
  );
  const pill = view.getByTestId("hark-action-pill");
  expect(pill.tagName).toBe("A");
  expect(pill.getAttribute("href")).toBe("/settings/connected-accounts");
});
