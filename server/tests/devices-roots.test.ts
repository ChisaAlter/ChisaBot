import { describe, expect, test } from "bun:test";
import { defaultCapabilities } from "../../shared/devices";
import { createDeviceHub } from "../src/devices/hub";
import { insideRoot, outsideRoots } from "../src/devices/roots";
import type { DeviceRecord } from "../src/devices/store";

const ROOTS = [
  "C:\\Users\\48818\\Desktop",
  "C:\\Users\\48818\\Documents",
  "C:\\Users\\48818\\Downloads",
];

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "Ayase",
    platform: "win32",
    osVersion: null,
    hostname: "PC",
    arch: "x64",
    clientVersion: "0.1.12",
    capabilities: {
      ...defaultCapabilities(),
      files_read: "ask",
      files_write: "ask",
    },
    allowedRoots: [...ROOTS],
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("allowed folders: windows paths (server side)", () => {
  test("inside / outside with drive letters, case, slashes and Chinese names", () => {
    expect(
      insideRoot("win32", "c:\\users\\48818\\DESKTOP\\报告\\a.txt", ROOTS[0]!),
    ).toBe(true);
    expect(insideRoot("win32", "C:/Users/48818/Desktop/报告", ROOTS[0]!)).toBe(
      true,
    );
    expect(insideRoot("win32", "C:\\Users\\48818\\Desktop2", ROOTS[0]!)).toBe(
      false,
    );
    expect(insideRoot("win32", "D:\\Users\\48818\\Desktop", ROOTS[0]!)).toBe(
      false,
    );
    expect(insideRoot("win32", "C:\\AI\\x", "C:\\")).toBe(true);
    expect(insideRoot("linux", "/home/a/b", "/home/a")).toBe(true);
    expect(insideRoot("linux", "/home/A/b", "/home/a")).toBe(false);
  });

  test("outsideRoots picks the folder to add", () => {
    expect(
      outsideRoots("win32", ROOTS, "list_files", { path: "C:\\AI" }),
    ).toEqual({ path: "C:\\AI", folder: "C:\\AI", wholeDrive: false });
    expect(
      outsideRoots("win32", ROOTS, "list_files", { path: "C:/AI/" })?.folder,
    ).toBe("C:\\AI");
    expect(
      outsideRoots("win32", ROOTS, "read_file", {
        path: "C:\\AI\\笔记\\说明.md",
      })?.folder,
    ).toBe("C:\\AI\\笔记");
    expect(
      outsideRoots("win32", ROOTS, "search", { path: "D:\\code\\main.py" })
        ?.folder,
    ).toBe("D:\\code");
    expect(
      outsideRoots("win32", ROOTS, "search", { path: "D:\\code" })?.folder,
    ).toBe("D:\\code");
    expect(
      outsideRoots("win32", ROOTS, "git", {
        cwd: "D:\\repo",
        subcommand: "status",
      })?.folder,
    ).toBe("D:\\repo");
    expect(
      outsideRoots("win32", ROOTS, "list_files", { path: "C:\\" })?.wholeDrive,
    ).toBe(true);
    // 里面的、相对路径、没给路径、不是文件类操作：都不算在外面。
    expect(
      outsideRoots("win32", ROOTS, "list_files", {
        path: "c:\\users\\48818\\documents\\项目",
      }),
    ).toBeNull();
    expect(
      outsideRoots("win32", ROOTS, "read_file", { path: "报告\\a.txt" }),
    ).toBeNull();
    expect(outsideRoots("win32", ROOTS, "list_files", {})).toBeNull();
    expect(
      outsideRoots("win32", ROOTS, "shell", { command: "dir C:\\AI" }),
    ).toBeNull();
    expect(
      outsideRoots("linux", ["/home/a"], "read_file", { path: "/etc/hosts" })
        ?.folder,
    ).toBe("/etc");
    // 一个允许的文件夹都没有：绝对路径也会被加入。
    expect(
      outsideRoots("win32", [], "list_files", { path: "C:\\AI" })?.folder,
    ).toBe("C:\\AI");
  });
});

