import {
  IconAlertCircle,
  IconBrandCodesandbox,
  IconBrandGoogle,
  IconBrandOpenai,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconCpu,
  IconDeviceDesktop,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconLock,
  IconPlus,
  IconRefresh,
  IconRobot,
  IconRotateClockwise,
  IconSearch,
  IconServer,
  IconSparkles,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorCard } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { agoText } from "@/lib/im";
import {
  type AcpRegistryEntry,
  AGENT_DRIVER_SPECS,
  AGENT_PROVIDER_PRESETS,
  type AgentDriverConfig,
  type AgentDriverKind,
  type AgentEnvironmentSummary,
  type AgentEnvVarInput,
  type AgentInstanceView,
  type AgentProviderPreset,
  acpRegistryQueryOptions,
  createAgentInstance,
  deleteAgentInstance,
  invalidateAgentProviderQueries,
  probeAgentInstance,
  probeAllEnvironmentInstances,
  SERVER_ENVIRONMENT_ID,
  saveEnvironmentSettings,
  updateAgentInstance,
  useAgentEnvironments,
  useAgentInstances,
  useEnvironmentSettings,
} from "@/lib/local-agents";
import { cn } from "@/lib/utils";
import {
  agentToolName,
  normalizeInstanceSlug,
} from "../../../../shared/agent-providers";
import {
  AGENT_PROFILES,
  type AgentProfile,
  ISOLATION_INFO,
  ISOLATIONS,
  type Isolation,
  PROFILE_INFO,
} from "../../../../shared/local-agents";

type DraftEnvRow = {
  id: string;
  name: string;
  value: string;
  sensitive: boolean;
  hasExistingSecret: boolean;
  dirtySecret: boolean;
};

type InstanceDraft = {
  name: string;
  slug: string;
  description: string;
  exposeAsTool: boolean;
  commandPath: string;
  homePath: string;
  shadowHomePath: string;
  extraArgsText: string;
  model: string;
  fixProxy: boolean;
  protocolMode: "auto" | "acp" | "cli";
  acpSource: "registry" | "local";
  acpAgentId: string;
  acpLauncher: "npx" | "uvx" | "binary" | "custom";
  acpPackage: string;
  stdinPrompt: boolean;
  outputFormat: "text" | "jsonl";
  defaultIsolation: "inherit" | Isolation;
  maxProfile: "inherit" | AgentProfile;
  requireStartApproval: boolean;
  envRows: DraftEnvRow[];
};

function parseArgsText(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const val = m[1] ?? m[2] ?? m[3] ?? "";
    if (val) tokens.push(val);
  }
  return tokens;
}

