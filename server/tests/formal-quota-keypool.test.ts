import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";
import {
  applyKeyResultToPool,
  type ModelPoolKey,
  selectKeyFromPool,
} from "../src/conversations/key-pool";
import {
  aggregateUsageRows,
  evaluateQuotaAdmission,
  type UsageLedgerRow,
  type UserQuotaRecord,
} from "../src/quotas/service";

/**
 * CB-045：同 Provider 多 Key 粘性轮换池 + 每用户配额准入控制形式化验证。
 *
 * 模型 1（Key Pool 状态机）验证不变量：
 * 1. 非空粘性保证：当池内存在至少一把未冷却且未禁用 Key 时，任意 `stickyKey` 必返回健康 Key，
 *    且在无新失败发生时连续对同一 `stickyKey` 选择结果始终稳定不变；
 * 2. 全池耗尽精确阻断：当全部可用 Key 均处于冷却期时，`selectKeyFromPool` 必返回 `key: null`
 *    以及严格大于 `now` 的最早恢复时间戳 `nextAvailableAt`；
 * 3. 冷却期满必可恢复：时间推进跨过 `nextAvailableAt` 后，至少有一把 Key 自动恢复健康并重新参与选择。
 *
 * 模型 2（配额与异步流结算状态机）验证不变量：
 * 1. 硬配额严格阻断：非管理员或 `bypassAdmin: false` 管理员一旦日请求数、日 Token 或月 Token
 *    达到或超过上限，准入判定必须返回 `allowed: false`；
 * 2. 管理员仅在 `bypassAdmin === true` 时豁免，且在途流异步结算后账本与准入判定仍精确同步；
 * 3. UTC 跨日清零日计数（保留月计数）、UTC 跨月清零月计数后自动恢复准入。
 */

interface KeyPoolVerifyState {
  keys: readonly ModelPoolKey[];
  now: number;
  selectParity: 0 | 1;
  lastStickyAKeyId: string | null;
  lastStickyAHealthMask: string | null;
  lastSelectionResult: {
    selectedId: string | null;
    nextAvailableAt: number | null;
    hadHealthyCandidate: boolean;
  } | null;
  stickyDriftDetected: boolean;
  recoveryFailureDetected: boolean;
}

interface KeyPoolMutants {
  cooldownNeverRecovers?: boolean;
  breakStickySelection?: boolean;
}

const POOL_BASE_TIME = 1_700_000_000_000;
const STICKY_A = "thread-alpha";
const STICKY_B = "thread-beta";

function selectWithMutant(
  keys: readonly ModelPoolKey[],
  stickyKey: string,
  now: number,
  parity: 0 | 1,
  mutants: KeyPoolMutants,
) {
  let effectiveKeys = keys;
  if (mutants.cooldownNeverRecovers) {
    effectiveKeys = keys.map((item) =>
      item.cooldownUntil !== undefined
        ? { ...item, cooldownUntil: now + 1 }
        : item,
    );
  }
  if (
    mutants.breakStickySelection &&
    parity === 1 &&
    effectiveKeys.length === 3
  ) {
    const first = effectiveKeys[0];
    const second = effectiveKeys[1];
    const third = effectiveKeys[2];
    if (first && second && third) {
      effectiveKeys = [second, third, first];
    }
  }
  return selectKeyFromPool(effectiveKeys, stickyKey, now);
}

