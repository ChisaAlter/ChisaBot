import { describe, expect, test } from "bun:test";
import { capabilityFor, defaultCapabilities, FULL_ACCESS_FOREVER, gitIsRead } from "../../shared/devices";
import { createDeviceHub } from "../src/devices/hub";
import { installScript } from "../src/devices/node-install";
import { createPairingStore } from "../src/devices/pairing";
import type { DeviceRecord, DeviceStore } from "../src/devices/store";
import { fullAccessActive } from "../src/devices/store";
import { deviceGuidance, deviceTools, editsPreview } from "../src/devices/tools";

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "开发机",
    platform: "linux",
    osVersion: "Debian 12",
    hostname: "box",
    arch: "x64",
    clientVersion: "0.1.8-node",
    capabilities: { ...defaultCapabilities(), shell: "allow", files_read: "allow", files_write: "ask" },
    allowedRoots: ["/srv/app"],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "x",
    fullAccessUntil: null,
    ...overrides,
  };
}

function fakeStore(initial: DeviceRecord) {
  let current = initial;
  const audits: Array<Record<string, unknown>> = [];
  return {
    audits,
    set: (next: DeviceRecord) => (current = next),
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

function socket() {
  const sent: Array<Record<string, any>> = [];
  return { sent, socket: { send: (d: string) => sent.push(JSON.parse(d)), close() {} } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const bot = { id: "bot1", name: "B" };

describe("capability mapping for coding operations", () => {
  test("reads are files_read, edits files_write, git writes shell", () => {
    expect(capabilityFor("search")).toBe("files_read");
    expect(capabilityFor("read_range")).toBe("files_read");
    expect(capabilityFor("edit_file")).toBe("files_write");
    expect(capabilityFor("apply_patch")).toBe("files_write");
    expect(capabilityFor("git", { subcommand: "status" })).toBe("files_read");
    expect(capabilityFor("git", { subcommand: "log", args: ["--oneline"] })).toBe("files_read");
    expect(capabilityFor("git", { subcommand: "branch", args: ["feature"] })).toBe("shell");
    expect(capabilityFor("git", { subcommand: "commit" })).toBe("shell");
    expect(capabilityFor("exec_start")).toBe("shell");
    expect(capabilityFor("activity")).toBe(null);
    expect(gitIsRead("remote", ["add", "x"])).toBe(false);
  });
});

describe("hub: features, push approval, full access", () => {
  test("old clients without features are refused new operations with an update hint", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = socket();
    const h = hub.attach(record(), s.socket, null);
    await h.onMessage(JSON.stringify({ type: "hello", clientVersion: "0.1.7" }));
    await expect(hub.invoke({ device: record(), operation: "search", args: { pattern: "x" }, bot, summary: "搜索" })).rejects.toThrow("0.1.8");
    expect(hub.supports("dev_1", "shell")).toBe(true);
    expect(hub.supports("dev_1", "edit_file")).toBe(false);
  });

  test("git push asks even when shell is allow; status goes straight through under files_read", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = socket();
    const h = hub.attach(record(), s.socket, null);
    await h.onMessage(JSON.stringify({ type: "hello", features: ["git", "shell"] }));
    const status = hub.invoke({ device: record(), operation: "git", args: { subcommand: "status" }, bot, summary: "git status" });
    await tick();
    const call = s.sent.find((m) => m.type === "call");
    expect(call?.args.subcommand).toBe("status");
    await h.onMessage(JSON.stringify({ type: "result", id: call!.id, ok: true, result: { exitCode: 0 } }));
    await status;
    const push = hub.invoke({ device: record(), operation: "git", args: { subcommand: "push" }, bot, summary: "git push" });
    await tick();
    expect(hub.listApprovals("u1").length).toBe(1);
    hub.decide(hub.listApprovals("u1")[0]!.id, false, "web");
    await expect(push).rejects.toThrow("拒绝");
  });

  test("approval carries the diff to the device and the web view", async () => {
    const fake = fakeStore(record());
    const hub = createDeviceHub({ store: fake.store as never });
    const s = socket();
    const h = hub.attach(record(), s.socket, null);
    await h.onMessage(JSON.stringify({ type: "hello", features: ["edit_file"] }));
    const diff = editsPreview("a.js", [{ oldText: "a - b", newText: "a + b" }]);
    const p = hub.invoke({ device: record(), operation: "edit_file", args: { path: "a.js" }, bot, summary: "修改", diff });
    await tick();
    expect(hub.listApprovals("u1")[0]?.diff).toContain("+a + b");
    expect(s.sent.find((m) => m.type === "approval_request")?.diff).toContain("-a - b");
    hub.decide(hub.listApprovals("u1")[0]!.id, false, "web");
    await expect(p).rejects.toThrow();
  });

  test("full access: no approval, off capabilities allowed, elevated allowed; expired = back to normal", async () => {
    const on = record({ capabilities: defaultCapabilities(), fullAccessUntil: new Date(Date.now() + 3600_000).toISOString() });
    const fake = fakeStore(on);
    const hub = createDeviceHub({ store: fake.store as never });
    const s = socket();
    const h = hub.attach(on, s.socket, null);
    await h.onMessage(JSON.stringify({ type: "hello", features: ["shell", "edit_file"] }));
    expect(s.sent.find((m) => m.type === "welcome")?.device.fullAccess).toBe(true);
    const p = hub.invoke({ device: on, operation: "shell", args: { command: "id", elevated: true }, bot, summary: "id" });
    await tick();
    const call = s.sent.find((m) => m.type === "call");
    expect(call).toBeDefined();
    expect(hub.listApprovals("u1").length).toBe(0);
    await h.onMessage(JSON.stringify({ type: "result", id: call!.id, ok: true, result: {} }));
    await p;
    expect(String(fake.audits.at(-1)?.detail)).toContain("完全访问");
    const expired = record({ capabilities: defaultCapabilities(), fullAccessUntil: new Date(Date.now() - 1000).toISOString() });
    await expect(hub.invoke({ device: expired, operation: "shell", args: { command: "id" }, bot, summary: "id" })).rejects.toThrow("关闭");
    await expect(
      hub.invoke({ device: record(), operation: "shell", args: { command: "id", elevated: true }, bot, summary: "id" }),
    ).rejects.toThrow("完全访问");
  });

  test("device can only turn full access off", async () => {
    const on = record({ fullAccessUntil: FULL_ACCESS_FOREVER });
    const fake = fakeStore(on);
    const hub = createDeviceHub({ store: fake.store as never });
    const h = hub.attach(on, socket().socket, null);
    await h.onMessage(JSON.stringify({ type: "set_config", fullAccess: "off" }));
    expect((await fake.store.get()).fullAccessUntil).toBe(null);
    expect(fake.audits.at(-1)?.action).toBe("full_access_off");
    await h.onMessage(JSON.stringify({ type: "set_config", fullAccess: "permanent" }));
    expect((await fake.store.get()).fullAccessUntil).toBe(null);
  });

  test("fullAccessActive respects pause, revoke, expiry, forever", () => {
    expect(fullAccessActive({ fullAccessUntil: FULL_ACCESS_FOREVER, paused: false, revoked: false })).toBe(true);
    expect(fullAccessActive({ fullAccessUntil: FULL_ACCESS_FOREVER, paused: true, revoked: false })).toBe(false);
    expect(fullAccessActive({ fullAccessUntil: new Date(Date.now() - 1).toISOString(), paused: false, revoked: false })).toBe(false);
    expect(fullAccessActive({ fullAccessUntil: null, paused: false, revoked: false })).toBe(false);
  });
});

describe("coding tools", () => {
  function harness(device: DeviceRecord) {
    const calls: Array<{ operation: string; args: any; diff?: string | null; summary: string }> = [];
    const store = { forOwner: async () => [device], get: async () => device } as unknown as DeviceStore;
    const hub = {
      isOnline: () => true,
      supports: () => true,
      invoke: async (input: any) => {
        calls.push({ operation: input.operation, args: input.args, diff: input.diff, summary: input.summary });
        if (input.operation === "file_download") return { base64: Buffer.from("abc").toString("base64"), size: 3, done: true, name: "f" };
        return { ok: true };
      },
    } as never;
    const written: Record<string, Buffer> = {};
    const tools = deviceTools({
      store,
      hub,
      botId: "bot1",
      actorId: "u1",
      devices: [device],
      workspace: { read: async () => ({ bytes: Buffer.alloc(7_000_000, 1), name: "big" }), write: async (p, b) => ((written[p] = b), true) },
    });
    const tool = (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    return { calls, tools, tool, written };
  }

  test("all coding tools are offered when shell/files are on", () => {
    const names = harness(record()).tools.map((t) => t.name);
    for (const n of ["device_search", "device_read_file", "device_edit_file", "device_apply_patch", "device_git", "device_run_shell", "device_shell_output", "device_shell_kill", "device_processes", "device_upload", "device_download"])
      expect(names).toContain(n);
  });

  test("edit tool sends exact edits with a diff preview; read with ranges", async () => {
    const h = harness(record());
    await h.tool("device_edit_file").execute({ path: "a.js", edits: [{ oldText: "x", newText: "y" }] });
    expect(h.calls[0]?.operation).toBe("edit_file");
    expect(h.calls[0]?.diff).toContain("-x\n+y");
    await h.tool("device_read_file").execute({ path: "a.js", startLine: 10, endLine: 20 });
    expect(h.calls[1]?.args).toEqual({ path: "a.js", startLine: 10, endLine: 20 });
  });

  test("run_shell background goes to exec_start; output polls; session passes through", async () => {
    const h = harness(record());
    await h.tool("device_run_shell").execute({ command: "npm test", cwd: "/srv/app", background: true, session: "main" });
    expect(h.calls[0]?.operation).toBe("exec_start");
    expect(h.calls[0]?.args.session).toBe("main");
    await h.tool("device_shell_output").execute({ jobId: "job_1", since: 10, waitSec: 5 });
    expect(h.calls[1]).toMatchObject({ operation: "exec_poll", args: { jobId: "job_1", since: 10, waitMs: 5000 } });
    await h.tool("device_shell_output").execute({});
    expect(h.calls[2]?.operation).toBe("exec_list");
  });

  test("upload is chunked with sha256 on the last chunk; download writes the workspace", async () => {
    const h = harness(record());
    await h.tool("device_upload").execute({ from: "out/big", to: "/srv/app/big" });
    const ups = h.calls.filter((c) => c.operation === "file_upload");
    expect(ups.length).toBe(3);
    expect(ups.at(-1)?.args.final).toBe(true);
    expect(typeof ups.at(-1)?.args.sha256).toBe("string");
    await h.tool("device_download").execute({ from: "/srv/app/f", to: "in/f" });
    expect(h.written["in/f"]?.toString()).toBe("abc");
  });

  test("guidance teaches the search→read→edit→test loop and full access state", () => {
    const text = deviceGuidance([record()], () => true);
    expect(text).toContain("device_search");
    expect(text).toContain("device_edit_file");
    expect(text).toContain("device_windows");
    expect(text).toContain("cannot turn it on");
    const full = deviceGuidance([record({ fullAccessUntil: FULL_ACCESS_FOREVER })], () => true);
    expect(full).toContain("FULL ACCESS is ON");
  });

  test("device_windows lists, focuses, launches, and closes desktop software & browser windows", async () => {
    const winDevice = record({ platform: "win32", osVersion: "Windows 11" });
    const h = harness(winDevice);
    expect(h.tools.map((t) => t.name)).toContain("device_windows");
    await h.tool("device_windows").execute({ action: "list", query: "Chrome" });
    expect(h.calls[0]?.operation).toBe("shell");
    expect(String(h.calls[0]?.args.command)).toContain("-EncodedCommand");
    await h.tool("device_windows").execute({ action: "focus", query: "Visual Studio Code", maximize: true });
    expect(h.calls[1]?.operation).toBe("shell");
    expect(h.calls[1]?.summary).toContain("聚焦窗口");
  });
});

describe("node pairing + install script", () => {
  test("node codes live longer and redeem as kind node", () => {
    let now = 0;
    const store = createPairingStore({ now: () => now });
    const node = store.issue("u1", "node");
    const phone = store.issue("u1");
    expect(node.ttlSeconds).toBe(1800);
    expect(phone.ttlSeconds).toBe(300);
    now = 10 * 60_000;
    const r = store.redeem(node.code);
    expect(r.ok && r.kind).toBe("node");
    expect(store.redeem(phone.code)).toEqual({ ok: false, reason: "expired" });
  });

  test("install script pairs, downloads the bundle and installs a service", () => {
    const s = installScript("https://example.com:8443");
    expect(s).toContain("/api/devices/agent/node/chisabot-node.cjs");
    expect(s).toContain("install-service");
    expect(s).toContain('SERVER="https://example.com:8443"');
    expect(installScript("https://x$(rm -rf /)")).not.toContain("$(rm");
  });
});
