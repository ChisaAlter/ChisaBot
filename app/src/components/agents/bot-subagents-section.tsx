import {
  IconDeviceDesktop,
  IconExternalLink,
  IconRobot,
  IconServer,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  AGENT_DRIVER_SPECS,
  type AgentInstanceView,
  type BotAgentGrant,
  type BotAgentGrantMode,
  localAgentKeys,
  SERVER_ENVIRONMENT_ID,
  saveBotAgentGrant,
  useBotAgentGrant,
} from "@/lib/local-agents";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<BotAgentGrantMode, string> = {
  all: "允许调用全部已启用智能体",
  selected: "仅允许调用勾选的智能体",
  none: "禁止调用子代理",
};

export function BotSubagentsSection({
  agentId,
  canManage,
  onNavigateAway,
}: {
  agentId: string;
  canManage: boolean;
  onNavigateAway?: () => void;
}) {
  const queryClient = useQueryClient();
  const grantQuery = useBotAgentGrant(agentId);
  const [saving, setSaving] = useState(false);

  if (grantQuery.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (grantQuery.isError || !grantQuery.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {"无法加载这个机器人的子代理授权配置。"}
      </p>
    );
  }

  const { grant, instances } = grantQuery.data;

  const applyPatch = async (
    patch: Partial<
      Pick<
        BotAgentGrant,
        | "mode"
        | "instanceIds"
        | "exposeNamedTools"
        | "allowNestedSubagents"
        | "maxDepth"
      >
    >,
  ) => {
    if (!canManage || saving) return;
    setSaving(true);
    try {
      await saveBotAgentGrant(agentId, patch);
      await queryClient.invalidateQueries({
        queryKey: localAgentKeys.botGrant(agentId),
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "保存子代理授权失败",
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleInstance = (inst: AgentInstanceView, checked: boolean) => {
    const current = new Set(grant.instanceIds);
    if (checked) {
      current.add(inst.id);
    } else {
      current.delete(inst.id);
    }
    void applyPatch({
      mode: "selected",
      instanceIds: [...current],
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-[440px] text-sm text-muted-foreground">
          {
            "将已配置的智能体提供方（Codex、Claude Code、Antigravity、Codebuddy、Devin 等）挂载给这个机器人作为工具去派发任务，支持同步拿回结果或后台并行执行。"
          }
        </p>
        <Button
          nativeButton={false}
          onClick={() => onNavigateAway?.()}
          render={<Link to="/settings/agent-providers" />}
          size="xs"
          variant="outline"
        >
          <IconExternalLink className="size-3.5" />
          {"管理提供方"}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{"子代理调用范围"}</ItemTitle>
            <ItemDescription>
              {"控制该机器人能否把编码、分析或自动化任务委派给外部智能体实例。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Select
              disabled={!canManage || saving}
              onValueChange={(val) =>
                val && void applyPatch({ mode: val as BotAgentGrantMode })
              }
              value={grant.mode}
            >
              <SelectTrigger className="min-w-[195px]" size="sm">
                <SelectValue>{MODE_LABELS[grant.mode]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{MODE_LABELS.all}</SelectItem>
                <SelectItem value="selected">{MODE_LABELS.selected}</SelectItem>
                <SelectItem value="none">{MODE_LABELS.none}</SelectItem>
              </SelectContent>
            </Select>
          </ItemActions>
        </Item>

        {grant.mode !== "none" ? (
          <>
            <Item variant="muted">
              <ItemContent>
                <ItemTitle>{"挂载为独立具名工具"}</ItemTitle>
                <ItemDescription>
                  {
                    "除通用 subagent_run 外，还将每个可用实例暴露为独立工具（如 agent_codex），方便机器人按职责精准挑选。"
                  }
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  checked={grant.exposeNamedTools}
                  disabled={!canManage || saving}
                  onCheckedChange={(v) =>
                    void applyPatch({ exposeNamedTools: Boolean(v) })
                  }
                />
              </ItemActions>
            </Item>

            <Item variant="muted">
              <ItemContent>
                <ItemTitle>{"允许子代理之间嵌套互调"}</ItemTitle>
                <ItemDescription>
                  {
                    "开启后，正在运行的外部智能体（如 Claude / Antigravity）可通过本地 MCP 工具桥调用其他子代理协同工作。"
                  }
                </ItemDescription>
              </ItemContent>
              <ItemActions className="flex items-center gap-2">
                {grant.allowNestedSubagents ? (
                  <Select
                    disabled={!canManage || saving}
                    onValueChange={(val) =>
                      val && void applyPatch({ maxDepth: Number(val) })
                    }
                    value={String(grant.maxDepth)}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue>{`最多 ${grant.maxDepth} 层`}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {`最多 ${d} 层`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Switch
                  checked={grant.allowNestedSubagents}
                  disabled={!canManage || saving}
                  onCheckedChange={(v) =>
                    void applyPatch({ allowNestedSubagents: Boolean(v) })
                  }
                />
              </ItemActions>
            </Item>
          </>
        ) : null}
      </div>

      {grant.mode !== "none" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {grant.mode === "selected"
                ? "勾选允许此机器人调用的智能体实例"
                : "当前可用的智能体实例一览"}
            </span>
            <span className="text-xs text-muted-foreground">
              {`${instances.filter((i) => i.enabled).length} 个已启用`}
            </span>
          </div>

          {instances.length === 0 ? (
            <Empty className="h-[140px] border border-dashed">
              <EmptyHeader>
                <EmptyTitle className="text-muted-foreground">
                  {"尚未配置智能体提供方"}
                </EmptyTitle>
                <EmptyDescription>
                  {
                    "前往「设置 → 智能体提供方」启用或添加 Codex、Claude、Antigravity 等实例。"
                  }
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-1.5">
              {instances.map((inst) => {
                const checked =
                  grant.mode === "all"
                    ? inst.enabled
                    : grant.instanceIds.includes(inst.id);
                const spec = AGENT_DRIVER_SPECS[inst.driver];
                return (
                  <div
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5",
                      !inst.enabled && "opacity-60",
                    )}
                    key={inst.id}
                  >
                    <div className="flex min-w-0 items-start gap-2.5">
                      <IconRobot className="mt-0.5 size-4 shrink-0 text-primary" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-medium">
                            {inst.name}
                          </span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {spec.label}
                          </span>
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            {inst.environmentId === SERVER_ENVIRONMENT_ID ? (
                              <IconServer className="size-3" />
                            ) : (
                              <IconDeviceDesktop className="size-3" />
                            )}
                            {inst.environmentName}
                          </span>
                          {!inst.enabled ? (
                            <span className="text-[11px] text-amber-600 dark:text-amber-400">
                              {"（全局已禁用）"}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <code className="font-mono text-[11px]">
                            {inst.toolName}
                          </code>
                          {inst.description ? (
                            <span className="truncate">{inst.description}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {grant.mode === "selected" ? (
                      <Checkbox
                        aria-label={`授权调用 ${inst.name}`}
                        checked={checked}
                        disabled={!canManage || saving}
                        onCheckedChange={(val) =>
                          toggleInstance(inst, Boolean(val))
                        }
                      />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {inst.enabled ? "已挂载" : "未启用"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
