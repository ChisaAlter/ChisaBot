import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import {
  IconCheck,
  IconClockHour4,
  IconCreditCard,
  IconDeviceDesktop,
  IconSend2,
  IconShieldCheck,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isChatRunning } from "@/lib/copilot/computer-activity";
import {
  CONFIRM_CATEGORY_INFO,
  CONFIRM_RESUME_MARKER,
  type ConfirmCategory,
  type ConfirmDetail,
  type ConfirmRequestView,
  type ConfirmStatus,
} from "../../../../shared/confirmations";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { confirmKeys, decideConfirmation, setConfirmPref, useThreadConfirmations } from "@/lib/confirmations";
import { cn } from "@/lib/utils";

/**
 * 聊天里的确认卡片（DESIGN.md §58）：机器人要做有后果的事、用户的偏好是「先问我」时，卡片画在那条工具调用
 * 下面——要做什么 · 对象 · 细节 · 「确认 / 取消」。确认后服务器上等着的工具接着执行，这一轮继续。
 *
 * 状态在服务器上（chisabot_confirm_requests），刷新、换设备看到的是同一张卡；决定后卡片原地收成一行
 * （细节和按钮 grid 0fr 收起，不跳版），记录留在对话里。
 */
const ICON: Record<ConfirmCategory, typeof IconSend2> = {
  message: IconSend2,
  delete: IconTrash,
  purchase: IconCreditCard,
  device: IconDeviceDesktop,
};

const DECIDED_TEXT: Record<Exclude<ConfirmStatus, "pending">, string> = {
  approved: "已确认",
  denied: "已取消，没有执行",
  expired: "已过期，没有执行",
  cancelled: "已停止，没有执行",
};

export type ConfirmCardModel = {
  category: ConfirmCategory;
  /** 卡片顶上那行小字，默认「需要你确认 · 类别」。 */
  eyebrow?: string;
  title: string;
  target?: string | null;
  details?: ConfirmDetail[];
  status: ConfirmStatus;
  /** 决定后那一行的补充（「在电脑上确认」「按偏好直接执行」）。 */
  decidedNote?: string | null;
};

