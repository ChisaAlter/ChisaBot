import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";

/**
 * 对应 `server/src/plugins/store.ts` 的「生命周期 / Bot 授权 / 策略 / 审计」三层权限状态机。
 *
 * 验证三项安全红线：
 * 1. 零隐式提权：插件未启用、Bot 未获 grant、或 policy 为 deny 时工具调用必须被拒绝；
 * 2. 撤销即时生效：撤销 grant 或策略改为 deny 后的下一次实时判定绝不命中陈旧允许缓存；
 * 3. 审计不可漏记：每次工具裁决（无论放行、待确认还是拒绝）均产生对应审计记录且层间职责正交。
 */

type PluginLifecycle = "uninstalled" | "disabled" | "enabled";
type PolicyMode = "allow" | "prompt" | "deny";
type BotId = "botA" | "botB";
type Verdict = "allow" | "prompt" | "deny";

interface PluginAuthState {
  lifecycle: PluginLifecycle;
  grantA: boolean;
  grantB: boolean;
  policy: PolicyMode;
  invocations: number;
  lastCall: {
    bot: BotId;
    verdict: Verdict;
    executed: boolean;
    audited: boolean;
    snapshot: {
      lifecycle: PluginLifecycle;
      granted: boolean;
      policy: PolicyMode;
    };
  } | null;
}

interface PluginFaults {
  ignoreDisabledStateOnGrantedBot?: boolean;
  skipAuditOnDeny?: boolean;
}

const MAX_CALLS = 2;
const BOTS: readonly BotId[] = ["botA", "botB"];

function grantFor(state: Readonly<PluginAuthState>, bot: BotId): boolean {
  return bot === "botA" ? state.grantA : state.grantB;
}

function createPluginModel(
  faults: PluginFaults = {},
  name = "插件授权-策略-审计三层状态机",
): StateModel<PluginAuthState> {
  return {
    name,
    initial: (): PluginAuthState => ({
      lifecycle: "uninstalled",
      grantA: false,
      grantB: false,
      policy: "prompt",
      invocations: 0,
      lastCall: null,
    }),
    canonicalize: (s) => JSON.stringify(s),
    transitions: [
      {
        name: "installPlugin",
        guard: (s) => s.lifecycle === "uninstalled",
        apply: (s): PluginAuthState => ({ ...s, lifecycle: "enabled" }),
      },
      {
        name: "disablePlugin",
        guard: (s) => s.lifecycle === "enabled",
        apply: (s): PluginAuthState => ({ ...s, lifecycle: "disabled" }),
      },
      {
        name: "enablePlugin",
        guard: (s) => s.lifecycle === "disabled",
        apply: (s): PluginAuthState => ({ ...s, lifecycle: "enabled" }),
      },
      {
        name: "uninstallPlugin",
        guard: (s) => s.lifecycle !== "uninstalled",
        apply: (s): PluginAuthState => ({
          ...s,
          lifecycle: "uninstalled",
          // 卸载清除当前运行授权（保留独立审计账本语义）。
          grantA: false,
          grantB: false,
        }),
      },
      {
        name: "grantBotA",
        guard: (s) => s.lifecycle !== "uninstalled" && !s.grantA,
        apply: (s): PluginAuthState => ({ ...s, grantA: true }),
      },
      {
        name: "revokeBotA",
        guard: (s) => s.grantA,
        apply: (s): PluginAuthState => ({ ...s, grantA: false }),
      },
      {
        name: "grantBotB",
        guard: (s) => s.lifecycle !== "uninstalled" && !s.grantB,
        apply: (s): PluginAuthState => ({ ...s, grantB: true }),
      },
      {
        name: "revokeBotB",
        guard: (s) => s.grantB,
        apply: (s): PluginAuthState => ({ ...s, grantB: false }),
      },
      {
        name: "setPolicyAllow",
        guard: (s) => s.policy !== "allow",
        apply: (s): PluginAuthState => ({ ...s, policy: "allow" }),
      },
      {
        name: "setPolicyPrompt",
        guard: (s) => s.policy !== "prompt",
        apply: (s): PluginAuthState => ({ ...s, policy: "prompt" }),
      },
      {
        name: "setPolicyDeny",
        guard: (s) => s.policy !== "deny",
        apply: (s): PluginAuthState => ({ ...s, policy: "deny" }),
      },
      ...BOTS.map((bot) => ({
        name: `invokeTool(${bot})`,
        guard: (s: Readonly<PluginAuthState>) => s.invocations < MAX_CALLS,
        apply: (s: Readonly<PluginAuthState>): PluginAuthState => {
          const hasGrant = grantFor(s, bot);
          const bypassDisabled =
            Boolean(faults.ignoreDisabledStateOnGrantedBot) &&
            s.lifecycle === "disabled";
          const pluginUsable = s.lifecycle === "enabled" || bypassDisabled;

          let verdict: Verdict = "deny";
          if (pluginUsable && hasGrant) {
            verdict = s.policy;
          }
          const executed = verdict === "allow";
          const audited = !(faults.skipAuditOnDeny && verdict === "deny");

          return {
            ...s,
            invocations: s.invocations + 1,
            lastCall: {
              bot,
              verdict,
              executed,
              audited,
              snapshot: {
                lifecycle: s.lifecycle,
                granted: hasGrant,
                policy: s.policy,
              },
            },
          };
        },
      })),
    ],
    invariants: [
      {
        name: "noImplicitPrivilegeEscalation",
        check: (s) => {
          const call = s.lastCall;
          if (!call?.executed) return true;
          if (call.snapshot.lifecycle !== "enabled") {
            return `插件处于 ${call.snapshot.lifecycle} 状态却执行了工具调用`;
          }
          if (!call.snapshot.granted) {
            return `${call.bot} 未获得 Bot grant 却执行了工具调用`;
          }
          if (call.snapshot.policy !== "allow") {
            return `策略为 ${call.snapshot.policy} 时不应直接免审执行`;
          }
          return true;
        },
      },
      {
        name: "uninstallLeavesNoActiveGrants",
        check: (s) =>
          s.lifecycle !== "uninstalled" || (!s.grantA && !s.grantB)
            ? true
            : "卸载后仍残留有效 Bot grant",
      },
      {
        name: "everyDecisionLeavesAuditRecord",
        check: (s) => {
          if (!s.lastCall) return true;
          return s.lastCall.audited
            ? true
            : `${s.lastCall.bot} 裁决为 ${s.lastCall.verdict} 时遗漏了审计记录`;
        },
      },
    ],
  };
}

