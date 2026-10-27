import { IconAlertTriangle, IconCheck, IconChevronDown, IconClockHour4, IconExternalLink, IconFileDiff, IconGitMerge, IconGitPullRequest, IconLoader2, IconShieldCheck, IconTerminal2, IconX } from "@tabler/icons-react";
import { memo, useState } from "react";
import { type CcApprovalState, type CcMessage, type CcPart, ccToolLine } from "../../../../shared/cloud-cc";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { ccApi } from "@/lib/cloud-cc";
import { cn } from "@/lib/utils";

type ToolPart = Extract<CcPart, { type: "tool" }>;
type Block = { kind: "tools"; tools: ToolPart[]; key: string } | { kind: "part"; part: CcPart; key: string };

/** 连在一起的工具调用并成一组「干活行」（DESIGN.md §70 的说法，§73.4）。 */
function blocks(parts: CcPart[]): Block[] {
  const out: Block[] = [];
  parts.forEach((part, i) => {
    if (part.type === "tool") {
      const last = out[out.length - 1];
      if (last && last.kind === "tools") last.tools.push(part);
      else out.push({ kind: "tools", tools: [part], key: `t${i}` });
    } else if (part.type === "text" && !part.text) {
      // 还没出字的文字段不画
    } else out.push({ kind: "part", part, key: `p${i}` });
  });
  return out;
}

function ToolLine({ tool }: { tool: ToolPart }) {
  const icon =
    tool.status === "running" ? (
      <IconLoader2 className="cc-tool-ic is-spin size-3.5" />
    ) : tool.status === "done" ? (
      <IconCheck className="cc-tool-ic is-ok size-3.5" />
    ) : tool.status === "denied" ? (
      <IconShieldCheck className="cc-tool-ic is-denied size-3.5" />
    ) : (
      <IconX className="cc-tool-ic is-err size-3.5" />
    );
  return (
    <div className="cc-tool" data-status={tool.status} data-testid="cc-tool-line">
      {icon}
      <span className="cc-tool-t">{ccToolLine(tool.name, tool.input)}</span>
      {tool.status === "denied" && tool.reason ? <span className="cc-tool-why">{tool.reason}</span> : null}
    </div>
  );
}

