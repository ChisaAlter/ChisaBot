import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";

/**
 * 对应 `server/src/approvals/service.ts` 与 `server/src/approvals/execute.ts`
 * 的「一次性敏感操作审批门（CAS 消费 + 载荷摘要绑定 + 多副本并发防重入）」形式化模型。
 *
 * 验证三项不变量：
 * 1. 至多执行一次（at-most-once）：无论多副本如何并发读取同一 `approved` 审批单，`executedCount <= 1`；
 * 2. 终态不可逆：一旦进入 `denied`、`expired`、`consumed` 或 `finished`，绝不可回退再审批或重执行；
 * 3. 参数摘要与审批人身份绑定：参数篡改（`digestB !== approvedDigest`）或非所有者成员审批绝不放行。
 */

type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "consumed"
  | "finished";
type Digest = "digestA" | "digestB";
type ReplicaId = "replica1" | "replica2";

interface ApprovalState {
  ownerId: "owner";
  status: ApprovalStatus;
  approvedDigest: Digest;
  currentPayloadDigest: Digest;
  executedCount: number;
  /** 两个副本各自缓存的旧快照状态（模拟读-审-写 TOCTOU 并发窗口）。 */
  cachedSnapshotR1: ApprovalStatus | null;
  cachedSnapshotR2: ApprovalStatus | null;
  illegalAuthBypassDetected: boolean;
}

interface ApprovalFaults {
  nonAtomicConsumeUsesSnapshot?: boolean;
  ignoreDigestMismatch?: boolean;
  allowNonOwnerApprove?: boolean;
}

const REPLICAS: readonly ReplicaId[] = ["replica1", "replica2"];

function createApprovalModel(
  faults: ApprovalFaults = {},
  name = "一次性审批门与多副本CAS消费状态机",
): StateModel<ApprovalState> {
  return {
    name,
    initial: (): ApprovalState => ({
      ownerId: "owner",
      status: "pending",
      approvedDigest: "digestA",
      currentPayloadDigest: "digestA",
      executedCount: 0,
      cachedSnapshotR1: null,
      cachedSnapshotR2: null,
      illegalAuthBypassDetected: false,
    }),
    canonicalize: (s) => JSON.stringify(s),
    isTerminal: (s) =>
      s.status === "denied" ||
      s.status === "expired" ||
      s.status === "finished",
    transitions: [
      {
        name: "ownerApprove",
        guard: (s) => s.status === "pending",
        apply: (s): ApprovalState => ({ ...s, status: "approved" }),
      },
      {
        name: "memberAttemptApprove",
        guard: (s) => s.status === "pending" && Boolean(faults.allowNonOwnerApprove),
        apply: (s): ApprovalState => ({
          ...s,
          status: "approved",
          illegalAuthBypassDetected: true,
        }),
      },
      {
        name: "ownerDeny",
        guard: (s) => s.status === "pending" || s.status === "approved",
        apply: (s): ApprovalState => ({ ...s, status: "denied" }),
      },
      {
        name: "expireRequest",
        guard: (s) => s.status === "pending" || s.status === "approved",
        apply: (s): ApprovalState => ({ ...s, status: "expired" }),
      },
      {
        name: "tamperTargetPayloadDigest",
        guard: (s) =>
          s.currentPayloadDigest === "digestA" &&
          (s.status === "pending" || s.status === "approved"),
        apply: (s): ApprovalState => ({
          ...s,
          currentPayloadDigest: "digestB",
        }),
      },
      ...REPLICAS.map((replica) => ({
        name: `readSnapshot(${replica})`,
        guard: (s: Readonly<ApprovalState>) =>
          replica === "replica1"
            ? s.cachedSnapshotR1 !== s.status
            : s.cachedSnapshotR2 !== s.status,
        apply: (s: Readonly<ApprovalState>): ApprovalState =>
          replica === "replica1"
            ? { ...s, cachedSnapshotR1: s.status }
            : { ...s, cachedSnapshotR2: s.status },
      })),
      ...REPLICAS.map((replica) => ({
        name: `tryConsumeAndExecute(${replica})`,
        guard: (s: Readonly<ApprovalState>) =>
          replica === "replica1"
            ? s.cachedSnapshotR1 === "approved"
            : s.cachedSnapshotR2 === "approved",
        apply: (s: Readonly<ApprovalState>): ApprovalState => {
          const snapshotOk =
            (replica === "replica1" ? s.cachedSnapshotR1 : s.cachedSnapshotR2) ===
            "approved";
          const liveCasOk = s.status === "approved";
          const digestMatches = s.currentPayloadDigest === s.approvedDigest;

          const consumeOk =
            (faults.nonAtomicConsumeUsesSnapshot ? snapshotOk : liveCasOk) &&
            (faults.ignoreDigestMismatch || digestMatches);

          const clearSnapshot =
            replica === "replica1"
              ? { cachedSnapshotR1: "finished" as ApprovalStatus }
              : { cachedSnapshotR2: "finished" as ApprovalStatus };

          if (!consumeOk) {
            return { ...s, ...clearSnapshot };
          }

          return {
            ...s,
            ...clearSnapshot,
            status: "consumed",
            executedCount: s.executedCount + 1,
          };
        },
      })),
      {
        name: "finishAfterConsume",
        guard: (s) => s.status === "consumed",
        apply: (s): ApprovalState => ({ ...s, status: "finished" }),
      },
    ],
    invariants: [
      {
        name: "atMostOnceExecution",
        check: (s) =>
          s.executedCount <= 1
            ? true
            : `同一审批单被并发重复执行了 ${s.executedCount} 次`,
      },
      {
        name: "payloadDigestBinding",
        check: (s) =>
          s.executedCount === 0 || s.currentPayloadDigest === s.approvedDigest
            ? true
            : `载荷摘要已被篡改为 ${s.currentPayloadDigest}（原审批 ${s.approvedDigest}）却仍被执行`,
      },
      {
        name: "ownerAuthorityRequired",
        check: (s) =>
          !s.illegalAuthBypassDetected
            ? true
            : "非所有者普通成员越权批准了审批单",
      },
      {
        name: "consumedNeverMovesBackToPendingOrApproved",
        check: (s) =>
          s.executedCount === 0 ||
          s.status === "consumed" ||
          s.status === "finished"
            ? true
            : `已执行审批回退到了非终态 ${s.status}`,
      },
    ],
  };
}

