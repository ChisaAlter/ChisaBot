import { z } from "zod";
import { LocalAgentCard } from "@/components/chat/local-agent-card";
import { useRenderTool } from "@/lib/chat/renderers";
import {
  type CardCheck,
  isSubagentRunToolName,
  registerCardCheck,
} from "./tool-renderers";

/**
 * `device_agent_run`、`subagent_run` 及具名工具 `agent_<slug>` 在聊天里画成实时子代理任务卡片。
 * 参数流式到达时先用标题画骨架，工具返回 taskId 后换成实时卡片；被拒绝时不画卡片。
 */
const parameters = z.object({
  title: z.string().optional(),
  task: z.string().optional(),
  agent: z.string().optional(),
  instance: z.string().optional(),
  mode: z.string().optional(),
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
  const id =
    value && typeof value === "object"
      ? (value as { taskId?: unknown }).taskId
      : undefined;
  if (typeof id === "string") return id;
  const match = /"taskId"\s*:\s*\\?"([0-9a-f-]{36})/.exec(result);
  if (match?.[1]) return match[1];
  // 有结果但没有 taskId = 被拒绝。
  return null;
}

/** device_agent_run 完成后画不画卡片：拿到 taskId 才画；被拒绝（taskIdOf 返回 null）时渲染器画空，这一轮不算有回答。 */
export const localAgentDrawsCard: CardCheck = registerCardCheck(
  ["device_agent_run", "subagent_run"],
  ({ result }) => taskIdOf(result) !== null,
);

export function LocalAgentTool() {
  useRenderTool({
    name: "device_agent_run",
    match: isSubagentRunToolName,
    parameters,
    render: ({ parameters: given, result }) => {
      const id = taskIdOf(result);
      if (id === null) return null;
      const fallbackTitle =
        typeof given?.title === "string" && given.title.trim()
          ? given.title
          : typeof given?.task === "string" && given.task.trim()
            ? given.task.trim().slice(0, 48)
            : undefined;
      return <LocalAgentCard pendingTitle={fallbackTitle} taskId={id} />;
    },
  });
  return null;
}