function ToolGroup({ tools, running }: { tools: ToolPart[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const denied = tools.filter((t) => t.status === "denied").length;
  if (running || tools.length <= 2 || denied)
    return (
      <div className="cc-tools">
        {tools.map((t, i) => (
          <ToolLine key={t.id ?? i} tool={t} />
        ))}
      </div>
    );
  const files = new Set(tools.filter((t) => ["Write", "Edit", "MultiEdit"].includes(t.name)).map((t) => String(t.input.file_path ?? "").split("/").pop()));
  return (
    <div className="cc-tools is-folded">
      <button aria-expanded={open} className="cc-tools-sum" onClick={() => setOpen((o) => !o)} type="button">
        <IconCheck className="cc-tool-ic is-ok size-3.5" />
        <span>{`已完成 ${tools.length} 步${files.size ? ` · 改了 ${files.size} 个文件` : ""}`}</span>
        <IconChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="cc-tools-list">
          {tools.map((t, i) => (
            <ToolLine key={t.id ?? i} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const APPROVAL_STATE_ZH: Record<CcApprovalState, string> = { pending: "需要你批准", approved: "已允许", denied: "已拒绝", expired: "2 分钟没人处理，按拒绝" };

/** 审批卡（同 §58 确认卡片的样子）：允许 / 本会话总是允许 / 拒绝。手机上按钮竖排、热区 ≥ 44px。 */
export function CcApprovalCard({ part }: { part: Extract<CcPart, { type: "approval" }> }) {
  const approve = useAsyncAction(() => ccApi.decide(part.id, "approve"), { errorToast: (e) => e.message });
  const always = useAsyncAction(() => ccApi.decide(part.id, "approve", true), { errorToast: (e) => e.message });
  const deny = useAsyncAction(() => ccApi.decide(part.id, "deny"), { errorToast: (e) => e.message });
  const pending = part.state === "pending";
  const busy = [approve, always, deny].some((a) => a.state === "pending");
  const command = part.tool === "Bash" ? String(part.input.command ?? "") : null;
  return (
    <section className="cf-card cc-approval" data-state={pending ? "pending" : part.state} data-testid="cc-approval">
      <div className="cf-head">
        <span aria-hidden className="cf-ico">
          {pending ? <IconTerminal2 className="size-[18px]" /> : part.state === "approved" ? <IconCheck className="size-[18px]" /> : part.state === "expired" ? <IconClockHour4 className="size-[18px]" /> : <IconX className="size-[18px]" />}
        </span>
        <div className="cf-main">
          <div className="cf-eyebrow">{pending ? "需要你批准 · Claude Code" : `${APPROVAL_STATE_ZH[part.state]}${part.always ? " · 本会话总是允许" : ""}`}</div>
          <div className="cf-title">{command ? `想运行：${command}` : part.summary}</div>
          {command ? <div className="cf-target">{"在这个会话自己的目录里运行"}</div> : null}
        </div>
      </div>
      <div className="cf-fold" data-open={pending ? "" : undefined} inert={!pending}>
        <div className="cf-fold-in">
          <div className="cf-actions cc-approval-actions">
            <Button data-testid="cc-approve" disabled={!pending || (busy && approve.state !== "pending")} feedback={{ pending: "允许中…", success: "已允许", error: "没成功" }} onClick={() => void approve.run()} size="sm" state={approve.state}>
              {"允许"}
            </Button>
            {part.canAlways ? (
              <Button data-testid="cc-always" disabled={!pending || (busy && always.state !== "pending")} feedback={{ pending: "保存中…", success: "已允许", error: "没成功" }} onClick={() => void always.run()} size="sm" state={always.state} variant="outline">
                {"本会话总是允许"}
              </Button>
            ) : null}
            <Button data-testid="cc-deny" disabled={!pending || (busy && deny.state !== "pending")} feedback={{ pending: "拒绝中…", success: "已拒绝", error: "没成功" }} onClick={() => void deny.run()} size="sm" state={deny.state} variant="outline">
              {"拒绝"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChangesCard({ part, onOpen }: { part: Extract<CcPart, { type: "changes" }>; onOpen?: (turnId: string) => void }) {
  const add = part.files.reduce((n, f) => n + (f.add ?? 0), 0);
  const del = part.files.reduce((n, f) => n + (f.del ?? 0), 0);
  return (
    <div className="cc-changes" data-testid="cc-changes">
      <div className="cc-changes-h">
        <IconFileDiff className="size-4" />
        <span className="cc-changes-t">{`改动 ${part.files.length} 个文件`}</span>
        <span className="cc-plus">{`+${add}`}</span>
        <span className="cc-minus">{`−${del}`}</span>
        {onOpen ? (
          <button className="cc-changes-open" data-testid="cc-open-diff" onClick={() => onOpen(part.turnId)} type="button">
            {"看 diff ›"}
          </button>
        ) : null}
      </div>
      <div className="cc-changes-files">
        {part.files.slice(0, 6).map((f) => (
          <span className="cc-chip" key={f.path}>
            {f.path.split("/").pop()}
            <span className="cc-plus">{f.add === null ? "" : ` +${f.add}`}</span>
            <span className="cc-minus">{f.del === null || f.del === 0 ? "" : ` −${f.del}`}</span>
          </span>
        ))}
        {part.files.length > 6 ? <span className="cc-chip is-more">{`还有 ${part.files.length - 6} 个`}</span> : null}
      </div>
    </div>
  );
}

/**
 * 合入 / 推送的结果卡（DESIGN.md §73.7）：已合入（快进 / 合并提交 / 已经是最新）· 有冲突（不动工作目录 +「让 Claude 处理」）·
 * PR 链接卡（#号 · 分支 → 目标 · 打开）· 推送了但没开成 PR。
 */
export function CcGitCard({ part, sessionId }: { part: Extract<CcPart, { type: "git" }>; sessionId?: string }) {
  const fix = useAsyncAction(
    async () => {
      if (!sessionId) return;
      const targetDesc = part.target ? `（${part.target}）` : "";
      const rebaseHint = part.target ? `；若为 Git 分支提交冲突也可执行 git rebase ${part.target}` : "";
      await ccApi.send(
        sessionId,
        `把会话分支 ${part.branch} 合入工作目录${targetDesc}时有冲突${part.files?.length ? `，冲突的文件：${part.files.join("、")}` : ""}。请先读取主工作目录（../../work/ 下对应文件）的最新内容，在当前会话目录里把双方修改合并好${rebaseHint}，完成后告诉我，我再点「合入工作目录」。`,
      );
    },
    { errorToast: (e) => e.message },
  );
  if (part.action === "merge") {
    const conflict = part.state === "conflict";
    const title = conflict
      ? `有冲突，没有合入${part.target ? ` ${part.target}` : "工作目录"}`
      : part.state === "up_to_date"
        ? `${part.target || "工作目录"} 已经包含这个会话的改动`
        : part.state === "applied"
          ? "已放进工作目录（没有提交）"
          : `已合入工作目录 · ${part.target}`;
    const sub = conflict
      ? `工作目录没有动。${part.files?.length ? `冲突：${part.files.slice(0, 4).join("、")}${part.files.length > 4 ? ` 等 ${part.files.length} 个` : ""}。` : ""}可点下方按钮让 Claude 合并冲突后再合入。`
      : part.state === "up_to_date"
        ? "没有新的提交需要合入。"
        : part.state === "applied"
          ? `${part.files?.length ?? 0} 个文件的改动来自 ${part.branch}，会同步到电脑上，在电脑上提交。`
          : `${part.state === "fast_forward" ? "快进" : "合并提交"} · ${part.commits ?? 0} 个提交来自 ${part.branch}`;
    return (
      <section className={cn("cc-git", conflict && "is-conflict")} data-state={part.state} data-testid="cc-git-merge">
        <span aria-hidden className="cc-git-ico">
          {conflict ? <IconAlertTriangle className="size-4" /> : <IconGitMerge className="size-4" />}
        </span>
        <div className="cc-git-main">
          <div className="cc-git-t">{title}</div>
          <div className="cc-git-s">{sub}</div>
          {conflict && sessionId ? (
            <div className="cc-git-actions">
              <Button data-testid="cc-git-fix" feedback={{ pending: "发送中…", success: "已交给 Claude", error: "没发出去" }} onClick={() => void fix.run()} size="sm" state={fix.state} variant="outline">
                {"让 Claude 处理"}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    );
  }
  const failed = part.state === "push_failed";
  return (
    <section className={cn("cc-git is-pr", failed && "is-conflict")} data-state={part.state} data-testid="cc-git-pr">
      <span aria-hidden className="cc-git-ico">
        {failed ? <IconAlertTriangle className="size-4" /> : <IconGitPullRequest className="size-4" />}
      </span>
      <div className="cc-git-main">
        <div className="cc-git-t">{failed ? "分支已推送，PR 没有开成" : `${part.state === "pr_exists" ? "PR 已经在了" : "已推送并开 PR"}${part.prNumber ? ` · #${part.prNumber}` : ""}`}</div>
        <div className="cc-git-s">
          <code>{part.branch}</code>
          {" → "}
          <code>{part.target}</code>
          {part.commits ? ` · ${part.commits} 个提交` : ""}
        </div>
        {failed && part.text ? <div className="cc-git-s is-err">{part.text}</div> : null}
      </div>
      {part.prUrl ? (
        <a className="cc-git-open" data-testid="cc-pr-link" href={part.prUrl} rel="noreferrer noopener" target="_blank">
          {"打开"}
          <IconExternalLink className="size-3.5" />
        </a>
      ) : null}
    </section>
  );
}

export const CcMessageView = memo(function CcMessageView({
  message,
  statusText,
  onOpenDiff,
  sessionId,
}: {
  message: CcMessage;
  statusText: string | null;
  onOpenDiff?: (turnId: string) => void;
  sessionId?: string;
}) {
  if (message.role === "user") {
    const text = message.parts.find((p) => p.type === "text") as { text: string } | undefined;
    return (
      <div className="cc-msg cc-msg-user" data-testid="cc-msg-user">
        <div className="cc-bubble-user">{text?.text ?? ""}</div>
        {message.status === "queued" ? <div className="cc-queued">{"已排队，这一轮结束后发给 Claude"}</div> : null}
      </div>
    );
  }
  if (message.role === "system")
    return (
      <div className="cc-msg cc-msg-system">
        {message.parts.map((p, i) =>
          p.type === "notice" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 系统消息的段没有 id
            <span className="cc-notice" key={i}>
              {p.text}
            </span>
          ) : p.type === "git" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <CcGitCard key={i} part={p} sessionId={sessionId} />
          ) : null,
        )}
      </div>
    );
  const running = message.status === "running";
  const list = blocks(message.parts);
  const hasText = message.parts.some((p) => p.type === "text" && p.text);
  const lastIsTool = list[list.length - 1]?.kind === "tools";
  return (
    <div className="cc-msg cc-msg-bot" data-status={message.status} data-testid="cc-msg-bot">
      {list.map((b) => {
        if (b.kind === "tools") return <ToolGroup key={b.key} running={running} tools={b.tools} />;
        const p = b.part;
        switch (p.type) {
          case "text":
            return (
              <div className="cc-text" data-testid="cc-text" key={b.key}>
                <SmoothStreamdown>{p.text}</SmoothStreamdown>
              </div>
            );
          case "approval":
            return <CcApprovalCard key={b.key} part={p} />;
          case "changes":
            return <ChangesCard key={b.key} onOpen={onOpenDiff} part={p} />;
          case "error":
            return (
              <div className="cc-error" data-testid="cc-error" key={b.key} role="alert">
                <IconAlertTriangle className="size-4 flex-none" />
                <span>{p.text}</span>
              </div>
            );
          case "notice":
            return (
              <div className="cc-msg-system" key={b.key}>
                <span className="cc-notice">{p.text}</span>
              </div>
            );
          default:
            return null;
        }
      })}
      {running && (!hasText || statusText || lastIsTool) && !message.parts.some((p) => p.type === "approval" && p.state === "pending") ? (
        <div className="chat-thinking cc-thinking" data-testid="cc-thinking" role="status">
          <span aria-hidden="true" className="chat-thinking-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="cc-thinking-t">{statusText ?? "Claude 正在干活"}</span>
        </div>
      ) : null}
      {!running && message.meta && (message.meta.durationMs || message.meta.costUsd) ? (
        <div className="cc-meta">
          {[message.meta.durationMs ? `${Math.max(1, Math.round(message.meta.durationMs / 1000))} 秒` : null, typeof message.meta.costUsd === "number" ? `$${message.meta.costUsd.toFixed(3)}` : null, message.meta.undone ? "改动已撤销" : null].filter(Boolean).join(" · ")}
        </div>
      ) : null}
    </div>
  );
});
