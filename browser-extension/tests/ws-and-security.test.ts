import { describe, expect, test } from "bun:test";
import {
  createExtensionAuth,
  normalizeServerUrl,
  parsePairingInput,
} from "../src/background/auth";
import {
  assessBrowserActionRisk,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  reduceBrowserCompanionSession,
} from "../src/background/security-bridge";
import {
  buildDeviceWsUrl,
  type CompanionCommandPayload,
  createCompanionWsClient,
  type WsLike,
} from "../src/background/ws-client";
import type { ChromeApi } from "../src/types/chrome";

class FakeWebSocket implements WsLike {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  emit(type: string, event: unknown = {}) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(event);
    }
  }
}

describe("权限纵深防御、共享状态机、认证流程与 WSS 协议", () => {
  test("直接复用 shared/browser-companion.ts 严守黑名单防绕过、付款锁与三档权限边界", () => {
    // 1. 内置与自定义黑名单（含大小写、FQDN 尾点、子域与受保护协议）永远 deny
    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_read",
        url: "CHROME://settings/passwords",
      }).decision,
    ).toBe("deny");

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_snapshot",
        url: "https://vault.BITWARDEN.com./#/vault",
      }).decision,
    ).toBe("deny");

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_click",
        url: "https://ebank.icbc.com.cn/pay",
        blockedDomains: ["icbc.com.cn"],
      }).decision,
    ).toBe("deny");

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_click",
        url: "https://microsoftedge.microsoft.com/%61ddons/detail/%ZZ",
      }).decision,
    ).toBe("deny");

    // 2. 付款类操作即使在 full 档（含带空格中文按钮与大写驼峰）也必须 ask + locked
    const purchase = assessBrowserActionRisk({
      tier: "full",
      operation: "browser_click",
      url: "https://shop.example.com/checkout",
      element: { role: "button", name: "确认付款 ¥199" },
    });
    expect(purchase.decision).toBe("ask");
    expect(purchase.locked).toBe(true);
    expect(purchase.category).toBe("purchase");

    const spacedPurchase = assessBrowserActionRisk({
      tier: "full",
      operation: "browser_click",
      url: "https://shop.example.com/checkout",
      element: { role: "button", name: "付 款" },
    });
    expect(spacedPurchase.decision).toBe("ask");
    expect(spacedPurchase.locked).toBe(true);

    // 3. observe 档放行只读，拦截写操作
    expect(
      assessBrowserActionRisk({
        tier: "observe",
        operation: "browser_hover",
        url: "https://grafana.example.com",
      }).decision,
    ).toBe("allow");
    expect(
      assessBrowserActionRisk({
        tier: "observe",
        operation: "browser_click",
        url: "https://grafana.example.com",
        element: { role: "button", name: "刷新" },
      }).decision,
    ).toBe("ask");

    // 4. cautious 档放行普通点击，拦截删除/重启/提交
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_click",
        url: "https://console.example.com",
        element: { role: "tab", name: "流量图表" },
      }).decision,
    ).toBe("allow");

    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_click",
        url: "https://console.example.com",
        element: { role: "button", name: "重启服务器" },
      }).decision,
    ).toBe("ask");

    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_type",
        url: "https://console.example.com",
        element: { role: "textbox", name: "备注" },
        submit: true,
      }).decision,
    ).toBe("ask");
  });

  test("共享状态机正确维护人机礼让、恢复后强刷快照守卫、审批与急停释放", () => {
    let s = createInitialBrowserCompanionSession({
      deviceId: "dev-1",
      botName: "鲸鱼娘",
      attached: true,
      activeTabId: 10,
    });
    expect(s.state).toBe("idle");
    expect(s.debuggerAttached).toBe(false);

    s = reduceBrowserCompanionSession(s, {
      type: "tool_start",
      tabId: 10,
      tabGroupId: 50,
      tabCount: 1,
    });
    expect(s.state).toBe("controlling");
    expect(s.botControlHeld).toBe(true);
    expect(s.hudVisible).toBe(true);

    // 真人插手 -> 礼让并强制释放控制锁
    s = reduceBrowserCompanionSession(s, { type: "human_input" });
    expect(s.state).toBe("yielded_to_human");
    expect(s.botControlHeld).toBe(false);
    expect(canCompanionBotAct(s, { mutating: true }).allowed).toBe(false);

    // 恢复控制 -> 强制要求先重抓快照才能执行写操作
    s = reduceBrowserCompanionSession(s, { type: "resume" });
    expect(s.state).toBe("controlling");
    expect(s.resumeSnapshotRequired).toBe(true);
    expect(canCompanionBotAct(s, { mutating: true })).toEqual({
      allowed: false,
      reason: "snapshot_required",
    });

    // 重抓快照后允许写操作
    s = reduceBrowserCompanionSession(s, {
      type: "tool_step",
      snapshotTaken: true,
      operation: "browser_snapshot",
    });
    expect(canCompanionBotAct(s, { mutating: true })).toEqual({
      allowed: true,
    });

    // 紧急停止立即清空 CDP 与 HUD
    s = reduceBrowserCompanionSession(s, { type: "kill_switch" });
    expect(s.state).toBe("detached");
    expect(s.debuggerAttached).toBe(false);
    expect(s.hudVisible).toBe(false);
    expect(s.killSwitched).toBe(true);

    // 显式重新附着可恢复 idle
    s = reduceBrowserCompanionSession(s, { type: "attach", tabId: 10 });
    expect(s.state).toBe("idle");
    expect(s.killSwitched).toBe(false);
  });

  test("WS 客户端携带 token、响应心跳、纵深防御拦截未批准高危调用、转发 companion_command 且撤销后停止重连", async () => {
    const sockets: FakeWebSocket[] = [];
    const commands: CompanionCommandPayload[] = [];
    let callExecuted = 0;
    let revokedTriggered = false;

    const wsClient = createCompanionWsClient({
      getAuth: () => ({
        serverUrl: "https://bot.example.com:8443",
        deviceToken: "cbd_test_token_123",
        deviceId: "dev-1",
        deviceName: "Chrome 伴侣",
        enrolledAt: new Date().toISOString(),
      }),
      getClientVersion: () => "0.1.192",
      getCompanionState: () => ({
        state: "idle",
        attached: true,
        attachedTabId: 1,
        activeTabId: 1,
        tabGroupId: null,
        tabCount: 0,
        tier: "cautious",
        blockedDomains: ["bank.example.com"],
        allowRemoteDispatch: true,
      }),
      evaluateLocalRisk: (call) =>
        assessBrowserActionRisk({
          tier: "cautious",
          operation: call.operation,
          url: String(call.args.url ?? "https://console.example.com"),
          element: { role: "button", name: String(call.args.label ?? "") },
          blockedDomains: ["bank.example.com"],
        }),
      onCall: async () => {
        callExecuted += 1;
        return { ok: true };
      },
      onCompanionCommand: (cmd) => {
        commands.push(cmd);
      },
      onRevoked: () => {
        revokedTriggered = true;
      },
      createWebSocket: (url, opts) => {
        expect(url).toBe(
          buildDeviceWsUrl(
            "https://bot.example.com:8443",
            "cbd_test_token_123",
          ),
        );
        expect(opts.headers["X-Device-Token"]).toBe("cbd_test_token_123");
        const ws = new FakeWebSocket();
        sockets.push(ws);
        return ws;
      },
      heartbeatMs: 0,
      silenceMs: 0,
      backoffBaseMs: 20,
    });

    wsClient.start();
    const ws = sockets[0]!;
    ws.emit("open");
    expect(ws.sent[0]?.type).toBe("hello");
    expect(ws.sent[0]?.platform).toBe("browser_extension");

    ws.emit("message", { data: JSON.stringify({ type: "ping" }) });
    expect(ws.sent.some((m) => m.type === "pong")).toBe(true);

    // 服务端下发 companion_command
    ws.emit("message", {
      data: JSON.stringify({
        type: "companion_command",
        command: "focus_tab",
        tabId: 42,
      }),
    });
    expect(commands).toEqual([{ command: "focus_tab", tabId: 42 }]);

    // 未带 _approved 的高危调用被本地纵深防御拦截
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "call-1",
        operation: "browser_click",
        args: { url: "https://console.example.com", label: "删除集群" },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(callExecuted).toBe(0);
    const blockedRes = ws.sent.find(
      (m) => m.type === "result" && m.id === "call-1",
    );
    expect(blockedRes?.ok).toBe(false);

    // 经服务端真实审批通过后注入 _approved: true 的高危调用正常放行执行
    ws.emit("message", {
      data: JSON.stringify({
        type: "call",
        id: "call-2",
        operation: "browser_click",
        args: {
          url: "https://console.example.com",
          label: "删除集群",
          _approved: true,
        },
        botName: "鲸鱼娘",
        timeoutMs: 10000,
      }),
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(callExecuted).toBe(1);
    const approvedRes = ws.sent.find(
      (m) => m.type === "result" && m.id === "call-2",
    );
    expect(approvedRes?.ok).toBe(true);

    // 收到 revoked 立即停止并不再重连
    ws.emit("message", { data: JSON.stringify({ type: "revoked" }) });
    expect(revokedTriggered).toBe(true);
    expect(wsClient.getState().state).toBe("revoked");
    await new Promise((r) => setTimeout(r, 50));
    expect(sockets.length).toBe(1);
    wsClient.stop();
  });

  test("认证工具正确归一化地址、解析配对码与执行 Better Auth 回退登录", async () => {
    expect(normalizeServerUrl("127.0.0.1:3001/")).toBe("http://127.0.0.1:3001");
    expect(normalizeServerUrl("bot.example.com:8443")).toBe(
      "https://bot.example.com:8443",
    );
    expect(() => normalizeServerUrl("http://public.example.com")).toThrow(
      "https",
    );

    const parsedUri = parsePairingInput(
      "",
      "chisabot://pair?server=https%3A%2F%2Fbot.example.com%3A8443&code=cbp_abcdefghijklmnopqrstuvwxyz123456",
    );
    expect(parsedUri.serverUrl).toBe("https://bot.example.com:8443");
    expect(parsedUri.code).toBe("cbp_abcdefghijklmnopqrstuvwxyz123456");

    const visited: string[] = [];
    const auth = createExtensionAuth({
      chromeApi: {
        runtime: {
          getManifest: () => ({ version: "0.1.192", name: "ChisaBot" }),
        },
      } as unknown as ChromeApi,
      fetchImpl: (async (url: string | URL) => {
        const target = String(url);
        visited.push(target);
        if (target.endsWith("/auth/login")) {
          return new Response("not found", { status: 404 });
        }
        if (target.endsWith("/api/auth/sign-in/email")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (target.endsWith("/api/devices/enroll")) {
          return new Response(
            JSON.stringify({
              token: "cbd_new_ext_token",
              device: {
                id: "dev-99",
                name: "Chrome 浏览器伴侣",
                ownerUserId: "u1",
              },
            }),
            { status: 201 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    });

    const record = await auth.loginWithPassword({
      serverUrl: "https://bot.example.com:8443",
      username: "alice@example.com",
      password: "secret",
    });
    expect(visited).toEqual([
      "https://bot.example.com:8443/auth/login",
      "https://bot.example.com:8443/api/auth/sign-in/email",
      "https://bot.example.com:8443/api/devices/enroll",
    ]);
    expect(record.deviceToken).toBe("cbd_new_ext_token");
    expect(record.deviceId).toBe("dev-99");
  });
});
