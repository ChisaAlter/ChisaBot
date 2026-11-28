import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useElementSync, useInterval, useTimeout } from "@/hooks";
import { reportHabitFeedbackMutationOptions } from "@/lib/composer/mutations";
import {
  type ComposerCandidate,
  composerAiSuggestionsQueryOptions,
  composerCandidatesQueryOptions,
  composerSettingsQueryOptions,
} from "@/lib/composer/queries";

/**
 * 本地输入候选条：快捷短语与高频习惯，按服务器的排序原样渲染。
 *
 * 呈现在编辑器正上方，点击把整句填进输入框（不发送）。候选条是被动的：
 * 不参与键盘焦点以外的任何输入语义，中文输入法组合期间也只是安静待着——
 * 它从不往里写字，只有人点了才写。
 */

const PREVIEW_MAX = 42;

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

export function CandidateStrip({
  candidates,
  onAccept,
}: {
  candidates: readonly ComposerCandidate[];
  onAccept: (text: string) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      aria-label="输入候选"
      className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5"
      role="listbox"
    >
      {candidates.map((candidate) => (
        <button
          aria-label={candidate.text}
          className="max-w-full truncate rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          key={candidate.text}
          onClick={() => onAccept(candidate.text)}
          role="option"
          title={candidate.text}
          type="button"
        >
          {candidate.source === "ai" ? (
            <span className="mr-1 text-primary/70">AI</span>
          ) : null}
          {preview(candidate.text)}
        </button>
      ))}
    </div>
  );
}

/**
 * 候选条的容器：防抖、查询、门控全部收在这里。Composer 本体不直接碰查询——
 * 它是叶子组件，测试与若干表面在没有 QueryClientProvider 的地方渲染它；
 * 只有显式传了 candidatesBotId 的表面才会挂载本组件，查询也只在这里发生。
 */
export function ComposerCandidates({
  botId,
  text,
  hasChips,
  aiContext,
  onAccept,
}: {
  botId: string | null;
  /** 最近对话上下文（AI 建议用，PR5）：输入为空且设置开启时出下一步建议。 */
  aiContext?: readonly { role: "user" | "bot"; text: string }[];
  /** 当前草稿纯文本（trim 后）；空串不出候选。 */
  text: string;
  /** 草稿带 @/命令 chip 时不出候选：填入是整框替换，不能毁字。 */
  hasChips: boolean;
  onAccept: (text: string) => void;
}) {
  const [prefix, setPrefix] = useState("");
  useTimeout(() => setPrefix(text), 180, text);
  const query = useQuery(composerCandidatesQueryOptions(botId, prefix));

  // AI 建议（PR5）：输入为空、设置开启、有对话上下文时，prefetch 下一步建议。
  // key 取上下文尾部指纹——新消息到达 key 变化自然重取，服务端 60s 缓存与限流兜底成本。
  const settingsQuery = useQuery(composerSettingsQueryOptions());
  const aiEnabled = settingsQuery.data?.aiEnabled === true;
  const contextKey = (aiContext ?? [])
    .map(
      (message) =>
        `${message.role}:${message.text.length}:${message.text.slice(0, 40)}`,
    )
    .join("|");
  const showAi =
    aiEnabled && text.length === 0 && !hasChips && contextKey.length > 0;
  const aiQuery = useQuery(
    composerAiSuggestionsQueryOptions(
      botId,
      showAi ? contextKey : "",
      aiContext ?? [],
    ),
  );

  const local =
    text.length > 0 && text === prefix && !hasChips ? (query.data ?? []) : [];
  const ai = showAi ? (aiQuery.data?.suggestions ?? []) : [];
  const seen = new Set<string>();
  const candidates: ComposerCandidate[] = [];
  for (const candidate of [...local, ...ai]) {
    const key = candidate.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= 5) break;
  }
  /*
   * 习惯反馈记账（PR7）：只对 habit 来源候选计数（phrase 是用户自维护、ai 无习惯行）。
   * shown：候选进入条时记一次；accepted：点选时记；ignored：候选从条上消失且未被点选时记。
   * useElementSync 的 cleanup 天然是「消失」的语义——候选列表变化或组件卸载都会触发。
   * 事件进队列按 3s 合批上报；被动记账，失败静默。
   */
  const stripRef = useRef<HTMLDivElement | null>(null);
  const queueRef = useRef<
    { kind: "shown" | "accepted" | "ignored"; text: string }[]
  >([]);
  const shownPendingRef = useRef(new Set<string>());
  const feedback = useMutation(reportHabitFeedbackMutationOptions());
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  useInterval(() => {
    const queue = queueRef.current;
    if (!botId || queue.length === 0) return;
    queueRef.current = [];
    feedbackRef.current.mutate({ botId, events: queue }, { onError: () => {} });
  }, 3_000);
  const candidatesKey = candidates.map((c) => c.text).join("|");
  const prevHabitsRef = useRef(new Set<string>());
  useElementSync(stripRef, candidatesKey, () => {
    const current = new Set(
      candidates.filter((c) => c.source === "habit").map((c) => c.text),
    );
    for (const text of current) {
      if (!prevHabitsRef.current.has(text)) {
        queueRef.current.push({ kind: "shown", text });
        shownPendingRef.current.add(text);
      }
    }
    for (const text of prevHabitsRef.current) {
      if (!current.has(text) && shownPendingRef.current.has(text)) {
        shownPendingRef.current.delete(text);
        queueRef.current.push({ kind: "ignored", text });
      }
    }
    prevHabitsRef.current = current;
    return () => {
      // 组件卸载：仍在展示的 habit 候选按 ignored 收尾（近似语义，被动记账可接受）。
      for (const text of shownPendingRef.current) {
        queueRef.current.push({ kind: "ignored", text });
      }
      shownPendingRef.current.clear();
      prevHabitsRef.current = new Set();
    };
  });
  const acceptWithFeedback = (text: string) => {
    if (shownPendingRef.current.has(text)) {
      shownPendingRef.current.delete(text);
      queueRef.current.push({ kind: "accepted", text });
    }
    onAccept(text);
  };

  return (
    <div ref={stripRef}>
      <CandidateStrip candidates={candidates} onAccept={acceptWithFeedback} />
    </div>
  );
}
