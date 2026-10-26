/**
 * 活动记录分组（CB-101）：按「轮」分组（一轮 = 你说的一句话 + 机器人为它做的事），
 * 人自己的操作单独成组；连续的只读探查命令合并成「运行了 N 条命令」。
 */
import {
  BATCH_MIN,
  isProbeCommand,
} from "../../../../shared/computer-activity-labels";
import type { ActivityStep } from "./use-computer-activity";

export type ActivityItem =
  | { type: "step"; step: ActivityStep }
  | { type: "batch"; id: string; steps: ActivityStep[] };

export type ActivityTurn = {
  key: string;
  actorKind: "agent" | "human";
  threadId: string | null;
  runId: string | null;
  prompt: string | null;
  turnStatus: string | null;
  /** 组内从早到晚，读起来是做事的顺序。 */
  items: ActivityItem[];
  /** 组内最新一步的开始时间，组按它从新到旧排。 */
  latestAt: string;
  running: boolean;
};

function groupKey(step: ActivityStep): string {
  if (step.actorKind === "human") return "human";
  return step.runId
    ? `run:${step.runId}`
    : step.threadId
      ? `thread:${step.threadId}`
      : "agent";
}

/** 合并：连续 ≥ BATCH_MIN 条成功的只读探查命令。失败的、被拒绝的、进行中的永远单独显示。 */
export function batchCommands(
  stepsOldestFirst: ActivityStep[],
): ActivityItem[] {
  const items: ActivityItem[] = [];
  let run: ActivityStep[] = [];
  const flush = () => {
    if (run.length >= BATCH_MIN)
      items.push({ type: "batch", id: `batch:${run[0]?.id}`, steps: run });
    else for (const step of run) items.push({ type: "step", step });
    run = [];
  };
  for (const step of stepsOldestFirst) {
    const mergeable =
      step.kind === "run_command" &&
      step.status === "ok" &&
      isProbeCommand(step.subject);
    if (mergeable) run.push(step);
    else {
      flush();
      items.push({ type: "step", step });
    }
  }
  flush();
  return items;
}

/** steps：从新到旧（接口给的顺序）。返回的组从新到旧；相邻的同组步骤才并在一起。 */
export function groupActivity(
  stepsNewestFirst: ActivityStep[],
): ActivityTurn[] {
  const chunks: ActivityStep[][] = [];
  let lastKey: string | null = null;
  for (const step of stepsNewestFirst) {
    const key = groupKey(step);
    if (key === lastKey) chunks[chunks.length - 1]?.push(step);
    else {
      chunks.push([step]);
      lastKey = key;
    }
  }
  return chunks.map((chunk) => {
    const newest = chunk[0] as ActivityStep;
    const oldestFirst = [...chunk].reverse();
    return {
      key: `${groupKey(newest)}:${chunk.at(-1)?.id}`,
      actorKind: newest.actorKind,
      threadId: newest.threadId,
      runId: newest.runId,
      prompt: chunk.find((step) => step.turnPrompt)?.turnPrompt ?? null,
      turnStatus: newest.turnStatus,
      items: batchCommands(oldestFirst),
      latestAt: newest.startedAt,
      running: chunk.some((step) => step.status === "running"),
    };
  });
}