function createKeyPoolModel(
  mutants: KeyPoolMutants = {},
  name = "多Key粘性轮换池与冷却恢复状态机",
): StateModel<KeyPoolVerifyState> {
  const initialKeys: ModelPoolKey[] = [
    { id: "k1", label: "主Key-1", apiKey: "sk-1" },
    { id: "k2", label: "备Key-2", apiKey: "sk-2" },
    { id: "k3", label: "备Key-3", apiKey: "sk-3" },
  ];

  const hasHealthy = (keys: readonly ModelPoolKey[], now: number) =>
    keys.some(
      (item) =>
        !item.disabled &&
        (item.cooldownUntil === undefined || item.cooldownUntil <= now),
    );

  const healthMask = (keys: readonly ModelPoolKey[], now: number) =>
    keys
      .map((item) =>
        !item.disabled &&
        (item.cooldownUntil === undefined || item.cooldownUntil <= now)
          ? "1"
          : "0",
      )
      .join("");

  return {
    name,
    allowStutterWhenNoEnabledTransition: true,
    initial: (): KeyPoolVerifyState => ({
      keys: initialKeys,
      now: POOL_BASE_TIME,
      selectParity: 0,
      lastStickyAKeyId: null,
      lastStickyAHealthMask: null,
      lastSelectionResult: null,
      stickyDriftDetected: false,
      recoveryFailureDetected: false,
    }),
    canonicalize: (state) =>
      JSON.stringify({
        keys: state.keys.map((item) => ({
          id: item.id,
          remaining:
            item.cooldownUntil !== undefined && item.cooldownUntil > state.now
              ? item.cooldownUntil - state.now
              : 0,
        })),
        selectParity: state.selectParity,
        lastStickyAKeyId: state.lastStickyAKeyId,
        lastStickyAHealthMask: state.lastStickyAHealthMask,
        stickyDriftDetected: state.stickyDriftDetected,
        recoveryFailureDetected: state.recoveryFailureDetected,
        lastNull: state.lastSelectionResult?.selectedId ?? null,
        lastHadHealthy: state.lastSelectionResult?.hadHealthyCandidate ?? null,
      }),
    transitions: [
      {
        name: "selectStickyA",
        guard: () => true,
        apply: (state) => {
          const healthyBefore = hasHealthy(state.keys, state.now);
          const currentMask = healthMask(state.keys, state.now);
          const sel = selectWithMutant(
            state.keys,
            STICKY_A,
            state.now,
            state.selectParity,
            mutants,
          );
          const drifted =
            healthyBefore &&
            state.lastStickyAHealthMask === currentMask &&
            state.lastStickyAKeyId !== null &&
            sel.key?.id !== state.lastStickyAKeyId;
          return {
            ...state,
            selectParity: state.selectParity === 0 ? 1 : 0,
            lastStickyAKeyId: sel.key?.id ?? state.lastStickyAKeyId,
            lastStickyAHealthMask: currentMask,
            lastSelectionResult: {
              selectedId: sel.key?.id ?? null,
              nextAvailableAt: sel.nextAvailableAt,
              hadHealthyCandidate: healthyBefore,
            },
            stickyDriftDetected: state.stickyDriftDetected || drifted,
          };
        },
      },
      {
        name: "selectStickyB",
        guard: () => true,
        apply: (state) => {
          const healthyBefore = hasHealthy(state.keys, state.now);
          const sel = selectWithMutant(
            state.keys,
            STICKY_B,
            state.now,
            state.selectParity,
            mutants,
          );
          return {
            ...state,
            lastSelectionResult: {
              selectedId: sel.key?.id ?? null,
              nextAvailableAt: sel.nextAvailableAt,
              hadHealthyCandidate: healthyBefore,
            },
          };
        },
      },
      ...(["k1", "k2", "k3"] as const).flatMap((keyId) => [
        {
          name: `fail429Short(${keyId})`,
          guard: (state: Readonly<KeyPoolVerifyState>) => {
            const target = state.keys.find((item) => item.id === keyId);
            return (
              target !== undefined &&
              (target.cooldownUntil === undefined ||
                target.cooldownUntil <= state.now)
            );
          },
          apply: (state: Readonly<KeyPoolVerifyState>): KeyPoolVerifyState => {
            const nextKeys = applyKeyResultToPool(
              state.keys,
              keyId,
              429,
              { "retry-after": "5" },
              state.now,
            );
            return {
              ...state,
              keys: nextKeys,
              lastSelectionResult: null,
            };
          },
        },
        {
          name: `fail429Medium(${keyId})`,
          guard: (state: Readonly<KeyPoolVerifyState>) => {
            const target = state.keys.find((item) => item.id === keyId);
            return (
              target !== undefined &&
              (target.cooldownUntil === undefined ||
                target.cooldownUntil <= state.now)
            );
          },
          apply: (state: Readonly<KeyPoolVerifyState>): KeyPoolVerifyState => {
            const nextKeys = applyKeyResultToPool(
              state.keys,
              keyId,
              429,
              { "retry-after": "10" },
              state.now,
            );
            return {
              ...state,
              keys: nextKeys,
              lastSelectionResult: null,
            };
          },
        },
      ]),
      {
        name: "succeedStickyA",
        guard: (state) => state.lastStickyAKeyId !== null,
        apply: (state) => {
          const id = state.lastStickyAKeyId ?? "";
          const nextKeys = applyKeyResultToPool(
            state.keys,
            id,
            200,
            undefined,
            state.now,
          );
          return { ...state, keys: nextKeys, lastSelectionResult: null };
        },
      },
      {
        name: "advanceToNextRecovery",
        guard: (state) =>
          state.keys.some(
            (item) =>
              item.cooldownUntil !== undefined &&
              item.cooldownUntil > state.now,
          ),
        apply: (state) => {
          const futureTimes = state.keys
            .map((item) => item.cooldownUntil)
            .filter((ts): ts is number => ts !== undefined && ts > state.now);
          const nextTs = Math.min(...futureTimes);
          const sel = selectWithMutant(
            state.keys,
            STICKY_A,
            nextTs,
            state.selectParity,
            mutants,
          );
          const nextKeysNormalized = state.keys.map((item) => {
            if (
              item.cooldownUntil !== undefined &&
              item.cooldownUntil <= nextTs
            ) {
              const { cooldownUntil: _c, lastStatus: _s, ...rest } = item;
              return rest;
            }
            return item;
          });
          return {
            ...state,
            keys: nextKeysNormalized,
            now: nextTs,
            lastStickyAKeyId: sel.key?.id ?? null,
            lastStickyAHealthMask: null,
            lastSelectionResult: null,
            recoveryFailureDetected:
              state.recoveryFailureDetected || sel.key === null,
          };
        },
      },
    ],
    invariants: [
      {
        name: "recoveryAfterCooldown",
        check: (state) =>
          !state.recoveryFailureDetected ||
          "时间跨过冷却截止时间后密钥仍未能自动恢复健康",
      },
      {
        name: "stickyStabilityWhenHealthy",
        check: (state) =>
          !state.stickyDriftDetected ||
          "同一 stickyKey 在上次选中密钥仍健康时发生了粘性漂移",
      },
      {
        name: "healthyPoolNeverExhaustedAndExhaustedReturnsRetryAt",
        check: (state) => {
          const last = state.lastSelectionResult;
          if (!last) return true;
          if (last.hadHealthyCandidate && last.selectedId === null) {
            return "存在未冷却 Key 时 selectKeyFromPool 返回了 null";
          }
          if (!last.hadHealthyCandidate) {
            if (last.selectedId !== null) {
              return "全池均处于冷却期时却违规返回了密钥";
            }
            if (
              last.nextAvailableAt === null ||
              last.nextAvailableAt <= state.now
            ) {
              return "全池耗尽时未返回严格大于当前时间的 nextAvailableAt";
            }
          }
          return true;
        },
      },
    ],
  };
}

