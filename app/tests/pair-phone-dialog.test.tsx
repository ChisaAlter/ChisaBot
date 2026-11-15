import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { AddServerCard } from "@/components/devices/full-access";
import { PairPhoneDialog } from "@/components/devices/pair-phone";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import { ClientError } from "@/lib/client";
import {
  createPairing,
  type PairingStatus,
  type PairingTicket,
  pairingErrorMessage,
} from "@/lib/devices";
import { settleReactWork } from "./settle-react-work";

type RecordedRequest = {
  method: string;
  pathname: string;
  contentType: string | null;
  bodyText: string;
};

type RouteBehavior =
  | { kind: "ok"; ticket?: Partial<PairingTicket> }
  | { kind: "slow"; delayMs: number }
  | { kind: "status"; status: number; error: string }
  | { kind: "throw"; error: Error };

type PollBehavior =
  | { kind: "state"; state: PairingStatus["state"]; deviceName?: string }
  | { kind: "status"; status: number; error: string };

let server: Server;
let serverPort = 0;
let recorded: RecordedRequest[] = [];
let script: RouteBehavior[] = [];
let pollScript: PollBehavior[] = [];
let nextId = 1;
let runId = 0;
let registeredDom = false;
let prevHref: string | null = null;
let prevFetch: typeof globalThis.fetch;
const inflightFetches = new Set<Promise<unknown>>();
// Use Bun's native fetch for the local test HTTP server so happy-dom's https->http Mixed Content guard never blocks it.
const nativeFetch = Bun.fetch;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function setDomUrl(url: string) {
  const happyDom = Reflect.get(window, "happyDOM");
  if (
    typeof happyDom === "object" &&
    happyDom !== null &&
    "setURL" in happyDom &&
    typeof happyDom.setURL === "function"
  ) {
    happyDom.setURL(url);
  }
}

function makeTicket(overrides?: Partial<PairingTicket>): PairingTicket {
  const id = `pair_${nextId++}`;
  return {
    id,
    code: `cbp_${id.padEnd(24, "x")}`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ttlSeconds: 300,
    kind: "phone",
    ...overrides,
  };
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

async function fetchWithSignalBridge(
  target: string,
  init?: RequestInit,
): Promise<Response> {
  const signal = init?.signal;
  if (!signal) return nativeFetch(target, init);
  const abortReason = () =>
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError");
  if (signal.aborted) throw abortReason();

  const { signal: _ignored, ...rest } = init;
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortReason()));
    signal.addEventListener("abort", onAbort, { once: true });
    nativeFetch(target, rest).then(
      (response) => finish(() => resolve(response)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function installFetchBridge() {
  prevFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const parsed = new URL(rawUrl, "https://chisabot.example.com:8443");
      let behavior: RouteBehavior | null = null;
      if (
        parsed.pathname === "/api/devices/pairing" &&
        (init?.method ?? "GET").toUpperCase() === "POST" &&
        script[0]?.kind === "throw"
      ) {
        behavior = script.shift() ?? null;
      }
      if (behavior?.kind === "throw") {
        throw behavior.error;
      }
      if (parsed.pathname.startsWith("/api/")) {
        const target = `http://127.0.0.1:${serverPort}${parsed.pathname}${parsed.search}`;
        const pending = fetchWithSignalBridge(target, init);
        inflightFetches.add(pending);
        pending.finally(() => inflightFetches.delete(pending)).catch(() => {});
        return pending;
      }
      return prevFetch(input, init);
    },
    prevFetch,
  );
}

