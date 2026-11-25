import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
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
import { SecurityAuditCard } from "@/components/settings/security-audit-card";
import { resetToastsForTest, Toaster } from "@/components/ui/toast";
import { UpdateBanner } from "@/components/update-banner";
import type { ApprovalInboxData } from "@/lib/approvals";
import type { PcBridge, PcLocalState, PcSecurityAudit } from "@/lib/pc-bridge";
import type { VaultSecretView } from "../../shared/vault";
import { settleReactWork } from "./settle-react-work";

let originalFetch: typeof fetch;
let mockVaultSecrets: VaultSecretView[] = [];
let mockApprovals: ApprovalInboxData;

function makeVaultSecret(id: string, domains: string[]): VaultSecretView {
  return {
    id,
    name: `key_${id}`,
    label: `密钥 ${id}`,
    domains,
    hint: "abcd",
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    lastUsedAt: null,
  };
}

function makeApprovals(
  overrides: Partial<ApprovalInboxData> = {},
): ApprovalInboxData {
  return {
    enabled: true,
    requests: [],
    rules: [],
    teamRules: [],
    preferences: {
      enabled: true,
      autoReview: true,
      hostCommands: "ask",
    },
    hostCommands: "ask",
    questions: [],
    ...overrides,
  };
}

function makePcState(overrides: Partial<PcLocalState> = {}): PcLocalState {
  return {
    version: "0.1.190",
    platform: "win32",
    hostname: "dev-box",
    serverUrl: "https://example.invalid",
    deviceId: "dev-1",
    agentState: "online",
    statusText: "在线",
    tokenProtected: true,
    encryptionBackend: "dpapi",
    localPaused: false,
    forceLocalApproval: true,
    autoStart: false,
    startHidden: false,
    ...overrides,
  };
}

function renderWithQuery(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <Toaster />
      {node}
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});

afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

beforeEach(() => {
  mockVaultSecrets = [
    makeVaultSecret("1", ["api.openai.com"]),
    makeVaultSecret("2", ["*.github.com", "api.openai.com"]),
  ];
  mockApprovals = makeApprovals();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes("/api/vault")) {
        return Response.json({ secrets: mockVaultSecrets });
      }
      if (url.includes("/api/approvals")) {
        return Response.json(mockApprovals);
      }
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
});

afterEach(() => {
  delete window.chisabotPC;
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
  resetToastsForTest();
  cleanup();
});

