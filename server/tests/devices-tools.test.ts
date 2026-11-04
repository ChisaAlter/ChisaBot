import { describe, expect, test } from "bun:test";
import { defaultCapabilities } from "../../shared/devices";
import type { DeviceHub } from "../src/devices/hub";
import type { DeviceRecord, DeviceStore } from "../src/devices/store";
import { agoText, deviceGuidance, deviceTools, resolveDevice } from "../src/devices/tools";
import { toolCarriedGuidance } from "../src/plugins/tools";

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "书房电脑",
    platform: "win32",
    osVersion: null,
    hostname: "STUDY",
    arch: "x64",
    clientVersion: "0.1.0",
    capabilities: { ...defaultCapabilities(), clipboard: "allow" },
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    // 旧的按机器人授权：空列表也不影响使用。
    botIds: [],
    lastUsedBy: null,
    tokenHash: "x",
    ...overrides,
  };
}

function harness(devices: DeviceRecord[], online: string[]) {
  const calls: Array<{ deviceId: string; botId: string; operation: string }> = [];
  const store = {
    get: async (id: string) => devices.find((device) => device.id === id) ?? null,
    forOwner: async (owner: string) => devices.filter((device) => device.ownerUserId === owner && !device.revoked),
  } as unknown as DeviceStore;
  const hub = {
    isOnline: (id: string) => online.includes(id),
    invoke: async (input: { device: DeviceRecord; operation: string; bot: { id: string } }) => {
      calls.push({ deviceId: input.device.id, botId: input.bot.id, operation: input.operation });
      return { ok: true, device: input.device.id };
    },
  } as unknown as DeviceHub;
  const toolsFor = (botId: string, actorId = "u1") =>
    deviceTools({ store, hub, botId, actorId, devices: devices.filter((d) => online.includes(d.id)) });
  return { calls, store, hub, toolsFor };
}

describe("device tools are shared by every bot of the owner", () => {
  test("two different bots get the same device and can both use it", async () => {
    const { calls, toolsFor } = harness([record()], ["dev_1"]);
    for (const botId of ["bot-a", "bot-b"]) {
      const tools = toolsFor(botId);
      expect(tools.map((tool) => tool.name)).toContain("device_clipboard");
      const list = JSON.parse(String(await tools[0]!.execute({})));
      expect(list.devices.map((d: { deviceId: string }) => d.deviceId)).toEqual(["dev_1"]);
      // 只有一台在线：deviceId 可以省略。
      await tools.find((tool) => tool.name === "device_clipboard")!.execute({ action: "read" });
    }
    expect(calls).toEqual([
      { deviceId: "dev_1", botId: "bot-a", operation: "clipboard_read" },
      { deviceId: "dev_1", botId: "bot-b", operation: "clipboard_read" },
    ]);
  });

  test("capabilities stay off by default: no shell tool when shell is off", () => {
    const { toolsFor } = harness([record()], ["dev_1"]);
    expect(toolsFor("bot-a").map((tool) => tool.name)).not.toContain("device_run_shell");
  });

  test("a selector is required when several devices are online, and may be a name", async () => {
    const devices = [record(), record({ id: "dev_2", name: "笔记本", hostname: "LAPTOP" })];
    const { store } = harness(devices, ["dev_1", "dev_2"]);
    const online = (id: string) => id === "dev_1" || id === "dev_2";
    expect(await resolveDevice(store, "u1", undefined, online)).toContain("2 台设备在线");
    expect(((await resolveDevice(store, "u1", "笔记本", online)) as DeviceRecord).id).toBe("dev_2");
    expect(((await resolveDevice(store, "u1", "study", online)) as DeviceRecord).id).toBe("dev_1");
    expect(((await resolveDevice(store, "u1", "dev_1", online)) as DeviceRecord).id).toBe("dev_1");
  });

  test("another person's device is never reachable", async () => {
    const { store } = harness([record({ ownerUserId: "u2" })], ["dev_1"]);
    expect(typeof (await resolveDevice(store, "u1", "dev_1", () => true))).toBe("string");
  });
});

describe("the bot knows whether the person's computer is linked and online (2026-10-13)", () => {
  const all = (devices: DeviceRecord[], online: string[]) => {
    const { store, hub } = harness(devices, online);
    return (botId = "bot-a") => deviceTools({ store, hub, botId, actorId: "u1", devices });
  };

  test("no linked device: no tools and nothing said", () => {
    expect(all([], [])()).toEqual([]);
    expect(deviceGuidance([], () => false)).toBe("");
  });

  test("linked but offline: only the read-only device_list, with guidance saying it is offline", async () => {
    const seen = new Date(Date.now() - 15 * 3600_000).toISOString();
    const tools = all([record({ lastSeenAt: seen })], [])();
    expect(tools.map((tool) => tool.name)).toEqual(["device_list"]);
    const guidance = toolCarriedGuidance(tools).join("\n");
    expect(guidance).toContain("书房电脑");
    expect(guidance).toContain("offline");
    expect(guidance).toContain("约 15 小时前");
    expect(guidance).toContain("ChisaBot desktop app");
    const list = JSON.parse(String(await tools[0]!.execute({})));
    expect(list.devices[0]).toMatchObject({ deviceId: "dev_1", online: false, lastSeen: "约 15 小时前" });
  });

  test("online: guidance says yes, names the enabled capabilities, and tells the bot not to deny it", () => {
    const tools = all([record()], ["dev_1"])();
    expect(tools.map((tool) => tool.name)).toContain("device_system_info");
    const guidance = toolCarriedGuidance(tools);
    // 只挂一次（在 device_list 上），不会在提示词里重复。
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toContain("ONLINE now");
    expect(guidance[0]).toContain("剪贴板");
    expect(guidance[0]).toContain("Never claim you only have an isolated browser");
  });

  test("online with every capability off: still told it is online, and how to turn capabilities on", () => {
    const tools = all([record({ capabilities: defaultCapabilities() })], ["dev_1"])();
    expect(tools.map((tool) => tool.name)).toEqual(["device_list", "device_system_info"]);
    const [guidance] = toolCarriedGuidance(tools);
    expect(guidance).toContain("none yet");
    expect(guidance).toContain("设置 → 设备");
  });

  test("operation tools only reflect online devices", () => {
    const devices = [record({ capabilities: defaultCapabilities() }), record({ id: "dev_2", name: "旧电脑", capabilities: { ...defaultCapabilities(), shell: "allow" } })];
    const names = all(devices, ["dev_1"])().map((tool) => tool.name);
    expect(names).not.toContain("device_run_shell");
  });

  test("agoText", () => {
    const now = Date.parse("2026-10-13T02:00:00Z");
    expect(agoText(null, now)).toBe("从未连接过");
    expect(agoText("2026-10-13T01:57:00Z", now)).toBe("3 分钟前");
    expect(agoText("2026-10-12T10:08:00Z", now)).toBe("约 16 小时前");
    expect(agoText("2026-10-09T02:00:00Z", now)).toBe("4 天前");
  });
});

