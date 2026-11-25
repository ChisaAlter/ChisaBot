import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ConfirmCardView,
  ConfirmResumeRow,
  isConfirmResume,
} from "@/components/chat/confirm-card";
import { settleReactWork } from "./settle-react-work";

/** 确认卡片（DESIGN.md §58）：等确认时有细节和按钮；决定后收成一行、按钮不可达；付款没有「以后直接做」。 */
describe("确认卡片", () => {
  beforeAll(() => GlobalRegistrator.register());
  afterEach(() => cleanup());
  afterAll(async () => {
    await settleReactWork();
    GlobalRegistrator.unregister();
  });

  test("等确认：标题、对象、细节、确认 / 取消、以后这类直接做", async () => {
    let approved = 0;
    const view = render(
      <ConfirmCardView
        model={{
          category: "message",
          title: "发邮件给张三",
          target: "zhangsan@example.com",
          details: [{ label: "主题", value: "周五开会" }],
          status: "pending",
        }}
        onAlways={async () => {}}
        onApprove={async () => {
          approved++;
        }}
        onDeny={async () => {}}
      />,
    );
    const card = view.getByTestId("confirm-card");
    expect(card.getAttribute("data-state")).toBe("pending");
    expect(card.textContent).toContain("需要你确认 · 对外发消息");
    expect(card.textContent).toContain("zhangsan@example.com");
    expect(card.textContent).toContain("周五开会");
    expect(view.getByTestId("confirm-always")).toBeTruthy();
    fireEvent.click(view.getByTestId("confirm-approve"));
    await new Promise((r) => setTimeout(r, 20));
    expect(approved).toBe(1);
  });

  test("决定后：收成一行，细节和按钮 inert", () => {
    const view = render(
      <ConfirmCardView
        model={{
          category: "delete",
          title: "删除 old.log",
          status: "approved",
          details: [{ label: "路径", value: "/x" }],
        }}
      />,
    );
    const card = view.getByTestId("confirm-card");
    expect(card.getAttribute("data-state")).toBe("approved");
    expect(card.textContent).toContain("已确认 · 删除");
    expect(card.querySelector(".cf-fold")?.hasAttribute("inert")).toBe(true);
    expect(card.querySelector(".cf-fold")?.hasAttribute("data-open")).toBe(
      false,
    );
  });

  test("付款：没有「以后这类直接做」，有锁的说明", () => {
    const view = render(
      <ConfirmCardView
        model={{
          category: "purchase",
          title: "下单 AirPods",
          status: "pending",
        }}
        onAlways={async () => {}}
      />,
    );
    expect(view.queryByTestId("confirm-always")).toBeNull();
    expect(view.getByTestId("confirm-card").textContent).toContain(
      "付款购买一律先问你",
    );
  });

  test("接着做的那条消息", () => {
    const text =
      "⟦chisabot:confirm:cf_1⟧\n用户确认了「删除测试文件 old.log」（云端）。";
    expect(isConfirmResume(text)).toBe(true);
    const view = render(<ConfirmResumeRow text={text} />);
    expect(view.getByTestId("confirm-resume-row").textContent).toContain(
      "你确认了「删除测试文件 old.log」",
    );
  });

  test("精确作用域放行与防连点互斥：展示次级按钮与范围提示，锁定类别不展示", async () => {
    let allowAlwaysCalls = 0;
    let approveCalls = 0;
    let denyCalls = 0;
    let resolveAlways!: () => void;
    const alwaysGate = new Promise<void>((resolve) => {
      resolveAlways = resolve;
    });

    const view = render(
      <ConfirmCardView
        alwaysLabel="始终允许此范围"
        model={{
          category: "device",
          title: "云端浏览器：click",
          target: "https://docs.github.com/en/rest",
          status: "pending",
        }}
        onAllowAlways={async () => {
          allowAlwaysCalls++;
          await alwaysGate;
        }}
        onApprove={async () => {
          approveCalls++;
        }}
        onDeny={async () => {
          denyCalls++;
        }}
        scopeHint="域名范围「docs.github.com」：记住后将覆盖该地址及所属主域（github.com 及子域范围）的同类操作"
      />,
    );

    expect(view.getByTestId("confirm-always").textContent).toBe(
      "始终允许此范围",
    );
    expect(view.getByTestId("confirm-scope-hint").textContent).toContain(
      "github.com",
    );

    const alwaysBtn = view.getByTestId("confirm-always") as HTMLButtonElement;
    const approveBtn = view.getByTestId("confirm-approve") as HTMLButtonElement;
    const denyBtn = view.getByTestId("confirm-deny") as HTMLButtonElement;

    fireEvent.click(alwaysBtn);
    fireEvent.click(alwaysBtn);
    fireEvent.click(approveBtn);
    fireEvent.click(denyBtn);
    expect(alwaysBtn.disabled).toBe(true);
    expect(approveBtn.disabled).toBe(true);
    expect(denyBtn.disabled).toBe(true);
    expect(allowAlwaysCalls).toBe(1);
    expect(approveCalls).toBe(0);
    expect(denyCalls).toBe(0);

    resolveAlways();
    await new Promise((r) => setTimeout(r, 20));
    cleanup();

    const busyView = render(
      <ConfirmCardView
        actionBusy
        alwaysLabel="始终允许此范围"
        model={{
          category: "device",
          title: "云端浏览器：click",
          status: "pending",
        }}
        onAllowAlways={async () => {
          allowAlwaysCalls++;
        }}
        onApprove={async () => {
          approveCalls++;
        }}
        onDeny={async () => {
          denyCalls++;
        }}
      />,
    );
    expect(
      (busyView.getByTestId("confirm-approve") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (busyView.getByTestId("confirm-deny") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (busyView.getByTestId("confirm-always") as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();

    const lockedView = render(
      <ConfirmCardView
        alwaysLabel="始终允许此范围"
        model={{ category: "admin", title: "添加连接器", status: "pending" }}
        onAllowAlways={async () => {}}
        scopeHint="不应显示"
      />,
    );
    expect(lockedView.queryByTestId("confirm-always")).toBeNull();
    expect(lockedView.queryByTestId("confirm-scope-hint")).toBeNull();
    expect(lockedView.getByTestId("confirm-card").textContent).toContain(
      "添加连接器一律先问你",
    );
  });
});
