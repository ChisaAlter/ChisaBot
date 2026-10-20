import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import type { PcLocalState } from "@/lib/pc-bridge";
import { type DeviceView, defaultCapabilities } from "../../shared/devices";

/**
 * 设备页顶部的「连接状态」卡（2026-10-13，用户：「我安装了 Windows 端，但是 bot 还是识别不到我的电脑」）。
 * 要一眼说清：有没有在线的电脑、能力是不是全关着；在 PC 客户端里没登记时给「登记这台电脑」。
 */

const real = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...real,
  Link: ({ children, ...props }: { children?: React.ReactNode }) => (
    <a {...(props as object)}>{children}</a>
  ),
  useNavigate: () => () => {},
}));

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});
afterEach(() => {
  cleanup();
  delete (window as { chisabotPC?: unknown }).chisabotPC;
});
// 2026-10-20 清基线：这个文件以前注册了就留着，后面的文件撞「already been globally registered」。
afterAll(() => {
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: "dev_1",
    ownerUserId: "u1",
    name: "Ayase",
    platform: "win32",
    osVersion: "Windows 11 Pro",
    hostname: "AYASE",
    arch: "x64",
    clientVersion: "0.1.0",
    capabilities: defaultCapabilities(),
    allowedRoots: [],
    paused: false,
    revoked: false,
    lastSeenAt: null,
    lastIp: null,
    createdAt: new Date().toISOString(),
    botIds: [],
    lastUsedBy: null,
    online: false,
    ...overrides,
  };
}

function local(overrides: Partial<PcLocalState> = {}): PcLocalState {
  return {
    version: "0.1.1",
    platform: "win32",
    hostname: "AYASE",
    serverUrl: "https://chat.example.com",
    deviceId: "",
    agentState: "offline",
    statusText: "已登录，但这台电脑还没登记为设备",
    enrolled: false,
    needsEnroll: true,
    tokenProtected: true,
    localPaused: false,
    forceLocalApproval: true,
    autoStart: false,
    startHidden: false,
    ...overrides,
  };
}

const { ConnectionCard } = await import("@/components/devices/devices");

test("all linked computers offline: says the bots cannot use it and what to do", () => {
  const view = render(
    <ConnectionCard devices={[device()]} local={null} onLocal={() => {}} />,
  );
  expect(view.getByText("没有在线设备")).toBeTruthy();
  expect(view.container.textContent).toContain(
    "都不在线，机器人现在用不了你的电脑",
  );
  expect(view.container.textContent).toContain("ChisaBot PC");
});

test("online with every capability off: says so and links to permissions", () => {
  const view = render(
    <ConnectionCard
      devices={[device({ online: true })]}
      local={null}
      onLocal={() => {}}
    />,
  );
  expect(view.getByText("1 台在线")).toBeTruthy();
  expect(view.container.textContent).toContain(
    "「Ayase」在线：你的所有机器人都能使用",
  );
  expect(view.getByText("能力全部关闭")).toBeTruthy();
  expect(view.getByText("打开权限")).toBeTruthy();
});

test("in the PC client, logged in but not enrolled: offers 登记这台电脑 and calls the bridge", async () => {
  const calls: string[] = [];
  const next = local({
    enrolled: true,
    needsEnroll: false,
    agentState: "online",
    deviceId: "dev_2",
    statusText: "在线",
  });
  (window as { chisabotPC?: unknown }).chisabotPC = {
    state: async () => local(),
    setLocal: async () => local(),
    pickFolders: async () => [],
    logout: async () => true,
    onChange: () => () => {},
    enroll: async () => {
      calls.push("enroll");
      return {
        status: "enrolled",
        message: "已登记为设备「AYASE」。",
        state: next,
      };
    },
  };
  const updates: PcLocalState[] = [];
  const view = render(
    <ConnectionCard
      devices={[device()]}
      local={local()}
      onLocal={(state) => updates.push(state)}
    />,
  );
  expect(view.container.textContent).toContain(
    "已登录，但这台电脑还没登记为设备",
  );
  fireEvent.click(view.getByText("登记这台电脑"));
  await waitFor(() => expect(calls).toEqual(["enroll"]));
  await waitFor(() => expect(updates.at(-1)?.agentState).toBe("online"));
});

test("in a plain browser with no devices: renders nothing (the add-a-computer section covers it)", () => {
  const view = render(
    <ConnectionCard devices={[]} local={null} onLocal={() => {}} />,
  );
  expect(view.container.textContent).toBe("");
});
