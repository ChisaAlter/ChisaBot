import {
  IconActivity,
  IconCheck,
  IconPencil,
  IconPlus,
  IconPower,
  IconRefresh,
  IconServer,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  activateExecutionNode,
  appPackagesKeys,
  createExecutionNode,
  deactivateExecutionNodes,
  deleteExecutionNode,
  type ExecutionNodeHealthResult,
  type ExecutionNodeView,
  executionNodesQueryOptions,
  probeExecutionNodeById,
  probeExecutionNodeDraft,
  updateExecutionNode,
} from "@/lib/app-packages";

type NodeFormState = {
  id?: string;
  name: string;
  baseUrl: string;
  token: string;
  allowPrivateNetwork: boolean;
  hasExistingToken: boolean;
};

const EMPTY_FORM: NodeFormState = {
  name: "",
  baseUrl: "",
  token: "",
  allowPrivateNetwork: false,
  hasExistingToken: false,
};

function healthBadge(status: ExecutionNodeView["lastHealthStatus"]): {
  label: string;
  className: string;
} {
  if (status === "healthy") {
    return {
      label: "健康",
      className:
        "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium",
    };
  }
  if (status === "unhealthy") {
    return {
      label: "异常",
      className: "bg-destructive/15 text-destructive font-medium",
    };
  }
  return {
    label: "未探测",
    className: "bg-muted text-muted-foreground",
  };
}

/**
 * 远程执行节点可视化热配置与一键热切换面板（挂载于 管理台 → 云端浏览器 页）。
 */