describe("一次性审批门与多副本 CAS 状态机形式化验证", () => {
  test("BFS 全状态穷举证明至多执行一次、摘要强绑定与终态不可逆", () => {
    const result = assertModelHolds(createApprovalModel());
    expect(result.exploredStates).toBeGreaterThan(25);
    expect(result.exploredTransitions).toBeGreaterThan(60);
  });

  test("fast-check 并发副本随机交错执行永不触发二次执行或参数篡改放行", () => {
    const model = createApprovalModel();
    const traceArb = fc.array(
      fc.integer({ min: 0, max: model.transitions.length - 1 }),
      { minLength: 1, maxLength: 60 },
    );

    fc.assert(
      fc.property(traceArb, (indices) => {
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

  test("变异体 1 捕杀：多副本仅凭陈旧快照消费而未做原子 CAS 时检出二次执行", () => {
    const result = exploreModel(
      createApprovalModel(
        { nonAtomicConsumeUsesSnapshot: true },
        "变异体-非原子消费竞态",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe("atMostOnceExecution");
    expect(result.counterexample?.actions).toEqual([
      "ownerApprove",
      "readSnapshot(replica1)",
      "readSnapshot(replica2)",
      "tryConsumeAndExecute(replica1)",
      "tryConsumeAndExecute(replica2)",
    ]);
  });

  test("变异体 2 捕杀：消费审批单时跳过 actionDigest 一致性校验被精确捕获", () => {
    const result = exploreModel(
      createApprovalModel(
        { ignoreDigestMismatch: true },
        "变异体-忽略载荷摘要绑定",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe("payloadDigestBinding");
    expect(result.counterexample?.actions).toEqual([
      "ownerApprove",
      "tamperTargetPayloadDigest",
      "readSnapshot(replica1)",
      "tryConsumeAndExecute(replica1)",
    ]);
  });
});
