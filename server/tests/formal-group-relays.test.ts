import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertModelHolds,
  exploreModel,
  type ModelTransition,
  type StateModel,
} from "../../shared/verification/model-checker";
import {
  evaluateGroupRelayGuard,
  GROUP_BOT_COOLDOWN_MS,
  GROUP_PAIR_PINGPONG_LIMIT,
  GROUP_RELAY_MAX_DEPTH,
  type GroupRelayGuardDecision,
  type GroupRelayGuardInput,
  mentionedPeers,
  relayPairKey,
} from "../src/channels/group";

/**
 * 多 Bot 群聊接力防死循环形式化验证。
 *
 * 覆盖拓扑：自环（A->A）、双向乒乓（A<->B）、三节点环（A->B->C->A）与同时 @ 多人扇出。
 * 证明性质：
 * 1. 最大深度不变量：所有入队接力 `depth <= GROUP_RELAY_MAX_DEPTH`；
 * 2. 无无限乒乓与有限终止性：任意 `(speaker -> peer)` 触发次数 `<= GROUP_PAIR_PINGPONG_LIMIT`，
 *    所有可达路径在有限步内终止，无自循环永动或死锁；
 * 3. 冷却与扇出边界：冷却窗内同一目标 Bot 被 `"cooldown_cap"` 阻断，单轮扇出不越 `maxPerRun`。
 */

type BotId = "A" | "B" | "C";

const BOTS: readonly BotId[] = ["A", "B", "C"];
const DEFAULT_MAX_PER_RUN = 2;
const BASE_CLOCK_MS = 10_000;
const MAX_POSSIBLE_PAIR_HOPS =
  BOTS.length * BOTS.length * GROUP_PAIR_PINGPONG_LIMIT;

interface PendingTurn {
  bot: BotId;
  depth: number;
}

interface GroupRelayModelState {
  queue: readonly PendingTurn[];
  pairCounts: Readonly<Record<string, number>>;
  cooledBots: readonly BotId[];
  maxDepthViolated: boolean;
  fanOutExceeded: boolean;
  cooldownViolation: boolean;
  fanOutUsed: number;
}

type GuardEvaluator = (input: GroupRelayGuardInput) => GroupRelayGuardDecision;

interface RelayModelOptions {
  name?: string;
  maxDepth?: number;
  maxPerRun?: number;
  guard?: GuardEvaluator;
  mode?: "cycle-and-cooldown" | "fanout-tree";
}

function canonicalPairCounts(counts: Readonly<Record<string, number>>): string {
  return Object.keys(counts)
    .sort()
    .map((key) => `${key}:${counts[key] ?? 0}`)
    .join(",");
}

function totalRelays(counts: Readonly<Record<string, number>>): number {
  let sum = 0;
  for (const value of Object.values(counts)) {
    sum += value;
  }
  return sum;
}

