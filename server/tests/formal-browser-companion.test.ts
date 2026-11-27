import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assessBrowserActionRisk,
  type BrowserActionRiskAssessment,
  type BrowserActionRiskInput,
  type BrowserCompanionEvent,
  type BrowserCompanionSession,
  type BrowserPermissionTier,
  canCompanionBotAct,
  createInitialBrowserCompanionSession,
  reduceBrowserCompanionSession,
} from "../../shared/browser-companion";
import {
  assertModelHolds,
  exploreModel,
  type ModelTransition,
  type StateModel,
} from "../../shared/verification/model-checker";

/**
 * 对应 `shared/browser-companion.ts` 浏览器伴侣扩展「接管会话状态机 + 三档权限 + 付款强制锁 + 黑名单防绕过」
 * 的形式化有限状态空间模型检验（BFS 全状态穷举 + fast-check 差分随机序列 + 变异体捕杀）。
 *
 * 验证四项核心安全与活性不变量：
 * 1. 人机礼让互斥与不丢锁：`yielded_to_human` / `awaiting_approval` 期间 Bot 绝不可执行或抢回控制，
 *    恢复控制后必须重新抓快照才允许写操作；
 * 2. 急停与点×必释放控制：`detach` / `kill_switch` / `remote_disconnect` 从任意态立即进入 `detached`
 *    并清空 `attached`、`debuggerAttached`、`hudVisible`、`botControlHeld` 与 `pendingApproval`；
 * 3. 黑名单永远不可绕过：所有权限档位下对内置/自定义黑名单及变体（大小写、尾点、子域、特殊协议、路径遍历）
 *    均返回 `deny` (`blocked_origin`)；
 * 4. 付款强制锁永远不可绕过：所有权限档位（含 `full`）对付款/购买/下单/转账类控件均返回
 *    `ask` + `locked: true` + `category: "purchase"`。
 */

type CompanionModelState = {
  session: BrowserCompanionSession;
  tier: BrowserPermissionTier;
  /** 检测到真人礼让/审批互斥或恢复快照护栏被破坏。 */
  humanYieldLockViolation: boolean;
  /** 检测到 detach / kill_switch / remote_disconnect 未完全释放控制或被非法重启。 */
  detachReleaseViolation: boolean;
  /** 检测到黑名单防绕过被击穿。 */
  blockedOriginBypassViolation: boolean;
  /** 检测到付款强制锁被绕过（例如 full 档直接放行）。 */
  purchaseLockBypassViolation: boolean;
};

type ReducerFn = typeof reduceBrowserCompanionSession;
type RiskFn = (input: BrowserActionRiskInput) => BrowserActionRiskAssessment;

type CompanionModelFaults = {
  reducer?: ReducerFn;
  assessRisk?: RiskFn;
};

const ADVERSARIAL_BLOCKED_URLS = [
  "CHROME://settings",
  "Edge://extensions",
  "about:blank",
  "file:///etc/passwd",
  "chrome-extension://abcdefg/popup.html",
  "https://CHROMEWEBSTORE.GOOGLE.COM./detail/x",
  "https://microsoftedge.microsoft.com/foo/%2e%2e/%61ddons/detail/x",
  "https://microsoftedge.microsoft.com/%61ddons/detail/%ZZ",
  "https://microsoftedge.microsoft.com/addons;v=1/detail/1",
  "https://microsoftedge.microsoft.com/foo/..;x=1/%61ddons;v=2/%ZZ",
  "https://my.1PASSWORD.com.:8443/vault",
  "https://pay.mybank.example.com./wire",
] as const;

const CUSTOM_BLOCKED_DOMAINS = ["mybank.example.com"] as const;

const PURCHASE_PROBES: readonly BrowserActionRiskInput[] = [
  {
    operation: "browser_click",
    url: "https://shop.example.com/checkout",
    element: { role: "button", name: "确认下单" },
  },
  {
    operation: "browser_click",
    url: "https://shop.example.com/checkout",
    element: { role: "button", name: "付 款" },
  },
  {
    operation: "browser_click",
    url: "https://shop.example.com/pay",
    element: { role: "button", name: "Pay Now" },
  },
  {
    operation: "browser_click",
    url: "https://shop.example.com/pay",
    element: { role: "button", name: "PAYNow" },
  },
  {
    operation: "browser_click",
    url: "https://bank-demo.example.org/send",
    element: { role: "button", name: "立即转账" },
  },
];

