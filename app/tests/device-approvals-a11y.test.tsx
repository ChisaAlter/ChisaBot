import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type * as React from "react";
import {
  type DeviceApprovalView,
  type DeviceView,
  defaultCapabilities,
} from "../../shared/devices";
import { settleReactWork } from "./settle-react-work";

/**
 * 设备页审计（模块 14）：S4 审批两个按钮各自的状态、O1 到点「已过期」、O2 倒计时不被时钟偏差重置、
 * O7 读不到设备时「返回设备列表」、O8 离线设备禁用并说明原因。
 */

const real = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
  ...real,
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: React.ReactNode;
    to?: string;
  }) => (
    <a href={to} {...(props as object)}>
      {children}
    </a>
  ),
  useNavigate: () => () => {},
}));

let decideImpl: (id: string, decision: string) => Promise<void> =
  async () => {};
const calls: string[] = [];
const realDevices = await import("@/lib/devices");
mock.module("@/lib/devices", () => ({
  ...realDevices,
  decideApproval: (id: string, decision: string) => {
    calls.push(decision);
    return decideImpl(id, decision);
  },
}));

beforeAll(() => {
  if (!globalThis.document) GlobalRegistrator.register();
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  decideImpl = async () => {};
});
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const { ApprovalRow, approvalDeadline } = await import(
  "@/components/devices/devices"
);
const { FullAccessCard } = await import("@/components/devices/full-access");
const { DeviceNotFound, DeviceErrorCard } = await import(
  "@/components/devices/device-page-parts"
);

let seq = 0;
function approval(
  overrides: Partial<DeviceApprovalView> = {},
): DeviceApprovalView {
  const now = Date.now();
  seq += 1;
  return {
    id: `appr_${seq}`,
    deviceId: "dev_1",
    deviceName: "Ayase",
    botId: "b1",
    botName: "小爱",
    operation: "shell",
    summary: "ls",
    createdAt: new Date(now - 10_000).toISOString(),
    expiresAt: new Date(now + 110_000).toISOString(),
    ...overrides,
  } as DeviceApprovalView;
}

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
    online: true,
    ...overrides,
  } as DeviceView;
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const st = (root: HTMLElement, id: string) =>
  btn(root, id).getAttribute("data-btn-state") ?? "idle";
const name = (root: HTMLElement, id: string) =>
  btn(root, id).getAttribute("aria-label") ?? "";
const btn = (root: HTMLElement, id: string) =>
  root.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

describe("S4 审批按钮各自的状态", () => {
  test("点「允许」只有允许按钮进入处理中，拒绝按钮禁用；成功后两个都锁住", async () => {
    let resolve!: () => void;
    decideImpl = () => new Promise<void>((r) => (resolve = r));
    const { container } = wrap(<ApprovalRow approval={approval()} />);
    fireEvent.click(btn(container, "device-approval-approve"));
    await waitFor(() =>
      expect(st(container, "device-approval-approve")).toBe("pending"),
    );
    expect(name(container, "device-approval-approve")).toBe("允许中…");
    expect(btn(container, "device-approval-deny").disabled).toBe(true);
    expect(st(container, "device-approval-deny")).toBe("idle");
    expect(calls).toEqual(["approve"]);
    await act(async () => resolve());
    await waitFor(() =>
      expect(st(container, "device-approval-approve")).toBe("success"),
    );
    expect(name(container, "device-approval-approve")).toBe("已允许");
    expect(btn(container, "device-approval-deny").disabled).toBe(true);
    expect(btn(container, "device-approval-approve").disabled).toBe(true);
  });

  test("拒绝失败只在拒绝按钮上显示失败，允许按钮仍可用", async () => {
    decideImpl = async () => {
      throw new Error("网络断了");
    };
    const { container } = wrap(<ApprovalRow approval={approval()} />);
    fireEvent.click(btn(container, "device-approval-deny"));
    await waitFor(() =>
      expect(st(container, "device-approval-deny")).toBe("error"),
    );
    expect(name(container, "device-approval-deny")).toBe("拒绝失败");
    expect(st(container, "device-approval-approve")).toBe("idle");
    expect(btn(container, "device-approval-approve").disabled).toBe(false);
  });
});

