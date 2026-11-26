import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  type ConditionMode,
  evaluateConditionOutcome,
  resetConditionState,
  revertConditionFire,
  type ScheduleConditionState,
} from "../../shared/schedules";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";

/**
 * 对应 `shared/schedules.ts` 与 `server/src/schedules/service.ts` 的
 * 「定时任务结构化条件基线 + 边沿触发 + 冷却 + 失败回滚 + 规则重置」BFS 形式化模型。
 *
 * 验证四项核心不变量：
 * 1. 冷却期内绝不重复触发；
 * 2. `becomes_met` 持续为真时不重复触发，转假后再转真才触发；
 * 3. 派发失败 `revertConditionFire` 后状态完整回退、不丢失触发机会；
 * 4. 编辑规则重置基线后不沿用旧基线。
 */

type RuleVersion = "ruleA" | "ruleB";
type ProbeValue = "val1" | "val2" | null;

const COOLDOWN_MS = 20;
const TIME_STEP_MS = 10;
const MAX_TIME_MS = 50;
const MAX_EDITS = 1;

interface CondModelState {
  ruleVersion: RuleVersion;
  nowMs: number;
  condition: ScheduleConditionState;
  /** 条件评估放行后等待主动作派发结果的挂起态。 */
  pendingDispatch: {
    prevState: ScheduleConditionState;
    firedAt: number;
  } | null;
  /** 最近一次已确认成功派发的时间戳（失败回滚时不推进）。 */
  lastConfirmedFiredAt: number | null;
  /** 当前规则下自上次转假/重置以来，本轮持续为 true 阶段是否已经确认触发过。 */
  sustainedTrueFired: boolean;
  /** 记录“派发失败并回滚后必须仍可再次触发”的审计标记。 */
  revertedFromUnmetEdge: boolean;
  editCount: number;
  /** 不变式违例标志。 */
  cooldownViolation: boolean;
  becomesMetRepeatViolation: boolean;
  revertIncompleteViolation: boolean;
  lostTriggerAfterRevertViolation: boolean;
  staleBaselineAfterEditViolation: boolean;
}

interface CondModelFaults {
  /** 变异体 1：冷却期未阻断重复触发。 */
  ignoreCooldown?: boolean;
  /** 变异体 2：`becomes_met` 持续为真时允许重复触发。 */
  allowSustainedBecomesMet?: boolean;
  /** 变异体 3：`revertConditionFire` 漏掉回滚 `lastMet`/`baselineValue`。 */
  incompleteRevert?: boolean;
  /** 变异体 4：编辑规则时沿用旧基线与旧边沿状态。 */
  keepBaselineOnRuleEdit?: boolean;
}

function initialCondition(mode: ConditionMode): ScheduleConditionState {
  return {
    conditionPrompt: "ruleA",
    conditionMode: mode,
    cooldownMs: COOLDOWN_MS,
    baselineValue: null,
    lastMet: null,
    lastFiredAt: null,
    lastSkipReason: null,
  };
}

function runEvaluateWithFaults(
  state: Readonly<ScheduleConditionState>,
  probe: { met: boolean; value: ProbeValue },
  nowMs: number,
  faults: CondModelFaults,
) {
  if (faults.ignoreCooldown) {
    const out = evaluateConditionOutcome(
      { ...state, cooldownMs: 0 },
      probe,
      nowMs,
    );
    return {
      ...out,
      nextState: { ...out.nextState, cooldownMs: state.cooldownMs },
    };
  }
  if (
    faults.allowSustainedBecomesMet &&
    state.conditionMode === "becomes_met"
  ) {
    const out = evaluateConditionOutcome(
      { ...state, conditionMode: "each_time_met" },
      probe,
      nowMs,
    );
    return {
      ...out,
      nextState: { ...out.nextState, conditionMode: state.conditionMode },
    };
  }
  return evaluateConditionOutcome(state, probe, nowMs);
}

const PROBE_INPUTS: ReadonlyArray<{
  label: string;
  met: boolean;
  value: ProbeValue;
}> = [
  { label: "true:val1", met: true, value: "val1" },
  { label: "true:val2", met: true, value: "val2" },
  { label: "false:val1", met: false, value: "val1" },
  { label: "false:null", met: false, value: null },
];

const EDIT_MODES: readonly ConditionMode[] = ["becomes_met", "each_time_met"];

