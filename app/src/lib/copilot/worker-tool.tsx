import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { WorkerCard } from "@/components/chat/worker-card";
import { pendingWorkerTitle } from "@/lib/chat/worker-title";
import { type CardCheck, registerCardCheck } from "./tool-renderers";

/**
 * `delegate_task`（服务器工具，server/src/workers/service.ts）在聊天里画成后台任务卡片（DESIGN.md §38.2）。
 * 参数流式到达时先用标题（没有标题时用任务说明的头一句）画一张「正在交给后台…」，工具返回 workerId 后换成活的卡片；
 * 被拒绝（后台任务关着、太多、参数不对…）时不画卡片，机器人自己会说明（以前一直挂着「正在交给后台…」的等待卡）。
 */
const parameters = z.object({
  title: z.string().optional(),
  task: z.string().optional(),
  plan: z.array(z.string()).optional(),
});

/** 还没有结果：undefined；有结果但没有 workerId（被拒绝）：null。 */
export function workerIdOf(result: unknown): string | undefined | null {
  if (typeof result !== "string") return undefined;
  // 服务器工具的结果有时被再包一层 JSON 字符串（"\"{…}\""），最多拆两层。
  let value: unknown = result;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  const id = value && typeof value === "object" ? (value as { workerId?: unknown }).workerId : undefined;
  if (typeof id === "string") return id;
  const match = /"workerId"\s*:\s*\\?"([0-9a-f-]{36})/.exec(result);
  if (match?.[1]) return match[1];
  // 有结果但没有 workerId = 被拒绝。
  return null;
}

/** delegate_task 完成后画不画卡片：拿到 workerId 才画；被拒绝时渲染器画空，这一轮不算有回答。 */
export const workerDrawsCard: CardCheck = registerCardCheck(["delegate_task"], ({ result }) => workerIdOf(result) !== null);

export function WorkerTool() {
  useRenderTool({
    name: "delegate_task",
    parameters,
    render: ({ parameters: given, result }) => {
      const id = workerIdOf(result);
      if (id === null) return <></>;
      return <WorkerCard pendingTitle={pendingWorkerTitle(given)} workerId={id} />;
    },
  });
  return null;
}
