import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  answerPersonQuestion,
  approvalInboxOptions,
  dismissPersonQuestion,
} from "@/lib/approvals";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";

/**
 * A Bot's unanswered question, drawn where it was asked.
 *
 * The question was only ever answerable in Approvals (§71.1), so somebody who followed the rail's
 * number into the conversation that raised it found nothing to click and the number stayed. One
 * question still has one answer however it is sent: both boxes POST the same route, so answering
 * here resumes that run exactly as answering there did.
 *
 * Read from the same owner-scoped inbox as the Approvals page, so a question answered in either
 * place is the one answer. The 作废 button beside it is for a question whose conversation is gone:
 * without it the number could never be cleared (§110).
 */
export function PendingQuestion({ channelId }: { channelId: string }) {
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const bots = useQuery(agentListQueryOptions());
  const [text, setText] = useState("");
  const question = (inbox.data?.questions ?? []).find(
    (candidate) => candidate.channelId === channelId,
  );
  const settled = async () => {
    setText("");
    await Promise.all([
      cache.invalidateQueries({ queryKey: ["approvals"] }),
      // The rail's number is its own query; without this it lags the answer by up to 15 seconds.
      cache.invalidateQueries({ queryKey: botLifecycleKeys.all }),
    ]);
  };
  const answer = useMutation({
    mutationFn: (input: { id: string; response: string }) =>
      answerPersonQuestion(input.id, input.response),
    onSuccess: settled,
    // The usual reason this fails is that the conversation it belongs to is gone, which is what
    // 不用回答了 is for — say so rather than leaving a button that silently does nothing.
    onError: (error) => toast.error(`回答没发出去：${error.message}`),
  });
  const dismiss = useMutation({
    mutationFn: dismissPersonQuestion,
    onSuccess: settled,
    onError: (error) => toast.error(`这个问题没能关掉：${error.message}`),
  });
  if (!question) return null;
  const name =
    bots.data?.find((bot) => bot.id === question.botId)?.name ?? "机器人";
  const busy = answer.isPending || dismiss.isPending;
  const askToDismiss = async (id: string) => {
    const ok = await confirmDialog({
      title: "不用回答这个问题了？",
      description:
        "这条问题会被关掉，机器人不会再等它。想让它接着做，直接在下面回答就好。",
      confirmLabel: "关掉问题",
      destructive: true,
    });
    if (ok) dismiss.mutate(id);
  };
  return (
    <section
      aria-label={`需要你回答：${question.question}`}
      className="chat-question"
    >
      <p className="chat-question-t">{`${name}问你：${question.question}`}</p>
      {question.why ? <p className="chat-question-s">{question.why}</p> : null}
      <Textarea
        aria-label="你的回答"
        data-unsent-watch
        onChange={(event) => setText(event.target.value)}
        placeholder="你的回答"
        rows={2}
        value={text}
      />
      <div className="chat-question-a">
        <Button
          disabled={busy}
          onClick={() => void askToDismiss(question.id)}
          size="sm"
          variant="ghost"
        >
          {"不用回答了"}
        </Button>
        <Button
          disabled={busy || !text.trim()}
          onClick={() =>
            answer.mutate({ id: question.id, response: text.trim() })
          }
          size="sm"
        >
          {answer.isPending ? "发送中…" : "发送"}
        </Button>
      </div>
    </section>
  );
}