export function ConfirmCardView({
  model,
  onApprove,
  onDeny,
  onAlways,
  approveLabel = "确认",
  denyLabel = "取消",
  testId = "confirm-card",
}: {
  model: ConfirmCardModel;
  onApprove?: () => Promise<unknown>;
  onDeny?: () => Promise<unknown>;
  /** 「以后这类直接做」：改偏好再确认。付款没有这个。 */
  onAlways?: () => Promise<unknown>;
  approveLabel?: string;
  denyLabel?: string;
  testId?: string;
}) {
  const approve = useAsyncAction(async () => onApprove?.(), { errorToast: (error) => error.message });
  const deny = useAsyncAction(async () => onDeny?.(), { errorToast: (error) => error.message });
  const always = useAsyncAction(async () => onAlways?.(), { errorToast: (error) => error.message });
  const pending = model.status === "pending";
  const busy = approve.state === "pending" || deny.state === "pending" || always.state === "pending";
  const Icon = ICON[model.category];
  const info = CONFIRM_CATEGORY_INFO[model.category];
  const details = model.details ?? [];
  return (
    <section
      aria-label={`${pending ? "需要你确认" : DECIDED_TEXT[model.status as Exclude<ConfirmStatus, "pending">]}：${model.title}`}
      className="cf-card"
      data-category={model.category}
      data-state={model.status}
      data-testid={testId}
    >
      <div className="cf-head">
        <span className="cf-ico" aria-hidden>
          {pending ? <Icon className="size-[18px]" /> : model.status === "approved" ? <IconCheck className="size-[18px]" /> : model.status === "expired" ? <IconClockHour4 className="size-[18px]" /> : <IconX className="size-[18px]" />}
        </span>
        <div className="cf-main">
          <div className="cf-eyebrow">
            {pending ? (model.eyebrow ?? `需要你确认 · ${info.label}`) : `${DECIDED_TEXT[model.status as Exclude<ConfirmStatus, "pending">]} · ${info.label}`}
          </div>
          <div className="cf-title">{model.title}</div>
          {model.target ? <div className="cf-target">{model.target}</div> : null}
        </div>
        {!pending && model.decidedNote ? <span className="cf-note">{model.decidedNote}</span> : null}
      </div>
      <div className="cf-fold" data-open={pending ? "" : undefined} inert={!pending}>
        <div className="cf-fold-in">
          {details.length ? (
            <dl className="cf-details">
              {details.map((detail, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表：只追加、不重排、没有稳定 id
                <div className="cf-row" key={`${detail.label}-${index}`}>
                  <dt>{detail.label}</dt>
                  {detail.diff ? (
                    <dd className="cf-diff">
                      <DiffLines diff={detail.value} />
                    </dd>
                  ) : (
                    <dd className={cn(detail.code && "is-code")}>{detail.value}</dd>
                  )}
                </div>
              ))}
            </dl>
          ) : null}
          <div className="cf-actions">
            <Button
              data-testid="confirm-approve"
              disabled={!pending || (busy && approve.state !== "pending")}
              feedback={{ pending: "确认中…", success: "已确认", error: "确认失败" }}
              onClick={() => void approve.run()}
              size="sm"
              state={approve.state}
              variant={model.category === "delete" ? "destructive" : "default"}
            >
              {approveLabel}
            </Button>
            <Button
              data-testid="confirm-deny"
              disabled={!pending || (busy && deny.state !== "pending")}
              feedback="cancel"
              onClick={() => void deny.run()}
              size="sm"
              state={deny.state}
              variant="outline"
            >
              {denyLabel}
            </Button>
            {onAlways && !info.locked ? (
              <button
                className="cf-always"
                data-testid="confirm-always"
                disabled={!pending || busy}
                onClick={() => void always.run()}
                type="button"
              >
                {always.state === "pending" ? "保存中…" : "以后这类直接做"}
              </button>
            ) : info.locked && pending ? (
              <span className="cf-lock">
                <IconShieldCheck className="size-3.5" aria-hidden />
                {"付款一律先问你"}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function viaNote(request: ConfirmRequestView) {
  if (request.status !== "approved" && request.status !== "denied") return null;
  if (request.decidedVia === "device") return "在电脑上决定";
  return null;
}

/** 一张服务器上的确认卡片（按 id 决定，决定后刷新这段对话的卡片列表）。 */
export function ConfirmRequestCard({ request, threadId }: { request: ConfirmRequestView; threadId: string | null }) {
  const queryClient = useQueryClient();
  const refresh = () => Promise.all([threadId ? queryClient.invalidateQueries({ queryKey: confirmKeys.thread(threadId) }) : null, queryClient.invalidateQueries({ queryKey: confirmKeys.recent })]);
  const decide = async (decision: "approve" | "deny") => {
    const updated = await decideConfirmation(request.id, decision);
    if (threadId)
      queryClient.setQueryData<ConfirmRequestView[]>(confirmKeys.thread(threadId), (list) => list?.map((item) => (item.id === updated.id ? updated : item)));
    await refresh();
  };
  return (
    <ConfirmCardView
      model={{
        category: request.category,
        title: request.title,
        target: request.target,
        details: request.details,
        status: request.status,
        decidedNote: viaNote(request),
      }}
      onAlways={async () => {
        await setConfirmPref(request.category, "auto", "在确认卡片上选了「以后这类直接做」");
        await decide("approve");
        toast.success(`以后「${CONFIRM_CATEGORY_INFO[request.category].label}」直接做，可在 设置 → 权限与审批 改回`);
      }}
      onApprove={() => decide("approve")}
      onDeny={() => decide("deny")}
    />
  );
}

/** 聊天正在跑一轮（turn-compaction 广播 chisabot-chat-running）。 */
function useChatRunning() {
  const [running, setRunning] = useState(() => isChatRunning());
  useEffect(() => {
    const on = (event: Event) => setRunning(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener("chisabot-chat-running", on);
    return () => window.removeEventListener("chisabot-chat-running", on);
  }, []);
  return running;
}


/**
 * 频道聊天（CB-046，DESIGN.md §68）：一个工具调用下面的确认卡片。`answered` = 这个调用已经有结果；
 * `recent` = 它在对话末尾附近（刷新后卡片可能还在等）。
 */
export function ToolCallConfirmCards({ toolCallId, answered, recent }: { toolCallId: string; answered: boolean; recent: boolean }) {
  const ids = useMemo(() => [toolCallId], [toolCallId]);
  const done = useMemo(() => (answered ? new Set([toolCallId]) : new Set<string>()), [answered, toolCallId]);
  return <ToolConfirmCards answered={done} ids={ids} recent={recent} />;
}

function ToolConfirmCards({ ids, answered, recent }: { ids: readonly string[]; answered: ReadonlySet<string>; recent: boolean }) {
  const chat = useCopilotChatConfiguration();
  const threadId = chat?.threadId ?? null;
  // 有工具调用还没结果、且（这一轮正在跑，或它在最近几条消息里——刷新后卡片还在等）时才轮询；
  // 历史里被打断、永远没结果的调用不让页面一直轮询。一轮刚跑完再取一次，卡片状态马上对上。
  const running = useChatRunning();
  const open = (running || recent) && ids.some((id) => !answered.has(id));
  const list = useThreadConfirmations(ids.length ? threadId : null, open);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!running && recent && threadId && ids.length) void queryClient.invalidateQueries({ queryKey: confirmKeys.thread(threadId) });
  }, [running, recent, threadId, ids.length, queryClient]);
  const cards = (list.data ?? []).filter((request) => request.toolCallId && ids.includes(request.toolCallId)).reverse();
  if (!cards.length) return null;
  return (
    <div className="cf-stack">
      {cards.map((request) => (
        <ConfirmRequestCard key={request.id} request={request} threadId={threadId} />
      ))}
    </div>
  );
}

/**
 * 没绑到工具调用的确认卡片（DESIGN.md §101.9）：网页上点「发送 / 删除」走 /api/approvals/computer，服务器那边拿不到
 * 工具调用 id；定时任务 / IM 触发的后台回合放的卡片也一样（§101.3）。以前它们只在「待处理」页出现，聊天里看不到。
 *
 * 画法：还在等的画在对话最下面（chat-tail）；这一页上亲眼看着它在等、后来被决定的，原地收成一行留着，直到服务器
 * 放进来的「用户确认了」那条（`resumed`，带这张卡的 id）出现——那一行就是它的记录，卡片让位，不画两遍。
 * 打开对话前就已经决定了的不画（记录是那一行 / 「待处理」）。
 */
export function looseConfirmations(
  list: readonly ConfirmRequestView[],
  seen: ReadonlySet<string>,
  resumed: ReadonlySet<string>,
): ConfirmRequestView[] {
  return list
    .filter((request) => !request.toolCallId && !resumed.has(request.id) && (request.status === "pending" || seen.has(request.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const RESUME_ID = /^⟦chisabot:confirm:([^⟧]+)⟧/;
/** 「用户确认了」那条消息里的卡片 id。 */
export const confirmResumeId = (text: string): string | null => RESUME_ID.exec(text)?.[1] ?? null;

export function LooseConfirmCards({ resumed, version }: { resumed: ReadonlySet<string>; version: number }) {
  const chat = useCopilotChatConfiguration();
  const threadId = chat?.threadId ?? null;
  const list = useThreadConfirmations(threadId, false);
  const queryClient = useQueryClient();
  // 后台回合的消息同步进来（列表变长）时卡片多半也刚放好：再取一次。有卡在等时 useThreadConfirmations 自己 1.5 秒一取。
  useEffect(() => {
    if (threadId && version > 0) void queryClient.invalidateQueries({ queryKey: confirmKeys.thread(threadId) });
  }, [threadId, version, queryClient]);
  const seen = useRef<Set<string>>(new Set());
  for (const request of list.data ?? []) if (request.status === "pending" && !request.toolCallId) seen.current.add(request.id);
  const cards = looseConfirmations(list.data ?? [], seen.current, resumed);
  if (!cards.length) return null;
  return (
    <div className="cf-stack cf-loose" data-testid="loose-confirm-cards">
      {cards.map((request) => (
        <ConfirmRequestCard key={request.id} request={request} threadId={threadId} />
      ))}
    </div>
  );
}

/** 后来才确认、服务器叫机器人接着做的那条消息：一行小字，不是用户气泡。 */
export function ConfirmResumeRow({ text }: { text: string }): ReactNode {
  const title = /用户确认了「([^」]*)」/.exec(text)?.[1] ?? "";
  return (
    <div className="cf-resume" data-testid="confirm-resume-row">
      <IconCheck className="size-3.5" aria-hidden />
      <span>{title ? `你确认了「${title}」，机器人接着做` : "你确认了，机器人接着做"}</span>
    </div>
  );
}
export const isConfirmResume = (text: string) => text.startsWith(CONFIRM_RESUME_MARKER);

/** 设备改文件的 unified diff：加行绿、删行红、@@ 灰（同 设置 → 设备 的 .device-diff，DESIGN.md §62）。 */
function DiffLines({ diff }: { diff: string }) {
  return (
    <pre className="device-diff is-approval">
      {diff
        .split("\n")
        .slice(0, 300)
        .map((line, index) => (
          <span
            className={cn(
              line.startsWith("+") && !line.startsWith("+++") && "is-add",
              line.startsWith("-") && !line.startsWith("---") && "is-del",
              line.startsWith("@@") && "is-hunk",
            )}
            // biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id，只渲染一次
            key={index}
          >
            {`${line}\n`}
          </span>
        ))}
    </pre>
  );
}