beforeAll(async () => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({
      url: "https://chisabot.example.com:8443/settings/devices",
    });
    registeredDom = true;
  } else {
    prevHref = window.location.href;
    setDomUrl("https://chisabot.example.com:8443/settings/devices");
  }

  server = createServer(async (req, res) => {
    const requestRun = runId;
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort || 80}`);
    const bodyText = await readBody(req);
    const contentTypeHeader = req.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader.join(", ")
      : (contentTypeHeader ?? null);

    if (requestRun === runId) {
      recorded.push({
        method,
        pathname: url.pathname,
        contentType,
        bodyText,
      });
    }

    if (url.pathname === "/api/devices/pairing" && method === "POST") {
      const step = script.shift() ?? { kind: "ok" };
      if (step.kind === "slow") {
        await Bun.sleep(step.delayMs);
        if (requestRun !== runId || res.writableEnded) return;
        sendJson(res, 201, makeTicket());
        return;
      }
      if (step.kind === "status") {
        sendJson(res, step.status, { error: step.error });
        return;
      }
      if (step.kind === "ok") {
        let parsedKind: "phone" | "node" = "phone";
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "kind" in parsed &&
            parsed.kind === "node"
          ) {
            parsedKind = "node";
          }
        } catch {
          // Keep default when caller omits JSON.
        }
        sendJson(res, 201, makeTicket({ kind: parsedKind, ...step.ticket }));
        return;
      }
    }

    if (url.pathname.startsWith("/api/devices/pairing/") && method === "GET") {
      const id = url.pathname.split("/").pop() ?? "pair_1";
      const step = pollScript.shift();
      if (step?.kind === "status") {
        sendJson(res, step.status, { error: step.error });
        return;
      }
      const state = step?.kind === "state" ? step.state : "pending";
      sendJson(res, 200, {
        id,
        state,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        device:
          state === "bound"
            ? {
                id: "dev_1",
                name:
                  step?.kind === "state"
                    ? (step.deviceName ?? "测试手机")
                    : "测试手机",
              }
            : null,
      });
      return;
    }

    if (
      url.pathname.startsWith("/api/devices/pairing/") &&
      method === "DELETE"
    ) {
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") {
        serverPort = address.port;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  jest.useRealTimers();
  runId += 1;
  recorded = [];
  script = [];
  pollScript = [];
  nextId = 1;
  resetToastsForTest();
  installFetchBridge();
});

afterEach(async () => {
  cleanup();
  await settleReactWork();
  await Promise.allSettled([...inflightFetches]);
  jest.useRealTimers();
  resetToastsForTest();
  globalThis.fetch = prevFetch;
});

afterAll(async () => {
  await settleReactWork();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (registeredDom && GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  } else if (prevHref !== null) {
    setDomUrl(prevHref);
  }
});

describe("phone pairing transport and dialog", () => {
  test("createPairing('phone') sends explicit JSON body with application/json content-type", async () => {
    const ticket = await createPairing();
    expect(ticket.kind).toBe("phone");
    const post = recorded.find(
      (req) => req.method === "POST" && req.pathname === "/api/devices/pairing",
    );
    expect(post).toBeDefined();
    expect(post?.contentType).toBe("application/json");
    expect(post?.bodyText).toBe('{"kind":"phone"}');
  });

  test("createPairing retries once on transient timeout and never retries HTTP errors", async () => {
    // Keep Bun's timer wheel active across AbortSignal.timeout (AGENTS.md Bun timer trap).
    script = [{ kind: "slow", delayMs: 120 }, { kind: "ok" }];
    const ticket = await createPairing("phone", { timeoutMs: 35 });
    expect(ticket.id).toBe("pair_1");
    expect(
      recorded.filter((r) => r.pathname === "/api/devices/pairing"),
    ).toHaveLength(2);

    recorded = [];
    script = [{ kind: "status", status: 500, error: "服务暂不可用" }];
    await expect(
      createPairing("phone", { timeoutMs: 35 }),
    ).rejects.toMatchObject({
      message: "服务暂不可用",
      status: 500,
    });
    expect(
      recorded.filter((r) => r.pathname === "/api/devices/pairing"),
    ).toHaveLength(1);
  });

  test("PairPhoneDialog translates timeout and network failures to Chinese and recovers on refresh", async () => {
    // Each createPairing() retries transient transport failures once (2 attempts total).
    script = [
      {
        kind: "throw",
        error: new DOMException("signal timed out", "TimeoutError"),
      },
      {
        kind: "throw",
        error: new DOMException("signal timed out", "TimeoutError"),
      },
      { kind: "throw", error: new TypeError("Failed to fetch") },
      { kind: "throw", error: new TypeError("Failed to fetch") },
      { kind: "ok" },
    ];
    const qc = queryClient();
    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <PairPhoneDialog onOpenChange={() => {}} open />
      </QueryClientProvider>,
    );

    const dialog = await within(document.body).findByRole("dialog");
    const refreshButton = () => {
      const found = within(dialog)
        .getAllByRole("button")
        .find((button) => (button.textContent ?? "").includes("刷新二维码"));
      if (!(found instanceof HTMLButtonElement)) {
        throw new Error("Expected refresh button");
      }
      return found;
    };

    await waitFor(() => {
      expect(within(dialog).getByText("生成失败")).toBeTruthy();
      expect(
        within(dialog).getByText("连接服务器超时，请点「刷新二维码」重试"),
      ).toBeTruthy();
    });
    expect(document.body.textContent ?? "").not.toContain("signal timed out");

    await waitFor(() => {
      expect(refreshButton().disabled).toBe(false);
    });
    fireEvent.click(refreshButton());
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "网络连不上，请检查网络后点「刷新二维码」重试",
        ),
      ).toBeTruthy();
      expect(document.body.textContent ?? "").toContain(
        "刷新失败：网络连不上，请检查网络后点「刷新二维码」重试",
      );
    });
    expect(document.body.textContent ?? "").not.toContain("Failed to fetch");

    await waitFor(() => {
      expect(refreshButton().disabled).toBe(false);
    });
    fireEvent.click(refreshButton());
    await waitFor(() => {
      expect(within(dialog).getByText("等待扫码")).toBeTruthy();
      expect(
        within(dialog).getByRole("img", { name: "绑定二维码" }),
      ).toBeTruthy();
    });
    expect(dialog.textContent ?? "").toContain(
      "https://chisabot.example.com:8443",
    );
    await settleReactWork();
  });

  test("closing PairPhoneDialog mid-flight aborts issuance and cancels any orphan ticket", async () => {
    let resolveSlow: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    let abortedSeen = false;

    const bridgeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const parsed = new URL(rawUrl, "https://chisabot.example.com:8443");
        if (
          parsed.pathname === "/api/devices/pairing" &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        ) {
          init?.signal?.addEventListener("abort", () => {
            abortedSeen = true;
          });
          await delayed;
          return new Response(
            JSON.stringify(makeTicket({ id: "pair_orphan" })),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return bridgeFetch(input, init);
      },
      bridgeFetch,
    );

    const qc = queryClient();
    const view = render(
      <QueryClientProvider client={qc}>
        <PairPhoneDialog onOpenChange={() => {}} open />
      </QueryClientProvider>,
    );

    await act(async () => {
      await Bun.sleep(10);
    });
    view.rerender(
      <QueryClientProvider client={qc}>
        <PairPhoneDialog onOpenChange={() => {}} open={false} />
      </QueryClientProvider>,
    );
    await act(async () => {
      resolveSlow();
    });
    await waitFor(() => {
      expect(abortedSeen).toBe(true);
      expect(
        recorded.some(
          (req) =>
            req.method === "DELETE" &&
            req.pathname === "/api/devices/pairing/pair_orphan",
        ),
      ).toBe(true);
    });
    await settleReactWork();
  });

  test("auto-refresh on countdown expiry issues one ticket and never double-issues or deletes the new ticket", async () => {
    script = [
      { kind: "ok", ticket: { ttlSeconds: 1 } },
      { kind: "ok", ticket: { ttlSeconds: 5 } },
      { kind: "ok", ticket: { ttlSeconds: 5 } },
    ];
    const qc = queryClient();
    render(
      <QueryClientProvider client={qc}>
        <PairPhoneDialog onOpenChange={() => {}} open />
      </QueryClientProvider>,
    );

    const dialog = await within(document.body).findByRole("dialog");
    await waitFor(() => {
      expect(dialog.textContent ?? "").toContain("0:01 后自动刷新");
    });

    await waitFor(
      () => {
        expect(dialog.textContent ?? "").toContain("0:05 后自动刷新");
      },
      { timeout: 3500 },
    );
    await act(async () => {
      await Bun.sleep(250);
    });

    const posts = recorded.filter(
      (req) => req.method === "POST" && req.pathname === "/api/devices/pairing",
    );
    expect(posts).toHaveLength(2);
    expect(
      recorded.some(
        (req) =>
          req.method === "DELETE" &&
          req.pathname === "/api/devices/pairing/pair_1",
      ),
    ).toBe(true);
    expect(
      recorded.some(
        (req) =>
          req.method === "DELETE" &&
          req.pathname === "/api/devices/pairing/pair_2",
      ),
    ).toBe(false);
    expect(within(dialog).getByText("等待扫码")).toBeTruthy();
    await settleReactWork();
  });

  test("polling state cancelled or HTTP 404 rotates to a fresh pairing code without deleting the dead one", async () => {
    script = [
      { kind: "ok", ticket: { ttlSeconds: 300 } },
      { kind: "ok", ticket: { ttlSeconds: 120 } },
      { kind: "ok", ticket: { ttlSeconds: 180 } },
    ];
    pollScript = [
      { kind: "state", state: "cancelled" },
      { kind: "status", status: 404, error: "Pairing not found." },
    ];
    const qc = queryClient();
    render(
      <QueryClientProvider client={qc}>
        <PairPhoneDialog onOpenChange={() => {}} open />
      </QueryClientProvider>,
    );

    const dialog = await within(document.body).findByRole("dialog");
    await waitFor(() => {
      expect(dialog.textContent ?? "").toContain("5:00 后自动刷新");
    });

    await waitFor(
      () => {
        expect(dialog.textContent ?? "").toContain("2:00 后自动刷新");
      },
      { timeout: 4500 },
    );
    expect(
      recorded.some(
        (req) =>
          req.method === "DELETE" &&
          req.pathname === "/api/devices/pairing/pair_1",
      ),
    ).toBe(false);

    await waitFor(
      () => {
        expect(dialog.textContent ?? "").toContain("3:00 后自动刷新");
      },
      { timeout: 4500 },
    );
    expect(
      recorded.some(
        (req) =>
          req.method === "DELETE" &&
          req.pathname === "/api/devices/pairing/pair_2",
      ),
    ).toBe(false);
    expect(
      recorded.filter(
        (req) =>
          req.method === "POST" && req.pathname === "/api/devices/pairing",
      ),
    ).toHaveLength(3);
    await settleReactWork();
  }, 12_000);

  test("stops auto-refresh after MAX_AUTO_REFRESH (6) cycles and manual refresh issues once", async () => {
    const realPerfNow = performance.now.bind(performance);
    let perfOffset = 0;
    performance.now = () => realPerfNow() + perfOffset;
    try {
      script = [
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 1 } },
        { kind: "ok", ticket: { ttlSeconds: 300 } },
        { kind: "ok", ticket: { ttlSeconds: 300 } },
      ];
      const qc = queryClient();
      render(
        <QueryClientProvider client={qc}>
          <PairPhoneDialog onOpenChange={() => {}} open />
        </QueryClientProvider>,
      );

      const dialog = await within(document.body).findByRole("dialog");
      const postCount = () =>
        recorded.filter(
          (req) =>
            req.method === "POST" && req.pathname === "/api/devices/pairing",
        ).length;
      const currentQrPath = () =>
        within(dialog)
          .queryByRole("img", { name: "绑定二维码" })
          ?.querySelector("path")
          ?.getAttribute("d") ?? null;

      let prevPath: string | null = null;
      for (let expected = 1; expected <= 7; expected += 1) {
        let nextPath: string | null = null;
        await waitFor(
          () => {
            expect(postCount()).toBeGreaterThanOrEqual(expected);
            nextPath = currentQrPath();
            expect(nextPath).toBeTruthy();
            expect(nextPath).not.toBe(prevPath);
          },
          { timeout: 3000 },
        );
        expect(postCount()).toBe(expected);
        prevPath = nextPath;
        await act(async () => {
          perfOffset += 1500;
        });
      }

      await waitFor(
        () => {
          expect(within(dialog).getByText("二维码已暂停刷新")).toBeTruthy();
        },
        { timeout: 3000 },
      );
      await act(async () => {
        await Bun.sleep(150);
      });
      expect(postCount()).toBe(7);
      expect(
        recorded.some(
          (req) =>
            req.method === "DELETE" &&
            req.pathname === "/api/devices/pairing/pair_7",
        ),
      ).toBe(true);

      const refreshButton = within(dialog)
        .getAllByRole("button")
        .find((button) => (button.textContent ?? "").includes("刷新二维码"));
      if (!(refreshButton instanceof HTMLButtonElement)) {
        throw new Error("Expected refresh button");
      }
      fireEvent.click(refreshButton);

      await waitFor(() => {
        expect(dialog.textContent ?? "").toContain("5:00 后自动刷新");
      });
      await act(async () => {
        await Bun.sleep(200);
      });
      expect(postCount()).toBe(8);
      expect(
        recorded.some(
          (req) =>
            req.method === "DELETE" &&
            req.pathname === "/api/devices/pairing/pair_8",
        ),
      ).toBe(false);
      expect(within(dialog).getByText("等待扫码")).toBeTruthy();
      await settleReactWork();
    } finally {
      performance.now = realPerfNow;
    }
  }, 15_000);

  test("pairingErrorMessage and dialog map English ClientError responses to Chinese while keeping Chinese messages", async () => {
    expect(
      pairingErrorMessage(new ClientError("Authentication required.", 401)),
    ).toBe("登录已过期，请刷新页面重新登录后重试");
    expect(
      pairingErrorMessage(new ClientError("Authorization required.", 403)),
    ).toBe("当前账号没有权限执行此操作");
    expect(
      pairingErrorMessage(new ClientError("Not Found", 404), "phone"),
    ).toBe("服务器暂不支持扫码绑定，请先更新服务器");
    expect(pairingErrorMessage(new ClientError("Not Found", 404), "node")).toBe(
      "服务器暂不支持节点安装，请先更新服务器",
    );
    expect(pairingErrorMessage(new ClientError("Too Many Requests", 429))).toBe(
      "操作太频繁，请稍后再试",
    );
    expect(
      pairingErrorMessage(
        new ClientError("No identity provider is configured.", 503),
      ),
    ).toBe("服务器尚未配置登录认证，无法绑定设备");
    expect(
      pairingErrorMessage(new ClientError("Bad Gateway", 502), "phone"),
    ).toBe("服务器暂时不可用，请稍后点「刷新二维码」重试");
    expect(
      pairingErrorMessage(new ClientError("Bad Gateway", 502), "node"),
    ).toBe("服务器暂时不可用，请稍后重试");
    expect(
      pairingErrorMessage(new ClientError("I am a teapot", 418), "phone"),
    ).toBe("无法生成二维码，请重试");
    expect(
      pairingErrorMessage(new ClientError("I am a teapot", 418), "node"),
    ).toBe("无法生成安装命令，请重试");
    expect(
      pairingErrorMessage(
        new ClientError("该设备绑定的二维码服务维护中，请稍后再试", 503),
      ),
    ).toBe("该设备绑定的二维码服务维护中，请稍后再试");

    script = [
      { kind: "status", status: 401, error: "Authentication required." },
      { kind: "status", status: 403, error: "Authorization required." },
      {
        kind: "status",
        status: 503,
        error: "No identity provider is configured.",
      },
      { kind: "status", status: 503, error: "系统维护中，请两分钟后再试" },
    ];
    const qc = queryClient();
    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <PairPhoneDialog onOpenChange={() => {}} open />
      </QueryClientProvider>,
    );

    const dialog = await within(document.body).findByRole("dialog");
    const refreshButton = () => {
      const found = within(dialog)
        .getAllByRole("button")
        .find((button) => (button.textContent ?? "").includes("刷新二维码"));
      if (!(found instanceof HTMLButtonElement)) {
        throw new Error("Expected refresh button");
      }
      return found;
    };

    await waitFor(() => {
      expect(
        within(dialog).getByText("登录已过期，请刷新页面重新登录后重试"),
      ).toBeTruthy();
    });
    expect(document.body.textContent ?? "").not.toContain(
      "Authentication required",
    );

    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    fireEvent.click(refreshButton());
    await waitFor(() => {
      expect(
        within(dialog).getByText("当前账号没有权限执行此操作"),
      ).toBeTruthy();
    });
    expect(document.body.textContent ?? "").not.toContain(
      "Authorization required",
    );

    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    fireEvent.click(refreshButton());
    await waitFor(() => {
      expect(
        within(dialog).getByText("服务器尚未配置登录认证，无法绑定设备"),
      ).toBeTruthy();
    });
    expect(document.body.textContent ?? "").not.toContain(
      "No identity provider",
    );

    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    fireEvent.click(refreshButton());
    await waitFor(() => {
      expect(
        within(dialog).getByText("系统维护中，请两分钟后再试"),
      ).toBeTruthy();
    });
    await settleReactWork();
  });

  test("unmounting AddServerCard mid-flight aborts node pairing and cancels orphan ticket", async () => {
    let resolveSlow: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    let abortedSeen = false;

    const bridgeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const parsed = new URL(rawUrl, "https://chisabot.example.com:8443");
        if (
          parsed.pathname === "/api/devices/pairing" &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        ) {
          init?.signal?.addEventListener("abort", () => {
            abortedSeen = true;
          });
          await delayed;
          return new Response(
            JSON.stringify(
              makeTicket({ id: "pair_node_orphan", kind: "node" }),
            ),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return bridgeFetch(input, init);
      },
      bridgeFetch,
    );

    const qc = queryClient();
    const view = render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <AddServerCard />
      </QueryClientProvider>,
    );

    fireEvent.click(view.getByRole("button", { name: "生成安装命令" }));
    await act(async () => {
      await Bun.sleep(10);
    });
    view.unmount();
    await act(async () => {
      resolveSlow();
    });

    await waitFor(() => {
      expect(abortedSeen).toBe(true);
      expect(
        recorded.some(
          (req) =>
            req.method === "DELETE" &&
            req.pathname === "/api/devices/pairing/pair_node_orphan",
        ),
      ).toBe(true);
    });
    expect(document.body.textContent ?? "").not.toContain("已取消");
    await settleReactWork();
  });
});