function createLongCooldownPoolModel(): StateModel<KeyPoolVerifyState> {
  const initialKeys: ModelPoolKey[] = [
    { id: "k1", label: "主Key-1", apiKey: "sk-1" },
    { id: "k2", label: "备Key-2", apiKey: "sk-2" },
  ];
  return {
    name: "402/401长周期冷却全池耗尽与恢复状态机",
    allowStutterWhenNoEnabledTransition: true,
    initial: (): KeyPoolVerifyState => ({
      keys: initialKeys,
      now: POOL_BASE_TIME,
      selectParity: 0,
      lastStickyAKeyId: null,
      lastStickyAHealthMask: null,
      lastSelectionResult: null,
      stickyDriftDetected: false,
      recoveryFailureDetected: false,
    }),
    canonicalize: (s) =>
      JSON.stringify({
        states: s.keys.map((item) =>
          item.cooldownUntil !== undefined && item.cooldownUntil > s.now
            ? `${item.id}:${item.lastStatus}`
            : `${item.id}:healthy`,
        ),
        recovered: s.recoveryFailureDetected,
        lastId: s.lastSelectionResult?.selectedId ?? null,
      }),
    transitions: [
      {
        name: "select",
        guard: () => true,
        apply: (s) => {
          const hadHealthy = s.keys.some(
            (k) => k.cooldownUntil === undefined || k.cooldownUntil <= s.now,
          );
          const sel = selectKeyFromPool(s.keys, STICKY_A, s.now);
          return {
            ...s,
            lastSelectionResult: {
              selectedId: sel.key?.id ?? null,
              nextAvailableAt: sel.nextAvailableAt,
              hadHealthyCandidate: hadHealthy,
            },
          };
        },
      },
      {
        name: "fail402(k1)",
        guard: (s) => {
          const k1 = s.keys[0];
          return Boolean(
            k1 && (!k1.cooldownUntil || k1.cooldownUntil <= s.now),
          );
        },
        apply: (s) => ({
          ...s,
          keys: applyKeyResultToPool(s.keys, "k1", 402, undefined, s.now),
        }),
      },
      {
        name: "fail401(k2)",
        guard: (s) => {
          const k2 = s.keys[1];
          return Boolean(
            k2 && (!k2.cooldownUntil || k2.cooldownUntil <= s.now),
          );
        },
        apply: (s) => ({
          ...s,
          keys: applyKeyResultToPool(s.keys, "k2", 401, undefined, s.now),
        }),
      },
      {
        name: "advanceToFirstAvailable",
        guard: (s) =>
          s.keys.some(
            (k) => k.cooldownUntil !== undefined && k.cooldownUntil > s.now,
          ),
        apply: (s) => {
          const futureTimes = s.keys
            .map((k) => k.cooldownUntil)
            .filter((ts): ts is number => ts !== undefined && ts > s.now);
          const nextTs = Math.min(...futureTimes);
          const sel = selectKeyFromPool(s.keys, STICKY_A, nextTs);
          const normalized = s.keys.map((item) => {
            if (
              item.cooldownUntil !== undefined &&
              item.cooldownUntil <= nextTs
            ) {
              const { cooldownUntil: _c, lastStatus: _s, ...rest } = item;
              return rest;
            }
            return item;
          });
          return {
            ...s,
            keys: normalized,
            now: nextTs,
            recoveryFailureDetected:
              s.recoveryFailureDetected || sel.key === null,
          };
        },
      },
    ],
    invariants: [
      {
        name: "recoveryAfterLongCooldown",
        check: (s) =>
          !s.recoveryFailureDetected ||
          "402/401 长周期冷却到期后未能恢复可用密钥",
      },
      {
        name: "allCooledReturnsMinNextAvailableAt",
        check: (s) => {
          const last = s.lastSelectionResult;
          if (!last) return true;
          if (!last.hadHealthyCandidate) {
            return (
              last.selectedId === null &&
              last.nextAvailableAt !== null &&
              last.nextAvailableAt > s.now
            );
          }
          return last.selectedId !== null;
        },
      },
    ],
  };
}