function createGroupRelayModel(
  options: RelayModelOptions = {},
): StateModel<GroupRelayModelState> {
  const maxDepth = options.maxDepth ?? GROUP_RELAY_MAX_DEPTH;
  const maxPerRun = options.maxPerRun ?? DEFAULT_MAX_PER_RUN;
  const guard: GuardEvaluator = options.guard ?? evaluateGroupRelayGuard;
  const mode = options.mode ?? "cycle-and-cooldown";

  const evalForState = (
    state: Readonly<GroupRelayModelState>,
    speaker: BotId,
    peer: BotId,
    depth: number,
    fanOutIndex: number,
    pairCountsSnapshot: Readonly<Record<string, number>>,
  ): GroupRelayGuardDecision => {
    const inCooldown = state.cooledBots.includes(peer);
    return guard({
      depth,
      maxDepth,
      speakerId: speaker,
      peerId: peer,
      pairCounts: pairCountsSnapshot,
      lastRelayedAtMs: inCooldown ? BASE_CLOCK_MS : null,
      nowMs: BASE_CLOCK_MS,
      fanOutIndex,
      maxPerRun,
      quotaAllowed: true,
      granted: true,
    });
  };

  const singleHopTransitions: ModelTransition<GroupRelayModelState>[] = [];
  for (const speaker of BOTS) {
    for (const peer of BOTS) {
      const label =
        speaker === peer
          ? `selfLoop(${speaker}->${peer})`
          : `relay(${speaker}->${peer})`;
      singleHopTransitions.push({
        name: label,
        guard: (s) => s.queue[0]?.bot === speaker,
        apply: (s): GroupRelayModelState => {
          const head = s.queue[0];
          if (!head) return s;
          const rest = s.queue.slice(1);
          const wasCooled = s.cooledBots.includes(peer);
          const decision = evalForState(
            s,
            speaker,
            peer,
            head.depth,
            0,
            s.pairCounts,
          );
          if (!decision.allowed) {
            return {
              ...s,
              queue: rest,
            };
          }
          const nextDepth = head.depth + 1;
          const nextCooled =
            mode === "cycle-and-cooldown"
              ? s.cooledBots.includes(peer)
                ? s.cooledBots
                : [...s.cooledBots, peer].sort()
              : [];
          return {
            ...s,
            queue: [...rest, { bot: peer, depth: nextDepth }],
            pairCounts: {
              ...s.pairCounts,
              [decision.pairKey]: decision.nextPairCount,
            },
            cooledBots: nextCooled,
            maxDepthViolated:
              s.maxDepthViolated || nextDepth > GROUP_RELAY_MAX_DEPTH,
            cooldownViolation: s.cooldownViolation || wasCooled,
          };
        },
      });
    }
  }

  const transitions: ModelTransition<GroupRelayModelState>[] = [
    ...singleHopTransitions,
    {
      name: "finishWithoutMention",
      guard: (s) => s.queue.length > 0,
      apply: (s) => ({
        ...s,
        queue: s.queue.slice(1),
      }),
    },
  ];

  if (mode === "cycle-and-cooldown") {
    transitions.push({
      name: "cooldownWindowPasses",
      guard: (s) => s.queue.length > 0 && s.cooledBots.length > 0,
      apply: (s) => ({
        ...s,
        cooledBots: [],
      }),
    });
  } else {
    transitions.push({
      name: "fanOutAllPeers",
      guard: (s) =>
        s.queue.length === 1 &&
        s.fanOutUsed === 0 &&
        (s.queue[0]?.depth ?? 0) >= 3,
      apply: (s): GroupRelayModelState => {
        const head = s.queue[0];
        if (!head) return s;
        const rest = s.queue.slice(1);
        const targets = BOTS.filter((b) => b !== head.bot).concat(head.bot);
        const nextCounts: Record<string, number> = { ...s.pairCounts };
        const enqueued: PendingTurn[] = [];
        let depthExceeded = s.maxDepthViolated;

        for (const [index, peer] of targets.entries()) {
          const decision = evalForState(
            s,
            head.bot,
            peer,
            head.depth,
            index,
            nextCounts,
          );
          if (!decision.allowed) continue;
          nextCounts[decision.pairKey] = decision.nextPairCount;
          const childDepth = head.depth + 1;
          enqueued.push({ bot: peer, depth: childDepth });
          if (childDepth > GROUP_RELAY_MAX_DEPTH) depthExceeded = true;
        }

        return {
          ...s,
          queue: [...rest, ...enqueued],
          pairCounts: nextCounts,
          cooledBots: [],
          maxDepthViolated: depthExceeded,
          fanOutExceeded: s.fanOutExceeded || enqueued.length > maxPerRun,
          fanOutUsed: s.fanOutUsed + 1,
        };
      },
    });
  }

  return {
    name:
      options.name ??
      (mode === "fanout-tree"
        ? "多 Bot 群聊同时扇出模型"
        : "多 Bot 群聊环形接力与冷却模型"),
    initial: (): GroupRelayModelState => ({
      queue: [{ bot: "A", depth: 0 }],
      pairCounts: {},
      cooledBots: [],
      maxDepthViolated: false,
      fanOutExceeded: false,
      cooldownViolation: false,
      fanOutUsed: 0,
    }),
    canonicalize: (s) =>
      JSON.stringify({
        q: s.queue,
        p: canonicalPairCounts(s.pairCounts),
        c: s.cooledBots,
        md: s.maxDepthViolated,
        fe: s.fanOutExceeded,
        cv: s.cooldownViolation,
        fu: s.fanOutUsed,
      }),
    isTerminal: (s) => s.queue.length === 0,
    transitions,
    invariants: [
      {
        name: "maxRelayDepthInvariant",
        check: (s) => {
          if (s.maxDepthViolated) {
            return `入队接力深度超过硬上限 ${GROUP_RELAY_MAX_DEPTH}`;
          }
          for (const item of s.queue) {
            if (item.depth > GROUP_RELAY_MAX_DEPTH) {
              return `队列项 ${item.bot} 深度 ${item.depth} 超过硬上限 ${GROUP_RELAY_MAX_DEPTH}`;
            }
          }
          return true;
        },
      },
      {
        name: "pairPingpongAndTerminationInvariant",
        check: (s) => {
          for (const [pair, count] of Object.entries(s.pairCounts)) {
            if (count > GROUP_PAIR_PINGPONG_LIMIT) {
              return `接力对 ${pair} 触发 ${count} 次，超过上限 ${GROUP_PAIR_PINGPONG_LIMIT}`;
            }
          }
          const relayCount = totalRelays(s.pairCounts);
          if (relayCount > MAX_POSSIBLE_PAIR_HOPS) {
            return `累计接受接力数 ${relayCount} 超过有限图上界 ${MAX_POSSIBLE_PAIR_HOPS}`;
          }
          return true;
        },
      },
      {
        name: "fanOutAndCooldownInvariant",
        check: (s) => {
          if (s.fanOutExceeded) {
            return `单轮扇出数量超过 maxPerRun=${maxPerRun}`;
          }
          if (s.cooldownViolation) {
            return "冷却窗内重复接力未被阻断";
          }
          return true;
        },
      },
    ],
  };
}

