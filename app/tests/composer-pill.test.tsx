import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Composer } from "@/components/channels/composer/composer";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "https://chisabot.test/" }));
// 「日常收起」是写进 localStorage 的全局偏好：不清掉会漏进同文件后面的用例，
// 也会接住同进程里先跑的文件留下的展开态。
beforeEach(() => {
  window.localStorage.removeItem("chisabot.composer-expanded");
});
afterEach(() => {
  window.localStorage.removeItem("chisabot.composer-expanded");
  cleanup();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("compact composer opens as a bar holding only +, the editor, a chevron and send", () => {
  const view = render(<Composer compact onSubmit={() => {}} />);
  const form = view.container.querySelector("form")!;
  expect(form.className).toContain("glass-composer-pill");
  expect(view.getByLabelText("更多消息选项不可用")).toBeTruthy();
  expect(view.getByRole("textbox", { name: "消息" })).toBeTruthy();
  expect(view.getByRole("button", { name: "展开输入框选项" })).toBeTruthy();
  expect(view.getByLabelText("发送消息")).toBeTruthy();
  // 展开态才有的控件此刻都不在。
  expect(
    view.queryByRole("button", { name: "助理快捷指令与随手问 (Alt+Space)" }),
  ).toBeNull();
  expect(view.queryByTestId("composer-spotlight-btn")).toBeNull();
});

test("the chevron swaps the bar for the full toolbar and back", () => {
  const view = render(<Composer compact onSubmit={() => {}} />);
  fireEvent.click(view.getByRole("button", { name: "展开输入框选项" }));
  expect(view.getByTestId("composer-spotlight-btn")).toBeTruthy();
  expect(view.getByRole("button", { name: "收起输入框选项" })).toBeTruthy();
  expect(view.container.querySelector("form")!.className).not.toContain(
    "glass-composer-pill",
  );
  fireEvent.click(view.getByRole("button", { name: "收起输入框选项" }));
  expect(view.queryByTestId("composer-spotlight-btn")).toBeNull();
  expect(view.getByRole("button", { name: "展开输入框选项" })).toBeTruthy();
});

test("the expanded choice is a global preference that survives a remount", () => {
  const first = render(<Composer compact onSubmit={() => {}} />);
  fireEvent.click(first.getByRole("button", { name: "展开输入框选项" }));
  cleanup();
  const second = render(<Composer compact onSubmit={() => {}} />);
  expect(second.getByTestId("composer-spotlight-btn")).toBeTruthy();
  expect(
    second.queryByRole("button", { name: "展开输入框选项" }),
  ).toBeNull();
});

test("sending still works straight from the bar", async () => {
  const sent: string[] = [];
  const view = render(
    <Composer
      compact
      initialValue="from the bar"
      onSubmit={(d) => {
        sent.push(d.text);
      }}
    />,
  );
  fireEvent.click(view.getByLabelText("发送消息"));
  expect(sent).toEqual(["from the bar"]);
});
