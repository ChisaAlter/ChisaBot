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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ComputerView } from "@/components/computer/computer-view";
import { LiveScreen } from "@/components/computer/live-screen";
import { controlStores } from "@/lib/computers/use-control";
import { settleReactWork } from "./settle-react-work";

class SocketDouble {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: SocketDouble | undefined;

  readyState = SocketDouble.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(_url: string) {
    SocketDouble.latest = this;
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    this.readyState = SocketDouble.CLOSED;
    this.onclose?.();
  }
}

class VisibleObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
}

let originalWebSocket: typeof WebSocket;
let originalCreateImageBitmap: typeof createImageBitmap | undefined;
let originalFetch: typeof fetch;
let originalIntersectionObserver: typeof IntersectionObserver;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
  originalWebSocket = globalThis.WebSocket;
  originalCreateImageBitmap = globalThis.createImageBitmap;
  originalFetch = globalThis.fetch;
  originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.WebSocket = SocketDouble as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    VisibleObserver as unknown as typeof IntersectionObserver;
  globalThis.createImageBitmap = (async () => ({
    width: 800,
    height: 600,
    close() {},
  })) as unknown as typeof createImageBitmap;
});

afterEach(() => {
  cleanup();
  SocketDouble.latest = undefined;
  globalThis.fetch = originalFetch;
  for (const store of controlStores.values()) store.dispose();
  controlStores.clear();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  if (originalCreateImageBitmap) {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  } else {
    Reflect.deleteProperty(globalThis, "createImageBitmap");
  }
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

async function emitFrame(socket: SocketDouble) {
  await act(async () => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "frame",
        data: "AAAA",
        width: 800,
        height: 600,
        url: "https://example.com/",
      }),
    });
  });
}

describe("LiveScreen click auto-takeover & watch-only lock", () => {
  test("ignores mouseDown before frame arrives and ignores mouseMove after frame arrives", async () => {
    let takeoverCalls = 0;
    const { container } = render(
      <LiveScreen
        computerId="auto-takeover-1"
        driving={false}
        onRequestAutoTakeover={async () => {
          takeoverCalls += 1;
          return true;
        }}
      />,
    );
    await waitFor(() => expect(SocketDouble.latest).toBeDefined());
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;

    // 还没收到第一帧（hasFrame=false）时不响应自动接管
    fireEvent.mouseDown(canvas, { button: 0, clientX: 20, clientY: 20 });
    expect(takeoverCalls).toBe(0);

    await emitFrame(SocketDouble.latest as SocketDouble);
    await waitFor(() =>
      expect(canvas.getAttribute("data-has-frame")).toBe("true"),
    );

    // mousemove 绝不触发接管（防误触）
    fireEvent.mouseMove(canvas, { clientX: 30, clientY: 30 });
    expect(takeoverCalls).toBe(0);
  });

  test("triggers onRequestAutoTakeover on mousedown when watching, shows pending & failure states", async () => {
    let calls = 0;
    let resolveTakeover!: (value: boolean) => void;
    const ui = render(
      <LiveScreen
        computerId="auto-takeover-2"
        driving={false}
        onRequestAutoTakeover={() => {
          calls += 1;
          return new Promise<boolean>((resolve) => {
            resolveTakeover = resolve;
          });
        }}
      />,
    );
    await waitFor(() => expect(SocketDouble.latest).toBeDefined());
    const canvas = ui.container.querySelector("canvas") as HTMLCanvasElement;
    await emitFrame(SocketDouble.latest as SocketDouble);
    await waitFor(() =>
      expect(canvas.getAttribute("data-has-frame")).toBe("true"),
    );

    fireEvent.mouseDown(canvas, { button: 0, clientX: 50, clientY: 50 });
    expect(calls).toBe(1);
    expect(ui.getByText("正在接管控制…")).toBeTruthy();

    // 接管请求进行中再次点击不重复发起
    fireEvent.mouseDown(canvas, { button: 0, clientX: 60, clientY: 60 });
    expect(calls).toBe(1);

    await act(async () => {
      resolveTakeover(false);
    });
    await waitFor(() =>
      expect(ui.getByRole("alert").textContent).toContain("没能接管控制"),
    );
  });

  test("locks canvas auto-takeover when watchOnly is enabled", async () => {
    let calls = 0;
    const ui = render(
      <LiveScreen
        computerId="auto-takeover-3"
        driving={false}
        onRequestAutoTakeover={async () => {
          calls += 1;
          return true;
        }}
        watchOnly
      />,
    );
    await waitFor(() => expect(SocketDouble.latest).toBeDefined());
    const canvas = ui.container.querySelector("canvas") as HTMLCanvasElement;
    await emitFrame(SocketDouble.latest as SocketDouble);
    await waitFor(() =>
      expect(canvas.getAttribute("data-has-frame")).toBe("true"),
    );

    expect(canvas.getAttribute("data-watch-only")).toBe("true");
    expect(ui.getByText("仅观摩")).toBeTruthy();

    fireEvent.mouseDown(canvas, { button: 0, clientX: 40, clientY: 40 });
    expect(calls).toBe(0);
  });

  test("ComputerView toolbar watch-only switch locks and unlocks live canvas click takeover", async () => {
    let takeCalls = 0;
    let holder: "bot" | "human" = "bot";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/control")) {
        return Response.json({
          holder,
          since: new Date(0).toISOString(),
          requested: false,
        });
      }
      if (url.endsWith("/control/request")) {
        return Response.json({
          holder,
          since: new Date(0).toISOString(),
          requested: true,
          request: {
            id: "req-1",
            status: "waiting",
          },
        });
      }
      if (url.endsWith("/control/take")) {
        takeCalls += 1;
        holder = "human";
        return Response.json({
          holder: "human",
          since: new Date().toISOString(),
          requested: false,
          request: {
            id: "req-1",
            status: "granted",
            holder: "human",
          },
        });
      }
      if (url.endsWith("/screenshot")) {
        return Response.json({
          base64: "AAAA",
          width: 800,
          height: 600,
          capturedAt: new Date().toISOString(),
          url: "https://example.com/",
        });
      }
      if (url.endsWith("/tabs")) {
        return Response.json({
          running: true,
          max: 8,
          activeId: "t1",
          tabs: [
            {
              id: "t1",
              url: "https://example.com/",
              title: "Example",
              active: true,
            },
          ],
        });
      }
      if (url === "/api/browser-bookmarks") {
        return Response.json({ bookmarks: [], max: 100 });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    const ui = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ComputerView computerId="view-takeover" active intervalMs={60_000} />
      </QueryClientProvider>,
    );

    const openBtn = ui.getByRole("button", { name: "打开助手屏幕全尺寸" });
    fireEvent.click(openBtn);

    await waitFor(() => expect(SocketDouble.latest).toBeDefined());
    await emitFrame(SocketDouble.latest as SocketDouble);

    const dialog = ui.getByRole("dialog", { name: "助手的屏幕" });
    const canvas = dialog.querySelector("canvas") as HTMLCanvasElement;
    await waitFor(() =>
      expect(canvas.getAttribute("data-has-frame")).toBe("true"),
    );

    const watchBtn = ui.getByRole("button", { name: "仅观摩" });
    expect(watchBtn.getAttribute("aria-pressed")).toBe("false");

    // 打开「仅观摩」锁：点击画布不再发起接管
    fireEvent.click(watchBtn);
    expect(watchBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    expect(takeCalls).toBe(0);

    // 关闭「仅观摩」锁：点击画布走接管链路
    fireEvent.click(watchBtn);
    expect(watchBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    await waitFor(() => expect(takeCalls).toBe(1));
  });
});
