import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";

/**
 * 对应 `server/src/local-conversations.ts` 的单会话回合租约与栅栏令牌（fencing token）模型。
 *
 * 验证三项核心性质：
 * 1. 互斥性：同一线程同一时刻至多只有 1 个运行中回合；
 * 2. 栅栏隔离：过期 epoch 的迟到提交/释放绝不能影响已新开回合的租约或写入账本；
 * 3. 无死锁活性：取消请求、正常结束或租约过期后，等待方终能重新拿锁推进会话。
 */

type WorkerId = "reqA" | "reqB";

interface InFlightAttempt {
  worker: WorkerId;
  epoch: number;
  expiredOrAborted: boolean;
}

interface LockState {
  currentEpoch: number;
  leaseHolder: { worker: WorkerId; epoch: number; abortRequested: boolean } | null;
  runningAttempts: readonly InFlightAttempt[];
  committedEpochs: readonly number[];
  illegalDoubleRunDetected: boolean;
  illegalStaleReleaseDetected: boolean;
  illegalStaleWriteDetected: boolean;
}

interface LockFaults {
  releaseWithoutEpochCheck?: boolean;
  writebackWithoutEpochCheck?: boolean;
}

const WORKERS: readonly WorkerId[] = ["reqA", "reqB"];
const MAX_EPOCH = 3;

function createLockModel(
  faults: LockFaults = {},
  name = "会话回合租约与栅栏锁",
): StateModel<LockState> {
  return {
    name,
    initial: (): LockState => ({
      currentEpoch: 0,
      leaseHolder: null,
      runningAttempts: [],
      committedEpochs: [],
      illegalDoubleRunDetected: false,
      illegalStaleReleaseDetected: false,
      illegalStaleWriteDetected: false,
    }),
    canonicalize: (s) =>
      JSON.stringify({
        e: s.currentEpoch,
        h: s.leaseHolder,
        r: s.runningAttempts,
        c: s.committedEpochs,
        d1: s.illegalDoubleRunDetected,
        d2: s.illegalStaleReleaseDetected,
        d3: s.illegalStaleWriteDetected,
      }),
    isTerminal: (s) =>
      s.currentEpoch >= MAX_EPOCH &&
      s.leaseHolder === null &&
      s.runningAttempts.length === 0,
    transitions: [
      ...WORKERS.map((worker) => ({
        name: `acquire(${worker})`,
        guard: (s: Readonly<LockState>) =>
          s.leaseHolder === null &&
          s.currentEpoch < MAX_EPOCH &&
          !s.runningAttempts.some((a) => a.worker === worker),
        apply: (s: Readonly<LockState>): LockState => {
          const nextEpoch = s.currentEpoch + 1;
          const activeCount = s.runningAttempts.filter(
            (a) => !a.expiredOrAborted,
          ).length;
          return {
            ...s,
            currentEpoch: nextEpoch,
            leaseHolder: { worker, epoch: nextEpoch, abortRequested: false },
            runningAttempts: [
              ...s.runningAttempts,
              { worker, epoch: nextEpoch, expiredOrAborted: false },
            ],
            illegalDoubleRunDetected:
              s.illegalDoubleRunDetected || activeCount > 0,
          };
        },
      })),
      ...WORKERS.map((worker) => ({
        name: `requestAbort(${worker})`,
        guard: (s: Readonly<LockState>) =>
          s.leaseHolder !== null && !s.leaseHolder.abortRequested,
        apply: (s: Readonly<LockState>): LockState =>
          s.leaseHolder
            ? {
                ...s,
                leaseHolder: { ...s.leaseHolder, abortRequested: true },
              }
            : s,
      })),
      {
        name: "leaseTimeoutReclaim",
        guard: (s) => s.leaseHolder !== null,
        apply: (s): LockState => {
          const holder = s.leaseHolder;
          if (!holder) return s;
          return {
            ...s,
            leaseHolder: null,
            // 原回合仍在慢速扫尾中，但已被标记过期（滞留工作项等待后续栅栏校验拦截）。
            runningAttempts: s.runningAttempts.map((a) =>
              a.epoch === holder.epoch ? { ...a, expiredOrAborted: true } : a,
            ),
          };
        },
      },
      ...WORKERS.map((worker) => ({
        name: `finishCommitAndRelease(${worker})`,
        guard: (s: Readonly<LockState>) =>
          s.runningAttempts.some((a) => a.worker === worker),
        apply: (s: Readonly<LockState>): LockState => {
          const attempt = s.runningAttempts.find((a) => a.worker === worker);
          if (!attempt) return s;

          const remaining = s.runningAttempts.filter(
            (a) => a.epoch !== attempt.epoch,
          );
          const holdsCurrentLease =
            s.leaseHolder !== null &&
            s.leaseHolder.worker === worker &&
            s.leaseHolder.epoch === attempt.epoch &&
            !s.leaseHolder.abortRequested;

          const staleWriteAllowed = Boolean(faults.writebackWithoutEpochCheck);
          const staleReleaseAllowed = Boolean(faults.releaseWithoutEpochCheck);

          let nextCommitted = s.committedEpochs;
          let staleWriteFlag = s.illegalStaleWriteDetected;
          if (holdsCurrentLease) {
            nextCommitted = [...s.committedEpochs, attempt.epoch];
          } else if (staleWriteAllowed && !s.committedEpochs.includes(attempt.epoch)) {
            nextCommitted = [...s.committedEpochs, attempt.epoch];
            staleWriteFlag = true;
          }

          let nextHolder = s.leaseHolder;
          let staleReleaseFlag = s.illegalStaleReleaseDetected;
          if (
            s.leaseHolder &&
            s.leaseHolder.worker === worker &&
            s.leaseHolder.epoch === attempt.epoch
          ) {
            nextHolder = null;
          } else if (
            staleReleaseAllowed &&
            s.leaseHolder &&
            s.leaseHolder.epoch !== attempt.epoch
          ) {
            // 缺陷变异体：未核对 leaseEpoch 直接清理活动锁，破坏互斥租约。
            nextHolder = null;
            staleReleaseFlag = true;
          }

          return {
            ...s,
            leaseHolder: nextHolder,
            runningAttempts: remaining,
            committedEpochs: nextCommitted,
            illegalStaleReleaseDetected: staleReleaseFlag,
            illegalStaleWriteDetected: staleWriteFlag,
          };
        },
      })),
    ],
    invariants: [
      {
        name: "singleActiveLeaseExclusion",
        check: (s) => {
          if (s.illegalDoubleRunDetected) {
            return "检测到并发未过期工作项重入";
          }
          const liveAttempts = s.runningAttempts.filter(
            (a) => !a.expiredOrAborted,
          );
          return liveAttempts.length <= 1
            ? true
            : `同时存在 ${liveAttempts.length} 个未过期运行中回合`;
        },
      },
      {
        name: "fencingTokenProtectsLeaseAndTranscript",
        check: (s) => {
          if (s.illegalStaleReleaseDetected) {
            return "过期回合误释放了当前新回合的租约";
          }
          if (s.illegalStaleWriteDetected) {
            return "已过期或已取消回合越过栅栏写入了对话记录";
          }
          return true;
        },
      },
      {
        name: "committedEpochsStrictlyIncreasing",
        check: (s) => {
          for (let i = 1; i < s.committedEpochs.length; i++) {
            const prev = s.committedEpochs[i - 1] ?? 0;
            const curr = s.committedEpochs[i] ?? 0;
            if (curr <= prev) {
              return `提交 epoch 非严格递增: [${s.committedEpochs.join(",")}]`;
            }
          }
          return true;
        },
      },
    ],
  };
}

