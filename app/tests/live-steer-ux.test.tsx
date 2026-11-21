import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/channels/composer/composer";
import { QueuedMessages } from "@/components/chat/queued-messages";
import { BusySendModePreference } from "@/components/settings/busy-send-mode-preference";
import { ConversationScopeProvider } from "@/lib/chat/conversation-scope";
import {
  BUSY_SEND_MODE_STORAGE_KEY,
  type BusySendMode,
  getBusySendMode,
  reverseBusySendMode,
  setBusySendMode,
  syncBusySendModeFromStorage,
} from "@/lib/conversations/send-mode";
import {
  queueMessage,
  withdrawMessage,
} from "@/lib/conversations/thread-inbox";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  }
});

const originalFetch = globalThis.fetch;

beforeEach(() => {
  window.localStorage.removeItem(BUSY_SEND_MODE_STORAGE_KEY);
  syncBusySendModeFromStorage(BUSY_SEND_MODE_STORAGE_KEY);
  setBusySendMode("steer");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.localStorage.removeItem(BUSY_SEND_MODE_STORAGE_KEY);
  syncBusySendModeFromStorage(BUSY_SEND_MODE_STORAGE_KEY);
});

afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("send-mode preference store", () => {
  test("defaults to steer, flips cleanly, and syncs from localStorage", () => {
    expect(getBusySendMode()).toBe("steer");
    expect(reverseBusySendMode("steer")).toBe("queue");
    expect(reverseBusySendMode("queue")).toBe("steer");

    setBusySendMode("queue");
    expect(getBusySendMode()).toBe("queue");
    expect(window.localStorage.getItem(BUSY_SEND_MODE_STORAGE_KEY)).toBe(
      "queue",
    );

    window.localStorage.setItem(BUSY_SEND_MODE_STORAGE_KEY, "steer");
    syncBusySendModeFromStorage(BUSY_SEND_MODE_STORAGE_KEY);
    expect(getBusySendMode()).toBe("steer");
  });
});

describe("QueueDock steer / edit / withdraw UX", () => {
  test("supports 立即引导 (next-step label), 行内编辑, and 撤回", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (method === "POST") {
        return new Response(
          JSON.stringify({ queued: true, status: "queued", mode: "queue" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PATCH") {
        if (body?.action === "steer") {
          return new Response(
            JSON.stringify({ ok: true, steerAction: "next-step" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (body?.action === "edit") {
          return new Response(
            JSON.stringify({
              ok: true,
              item: { id: body.id, status: "queued" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
      }
      if (method === "DELETE") {
        return new Response(JSON.stringify({ withdrawn: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      await queueMessage("t-ux", "先看日志", "msg-1", { mode: "queue" });
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationScopeProvider agentId="bot-1" threadId="t-ux">
          <QueuedMessages />
        </ConversationScopeProvider>
      </QueryClientProvider>,
    );

    expect(view.getByText("先看日志")).toBeTruthy();
    expect(view.getByText("已排队 · 当前步骤结束后读取")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByTestId("queued-steer-btn"));
    });
    expect(view.getByText("已插话 · 当前操作后接管")).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c.method === "PATCH" &&
          (c.body as { action?: string })?.action === "steer",
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(view.getByTestId("queued-edit-btn"));
    });
    const user = userEvent.setup({ document: globalThis.document });
    const input = view.getByTestId("queued-edit-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "改成输出表格");
    await act(async () => {
      await user.click(view.getByTestId("queued-edit-save"));
    });
    expect(view.getByText("改成输出表格")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByLabelText("撤回这条排队的消息"));
    });
    await act(async () => {
      await settleReactWork();
    });
    expect(view.queryByText("改成输出表格")).toBeNull();
    // Cleanup if still present
    await withdrawMessage("t-ux", "msg-1");
  });
});

describe("Composer busy-mode pill, Ctrl+Enter reverse, empty-Enter promote & Settings", () => {
  test("busy composer renders toggle pill, sends mode on queue, reverses on Ctrl+Enter, and promotes on empty Enter", async () => {
    const queued: { text: string; mode: BusySendMode | undefined }[] = [];
    let promoted = 0;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConversationScopeProvider agentId="bot-1" threadId="t-comp">
          <Composer
            compact
            onPromoteQueued={() => {
              promoted += 1;
            }}
            onQueue={(draft, mode) => {
              queued.push({ text: draft.text, mode });
            }}
            onSubmit={() => {}}
            pending
          />
        </ConversationScopeProvider>
      </QueryClientProvider>,
    );

    await act(async () => {
      await settleReactWork();
    });

    const pill = view.getByTestId("busy-send-mode-toggle");
    expect(pill.textContent).toContain("插话");

    // Empty Enter promotes pending queued items
    const form = view.container.querySelector("form");
    expect(form).toBeTruthy();
    if (form) {
      fireEvent.keyDown(form, { key: "Enter" });
    }
    expect(promoted).toBe(1);

    // Toggle pill switches preference between steer <-> queue
    fireEvent.click(pill);
    expect(getBusySendMode()).toBe("queue");
    expect(pill.textContent).toContain("排队");

    // Populate editor text cleanly and test Ctrl+Enter reverses "queue" -> "steer"
    const editable = view.container.querySelector(
      '[contenteditable="true"], textarea',
    ) as HTMLElement | null;
    expect(editable).toBeTruthy();
    if (editable) {
      editable.textContent = "立刻切过去";
      fireEvent.input(editable);
      await act(async () => {
        await settleReactWork();
      });
      if (form) {
        await act(async () => {
          fireEvent.keyDown(form, { key: "Enter", ctrlKey: true });
        });
      }
      expect(queued[0]).toEqual({ text: "立刻切过去", mode: "steer" });
    }
  });

  test("BusySendModePreference toggles aria-pressed and store state", () => {
    const view = render(<BusySendModePreference />);
    const steerBtn = view.getByTestId("busy-send-mode-steer");
    const queueBtn = view.getByTestId("busy-send-mode-queue");
    expect(steerBtn.getAttribute("aria-pressed")).toBe("true");
    expect(queueBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(queueBtn);
    expect(getBusySendMode()).toBe("queue");
    expect(queueBtn.getAttribute("aria-pressed")).toBe("true");
  });
});
