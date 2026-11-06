import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FallbackModelsCard } from "@/components/settings/fallback-models";
import { HistorySummaryModelCard } from "@/components/settings/history-summary-model";
import { modelSelectionKeys } from "@/lib/model-selection/queries";
import { runtimeKernelKeys } from "@/lib/runtime-kernel";
import { settleReactWork } from "./settle-react-work";

const originalFetch = globalThis.fetch;
const fallbackKey = ["admin", "model-fallbacks"] as const;
const summaryKey = ["admin", "history-summary-model"] as const;
const clients: QueryClient[] = [];

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  globalThis.fetch = originalFetch;
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function draw(kind: "fallback" | "summary") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(fallbackKey, { models: ["a", "b", "c"] });
  client.setQueryData(summaryKey, { model: "a" });
  client.setQueryData(modelSelectionKeys.catalog, {
    models: ["a", "b", "c"].map((id) => ({ id, label: id })),
    fetchedAt: Date.now(),
  });
  client.setQueryData(runtimeKernelKeys.status, {
    kernel: "builtin",
    hermes: null,
  });
  const view = render(
    <QueryClientProvider client={client}>
      {kind === "fallback" ? (
        <FallbackModelsCard mainModel="main" />
      ) : (
        <HistorySummaryModelCard />
      )}
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function pendingSave(path: string) {
  const writes: unknown[] = [];
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) !== path || init?.method !== "PUT")
        throw new Error(`Unexpected request: ${String(input)}`);
      writes.push(JSON.parse(String(init.body)));
      return pending;
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    writes,
    finish: (body: unknown) =>
      act(async () => {
        resolve(Response.json(body));
      }),
  };
}

function fallbackOrder(view: ReturnType<typeof draw>) {
  return view
    .getAllByTestId("fallback-row")
    .map((row) => row.querySelector(".font-mono")?.textContent);
}

test("备用模型保存期间的后续删除保留，旧响应只更新已保存值", async () => {
  const save = pendingSave("/api/admin/model-fallbacks");
  const view = draw("fallback");
  fireEvent.click(view.getAllByRole("button", { name: "下移" })[0]!);
  fireEvent.click(view.getByTestId("fallback-save"));
  expect(save.writes).toEqual([{ models: ["b", "a", "c"] }]);
  fireEvent.click(view.getAllByRole("button", { name: "移除" })[2]!);
  await save.finish({ models: ["b", "a", "c"] });
  await waitFor(() =>
    expect(view.client.getQueryData(fallbackKey)).toEqual({
      models: ["b", "a", "c"],
    }),
  );
  expect(fallbackOrder(view)).toEqual(["b", "a"]);
});

test("备用模型后台重取跟随已保存值，但不覆盖未保存顺序", async () => {
  const view = draw("fallback");
  await act(async () => {
    view.client.setQueryData(fallbackKey, { models: ["c", "a", "b"] });
  });
  await waitFor(() => expect(fallbackOrder(view)).toEqual(["c", "a", "b"]));
  fireEvent.click(view.getAllByRole("button", { name: "下移" })[0]!);
  await act(async () => {
    view.client.setQueryData(fallbackKey, { models: ["b", "c"] });
  });
  expect(fallbackOrder(view)).toEqual(["a", "c", "b"]);
});

async function pickSummary(view: ReturnType<typeof draw>, model: string) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByTestId("history-summary-model-select"));
  await user.click(await view.findByRole("option", { name: model }));
}

function summaryValue(view: ReturnType<typeof draw>) {
  return view
    .getByTestId("history-summary-model-select")
    .querySelector('[data-slot="select-value"]')?.textContent;
}

test("摘要模型保存期间新选的模型不会被旧保存结果覆盖", async () => {
  const save = pendingSave("/api/admin/history-summary-model");
  const view = draw("summary");
  await pickSummary(view, "b");
  fireEvent.click(view.getByTestId("history-summary-model-save"));
  expect(save.writes).toEqual([{ model: "b" }]);
  await pickSummary(view, "c");
  await save.finish({ model: "b" });
  await waitFor(() =>
    expect(view.client.getQueryData(summaryKey)).toEqual({ model: "b" }),
  );
  expect(summaryValue(view)).toBe("c");
});

test("摘要模型后台重取更新干净表单，编辑后继续保留选择", async () => {
  const view = draw("summary");
  await act(async () => {
    view.client.setQueryData(summaryKey, { model: "b" });
  });
  await waitFor(() => expect(summaryValue(view)).toBe("b"));
  await pickSummary(view, "c");
  await act(async () => {
    view.client.setQueryData(summaryKey, { model: null });
  });
  expect(summaryValue(view)).toBe("c");
});

test("保存后没有后续修改的表单继续跟随服务器设置", async () => {
  const save = pendingSave("/api/admin/model-fallbacks");
  const view = draw("fallback");
  fireEvent.click(view.getAllByRole("button", { name: "下移" })[0]!);
  fireEvent.click(view.getByTestId("fallback-save"));
  await save.finish({ models: ["b", "a", "c"] });
  await waitFor(() =>
    expect(view.client.getQueryData(fallbackKey)).toEqual({
      models: ["b", "a", "c"],
    }),
  );
  await act(async () => {
    view.client.setQueryData(fallbackKey, { models: ["c"] });
  });
  await waitFor(() => expect(fallbackOrder(view)).toEqual(["c"]));
});