export function ExecutionNodePanel({ settingItem }: { settingItem?: string }) {
  const queryClient = useQueryClient();
  const nodesQuery = useQuery(executionNodesQueryOptions());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<NodeFormState>(EMPTY_FORM);
  const [draftHealth, setDraftHealth] =
    useState<ExecutionNodeHealthResult | null>(null);

  const refreshNodes = () =>
    queryClient.invalidateQueries({ queryKey: appPackagesKeys.executionNodes });

  const saveMutation = useMutation({
    mutationFn: async (current: NodeFormState) => {
      if (current.id) {
        return updateExecutionNode(current.id, {
          name: current.name,
          baseUrl: current.baseUrl,
          ...(current.token.trim() ? { token: current.token.trim() } : {}),
          allowPrivateNetwork: current.allowPrivateNetwork,
        });
      }
      return createExecutionNode({
        name: current.name,
        baseUrl: current.baseUrl,
        ...(current.token.trim() ? { token: current.token.trim() } : {}),
        allowPrivateNetwork: current.allowPrivateNetwork,
      });
    },
    onSuccess: (node) => {
      void refreshNodes();
      toast.success(`已保存远程执行节点「${node.name}」`);
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      setDraftHealth(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const activateMutation = useMutation({
    mutationFn: activateExecutionNode,
    onSuccess: (res) => {
      queryClient.setQueryData(appPackagesKeys.executionNodes, res);
      toast.success("已热切换激活所选远程执行节点，新请求立即生效");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deactivateMutation = useMutation({
    mutationFn: deactivateExecutionNodes,
    onSuccess: (res) => {
      queryClient.setQueryData(appPackagesKeys.executionNodes, res);
      toast.success("已切回静态环境变量默认模式");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const probeMutation = useMutation({
    mutationFn: probeExecutionNodeById,
    onSuccess: ({ node, health }) => {
      void refreshNodes();
      if (health.ok) {
        toast.success(
          `节点「${node.name}」连通正常（${health.latencyMs} ms）`,
        );
      } else {
        toast.error(
          `节点「${node.name}」探活失败：${health.error ?? `HTTP ${health.status ?? "错误"}`}`,
        );
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const draftProbeMutation = useMutation({
    mutationFn: probeExecutionNodeDraft,
    onSuccess: (health) => {
      setDraftHealth(health);
      if (health.ok) {
        toast.success(`探活成功（${health.latencyMs} ms）`);
      } else {
        toast.error(health.error ?? "节点探活失败");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteExecutionNode,
    onSuccess: () => {
      void refreshNodes();
      toast.success("已删除远程执行节点");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = nodesQuery.data;
  const nodes = data?.nodes ?? [];

  return (
    <>
      <PageSection
        action={
          <div className="flex items-center gap-2">
            {data?.activeNodeId ? (
              <Button
                disabled={deactivateMutation.isPending}
                onClick={() => deactivateMutation.mutate()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconPower className="size-3.5" />
                {"切回静态环境变量"}
              </Button>
            ) : null}
            <Button
              disabled={nodesQuery.isFetching}
              onClick={() => void nodesQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconRefresh className="size-3.5" />
              {"刷新"}
            </Button>
            <Button
              data-testid="add-execution-node-btn"
              onClick={() => {
                setForm(EMPTY_FORM);
                setDraftHealth(null);
                setDialogOpen(true);
              }}
              size="sm"
              type="button"
            >
              <IconPlus className="size-3.5" />
              {"添加执行节点"}
            </Button>
          </div>
        }
        description="管理多个远程 agent-computer 执行节点，支持连通性探活与零重启热切换；未激活任何远程节点时自动无缝回退到环境变量静态模式。"
        settingItem={settingItem}
        title="远程执行节点热切换"
      >
        <div className="space-y-3" data-testid="execution-node-panel">
          {data ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {data.activeNodeId
                ? `当前生效：动态远程执行节点（${nodes.find((n) => n.id === data.activeNodeId)?.name ?? data.activeNodeId}）`
                : data.staticFallbackConfigured
                  ? `当前生效：静态环境变量模式（${data.staticFallbackProvider ?? "shared"}）`
                  : "当前未激活远程执行节点，且未配置静态云端电脑环境变量。"}
            </div>
          ) : null}

          {nodesQuery.isPending ? (
            <PageSkeleton rows={2} />
          ) : nodesQuery.error ? (
            <p className="text-destructive text-sm" role="alert">
              {nodesQuery.error.message}
            </p>
          ) : nodes.length === 0 ? (
            <PageEmpty>
              {"尚未配置远程执行节点。点击「添加执行节点」即可热切换远端 agent-computer 服务。"}
            </PageEmpty>
          ) : (
            <div className="space-y-2.5">
              {nodes.map((node) => {
                const badge = healthBadge(node.lastHealthStatus);
                return (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 p-3.5"
                    data-testid={`execution-node-row-${node.id}`}
                    key={node.id}
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <IconServer className="size-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{node.name}</span>
                        {node.isActive ? (
                          <span className="rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary text-xs">
                            {"当前激活"}
                          </span>
                        ) : null}
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${badge.className}`}
                        >
                          {badge.label}
                          {node.lastHealthDetail?.latencyMs !== undefined
                            ? ` · ${node.lastHealthDetail.latencyMs} ms`
                            : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 font-mono text-muted-foreground text-xs">
                        <span className="break-all">{node.baseUrl}</span>
                        <span>{node.hasToken ? "· 已加密令牌" : "· 无令牌"}</span>
                        {node.allowPrivateNetwork ? (
                          <span>{"· 允许私网"}</span>
                        ) : null}
                      </div>
                      {node.lastHealthDetail?.error ? (
                        <div className="text-destructive text-xs">
                          {node.lastHealthDetail.error}
                        </div>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        disabled={probeMutation.isPending}
                        onClick={() => probeMutation.mutate(node.id)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <IconActivity className="size-3.5" />
                        {"探活"}
                      </Button>
                      {!node.isActive ? (
                        <Button
                          data-testid={`activate-node-${node.id}`}
                          disabled={activateMutation.isPending}
                          onClick={() => activateMutation.mutate(node.id)}
                          size="sm"
                          type="button"
                        >
                          <IconCheck className="size-3.5" />
                          {"热切换激活"}
                        </Button>
                      ) : null}
                      <Button
                        onClick={() => {
                          setForm({
                            id: node.id,
                            name: node.name,
                            baseUrl: node.baseUrl,
                            token: "",
                            allowPrivateNetwork: node.allowPrivateNetwork,
                            hasExistingToken: node.hasToken,
                          });
                          setDraftHealth(null);
                          setDialogOpen(true);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <IconPencil className="size-3.5" />
                      </Button>
                      <Button
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(node.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconTrash className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PageSection>

      <Dialog onOpenChange={setDialogOpen} open={dialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {form.id ? "编辑远程执行节点" : "添加远程执行节点"}
            </DialogTitle>
            <DialogDescription>
              {"访问令牌使用 AES-256-GCM 加密封存；变更节点地址域名时旧令牌会自动清除以防跨源外泄。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <FieldGroup>
              <Field>
                <FieldLabel>{"节点名称"}</FieldLabel>
                <Input
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                  placeholder="例如：上海 GPU 节点 / 内网执行节点"
                  value={form.name}
                />
              </Field>
              <Field>
                <FieldLabel>{"节点地址（Base URL）"}</FieldLabel>
                <Input
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  placeholder="https://exec-node.example.com"
                  value={form.baseUrl}
                />
              </Field>
              <Field>
                <FieldLabel>
                  {"访问令牌"}
                  {form.hasExistingToken ? "（已加密保存）" : ""}
                </FieldLabel>
                <Input
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, token: e.target.value }))
                  }
                  placeholder={
                    form.hasExistingToken
                      ? "留空保持现有加密令牌，输入新值可替换"
                      : "输入 AGENT_COMPUTER_TOKEN（可选）"
                  }
                  type="password"
                  value={form.token}
                />
              </Field>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
                <div>
                  <div className="font-medium">{"允许内网 / 专网 HTTP 地址"}</div>
                  <div className="text-muted-foreground">
                    {"开启后允许连接局域网或 Tailscale/VPN 节点，仍始终拦截云元数据地址。"}
                  </div>
                </div>
                <Switch
                  checked={form.allowPrivateNetwork}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({
                      ...prev,
                      allowPrivateNetwork: checked,
                    }))
                  }
                />
              </div>
            </FieldGroup>

            {draftHealth ? (
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  draftHealth.ok
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                }`}
              >
                {draftHealth.ok
                  ? `连通正常（HTTP ${draftHealth.status ?? 200} · ${draftHealth.latencyMs} ms）`
                  : `探测失败：${draftHealth.error ?? `HTTP ${draftHealth.status ?? "错误"}`}`}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => setDialogOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              disabled={draftProbeMutation.isPending || !form.baseUrl.trim()}
              onClick={() =>
                draftProbeMutation.mutate({
                  ...(form.id ? { nodeId: form.id } : {}),
                  baseUrl: form.baseUrl.trim(),
                  ...(form.token.trim() ? { token: form.token.trim() } : {}),
                  allowPrivateNetwork: form.allowPrivateNetwork,
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              <IconActivity className="size-3.5" />
              {draftProbeMutation.isPending ? "探测中…" : "测试连通性"}
            </Button>
            <Button
              disabled={
                saveMutation.isPending ||
                !form.name.trim() ||
                !form.baseUrl.trim()
              }
              onClick={() => saveMutation.mutate(form)}
              size="sm"
              type="button"
            >
              {saveMutation.isPending ? "保存中…" : "保存节点"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
