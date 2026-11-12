import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmHost } from "@/components/ui/confirm";
import type { ScheduleView } from "../../shared/schedules";
import { settleReactWork } from "./settle-react-work";

/** CB-106 §2：编辑定时任务（名字、时间、内容）走 PATCH，只发改了的字段；时区显示出来。 */
const calls: { id: string; body: unknown }[] = [];
const { editFormOf, editPatchOf, scheduleZone, switchRepeat } = await import(
  "@/lib/schedule-edit"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const base = {
  id: "sch_x",
  title: "晨报",
  instruction: "生成今日晨报",
  kind: "cron",
  cron: "40 0 * * *",
  runAt: null,
  timezone: "Asia/Shanghai",
  status: "active",
} as unknown as ScheduleView;

describe("edit form", () => {
  test("fills from cron / weekdays / once / other", () => {
    expect(editFormOf(base)).toMatchObject({ repeat: "daily", at: "00:40" });
    expect(editFormOf({ ...base, cron: "30 8 * * 1-5" })).toMatchObject({
      repeat: "weekdays",
      at: "08:30",
    });
    expect(
      editFormOf({
        ...base,
        kind: "once",
        cron: null,
        runAt: "2026-10-28T01:05:00Z",
      }),
    ).toMatchObject({ repeat: "once", at: "2026-10-28T09:05" });
    expect(editFormOf({ ...base, cron: "0 */3 * * *" })).toMatchObject({
      repeat: "cron",
      cron: "0 */3 * * *",
    });
  });
  test("patch carries only changed fields; time untouched sends no when", () => {
    const o = editFormOf(base);
    expect(editPatchOf(o, { ...o, title: " 新晨报 " })).toEqual({
      patch: { title: "新晨报" },
    });
    expect(editPatchOf(o, { ...o, at: "07:15" })).toEqual({
      patch: { when: { repeat: "daily", at: "07:15" } },
    });
    expect(
      editPatchOf(o, switchRepeat(o, "once", new Date("2026-10-27T02:00:00Z"))),
    ).toEqual({
      patch: { when: { repeat: "once", at: "2026-10-27 00:40" } },
    });
    expect(editPatchOf(o, { ...o, repeat: "cron", cron: "0 9 * * 6" })).toEqual(
      {
        patch: { when: { repeat: "cron", cron: "0 9 * * 6" } },
      },
    );
    expect(editPatchOf(o, o)).toEqual({ patch: {} });
    expect(editPatchOf(o, { ...o, title: "  " })).toEqual({
      error: "名字不能为空",
    });
    expect(editPatchOf(o, { ...o, repeat: "cron", cron: "" })).toEqual({
      error: "请填写 cron 表达式",
    });
  });
  test("zone label", () => {
    expect(scheduleZone(base)).toBe("北京时间");
  });
});

describe("ScheduleEditDialog", () => {
  test("edit title + time + content and save via PATCH", async () => {
    const { ScheduleEditDialog } = await import(
      "@/components/schedules/edit-dialog"
    );
    let open = true;
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ScheduleEditDialog
          onOpenChange={(v) => {
            open = v;
          }}
          save={async (id, body) => {
            calls.push({ id, body });
            return base;
          }}
          schedule={base}
        />
      </QueryClientProvider>,
    );
    const title = (await view.findByTestId(
      "sch-edit-title",
    )) as HTMLInputElement;
    expect(title.value).toBe("晨报");
    expect(view.baseElement.textContent).toContain("时间（北京时间）");
    // Base UI 的输入框读按键，不读派发的 change 事件，所以用 user-event 打字。
    const user = userEvent.setup({ document: globalThis.document });
    await user.clear(title);
    await user.type(title, "早报");
    const at = view.getByTestId("sch-edit-at");
    await user.clear(at);
    await user.type(at, "07:00");
    const content = view.getByTestId("sch-edit-instruction");
    await user.clear(content);
    await user.type(content, "生成早报");
    await user.click(view.getByTestId("sch-edit-save"));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual({
      id: "sch_x",
      body: {
        title: "早报",
        instruction: "生成早报",
        when: { repeat: "daily", at: "07:00" },
      },
    });
    await waitFor(() => expect(open).toBe(false));
  });

  test("pending save locks draft and dismissal; same-task refresh keeps the draft", async () => {
    const { ScheduleEditDialog } = await import(
      "@/components/schedules/edit-dialog"
    );
    let finish!: (value: ScheduleView) => void;
    const saved = new Promise<ScheduleView>((resolve) => {
      finish = resolve;
    });
    const requests: unknown[] = [];
    const closes: boolean[] = [];
    const client = new QueryClient();
    const draw = (schedule: ScheduleView) => (
      <QueryClientProvider client={client}>
        <ScheduleEditDialog
          schedule={schedule}
          onOpenChange={(open) => closes.push(open)}
          save={async (_id, patch) => {
            requests.push(patch);
            return saved;
          }}
        />
        <ConfirmHost />
      </QueryClientProvider>
    );
    const view = render(draw(base));
    const user = userEvent.setup({ document: globalThis.document });
    const title = view.getByTestId("sch-edit-title") as HTMLInputElement;
    await user.clear(title);
    await user.type(title, "我的草稿");
    view.rerender(draw({ ...base, title: "刷新得到的原名称" }));
    expect(title.value).toBe("我的草稿");
    await user.click(view.getByTestId("sch-edit-save"));
    await waitFor(() => expect(requests).toEqual([{ title: "我的草稿" }]));
    expect(title.disabled).toBe(true);
    expect((view.getByTestId("sch-edit-at") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (view.getByTestId("sch-edit-instruction") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      (view.getByRole("button", { name: "取消" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(view.queryByRole("button", { name: "关闭" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(closes).toEqual([]);
    await act(async () => {
      finish(base);
      await saved;
    });
    await waitFor(() => expect(closes).toEqual([false]));
    client.clear();
  });

  test.each(["success", "failure"] as const)(
    "late %s from task A cannot close or change task B",
    async (outcome) => {
      const { ScheduleEditDialog } = await import(
        "@/components/schedules/edit-dialog"
      );
      let finish!: (value: ScheduleView) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<ScheduleView>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let started = false;
      const closes: boolean[] = [];
      const client = new QueryClient();
      const draw = (schedule: ScheduleView) => (
        <QueryClientProvider client={client}>
          <ScheduleEditDialog
            schedule={schedule}
            onOpenChange={(open) => closes.push(open)}
            save={async () => {
              started = true;
              return pending;
            }}
          />
        </QueryClientProvider>
      );
      const view = render(draw(base));
      const user = userEvent.setup({ document: globalThis.document });
      await user.type(view.getByTestId("sch-edit-title"), " A");
      await user.click(view.getByTestId("sch-edit-save"));
      await waitFor(() => expect(started).toBe(true));
      view.rerender(draw({ ...base, id: "sch_b", title: "晚报" }));
      const nextTitle = view.getByTestId("sch-edit-title") as HTMLInputElement;
      await user.type(nextTitle, " B 草稿");
      await act(async () => {
        if (outcome === "success") finish(base);
        else fail(new Error("A 保存失败"));
        try {
          await pending;
        } catch {
          /* production callback owns the error */
        }
      });
      expect(nextTitle.value).toBe("晚报 B 草稿");
      expect(nextTitle.disabled).toBe(false);
      expect(closes).toEqual([]);
      expect(view.queryByRole("alert")).toBeNull();
      client.clear();
    },
  );

  test("failed save keeps the edited draft and exposes retry without closing", async () => {
    const { ScheduleEditDialog } = await import(
      "@/components/schedules/edit-dialog"
    );
    let attempt = 0;
    const closes: boolean[] = [];
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <ScheduleEditDialog
          schedule={base}
          onOpenChange={(open) => closes.push(open)}
          save={async () => {
            if (++attempt === 1) throw new Error("服务暂时不可用");
            return base;
          }}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup({ document: globalThis.document });
    const title = view.getByTestId("sch-edit-title") as HTMLInputElement;
    await user.type(title, "草稿");
    await user.click(view.getByTestId("sch-edit-save"));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("服务暂时不可用"),
    );
    await waitFor(() => expect(title.disabled).toBe(false));
    expect(title.value).toBe("晨报草稿");
    expect(closes).toEqual([]);
    await user.click(view.getByTestId("sch-edit-save"));
    await waitFor(() => expect(closes).toEqual([false]));
    expect(attempt).toBe(2);
    client.clear();
  });
});
