import { describe, expect, test } from "bun:test";
import {
  assessBrowserActionRisk,
  BROWSER_COMPANION_OPERATIONS,
  BROWSER_COMPANION_STATES,
  BROWSER_PERMISSION_INFO,
  BROWSER_PERMISSION_TIERS,
  BUILTIN_BLOCKED_DOMAINS,
  BUILTIN_BLOCKED_PROTOCOLS,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  DEFAULT_BROWSER_PERMISSION_TIER,
  DEFAULT_COMPANION_EXTENSION_CONFIG,
  isBrowserCompanionOperation,
  isBrowserCompanionState,
  isBrowserPermissionTier,
  matchBlockedOrigin,
  normalizeBlockedDomainRule,
  normalizeBlockedDomains,
  normalizeBrowserPermissionTier,
  normalizeCompanionExtensionConfig,
  reduceBrowserCompanionSession,
} from "./browser-companion";
import {
  BROWSER_EXTENSION_PLATFORM,
  capabilityFor,
  isBrowserExtensionPlatform,
  isMobilePlatform,
  OPERATION_CAPABILITY,
  OPERATION_LABEL,
} from "./devices";

describe("shared/browser-companion metadata & config", () => {
  test("permission tiers and Chinese labels are complete", () => {
    expect(BROWSER_PERMISSION_TIERS).toEqual(["observe", "cautious", "full"]);
    expect(DEFAULT_BROWSER_PERMISSION_TIER).toBe("cautious");
    for (const tier of BROWSER_PERMISSION_TIERS) {
      expect(isBrowserPermissionTier(tier)).toBe(true);
      expect(BROWSER_PERMISSION_INFO[tier].label.length).toBeGreaterThan(0);
      expect(BROWSER_PERMISSION_INFO[tier].description.length).toBeGreaterThan(0);
    }
    expect(BROWSER_PERMISSION_INFO.observe.label).toBe("仅观察");
    expect(BROWSER_PERMISSION_INFO.cautious.label).toBe("谨慎操作");
    expect(BROWSER_PERMISSION_INFO.full.label).toBe("完全访问");
    expect(BROWSER_PERMISSION_INFO.full.dangerous).toBe(true);
    expect(normalizeBrowserPermissionTier("unknown")).toBe("cautious");
    expect(normalizeBrowserPermissionTier(null)).toBe("cautious");
  });

  test("device platform and operations wiring in shared/devices.ts", () => {
    expect(BROWSER_EXTENSION_PLATFORM).toBe("browser_extension");
    expect(isBrowserExtensionPlatform("browser_extension")).toBe(true);
    expect(isBrowserExtensionPlatform("win32")).toBe(false);
    expect(isBrowserExtensionPlatform("android")).toBe(false);
    expect(isBrowserExtensionPlatform(null)).toBe(false);
    expect(isMobilePlatform(BROWSER_EXTENSION_PLATFORM)).toBe(false);

    for (const op of BROWSER_COMPANION_OPERATIONS) {
      expect(isBrowserCompanionOperation(op)).toBe(true);
      expect(OPERATION_LABEL[op]).toBeTruthy();
      expect(Object.hasOwn(OPERATION_CAPABILITY, op)).toBe(true);
      expect(capabilityFor(op)).toBe(OPERATION_CAPABILITY[op]);
    }
    expect(OPERATION_CAPABILITY.browser_navigate).toBe("open");
    expect(OPERATION_CAPABILITY.browser_click).toBe("input");
    expect(OPERATION_CAPABILITY.browser_type).toBe("input");
    expect(OPERATION_CAPABILITY.browser_key).toBe("input");
    expect(OPERATION_CAPABILITY.browser_snapshot).toBe("screenshot");
    expect(OPERATION_CAPABILITY.browser_read).toBe("screenshot");
    expect(OPERATION_CAPABILITY.browser_screenshot).toBe("screenshot");
    expect(OPERATION_CAPABILITY.browser_control).toBeNull();
  });

  test("companion extension config normalization", () => {
    expect(normalizeCompanionExtensionConfig(null)).toEqual(
      DEFAULT_COMPANION_EXTENSION_CONFIG,
    );
    const normalized = normalizeCompanionExtensionConfig({
      tier: "full",
      blockedDomains: [
        "*.Bank.Example.com.",
        "https://BANK.EXAMPLE.COM/",
        "  ",
        "bad host with space",
        "pay.local/checkout/",
      ],
      allowRemoteDispatch: true,
      attachedTabId: 42,
      tabGroupId: 7,
      attached: false,
      selectedBotId: " bot_1 ",
      maxControlledTabs: 99,
    });
    expect(normalized.tier).toBe("full");
    expect(normalized.blockedDomains).toEqual([
      "bank.example.com",
      "pay.local/checkout",
    ]);
    expect(normalized.allowRemoteDispatch).toBe(true);
    expect(normalized.attachedTabId).toBe(42);
    expect(normalized.tabGroupId).toBe(7);
    expect(normalized.attached).toBe(false);
    expect(normalized.selectedBotId).toBe("bot_1");
    expect(normalized.maxControlledTabs).toBe(8);
  });
});