describe("O1 / O2 倒计时", () => {
  test("已经过了 expiresAt：显示「已过期」，两个按钮都禁用（不会重置成整段 TTL）", () => {
    const now = Date.now();
    const expired = approval({
      createdAt: new Date(now - 200_000).toISOString(),
      expiresAt: new Date(now - 80_000).toISOString(),
    });
    const { container } = wrap(<ApprovalRow approval={expired} />);
    expect(
      container.querySelector('[data-testid="device-approval-expired"]')
        ?.textContent,
    ).toContain("已过期");
    expect(
      container.querySelector('[data-testid="device-approval-meta"]')
        ?.textContent,
    ).toContain("已过期");
    expect(btn(container, "device-approval-approve").disabled).toBe(true);
    expect(btn(container, "device-approval-deny").disabled).toBe(true);
  });

  test("本机时钟偏差：剩余时间夹在 [0, TTL]；同一个审批再算一遍只会提前不会延长", () => {
    const a = approval({
      createdAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2026-10-29T00:02:00.000Z",
    });
    // 本机慢 10 分钟：最多按 TTL（120s）算
    const first = approvalDeadline(
      a,
      1_000,
      Date.parse("2026-10-28T23:50:00.000Z"),
    );
    expect(first).toBe(1_000 + 120_000);
    // 5 秒后列表刷新、本机时钟被校正到更晚：截止时刻只会提前
    expect(
      approvalDeadline(a, 6_000, Date.parse("2026-10-29T00:01:30.000Z")),
    ).toBe(6_000 + 30_000);
    // 再刷新时本机又跳回去：不延长
    expect(
      approvalDeadline(a, 7_000, Date.parse("2026-10-28T23:00:00.000Z")),
    ).toBe(36_000);
    // 本机快：已经过期就是 0，不回到 TTL
    const b = approval({
      createdAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2026-10-29T00:02:00.000Z",
    });
    expect(
      approvalDeadline(b, 1_000, Date.parse("2026-10-29T00:05:00.000Z")),
    ).toBe(1_000);
    // 服务器给了 remainingMs 时以它为准
    const c = { ...approval(), remainingMs: 42_000 };
    expect(approvalDeadline(c, 0, Date.now())).toBe(42_000);
  });
});

describe("O7 / O6 读不到设备", () => {
  test("有「返回设备列表」链接，标题是 h2", () => {
    const { container } = wrap(<DeviceNotFound message="设备不存在。" />);
    const back = container.querySelector(
      '[data-testid="device-back-to-list"]',
    ) as HTMLAnchorElement;
    expect(back.textContent).toContain("返回设备列表");
    expect(back.getAttribute("href")).toBe("/settings/devices");
    expect(container.querySelector("h2")?.textContent).toBe("无法读取这台设备");
    expect(container.querySelector("h4")).toBeNull();
  });

  test("错误卡标题不跳级", () => {
    const { container } = wrap(
      <DeviceErrorCard title="设备列表暂时无法读取" />,
    );
    expect(container.querySelector("h2")).not.toBeNull();
  });
});

describe("O8 离线设备", () => {
  test("开启完全访问被禁用，并用 aria-describedby 指向可见说明", () => {
    const { container } = wrap(
      <FullAccessCard device={device({ online: false })} />,
    );
    const enable = btn(container, "full-access-enable");
    expect(enable.disabled).toBe(true);
    const note = container.querySelector(
      '[data-testid="full-access-offline-note"]',
    ) as HTMLElement;
    expect(note.textContent).toContain("离线");
    expect(enable.getAttribute("aria-describedby")).toBe(note.id);
  });

  test("在线时可以开启", () => {
    const { container } = wrap(
      <FullAccessCard device={device({ online: true })} />,
    );
    expect(btn(container, "full-access-enable").disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="full-access-offline-note"]'),
    ).toBeNull();
  });
});
