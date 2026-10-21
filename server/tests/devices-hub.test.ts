import { describe, expect, test } from "bun:test";
import { defaultCapabilities } from "../../shared/devices";
import { createDeviceHub, DeviceRefusedError } from "../src/devices/hub";
import type { DeviceRecord } from "../src/devices/store";
import { cleanRoots } from "../src/devices/store";

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "测试机",
    platform: "win32",
    osVersion: null,
    hostname: "PC",
    arch: "x64",
    clientVersion: "0.1.0",
    capabilities: { ...defaultCapabilities(), shell: "allow", clipboard: "ask" },
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "x",
    ...overrides,
  };
}

function fakeStore(initial: DeviceRecord) {
  let current = initial;
  const audits: Array<Record<string, unknown>> = [];
  return {
    audits,
    set(next: DeviceRecord) {
      current = next;
    },
    store: {
      get: async () => current,
      touch: async () => {},
      update: async (_id: string, patch: Record<string, unknown>) => {
        current = { ...current, ...(patch as Partial<DeviceRecord>) };
        return current;
      },
      audit: async (input: Record<string, unknown>) => {
        audits.push({ ...input });
        return String(audits.length - 1);
      },
      finishAudit: async (id: string, result: Record<string, unknown>) => {
        Object.assign(audits[Number(id)] as object, result);
      },
    },
  };
}

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: [] as number[],
    socket: {
      send: (data: string) => sent.push(JSON.parse(data)),
      close(code?: number) {
        this.closedCode = code;
      },
      closedCode: undefined as number | undefined,
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("device hub", () => {
  test("refuses offline, off and paused before sending, and audits each", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const base = { args: {}, bot: { id: "bot1", name: "主机器人" }, summary: "x" };
    await expect(hub.invoke({ ...base, device: record(), operation: "shell" })).rejects.toThrow("离线");
    await expect(hub.invoke({ ...base, device: record(), operation: "read_file" })).rejects.toThrow("关闭");
    await expect(hub.invoke({ ...base, device: record({ paused: true }), operation: "shell" })).rejects.toThrow("紧急停止");
    expect(fake.audits.map((a) => a.outcome)).toEqual(["offline", "refused", "refused"]);
  });

  test("hello with suggestedRoots asks the store to seed default folders (and touch gets no roots)", async () => {
    const fake = fakeStore(record());
    const seeded: Array<{ id: string; roots: unknown }> = [];
    const touched: Array<Record<string, unknown>> = [];
    const store = {
      ...fake.store,
      touch: async (_id: string, facts: Record<string, unknown>) => {
        touched.push(facts);
      },
      seedRoots: async (id: string, roots: unknown) => {
        seeded.push({ id, roots });
        return true;
      },
    };
    const hub = createDeviceHub({ store: store as never });
    const s = fakeSocket();
    const handlers = hub.attach(record(), s.socket, "1.2.3.4");
    await handlers.onMessage(
      JSON.stringify({ type: "hello", clientVersion: "0.1.7", suggestedRoots: ["C:\\Users\\a\\Desktop"] }),
    );
    expect(seeded).toEqual([{ id: "dev_1", roots: ["C:\\Users\\a\\Desktop"] }]);
    expect(touched.some((facts) => "suggestedRoots" in facts)).toBe(false);
  });

  test("routes a call to the connected device and returns its result", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = fakeSocket();
    const handlers = hub.attach(record(), s.socket, "1.2.3.4");
    expect(s.sent[0]?.type).toBe("welcome");
    expect(hub.isOnline("dev_1")).toBe(true);
    const pending = hub.invoke({ device: record(), operation: "shell", args: { command: "dir" }, bot: { id: "bot1", name: "B" }, summary: "运行命令：dir" });
    await tick();
    const call = s.sent.find((m) => m.type === "call") as { id: string; operation: string };
    expect(call.operation).toBe("shell");
    await handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: true, result: { stdout: "ok" } }));
    expect(await pending).toEqual({ stdout: "ok" });
    expect(fake.audits.at(-1)?.outcome).toBe("succeeded");
  });

  test("ask policy waits for approval; web approval lets it through, device denial refuses", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = fakeSocket();
    const handlers = hub.attach(record(), s.socket, null);
    const first = hub.invoke({ device: record(), operation: "clipboard_read", args: {}, bot: { id: "bot1", name: "B" }, summary: "读取剪贴板" });
    await tick();
    const [approval] = hub.listApprovals("u1");
    expect(approval?.operation).toBe("clipboard_read");
    const request = s.sent.find((m) => m.type === "approval_request") as { remainingMs?: number } | undefined;
    expect(request).toBeDefined();
    // 服务器时钟算好的剩余时间，PC 时钟不准也能正确倒数。
    expect(typeof request?.remainingMs).toBe("number");
    expect(request!.remainingMs!).toBeGreaterThan(0);
    expect(hub.decide(approval!.id, true, "web")).toBe(true);
    await tick();
    const call = s.sent.find((m) => m.type === "call") as { id: string };
    await handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: true, result: { text: "hi" } }));
    expect(await first).toEqual({ text: "hi" });

    const second = hub.invoke({ device: record(), operation: "clipboard_read", args: {}, bot: { id: "bot1", name: "B" }, summary: "读取剪贴板" });
    await tick();
    const [again] = hub.listApprovals(null);
    await handlers.onMessage(JSON.stringify({ type: "approval", id: again!.id, decision: "deny" }));
    await expect(second).rejects.toThrow("拒绝");
    expect(fake.audits.at(-1)?.outcome).toBe("denied");
  });

  test("approval expires", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never, approvalTtlMs: 30 });
    const handlers = hub.attach(record(), fakeSocket().socket, null);
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await expect(
        hub.invoke({ device: record(), operation: "clipboard_read", args: {}, bot: { id: "bot1", name: "B" }, summary: "x" }),
      ).rejects.toThrow("超时");
    } finally {
      clearTimeout(keepAlive);
      handlers.onClose();
    }
  });

  test("call timeout, device error, kill switch from PC, revoke kick", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = fakeSocket();
    const handlers = hub.attach(record(), s.socket, null);
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await expect(
        hub.invoke({ device: record(), operation: "shell", args: {}, bot: { id: "b", name: null }, summary: "x", timeoutMs: 1000 }),
      ).rejects.toThrow("没有返回");
    } finally {
      clearTimeout(keepAlive);
    }
    const failing = hub.invoke({ device: record(), operation: "shell", args: {}, bot: { id: "b", name: null }, summary: "x" });
    await tick();
    const call = s.sent.filter((m) => m.type === "call").at(-1) as { id: string };
    await handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: false, error: "boom" }));
    await expect(failing).rejects.toBeInstanceOf(DeviceRefusedError);

    const hanging = hub.invoke({ device: record(), operation: "shell", args: {}, bot: { id: "b", name: null }, summary: "x" });
    await tick();
    await handlers.onMessage(JSON.stringify({ type: "set_config", paused: true }));
    await expect(hanging).rejects.toThrow("紧急停止");
    expect(fake.audits.some((a) => a.action === "kill_switch_on")).toBe(true);

    hub.kick("dev_1");
    expect(s.sent.at(-1)?.type).toBe("revoked");
    expect(s.socket.closedCode).toBe(4401);
    expect(hub.isOnline("dev_1")).toBe(false);
  });

  test("screenshot base64 is kept server-side and replaced by a url", async () => {
    const fake = fakeStore(record({ capabilities: { ...defaultCapabilities(), screenshot: "allow" } }));
    const hub = createDeviceHub({ store: fake.store as never });
    const s = fakeSocket();
    const device = record({ capabilities: { ...defaultCapabilities(), screenshot: "allow" } });
    const handlers = hub.attach(device, s.socket, null);
    const pending = hub.invoke({ device, operation: "screenshot", args: {}, bot: { id: "b", name: null }, summary: "截图" });
    await tick();
    const call = s.sent.find((m) => m.type === "call") as { id: string };
    await handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: true, result: { format: "png", width: 2, height: 1, base64: Buffer.from("PNGDATA").toString("base64") } }));
    const result = (await pending) as { url: string; screenshotId: string; base64?: string };
    expect(result.base64).toBeUndefined();
    expect(result.url).toContain("/api/devices/dev_1/screenshots/");
    expect(hub.screenshot("dev_1", result.screenshotId)?.toString()).toBe("PNGDATA");
    expect(hub.screenshot("dev_2", result.screenshotId)).toBeNull();
  });

  test("cleanRoots keeps only absolute, unique paths", () => {
    expect(cleanRoots(["C:\\Users\\me", "c:\\users\\ME", "relative", "/home/a", "\\\\nas\\share", 5])).toEqual([
      "C:\\Users\\me",
      "/home/a",
      "\\\\nas\\share",
    ]);
  });

  test("bot full access (§97): ask capability runs without a prompt, outside folder is added; off / elevated still refused", async () => {
    const fake = fakeStore(record({ capabilities: { ...defaultCapabilities(), shell: "ask", files_write: "ask", clipboard: "off" }, allowedRoots: ["C:\\Work"] }));
    const decisions: Array<"auto" | "ask" | "full"> = [];
    let mode: "auto" | "ask" | "full" = "full";
    const confirm = {
      linkable: () => false,
      before: async () => {
        decisions.push(mode);
        return mode;
      },
      opened: async () => {},
      closed: async () => {},
    };
    const hub = createDeviceHub({ store: fake.store as never, confirm });
    const s = fakeSocket();
    const handlers = hub.attach(record(), s.socket, null);
    const device = () => record({ capabilities: { ...defaultCapabilities(), shell: "ask", files_write: "ask", clipboard: "off" }, allowedRoots: ["C:\\Work"] });
    const answer = async () => {
      await tick();
      const call = s.sent.filter((m) => m.type === "call").at(-1) as { id: string };
      await handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: true, result: { ok: 1 } }));
    };
    // 「询问」的运行命令：不弹审批，直接发给 PC。
    const run = hub.invoke({ device: device(), operation: "shell", args: { command: "npm i" }, bot: { id: "bot1", name: "B" }, summary: "运行命令：npm i" });
    await answer();
    expect(await run).toEqual({ ok: 1 });
    expect(s.sent.some((m) => m.type === "approval_request")).toBe(false);
    expect(fake.audits.at(-1)?.detail).toContain("机器人完全访问");
    // 允许的文件夹以外：先把文件夹加进去（写审计、推配置），再执行。
    const write = hub.invoke({ device: device(), operation: "write_file", args: { path: "D:\\Other\\a.txt", content: "x" }, bot: { id: "bot1", name: "B" }, summary: "写文件" });
    await answer();
    expect(await write).toEqual({ ok: 1 });
    expect(s.sent.some((m) => m.type === "approval_request")).toBe(false);
    expect(fake.audits.some((a) => a.action === "roots_added" && String(a.summary).includes("完全访问"))).toBe(true);
    expect(s.sent.some((m) => m.type === "config")).toBe(true);
    // 关闭的能力、管理员身份运行：完全访问放不开。
    await expect(hub.invoke({ device: device(), operation: "clipboard_read", args: {}, bot: { id: "bot1", name: "B" }, summary: "x" })).rejects.toThrow("关闭");
    await expect(hub.invoke({ device: device(), operation: "shell", args: { command: "x", elevated: true }, bot: { id: "bot1", name: "B" }, summary: "x" })).rejects.toThrow("管理员");
    // 请求批准：弹审批。
    mode = "ask";
    void hub.invoke({ device: device(), operation: "shell", args: { command: "dir" }, bot: { id: "bot1", name: "B" }, summary: "运行命令：dir" }).catch(() => {});
    await tick();
    expect(s.sent.some((m) => m.type === "approval_request")).toBe(true);
    for (const approval of hub.listApprovals(null)) hub.decide(approval.id, false, "web");
  });
});