describe("blocked origin & protocol anti-bypass", () => {
  test("blocks all built-in protected protocols regardless of case or tier", () => {
    const urls = [
      "chrome://settings",
      "CHROME://extensions",
      "edge://settings/passwords",
      "Edge://flags",
      "about:blank",
      "ABOUT:srcdoc",
      "file:///etc/passwd",
      "FILE:///C:/Users/admin/secrets.txt",
      "chrome-extension://abcdefghijklmnop/sidepanel.html",
      "chrome-untrusted://terminal/",
      "devtools://devtools/bundled/inspector.html",
      "view-source:https://example.com",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "blob:https://example.com/1234",
      "ftp://files.example.com/a.txt",
    ];
    expect(BUILTIN_BLOCKED_PROTOCOLS.length).toBeGreaterThanOrEqual(5);

    for (const url of urls) {
      for (const tier of BROWSER_PERMISSION_TIERS) {
        const readRes = assessBrowserActionRisk({
          tier,
          operation: "browser_read",
          url,
        });
        expect(readRes.decision).toBe("deny");
        expect(readRes.category).toBe("blocked_origin");
        expect(readRes.locked).toBe(true);
      }
    }
  });

  test("blocks extension stores, password managers, and custom domains against case/trailing-dot/subdomain/path-traversal bypasses", () => {
    expect(BUILTIN_BLOCKED_DOMAINS).toContain("chromewebstore.google.com");
    expect(BUILTIN_BLOCKED_DOMAINS).toContain(
      "microsoftedge.microsoft.com/addons",
    );

    const blockedUrls = [
      "https://chromewebstore.google.com/detail/foo/bar",
      "https://CHROMEWEBSTORE.GOOGLE.COM./detail/foo",
      "https://sub.chromewebstore.google.com/",
      "https://chrome.google.com/webstore/category/extensions",
      "https://microsoftedge.microsoft.com/addons",
      "https://microsoftedge.microsoft.com/addons/detail/abc",
      "https://MICROSOFTEDGE.MICROSOFT.COM./ADDONS/detail/abc",
      "https://microsoftedge.microsoft.com/foo/../addons/detail/abc",
      "https://microsoftedge.microsoft.com/foo/%2e%2e/%61ddons/detail/abc",
      "https://microsoftedge.microsoft.com/%61ddons/detail/%ZZ",
      "https://microsoftedge.microsoft.com/addons;v=1/detail/1",
      "https://microsoftedge.microsoft.com/addons%3bv=1/detail/1",
      "https://microsoftedge.microsoft.com/foo/..;x=1/%61ddons;v=2/%ZZ",
      "https://1password.com/signin",
      "https://my.1PASSWORD.com.:8443/vault",
      "https://vault.bitwarden.com/#/login",
      "https://vault.bitwarden.eu/",
      "https://lastpass.com/",
      "https://app.dashlane.com/",
      "https://passwords.google.com/",
      "https://pass.proton.me/",
      "https://user:pass@1password.com/",
      "//1password.com/vault",
    ];

    for (const url of blockedUrls) {
      const res = assessBrowserActionRisk({
        tier: "full",
        operation: "browser_snapshot",
        url,
      });
      expect(res.decision).toBe("deny");
      expect(res.category).toBe("blocked_origin");
    }

    // 非 addons 路径的普通微软文档页面不应被误杀，非子域名相似前缀也不应误杀。
    expect(
      matchBlockedOrigin("https://microsoftedge.microsoft.com/welcome").blocked,
    ).toBe(false);
    expect(
      matchBlockedOrigin("https://microsoftedge.microsoft.com/welcome;v=1")
        .blocked,
    ).toBe(false);
    expect(matchBlockedOrigin("https://not1password.com/").blocked).toBe(false);
    expect(matchBlockedOrigin("https://fake-bitwarden.com/").blocked).toBe(
      false,
    );

    // 自定义黑名单同样支持子域、大小写、尾点与路径前缀。
    const custom = normalizeBlockedDomains([
      "*.MyBank.Example.com.",
      "corp.internal/admin",
    ]);
    expect(custom).toEqual(["mybank.example.com", "corp.internal/admin"]);
    expect(normalizeBlockedDomainRule("*")).toBeNull();
    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_read",
        url: "https://PAY.MYBANK.EXAMPLE.COM./transfer",
        blockedDomains: custom,
      }),
    ).toMatchObject({
      decision: "deny",
      category: "blocked_origin",
    });
    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_navigate",
        url: "https://corp.internal/ADMIN/users",
        blockedDomains: custom,
      }),
    ).toMatchObject({
      decision: "deny",
      category: "blocked_origin",
    });
    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_navigate",
        url: "https://corp.internal/docs",
        blockedDomains: custom,
      }).decision,
    ).toBe("allow");
  });
});

