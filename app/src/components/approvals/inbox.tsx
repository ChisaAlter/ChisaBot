import { IconChecks, IconChevronRight } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ConfirmRow } from "@/components/approvals/confirm-row";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, ErrorCard } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type ApprovalDecision, type ApprovalInboxData, answerPersonQuestion, approvalInboxOptions, decideApproval } from "@/lib/approvals";
import { confirmKeys, recentConfirmationsQueryOptions } from "@/lib/confirmations";
import { agoText } from "@/lib/im";

/**
 * 「待处理」（账号菜单 → 待处理，`/approvals`，DESIGN.md §71.1）：只放等你点头的事——
 * 聊天里没来得及点的确认卡片（§58）、要你亲自完成的操作、机器人在等你回答的问题。
 * 偏好（哪些事先问我）只在 设置 → 权限与审批；这里不再放上游的开关和规则表（生产 0 行，§58 取代）。
 */
export function PendingInbox() {
  const cache = useQueryClient();
  const upstream = useQuery(approvalInboxOptions());
  const recent = useQuery(recentConfirmationsQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const botName = useMemo(() => {
    const names = new Map((bots.data ?? []).map((bot) => [bot.id, bot.name]));
    return (id: string) => names.get(id) ?? "机器人";
  }, [bots.data]);
  const refresh = () => Promise.all([cache.invalidateQueries({ queryKey: ["approvals"] }), cache.invalidateQueries({ queryKey: confirmKeys.all })]);

  const confirms = (recent.data ?? []).filter((request) => request.status === "pending");
  const requests = (upstream.data?.requests ?? []).filter((request) => request.status === "pending");
  const questions = upstream.data?.questions ?? [];
  const loading = recent.isPending || upstream.isPending;
  const failed = recent.error || upstream.error;
  const total = confirms.length + requests.length + questions.length;

  return (
    <div className="pending-inbox space-y-6" data-testid="pending-inbox">
      {loading ? (
        <PageSkeleton rows={2} />
      ) : failed ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void refresh()} size="sm" variant="outline">
              {"重试"}
            </Button>
          }
          description={"刷新一下再试；聊天里的确认卡片不受影响。"}
          detail={(recent.error ?? upstream.error)?.message}
          title={"待处理的事暂时读不到"}
        />
      ) : total === 0 ? (
        <EmptyState
          description={"机器人要做有后果的事（对外发消息、删除、付款、操作你的电脑）时会在聊天里先问你；没来得及点的会留在这里。"}
          icon={<IconChecks className="size-6" />}
          title={"没有等你处理的事"}
        />
      ) : (
        <>
          {confirms.length ? (
            <PageSection title={`等你确认 · ${confirms.length}`}>
              <Card className="mem-card">
                {confirms.map((request) => (
                  <ConfirmRow botName={botName(request.agentId)} key={request.id} onDecided={refresh} request={request} />
                ))}
              </Card>
            </PageSection>
          ) : null}
          {requests.length ? (
            <PageSection title={`要你处理 · ${requests.length}`}>
              <div className="space-y-3">
                {requests.map((request) => (
                  <HandOffCard botName={botName(request.action.botId)} key={request.id} onDone={refresh} request={request} />
                ))}
              </div>
            </PageSection>
          ) : null}
          {questions.length ? (
            <PageSection title={`在等你回答 · ${questions.length}`}>
              <div className="space-y-3">
                {questions.map((question) => (
                  <QuestionCard botName={botName(question.botId)} key={question.id} onDone={refresh} question={question} />
                ))}
              </div>
            </PageSection>
          ) : null}
        </>
      )}
      <Link className="pending-prefs-link" to="/settings/approvals">
        <span>
          <span className="pending-prefs-t">{"哪些事先问我"}</span>
          <span className="pending-prefs-s">{"设置 → 权限与审批：按类别选「先问我 / 直接做」，或用自己的话写规则"}</span>
        </span>
        <IconChevronRight aria-hidden className="size-4 shrink-0" />
      </Link>
    </div>
  );
}

type PendingRequest = ApprovalInboxData["requests"][number];

/** 上游审批闸门交给你的一步（付款 / 改密码这类安全规则，或「执行前询问」）：人话标题，参数折叠在「查看详情」里。 */
function HandOffCard({ request, botName, onDone }: { request: PendingRequest; botName: string; onDone: () => Promise<unknown> }) {
  const handOff = request.action.policy?.behaviour === "hand_off";
  const decide = async (choice: ApprovalDecision) => {
    await decideApproval(request.id, choice);
    await onDone();
  };
  const opts = { errorToast: (error: Error) => error.message };
  const first = useAsyncAction(() => decide(handOff ? "handled" : "allow_once"), opts);
  const always = useAsyncAction(() => decide("allow_always"), opts);
  const deny = useAsyncAction(() => decide("deny"), opts);
  const what = request.action.toolRef.replace(/^computer_|^host\//, "").replaceAll("_", " ");
  return (
    <Card className="pending-card">
      <div className="pending-card-t">{handOff ? `${botName}把这一步交给你亲自完成` : `${botName}想执行「${what}」`}</div>
      <div className="pending-card-s">
        {[request.action.policy?.reason, agoText(request.createdAt)].filter(Boolean).join(" · ")}
      </div>
      <details className="pending-card-d">
        <summary>{"查看详情"}</summary>
        <pre>{JSON.stringify(request.action.args, null, 2)}</pre>
      </details>
      <div className="pending-card-a">
        <Button feedback={{ pending: "处理中…", success: handOff ? "已标记完成" : "已允许", error: "失败" }} onClick={() => void first.run()} size="sm" state={first.state}>
          {handOff ? "我已自己完成" : "允许一次"}
        </Button>
        {handOff ? null : (
          <Button feedback={{ pending: "处理中…", success: "已允许", error: "失败" }} onClick={() => void always.run()} size="sm" state={always.state} variant="outline">
            {"以后都允许"}
          </Button>
        )}
        <Button feedback="cancel" onClick={() => void deny.run()} size="sm" state={deny.state} variant="outline">
          {"不要执行"}
        </Button>
      </div>
    </Card>
  );
}

function QuestionCard({ question, botName, onDone }: { question: ApprovalInboxData["questions"][number]; botName: string; onDone: () => Promise<unknown> }) {
  const [text, setText] = useState("");
  const send = useAsyncAction(
    async () => {
      await answerPersonQuestion(question.id, text.trim());
      await onDone();
    },
    { errorToast: (error) => error.message },
  );
  return (
    <Card className="pending-card">
      <div className="pending-card-t">{`${botName}问：${question.question}`}</div>
      {question.why ? <div className="pending-card-s">{question.why}</div> : null}
      <Textarea aria-label={"你的回答"} onChange={(event) => setText(event.target.value)} placeholder={"你的回答"} value={text} />
      <div className="pending-card-a">
        <Button disabled={!text.trim()} feedback={{ pending: "发送中…", success: "已发送", error: "发送失败" }} onClick={() => void send.run()} size="sm" state={send.state}>
          {"发送"}
        </Button>
      </div>
    </Card>
  );
}
