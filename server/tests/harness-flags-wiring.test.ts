import { afterEach, describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import {
  DEFAULT_HARNESS_FLAGS,
  HARNESS_FLAG_DESCRIPTORS,
  type HarnessFlags,
} from "../../shared/admin-workbench";
import { setActiveHarnessFlagsReader } from "../src/admin/harness-settings";
import type { AppVariables } from "../src/auth/guards";
import { createDemonstrationStore } from "../src/computer/demonstration-store";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { createHeadlessComputerTools } from "../src/computer/headless-tools";
import {
  createPolicyStore,
  DEFAULT_ACTION_POLICY,
} from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { ComputerProvider } from "../src/computer/provider";
import { createDeviceHub, DeviceRefusedError } from "../src/devices/hub";
import type { DeviceRecord, DeviceStore } from "../src/devices/store";
import { deviceTools } from "../src/devices/tools";
import { REFUSAL_MARKER } from "../src/plugins/tools";

function setFlags(patch: Partial<HarnessFlags>) {
  setActiveHarnessFlagsReader(() => ({ ...DEFAULT_HARNESS_FLAGS, ...patch }));
}

afterEach(() => {
  setActiveHarnessFlagsReader(null);
});

describe("Harness 能力开关接线与假开关清理", () => {
  test("HARNESS_FLAG_DESCRIPTORS 仅保留已接入运行时的 5 项真开关，隐藏未实现项", () => {
    const keys = HARNESS_FLAG_DESCRIPTORS.map((d) => d.key);
    expect(keys).toEqual([
      "browserSubagent",
      "cookieImport",
      "passkeyForward",
      "desktopControl",
      "teachByDemo",
    ]);
    expect(keys).not.toContain("memoryDreaming");
    expect(keys).not.toContain("interactiveForms");
  });

  test("teachByDemo 关闭时 /demonstrations/* 路由返回中文 403，开启时放行", async () => {
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      c,
      next,
    ) => {
      c.set("actor", {
        id: "user-1",
        email: "u@chisabot.test",
        name: "User",
        role: "user",
      });
      await next();
    };
    const provider: ComputerProvider = {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://127.0.0.1:19999",
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    };
    const gateway = createComputerGateway({
      provider,
      auditStore: { insert: async () => {} },
      policy: () => DEFAULT_ACTION_POLICY,
    });
    const routes = createComputerRoutes(
      gateway,
      createPolicyStore(DEFAULT_ACTION_POLICY),
      requireUser,
      async () => true,
      undefined,
      undefined,
      undefined,
      createDemonstrationStore(),
    );

    setFlags({ teachByDemo: false });
    const deniedStart = await routes.request(
      "http://chisabot.test/bot-1/demonstrations/start",
      { method: "POST" },
    );
    expect(deniedStart.status).toBe(403);
    expect((await deniedStart.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("teachByDemo"),
    });

    const deniedStop = await routes.request(
      "http://chisabot.test/bot-1/demonstrations/11111111-1111-4111-8111-111111111111/stop",
      { method: "POST" },
    );
    expect(deniedStop.status).toBe(403);

    const deniedGet = await routes.request(
      "http://chisabot.test/bot-1/demonstrations/11111111-1111-4111-8111-111111111111",
    );
    expect(deniedGet.status).toBe(403);

    setFlags({ teachByDemo: true });
    const allowedStart = await routes.request(
      "http://chisabot.test/bot-1/demonstrations/start",
      { method: "POST" },
    );
    expect(allowedStart.status).toBe(201);
  });

  test("desktopControl 关闭时拦截桌面图形操作（hub.invoke 与 deviceTools），不影响只读系统信息", async () => {
    const device: DeviceRecord = {
      id: "dev-1",
      ownerUserId: "user-1",
      name: "Workstation",
      platform: "win32",
      osVersion: "11",
      hostname: "pc",
      arch: "x64",
      clientVersion: "0.1.90",
      tokenHash: "hash",
      capabilities: {
        files_read: "allow",
        files_write: "allow",
        shell: "allow",
        screenshot: "allow",
        input: "allow",
        open: "allow",
        clipboard: "allow",
      },
      allowedRoots: ["C:\\Work"],
      paused: false,
      revoked: false,
      lastSeenAt: new Date().toISOString(),
      lastIp: "127.0.0.1",
      createdAt: new Date().toISOString(),
      botIds: [],
      fullAccessUntil: null,
    };
    const store: DeviceStore = {
      get: async (id) => (id === device.id ? device : null),
      list: async () => [device],
      update: async () => device,
      audit: async () => "aud-1",
      finishAudit: async () => {},
      touch: async () => {},
    } as unknown as DeviceStore;

    const hub = createDeviceHub({ store });
    hub.attach(
      device,
      {
        send: () => {},
        close: () => {},
      },
      "127.0.0.1",
    );

    setFlags({ desktopControl: false });

    // hub.invoke 拦截桌面操控
    for (const op of [
      "screenshot",
      "window_screenshot",
      "input",
      "desktop_windows",
      "desktop_snapshot",
    ] as const) {
      await expect(
        hub.invoke({
          device,
          operation: op,
          args: {},
          bot: { id: "bot-1", name: "Bot" },
          summary: `test ${op}`,
        }),
      ).rejects.toBeInstanceOf(DeviceRefusedError);
    }

    // deviceTools 拦截桌面操控工具（含 device_windows）
    const tools = deviceTools({
      store,
      hub,
      botId: "bot-1",
      actorId: "user-1",
      devices: [device],
    });
    const byName = (name: string) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    };
    expect(String(await byName("device_screenshot").execute({}))).toContain(
      `${REFUSAL_MARKER} 管理员已在 Harness 开关台关闭「桌面图形操作（desktopControl）」`,
    );
    expect(
      String(
        await byName("device_input").execute({ action: "click", x: 10, y: 10 }),
      ),
    ).toContain("desktopControl");
    expect(
      String(await byName("device_windows").execute({ action: "list" })),
    ).toContain("desktopControl");
  });

  test("browserSubagent 关闭时拦截云端浏览器网关与无头浏览器工具，不影响工作区文件工具", async () => {
    const provider: ComputerProvider = {
      name: "test",
      isolation: "per-bot",
      locate: async () => "http://127.0.0.1:19999",
      status: async (botId) => ({ botId, state: "ready" }),
      list: async () => [],
      stop: async () => ({ wasRunning: false }),
      reset: async () => ({ cleared: false }),
    };
    const gateway = createComputerGateway({
      provider,
      auditStore: { insert: async () => {} },
      policy: () => DEFAULT_ACTION_POLICY,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const actor = { id: "user-1", userId: "user-1" };

    setFlags({ browserSubagent: false });

    await expect(
      gateway.navigate("bot-1", actor, "https://example.com"),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await expect(
      gateway.click("bot-1", actor, { ref: "e1", snapshotId: 1 }),
    ).rejects.toBeInstanceOf(ActionRefusedError);
    await expect(
      gateway.tabAction?.("bot-1", actor, { action: "new" }),
    ).rejects.toBeInstanceOf(ActionRefusedError);

    // 工作区文件工具不受 browserSubagent 关闭影响
    const listed = await gateway.listFiles("bot-1", actor, { path: "." });
    expect(listed).toEqual({ entries: [] });

    // 无头浏览器工具返回中文拒绝
    const headless = createHeadlessComputerTools({
      gateway,
      botId: "bot-1",
      actor,
    });
    const navTool = headless.find(
      (t) => t.definition.name === "computer_navigate",
    );
    const snapTool = headless.find(
      (t) => t.definition.name === "computer_snapshot",
    );
    const listTool = headless.find(
      (t) => t.definition.name === "computer_list_files",
    );
    expect(
      await navTool?.execute(
        { url: "https://example.com" },
        { toolCallId: "c1", signal: new AbortController().signal },
      ),
    ).toMatchObject({
      ok: false,
      refused: true,
      rule: "harness:browserSubagent",
    });
    expect(
      await snapTool?.execute(
        {},
        { toolCallId: "c2", signal: new AbortController().signal },
      ),
    ).toMatchObject({
      ok: false,
      refused: true,
      rule: "harness:browserSubagent",
    });
    expect(
      await listTool?.execute(
        { path: "." },
        { toolCallId: "c3", signal: new AbortController().signal },
      ),
    ).toMatchObject({ ok: true });
  });
});
