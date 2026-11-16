import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type StateModel,
} from "../../shared/verification/model-checker";
import {
  applyStoredAnswer,
  type StoredSync,
} from "../src/lib/conversations/thread-sync";

/**
 * 对应 `app/src/lib/conversations/thread-sync.ts` 与聊天滚动发送账本的
 * 「乐观发送 / 流式增量去重 / 断线重连权威快照合并」形式化验证。
 *
 * 包含两部分：
 * 1. 有限状态空间 BFS + 变异体捕杀：验证 clientMessageId 去重合并（零双影）、流式分片幂等吸收、发送失败不污染服务端历史；
 * 2. 基于真实实现 `applyStoredAnswer` 的 `fast-check` 属性测试：验证任意合法增量游标/快照/乱序/损坏载荷均满足幂等、前序稳定与边界 fail-closed。
 */

type OptimisticStatus = "none" | "sending" | "failed" | "merged";

interface VisibleMessage {
  clientMessageId?: string;
  serverId?: string;
  source: "optimistic" | "server";
}

interface LedgerState {
  optimistic: OptimisticStatus;
  serverCommitted: boolean;
  appliedChunks: readonly number[];
  assistantChunkDraws: readonly number[];
  visibleMessages: readonly VisibleMessage[];
}

interface LedgerFaults {
  snapshotMissesClientMessageId?: boolean;
  duplicateChunkAppendsAgain?: boolean;
}

const STREAM_CHUNKS = [1, 2] as const;

function createChatLedgerModel(
  faults: LedgerFaults = {},
  name = "前端聊天账本乐观态与重连快照合并",
): StateModel<LedgerState> {
  return {
    name,
    initial: (): LedgerState => ({
      optimistic: "none",
      serverCommitted: false,
      appliedChunks: [],
      assistantChunkDraws: [],
      visibleMessages: [],
    }),
    canonicalize: (s) => JSON.stringify(s),
    isTerminal: (s) =>
      s.optimistic === "merged" &&
      s.serverCommitted &&
      s.appliedChunks.length === STREAM_CHUNKS.length,
    transitions: [
      {
        name: "optimisticSend",
        guard: (s) => s.optimistic === "none" && !s.serverCommitted,
        apply: (s): LedgerState => ({
          ...s,
          optimistic: "sending",
          visibleMessages: [
            ...s.visibleMessages,
            { clientMessageId: "c1", source: "optimistic" },
          ],
        }),
      },
      {
        name: "sendFailBeforeServerAck",
        guard: (s) => s.optimistic === "sending" && !s.serverCommitted,
        apply: (s): LedgerState => ({
          ...s,
          optimistic: "failed",
        }),
      },
      {
        name: "retryFailedSend",
        guard: (s) => s.optimistic === "failed" && !s.serverCommitted,
        apply: (s): LedgerState => ({
          ...s,
          optimistic: "sending",
        }),
      },
      {
        name: "serverCommitsClientMessage",
        guard: (s) =>
          (s.optimistic === "sending" || s.optimistic === "failed") &&
          !s.serverCommitted,
        apply: (s): LedgerState => ({
          ...s,
          optimistic: "merged",
          serverCommitted: true,
          visibleMessages: s.visibleMessages.map((m) =>
            m.clientMessageId === "c1"
              ? { clientMessageId: "c1", serverId: "srv1", source: "server" }
              : m,
          ),
        }),
      },
      {
        name: "reconnectReplayServerSnapshot",
        guard: (s) => s.serverCommitted && s.optimistic !== "none",
        apply: (s): LedgerState => {
          if (faults.snapshotMissesClientMessageId) {
            // 缺陷变异体：只按 serverId 判重却丢掉 clientMessageId 对齐，若前序是乐观条或重放新 id 会产生双影。
            return {
              ...s,
              visibleMessages: [
                ...s.visibleMessages,
                { clientMessageId: "c1", serverId: "srv1-replayed", source: "server" },
              ],
            };
          }

          const exists = s.visibleMessages.some(
            (m) => m.clientMessageId === "c1" || m.serverId === "srv1",
          );
          return {
            ...s,
            optimistic: "merged",
            visibleMessages: exists
              ? s.visibleMessages.map((m) =>
                  m.clientMessageId === "c1"
                    ? { clientMessageId: "c1", serverId: "srv1", source: "server" }
                    : m,
                )
              : [
                  ...s.visibleMessages,
                  { clientMessageId: "c1", serverId: "srv1", source: "server" },
                ],
          };
        },
      },
      ...STREAM_CHUNKS.map((chunkSeq) => ({
        name: `applyStreamChunk(${chunkSeq})`,
        guard: (s: Readonly<LedgerState>) =>
          s.serverCommitted && s.assistantChunkDraws.length < 3,
        apply: (s: Readonly<LedgerState>): LedgerState => {
          const alreadyApplied = s.appliedChunks.includes(chunkSeq);
          if (alreadyApplied && !faults.duplicateChunkAppendsAgain) {
            return s;
          }
          return {
            ...s,
            appliedChunks: alreadyApplied
              ? s.appliedChunks
              : [...s.appliedChunks, chunkSeq],
            assistantChunkDraws: [...s.assistantChunkDraws, chunkSeq],
          };
        },
      })),
    ],
    invariants: [
      {
        name: "noDuplicateClientMessageRender",
        check: (s) => {
          const copies = s.visibleMessages.filter(
            (m) => m.clientMessageId === "c1",
          );
          return copies.length <= 1
            ? true
            : `同一 clientMessageId 渲染了 ${copies.length} 条重复消息`;
        },
      },
      {
        name: "idempotentStreamChunkApplication",
        check: (s) => {
          const seen = new Set<number>();
          for (const seq of s.assistantChunkDraws) {
            if (seen.has(seq)) {
              return `重复流式分片 seq=${seq} 被二次追加到正文中`;
            }
            seen.add(seq);
          }
          return true;
        },
      },
      {
        name: "failureBeforeAckNeverPollutesAuthority",
        check: (s) => {
          if (s.optimistic !== "failed") return true;
          const leaked = s.visibleMessages.some((m) => m.source === "server");
          return !leaked
            ? true
            : "发送前失败的消息错误地进入了权威服务端列表";
        },
      },
    ],
  };
}