describe("多 Bot 群聊接力防死循环形式化证明", () => {
  test("BFS 全状态空间证明：自环、双向乒乓、三节点环与冷却窗恒守深度上限与有限终结", () => {
    const result = assertModelHolds(
      createGroupRelayModel({
        maxDepth: GROUP_RELAY_MAX_DEPTH,
        maxPerRun: DEFAULT_MAX_PER_RUN,
        mode: "cycle-and-cooldown",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.exploredStates).toBeGreaterThan(200);
    expect(result.exploredTransitions).toBeGreaterThan(500);

    // 真实 mentionedPeers 也从词法层面拒绝自环（A->A）。
    const roster = BOTS.map((id) => ({ id, name: id }));
    expect(mentionedPeers("@A @B @C", roster, "A").map((b) => b.id)).toEqual([
      "B",
      "C",
    ]);
  });

  test("BFS 全状态空间证明：同时 @ 多人扇出在任意深度分支下仍受 maxPerRun、pingpong 与 depth 约束", () => {
    const result = assertModelHolds(
      createGroupRelayModel({
        maxDepth: GROUP_RELAY_MAX_DEPTH,
        maxPerRun: DEFAULT_MAX_PER_RUN,
        mode: "fanout-tree",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.exploredStates).toBeGreaterThan(100);
    expect(result.exploredTransitions).toBeGreaterThan(200);
  });

  test("fast-check 随机拓扑与时序属性测试直连真实 evaluateGroupRelayGuard", () => {
    const stepArb = fc.record({
      targets: fc.array(fc.constantFrom<BotId>("A", "B", "C"), {
        minLength: 0,
        maxLength: 5,
      }),
      advanceMs: fc.integer({ min: 0, max: GROUP_BOT_COOLDOWN_MS * 2 }),
      quotaAllowed: fc.boolean(),
      grantedMask: fc.integer({ min: 0, max: 7 }),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 4 }),
        fc.array(stepArb, { minLength: 1, maxLength: 35 }),
        (configuredMaxDepth, maxPerRun, steps) => {
          const queue: PendingTurn[] = [{ bot: "A", depth: 0 }];
          const pairCounts: Record<string, number> = {};
          const lastRelayedAt = new Map<BotId, number>();
          let nowMs = BASE_CLOCK_MS;
          let stepIndex = 0;

          while (queue.length > 0 && stepIndex < steps.length) {
            const current = queue.shift();
            if (!current) break;
            const step = steps[stepIndex];
            stepIndex += 1;
            if (!step) break;

            nowMs += step.advanceMs;
            let acceptedInReply = 0;

            for (const [fanOutIndex, peer] of step.targets.entries()) {
              const prevRelay = lastRelayedAt.get(peer) ?? null;
              const granted =
                ((step.grantedMask >> BOTS.indexOf(peer)) & 1) === 1;
              const decision = evaluateGroupRelayGuard({
                depth: current.depth,
                maxDepth: configuredMaxDepth,
                speakerId: current.bot,
                peerId: peer,
                pairCounts,
                lastRelayedAtMs: prevRelay,
                nowMs,
                fanOutIndex,
                maxPerRun,
                quotaAllowed: step.quotaAllowed,
                granted,
              });

              if (!decision.allowed) {
                if (
                  current.depth >=
                  Math.min(configuredMaxDepth, GROUP_RELAY_MAX_DEPTH)
                ) {
                  expect(decision.reason).toBe("depth_cap");
                }
                continue;
              }

              const nextDepth = current.depth + 1;
              expect(nextDepth).toBeLessThanOrEqual(GROUP_RELAY_MAX_DEPTH);
              expect(nextDepth).toBeLessThanOrEqual(configuredMaxDepth);
              expect(decision.nextPairCount).toBeLessThanOrEqual(
                GROUP_PAIR_PINGPONG_LIMIT,
              );
              if (prevRelay !== null) {
                expect(nowMs - prevRelay).toBeGreaterThanOrEqual(
                  GROUP_BOT_COOLDOWN_MS,
                );
              }
              expect(step.quotaAllowed).toBe(true);
              expect(granted).toBe(true);
              expect(fanOutIndex).toBeLessThan(maxPerRun);

              acceptedInReply += 1;
              expect(acceptedInReply).toBeLessThanOrEqual(maxPerRun);

              pairCounts[decision.pairKey] = decision.nextPairCount;
              lastRelayedAt.set(peer, nowMs);
              queue.push({ bot: peer, depth: nextDepth });
            }
          }

          for (const count of Object.values(pairCounts)) {
            expect(count).toBeLessThanOrEqual(GROUP_PAIR_PINGPONG_LIMIT);
          }
          expect(totalRelays(pairCounts)).toBeLessThanOrEqual(
            MAX_POSSIBLE_PAIR_HOPS,
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  test("变异体 1 捕杀：移除 depth_cap 检查时通过三节点环突破 GROUP_RELAY_MAX_DEPTH 并输出最短反例", () => {
    // 绕过真实守卫的深度判定（固定按 depth=0 传入），其余规则仍使用真实 evaluateGroupRelayGuard。
    const mutantWithoutDepthCap: GuardEvaluator = (input) =>
      evaluateGroupRelayGuard({ ...input, depth: 0 });

    const result = exploreModel(
      createGroupRelayModel({
        name: "变异体1-移除depth_cap",
        maxDepth: GROUP_RELAY_MAX_DEPTH,
        guard: mutantWithoutDepthCap,
        mode: "cycle-and-cooldown",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "maxRelayDepthInvariant",
    );
    expect(result.counterexample?.actions.length).toBeGreaterThanOrEqual(
      GROUP_RELAY_MAX_DEPTH + 1,
    );
  });

  test("变异体 2 捕杀：放宽 maxDepth 下移除 pingpong_cap 导致双向重复乒乓超限并输出反例", () => {
    // 放宽 maxDepth=10（在真实守卫下也会放行 depth<6），同时绕过 pairCounts 计数，复现 A<->B 乒乓失控。
    const mutantWithoutPingpongCap: GuardEvaluator = (input) => {
      const decision = evaluateGroupRelayGuard({
        ...input,
        maxDepth: 10,
        pairCounts: {},
      });
      if (!decision.allowed) return decision;
      const pairKey = relayPairKey(input.speakerId, input.peerId);
      return {
        ...decision,
        nextPairCount: (input.pairCounts?.[pairKey] ?? 0) + 1,
      };
    };

    const result = exploreModel(
      createGroupRelayModel({
        name: "变异体2-移除pingpong_cap",
        maxDepth: 10,
        guard: mutantWithoutPingpongCap,
        mode: "cycle-and-cooldown",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.counterexample?.kind).toBe("invariant");
    expect(result.counterexample?.failedInvariant).toBe(
      "pairPingpongAndTerminationInvariant",
    );
    // 最短乒乓超限路径：A->B, B->A, (冷却tick), A->B, B->A, (冷却tick), A->B (第 3 次 A->B)。
    expect(result.counterexample?.actions.length).toBeGreaterThanOrEqual(5);
  });
});
