import { useMutation, useQuery } from "@tanstack/react-query";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageSection } from "@/components/layout/page-shell";
import { Card } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { handoffRoster } from "@/lib/agents/handoff-roster";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";
import { queryClient as sharedQueryClient } from "@/query-client";

/**
 * 这个机器人可以问谁（bot-to-bot 授权，kind="bot"）。
 *
 * 方向性，写在卡上：这是它能问谁，不是谁能问它。写授权是管理员的事
 * （`enablementRefusal` 的 bot 分支 admin-only），非管理员看到的是只读清单。
 * 隐藏的机器人也参与 join——授权不按你的显示偏好过滤，藏起来的只能收回不能新发
 * （见 `handoffRoster` 的说明，那是这条 join 当年踩过的坑）。
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const setGrant = useMutation(
    setHandoffGrantMutationOptions(sharedQueryClient),
  );

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable, grantable } = handoff.data;

  const { candidates, granted, total } = handoffRoster({
    agentId,
    roster: agents.data ?? [],
    hidden: hiddenAgents.data ?? [],
    reachable,
    grantable,
  });

  // 不是管理员、又没有任何已授权可看的，这张卡对它没有内容。
  if (!canGrant && candidates.length === 0) return null;

  return (
    <PageSection
      description={
        "这个机器人可以问谁，而不是谁可以问它。被问的机器人的回答会回到问它的对话里。改动只有管理员能做。"
      }
      title={`可询问的机器人${total > 0 ? ` · ${granted}/${total}` : ""}`}
    >
      <Card className="bp-card">
        {!enabled ? (
          <p className="px-5 py-4 text-muted-foreground text-sm">
            {"此部署已关闭机器人互相询问；这些授权保留但不生效。"}
          </p>
        ) : null}
        {!grantable ? (
          <p className="px-5 py-4 text-muted-foreground text-sm">
            {"这个机器人不能持有询问授权；它仍然可以被能询问的机器人问到。"}
          </p>
        ) : null}
        {setGrant.error ? (
          <p className="px-5 py-4 text-destructive text-sm" role="alert">
            {setGrant.error.message}
          </p>
        ) : null}
        {candidates.length === 0 ? (
          <p className="px-5 py-4 text-muted-foreground text-sm">
            {"没有别的机器人可以问。"}
          </p>
        ) : (
          candidates.map((candidate) => (
            <div className="bp-srow sg-srow is-inline" key={candidate.id}>
              <span className="sg-srow-c flex min-w-0 items-center gap-2.5">
                <AbstractAvatar
                  agentId={candidate.id}
                  name={candidate.name}
                  seed={candidate.avatarSeed}
                  size={28}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-sm">
                    {candidate.name}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {candidate.hidden
                      ? `${candidate.title} · 已从你的名册隐藏`
                      : candidate.title}
                  </span>
                </span>
              </span>
              <Switch
                aria-label={`让这个机器人询问 ${candidate.name}`}
                checked={reachable.includes(candidate.id)}
                disabled={!canGrant || setGrant.isPending}
                onCheckedChange={(next: boolean) =>
                  setGrant.mutate({ agentId, ref: candidate.id, granted: next })
                }
              />
            </div>
          ))
        )}
        {!canGrant && candidates.length > 0 ? (
          <p className="px-5 py-3 text-muted-foreground text-xs">
            {"管理员决定哪些机器人可以被询问。"}
          </p>
        ) : null}
      </Card>
    </PageSection>
  );
}