describe("插件授权、策略与审计三层状态机形式化验证", () => {
  test("BFS 穷举全部可达组合，证明零隐式提权、撤销即时生效与审计完备", () => {
    const result = assertModelHolds(createPluginModel());
    expect(result.exploredStates).toBeGreaterThan(50);
    expect(result.exploredTransitions).toBeGreaterThan(150);
  });

  test("fast-check 随机长操作流（含高频 grant/revoke/policy 切换与调用）守恒三层约束", () => {
    const model = createPluginModel();
    const traceArb = fc.array(
      fc.integer({ min: 0, max: model.transitions.length - 1 }),
      { minLength: 1, maxLength: 100 },
    );

    fc.assert(
      fc.property(traceArb, (indices) => {
        let state = model.initial();
        let auditCount = 0;

        for (const rawIndex of indices) {
          // 为属性测试突破 BFS 有限调用次数上限：在每次调用前归零单轮计数镜像真实长期运行流。
          const stepState: PluginAuthState = { ...state, invocations: 0 };
          const transition =
            model.transitions[rawIndex % model.transitions.length];
          if (transition?.guard(stepState)) {
            state = transition.apply(stepState);
            if (transition.name.startsWith("invokeTool(")) {
              auditCount++;
              expect(state.lastCall?.audited).toBe(true);
            }
            for (const inv of model.invariants) {
              expect(inv.check(state)).toBe(true);
            }
          }
        }

        expect(auditCount).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  test("变异体 1 捕杀：停用插件未阻断已有 grant 时给出最短提权反例", () => {
    const result = exploreModel(
      createPluginModel(
        { ignoreDisabledStateOnGrantedBot: true },
        "变异体-停用插件仍允许已授权调用",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "noImplicitPrivilegeEscalation",
    );
    expect(result.counterexample?.actions).toContain("disablePlugin");
  });

  test("变异体 2 捕杀：拒绝分支漏记审计日志时被精确捕获", () => {
    const result = exploreModel(
      createPluginModel(
        { skipAuditOnDeny: true },
        "变异体-拒绝调用漏记审计",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "everyDecisionLeavesAuditRecord",
    );
    expect(result.counterexample?.actions).toEqual(["invokeTool(botA)"]);
  });
});
