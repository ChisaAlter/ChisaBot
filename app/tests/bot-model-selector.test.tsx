import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import type { AgentModelState, ModelCatalog } from "../../shared/model-selection";

beforeAll(() => GlobalRegistrator.register({ url: "https://chisabot.test/" }));
afterEach(async () => { await act(async () => cleanup()); });
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let states: Record<string, AgentModelState>;
let catalog: ModelCatalog;
let saveError: boolean;
let catalogError: boolean;
let finishSave: (() => void) | undefined;
let holdSave: boolean;
let refreshed: boolean;

beforeEach(() => {
  states = Object.fromEntries(["bot-a", "bot-b"].map((agentId) => [agentId, {
    agentId, model: "vendor/first", overrideModel: "vendor/first", defaultModel: "vendor/first", available: true, canManage: true,
  }]));
  catalog = { fetchedAt: 10, models: [
    { id: "vendor/first", label: "First", provider: "Vendor" },
    { id: "other/second", label: "Second", provider: "Other" },
  ] };
  saveError = false;
  catalogError = false;
  holdSave = false;
  finishSave = undefined;
  refreshed = false;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/models")) {
      if (path.includes("refresh=1")) refreshed = true;
      return catalogError ? Response.json({ error: "目录暂时不可用" }, { status: 502 }) : Response.json(catalog);
    }
    const match = /^\/api\/agents\/([^/]+)\/model$/.exec(path);
    if (!match || !states[match[1]]) throw new Error(`Unexpected request: ${path}`);
    const id = match[1];
    if (init?.method === "PUT") {
      if (holdSave) await new Promise<void>((resolve) => { finishSave = resolve; });
      if (saveError) return Response.json({ error: "模型保存失败" }, { status: 500 });
      const { model } = JSON.parse(String(init.body));
      states[id] = { ...states[id], overrideModel: model, model: model ?? states[id].defaultModel, available: true };
    }
    return Response.json(states[id]);
  }, { preconnect: originalFetch.preconnect });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const client of clients.splice(0)) client.clear();
});

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}>
    <section data-testid="composer"><BotModelSelector agentId="bot-a" compact /></section>
    <section data-testid="settings"><BotModelSelector agentId="bot-a" /></section>
    <section data-testid="other-bot"><BotModelSelector agentId="bot-b" /></section>
  </QueryClientProvider>);
}

async function choose(view: ReturnType<typeof draw>, id = "other/second") {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const input = within(view.getByTestId("composer")).getByRole("combobox", { name: "模型选择" });
  await user.click(input);
  await user.type(await view.findByLabelText("搜索模型"), id);
  const item = await view.findByRole("option", { name: new RegExp(id) });
  await user.click(item);
}

/*
 * 输入框旁那颗药丸（`ModelPicker`）只放得下一个短名：目录里的 label，没有 label 时取 id 的最后
 * 一段。完整 id 在它的 title 上（悬停提示里也是它），所以两处一起断言 —— 只看短名分不出
 * 「Second」是 other/second 还是别的提供方下的同名模型。
 */
function pill(view: ReturnType<typeof draw>, section: "composer" | "settings" | "other-bot") {
  return within(view.getByTestId(section)).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement;
}

/** 刷新 Magpie 模型列表的按钮现在在药丸弹层的页脚里，弹层开着才有。 */
function refreshButton(view: ReturnType<typeof draw>) {
  return view.getByRole("button", { name: "刷新" });
}

test("composer and BOT settings save one value without changing another BOT", async () => {
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  await choose(view);
  await waitFor(() => {
    expect((within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).textContent).toContain("other/second");
  });
  expect(within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }).textContent).toContain("other/second");
  expect(pill(view, "composer").textContent).toContain("Second");
  expect(pill(view, "composer").title).toContain("other/second");
  expect(pill(view, "other-bot").textContent).toContain("First");
  expect(pill(view, "other-bot").title).toContain("vendor/first");
});

