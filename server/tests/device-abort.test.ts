import { describe, expect, spyOn, test } from "bun:test";
import { defaultCapabilities, type ServerToDevice } from "../../shared/devices";
import { TOOL_STOPPED_ZH, withToolAbort } from "../src/confirmations/context";
import {
  createDeviceHub,
  type DeviceConfirmLink,
  DeviceRefusedError,
  type InvokeInput,
} from "../src/devices/hub";
import type { DeviceRecord, DeviceStore } from "../src/devices/store";
import { deviceTools } from "../src/devices/tools";
import { REFUSAL_MARKER } from "../src/plugins/tools";

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "device-1",
    ownerUserId: "owner-1",
    name: "Test device",
    platform: "win32",
    osVersion: null,
    hostname: "TEST-PC",
    arch: "x64",
    clientVersion: "0.1.8",
    capabilities: { ...defaultCapabilities(), shell: "allow", clipboard: "ask" },
    allowedRoots: ["C:\\Work"],
    paused: false,
    revoked: false,
    fullAccessUntil: null,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "test-token-hash",
    ...overrides,
  };
}

function fixture(options: {
  device?: DeviceRecord;
  before?: DeviceConfirmLink["before"];
  opened?: DeviceConfirmLink["opened"];
  get?: () => Promise<DeviceRecord>;
  send?: (message: ServerToDevice) => void;
} = {}) {
  let device = options.device ?? record();
  const audits: Array<Record<string, unknown>> = [];
  const sent: ServerToDevice[] = [];
  const closed: Array<{ id: string; decision: string; by: string }> = [];
  const added: Partial<DeviceRecord>[] = [];
  const receivers = new Set<() => void>();
  const store = {
    get: options.get ?? (async () => device),
    forOwner: async () => [device],
    touch: async () => {},
    update: async (_id: string, patch: Partial<DeviceRecord>) => {
      added.push(patch);
      device = { ...device, ...patch };
      return device;
    },
    audit: async (entry: Record<string, unknown>) => {
      audits.push({ ...entry });
      return String(audits.length - 1);
    },
    finishAudit: async (id: string, result: Record<string, unknown>) => {
      Object.assign(audits[Number(id)]!, result);
    },
  };
  const hub = createDeviceHub({
    store: store as never,
    confirm: {
      linkable: () => true,
      before: options.before ?? (async () => "ask"),
      opened: options.opened ?? (async () => {}),
      closed: async (id, decision, by) => { closed.push({ id, decision, by }); },
    },
  });
  const handlers = hub.attach(device, {
    send: (text) => {
      const message = JSON.parse(text) as ServerToDevice;
      sent.push(message);
      for (const check of [...receivers]) check();
      options.send?.(message);
    },
    close: () => {},
  }, null);
  const waitFor = (type: ServerToDevice["type"], count = 1) => new Promise<void>((resolve, reject) => {
    const finish = () => {
      if (sent.filter((message) => message.type === type).length < count) return;
      clearTimeout(timer);
      receivers.delete(finish);
      resolve();
    };
    const timer = setTimeout(() => {
      receivers.delete(finish);
      reject(new Error(`Missing ${type} message ${count}`));
    }, 1000);
    receivers.add(finish);
    finish();
  });
  const invoke = (signal?: AbortSignal, overrides: Partial<InvokeInput> = {}) => hub.invoke({
    device, operation: "shell", args: { command: "dir" },
    bot: { id: "bot-1", name: "Test Bot" }, summary: "Run dir", signal, ...overrides,
  });
  const calls = () => sent.filter((message) => message.type === "call");
  const cancels = () => sent.filter((message) => message.type === "cancel");
  const answer = (id: string, result: unknown = { ok: true }) => handlers.onMessage(JSON.stringify({ type: "result", id, ok: true, result }));
  const tools = () => deviceTools({
    store: store as unknown as DeviceStore, hub, actorId: device.ownerUserId,
    botId: "bot-1", devices: [device],
  });
  return { hub, handlers, audits, sent, closed, added, waitFor, invoke, calls, cancels, answer, tools };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("device invocation cancellation", () => {
  test("an already aborted invocation sends no call and opens no approval", async () => {
    const controller = new AbortController();
    controller.abort("stopped");
    let before = 0;
    const f = fixture({ before: async () => { before++; return "ask"; } });
    try {
      await expect(f.invoke(controller.signal, { operation: "clipboard_read", args: {} })).rejects.toThrow(TOOL_STOPPED_ZH);
      expect(f.calls()).toHaveLength(0);
      expect(f.sent.some((message) => message.type === "approval_request")).toBe(false);
      expect(f.hub.listApprovals(null)).toHaveLength(0);
      expect(f.audits).toMatchObject([{ action: "clipboard_read", outcome: "cancelled" }]);
      expect(before).toBe(0);
    } finally { f.handlers.onClose(); }
  });

  test("abort while awaiting permission preference never opens an approval or sends a call", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const preference = Promise.withResolvers<"ask">();
    const f = fixture({ before: async () => { entered.resolve(); return preference.promise; } });
    try {
      const pending = f.invoke(controller.signal, { operation: "clipboard_read", args: {} });
      await entered.promise;
      controller.abort();
      preference.resolve("ask");
      await expect(pending).rejects.toThrow(TOOL_STOPPED_ZH);
      expect(f.calls()).toHaveLength(0);
      expect(f.sent.some((message) => message.type === "approval_request")).toBe(false);
      expect(f.audits[0]?.outcome).toBe("cancelled");
    } finally { f.handlers.onClose(); }
  });

  test("abort closes only its own approval, including a chat card still being created", async () => {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const inserting = Promise.withResolvers<void>();
    let first = true;
    const f = fixture({ opened: async () => {
      if (first) { first = false; await inserting.promise; }
    } });
    const stopped = f.invoke(controller.signal, { operation: "clipboard_read", args: {}, summary: "first" });
    const rejected = stopped.catch((error) => error);
    const other = f.invoke(undefined, { operation: "clipboard_read", args: {}, summary: "second" });
    try {
      await f.waitFor("approval_request", 2);
      const firstApproval = f.hub.listApprovals(null).find((approval) => approval.summary === "first")!;
      const secondApproval = f.hub.listApprovals(null).find((approval) => approval.summary === "second")!;
      controller.abort();
      expect(await rejected).toBeInstanceOf(DeviceRefusedError);
      expect(f.hub.listApprovals(null).map((approval) => approval.id)).toEqual([secondApproval.id]);
      expect(f.sent.filter((message) => message.type === "approval_closed")).toEqual([
        { type: "approval_closed", id: firstApproval.id, decision: "deny" },
      ]);
      expect(f.closed.some((entry) => entry.id === firstApproval.id)).toBe(false);
      inserting.resolve();
      await tick();
      expect(f.closed).toContainEqual({ id: firstApproval.id, decision: "deny", by: "aborted" });
      expect(remove).toHaveBeenCalled();
      expect(f.hub.decide(firstApproval.id, true, "web")).toBe(false);
      expect(f.calls()).toHaveLength(0);
      expect(f.hub.decide(secondApproval.id, true, "web")).toBe(true);
      await f.waitFor("call");
      await f.answer(f.calls()[0]!.id, { text: "other call finished" });
      expect(await other).toEqual({ text: "other call finished" });
      expect(f.audits.filter((audit) => audit.action === "clipboard_read").map((audit) => audit.outcome)).toEqual(["cancelled", "succeeded"]);
    } finally { inserting.resolve(); remove.mockRestore(); f.handlers.onClose(); }
  });

  test("approval followed immediately by abort sends no call", async () => {
    const controller = new AbortController();
    const f = fixture();
    try {
      const pending = f.invoke(controller.signal, { operation: "clipboard_read", args: {} });
      await f.waitFor("approval_request");
      const [approval] = f.hub.listApprovals(null);
      expect(f.hub.decide(approval!.id, true, "web")).toBe(true);
      controller.abort();
      await expect(pending).rejects.toThrow(TOOL_STOPPED_ZH);
      expect(f.calls()).toHaveLength(0);
      expect(f.audits[0]?.outcome).toBe("cancelled");
    } finally { f.handlers.onClose(); }
  });

  test("abort during post-approval config refresh prevents the call and adding outside roots", async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const fresh = Promise.withResolvers<DeviceRecord>();
    const f = fixture({ get: async () => { reading.resolve(); return fresh.promise; } });
    try {
      const pending = f.invoke(controller.signal, {
        operation: "write_file", args: { path: "D:\\Outside\\file.txt", content: "x" },
        device: record({ capabilities: { ...defaultCapabilities(), files_write: "ask" } }),
      });
      await f.waitFor("approval_request");
      f.hub.decide(f.hub.listApprovals(null)[0]!.id, true, "web");
      await reading.promise;
      controller.abort();
      fresh.resolve(record());
      await expect(pending).rejects.toThrow(TOOL_STOPPED_ZH);
      expect(f.added).toHaveLength(0);
      expect(f.calls()).toHaveLength(0);
      expect(f.audits[0]?.outcome).toBe("cancelled");
    } finally { fresh.resolve(record()); f.handlers.onClose(); }
  });

  test("running abort cancels the exact call, ignores its late result, and leaves concurrent work running", async () => {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const f = fixture();
    const first = f.invoke(controller.signal, { summary: "cancel me", timeoutMs: 1000 });
    const failure = first.catch((error) => error);
    const second = f.invoke(undefined, { summary: "keep running" });
    try {
      await f.waitFor("call", 2);
      const [stopped, active] = f.calls();
      controller.abort("user stopped this run");
      expect(await failure).toBeInstanceOf(DeviceRefusedError);
      expect(f.cancels()).toEqual([{ type: "cancel", id: stopped!.id }]);
      expect(remove).toHaveBeenCalled();
      await f.answer(stopped!.id, { stdout: "late success" });
      expect(f.audits[0]?.outcome).toBe("cancelled");
      expect(f.audits[1]?.outcome).toBe("requested");
      await f.answer(active!.id, { stdout: "kept running" });
      expect(await second).toEqual({ stdout: "kept running" });
      expect(f.audits.map((audit) => audit.outcome)).toEqual(["cancelled", "succeeded"]);
      // The cancelled call's old timeout must not send another cancel later.
      await new Promise<void>((resolve) => setTimeout(resolve, 1050));
      expect(f.cancels()).toHaveLength(1);
    } finally { remove.mockRestore(); f.handlers.onClose(); }
  });

  test("abort racing a synchronous device response never returns a late success", async () => {
    const controller = new AbortController();
    const f = fixture();
    try {
      const pending = f.invoke(controller.signal);
      await f.waitFor("call");
      const response = f.answer(f.calls()[0]!.id, { stdout: "response" });
      controller.abort();
      await response;
      await expect(pending).rejects.toThrow(TOOL_STOPPED_ZH);
      expect(f.audits[0]?.outcome).toBe("cancelled");
    } finally { f.handlers.onClose(); }
  });

  test.each(["success", "device error", "disconnect", "send failure", "timeout"] as const)("%s releases its abort listener before a later abort", async (ending) => {
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const f = fixture({ send: (message) => {
      if (ending === "send failure" && message.type === "call") throw new Error("socket closed");
    } });
    const pending = f.invoke(controller.signal, { timeoutMs: 1000 });
    const settled = pending.catch((error) => error);
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await f.waitFor("call");
      const call = f.calls()[0]!;
      if (ending === "success") await f.answer(call.id);
      if (ending === "device error") await f.handlers.onMessage(JSON.stringify({ type: "result", id: call.id, ok: false, error: "failed" }));
      if (ending === "disconnect") f.handlers.onClose();
      await settled;
      expect(remove).toHaveBeenCalled();
      const before = f.cancels().length;
      controller.abort();
      expect(f.cancels()).toHaveLength(before);
      expect(f.audits[0]?.outcome).toBe(ending === "success" ? "succeeded" : ending === "timeout" ? "timeout" : "failed");
    } finally { clearTimeout(keepAlive); remove.mockRestore(); f.handlers.onClose(); }
  });

  test("full access continues to skip prompts and hard capability refusals remain intact", async () => {
    const f = fixture({ device: record({ fullAccessUntil: "9999-12-31T23:59:59.999Z", capabilities: defaultCapabilities() }) });
    try {
      const pending = f.invoke(undefined, { args: { command: "dir", elevated: true } });
      await f.waitFor("call");
      expect(f.hub.listApprovals(null)).toHaveLength(0);
      expect(f.sent.some((message) => message.type === "approval_request")).toBe(false);
      await f.answer(f.calls()[0]!.id);
      expect(await pending).toEqual({ ok: true });
      expect(f.audits[0]?.detail).toContain("完全访问");
    } finally { f.handlers.onClose(); }
    const ask = fixture();
    try {
      await expect(ask.invoke(undefined, { args: { command: "dir", elevated: true } })).rejects.toThrow("管理员");
      await expect(ask.invoke(undefined, { operation: "write_file", args: {} })).rejects.toThrow("关闭");
      expect(ask.calls()).toHaveLength(0);
    } finally { ask.handlers.onClose(); }
  });
});

describe("device tool ALS cancellation", () => {
  test("raw propagates actual currentToolAbort through hub and cancels the device call", async () => {
    const controller = new AbortController();
    const f = fixture();
    try {
      const shell = f.tools().find((tool) => tool.name === "device_run_shell")!;
      const pending = withToolAbort(controller.signal, () => shell.execute({ command: "dir" }));
      await f.waitFor("call");
      controller.abort();
      expect(await pending).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);
      expect(f.cancels()).toEqual([{ type: "cancel", id: f.calls()[0]!.id }]);
      expect(f.audits[0]?.outcome).toBe("cancelled");
    } finally { f.handlers.onClose(); }
  });

  test("an already stopped tool never resolves a device or opens approval", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    try {
      const clipboard = f.tools().find((tool) => tool.name === "device_clipboard")!;
      expect(await withToolAbort(controller.signal, () => clipboard.execute({ action: "read" }))).toBe(`${REFUSAL_MARKER} ${TOOL_STOPPED_ZH}`);
      expect(f.calls()).toHaveLength(0);
      expect(f.hub.listApprovals(null)).toHaveLength(0);
      expect(f.audits).toHaveLength(0);
    } finally { f.handlers.onClose(); }
  });
});