function createCompanionModel(
  faults: CompanionModelFaults = {},
  name = "浏览器伴侣接管状态机与安全护栏",
): StateModel<CompanionModelState> {
  const reduce: ReducerFn = faults.reducer ?? reduceBrowserCompanionSession;
  const assess: RiskFn = faults.assessRisk ?? assessBrowserActionRisk;

  const applySessionEvent = (
    current: Readonly<CompanionModelState>,
    event: BrowserCompanionEvent,
  ): CompanionModelState => {
    const before = current.session;
    const next = reduce(before, event);

    // 若从 yielded_to_human 或 awaiting_approval 被非授权事件直接切回 controlling，记为礼让/审批锁违背。
    const stolenFromHumanYield =
      before.state === "yielded_to_human" &&
      event.type !== "resume" &&
      next.state === "controlling";
    const stolenFromApproval =
      before.state === "awaiting_approval" &&
      event.type !== "approval_resolved" &&
      next.state === "controlling";
    const staleApprovalUnlocked =
      before.state === "awaiting_approval" &&
      event.type === "approval_resolved" &&
      before.pendingApproval?.approvalId !== event.approvalId &&
      next.state !== "awaiting_approval";
    const missingSnapshotGuardAfterResume =
      before.state === "yielded_to_human" &&
      event.type === "resume" &&
      next.state === "controlling" &&
      !next.resumeSnapshotRequired;

    const releaseEvent =
      event.type === "detach" ||
      event.type === "kill_switch" ||
      event.type === "remote_disconnect";
    const leakedAfterRelease =
      releaseEvent &&
      (next.state !== "detached" ||
        next.attached ||
        next.debuggerAttached ||
        next.hudVisible ||
        next.botControlHeld ||
        next.pendingApproval !== null ||
        next.yieldReason !== null ||
        (event.type === "kill_switch" && !next.killSwitched));
    const restartedWhileKillSwitched =
      before.killSwitched &&
      event.type !== "attach" &&
      (next.state !== "detached" || next.botControlHeld || next.debuggerAttached);

    return {
      ...current,
      session: next,
      humanYieldLockViolation:
        current.humanYieldLockViolation ||
        stolenFromHumanYield ||
        stolenFromApproval ||
        staleApprovalUnlocked ||
        missingSnapshotGuardAfterResume,
      detachReleaseViolation:
        current.detachReleaseViolation ||
        leakedAfterRelease ||
        restartedWhileKillSwitched,
    };
  };

  const transitions: ModelTransition<CompanionModelState>[] = [
    {
      name: "attach",
      guard: () => true,
      apply: (s) =>
        applySessionEvent(s, {
          type: "attach",
          tabId: 101,
          botId: "bot-whale",
          botName: "鲸鱼娘",
        }),
    },
    {
      name: "tool_start",
      guard: () => true,
      apply: (s) =>
        applySessionEvent(s, {
          type: "tool_start",
          botId: "bot-whale",
          botName: "鲸鱼娘",
          tabId: 101,
          tabGroupId: 7,
          tabCount: 1,
          stepLabel: "操作页面",
        }),
    },
    {
      name: "tool_step_mutate",
      guard: () => true,
      apply: (s) => {
        const gate = canCompanionBotAct(s.session, { mutating: true });
        const shouldReject =
          s.session.state !== "controlling" ||
          s.session.killSwitched ||
          !s.session.attached ||
          s.session.resumeSnapshotRequired;
        const nextState = applySessionEvent(s, {
          type: "tool_step",
          operation: "browser_click",
          stepLabel: "点击页面",
        });
        return {
          ...nextState,
          humanYieldLockViolation:
            nextState.humanYieldLockViolation || (shouldReject && gate.allowed),
        };
      },
    },
    {
      name: "tool_step_snapshot",
      guard: () => true,
      apply: (s) =>
        applySessionEvent(s, {
          type: "tool_step",
          operation: "browser_snapshot",
          snapshotTaken: true,
          stepLabel: "重新获取快照",
        }),
    },
    {
      name: "human_input",
      guard: () => true,
      apply: (s) => applySessionEvent(s, { type: "human_input" }),
    },
    {
      name: "challenge",
      guard: () => true,
      apply: (s) => applySessionEvent(s, { type: "challenge" }),
    },
    {
      name: "approval_requested",
      guard: () => true,
      apply: (s) =>
        applySessionEvent(s, {
          type: "approval_requested",
          approval: {
            approvalId: "appr-1",
            operation: "browser_click",
            summary: "点击「确认下单」",
            category: "purchase",
            locked: true,
          },
        }),
    },
    {
      name: "approval_approve",
      guard: (s) => s.session.state === "awaiting_approval",
      apply: (s) =>
        applySessionEvent(s, {
          type: "approval_resolved",
          approvalId: "appr-1",
          approved: true,
        }),
    },
    {
      name: "approval_stale_approve",
      guard: (s) => s.session.state === "awaiting_approval",
      apply: (s) =>
        applySessionEvent(s, {
          type: "approval_resolved",
          approvalId: "appr-stale",
          approved: true,
        }),
    },
    {
      name: "approval_deny",
      guard: (s) => s.session.state === "awaiting_approval",
      apply: (s) =>
        applySessionEvent(s, {
          type: "approval_resolved",
          approvalId: "appr-1",
          approved: false,
          endTurn: true,
        }),
    },
    {
      name: "resume",
      guard: () => true,
      apply: (s) => applySessionEvent(s, { type: "resume" }),
    },
    {
      name: "turn_complete",
      guard: (s) => s.session.state === "controlling",
      apply: (s) => applySessionEvent(s, { type: "turn_complete" }),
    },
    {
      name: "detach",
      guard: () => true,
      apply: (s) =>
        applySessionEvent(s, { type: "detach", reason: "user_close_hud" }),
    },
    {
      name: "kill_switch",
      guard: () => true,
      apply: (s) => applySessionEvent(s, { type: "kill_switch" }),
    },
    {
      name: "remote_disconnect",
      guard: () => true,
      apply: (s) => applySessionEvent(s, { type: "remote_disconnect" }),
    },
    {
      name: "switch_tier_observe",
      guard: (s) => s.tier !== "observe",
      apply: (s) => ({ ...s, tier: "observe" }),
    },
    {
      name: "switch_tier_cautious",
      guard: (s) => s.tier !== "cautious",
      apply: (s) => ({ ...s, tier: "cautious" }),
    },
    {
      name: "switch_tier_full",
      guard: (s) => s.tier !== "full",
      apply: (s) => ({ ...s, tier: "full" }),
    },
    {
      name: "probe_blocked_origin",
      guard: () => true,
      apply: (s) => {
        let violated = false;
        for (const url of ADVERSARIAL_BLOCKED_URLS) {
          const verdict = assess({
            tier: s.tier,
            operation: "browser_read",
            url,
            blockedDomains: CUSTOM_BLOCKED_DOMAINS,
          });
          if (
            verdict.decision !== "deny" ||
            verdict.category !== "blocked_origin"
          ) {
            violated = true;
            break;
          }
        }
        return {
          ...s,
          blockedOriginBypassViolation:
            s.blockedOriginBypassViolation || violated,
        };
      },
    },
    {
      name: "probe_purchase_lock",
      guard: () => true,
      apply: (s) => {
        let violated = false;
        for (const probe of PURCHASE_PROBES) {
          const verdict = assess({
            ...probe,
            tier: s.tier,
            blockedDomains: CUSTOM_BLOCKED_DOMAINS,
          });
          if (
            verdict.decision !== "ask" ||
            verdict.locked !== true ||
            verdict.category !== "purchase"
          ) {
            violated = true;
            break;
          }
        }
        return {
          ...s,
          purchaseLockBypassViolation:
            s.purchaseLockBypassViolation || violated,
        };
      },
    },
  ];

  return {
    name,
    initial: () => ({
      session: createInitialBrowserCompanionSession({
        sessionId: "formal-sess",
        deviceId: "formal-ext",
        activeTabId: 101,
      }),
      tier: "cautious",
      humanYieldLockViolation: false,
      detachReleaseViolation: false,
      blockedOriginBypassViolation: false,
      purchaseLockBypassViolation: false,
    }),
    canonicalize: (s) =>
      [
        s.session.state,
        s.session.attached ? 1 : 0,
        s.session.debuggerAttached ? 1 : 0,
        s.session.hudVisible ? 1 : 0,
        s.session.botControlHeld ? 1 : 0,
        s.session.resumeSnapshotRequired ? 1 : 0,
        s.session.killSwitched ? 1 : 0,
        s.session.yieldReason ?? "-",
        s.session.pendingApproval ? s.session.pendingApproval.approvalId : "-",
        s.tier,
        s.humanYieldLockViolation ? 1 : 0,
        s.detachReleaseViolation ? 1 : 0,
        s.blockedOriginBypassViolation ? 1 : 0,
        s.purchaseLockBypassViolation ? 1 : 0,
      ].join("|"),
    transitions,
    invariants: [
      {
        name: "humanYieldAndApprovalExclusivity",
        check: (s) => {
          if (s.humanYieldLockViolation) {
            return "人机礼让或审批互斥锁被绕过";
          }
          if (s.session.botControlHeld !== (s.session.state === "controlling")) {
            return `botControlHeld (${s.session.botControlHeld}) 与状态 ${s.session.state} 不一致`;
          }
          if (s.session.state === "yielded_to_human") {
            const readGate = canCompanionBotAct(s.session, { mutating: false });
            const mutateGate = canCompanionBotAct(s.session, { mutating: true });
            if (readGate.allowed || mutateGate.allowed || !s.session.yieldReason) {
              return "yielded_to_human 状态下仍允许 Bot 动作或丢失 yieldReason";
            }
          }
          if (s.session.state === "awaiting_approval") {
            const gate = canCompanionBotAct(s.session, { mutating: false });
            if (gate.allowed || !s.session.pendingApproval) {
              return "awaiting_approval 状态下仍允许 Bot 动作或丢失 pendingApproval";
            }
          }
          if (
            s.session.state === "controlling" &&
            s.session.resumeSnapshotRequired
          ) {
            const mutateGate = canCompanionBotAct(s.session, { mutating: true });
            if (mutateGate.allowed || mutateGate.reason !== "snapshot_required") {
              return "从真人礼让恢复后未强制重抓快照即允许写操作";
            }
          }
          return true;
        },
      },
      {
        name: "detachAndKillSwitchReleaseControl",
        check: (s) => {
          if (s.detachReleaseViolation) {
            return "急停/点×/断连后未彻底释放控制或被非法重启";
          }
          if (s.session.state === "detached") {
            if (
              s.session.attached ||
              s.session.debuggerAttached ||
              s.session.hudVisible ||
              s.session.botControlHeld ||
              s.session.pendingApproval !== null ||
              s.session.yieldReason !== null
            ) {
              return "detached 状态下残留了附着、CDP、HUD 或审批锁";
            }
          }
          if (
            s.session.killSwitched &&
            (s.session.state !== "detached" ||
              s.session.botControlHeld ||
              s.session.debuggerAttached)
          ) {
            return "killSwitched 为 true 时仍处于活跃控制态";
          }
          return true;
        },
      },
      {
        name: "blockedOriginNeverBypassed",
        check: (s) =>
          !s.blockedOriginBypassViolation
            ? true
            : "内置/自定义黑名单域名或受保护协议被绕过",
      },
      {
        name: "purchaseLockNeverBypassed",
        check: (s) =>
          !s.purchaseLockBypassViolation
            ? true
            : "付款/购买强制确认锁被绕过",
      },
    ],
  };
}