test("a pending model write disables both selectors until the server acknowledges", async () => {
  holdSave = true;
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  await choose(view);
  await waitFor(() => expect(finishSave).toBeDefined());
  expect((within(view.getByTestId("composer")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(view.getByTestId("other-bot")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => finishSave?.());
  await waitFor(() => expect((within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).disabled).toBe(false));
});

test("a rejected save keeps the last saved model in both controls", async () => {
  saveError = true;
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  await choose(view);
  /*
   * 没有乐观更新：保存失败时两个控件都回到服务端那一个模型。失败原因写在药丸弹层的页脚里，
   * 而选中后弹层就关了 —— 所以重新打开才看得到，也才证明这一次确实保存失败了。
   */
  await waitFor(() => expect(pill(view, "composer").disabled).toBe(false));
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(pill(view, "composer"));
  expect(await view.findByText("模型保存失败")).toBeTruthy();
  await waitFor(() => expect(pill(view, "composer").textContent).toContain("First"));
  expect(pill(view, "composer").title).toContain("vendor/first");
  expect(pill(view, "settings").textContent).toContain("vendor/first");
});

test("a missing model stays visible and never selects the first catalog entry", async () => {
  states["bot-a"] = { ...states["bot-a"], model: "gone/model", overrideModel: "gone/model", available: true };
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  // 药丸上是 id 的最后一段加「已失效」标签；完整 id 在 title 里，别让它被悄悄换掉。
  expect(pill(view, "composer").textContent).toContain("model");
  expect(pill(view, "composer").textContent).toContain("已失效");
  expect(pill(view, "composer").title).toContain("gone/model");
  expect(within(view.getByTestId("settings")).getByRole("alert").textContent).toContain("不可用");
  expect(within(view.getByTestId("settings")).getByRole("alert").textContent).toContain("gone/model");
  expect(states["bot-a"].model).toBe("gone/model");
});

test("refresh fetches new Magpie models and failed refresh keeps the selection", async () => {
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  catalog.models.push({ id: "new/third", label: "Third", provider: "New" });
  await user.click(pill(view, "composer"));
  await user.click(refreshButton(view));
  await waitFor(() => expect(refreshed).toBe(true));
  await user.keyboard("{Escape}");
  await choose(view, "new/third");
  await waitFor(() => expect(states["bot-a"].model).toBe("new/third"));
  catalogError = true;
  await user.click(pill(view, "composer"));
  await user.click(refreshButton(view));
  await view.findByText("目录暂时不可用");
  expect(pill(view, "settings").textContent).toContain("new/third");
});

test("an external tab change reloads the server value in both controls", async () => {
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  states["bot-a"] = { ...states["bot-a"], model: "other/second", overrideModel: "other/second" };
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: "chisabot-model-selection-changed", newValue: JSON.stringify({ agentId: "bot-a", at: 20 }) }));
  });
  await waitFor(() => expect(pill(view, "settings").textContent).toContain("other/second"));
  expect(pill(view, "composer").textContent).toContain("Second");
  expect(pill(view, "composer").title).toContain("other/second");
});

test("a remote BOT explains that its model is configured externally", async () => {
  states["bot-a"] = { ...states["bot-a"], available: false, canManage: false };
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  expect((within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(view.getByTestId("settings")).getByText("此外部 BOT 的模型由其服务管理。")).toBeTruthy();
  expect(within(view.getByTestId("settings")).queryByRole("alert")).toBeNull();
});

test("a successful inherited-model reset stays synchronized", async () => {
  states["bot-a"] = { ...states["bot-a"], model: "other/second", overrideModel: "other/second" };
  const view = draw();
  await view.findAllByRole("combobox", { name: "模型选择" });
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(within(view.getByTestId("composer")).getByRole("combobox", { name: "模型选择" }));
  await user.click(await view.findByRole("option", { name: /部署默认/ }));
  await waitFor(() => expect(states["bot-a"].overrideModel).toBeNull());
  expect(within(view.getByTestId("settings")).getByRole("combobox", { name: "模型选择" }).textContent).toContain("部署默认");
});