function createConditionModel(
  initialMode: ConditionMode = "becomes_met",
  faults: CondModelFaults = {},
  name = "定时任务条件基线与边沿冷却状态机",
): StateModel<CondModelState> {
  return {
    name,
    initial: (): CondModelState => ({
      ruleVersion: "ruleA",
      nowMs: 0,
      condition: initialCondition(initialMode),
      pendingDispatch: null,
      lastConfirmedFiredAt: null,
      sustainedTrueFired: false,
      revertedFromUnmetEdge: false,
      editCount: 0,
      cooldownViolation: false,
      becomesMetRepeatViolation: false,
      revertIncompleteViolation: false,
      lostTriggerAfterRevertViolation: false,
      staleBaselineAfterEditViolation: false,
    }),
    canonicalize: (s) => JSON.stringify(s),
    isTerminal: (s) =>
      s.nowMs >= MAX_TIME_MS &&
      s.pendingDispatch === null &&
      s.editCount >= MAX_EDITS,
    transitions: [
      {
        name: "advanceTime",
        guard: (s) => s.pendingDispatch === null && s.nowMs < MAX_TIME_MS,
        apply: (s): CondModelState => ({
          ...s,
          nowMs: s.nowMs + TIME_STEP_MS,
        }),
      },
      ...PROBE_INPUTS.map((probe) => ({
        name: `probe(${probe.label})`,
        guard: (s: Readonly<CondModelState>) => s.pendingDispatch === null,
        apply: (s: Readonly<CondModelState>): CondModelState => {
          const outcome = runEvaluateWithFaults(
            s.condition,
            { met: probe.met, value: probe.value },
            s.nowMs,
            faults,
          );

          const inCooldown =
            s.lastConfirmedFiredAt !== null &&
            s.nowMs - s.lastConfirmedFiredAt < s.condition.cooldownMs;

          if (outcome.shouldFire) {
            const cooldownViolated = inCooldown;
            const becomesMetViolated =
              s.condition.conditionMode === "becomes_met" &&
              s.sustainedTrueFired;
            return {
              ...s,
              condition: outcome.nextState,
              pendingDispatch: {
                prevState: s.condition,
                firedAt: s.nowMs,
              },
              revertedFromUnmetEdge: false,
              cooldownViolation: s.cooldownViolation || cooldownViolated,
              becomesMetRepeatViolation:
                s.becomesMetRepeatViolation || becomesMetViolated,
            };
          }

          // 若刚才发生过主动作失败回滚且冷却未阻断，同条件下立刻再探测 met=true 必须不得丢失触发机会。
          const lostOpportunity =
            s.revertedFromUnmetEdge && probe.met && !inCooldown;

          return {
            ...s,
            condition: outcome.nextState,
            sustainedTrueFired: probe.met ? s.sustainedTrueFired : false,
            revertedFromUnmetEdge: probe.met ? s.revertedFromUnmetEdge : false,
            lostTriggerAfterRevertViolation:
              s.lostTriggerAfterRevertViolation || lostOpportunity,
          };
        },
      })),
      {
        name: "dispatchSuccess",
        guard: (s) => s.pendingDispatch !== null,
        apply: (s): CondModelState => {
          if (!s.pendingDispatch) return s;
          return {
            ...s,
            lastConfirmedFiredAt: s.pendingDispatch.firedAt,
            sustainedTrueFired: true,
            pendingDispatch: null,
          };
        },
      },
      {
        name: "dispatchFailAndRevert",
        guard: (s) => s.pendingDispatch !== null,
        apply: (s): CondModelState => {
          if (!s.pendingDispatch) return s;
          const prev = s.pendingDispatch.prevState;
          const reverted = faults.incompleteRevert
            ? {
                ...s.condition,
                lastFiredAt: prev.lastFiredAt,
                // 缺陷变异体：漏掉了回滚 lastMet 与 baselineValue
              }
            : revertConditionFire(prev, s.condition);

          const incomplete =
            reverted.baselineValue !== prev.baselineValue ||
            reverted.lastMet !== prev.lastMet ||
            reverted.lastFiredAt !== prev.lastFiredAt ||
            reverted.lastSkipReason !== prev.lastSkipReason;

          return {
            ...s,
            condition: reverted,
            pendingDispatch: null,
            revertedFromUnmetEdge: !s.sustainedTrueFired,
            revertIncompleteViolation:
              s.revertIncompleteViolation || incomplete,
          };
        },
      },
      ...EDIT_MODES.map((nextMode) => ({
        name: `editRule(${nextMode})`,
        guard: (s: Readonly<CondModelState>) =>
          s.pendingDispatch === null && s.editCount < MAX_EDITS,
        apply: (s: Readonly<CondModelState>): CondModelState => {
          const nextCondition = faults.keepBaselineOnRuleEdit
            ? {
                ...s.condition,
                conditionPrompt: "ruleB",
                conditionMode: nextMode,
              }
            : resetConditionState(s.condition, {
                conditionPrompt: "ruleB",
                conditionMode: nextMode,
                cooldownMs: COOLDOWN_MS,
              });

          const stale =
            nextCondition.baselineValue !== null ||
            nextCondition.lastMet !== null ||
            nextCondition.lastFiredAt !== null ||
            nextCondition.lastSkipReason !== null;

          return {
            ...s,
            ruleVersion: "ruleB",
            condition: nextCondition,
            lastConfirmedFiredAt: null,
            sustainedTrueFired: false,
            revertedFromUnmetEdge: false,
            editCount: s.editCount + 1,
            staleBaselineAfterEditViolation:
              s.staleBaselineAfterEditViolation || stale,
          };
        },
      })),
    ],
    invariants: [
      {
        name: "noFireDuringCooldown",
        check: (s) =>
          !s.cooldownViolation ? true : "在冷却期内发生了重复触发",
      },
      {
        name: "becomesMetEdgeOnly",
        check: (s) =>
          !s.becomesMetRepeatViolation
            ? true
            : "becomes_met 模式下条件持续为真时重复触发",
      },
      {
        name: "revertRestoresFullConditionState",
        check: (s) =>
          !s.revertIncompleteViolation && !s.lostTriggerAfterRevertViolation
            ? true
            : "主动作派发失败回滚后未完整恢复状态或丢失触发机会",
      },
      {
        name: "ruleEditResetsBaseline",
        check: (s) =>
          !s.staleBaselineAfterEditViolation
            ? true
            : "编辑条件规则后仍沿用旧基线或旧触发历史",
      },
    ],
  };
}

