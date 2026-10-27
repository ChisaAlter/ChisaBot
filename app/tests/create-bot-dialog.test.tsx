import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { settleReactWork } from "./settle-react-work";

/**
 * 新建机器人（DESIGN.md §46.2 / §81）：一步完成；和编辑同一张表——头像 · 名称 · 职责 · 它做什么，文字从空白开始、
 * 没有示例角色；没有「谁可以看到它」「它在哪里运行」；发出去的一律私有、不带端点；头像随后写到 /api/bot-avatars。
 */

/*
 * 先注册 happy-dom 再加载组件（DESIGN.md §81 起表单里多了头像窗）：Base UI 在模块加载时就判断有没有 document，
 * 静态 import 会早于 beforeAll，弹窗就画不出来。
 */
GlobalRegistrator.register();
const { CreateAgentDialog } = await import("@/components/agents/create-agent-dialog");
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let writes: { request: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method !== "GET") writes.push({ request: `${method} ${path}`, body });
      if (path === "/api/agents" && method === "POST") {
        return Response.json(
          {
            agent: {
              id: "new-bot",
              name: body.name,
              title: body.title,
              roleDescription: body.roleDescription,
              avatarSeed: "new-bot",
              visibility: "private",
              endpoint: null,
              builtIn: true,
              hasAuth: false,
              hasCallbackToken: false,
              hidden: false,
              pinned: false,
              systemOwned: false,
              canManage: true,
              mine: true,
            },
          },
          { status: 201 },
        );
      }
      if (String(path).startsWith("/api/bot-avatars/") && method === "PUT") {
        return Response.json({ avatar: body });
      }
      if (path === "/api/bot-avatars") return Response.json({ avatars: {} });
      return Response.json({ agents: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

function draw(screen: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 新建表单不用路由；RouterProvider 在 happy-dom 里首帧是空的（composing-enter 的老测试就卡在这）。
  return render(<QueryClientProvider client={queryClient}>{screen}</QueryClientProvider>);
}

test("one step: avatar, name, role, purpose — empty, no preset roles, no visibility or location choice", async () => {
  const view = draw(<CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />);
  const name = (await view.findByLabelText("名称")) as HTMLInputElement;
  const title = view.getByLabelText(/职责/) as HTMLInputElement;
  const prompt = view.getByLabelText(/它做什么/) as HTMLTextAreaElement;
  // 和编辑同一张表（DESIGN.md §81）：职责看得见，没有单独的「提示词」格。
  expect(view.queryByLabelText("提示词")).toBeNull();
  expect(view.getAllByRole("button", { name: "更换头像" })).toHaveLength(1);
  expect(name.value).toBe("");
  expect(title.value).toBe("");
  expect(prompt.value).toBe("");
  const text = document.body.textContent ?? "";
  for (const gone of ["财务", "报销", "发票", "第 1 步", "谁可以看到", "公开", "在哪里运行", "自托管", "内置", "端点"]) {
    expect(text.includes(gone)).toBe(false);
    for (const field of [name, title, prompt]) expect(field.placeholder.includes(gone)).toBe(false);
  }
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.getByRole("button", { name: /创建机器人/ })).toBeTruthy();
});

test("role follows the purpose until typed over; purpose is saved verbatim; default avatar is a monogram", async () => {
  const created: string[] = [];
  const view = draw(
    <CreateAgentDialog onClose={() => {}} onCreated={(id) => { created.push(id); }} open />,
  );
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("名称"), "测试");
  await user.type(view.getByLabelText(/它做什么/), "你是我自己写的提示词。");
  // 职责按第一句自动写出来，看得见。
  expect((view.getByLabelText(/职责/) as HTMLInputElement).value).toBe("我自己写的提示词");
  await act(async () => {
    await user.click(view.getByRole("button", { name: /创建机器人/ }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(writes.map((w) => w.request)).toEqual(["POST /api/agents", "PUT /api/bot-avatars/new-bot"]);
  expect(writes[0]?.body).toMatchObject({
    name: "测试",
    title: "我自己写的提示词",
    roleDescription: "你是我自己写的提示词。",
    visibility: "private",
    endpoint: "",
  });
  expect(writes[0]?.body.auth).toBeUndefined();
  expect(writes[1]?.body).toMatchObject({ kind: "monogram" });
  expect(created).toEqual(["new-bot"]);
});

test("a typed role wins over the suggestion; empty purpose saves the default sentence", async () => {
  const view = draw(<CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />);
  const user = userEvent.setup({ document });
  await user.type(await view.findByLabelText("名称"), "记账");
  await user.type(view.getByLabelText(/职责/), "管钱");
  await act(async () => {
    await user.click(view.getByRole("button", { name: /创建机器人/ }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(writes[0]?.body).toMatchObject({ name: "记账", title: "管钱" });
  expect(String(writes[0]?.body.roleDescription)).toContain("私人助手");
});

test("empty submit shows field errors and sends nothing", async () => {
  const view = draw(<CreateAgentDialog onClose={() => {}} onCreated={() => {}} open />);
  const user = userEvent.setup({ document });
  await view.findByLabelText("名称");
  await act(async () => {
    await user.click(view.getByRole("button", { name: /创建机器人/ }));
  });
  expect(writes).toEqual([]);
  expect(view.getByText("请填写名称。")).toBeTruthy();
});
