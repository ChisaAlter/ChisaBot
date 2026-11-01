import { useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { LocalAgentCard } from "@/components/chat/local-agent-card";
import { type CardCheck, registerCardCheck } from "./tool-renderers";

/**
 * `device_agent_run`（服务器工具，server/src/local-agents/service.ts）在聊天里画成本地 agent 任务卡片
 * （docs/local-agents.md）。参数流式到达时先用标题画「正在交给电脑…」，工具返回 taskId 后换成活的卡片；
 * 被拒绝（离线、能力关闭、档位不允许…）时不画卡片，机器人自己会说明。
 */
const parameters = z.object({
  title: z.string().optional(),
  task: z.string().optional(),
  agent: z.string().optional(),
});

export function taskIdOf(result: unknown): string | undefined | null {
  if (typeof result !== "string") return undefined;
  let value: unknown = result;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  const id = value && typeof value === "object" ? (value as { taskId?: unknown }).taskId : undefined;
  if (typeof id === "string") return id;
  const match = /"taskId"\s*:\s*\\?"([0-9a-f-]{36})/.exec(result);
  if (match?.[1]) return match[1];
  // 有结果但没有 taskId = 被拒绝。
  return null;
}

/** device_agent_run 完成后画不画卡片：拿到 taskId 才画；被拒绝（taskIdOf 返回 null）时渲染器画空，这一轮不算有回答。 */
export const localAgentDrawsCard: CardCheck = registerCardCheck(["device_agent_run"], ({ result }) => taskIdOf(result) !== null);

export function LocalAgentTool() {
  useRenderTool({
    name: "device_agent_run",
    parameters,
    render: ({ parameters: given, result }) => {
      const id = taskIdOf(result);
      if (id === null) return <></>;
      return <LocalAgentCard pendingTitle={typeof given?.title === "string" ? given.title : undefined} taskId={id} />;
    },
  });
  return null;
}
