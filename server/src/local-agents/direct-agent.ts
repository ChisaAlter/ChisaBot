/**
 * 聊天框 `@子代理` / 子代理胶囊直连运行器。
 *
 * 当用户在聊天框显式指定了 `subagentInstanceId` 发送消息时，跳过主 Bot LLM 的中转损耗，
 * 直接在当前对话流中发射标准 AG-UI 工具事件（`subagent_run`），原地挂载实时子代理任务卡片，
 * 任务完成后照常经 `ThreadInbox` 回流到当前对话。
 */

import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { LOCAL_AGENT_INFO, profileLine } from "../../../shared/local-agents";
import { reasonWithoutStatement } from "../db/query-failure";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { LocalAgentService } from "./service";

function extractLatestUserPrompt(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") {
      return msg.content.trim();
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((part) =>
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
            ? part.text
            : "",
        )
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  }
  return "";
}

export class DirectSubagentRuntimeAgent extends AbstractAgent {
  constructor(
    private readonly deps: {
      ownerUserId: string;
      botId: string;
      botName: string | null;
      instanceRef: string;
      cwd?: string;
      localAgents: LocalAgentService;
    },
  ) {
    super({ agentId: deps.botId, description: "Direct subagent invocation" });
  }

  override clone(): DirectSubagentRuntimeAgent {
    const cloned = new DirectSubagentRuntimeAgent(this.deps);
    cloned.agentId = this.agentId;
    cloned.description = this.description;
    cloned.threadId = this.threadId;
    return cloned;
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      let cancelled = false;
      const emit = (event: Record<string, unknown>) => {
        if (!cancelled && !observer.closed) {
          observer.next(event as unknown as BaseEvent);
        }
      };

      void (async () => {
        emit({
          type: "RUN_STARTED",
          threadId: input.threadId,
          runId: input.runId,
        });

        const rawPrompt = extractLatestUserPrompt(input.messages);
        // 剥离输入开头形如 `@codex ` 的提及标记（若只有 `@codex` 没有正文则提示）
        const cleanedPrompt = rawPrompt.replace(/^@[a-z0-9_-]+\s+/i, "").trim();
        const taskPrompt = cleanedPrompt || rawPrompt;
        const parentMsgId = randomUUID();
        const toolCallId = `call_subagent_${randomUUID().slice(0, 12)}`;
        const title =
          taskPrompt.replace(/\s+/g, " ").slice(0, 48) || "子代理任务";

        if (!taskPrompt) {
          const msgId = randomUUID();
          emit({
            type: "TEXT_MESSAGE_START",
            messageId: msgId,
            role: "assistant",
          });
          emit({
            type: "TEXT_MESSAGE_CONTENT",
            messageId: msgId,
            delta: "请在选择子代理后输入需要执行的任务说明。",
          });
          emit({ type: "TEXT_MESSAGE_END", messageId: msgId });
          emit({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          });
          observer.complete();
          return;
        }

        const fProps = (input.forwardedProps ?? {}) as Record<string, unknown>;
        const shouldWait =
          Boolean(fProps.chisabotSchedule) || fProps.subagentWait === true;
        const mode: "wait" | "async" = shouldWait ? "wait" : "async";

        const toolArgs = {
          instance: this.deps.instanceRef,
          task: taskPrompt,
          title,
          mode,
          ...(this.deps.cwd ? { cwd: this.deps.cwd } : {}),
        };

        emit({
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: "subagent_run",
          parentMessageId: parentMsgId,
        });
        emit({
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: JSON.stringify(toolArgs),
        });
        emit({
          type: "TOOL_CALL_END",
          toolCallId,
        });

        try {
          const outcome = await this.deps.localAgents.runSubagent({
            ownerUserId: this.deps.ownerUserId,
            botId: this.deps.botId,
            botName: this.deps.botName,
            threadId: input.threadId,
            instance: this.deps.instanceRef,
            task: taskPrompt,
            title,
            cwd: this.deps.cwd,
            mode,
            waitTimeoutMs: shouldWait ? 15 * 60_000 : undefined,
            invocationMode: shouldWait ? "wait" : "direct",
            bypassBotGrant: true,
          });
          const task = outcome.task;
          const label =
            task.instanceName ||
            LOCAL_AGENT_INFO[task.agent]?.label ||
            task.agent;
          emit({
            type: "TOOL_CALL_RESULT",
            toolCallId,
            messageId: randomUUID(),
            role: "tool",
            content: JSON.stringify({
              taskId: task.id,
              status: task.status,
              device: task.deviceName,
              instanceName: label,
              agent: label,
              profile: profileLine(task),
              cwd: task.cwd,
              summary: task.summary,
              diff: task.diff,
              error: task.error,
              timedOut: outcome.timedOut,
            }),
          });

          const textId = randomUUID();
          let statusNote: string;
          if (shouldWait) {
            if (task.status === "done") {
              const diffSummary = task.diff?.files.length
                ? `\n\n改动文件：${task.diff.files.length} 个（+${task.diff.added} −${task.diff.removed}）`
                : "";
              statusNote =
                (task.summary?.trim() || `子代理「${label}」已完成任务。`) +
                diffSummary;
            } else if (outcome.timedOut) {
              statusNote = `子代理「${label}」仍在后台运行（任务 ${task.id}），完成后会继续回报。`;
            } else {
              statusNote = `${REFUSAL_MARKER} 子代理「${label}」执行未成功：${task.error || task.status}`;
            }
          } else {
            statusNote =
              task.status === "pending_approval"
                ? `已将任务交给子代理「${label}」（${task.deviceName}），请在上方卡片点击批准后开始执行。`
                : `已直接交给子代理「${label}」（${task.deviceName}）执行，进度在上方任务卡片实时更新，完成后会自动回报结果。`;
          }
          emit({
            type: "TEXT_MESSAGE_START",
            messageId: textId,
            role: "assistant",
          });
          emit({
            type: "TEXT_MESSAGE_CONTENT",
            messageId: textId,
            delta: statusNote,
          });
          emit({ type: "TEXT_MESSAGE_END", messageId: textId });
        } catch (error) {
          const errMsg = reasonWithoutStatement(error);
          emit({
            type: "TOOL_CALL_RESULT",
            toolCallId,
            messageId: randomUUID(),
            role: "tool",
            content: `${REFUSAL_MARKER} ${errMsg}`,
          });
          const textId = randomUUID();
          emit({
            type: "TEXT_MESSAGE_START",
            messageId: textId,
            role: "assistant",
          });
          emit({
            type: "TEXT_MESSAGE_CONTENT",
            messageId: textId,
            delta: `无法启动子代理：${errMsg}`,
          });
          emit({ type: "TEXT_MESSAGE_END", messageId: textId });
        }

        emit({
          type: "RUN_FINISHED",
          threadId: input.threadId,
          runId: input.runId,
        });
        observer.complete();
      })().catch((err) => {
        if (!observer.closed) observer.error(err);
      });

      return () => {
        cancelled = true;
      };
    });
  }
}
