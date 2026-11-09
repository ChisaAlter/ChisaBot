import {
  IconBrandGithub,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconGitPullRequest,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useRef } from "react";
import { z } from "zod";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { useRenderTool } from "@/lib/chat/renderers";
import {
  decideGithubAction,
  githubActionQueryOptions,
  githubKeys,
} from "@/lib/github";
import type {
  GithubActionKind,
  GithubActionView,
} from "../../../../shared/github";

/**
 * GitHub 写操作的确认卡片（DESIGN.md §53）。RENDER ONLY：工具在服务器上等用户点「允许 / 拒绝」，
 * 点「允许」时服务器才真正调用 GitHub。卡片按工具结果里的 ⟦github:id⟧ 找到这条操作（重新打开对话也对得上）。
 */
const parameters = z.object({
  repo: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  number: z.number().optional(),
  head: z.string().optional(),
  base: z.string().optional(),
  draft: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});
type Given = z.infer<typeof parameters>;

const TOOLS: { name: string; kind: GithubActionKind }[] = [
  { name: "github_create_issue", kind: "create_issue" },
  { name: "github_comment", kind: "comment" },
  { name: "github_create_pr", kind: "create_pr" },
];

function useGithubRender(tool: (typeof TOOLS)[number]) {
  useRenderTool({
    name: tool.name,
    parameters,
    render: ({ parameters: given, status, result }) => (
      <GithubActionCard
        given={given ?? {}}
        kind={tool.kind}
        result={typeof result === "string" ? result : undefined}
        running={status !== "complete"}
      />
    ),
  });
}

export function GithubTool() {
  useGithubRender(TOOLS[0]!);
  useGithubRender(TOOLS[1]!);
  useGithubRender(TOOLS[2]!);
  return null;
}

const ACTION_ID = /⟦github:(ga_[a-z0-9]+)⟧/;

function headline(kind: GithubActionKind, repo: string, number?: number) {
  if (kind === "comment")
    return `在 ${repo}${number ? `#${number}` : ""} 发表评论`;
  if (kind === "create_pr") return `在 ${repo} 创建 Pull Request`;
  return `在 ${repo} 创建 Issue`;
}

const GithubActionCard = memo(function GithubActionCard({
  kind,
  given,
  running,
  result,
}: {
  kind: GithubActionKind;
  given: Given;
  running: boolean;
  result?: string;
}) {
  const queryClient = useQueryClient();
  const id = result?.match(ACTION_ID)?.[1];
  const repo = typeof given.repo === "string" ? given.repo : "";
  const action = useQuery(
    githubActionQueryOptions({
      ...(id ? { id } : {}),
      kind,
      repo,
      poll: running && !id,
    }),
  );
  const mountedAt = useRef(Date.now());
  const row: GithubActionView | null = action.data ?? null;
  // 工具还没返回时按 kind + repo 找最新一条：比卡片早出现的（上一次的同类操作）不认。
  const live =
    row !== null &&
    (id
      ? row.id === id
      : running && Date.parse(row.createdAt) >= mountedAt.current - 5000);
  const state =
    live && row
      ? row.status
      : running
        ? "preparing"
        : result && /已在 .* 创建/.test(result)
          ? "done"
          : "stopped";
  const decide = (approve: boolean) => async () => {
    if (!row) throw new Error("还没准备好，稍等一下");
    const next = await decideGithubAction(row.id, approve);
    queryClient.setQueryData(githubKeys.action(id ?? `${kind}:${repo}`), next);
    if (next.status === "failed")
      throw new Error(next.result?.error ?? "GitHub 没有接受");
  };
  const approve = useAsyncAction(decide(true), {
    errorToast: (error) => error.message,
  });
  const reject = useAsyncAction(decide(false), {
    errorToast: (error) => error.message,
  });
  const payload = live && row ? row.payload : given;
  const number = payload.number ?? given.number;
  const done = state === "done";
  const bad = state === "failed";
  const stopped =
    state === "rejected" || state === "expired" || state === "stopped";
  const pending = state === "pending" && running;
  const url =
    live && row
      ? row.result?.url
      : result?.match(/https:\/\/github\.com\/\S+/)?.[0];
  const sub = done
    ? `已发出${live && row.result?.number ? ` · #${row.result.number}` : ""}`
    : bad
      ? `GitHub 没有接受：${(live && row?.result?.error) || "未知错误"}`
      : state === "rejected"
        ? "你拒绝了，什么都没有发出。"
        : state === "expired"
          ? "已过期，没有发出。"
          : stopped
            ? "没有发出。"
            : state === "running"
              ? "正在发到 GitHub…"
              : "机器人想做这件事，你点「允许」后才会发出。";

  return (
    <div
      className="gh-card"
      data-state={done ? "done" : bad ? "failed" : stopped ? "stopped" : "open"}
      data-testid="github-action-card"
    >
      <div className="gh-card-h">
        <span className="gh-card-ico">
          {done ? (
            <IconCircleCheck className="size-5" />
          ) : bad || stopped ? (
            <IconCircleX className="size-5" />
          ) : kind === "create_pr" ? (
            <IconGitPullRequest className="size-5" />
          ) : (
            <IconBrandGithub className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="gh-card-t">
            {headline(kind, repo || "仓库", number)}
          </div>
          <div className="gh-card-s">{sub}</div>
        </div>
      </div>
      <div className="gh-card-p">
        {payload.title ? (
          <div className="gh-card-pt">{payload.title}</div>
        ) : null}
        {kind === "create_pr" && (payload.head || payload.base) ? (
          <div className="gh-card-chips">
            <span className="gh-chip is-code">{`${payload.head ?? "?"} → ${payload.base ?? "?"}`}</span>
            {payload.draft ? <span className="gh-chip">{"草稿"}</span> : null}
          </div>
        ) : null}
        {payload.labels?.length ? (
          <div className="gh-card-chips">
            {payload.labels.map((label) => (
              <span className="gh-chip" key={label}>
                {label}
              </span>
            ))}
          </div>
        ) : null}
        {payload.body ? (
          <div className="gh-card-body">{payload.body}</div>
        ) : kind !== "comment" ? (
          <div className="gh-card-body is-empty">{"（没有正文）"}</div>
        ) : null}
      </div>
      {pending || state === "running" || state === "preparing" ? (
        <div className="gh-card-f">
          <Button
            disabled={!pending || reject.state === "pending"}
            feedback={{ pending: "发送中…", success: "已发出", error: "失败" }}
            onClick={() => void approve.run()}
            size="sm"
            state={
              state === "running" && approve.state === "idle"
                ? "pending"
                : approve.state
            }
          >
            {"允许"}
          </Button>
          <Button
            disabled={!pending || approve.state === "pending"}
            onClick={() => void reject.run()}
            size="sm"
            state={reject.state}
            variant="ghost"
          >
            {"拒绝"}
          </Button>
        </div>
      ) : null}
      {done && url ? (
        <a
          className="gh-card-link"
          href={url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {"在 GitHub 查看"}
          <IconExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
});