describe("定时任务条件基线、边沿触发与冷却状态机形式化验证", () => {
  test("BFS 全状态穷举证明 becomes_met 起始下四项核心不变式恒成立", () => {
    const result = assertModelHolds(createConditionModel("becomes_met"));
    expect(result.exploredStates).toBeGreaterThan(100);
    expect(result.exploredTransitions).toBeGreaterThan(300);
  });

  test("BFS 全状态穷举证明 each_time_met 起始下冷却、回滚与规则重置不变式恒成立", () => {
    const result = assertModelHolds(createConditionModel("each_time_met"));
    expect(result.exploredStates).toBeGreaterThan(100);
    expect(result.exploredTransitions).toBeGreaterThan(300);
  });

  test("fast-check 随机交错探测、派发失败回滚与规则编辑永不违背四项不变式", () => {
    const model = createConditionModel("becomes_met");
    const traceArb = fc.array(
      fc.integer({ min: 0, max: model.transitions.length - 1 }),
      { minLength: 1, maxLength: 80 },
    );

    fc.assert(
      fc.property(traceArb, (indices) => {
        let state = model.initial();
        for (const idx of indices) {
          const t = model.transitions[idx % model.transitions.length];
          if (t?.guard(state)) {
            state = t.apply(state);
            for (const inv of model.invariants) {
              expect(inv.check(state)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("变异体 1 捕杀：冷却期内跳过 cooldownMs 校验被 BFS 精确检出", () => {
    const result = exploreModel(
      createConditionModel(
        "each_time_met",
        { ignoreCooldown: true },
        "变异体-冷却失效",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe("noFireDuringCooldown");
    expect(result.counterexample?.actions).toEqual([
      "probe(true:val1)",
      "dispatchSuccess",
      "probe(true:val1)",
    ]);
  });

  test("变异体 2 捕杀：becomes_met 持续为真时重复触发被 BFS 精确检出", () => {
    const result = exploreModel(
      createConditionModel(
        "becomes_met",
        { allowSustainedBecomesMet: true },
        "变异体-becomes_met持续触发",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe("becomesMetEdgeOnly");
    expect(result.counterexample?.actions).toEqual([
      "probe(true:val1)",
      "dispatchSuccess",
      "advanceTime",
      "advanceTime",
      "probe(true:val1)",
    ]);
  });

  test("变异体 3 捕杀：派发失败后未完整回滚 lastMet/baselineValue 被 BFS 精确检出", () => {
    const result = exploreModel(
      createConditionModel(
        "becomes_met",
        { incompleteRevert: true },
        "变异体-回滚不完整",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "revertRestoresFullConditionState",
    );
    expect(result.counterexample?.actions).toEqual([
      "probe(true:val1)",
      "dispatchFailAndRevert",
    ]);
  });

  test("变异体 4 捕杀：编辑条件规则后沿用旧基线被 BFS 精确检出", () => {
    const result = exploreModel(
      createConditionModel(
        "becomes_met",
        { keepBaselineOnRuleEdit: true },
        "变异体-编辑规则未清基线",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "ruleEditResetsBaseline",
    );
  });
});