describe("allowed folders: approval adds the folder, then runs", () => {
  function harness(initial: DeviceRecord) {
    let current = initial;
    const audits: Array<Record<string, unknown>> = [];
    const store = {
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
    };
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      send: (data: string) => sent.push(JSON.parse(data)),
      close() {},
    };
    const hub = createDeviceHub({ store: store as never });
    const handlers = hub.attach(initial, socket, null);
    return { hub, handlers, sent, audits, current: () => current };
  }

  test("C:\\AI: card says it will be added; approve → roots updated + config pushed before the call", async () => {
    const h = harness(record());
    const pending = h.hub.invoke({
      device: record(),
      operation: "list_files",
      args: { path: "C:\\AI" },
      bot: { id: "b", name: "星灵" },
      summary: "列出：C:\\AI",
    });
    await tick();
    const [approval] = h.hub.listApprovals("u1");
    expect(approval?.summary).toContain("批准后会把它加入允许的文件夹");
    expect(h.hub.decide(approval!.id, true, "web")).toBe(true);
    await tick();
    expect(h.current().allowedRoots).toEqual([...ROOTS, "C:\\AI"]);
    const configIndex = h.sent.findIndex(
      (m) =>
        m.type === "config" &&
        (m.device as { allowedRoots: string[] }).allowedRoots.includes(
          "C:\\AI",
        ),
    );
    const callIndex = h.sent.findIndex((m) => m.type === "call");
    expect(configIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(configIndex);
    const call = h.sent[callIndex] as { id: string };
    await h.handlers.onMessage(
      JSON.stringify({
        type: "result",
        id: call.id,
        ok: true,
        result: { entries: [] },
      }),
    );
    expect(await pending).toEqual({ entries: [] });
    expect(
      h.audits.some(
        (a) =>
          a.action === "roots_added" && String(a.summary).includes("C:\\AI"),
      ),
    ).toBe(true);
    const main = h.audits.find((a) => a.action === "list_files");
    expect(main?.outcome).toBe("succeeded");
    expect(String(main?.detail)).toContain("已把 C:\\AI 加入允许的文件夹");
  });

  test("deny keeps the roots unchanged; capability 'allow' still asks for an outside path", async () => {
    const h = harness(
      record({
        capabilities: { ...defaultCapabilities(), files_read: "allow" },
      }),
    );
    const pending = h.hub.invoke({
      device: record({
        capabilities: { ...defaultCapabilities(), files_read: "allow" },
      }),
      operation: "read_file",
      args: { path: "D:\\资料\\a.txt" },
      bot: { id: "b", name: "B" },
      summary: "读取：D:\\资料\\a.txt",
    });
    await tick();
    const [approval] = h.hub.listApprovals("u1");
    expect(approval?.summary).toContain("D:\\资料");
    h.hub.decide(approval!.id, false, "web");
    await expect(pending).rejects.toThrow("拒绝");
    expect(h.current().allowedRoots).toEqual(ROOTS);
    expect(h.sent.some((m) => m.type === "call")).toBe(false);
  });

  test("inside path with capability 'allow' runs without approval (unchanged behaviour)", async () => {
    const caps = { ...defaultCapabilities(), files_read: "allow" as const };
    const h = harness(record({ capabilities: caps }));
    const pending = h.hub.invoke({
      device: record({ capabilities: caps }),
      operation: "read_file",
      args: { path: "C:\\Users\\48818\\Desktop\\a.txt" },
      bot: { id: "b", name: "B" },
      summary: "读取",
    });
    await tick();
    expect(h.hub.listApprovals("u1")).toEqual([]);
    const call = h.sent.find((m) => m.type === "call") as { id: string };
    await h.handlers.onMessage(
      JSON.stringify({ type: "result", id: call.id, ok: true, result: "hi" }),
    );
    expect(await pending).toBe("hi");
    expect(h.current().allowedRoots).toEqual(ROOTS);
  });

  test("capability off still refuses (no folder is added)", async () => {
    const caps = { ...defaultCapabilities(), files_read: "off" as const };
    const h = harness(record({ capabilities: caps }));
    await expect(
      h.hub.invoke({
        device: record({ capabilities: caps }),
        operation: "list_files",
        args: { path: "C:\\AI" },
        bot: { id: "b", name: "B" },
        summary: "列出",
      }),
    ).rejects.toThrow("关闭");
    expect(h.current().allowedRoots).toEqual(ROOTS);
  });
});