describe("assessBrowserActionRisk permission tiers & purchase lock", () => {
  test("purchase/payment/checkout/transfer controls are ALWAYS ask + locked across observe, cautious, and full", () => {
    const purchaseLabels = [
      "立即付款",
      "确认支付 ¥199",
      "立即购买",
      "确认下单",
      "提交订单",
      "去结算",
      "结账",
      "确认转账",
      "微信支付",
      "Pay Now",
      "Proceed to Checkout",
      "Complete Purchase",
      "Buy Now",
      "Place Order",
      "Transfer Funds",
      "Wire Transfer",
      "Subscribe",
      "btn_payNow",
      "PAYNow",
      "BUYNow",
      "btnPAYNow",
      "Pay\u200bNow",
      "付 款",
      "支 付",
      "购 买",
      "确 认 下 单",
      "付\u200b款",
      "支\u3000付",
    ];

    for (const name of purchaseLabels) {
      for (const tier of BROWSER_PERMISSION_TIERS) {
        const res = assessBrowserActionRisk({
          tier,
          operation: "browser_click",
          url: "https://shop.example.com/cart",
          element: { role: "button", name },
        });
        expect(res.decision).toBe("ask");
        expect(res.locked).toBe(true);
        expect(res.category).toBe("purchase");
      }
    }

    // 悬停或快照查看支付按钮属于只读观察，不触发付款拦截。
    const hoverPay = assessBrowserActionRisk({
      tier: "observe",
      operation: "browser_hover",
      url: "https://shop.example.com/cart",
      element: { role: "button", name: "立即付款" },
    });
    expect(hoverPay.decision).toBe("allow");
  });

  test("observe tier allows read/snapshot/scroll/hover/screenshot/list-tabs and asks for all writes", () => {
    const allowedReadOps = [
      { operation: "browser_snapshot" as const },
      { operation: "browser_read" as const },
      { operation: "browser_scroll" as const },
      { operation: "browser_hover" as const },
      { operation: "browser_screenshot" as const },
      { operation: "browser_tabs" as const },
      { operation: "browser_tabs" as const, action: "list" },
      { operation: "browser_control" as const, action: "status" },
      { operation: "browser_control" as const, action: "detach" },
      { operation: "browser_control" as const, action: "hud_update" },
    ];
    for (const item of allowedReadOps) {
      const res = assessBrowserActionRisk({
        tier: "observe",
        url: "https://console.example.com/metrics",
        ...item,
      });
      expect(res.decision).toBe("allow");
    }

    const askWriteOps = [
      {
        operation: "browser_click" as const,
        element: { role: "button", name: "查看详情" },
      },
      {
        operation: "browser_type" as const,
        element: { role: "textbox", name: "搜索" },
      },
      { operation: "browser_key" as const, key: "Tab" },
      { operation: "browser_navigate" as const },
      { operation: "browser_tabs" as const, action: "new" },
      { operation: "browser_tabs" as const, action: "close" },
      { operation: "browser_tabs" as const, action: "activate" },
      { operation: "browser_control" as const },
    ];
    for (const item of askWriteOps) {
      const res = assessBrowserActionRisk({
        tier: "observe",
        url: "https://console.example.com/metrics",
        ...item,
      });
      expect(res.decision).toBe("ask");
      expect(res.category).toBe("write");
    }
  });

  test("cautious tier allows ordinary navigation/clicks/typing and asks on high-risk semantics or submit/Enter", () => {
    // 常规操作放行
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_navigate",
        url: "https://console.example.com/servers",
      }).decision,
    ).toBe("allow");
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_click",
        url: "https://console.example.com/servers",
        element: { role: "tab", name: "内存监控" },
      }).decision,
    ).toBe("allow");
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_type",
        url: "https://console.example.com/servers",
        element: { role: "textbox", name: "过滤节点" },
        submit: false,
      }).decision,
    ).toBe("allow");
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_key",
        url: "https://console.example.com/servers",
        key: "Escape",
      }).decision,
    ).toBe("allow");

    // 高危语义词拦截
    const highRiskNames = [
      "删除实例",
      "清空日志",
      "注销账号",
      "重启服务器",
      "强制关机",
      "重装系统",
      "重置配置",
      "格式化磁盘",
      "提交表单",
      "发布公告",
      "发送邮件",
      "修改密码",
      "撤销令牌",
      "Delete",
      "Restart Server",
      "Shut Down",
      "Reinstall OS",
      "Factory Reset",
      "Format Disk",
      "Submit",
      "Publish",
      "Send Message",
      "Change Password",
      "Revoke Token",
      "删 除",
      "提 交",
      "重 启",
      "关 机",
      "注 销",
      "删\u3000除",
      "删\u200b除",
      "DELETEItem",
      "SUBMITForm",
      "RESTARTServer",
    ];
    for (const name of highRiskNames) {
      const res = assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_click",
        url: "https://console.example.com/servers",
        element: { role: "button", name },
      });
      expect(res.decision).toBe("ask");
      expect(res.category).toBe("high_risk");
    }

    // submit=true 与 Enter 键拦截
    expect(
      assessBrowserActionRisk({
        tier: "cautious",
        operation: "browser_type",
        url: "https://console.example.com/form",
        element: { role: "textbox", name: "备注" },
        submit: true,
      }),
    ).toMatchObject({ decision: "ask", category: "high_risk" });

    for (const key of ["Enter", "Return", "NumpadEnter", "Control+Enter"]) {
      expect(
        assessBrowserActionRisk({
          tier: "cautious",
          operation: "browser_key",
          url: "https://console.example.com/form",
          key,
        }),
      ).toMatchObject({ decision: "ask", category: "high_risk" });
    }
  });

  test("full tier allows high-risk non-purchase actions while keeping blocked origins and purchase lock intact", () => {
    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_click",
        url: "https://console.example.com/servers",
        element: { role: "button", name: "重启服务器" },
      }).decision,
    ).toBe("allow");

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_type",
        url: "https://console.example.com/form",
        element: { role: "textbox", name: "备注" },
        submit: true,
      }).decision,
    ).toBe("allow");

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_click",
        url: "https://shop.example.com/checkout",
        element: { role: "button", name: "确认下单" },
      }),
    ).toMatchObject({
      decision: "ask",
      locked: true,
      category: "purchase",
    });

    expect(
      assessBrowserActionRisk({
        tier: "full",
        operation: "browser_click",
        url: "https://vault.bitwarden.com",
        element: { role: "button", name: "查看" },
      }),
    ).toMatchObject({
      decision: "deny",
      category: "blocked_origin",
    });
  });
});