describe("SecurityAuditCard", () => {
  test("纯网页环境下展示保险箱与审批门禁，不渲染 PC 本机安全自检行", async () => {
    const view = renderWithQuery(<SecurityAuditCard />);

    await waitFor(() => {
      expect(view.getByText("已托管 2 项")).toBeTruthy();
      expect(view.getByText("已开启")).toBeTruthy();
    });

    expect(
      view.getByText(/已托管 2 项密钥（覆盖 2 个外域白名单）/),
    ).toBeTruthy();
    expect(
      view.getByText(/已开启审批拦截 · 自动审核已开启 · 宿主机命令需审批/),
    ).toBeTruthy();
    expect(view.queryByTestId("security-audit-pc")).toBeNull();
  });

  test("PC 环境下显式展示 dpapi 后端与 0600 正常状态", async () => {
    const pcState = makePcState({
      platform: "darwin",
      encryptionBackend: "keychain",
    });
    const audit: PcSecurityAudit = {
      platform: "darwin",
      tokenProtected: true,
      encryptionBackend: "keychain",
      files: [
        {
          name: "config.json",
          exists: true,
          mode: 0o600,
          secure: true,
          isSymlink: false,
        },
        {
          name: "audit.jsonl",
          exists: true,
          mode: 0o600,
          secure: true,
          isSymlink: false,
        },
      ],
    };
    window.chisabotPC = {
      state: async () => pcState,
      setLocal: async () => pcState,
      pickFolders: async () => [],
      logout: async () => true,
      securityAudit: async () => audit,
      hardenPermissions: async () => audit,
      onChange: () => () => {},
    } as PcBridge;

    const view = renderWithQuery(<SecurityAuditCard />);

    await waitFor(() => {
      expect(view.getByTestId("security-audit-pc")).toBeTruthy();
      expect(view.getByText(/keychain（macOS 钥匙串加密）/)).toBeTruthy();
      expect(view.getByText(/config\.json: 0600 正常/)).toBeTruthy();
      expect(view.getByText(/audit\.jsonl: 0600 正常/)).toBeTruthy();
      expect(view.getByText("已加固")).toBeTruthy();
    });
    expect(view.queryByTestId("security-audit-harden-btn")).toBeNull();
  });

  test("检测到 basic_text 降级与非 0600 权限时展示提醒并支持一键加固", async () => {
    const pcState = makePcState({
      platform: "linux",
      tokenProtected: false,
      encryptionBackend: "basic_text",
    });
    let currentAudit: PcSecurityAudit = {
      platform: "linux",
      tokenProtected: false,
      encryptionBackend: "basic_text",
      files: [
        {
          name: "config.json",
          exists: true,
          mode: 0o644,
          secure: false,
          isSymlink: false,
        },
        {
          name: "audit.jsonl",
          exists: true,
          mode: 0o600,
          secure: true,
          isSymlink: false,
        },
      ],
    };
    const hardenedAudit: PcSecurityAudit = {
      ...currentAudit,
      files: [
        {
          name: "config.json",
          exists: true,
          mode: 0o600,
          secure: true,
          isSymlink: false,
        },
        {
          name: "audit.jsonl",
          exists: true,
          mode: 0o600,
          secure: true,
          isSymlink: false,
        },
      ],
    };
    const hardenPermissions = jest.fn(async () => {
      currentAudit = hardenedAudit;
      return hardenedAudit;
    });
    window.chisabotPC = {
      state: async () => pcState,
      setLocal: async () => pcState,
      pickFolders: async () => [],
      logout: async () => true,
      securityAudit: async () => currentAudit,
      hardenPermissions,
      onChange: () => () => {},
    } as PcBridge;

    const view = renderWithQuery(<SecurityAuditCard />);

    await waitFor(() => {
      expect(view.getByText(/basic_text（系统安全存储已降级/)).toBeTruthy();
      expect(
        view.getByText(/config\.json: 当前 0644（需收敛为 0600）/),
      ).toBeTruthy();
      expect(view.getByTestId("security-audit-harden-btn")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("security-audit-harden-btn"));
    });

    await waitFor(() => {
      expect(hardenPermissions).toHaveBeenCalledTimes(1);
      expect(view.getByText(/config\.json: 0600 正常/)).toBeTruthy();
      expect(
        view.getByText("已将本机配置与审计日志权限收敛为 0600"),
      ).toBeTruthy();
    });
    expect(view.queryByTestId("security-audit-harden-btn")).toBeNull();
  });
});

describe("UpdateBanner 手动下载安装联动", () => {
  test("status=available 且 manualInstall=true 时显示手动下载提示并调用 installUpdate", async () => {
    const pcState = makePcState({
      update: {
        supported: true,
        status: "available",
        version: "0.2.0",
        manualInstall: true,
      },
    });
    const installUpdate = jest.fn(async () => true);
    window.chisabotPC = {
      state: async () => pcState,
      setLocal: async () => pcState,
      pickFolders: async () => [],
      logout: async () => true,
      installUpdate,
      onChange: () => () => {},
    } as PcBridge;

    const reload = jest.fn();
    const view = render(<UpdateBanner bundled="dev" reload={reload} />);

    await waitFor(() => {
      expect(view.getByText("有新版本 v0.2.0 可手动下载安装")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(view.getByText("有新版本 v0.2.0 可手动下载安装"));
    });

    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});
