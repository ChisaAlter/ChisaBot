import { describe, expect, test } from "bun:test";
import {
  type AXNode,
  createCdpDriver,
  cutAtCodeUnits,
  parseAXTreeNodes,
  parseKeyChord,
  StaleSnapshotError,
} from "../src/background/cdp-driver";
import type { ChromeApi, ChromeDebuggee } from "../src/types/chrome";

function createFakeChrome(options?: { failScreenshot?: boolean }) {
  const attached: number[] = [];
  const detached: number[] = [];
  const commands: Array<{
    tabId: number;
    method: string;
    params?: Record<string, unknown>;
  }> = [];
  const detachListeners: Array<(src: ChromeDebuggee, reason: string) => void> =
    [];

  const sampleNodes: AXNode[] = [
    {
      nodeId: "root",
      role: { value: "RootWebArea" },
      name: { value: "控制台" },
      childIds: ["n1", "n2", "n3", "n4", "n5", "n6"],
    },
    {
      nodeId: "n1",
      ignored: true,
      role: { value: "button" },
      name: { value: "隐藏按钮" },
      backendDOMNodeId: 100,
    },
    {
      nodeId: "n2",
      role: { value: "generic" },
      name: { value: "普通容器" },
      backendDOMNodeId: 101,
    },
    {
      nodeId: "n3",
      role: { value: "button" },
      name: { value: "刷新监控" },
      backendDOMNodeId: 201,
    },
    {
      nodeId: "n4",
      role: { value: "textbox" },
      name: { value: "搜索主机" },
      value: { value: "prod-01" },
      backendDOMNodeId: 202,
    },
    {
      nodeId: "n5",
      role: { value: "checkbox" },
      name: { value: "自动刷新" },
      properties: [{ name: "checked", value: { value: "false" } }],
      backendDOMNodeId: 203,
    },
    {
      nodeId: "n6",
      role: { value: "combobox" },
      name: { value: "区域" },
      backendDOMNodeId: 204,
      childIds: ["opt1", "opt2"],
    },
    {
      nodeId: "opt1",
      role: { value: "option" },
      name: { value: "华东一区" },
      properties: [{ name: "selected", value: { value: true } }],
    },
    {
      nodeId: "opt2",
      role: { value: "option" },
      name: { value: "新加坡" },
    },
  ];

  const chromeApi = {
    tabs: {
      get: async (tabId: number) => ({
        id: tabId,
        windowId: 1,
        index: 0,
        active: true,
        groupId: -1,
        status: "complete" as const,
        url: "https://console.example.com/metrics",
        title: "服务器监控台",
      }),
    },
    debugger: {
      attach: async (target: ChromeDebuggee) => {
        if (typeof target.tabId === "number") attached.push(target.tabId);
      },
      detach: async (target: ChromeDebuggee) => {
        if (typeof target.tabId === "number") detached.push(target.tabId);
      },
      sendCommand: async (
        target: ChromeDebuggee,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        const tabId = target.tabId ?? 0;
        commands.push({ tabId, method, params });
        if (method === "Accessibility.getFullAXTree") {
          return { nodes: sampleNodes };
        }
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                url: "https://console.example.com/metrics",
                title: "服务器监控台",
                text: "CPU 使用率 28%\n内存 4.2GB / 16GB",
              },
            },
          };
        }
        if (method === "DOM.getBoxModel") {
          return {
            model: {
              border: [100, 200, 200, 200, 200, 240, 100, 240],
            },
          };
        }
        if (method === "DOM.resolveNode") {
          return { object: { objectId: "obj-1" } };
        }
        if (method === "Runtime.callFunctionOn") {
          return { result: { value: { isSelect: false, matched: false } } };
        }
        if (method === "Page.getLayoutMetrics") {
          return {
            visualViewport: { clientWidth: 1280, clientHeight: 800 },
          };
        }
        if (method === "Page.captureScreenshot") {
          if (options?.failScreenshot) {
            throw new Error("capture failed");
          }
          return { data: "ZmFrZS1qcGVn" };
        }
        return {};
      },
      onDetach: {
        addListener: (cb: (src: ChromeDebuggee, reason: string) => void) => {
          detachListeners.push(cb);
        },
        removeListener: (cb: (src: ChromeDebuggee, reason: string) => void) => {
          const idx = detachListeners.indexOf(cb);
          if (idx >= 0) detachListeners.splice(idx, 1);
        },
      },
    },
  } as unknown as ChromeApi;

  return {
    chromeApi,
    attached,
    detached,
    commands,
    triggerExternalDetach: (tabId: number, reason: string) => {
      for (const cb of detachListeners) cb({ tabId }, reason);
    },
  };
}