function formatArgsText(args: readonly string[] | undefined): string {
  if (!args?.length) return "";
  return args
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

function buildDraftFromInstance(inst: AgentInstanceView): InstanceDraft {
  const cfg = inst.config ?? {};
  return {
    name: inst.name,
    slug: inst.slug,
    description: inst.description ?? "",
    exposeAsTool: inst.exposeAsTool,
    commandPath: cfg.commandPath ?? "",
    homePath: cfg.homePath ?? "",
    shadowHomePath: cfg.shadowHomePath ?? "",
    extraArgsText: formatArgsText(cfg.extraArgs),
    model: cfg.model ?? "",
    fixProxy: cfg.fixProxy !== false,
    protocolMode: cfg.protocolMode ?? "auto",
    acpSource: cfg.acpSource ?? "local",
    acpAgentId: cfg.acpAgentId ?? "",
    acpLauncher: cfg.acpLauncher ?? "npx",
    acpPackage: cfg.acpPackage ?? "",
    stdinPrompt: cfg.stdinPrompt !== false,
    outputFormat: cfg.outputFormat ?? "text",
    defaultIsolation: cfg.defaultIsolation ?? "inherit",
    maxProfile: cfg.maxProfile ?? "inherit",
    requireStartApproval: cfg.requireStartApproval === true,
    envRows: (inst.envVars ?? []).map((ev, idx) => ({
      id: `${ev.name}-${idx}`,
      name: ev.name,
      value: ev.sensitive ? "" : ev.value,
      sensitive: ev.sensitive,
      hasExistingSecret: ev.sensitive && ev.hasValue,
      dirtySecret: false,
    })),
  };
}

function DriverIcon({
  driver,
  slug,
  className,
}: {
  driver: AgentDriverKind;
  slug?: string;
  className?: string;
}) {
  const s = (slug ?? "").toLowerCase();
  if (driver === "codex") {
    return (
      <IconBrandOpenai className={cn("size-5 text-foreground", className)} />
    );
  }
  if (driver === "claude") {
    return (
      <IconSparkles
        className={cn("size-5 text-amber-600 dark:text-amber-400", className)}
      />
    );
  }
  if (driver === "antigravity") {
    return (
      <IconBrandGoogle
        className={cn("size-5 text-blue-600 dark:text-blue-400", className)}
      />
    );
  }
  if (driver === "gemini") {
    return (
      <IconBrandGoogle className={cn("size-5 text-indigo-500", className)} />
    );
  }
  if (driver === "acp") {
    if (s.includes("devin")) {
      return (
        <IconBrandCodesandbox
          className={cn("size-5 text-teal-600 dark:text-teal-400", className)}
        />
      );
    }
    return (
      <IconCode
        className={cn(
          "size-5 text-emerald-600 dark:text-emerald-400",
          className,
        )}
      />
    );
  }
  if (driver === "builtin") {
    return <IconRobot className={cn("size-5 text-primary", className)} />;
  }
  if (driver === "custom") {
    return (
      <IconTerminal2
        className={cn("size-5 text-muted-foreground", className)}
      />
    );
  }
  return (
    <IconCpu
      className={cn("size-5 text-sky-600 dark:text-sky-400", className)}
    />
  );
}

function describeInstanceStatus(inst: AgentInstanceView): {
  text: string;
  tone: "muted" | "ok" | "warn";
} {
  if (!inst.enabled) {
    return { text: "已禁用", tone: "muted" };
  }
  if (!inst.environmentOnline) {
    return { text: "所在环境离线", tone: "warn" };
  }
  const probe = inst.probe;
  if (!probe) {
    return { text: "可用 · 待检测", tone: "muted" };
  }
  if (probe.status === "missing" || probe.status === "error") {
    const detail = probe.message ? ` · ${probe.message}` : "";
    return {
      text: `${probe.status === "missing" ? "未找到" : "异常"}${detail}`,
      tone: "warn",
    };
  }
  if (probe.status === "unauthenticated" || probe.authenticated === false) {
    return {
      text: `未认证${probe.message ? ` · ${probe.message}` : ""}`,
      tone: "warn",
    };
  }
  if (probe.authLabel) {
    return { text: `已认证 · ${probe.authLabel}`, tone: "ok" };
  }
  if (probe.authenticated) {
    return { text: "已认证", tone: "ok" };
  }
  return { text: probe.message || "可用", tone: "ok" };
}

export function AgentProvidersPage() {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions());
  const isAdmin = me.data?.role === "admin";

  const envsQuery = useAgentEnvironments();
  const environments = envsQuery.data ?? [];

  const [selectedEnvId, setSelectedEnvId] = useState<string>("");

  useEffect(() => {
    if (!environments.length) return;
    if (selectedEnvId && environments.some((e) => e.id === selectedEnvId)) {
      return;
    }
    const preferred =
      environments.find((e) => e.online && e.id !== SERVER_ENVIRONMENT_ID) ??
      environments.find((e) => e.online) ??
      environments[0];
    if (preferred) {
      setSelectedEnvId(preferred.id);
    }
  }, [environments, selectedEnvId]);

  const currentEnv: AgentEnvironmentSummary | undefined = useMemo(
    () => environments.find((e) => e.id === selectedEnvId) ?? environments[0],
    [environments, selectedEnvId],
  );
  const activeEnvId = currentEnv?.id ?? "";
  const readOnlyServer = activeEnvId === SERVER_ENVIRONMENT_ID && !isAdmin;

  const instancesQuery = useAgentInstances(activeEnvId || undefined);
  const envSettingsQuery = useEnvironmentSettings(activeEnvId || undefined);
  const instances = instancesQuery.data ?? [];

  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
  useEffect(() => {
    if (!instances.length) {
      setSelectedInstanceId("");
      return;
    }
    if (
      !selectedInstanceId ||
      !instances.some((item) => item.id === selectedInstanceId)
    ) {
      const first = instances[0];
      if (first) setSelectedInstanceId(first.id);
    }
  }, [instances, selectedInstanceId]);

  const selectedInstance = useMemo(
    () => instances.find((item) => item.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId],
  );

  const [probingAll, setProbingAll] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [envConfigOpen, setEnvConfigOpen] = useState(false);

  const latestCheckedAt = useMemo(() => {
    let latest: string | null = currentEnv?.detectedAt ?? null;
    for (const inst of instances) {
      const t = inst.probe?.checkedAt;
      if (t && (!latest || t > latest)) latest = t;
    }
    return latest;
  }, [currentEnv?.detectedAt, instances]);

  const handleProbeAll = async () => {
    if (!activeEnvId || probingAll) return;
    setProbingAll(true);
    try {
      await probeAllEnvironmentInstances(activeEnvId);
      await invalidateAgentProviderQueries(queryClient, activeEnvId);
      toast.success("已完成全部提供方状态检测");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "检测失败");
    } finally {
      setProbingAll(false);
    }
  };

  const handleToggleEnabled = async (
    inst: AgentInstanceView,
    enabled: boolean,
  ) => {
    if (readOnlyServer) {
      toast.error("只有管理员可以修改服务器本机的智能体提供方设置。");
      return;
    }
    try {
      await updateAgentInstance(inst.id, { enabled });
      await invalidateAgentProviderQueries(queryClient, activeEnvId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换状态失败");
    }
  };

  const handleCloneInstance = async (base: AgentInstanceView) => {
    if (!activeEnvId || readOnlyServer) return;
    const sameDriverCount =
      instances.filter((i) => i.driver === base.driver).length + 1;
    try {
      const created = await createAgentInstance({
        environmentId: activeEnvId,
        driver: base.driver,
        name: `${AGENT_DRIVER_SPECS[base.driver].label} #${sameDriverCount}`,
        slug: `${base.driver}-${sameDriverCount}`,
        description: base.description,
        enabled: true,
        exposeAsTool: base.exposeAsTool,
        config: {
          ...base.config,
          ...(AGENT_DRIVER_SPECS[base.driver].fields.supportsShadowHome
            ? {
                shadowHomePath: `~/.${base.driver}-chisabot/account-${sameDriverCount}`,
              }
            : {}),
        },
      });
      await invalidateAgentProviderQueries(queryClient, activeEnvId);
      setSelectedInstanceId(created.id);
      toast.success(`已创建新实例「${created.name}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建实例失败");
    }
  };

  return (
    <PageShell
      description="配置 Codex、Claude Code、Antigravity、Codebuddy、Devin 及 ACP 智能体多账号实例。启用后的智能体既可在聊天中用 @ 直接点名作为子代理运行，也可授权给机器人作为工具派发任务。"
      title="智能体提供方"
      width="wide"
    >
      {envsQuery.isPending ? (
        <PageSkeleton rows={4} />
      ) : envsQuery.isError ? (
        <ErrorCard
          action={
            <Button
              className="mt-2"
              onClick={() => void envsQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={envsQuery.error.message}
          title="无法加载智能体运行环境"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* 顶部环境选择栏（对齐 T3 Code「正在应用设置到 ... on <环境>」） */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 px-4 py-3 backdrop-blur-sm">
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{"正在应用设置到"}</span>
              <Select
                onValueChange={(val) => {
                  if (val) setSelectedEnvId(val);
                }}
                value={activeEnvId}
              >
                <SelectTrigger
                  className="w-full min-w-0 sm:w-auto sm:min-w-[190px]"
                  size="sm"
                >
                  <SelectValue placeholder="选择运行环境">
                    {currentEnv ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        {currentEnv.kind === "server" ? (
                          <IconServer className="size-3.5 text-primary" />
                        ) : (
                          <IconDeviceDesktop className="size-3.5 text-muted-foreground" />
                        )}
                        <span
                          className="truncate font-medium"
                          title={currentEnv.name}
                        >
                          {currentEnv.name}
                        </span>
                        <span
                          className={cn(
                            "ml-1 inline-block size-2 shrink-0 rounded-full",
                            currentEnv.online
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                        />
                      </span>
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {environments.map((env) => (
                    <SelectItem key={env.id} value={env.id}>
                      <span className="flex items-center gap-2">
                        {env.kind === "server" ? (
                          <IconServer className="size-3.5" />
                        ) : (
                          <IconDeviceDesktop className="size-3.5" />
                        )}
                        <span>{env.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {env.online ? "在线" : "离线"}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                className="text-xs text-muted-foreground"
                onClick={() => setEnvConfigOpen((prev) => !prev)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <IconFolder className="size-3.5" />
                {"工作区与沙盒边界"}
                {envConfigOpen ? (
                  <IconChevronUp className="size-3.5" />
                ) : (
                  <IconChevronDown className="size-3.5" />
                )}
              </Button>
            </div>

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {latestCheckedAt ? (
                <span>{`已检查 ${agoText(latestCheckedAt)}`}</span>
              ) : null}
              <Button
                disabled={!currentEnv?.online || probingAll}
                onClick={() => void handleProbeAll()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconRefresh
                  className={cn("size-3.5", probingAll && "animate-spin")}
                />
                {probingAll ? "检测中…" : "全部检测"}
              </Button>
            </div>
          </div>

          {readOnlyServer ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              <IconAlertCircle className="size-4 shrink-0" />
              <span>
                {
                  "当前查看的是「服务器本机」环境，仅管理员可修改本机提供方配置与受控工作目录；你可以在自己的已配对电脑上自由添加和管理提供方。"
                }
              </span>
            </div>
          ) : null}

          {/* 可折叠的宿主环境工作目录与权限档位面板 */}
          {envConfigOpen &&
          activeEnvId &&
          currentEnv &&
          envSettingsQuery.data ? (
            <EnvironmentBoundaryPanel
              env={currentEnv}
              envState={envSettingsQuery.data}
              onSaved={() =>
                void invalidateAgentProviderQueries(queryClient, activeEnvId)
              }
              readOnly={readOnlyServer}
            />
          ) : null}

          {/* 标题栏 */}
          <div className="flex items-center justify-between px-1 pt-1">
            <div className="flex items-center gap-1.5">
              <h2 className="text-base font-semibold tracking-tight">
                {"提供方"}
              </h2>
              <Button
                aria-label="添加提供方"
                className="size-6 rounded-md p-0 text-muted-foreground hover:text-foreground"
                disabled={!activeEnvId || readOnlyServer}
                onClick={() => setAddOpen(true)}
                size="xs"
                type="button"
                variant="ghost"
              >
                <IconPlus className="size-4" />
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">
              {`已启用 ${instances.filter((i) => i.enabled).length} / ${instances.length} 个实例`}
            </span>
          </div>

          {/* T3 Code 风格双栏主体卡片 */}
          <div
            className="grid min-h-[560px] grid-cols-1 overflow-hidden rounded-2xl border border-border/80 bg-card/75 shadow-xs backdrop-blur-md md:grid-cols-[270px_minmax(0,1fr)]"
            data-setting-item="agent-providers.agent-provider-instances"
          >
            {/* 左栏：提供方实例列表 */}
            <div className="flex flex-col justify-between border-b border-border/70 bg-muted/25 md:border-r md:border-b-0">
              <div className="flex flex-col divide-y divide-border/50">
                {instancesQuery.isPending ? (
                  <div className="p-4 text-xs text-muted-foreground">
                    {"正在加载提供方列表…"}
                  </div>
                ) : instances.length === 0 ? (
                  <div className="p-5 text-xs text-muted-foreground">
                    {
                      "当前环境还没有智能体实例，点击下方「+ 添加提供方」开始配置。"
                    }
                  </div>
                ) : (
                  instances.map((inst) => {
                    const active = inst.id === selectedInstance?.id;
                    const statusInfo = describeInstanceStatus(inst);
                    return (
                      <div
                        className={cn(
                          "group flex items-center justify-between gap-2.5 px-3.5 py-3 transition-colors",
                          active
                            ? "bg-background shadow-[inset_2px_0_0_var(--color-primary)]"
                            : "hover:bg-background/50",
                        )}
                        key={inst.id}
                      >
                        <button
                          className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                          onClick={() => setSelectedInstanceId(inst.id)}
                          type="button"
                        >
                          <div className="mt-0.5 shrink-0">
                            <DriverIcon driver={inst.driver} slug={inst.slug} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-1.5">
                              <span
                                className={cn(
                                  "truncate text-sm font-medium",
                                  !inst.enabled && "text-muted-foreground",
                                )}
                              >
                                {inst.name}
                              </span>
                              {inst.probe?.version ? (
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                  {inst.probe.version.startsWith("v")
                                    ? inst.probe.version
                                    : `v${inst.probe.version}`}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                              {statusInfo.tone === "warn" ? (
                                <span className="inline-block size-1.5 shrink-0 rounded-full bg-amber-500" />
                              ) : null}
                              <span
                                className={cn(
                                  "truncate",
                                  statusInfo.tone === "warn"
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-muted-foreground",
                                )}
                                title={statusInfo.text}
                              >
                                {statusInfo.text}
                              </span>
                            </div>
                          </div>
                        </button>

                        <Switch
                          aria-label={`启用 ${inst.name}`}
                          checked={inst.enabled}
                          disabled={readOnlyServer}
                          onCheckedChange={(checked) =>
                            void handleToggleEnabled(inst, Boolean(checked))
                          }
                        />
                      </div>
                    );
                  })
                )}
              </div>

              <div className="border-t border-border/60 p-2.5">
                <Button
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                  disabled={!activeEnvId || readOnlyServer}
                  onClick={() => setAddOpen(true)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <IconPlus className="size-4" />
                  {"添加提供方"}
                </Button>
              </div>
            </div>

            {/* 右栏：选中实例的配置详情 */}
            <div className="flex flex-col bg-background/60">
              {selectedInstance ? (
                <InstanceDetailPane
                  instance={selectedInstance}
                  key={selectedInstance.id}
                  onClone={() => void handleCloneInstance(selectedInstance)}
                  onDeleted={() => {
                    void invalidateAgentProviderQueries(
                      queryClient,
                      activeEnvId,
                    );
                  }}
                  onUpdated={() => {
                    void invalidateAgentProviderQueries(
                      queryClient,
                      activeEnvId,
                    );
                  }}
                  readOnly={readOnlyServer}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                  <IconRobot className="size-10 text-muted-foreground/50" />
                  <div className="text-sm font-medium">
                    {"尚未选择智能体提供方"}
                  </div>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    {
                      "在左侧选择一个智能体实例查看或修改路径、影子 Home、启动参数与加密环境变量，或点击「添加提供方」新增实例。"
                    }
                  </p>
                  {!readOnlyServer && activeEnvId ? (
                    <Button
                      onClick={() => setAddOpen(true)}
                      size="sm"
                      type="button"
                    >
                      <IconPlus className="size-4" />
                      {"添加提供方"}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AddProviderDialog
        environmentId={activeEnvId}
        existingCount={instances.length}
        onCreated={(created) => {
          setSelectedInstanceId(created.id);
          void invalidateAgentProviderQueries(queryClient, activeEnvId);
        }}
        onOpenChange={setAddOpen}
        open={addOpen}
      />
    </PageShell>
  );
}

function EnvironmentBoundaryPanel({
  env,
  envState,
  readOnly,
  onSaved,
}: {
  env: AgentEnvironmentSummary;
  envState: {
    settings: {
      profile: AgentProfile;
      isolation: Isolation;
      network: boolean;
      workspaceRoots: string[];
    };
    effectiveRoots: string[];
    envRoots: string[];
  };
  readOnly: boolean;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<AgentProfile>(
    envState.settings.profile,
  );
  const [isolation, setIsolation] = useState<Isolation>(
    envState.settings.isolation,
  );
  const [network, setNetwork] = useState<boolean>(envState.settings.network);
  const [rootsText, setRootsText] = useState<string>(
    (envState.settings.workspaceRoots.length
      ? envState.settings.workspaceRoots
      : envState.effectiveRoots
    ).join("\n"),
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const workspaceRoots = rootsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      await saveEnvironmentSettings(env.id, {
        profile,
        isolation,
        network,
        workspaceRoots,
      });
      toast.success("已保存当前运行环境的工作区与隔离设置");
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存环境设置失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/50 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">
            {`「${env.name}」受控工作区与默认沙盒边界`}
          </div>
          <div className="text-xs text-muted-foreground">
            {env.kind === "server"
              ? "服务器本机运行子代理时仅允许访问下列受控工作目录（也可通过环境变量 CHISABOT_SERVER_AGENT_ROOTS 预设）。"
              : "子代理在该电脑上运行时遵循以下权限档位、隔离方式与允许访问的根目录。"}
          </div>
        </div>
        {!readOnly ? (
          <Button
            disabled={saving}
            onClick={() => void handleSave()}
            size="sm"
            type="button"
          >
            {saving ? "保存中…" : "保存环境边界"}
          </Button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            {"权限档位"}
          </div>
          <Select
            disabled={readOnly}
            onValueChange={(v) => v && setProfile(v as AgentProfile)}
            value={profile}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>
                {PROFILE_INFO[profile]?.label ?? profile}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AGENT_PROFILES.map((p) => (
                <SelectItem key={p} value={p}>
                  {`${PROFILE_INFO[p].label} — ${PROFILE_INFO[p].description}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium text-muted-foreground">
            {"默认隔离方式"}
          </div>
          <Select
            disabled={readOnly}
            onValueChange={(v) => v && setIsolation(v as Isolation)}
            value={isolation}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue>
                {ISOLATION_INFO[isolation]?.label ?? isolation}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ISOLATIONS.map((iso) => (
                <SelectItem key={iso} value={iso}>
                  {`${ISOLATION_INFO[iso].label} — ${ISOLATION_INFO[iso].description}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
          <div>
            <div className="text-xs font-medium">{"允许子代理联网"}</div>
            <div className="text-[11px] text-muted-foreground">
              {"外部 CLI 调用云端模型通常需要联网"}
            </div>
          </div>
          <Switch
            checked={network}
            disabled={readOnly}
            onCheckedChange={(v) => setNetwork(Boolean(v))}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium text-muted-foreground">
          {"允许子代理访问的工作目录（每行一个绝对路径）"}
        </div>
        <Textarea
          className="min-h-[72px] font-mono text-xs"
          disabled={readOnly}
          onChange={(e) => setRootsText(e.target.value)}
          placeholder={
            env.platform === "win32"
              ? "例如：C:\\Projects\\MyApp"
              : "例如：/srv/workspaces/my-app"
          }
          value={rootsText}
        />
      </div>
    </div>
  );
}

function InstanceDetailPane({
  instance,
  readOnly,
  onClone,
  onUpdated,
  onDeleted,
}: {
  instance: AgentInstanceView;
  readOnly: boolean;
  onClone: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const spec = AGENT_DRIVER_SPECS[instance.driver];
  const fields = spec.fields;
  const statusInfo = describeInstanceStatus(instance);

  const [draft, setDraft] = useState<InstanceDraft>(() =>
    buildDraftFromInstance(instance),
  );
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setDraft(buildDraftFromInstance(instance));
  }, [instance]);

  const previewToolName = agentToolName(draft.slug || instance.slug);

  const handleReset = () => {
    setDraft(buildDraftFromInstance(instance));
    toast.info("已还原未保存的修改");
  };

  const handleProbe = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const updated = await probeAgentInstance(instance.id);
      const nextStatus = describeInstanceStatus(updated);
      toast.success(`${updated.name}：${nextStatus.text}`);
      onUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "探活失败");
    } finally {
      setProbing(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirmDialog({
      title: `删除「${instance.name}」？`,
      description:
        "删除后，机器人与聊天框将无法再调用这个提供方实例；正在运行的任务不会立即中断。",
      confirmLabel: "删除实例",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAgentInstance(instance.id);
      toast.success(`已删除「${instance.name}」`);
      onDeleted();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      toast.error("请填写显示名称");
      return;
    }
    setSaving(true);
    try {
      const config: AgentDriverConfig = {
        commandPath: draft.commandPath.trim() || null,
        homePath: draft.homePath.trim() || null,
        shadowHomePath: draft.shadowHomePath.trim() || null,
        extraArgs: parseArgsText(draft.extraArgsText),
        model: draft.model.trim() || null,
        ...(instance.driver === "antigravity"
          ? {
              fixProxy: draft.fixProxy,
              protocolMode: draft.protocolMode,
            }
          : {}),
        ...(instance.driver === "acp"
          ? {
              acpSource: draft.acpSource,
              acpAgentId: draft.acpAgentId.trim() || null,
              acpLauncher: draft.acpLauncher,
              acpPackage: draft.acpPackage.trim() || null,
            }
          : {}),
        ...(instance.driver === "custom"
          ? {
              stdinPrompt: draft.stdinPrompt,
              outputFormat: draft.outputFormat,
            }
          : {}),
        defaultIsolation:
          draft.defaultIsolation === "inherit" ? null : draft.defaultIsolation,
        maxProfile: draft.maxProfile === "inherit" ? null : draft.maxProfile,
        requireStartApproval: draft.requireStartApproval,
      };

      const envVars: AgentEnvVarInput[] = draft.envRows
        .filter((row) => row.name.trim().length > 0)
        .map((row) => {
          const cleanName = row.name.trim();
          if (row.sensitive && row.hasExistingSecret && !row.dirtySecret) {
            return {
              name: cleanName,
              sensitive: true,
              keepExisting: true,
            };
          }
          return {
            name: cleanName,
            value: row.value,
            sensitive: row.sensitive,
          };
        });

      await updateAgentInstance(instance.id, {
        name: draft.name.trim(),
        slug: normalizeInstanceSlug(draft.slug || draft.name),
        description: draft.description.trim(),
        exposeAsTool: draft.exposeAsTool,
        config,
        envVars,
      });
      toast.success("提供方配置已保存");
      onUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col justify-between">
      <div className="flex flex-col divide-y divide-border/60 px-6 py-5">
        {/* 头部标题行 */}
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 pb-4">
          <div className="flex min-w-0 flex-1 basis-48 items-start gap-2.5">
            <DriverIcon
              className="mt-0.5 size-5 shrink-0"
              driver={instance.driver}
              slug={instance.slug}
            />
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold [overflow-wrap:anywhere]">
                {instance.name}
              </h3>
              <span className="mt-1 inline-block rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {spec.badge}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              disabled={!instance.environmentOnline || probing}
              onClick={() => void handleProbe()}
              size="xs"
              title="立即检测该提供方版本与认证状态"
              type="button"
              variant="ghost"
            >
              <IconRefresh
                className={cn("size-3.5", probing && "animate-spin")}
              />
              {probing ? "检测中" : "重新检测"}
            </Button>
            {!readOnly ? (
              <Button
                onClick={handleReset}
                size="xs"
                title="还原未保存的修改"
                type="button"
                variant="ghost"
              >
                <IconRotateClockwise className="size-3.5" />
              </Button>
            ) : null}
            {!readOnly ? (
              <Button
                className="text-destructive hover:text-destructive"
                onClick={() => void handleDelete()}
                size="xs"
                title="删除此提供方实例"
                type="button"
                variant="ghost"
              >
                <IconTrash className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>

        {/* 状态行 */}
        <div className="flex flex-col gap-1 py-4">
          <div className="text-xs font-medium text-foreground">{"状态"}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                statusInfo.tone === "warn"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground",
              )}
            >
              {statusInfo.text}
            </span>
            {instance.probe?.resolvedPath ? (
              <span className="w-full min-w-0 rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                {instance.probe.resolvedPath}
              </span>
            ) : null}
          </div>
        </div>

        {/* 显示名称 + 快速新增同驱动账号实例（还原截图 `+` 按钮） */}
        <div className="grid grid-cols-1 items-center gap-3 py-4 sm:grid-cols-[1fr_260px]">
          <div>
            <div className="text-sm font-medium">{"显示名称"}</div>
            <div className="text-xs text-muted-foreground">
              {
                "在聊天 @ 菜单、子代理卡片和机器人工具说明中展示的名称。点右侧 + 可新增同提供方的第二个账号实例。"
              }
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!readOnly ? (
              <Button
                aria-label="新增同类型提供方实例"
                className="size-8 shrink-0 p-0"
                onClick={onClone}
                size="sm"
                title="新增一个同提供方的独立账号实例"
                type="button"
                variant="ghost"
              >
                <IconPlus className="size-4" />
              </Button>
            ) : null}
            <Input
              disabled={readOnly}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, name: e.target.value }))
              }
              placeholder={spec.label}
              value={draft.name}
            />
          </div>
        </div>

        {/* 子代理标识与擅长说明 */}
        <div className="flex flex-col gap-3 py-4">
          <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
            <div>
              <div className="text-sm font-medium">{"实例标识与工具挂载"}</div>
              <div className="text-xs text-muted-foreground">
                {"机器人将其作为工具调用时的名称："}
                <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  {previewToolName}
                </code>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, slug: e.target.value }))
                }
                placeholder="codex-personal"
                value={draft.slug}
              />
              <Switch
                aria-label="暴露为独立机器人工具"
                checked={draft.exposeAsTool}
                disabled={readOnly}
                onCheckedChange={(v) =>
                  setDraft((prev) => ({ ...prev, exposeAsTool: Boolean(v) }))
                }
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">
              {"职责与擅长场景（供主机器人选型参考）"}
            </div>
            <Input
              disabled={readOnly}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, description: e.target.value }))
              }
              placeholder={spec.description}
              value={draft.description}
            />
          </div>
        </div>

        {/* 运行时区块（严格对齐 T3 Code：可执行文件路径、HOME 路径、影子 home 路径、启动参数等） */}
        <div className="flex flex-col gap-4 py-5">
          <h4 className="text-sm font-semibold">{"运行时"}</h4>

          {fields.supportsCommandPath ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">{"可执行文件路径"}</div>
                <div className="text-xs text-muted-foreground">
                  {`该实例使用的 ${spec.label} 可执行文件路径或命令名。`}
                </div>
              </div>
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, commandPath: e.target.value }))
                }
                placeholder={fields.defaultCommand ?? ""}
                value={draft.commandPath}
              />
            </div>
          ) : null}

          {fields.supportsHomePath ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">
                  {`${fields.homeEnvName ?? "HOME"} 路径`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {`自定义 ${spec.label} 主配置与状态目录。`}
                </div>
              </div>
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, homePath: e.target.value }))
                }
                placeholder={fields.defaultHomePath ?? ""}
                value={draft.homePath}
              />
            </div>
          ) : null}

          {fields.supportsShadowHome ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">{"影子 home 路径"}</div>
                <div className="text-xs text-muted-foreground">
                  {`按账号隔离的 ${spec.label} home，独立保存认证凭据（如 auth.json），同时通过链接共享主目录的会话与技能状态。`}
                </div>
              </div>
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    shadowHomePath: e.target.value,
                  }))
                }
                placeholder={fields.defaultShadowHint ?? ""}
                value={draft.shadowHomePath}
              />
            </div>
          ) : null}

          {instance.driver === "acp" ? (
            <>
              <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
                <div>
                  <div className="text-sm font-medium">{"ACP 启动器"}</div>
                  <div className="text-xs text-muted-foreground">
                    {"通过 npx、uvx 或本地二进制文件启动 ACP 协议服务。"}
                  </div>
                </div>
                <Select
                  disabled={readOnly}
                  onValueChange={(v) =>
                    v &&
                    setDraft((prev) => ({
                      ...prev,
                      acpLauncher: v as InstanceDraft["acpLauncher"],
                    }))
                  }
                  value={draft.acpLauncher}
                >
                  <SelectTrigger className="w-full" size="sm">
                    <SelectValue>{draft.acpLauncher}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="npx">
                      {"npx（Node 包自动拉取）"}
                    </SelectItem>
                    <SelectItem value="uvx">
                      {"uvx（Python 包自动拉取）"}
                    </SelectItem>
                    <SelectItem value="binary">
                      {"binary（本地已安装命令）"}
                    </SelectItem>
                    <SelectItem value="custom">
                      {"custom（自定义命令）"}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {draft.acpLauncher === "npx" || draft.acpLauncher === "uvx" ? (
                <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
                  <div>
                    <div className="text-sm font-medium">{"ACP 包名"}</div>
                    <div className="text-xs text-muted-foreground">
                      {
                        "例如 @tencent-ai/codebuddy-code 或 @zed-industries/claude-code-acp。"
                      }
                    </div>
                  </div>
                  <Input
                    className="font-mono text-xs"
                    disabled={readOnly}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        acpPackage: e.target.value,
                      }))
                    }
                    placeholder="@tencent-ai/codebuddy-code"
                    value={draft.acpPackage}
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {instance.driver === "antigravity" ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">
                  {"自动修正 Windows 代理前缀"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {
                    "自动为缺少协议头的 HTTP_PROXY 补齐 http:// 并清理冲突变量。"
                  }
                </div>
              </div>
              <div className="flex justify-end">
                <Switch
                  checked={draft.fixProxy}
                  disabled={readOnly}
                  onCheckedChange={(v) =>
                    setDraft((prev) => ({ ...prev, fixProxy: Boolean(v) }))
                  }
                />
              </div>
            </div>
          ) : null}

          {fields.supportsCustomIO ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">
                  {"通过标准输入（stdin）传入任务"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {
                    "关闭时可在启动参数中使用 {{prompt}}、{{workdir}}、{{model}} 占位符。"
                  }
                </div>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Select
                  disabled={readOnly}
                  onValueChange={(v) =>
                    v &&
                    setDraft((prev) => ({
                      ...prev,
                      outputFormat: v as "text" | "jsonl",
                    }))
                  }
                  value={draft.outputFormat}
                >
                  <SelectTrigger size="sm">
                    <SelectValue>
                      {draft.outputFormat === "jsonl" ? "JSONL 流" : "纯文本"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">{"纯文本输出"}</SelectItem>
                    <SelectItem value="jsonl">{"JSONL 事件流"}</SelectItem>
                  </SelectContent>
                </Select>
                <Switch
                  checked={draft.stdinPrompt}
                  disabled={readOnly}
                  onCheckedChange={(v) =>
                    setDraft((prev) => ({ ...prev, stdinPrompt: Boolean(v) }))
                  }
                />
              </div>
            </div>
          ) : null}

          {fields.supportsExtraArgs ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">{"启动参数"}</div>
                <div className="text-xs text-muted-foreground">
                  {`会话启动时传给 ${spec.label} 的额外命令行参数。`}
                </div>
              </div>
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    extraArgsText: e.target.value,
                  }))
                }
                placeholder="例如：--full-auto"
                value={draft.extraArgsText}
              />
            </div>
          ) : null}

          {fields.supportsModel ? (
            <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
              <div>
                <div className="text-sm font-medium">{"默认模型覆盖"}</div>
                <div className="text-xs text-muted-foreground">
                  {"留空则使用该智能体自身的默认模型配置。"}
                </div>
              </div>
              <Input
                className="font-mono text-xs"
                disabled={readOnly}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, model: e.target.value }))
                }
                placeholder="留空跟随默认"
                value={draft.model}
              />
            </div>
          ) : null}

          <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
            <div>
              <div className="text-sm font-medium">{"工作区隔离覆盖"}</div>
              <div className="text-xs text-muted-foreground">
                {
                  "可单独指定该实例在 Git worktree 或临时副本中运行，改动完成后在聊天卡片一键应用。"
                }
              </div>
            </div>
            <Select
              disabled={readOnly}
              onValueChange={(v) =>
                v &&
                setDraft((prev) => ({
                  ...prev,
                  defaultIsolation: v as InstanceDraft["defaultIsolation"],
                }))
              }
              value={draft.defaultIsolation}
            >
              <SelectTrigger className="w-full" size="sm">
                <SelectValue>
                  {draft.defaultIsolation === "inherit"
                    ? "跟随环境默认"
                    : ISOLATION_INFO[draft.defaultIsolation]?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{"跟随环境默认"}</SelectItem>
                {ISOLATIONS.map((iso) => (
                  <SelectItem key={iso} value={iso}>
                    {ISOLATION_INFO[iso].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_260px]">
            <div>
              <div className="text-sm font-medium">{"启动前人工确认"}</div>
              <div className="text-xs text-muted-foreground">
                {
                  "开启后每次派发任务前先弹出确认卡片；关闭时在受控工作区与隔离沙盒内直接启动（越界操作仍会拦截询问）。"
                }
              </div>
            </div>
            <div className="flex justify-end">
              <Switch
                checked={draft.requireStartApproval}
                disabled={readOnly}
                onCheckedChange={(v) =>
                  setDraft((prev) => ({
                    ...prev,
                    requireStartApproval: Boolean(v),
                  }))
                }
              />
            </div>
          </div>
        </div>

        {/* 环境变量区块（对齐 T3 Code 底部「环境」，支持 AES-GCM 敏感加密存储） */}
        <div
          className="flex flex-col gap-3 py-5"
          data-setting-item="agent-providers.agent-provider-env"
        >
          <div className="flex items-center justify-between">
            <div>
              <h4 className="text-sm font-semibold">{"环境"}</h4>
              <p className="text-xs text-muted-foreground">
                {
                  "注入到该提供方进程的专属环境变量（如 API 密钥、自定义网关地址）。勾选锁图标后使用服务端 AES-GCM 加密保存。"
                }
              </p>
            </div>
            {!readOnly ? (
              <Button
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    envRows: [
                      ...prev.envRows,
                      {
                        id: `new-${Date.now()}-${prev.envRows.length}`,
                        name: "",
                        value: "",
                        sensitive: true,
                        hasExistingSecret: false,
                        dirtySecret: true,
                      },
                    ],
                  }))
                }
                size="xs"
                type="button"
                variant="outline"
              >
                <IconPlus className="size-3.5" />
                {"添加变量"}
              </Button>
            ) : null}
          </div>

          {draft.envRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
              {"暂未配置额外环境变量，将直接使用宿主默认环境。"}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {draft.envRows.map((row, idx) => {
                const revealed = Boolean(revealedIds[row.id]);
                return (
                  <div
                    className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[170px_minmax(0,1fr)_auto]"
                    key={row.id}
                  >
                    <Input
                      className="font-mono text-xs"
                      disabled={readOnly}
                      onChange={(e) => {
                        const nextName = e.target.value;
                        setDraft((prev) => ({
                          ...prev,
                          envRows: prev.envRows.map((item, i) =>
                            i === idx ? { ...item, name: nextName } : item,
                          ),
                        }));
                      }}
                      placeholder="OPENAI_API_KEY"
                      value={row.name}
                    />
                    <Input
                      className="font-mono text-xs"
                      disabled={readOnly}
                      onChange={(e) => {
                        const nextVal = e.target.value;
                        setDraft((prev) => ({
                          ...prev,
                          envRows: prev.envRows.map((item, i) =>
                            i === idx
                              ? { ...item, value: nextVal, dirtySecret: true }
                              : item,
                          ),
                        }));
                      }}
                      placeholder={
                        row.sensitive &&
                        row.hasExistingSecret &&
                        !row.dirtySecret
                          ? "••••••••（已加密保存，留空保持不变）"
                          : "变量值"
                      }
                      type={row.sensitive && !revealed ? "password" : "text"}
                      value={row.value}
                    />
                    <div className="flex items-center gap-1">
                      {row.sensitive ? (
                        <Button
                          aria-label={revealed ? "隐藏值" : "显示输入值"}
                          className="size-7 p-0"
                          onClick={() =>
                            setRevealedIds((prev) => ({
                              ...prev,
                              [row.id]: !revealed,
                            }))
                          }
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          {revealed ? (
                            <IconEyeOff className="size-3.5" />
                          ) : (
                            <IconEye className="size-3.5" />
                          )}
                        </Button>
                      ) : null}
                      <Button
                        aria-label="切换敏感加密存储"
                        className={cn(
                          "size-7 p-0",
                          row.sensitive
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                        disabled={readOnly}
                        onClick={() =>
                          setDraft((prev) => ({
                            ...prev,
                            envRows: prev.envRows.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    sensitive: !item.sensitive,
                                    dirtySecret: true,
                                  }
                                : item,
                            ),
                          }))
                        }
                        size="xs"
                        title={
                          row.sensitive
                            ? "当前：加密存储（不回传明文）"
                            : "当前：普通明文变量"
                        }
                        type="button"
                        variant="ghost"
                      >
                        <IconLock className="size-3.5" />
                      </Button>
                      {!readOnly ? (
                        <Button
                          aria-label="移除变量"
                          className="size-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              envRows: prev.envRows.filter((_, i) => i !== idx),
                            }))
                          }
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          <IconTrash className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 底部保存栏 */}
      {!readOnly ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/20 px-6 py-3">
          <Button
            disabled={saving}
            onClick={handleReset}
            size="sm"
            type="button"
            variant="ghost"
          >
            {"还原"}
          </Button>
          <Button
            disabled={saving}
            onClick={() => void handleSave()}
            size="sm"
            type="button"
          >
            <IconCheck className="size-4" />
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AddProviderDialog({
  open,
  onOpenChange,
  environmentId,
  existingCount,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  existingCount: number;
  onCreated: (instance: AgentInstanceView) => void;
}) {
  const [tab, setTab] = useState<"presets" | "acp">("presets");
  const [search, setSearch] = useState("");
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  const acpQuery = useQuery({
    ...acpRegistryQueryOptions(search),
    enabled: open && tab === "acp",
  });

  const handleAddPreset = async (preset: AgentProviderPreset) => {
    if (!environmentId || creatingKey) return;
    setCreatingKey(preset.key);
    try {
      const created = await createAgentInstance({
        environmentId,
        driver: preset.driver,
        name: preset.name,
        slug:
          existingCount > 0
            ? `${preset.slug}-${existingCount + 1}`
            : preset.slug,
        description: preset.description,
        enabled: true,
        exposeAsTool: true,
        config: preset.config,
      });
      toast.success(`已添加「${created.name}」`);
      onCreated(created);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加提供方失败");
    } finally {
      setCreatingKey(null);
    }
  };

  const handleAddAcpEntry = async (entry: AcpRegistryEntry) => {
    if (!environmentId || creatingKey) return;
    setCreatingKey(entry.id);
    try {
      const created = await createAgentInstance({
        environmentId,
        driver: "acp",
        name: entry.name,
        slug: entry.id,
        description: entry.description,
        enabled: true,
        exposeAsTool: true,
        config: {
          acpSource: "registry",
          acpAgentId: entry.id,
          acpLauncher: entry.launcher,
          acpPackage: entry.packageSpec,
          commandPath: entry.launcher === "binary" ? entry.id : null,
          extraArgs: entry.args,
        },
        envVars: (entry.envHints ?? []).map((envName) => ({
          name: envName,
          value: "",
          sensitive: true,
        })),
      });
      toast.success(`已从 ACP Registry 添加「${created.name}」`);
      onCreated(created);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "添加 ACP 智能体失败",
      );
    } finally {
      setCreatingKey(null);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[82svh] overflow-hidden sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{"添加智能体提供方"}</DialogTitle>
          <DialogDescription>
            {
              "选择常用编程智能体驱动（支持同一提供方添加多个独立账号实例），或从官方 ACP Registry 目录搜索接入。"
            }
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b border-border pb-2">
          <Button
            onClick={() => setTab("presets")}
            size="sm"
            type="button"
            variant={tab === "presets" ? "secondary" : "ghost"}
          >
            {"内置提供方预设"}
          </Button>
          <Button
            onClick={() => setTab("acp")}
            size="sm"
            type="button"
            variant={tab === "acp" ? "secondary" : "ghost"}
          >
            {"ACP Registry 目录"}
          </Button>
        </div>

        {tab === "presets" ? (
          <div className="grid max-h-[52svh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {AGENT_PROVIDER_PRESETS.map((preset) => (
              <button
                className="flex flex-col items-start gap-1.5 rounded-xl border border-border/70 bg-card/60 p-3.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:opacity-50"
                disabled={Boolean(creatingKey)}
                key={preset.key}
                onClick={() => void handleAddPreset(preset)}
                type="button"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <DriverIcon driver={preset.driver} slug={preset.slug} />
                    <span className="text-sm font-medium">{preset.name}</span>
                  </div>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {preset.vendor}
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {preset.description}
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex max-h-[52svh] flex-col gap-3 overflow-hidden">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 ACP 智能体（如 codebuddy、devin、goose、qwen…）"
                value={search}
              />
            </div>
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {acpQuery.isPending ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {"正在检索 ACP Registry…"}
                </div>
              ) : (acpQuery.data?.entries ?? []).length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  {"没有找到匹配的 ACP 智能体。"}
                </div>
              ) : (
                (acpQuery.data?.entries ?? []).map((entry) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 p-3"
                    key={entry.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {entry.name}
                        </span>
                        {entry.version ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {`v${entry.version}`}
                          </span>
                        ) : null}
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {entry.launcher}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {entry.description}
                      </p>
                    </div>
                    <Button
                      disabled={Boolean(creatingKey)}
                      onClick={() => void handleAddAcpEntry(entry)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {creatingKey === entry.id ? "添加中…" : "添加"}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
