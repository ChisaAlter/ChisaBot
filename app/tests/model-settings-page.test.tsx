import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import type { ModelSettingsCurrent } from "@/lib/model-settings/form";
import { Route as ModelsRoute } from "@/routes/_authed/admin/models";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let stored: ModelSettingsCurrent;
let writes: { path: string; body: Record<string, unknown> }[];
let connectionOK: boolean;
let loadError: boolean;
let saveError: boolean;

beforeEach(() => {
  stored = {
    provider: "openai",
    model: "original-model",
    baseUrl: "https://models.example.test/v1",
    useApiKey: true,
    hasApiKey: true,
    source: "environment",
  };
  writes = [];
  connectionOK = true;
  loadError = false;
  saveError = false;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/admin/model-settings" && method === "GET") {
        return loadError
          ? Response.json({ error: "当前无法读取模型设置。" }, { status: 500 })
          : Response.json({ config: stored });
      }
      /*
       * 同一页下面还有「备用模型」「生图模型」「识图模型」三块，各自发一次读请求。
       * 不答这几个请求的话，每一块都会渲染自己的 role="alert"，下面那些
       * 「页面上那一条报错」的断言就再也分不清报的是哪一条。
       */
      if (path === "/api/admin/model-fallbacks" && method === "GET") {
        return Response.json({ models: [] });
      }
      if (path === "/api/models") {
        return Response.json({ models: [], fetchedAt: 0 });
      }
      if (path === "/api/media-models/default" && method === "GET") {
        return Response.json({
          image: {
            enabled: false,
            provider: "minimax",
            baseUrl: "",
            model: "",
            editModel: "",
            keySource: "none",
            keyHint: "",
            ready: false,
            updatedAt: null,
          },
          vision: {
            mode: "follow",
            baseUrl: "",
            model: "",
            keySource: "none",
            keyHint: "",
            ready: false,
            updatedAt: null,
          },
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ path, body });
      if (path === "/api/admin/model-settings/test") {
        return Response.json({
          ok: connectionOK,
          message: connectionOK ? "模型连接成功。" : "模型接口拒绝了请求。",
          latencyMs: 125,
        });
      }
      if (path === "/api/admin/model-settings" && init?.method === "PUT") {
        if (saveError)
          return Response.json(
            { error: "模型设置保存失败，请重试。" },
            { status: 500 },
          );
        stored = {
          provider: body.provider as ModelSettingsCurrent["provider"],
          model: String(body.model),
          baseUrl: String(body.baseUrl),
          useApiKey: Boolean(body.useApiKey),
          hasApiKey: Boolean(body.useApiKey),
          source: "saved",
        };
        return Response.json({ config: stored });
      }
      throw new Error(`Unexpected model settings request: ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function draw() {
  const Models = ModelsRoute.options.component as ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <Models /> }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function fill(
  view: ReturnType<typeof draw>,
  label: string,
  value: string,
) {
  const field = await view.findByLabelText(label);
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.clear(field);
  await user.type(field, value);
}

/*
 * 「保存设置」的按钮在 DESIGN.md §2 的状态机里会把可读名字换成状态词（保存中… / 已保存 /
 * 保存失败），所以按名字找它时要认这一整族，而不是只认空闲时的那个词。锚定首尾是为了不要
 * 顺带选中下面生图 / 识图卡片上那几个只叫「保存」的按钮。
 */
const SAVE_BUTTON_NAME = /^(保存设置|保存中…|已保存|保存失败)$/;

function saveButton(view: ReturnType<typeof draw>) {
  return view.getByRole("button", { name: SAVE_BUTTON_NAME });
}

/*
 * 按钮在 pending 期间是禁用的（第一次保存失败后还有一段最短 pending 时间），这时点它不会提交表单。
 * 等它重新可点再点，「再存一次」才真的发了第二个请求 —— 而不是测试自己把第二次点击吞掉了。
 */
async function clickSave(view: ReturnType<typeof draw>) {
  const button = saveButton(view);
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(button);
}

test("saving a new model preserves the key by omitting a blank password field", async () => {
  const view = draw();
  await view.findByLabelText("模型名称");
  expect((view.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  await fill(view, "模型名称", "next-model");
  await clickSave(view);
  await view.findByText(/已保存，下一轮对话将使用/);
  expect(writes).toEqual([
    {
      path: "/api/admin/model-settings",
      body: {
        provider: "openai",
        model: "next-model",
        baseUrl: "https://models.example.test/v1",
        useApiKey: true,
      },
    },
  ]);
});

test("testing uses the unsaved form and editing clears its stale result", async () => {
  const view = draw();
  await fill(view, "模型名称", "draft-model");
  fireEvent.click(view.getByRole("button", { name: "测试连接" }));
  await view.findByText(/模型连接成功/);
  expect(writes[0]).toMatchObject({
    path: "/api/admin/model-settings/test",
    body: { model: "draft-model" },
  });
  expect(stored.model).toBe("original-model");
  await fill(view, "模型名称", "different-model");
  expect(view.queryByText(/模型连接成功/)).toBeNull();
});

test("switching interfaces requires a fresh key and clears it after a successful save", async () => {
  const view = draw();
  await fill(view, "接口地址（Base URL）", "https://other.example.test/v1");
  await clickSave(view);
  await view.findByText(/请为此接口填写 API Key/);
  expect(writes).toHaveLength(0);
  await fill(view, "API Key", "new-key");
  await clickSave(view);
  await view.findByText(/已保存，下一轮对话将使用/);
  expect(writes[0]?.body.apiKey).toBe("new-key");
  expect((view.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  expect(view.container.textContent).not.toContain("new-key");
});

test("an administrator can explicitly use a local model with no API key", async () => {
  const view = draw();
  await fill(view, "接口地址（Base URL）", "http://localhost:11434/v1");
  fireEvent.click(view.getByRole("checkbox", { name: "此接口需要 API Key" }));
  await clickSave(view);
  await view.findByText(/已保存，下一轮对话将使用/);
  expect(writes[0]?.body).toMatchObject({ useApiKey: false });
  expect(writes[0]?.body.apiKey).toBeUndefined();
});

test("connection failure remains a visible result instead of looking successful", async () => {
  connectionOK = false;
  const view = draw();
  await view.findByLabelText("模型名称");
  fireEvent.click(view.getByRole("button", { name: "测试连接" }));
  await view.findByRole("alert");
  expect(view.getByRole("alert").textContent).toContain("模型接口拒绝了请求。");
  expect(writes).toHaveLength(1);
});

test("failed settings reads show the reason and provide retry", async () => {
  loadError = true;
  const view = draw();
  expect((await view.findByRole("alert")).textContent).toContain(
    "当前无法读取模型设置",
  );
  loadError = false;
  fireEvent.click(view.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(view.queryByLabelText("模型名称")).not.toBeNull());
});

test("failed saves keep the draft available and allow a retry", async () => {
  saveError = true;
  const view = draw();
  await fill(view, "模型名称", "retry-model");
  await clickSave(view);
  expect((await view.findByRole("alert")).textContent).toContain(
    "模型设置保存失败",
  );
  expect((view.getByLabelText("模型名称") as HTMLInputElement).value).toBe(
    "retry-model",
  );
  saveError = false;
  await clickSave(view);
  await view.findByText(/已保存，下一轮对话将使用/);
  expect(stored.model).toBe("retry-model");
});