interface QuotaVerifyState {
  isAdmin: boolean;
  bypassAdmin: boolean;
  dayIndex: 0 | 1 | 2;
  dailyRequests: number;
  dailyTokens: number;
  monthlyTokens: number;
  inFlightStreams: number;
  lastDeniedByQuota: boolean;
  quotaViolationDetected: boolean;
}

interface QuotaMutants {
  allowAtExactLimit?: boolean;
  ignoreBypassAdminFlag?: boolean;
}

const DAY_TIMESTAMPS = [
  Date.UTC(2026, 4, 10, 12, 0, 0),
  Date.UTC(2026, 4, 11, 12, 0, 0),
  Date.UTC(2026, 5, 1, 12, 0, 0),
] as const;
const DAY_LABELS = ["2026-05-10", "2026-05-11", "2026-06-01"] as const;

const DAILY_REQ_LIMIT = 2;
const DAILY_TOK_LIMIT = 100;
const MONTHLY_TOK_LIMIT = 200;

function checkAdmissionForModel(
  state: Readonly<QuotaVerifyState>,
  mutants: QuotaMutants,
) {
  const now = DAY_TIMESTAMPS[state.dayIndex];
  const day = DAY_LABELS[state.dayIndex];
  const quota: UserQuotaRecord = {
    userId: "user-1",
    dailyRequestLimit: DAILY_REQ_LIMIT,
    dailyTokenLimit: DAILY_TOK_LIMIT,
    monthlyTokenLimit: MONTHLY_TOK_LIMIT,
    bypassAdmin: mutants.ignoreBypassAdminFlag ? true : state.bypassAdmin,
    updatedBy: "admin",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
  const rows: UsageLedgerRow[] = [
    {
      userId: "user-1",
      day,
      model: "gpt-4o",
      inputTokens: state.dailyTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      requests: state.dailyRequests,
    },
  ];
  if (state.monthlyTokens > state.dailyTokens && state.dayIndex === 1) {
    rows.push({
      userId: "user-1",
      day: DAY_LABELS[0],
      model: "gpt-4o",
      inputTokens: state.monthlyTokens - state.dailyTokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      requests: 0,
    });
  }
  const usage = aggregateUsageRows(rows, day);
  if (mutants.allowAtExactLimit) {
    const tweaked: UserQuotaRecord = {
      ...quota,
      dailyRequestLimit:
        quota.dailyRequestLimit !== null ? quota.dailyRequestLimit + 1 : null,
      dailyTokenLimit:
        quota.dailyTokenLimit !== null ? quota.dailyTokenLimit + 1 : null,
      monthlyTokenLimit:
        quota.monthlyTokenLimit !== null ? quota.monthlyTokenLimit + 1 : null,
    };
    return evaluateQuotaAdmission({
      quota: tweaked,
      isAdmin: state.isAdmin,
      usage,
      now,
    });
  }
  return evaluateQuotaAdmission({
    quota,
    isAdmin: state.isAdmin,
    usage,
    now,
  });
}

function createQuotaModel(
  mutants: QuotaMutants = {},
  name = "用户日/月配额准入与流式异步结算状态机",
): StateModel<QuotaVerifyState> {
  return {
    name,
    allowStutterWhenNoEnabledTransition: true,
    initial: (): QuotaVerifyState => ({
      isAdmin: false,
      bypassAdmin: true,
      dayIndex: 0,
      dailyRequests: 0,
      dailyTokens: 0,
      monthlyTokens: 0,
      inFlightStreams: 0,
      lastDeniedByQuota: false,
      quotaViolationDetected: false,
    }),
    canonicalize: (s) => JSON.stringify(s),
    transitions: [
      {
        name: "admitAndStartStream",
        guard: (s) => s.inFlightStreams < 2,
        apply: (s) => {
          const decision = checkAdmissionForModel(s, mutants);
          const shouldBeExempt = s.isAdmin && s.bypassAdmin;
          const overLimit =
            s.dailyRequests >= DAILY_REQ_LIMIT ||
            s.dailyTokens >= DAILY_TOK_LIMIT ||
            s.monthlyTokens >= MONTHLY_TOK_LIMIT;

          const violated =
            (!shouldBeExempt && overLimit && decision.allowed) ||
            (shouldBeExempt && !decision.allowed);

          if (!decision.allowed) {
            return {
              ...s,
              lastDeniedByQuota: true,
              quotaViolationDetected: s.quotaViolationDetected || violated,
            };
          }
          return {
            ...s,
            inFlightStreams: s.inFlightStreams + 1,
            lastDeniedByQuota: false,
            quotaViolationDetected: s.quotaViolationDetected || violated,
          };
        },
      },
      {
        name: "settleStream(50tokens)",
        guard: (s) => s.inFlightStreams > 0,
        apply: (s) => ({
          ...s,
          inFlightStreams: s.inFlightStreams - 1,
          dailyRequests: Math.min(3, s.dailyRequests + 1),
          dailyTokens: Math.min(200, s.dailyTokens + 50),
          monthlyTokens: Math.min(300, s.monthlyTokens + 50),
          lastDeniedByQuota: false,
        }),
      },
      {
        name: "settleStream(100tokens)",
        guard: (s) => s.inFlightStreams > 0,
        apply: (s) => ({
          ...s,
          inFlightStreams: s.inFlightStreams - 1,
          dailyRequests: Math.min(3, s.dailyRequests + 1),
          dailyTokens: Math.min(200, s.dailyTokens + 100),
          monthlyTokens: Math.min(300, s.monthlyTokens + 100),
          lastDeniedByQuota: false,
        }),
      },
      {
        name: "rolloverUtcDay",
        guard: (s) => s.dayIndex === 0 && s.inFlightStreams === 0,
        apply: (s) => ({
          ...s,
          dayIndex: 1,
          dailyRequests: 0,
          dailyTokens: 0,
          lastDeniedByQuota: false,
        }),
      },
      {
        name: "rolloverUtcMonth",
        guard: (s) => s.dayIndex < 2 && s.inFlightStreams === 0,
        apply: (s) => ({
          ...s,
          dayIndex: 2,
          dailyRequests: 0,
          dailyTokens: 0,
          monthlyTokens: 0,
          lastDeniedByQuota: false,
        }),
      },
      {
        name: "switchToAdmin",
        guard: (s) => !s.isAdmin,
        apply: (s) => ({ ...s, isAdmin: true }),
      },
      {
        name: "toggleBypassAdmin",
        guard: () => true,
        apply: (s) => ({ ...s, bypassAdmin: !s.bypassAdmin }),
      },
    ],
    invariants: [
      {
        name: "nonBypassedUserBlockedAtLimit",
        check: (s) =>
          !s.quotaViolationDetected ||
          "非豁免用户在达到配额上限后仍被准入，或应豁免管理员被错误拦截",
      },
      {
        name: "dailyNeverExceedsMonthly",
        check: (s) =>
          s.dailyTokens <= s.monthlyTokens ||
          "日累计 Token 不可能超过同月累计 Token",
      },
    ],
  };
}

describe("Key Pool 与配额服务形式化模型检验", () => {
  test("BFS 全状态穷举证明 Key Pool 粘性稳定、全池耗尽返回恢复时刻及期满自动恢复", () => {
    const result = assertModelHolds(createKeyPoolModel());
    expect(result.exploredStates).toBeGreaterThan(20);
    expect(result.exploredTransitions).toBeGreaterThan(50);

    const longResult = assertModelHolds(createLongCooldownPoolModel());
    expect(longResult.exploredStates).toBeGreaterThan(5);
  });

  test("BFS 全状态穷举证明非豁免用户在任意异步结算与 UTC 跨日/月边界下均受硬配额严格保护", () => {
    const result = assertModelHolds(createQuotaModel());
    expect(result.exploredStates).toBeGreaterThan(30);
    expect(result.exploredTransitions).toBeGreaterThan(80);
  });

  test("fast-check 性质验证：任意 Key 池配置下均满足粘性、耗尽与时间恢复性质", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.array(fc.constantFrom(200, 429, 402, 401), {
          minLength: 1,
          maxLength: 20,
        }),
        (keyCount, stickyKey, statuses) => {
          const baseTime = 1_700_000_000_000;
          let keys: ModelPoolKey[] = Array.from(
            { length: keyCount },
            (_, idx) => ({
              id: `k-${idx}`,
              label: `Key-${idx}`,
              apiKey: `sk-${idx}`,
            }),
          );
          let now = baseTime;
          for (const status of statuses) {
            const first = selectKeyFromPool(keys, stickyKey, now);
            const second = selectKeyFromPool(keys, stickyKey, now);
            expect(second.key?.id ?? null).toBe(first.key?.id ?? null);

            if (first.key) {
              keys = applyKeyResultToPool(
                keys,
                first.key.id,
                status,
                { "retry-after": "10" },
                now,
              );
            } else if (first.nextAvailableAt !== null) {
              now = first.nextAvailableAt;
              const afterRecover = selectKeyFromPool(keys, stickyKey, now);
              expect(afterRecover.key).not.toBeNull();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("变异体 1 捕杀：Key 冷却永不过期故障被 BFS 精准检出反例", () => {
    const result = exploreModel(
      createKeyPoolModel(
        { cooldownNeverRecovers: true },
        "变异体-Key冷却永不恢复",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "recoveryAfterCooldown",
    );
  });

  test("变异体 2 捕杀：Key 选择破坏粘性映射时被 BFS 精准捕获", () => {
    const result = exploreModel(
      createKeyPoolModel({ breakStickySelection: true }, "变异体-粘性哈希漂移"),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "stickyStabilityWhenHealthy",
    );
  });

  test("变异体 3 捕杀：配额阈值偏移 (> 代替 >=) 在边界值误放行被 BFS 精确捕获", () => {
    const result = exploreModel(
      createQuotaModel({ allowAtExactLimit: true }, "变异体-配额阈值边界错位"),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "nonBypassedUserBlockedAtLimit",
    );
  });

  test("变异体 4 捕杀：忽略管理员 bypassAdmin=false 开关时被 BFS 精确捕获", () => {
    const result = exploreModel(
      createQuotaModel(
        { ignoreBypassAdminFlag: true },
        "变异体-忽略管理员豁免开关",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "nonBypassedUserBlockedAtLimit",
    );
  });
});