describe("reduceBrowserCompanionSession state machine", () => {
  test("covers complete lifecycle across attach, tool_start/step, human_input/challenge, approval, resume, detach, kill_switch, remote_disconnect", () => {
    for (const state of BROWSER_COMPANION_STATES) {
      expect(isBrowserCompanionState(state)).toBe(true);
    }

    // 初始打开侧栏默认附着当前页（idle），不挂 CDP 无横幅
    let s = createInitialBrowserCompanionSession({
      sessionId: "sess-1",
      deviceId: "dev-ext-1",
      activeTabId: 101,
    });
    expect(s.state).toBe("idle");
    expect(s.attached).toBe(true);
    expect(s.debuggerAttached).toBe(false);
    expect(s.hudVisible).toBe(false);
    expect(s.botControlHeld).toBe(false);
    expect(canCompanionBotAct(s)).toEqual({ allowed: false, reason: "idle" });

    // Bot 开始调用工具 -> controlling（建标签组 + 挂 CDP + 显 HUD）
    s = reduceBrowserCompanionSession(s, {
      type: "tool_start",
      botId: "bot-whale",
      botName: "鲸鱼娘",
      tabId: 101,
      tabGroupId: 9,
      tabCount: 1,
      stepLabel: "读取服务器监控页",
      timestamp: 1000,
    });
    expect(s.state).toBe("controlling");
    expect(s.debuggerAttached).toBe(true);
    expect(s.hudVisible).toBe(true);
    expect(s.botControlHeld).toBe(true);
    expect(s.tabGroupId).toBe(9);
    expect(canCompanionBotAct(s, { mutating: true })).toEqual({ allowed: true });

    // tool_step 更新步骤文案与受控标签数
    s = reduceBrowserCompanionSession(s, {
      type: "tool_step",
      stepLabel: "滚动查看内存与网卡图表",
      tabCount: 2,
      timestamp: 1001,
    });
    expect(s.state).toBe("controlling");
    expect(s.tabCount).toBe(2);
    expect(s.currentStepLabel).toBe("滚动查看内存与网卡图表");

    // 命中高危控件 -> awaiting_approval
    s = reduceBrowserCompanionSession(s, {
      type: "approval_requested",
      approval: {
        approvalId: "appr-1",
        operation: "browser_click",
        summary: "点击「重启服务器」",
        category: "high_risk",
      },
      timestamp: 1002,
    });
    expect(s.state).toBe("awaiting_approval");
    expect(s.botControlHeld).toBe(false);
    expect(s.pendingApproval?.approvalId).toBe("appr-1");
    expect(canCompanionBotAct(s)).toEqual({
      allowed: false,
      reason: "awaiting_approval",
    });

    // 错误 approvalId 或 Bot 强行 tool_start / resume 不能绕过审批
    expect(
      reduceBrowserCompanionSession(s, {
        type: "approval_resolved",
        approvalId: "appr-wrong",
        approved: true,
      }).state,
    ).toBe("awaiting_approval");
    expect(
      reduceBrowserCompanionSession(s, { type: "tool_start" }).state,
    ).toBe("awaiting_approval");
    expect(reduceBrowserCompanionSession(s, { type: "resume" }).state).toBe(
      "awaiting_approval",
    );

    // 批准 -> 回到 controlling
    s = reduceBrowserCompanionSession(s, {
      type: "approval_resolved",
      approvalId: "appr-1",
      approved: true,
      stepLabel: "正在重启服务器",
      timestamp: 1003,
    });
    expect(s.state).toBe("controlling");
    expect(s.botControlHeld).toBe(true);
    expect(s.pendingApproval).toBeNull();

    // 真人主动点击/打字 -> yielded_to_human（礼让暂停）
    s = reduceBrowserCompanionSession(s, {
      type: "human_input",
      timestamp: 1004,
    });
    expect(s.state).toBe("yielded_to_human");
    expect(s.botControlHeld).toBe(false);
    expect(s.yieldReason).toBe("human_input");
    expect(s.resumeSnapshotRequired).toBe(true);
    expect(canCompanionBotAct(s)).toEqual({
      allowed: false,
      reason: "yielded_to_human",
    });

    // 礼让期间 Bot 的 tool_start / tool_step 全部被拒（不抢鼠标）
    expect(
      reduceBrowserCompanionSession(s, { type: "tool_start" }).state,
    ).toBe("yielded_to_human");
    expect(
      reduceBrowserCompanionSession(s, {
        type: "tool_step",
        snapshotTaken: true,
      }).state,
    ).toBe("yielded_to_human");

    // 用户点击「继续交给 Bot」-> controlling，但必须先重新抓快照才能写操作
    s = reduceBrowserCompanionSession(s, {
      type: "resume",
      timestamp: 1005,
    });
    expect(s.state).toBe("controlling");
    expect(s.botControlHeld).toBe(true);
    expect(s.resumeSnapshotRequired).toBe(true);
    expect(canCompanionBotAct(s, { mutating: false })).toEqual({
      allowed: true,
    });
    expect(canCompanionBotAct(s, { mutating: true })).toEqual({
      allowed: false,
      reason: "snapshot_required",
    });

    // 重新抓快照后解除 resumeSnapshotRequired
    s = reduceBrowserCompanionSession(s, {
      type: "tool_step",
      operation: "browser_snapshot",
      snapshotTaken: true,
      timestamp: 1006,
    });
    expect(s.resumeSnapshotRequired).toBe(false);
    expect(canCompanionBotAct(s, { mutating: true })).toEqual({ allowed: true });

    // 遇验证码挑战 -> yielded_to_human(challenge)
    s = reduceBrowserCompanionSession(s, {
      type: "challenge",
      reason: "请完成 Cloudflare 验证",
      timestamp: 1007,
    });
    expect(s.state).toBe("yielded_to_human");
    expect(s.yieldReason).toBe("challenge");
    expect(s.botControlHeld).toBe(false);

    // 点页内 × (detach) -> 立即释放控制、CDP 与 HUD
    s = reduceBrowserCompanionSession(s, {
      type: "detach",
      reason: "user_close_hud",
      timestamp: 1008,
    });
    expect(s.state).toBe("detached");
    expect(s.attached).toBe(false);
    expect(s.debuggerAttached).toBe(false);
    expect(s.hudVisible).toBe(false);
    expect(s.botControlHeld).toBe(false);
    expect(s.tabGroupId).toBeNull();
    expect(s.tabCount).toBe(0);

    // 重新开启附着 -> idle
    s = reduceBrowserCompanionSession(s, {
      type: "attach",
      tabId: 202,
      timestamp: 1009,
    });
    expect(s.state).toBe("idle");
    expect(s.attached).toBe(true);
    expect(s.activeTabId).toBe(202);
    expect(s.tabCount).toBe(1);

    // 拒绝审批且回合结束 -> idle
    s = reduceBrowserCompanionSession(s, { type: "tool_start", tabId: 202 });
    s = reduceBrowserCompanionSession(s, {
      type: "approval_requested",
      approval: {
        approvalId: "appr-2",
        operation: "browser_click",
        summary: "点击「删除」",
        category: "high_risk",
      },
    });
    s = reduceBrowserCompanionSession(s, {
      type: "approval_resolved",
      approvalId: "appr-2",
      approved: false,
    });
    expect(s.state).toBe("idle");
    expect(s.hudVisible).toBe(false);
    expect(s.botControlHeld).toBe(false);
    expect(s.pendingApproval).toBeNull();

    // 紧急停止 kill_switch -> detached + killSwitched，禁止任何 tool_start/resume，只能重新 attach 解除
    s = reduceBrowserCompanionSession(s, { type: "tool_start", tabId: 202 });
    s = reduceBrowserCompanionSession(s, { type: "kill_switch" });
    expect(s.state).toBe("detached");
    expect(s.killSwitched).toBe(true);
    expect(s.debuggerAttached).toBe(false);
    expect(s.botControlHeld).toBe(false);
    expect(canCompanionBotAct(s)).toEqual({
      allowed: false,
      reason: "kill_switched",
    });
    expect(
      reduceBrowserCompanionSession(s, { type: "tool_start" }).state,
    ).toBe("detached");
    expect(reduceBrowserCompanionSession(s, { type: "resume" }).state).toBe(
      "detached",
    );

    // 远端断连 remote_disconnect -> 立即 detached 并清空控制态
    s = reduceBrowserCompanionSession(s, { type: "attach", tabId: 303 });
    expect(s.killSwitched).toBe(false);
    s = reduceBrowserCompanionSession(s, { type: "tool_start", tabId: 303 });
    s = reduceBrowserCompanionSession(s, { type: "remote_disconnect" });
    expect(s.state).toBe("detached");
    expect(s.detachReason).toBe("remote_disconnect");
    expect(s.debuggerAttached).toBe(false);
    expect(s.hudVisible).toBe(false);
    expect(s.botControlHeld).toBe(false);
  });
});
