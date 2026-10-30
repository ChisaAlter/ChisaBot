import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  AuthLoopCard,
  AuthLoopNotice,
} from "@/components/auth/auth-loop-notice";
import {
  goToLogin,
  LOGIN_REDIRECT_KEY,
  resetLoginRedirectForTests,
} from "@/lib/auth/login-redirect";
import { settleReactWork } from "./settle-react-work";

/** 刚从 /login 回来又被网关 401：页面上出现「登录状态异常」和「退出重新登录」，而不是再跳一次。 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/channel/abc" });
});

afterEach(() => {
  cleanup();
  resetLoginRedirectForTests();
  window.sessionStorage.clear();
});

afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("没有循环时什么都不显示", () => {
  render(<AuthLoopNotice />);
  expect(document.body.querySelector("[data-auth-loop]")).toBeNull();
});

test("刚从 /login 回来又被 401：不跳，显示「登录状态异常」和「退出重新登录」", async () => {
  const replaced: string[] = [];
  const win = {
    location: {
      pathname: "/channel/abc",
      search: "",
      hash: "",
      replace: (to: string) => replaced.push(to),
    },
    sessionStorage: window.sessionStorage,
  } as unknown as Window;
  window.sessionStorage.setItem(LOGIN_REDIRECT_KEY, String(Date.now() - 2_000));
  render(<AuthLoopNotice />);
  await act(async () => {
    goToLogin(win);
  });
  expect(replaced).toEqual([]);
  const dialog = document.body.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("登录状态异常");
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent === "退出重新登录",
  );
  expect(button).toBeDefined();
  expect(document.activeElement).toBe(button as Element);
});

test("点「退出重新登录」调用退出流程，按钮变成进行中", async () => {
  let calls = 0;
  render(
    <AuthLoopCard
      onSignOut={() => {
        calls++;
        return new Promise<void>(() => {});
      }}
    />,
  );
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent === "退出重新登录",
  ) as HTMLButtonElement;
  await act(async () => {
    fireEvent.click(button);
  });
  expect(calls).toBe(1);
  expect(button.textContent).toBe("正在退出…");
});