describe("会话回合租约与栅栏锁形式化验证", () => {
  test("BFS 全可达状态空间证明互斥性、栅栏隔离与无死锁活性", () => {
    const result = assertModelHolds(createLockModel());
    expect(result.exploredStates).toBeGreaterThan(20);
    expect(result.exploredTransitions).toBeGreaterThan(40);
  });

  test("fast-check 随机长交错指令序列保持租约不变式", () => {
    const model = createLockModel();
    const actionArb = fc.array(
      fc.integer({ min: 0, max: model.transitions.length - 1 }),
      { minLength: 1, maxLength: 80 },
    );

    fc.assert(
      fc.property(actionArb, (indices) => {
        let state = model.initial();
        for (const rawIndex of indices) {
          const transition =
            model.transitions[rawIndex % model.transitions.length];
          if (transition?.guard(state)) {
            state = transition.apply(state);
            for (const inv of model.invariants) {
              expect(inv.check(state)).toBe(true);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  test("变异体 1 捕杀：释放锁漏检 leaseEpoch 时给出最短反例路径", () => {
    const result = exploreModel(
      createLockModel(
        { releaseWithoutEpochCheck: true },
        "变异体-释放锁漏检epoch",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "fencingTokenProtectsLeaseAndTranscript",
    );
    expect(result.counterexample?.actions.length).toBeGreaterThanOrEqual(4);
  });

  test("变异体 2 捕杀：过期/被中止回合漏检栅栏令牌写回时被精确拦截", () => {
    const result = exploreModel(
      createLockModel(
        { writebackWithoutEpochCheck: true },
        "变异体-迟到写回漏检栅栏",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "fencingTokenProtectsLeaseAndTranscript",
    );
    expect(result.counterexample?.actions.length).toBeGreaterThanOrEqual(2);
  });
});