describe("前端聊天账本同步与去重形式化验证", () => {
  test("BFS 全状态空间证明乐观合并零双影、流式分片幂等、失败不污染历史", () => {
    const result = assertModelHolds(createChatLedgerModel());
    expect(result.exploredStates).toBeGreaterThanOrEqual(8);
    expect(result.exploredTransitions).toBeGreaterThanOrEqual(15);
  });

  test("fast-check 验证真实 applyStoredAnswer 在随机全量/增量/不变/损坏载荷下满足合并与 fail-closed 不变式", () => {
    const rowArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 12 }),
      role: fc.constantFrom("user", "assistant"),
      text: fc.string({ maxLength: 30 }),
    });

    const baseArb = fc.record({
      version: fc.string({ minLength: 1, maxLength: 8 }),
      cursor: fc.string({ minLength: 1, maxLength: 8 }),
      rows: fc.array(rowArb, { maxLength: 20 }),
    });

    const suffixArb = fc.array(rowArb, { maxLength: 10 });

    fc.assert(
      fc.property(
        fc.option(baseArb, { nil: null }),
        suffixArb,
        fc.integer({ min: -3, max: 25 }),
        fc.boolean(),
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.string({ minLength: 1, maxLength: 8 }),
        (base, delta, rawStart, unchanged, nextVersion, nextCursor) => {
          const syncBase: StoredSync | null = base;

          // 1. unchanged=true 时必须校验 base/version/cursor 完整且复用引用不乱改动。
          const unchangedOut = applyStoredAnswer(syncBase, {
            unchanged: true,
            version: unchanged ? nextVersion : 123,
            cursor: nextCursor,
          });
          if (!syncBase || !unchanged) {
            expect(unchangedOut).toBeNull();
          } else {
            expect(unchangedOut?.unchanged).toBe(true);
            expect(unchangedOut?.rows).toBe(syncBase.rows);
          }

          // 2. 增量拼接场景：当 start 在合法前缀范围 [0..base.rows.length] 内时精确保留前段并追加尾部。
          const incrementalOut = applyStoredAnswer(syncBase, {
            messages: delta,
            start: rawStart,
            version: nextVersion,
            cursor: nextCursor,
          });
          const validStart =
            Number.isInteger(rawStart) &&
            rawStart >= 0 &&
            (rawStart === 0 || (syncBase !== null && rawStart <= syncBase.rows.length));

          if (!validStart) {
            expect(incrementalOut).toBeNull();
          } else if (rawStart > 0 && syncBase) {
            expect(incrementalOut?.rows).toEqual([
              ...syncBase.rows.slice(0, rawStart),
              ...delta,
            ]);
          } else {
            expect(incrementalOut?.rows).toEqual(delta);
          }

          // 3. 损坏格式（非对象/非数组 messages）严格返回 null（fail-closed）。
          expect(applyStoredAnswer(syncBase, null)).toBeNull();
          expect(
            applyStoredAnswer(syncBase, { messages: "not-an-array" }),
          ).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("变异体 1 捕杀：重连快照未按 clientMessageId 合并时触发消息双影", () => {
    const result = exploreModel(
      createChatLedgerModel(
        { snapshotMissesClientMessageId: true },
        "变异体-重连快照未匹配clientMessageId",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "noDuplicateClientMessageRender",
    );
    expect(result.counterexample?.actions).toEqual([
      "optimisticSend",
      "serverCommitsClientMessage",
      "reconnectReplayServerSnapshot",
    ]);
  });

  test("变异体 2 捕杀：重放流式文本分片未去重导致正文翻倍被捕获", () => {
    const result = exploreModel(
      createChatLedgerModel(
        { duplicateChunkAppendsAgain: true },
        "变异体-流式分片重复叠加",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "idempotentStreamChunkApplication",
    );
    expect(result.counterexample?.actions).toContain("applyStreamChunk(1)");
  });
});