describe("CDP AXTree 快照解析与按需调试驱动", () => {
  test("parseAXTreeNodes 过滤非交互节点、折叠下拉框选项并保留 backendDOMNodeId 映射", () => {
    const nodes: AXNode[] = [
      {
        nodeId: "0",
        role: { value: "RootWebArea" },
        childIds: ["1", "2", "3", "4"],
      },
      {
        nodeId: "1",
        ignored: true,
        role: { value: "button" },
        name: { value: "不可见按钮" },
        backendDOMNodeId: 10,
      },
      {
        nodeId: "2",
        role: { value: "button" },
        name: { value: "立即部署" },
        backendDOMNodeId: 11,
      },
      {
        nodeId: "3",
        role: { value: "switch" },
        name: { value: "开启告警" },
        backendDOMNodeId: 12,
      },
      {
        nodeId: "4",
        role: { value: "combobox" },
        name: { value: "地区" },
        backendDOMNodeId: 13,
        childIds: ["4-a", "4-b"],
      },
      {
        nodeId: "4-a",
        role: { value: "option" },
        name: { value: "东京" },
        properties: [{ name: "selected", value: { value: true } }],
      },
      {
        nodeId: "4-b",
        role: { value: "option" },
        name: { value: "法兰克福" },
      },
    ];

    const parsed = parseAXTreeNodes(nodes);
    expect(parsed.truncated).toBe(false);
    expect(parsed.elements).toEqual([
      { ref: "e1", role: "button", name: "立即部署" },
      { ref: "e2", role: "switch", name: "开启告警", checked: false },
      {
        ref: "e3",
        role: "combobox",
        name: "地区",
        value: "东京",
        options: ["东京", "法兰克福"],
      },
    ]);
    expect(parsed.entries.get("e1")?.backendDOMNodeId).toBe(11);
    expect(parsed.entries.get("e3")?.backendDOMNodeId).toBe(13);
  });

  test("parseAXTreeNodes 遵守 200 元素上限并置 truncated=true", () => {
    const children: AXNode[] = [];
    const childIds: string[] = [];
    for (let i = 1; i <= 215; i += 1) {
      const id = `b-${i}`;
      childIds.push(id);
      children.push({
        nodeId: id,
        role: { value: "button" },
        name: { value: `按钮 ${i}` },
        backendDOMNodeId: 1000 + i,
      });
    }
    const parsed = parseAXTreeNodes([
      { nodeId: "root", role: { value: "RootWebArea" }, childIds },
      ...children,
    ]);
    expect(parsed.elements.length).toBe(200);
    expect(parsed.truncated).toBe(true);
  });

  test("cutAtCodeUnits 不截断 UTF-16 高代理对", () => {
    const emojiText = "A😀B";
    expect(cutAtCodeUnits(emojiText, 2)).toBe("A");
    expect(cutAtCodeUnits(emojiText, 3)).toBe("A😀");
  });

  test("按需 attach、拒绝过期 snapshotId、悬停发真实 mouseMoved、type 不回显明文", async () => {
    const fake = createFakeChrome();
    const syntheticCalls: number[] = [];
    const driver = createCdpDriver({
      chromeApi: fake.chromeApi,
      idleDetachMs: 0,
      sleep: async () => {},
      onBeforeSyntheticInput: async (tabId) => {
        syntheticCalls.push(tabId);
      },
    });

    // 纯初始化绝不挂 debugger
    expect(fake.attached).toEqual([]);
    expect(driver.isAttached(7)).toBe(false);

    const snap1 = await driver.snapshot(7);
    expect(fake.attached).toEqual([7]);
    expect(snap1.snapshotId).toBe(1);
    expect(snap1.elements.length).toBe(4);
    expect(driver.lookupElement(7, 1, "e1")?.name).toBe("刷新监控");

    // 悬停发两段 mouseMoved（可触发 ECharts / Canvas Tooltip）
    await driver.hover(7, snap1.snapshotId, "e1");
    const moves = fake.commands.filter(
      (c) =>
        c.method === "Input.dispatchMouseEvent" &&
        c.params?.type === "mouseMoved",
    );
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(syntheticCalls).toContain(7);

    // 输入敏感文本不回显明文
    const typeRes = await driver.type(
      7,
      snap1.snapshotId,
      "e2",
      "SuperSecret123",
      true,
    );
    expect(typeRes.characters).toBe(14);
    expect(typeRes.submitted).toBe(true);
    expect(JSON.stringify(typeRes)).not.toContain("SuperSecret123");

    // 获取新快照后，旧 snapshotId 必须被拒绝
    const snap2 = await driver.snapshot(7);
    expect(snap2.snapshotId).toBe(2);
    await expect(
      driver.click(7, snap1.snapshotId, "e1"),
    ).rejects.toBeInstanceOf(StaleSnapshotError);

    // 新快照可正常点击
    const clickRes = await driver.click(7, snap2.snapshotId, "e1");
    expect(clickRes.action).toBe("click");
    expect(clickRes.element?.name).toBe("刷新监控");

    driver.dispose();
  });

  test("screenshot 严格按「隐藏 HUD -> 截图(jpeg 78) -> 恢复 HUD」时序执行，异常也不漏恢复", async () => {
    const timeline: string[] = [];
    const fake = createFakeChrome();
    const driver = createCdpDriver({
      chromeApi: fake.chromeApi,
      idleDetachMs: 0,
      sleep: async () => {},
      onBeforeScreenshot: async () => {
        timeline.push("hide");
      },
      onAfterScreenshot: async () => {
        timeline.push("restore");
      },
    });

    const shot = await driver.screenshot(9);
    expect(shot.mimeType).toBe("image/jpeg");
    expect(shot.base64).toBe("ZmFrZS1qcGVn");
    expect(timeline).toEqual(["hide", "restore"]);
    const capCmd = fake.commands.find(
      (c) => c.method === "Page.captureScreenshot",
    );
    expect(capCmd?.params).toEqual({ format: "jpeg", quality: 78 });
    driver.dispose();

    // 失败路径也必须在 finally 中恢复 HUD
    const failTimeline: string[] = [];
    const failFake = createFakeChrome({ failScreenshot: true });
    const failDriver = createCdpDriver({
      chromeApi: failFake.chromeApi,
      idleDetachMs: 0,
      sleep: async () => {},
      onBeforeScreenshot: async () => {
        failTimeline.push("hide");
      },
      onAfterScreenshot: async () => {
        failTimeline.push("restore");
      },
    });

    await expect(failDriver.screenshot(9)).rejects.toThrow("capture failed");
    expect(failTimeline).toEqual(["hide", "restore"]);
    failDriver.dispose();
  });

  test("用户点击 Chrome 顶栏「取消」触发 onDetach 时清理映射并回调", async () => {
    const fake = createFakeChrome();
    const detachedEvents: Array<{ tabId: number; reason: string }> = [];
    const driver = createCdpDriver({
      chromeApi: fake.chromeApi,
      idleDetachMs: 0,
      sleep: async () => {},
      onExternalDetach: (tabId, reason) => {
        detachedEvents.push({ tabId, reason });
      },
    });

    const snap = await driver.snapshot(12);
    expect(driver.isAttached(12)).toBe(true);

    fake.triggerExternalDetach(12, "canceled_by_user");
    expect(driver.isAttached(12)).toBe(false);
    expect(detachedEvents).toEqual([{ tabId: 12, reason: "canceled_by_user" }]);
    expect(driver.lookupElement(12, snap.snapshotId, "e1")).toBeNull();
    driver.dispose();
  });

  test("parseKeyChord 正确解析组合键与命名键", () => {
    const ctrlA = parseKeyChord("Control+a");
    expect(ctrlA.modifiers).toBe(2);
    expect(ctrlA.def.code).toBe("KeyA");

    const enter = parseKeyChord("Enter");
    expect(enter.modifiers).toBe(0);
    expect(enter.def.windowsVirtualKeyCode).toBe(13);
  });
});