function collectReachableStates(model: StateModel<CompanionModelState>) {
  const states = new Map<string, CompanionModelState>();
  const queue: CompanionModelState[] = [model.initial()];
  const initKey = model.canonicalize(queue[0]);
  states.set(initKey, queue[0]);

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current) continue;
    for (const transition of model.transitions) {
      if (!transition.guard(current)) continue;
      const next = transition.apply(current);
      const key = model.canonicalize(next);
      if (!states.has(key)) {
        states.set(key, next);
        queue.push(next);
      }
    }
  }
  return states;
}

describe("浏览器伴侣扩展状态机与权限护栏形式化验证", () => {
  test("BFS 全状态穷举证明人机礼让不丢锁、急停与点×必释放控制、黑名单与付款不可绕过且无死锁", () => {
    const model = createCompanionModel();
    const result = assertModelHolds(model);
    expect(result.ok).toBe(true);
    expect(result.exploredStates).toBeGreaterThan(20);
    expect(result.exploredTransitions).toBeGreaterThan(200);

    // 活性证明：从任意可达状态出发，都存在有限步到达完全释放态 detached，且所有挂起态都可干净退出或恢复。
    const reachable = collectReachableStates(model);
    const detachTransition = model.transitions.find((t) => t.name === "detach");
    const killTransition = model.transitions.find(
      (t) => t.name === "kill_switch",
    );
    expect(detachTransition).toBeDefined();
    expect(killTransition).toBeDefined();

    for (const state of reachable.values()) {
      const afterDetach = detachTransition!.apply(state);
      expect(afterDetach.session.state).toBe("detached");
      expect(afterDetach.session.debuggerAttached).toBe(false);
      expect(afterDetach.session.hudVisible).toBe(false);
      expect(afterDetach.session.botControlHeld).toBe(false);

      const afterKill = killTransition!.apply(state);
      expect(afterKill.session.state).toBe("detached");
      expect(afterKill.session.killSwitched).toBe(true);
      expect(afterKill.session.debuggerAttached).toBe(false);
      expect(afterKill.session.botControlHeld).toBe(false);
    }
  });

  test("fast-check 随机交错事件序列保持所有不变量且纯函数不修改入参", () => {
    const model = createCompanionModel();
    const traceArb = fc.array(
      fc.integer({ min: 0, max: model.transitions.length - 1 }),
      { minLength: 10, maxLength: 60 },
    );

    fc.assert(
      fc.property(traceArb, (indices) => {
        let state = model.initial();
        for (const index of indices) {
          const transition = model.transitions[index % model.transitions.length];
          if (!transition?.guard(state)) continue;
          const snapshotBefore = JSON.stringify(state.session);
          const next = transition.apply(state);
          // 确认纯函数没有原地篡改原状态对象
          expect(JSON.stringify(state.session)).toBe(snapshotBefore);
          state = next;
          for (const inv of model.invariants) {
            expect(inv.check(state)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test("变异体 1 捕杀：礼让态允许 tool_start 直接抢回控制权时被 BFS 精确检出", () => {
    const mutantReducer: ReducerFn = (state, event) => {
      // 缺陷：忘记拦截 yielded_to_human 下的 tool_start，导致 Bot 抢夺真人鼠标
      if (event.type === "tool_start" && state.state === "yielded_to_human") {
        return {
          ...state,
          state: "controlling",
          botControlHeld: true,
          yieldReason: null,
        };
      }
      return reduceBrowserCompanionSession(state, event);
    };

    const result = exploreModel(
      createCompanionModel(
        { reducer: mutantReducer },
        "变异体-人机礼让丢锁抢控",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "humanYieldAndApprovalExclusivity",
    );
    expect(result.counterexample?.actions).toEqual([
      "tool_start",
      "human_input",
      "tool_start",
    ]);
  });

  test("变异体 2 捕杀：急停 kill_switch 漏释放 debuggerAttached 时被 BFS 精确检出", () => {
    const mutantReducer: ReducerFn = (state, event) => {
      if (event.type === "kill_switch") {
        const next = reduceBrowserCompanionSession(state, event);
        // 缺陷：急停后遗留了 debuggerAttached = true
        return {
          ...next,
          debuggerAttached: state.debuggerAttached,
        };
      }
      return reduceBrowserCompanionSession(state, event);
    };

    const result = exploreModel(
      createCompanionModel(
        { reducer: mutantReducer },
        "变异体-急停漏释放CDP",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "detachAndKillSwitchReleaseControl",
    );
    expect(result.counterexample?.actions).toEqual([
      "tool_start",
      "kill_switch",
    ]);
  });

  test("变异体 3 捕杀：full 档绕过付款强制锁时被 BFS 精确检出", () => {
    const mutantAssess: RiskFn = (input) => {
      // 缺陷：在 full 档跳过付款强制确认直接放行
      if (input.tier === "full" && input.operation === "browser_click") {
        return {
          decision: "allow",
          category: "safe",
          reason: "mutant bypassed purchase lock",
        };
      }
      return assessBrowserActionRisk(input);
    };

    const result = exploreModel(
      createCompanionModel(
        { assessRisk: mutantAssess },
        "变异体-full档绕过付款强制锁",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "purchaseLockNeverBypassed",
    );
    expect(result.counterexample?.actions).toEqual([
      "switch_tier_full",
      "probe_purchase_lock",
    ]);
  });

  test("变异体 4 捕杀：忽略域名尾点/大小写导致黑名单被绕过时被 BFS 精确检出", () => {
    const mutantAssess: RiskFn = (input) => {
      // 缺陷：未剥离尾点与小写化，放过 `https://my.1PASSWORD.com.:8443/vault`
      if (input.url?.includes("1PASSWORD.com.")) {
        return {
          decision: "allow",
          category: "safe",
          reason: "mutant missed trailing dot",
        };
      }
      return assessBrowserActionRisk(input);
    };

    const result = exploreModel(
      createCompanionModel(
        { assessRisk: mutantAssess },
        "变异体-尾点大小写绕过黑名单",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "blockedOriginNeverBypassed",
    );
    expect(result.counterexample?.actions).toEqual(["probe_blocked_origin"]);
  });
});
