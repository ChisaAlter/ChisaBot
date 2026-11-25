import {
  IconAlertCircle,
  IconBrandGoogle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconDownload,
  IconExternalLink,
  IconFolder,
  IconLoader2,
  IconLogout,
  IconRefresh,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import {
  type AgentInstanceView,
  type AntigravityInstallJobView,
  type AntigravityInstallStage,
  type AntigravityLoginSessionView,
  type AntigravityLoginStage,
  cancelAntigravityInstallMutationOptions,
  cancelAntigravityLoginMutationOptions,
  logoutAntigravityMutationOptions,
  startAntigravityInstallMutationOptions,
  startAntigravityLoginMutationOptions,
  submitAntigravityLoginMutationOptions,
  useAntigravityLogin,
  useAntigravityRuntime,
} from "@/lib/local-agents";
import { cn } from "@/lib/utils";

const INSTALL_STAGE_LABELS: Record<AntigravityInstallStage, string> = {
  checking: "检查版本",
  downloading: "下载中",
  verifying: "校验 SHA-512",
  extracting: "解压中",
  activating: "激活中",
};

const LOGIN_STAGE_LABELS: Record<AntigravityLoginStage, string> = {
  starting: "正在启动登录流程",
  awaiting_auth: "等待浏览器完成 Google 授权",
  submitting: "正在提交授权码",
  verifying: "正在验证账号凭据",
};

function formatVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isSafeExternalUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  return url.startsWith("https://") || url.startsWith("http://");
}

function resolveRuntimeBadge(
  instance: AgentInstanceView,
  runtime: {
    installed: boolean;
    source: "managed" | "system" | "missing";
    managedInstalled: boolean;
    managedVersion: string | null;
    activeVersion: string | null;
    systemBinaryPath: string | null;
  } | null,
): { label: string; tone: "ok" | "neutral" | "warn" } {
  const customConfigured = Boolean(instance.config?.commandPath?.trim());
  if (customConfigured && instance.probe?.runtimeSource === "custom") {
    const ver = formatVersion(instance.probe.version);
    return {
      label: ver ? `自定义路径 ${ver}` : "自定义路径",
      tone: "ok",
    };
  }
  if (
    runtime?.managedInstalled ||
    runtime?.source === "managed" ||
    instance.probe?.runtimeSource === "managed"
  ) {
    const ver = formatVersion(
      runtime?.managedVersion ??
        runtime?.activeVersion ??
        instance.probe?.version,
    );
    return {
      label: ver ? `ChisaBot 托管 ${ver}` : "ChisaBot 托管",
      tone: "ok",
    };
  }
  if (
    runtime?.source === "system" ||
    instance.probe?.runtimeSource === "system" ||
    runtime?.systemBinaryPath
  ) {
    const ver = formatVersion(
      runtime?.activeVersion ?? instance.probe?.version,
    );
    return {
      label: ver ? `系统安装 ${ver}` : "系统安装",
      tone: "neutral",
    };
  }
  if (customConfigured && instance.probe?.resolvedPath) {
    const ver = formatVersion(instance.probe.version);
    return {
      label: ver ? `自定义路径 ${ver}` : "自定义路径",
      tone: "neutral",
    };
  }
  return { label: "未安装", tone: "warn" };
}

export function AntigravityManagedCard({
  instance,
  readOnly,
  onUpdated,
}: {
  instance: AgentInstanceView;
  readOnly: boolean;
  onUpdated: () => void;
}) {
  const queryClient = useQueryClient();
  const [authCode, setAuthCode] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);

  const handleInstallSettled = (job: AntigravityInstallJobView) => {
    if (job.status === "succeeded") {
      const ver = formatVersion(job.version);
      toast.success(
        ver
          ? `Antigravity ${ver} 托管运行时已安装就绪`
          : "Antigravity 托管运行时已安装就绪",
      );
      onUpdated();
    } else if (job.status === "failed") {
      toast.error(job.error || "Antigravity 托管运行时安装失败");
    }
  };

  const handleLoginSettled = (session: AntigravityLoginSessionView) => {
    if (session.status === "succeeded") {
      const label = session.email || session.authLabel;
      toast.success(
        label
          ? `Antigravity 已登录：${label}`
          : "Antigravity 独立账号已登录成功",
      );
      setAuthCode("");
      onUpdated();
    } else if (session.status === "failed") {
      toast.error(session.error || "Antigravity 登录未完成");
    }
  };

  const runtimeQuery = useAntigravityRuntime(instance.environmentId, {
    onInstallSettled: handleInstallSettled,
  });
  const loginQuery = useAntigravityLogin(instance.id, {
    environmentId: instance.environmentId,
    onLoginSettled: handleLoginSettled,
  });

  const runtimeState = runtimeQuery.data;
  const runtime = runtimeState?.runtime ?? null;
  const installJob = runtimeState?.installJob ?? null;
  const loginSession = loginQuery.data ?? null;

  const [prevSessionId, setPrevSessionId] = useState<string | null>(
    loginSession?.sessionId ?? null,
  );
  if ((loginSession?.sessionId ?? null) !== prevSessionId) {
    setPrevSessionId(loginSession?.sessionId ?? null);
    setAuthCode("");
    setCopiedUrl(false);
  }

  const startInstallMutation = useMutation(
    startAntigravityInstallMutationOptions(queryClient),
  );
  const cancelInstallMutation = useMutation(
    cancelAntigravityInstallMutationOptions(queryClient),
  );
  const startLoginMutation = useMutation(
    startAntigravityLoginMutationOptions(queryClient),
  );
  const submitLoginMutation = useMutation(
    submitAntigravityLoginMutationOptions(queryClient),
  );
  const cancelLoginMutation = useMutation(
    cancelAntigravityLoginMutationOptions(queryClient),
  );
  const logoutMutation = useMutation(
    logoutAntigravityMutationOptions(queryClient),
  );

  const effectiveOnline = runtimeState
    ? runtimeState.online
    : instance.environmentOnline;
  const writeDisabled = readOnly || !effectiveOnline;
  const runtimeUnsupported = runtime !== null && !runtime.supported;

  const customConfigured = Boolean(instance.config?.commandPath?.trim());
  const probeFound =
    instance.probe?.status === "available" ||
    instance.probe?.status === "unauthenticated";
  const isRuntimeInstalled = runtime
    ? runtime.installed ||
      runtime.managedInstalled ||
      Boolean(runtime.activeBinaryPath) ||
      (customConfigured && probeFound)
    : probeFound;

  const isInstalling = installJob?.status === "running";
  const installStageLabel = installJob?.stage
    ? INSTALL_STAGE_LABELS[installJob.stage]
    : "准备中";
  const clampedPercent =
    typeof installJob?.percent === "number" &&
    Number.isFinite(installJob.percent)
      ? Math.max(0, Math.min(100, Math.round(installJob.percent)))
      : null;

  const runtimeBadge = resolveRuntimeBadge(instance, runtime);
  const activeBinaryPath =
    runtime?.activeBinaryPath ??
    runtime?.managedBinaryPath ??
    instance.probe?.resolvedPath ??
    null;

  const isLoginRunning = loginSession?.status === "running";
  const isAwaitingAuth = loginSession?.status === "awaiting_auth";
  const isLoginActive = isLoginRunning || isAwaitingAuth;
  const isAuthenticated =
    instance.probe?.authenticated === true ||
    (loginSession?.status === "succeeded" && loginSession.authenticated);
  const authDisplayLabel =
    loginSession?.email ||
    loginSession?.authLabel ||
    (instance.probe?.authLabel && instance.probe.authLabel !== "已认证"
      ? instance.probe.authLabel
      : null);
  const effectiveHomePath =
    loginSession?.homePath ??
    instance.probe?.homePath ??
    instance.config?.homePath?.trim() ??
    null;

  const handleInstall = async (force: boolean) => {
    if (writeDisabled || runtimeUnsupported || startInstallMutation.isPending) {
      return;
    }
    try {
      const job = await startInstallMutation.mutateAsync({
        environmentId: instance.environmentId,
        ...(force ? { force: true } : {}),
      });
      if (job.status === "succeeded") {
        handleInstallSettled(job);
      } else if (job.status === "failed") {
        toast.error(job.error || "安装未能启动");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动安装失败");
    }
  };

  const handleCancelInstall = async () => {
    if (writeDisabled || cancelInstallMutation.isPending) return;
    try {
      await cancelInstallMutation.mutateAsync(instance.environmentId);
      toast.info("已请求取消 Antigravity 安装");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消安装失败");
    }
  };

  const handleStartLogin = async (restart: boolean) => {
    if (
      writeDisabled ||
      !isRuntimeInstalled ||
      isInstalling ||
      startLoginMutation.isPending
    ) {
      return;
    }
    try {
      setAuthCode("");
      const session = await startLoginMutation.mutateAsync({
        instanceId: instance.id,
        environmentId: instance.environmentId,
        ...(restart ? { restart: true } : {}),
      });
      if (session.status === "succeeded") {
        handleLoginSettled(session);
      } else if (session.status === "failed") {
        toast.error(session.error || "启动登录失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "启动登录失败");
    }
  };

  const handleSubmitCode = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = authCode.trim();
    if (
      !trimmed ||
      writeDisabled ||
      submitLoginMutation.isPending ||
      !loginSession
    ) {
      return;
    }
    try {
      const session = await submitLoginMutation.mutateAsync({
        instanceId: instance.id,
        environmentId: instance.environmentId,
        code: trimmed,
        sessionId: loginSession.sessionId,
      });
      setAuthCode("");
      if (session.status === "succeeded") {
        handleLoginSettled(session);
      } else if (session.status === "failed") {
        toast.error(session.error || "授权码校验失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提交授权码失败");
    }
  };

  const handleCancelLogin = async () => {
    if (writeDisabled || cancelLoginMutation.isPending) return;
    try {
      await cancelLoginMutation.mutateAsync(instance.id);
      setAuthCode("");
      toast.info("已取消 Antigravity 登录");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消登录失败");
    }
  };

  const handleLogout = async () => {
    if (writeDisabled || logoutMutation.isPending) return;
    try {
      const result = await logoutMutation.mutateAsync({
        instanceId: instance.id,
        environmentId: instance.environmentId,
      });
      if (!result.ok) {
        toast.error(result.error || "退出登录失败，请稍后重试");
        return;
      }
      setAuthCode("");
      toast.success("已退出当前实例的 Antigravity 账号");
      onUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退出登录失败");
    }
  };

  const handleCopyAuthUrl = async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopiedUrl(true);
        toast.success("已复制 Google 授权链接");
      } else {
        toast.info("当前环境不支持一键复制，请直接点击打开授权页");
      }
    } catch {
      toast.error("复制链接失败，请手动复制或点击打开授权页");
    }
  };

  return (
    <div
      className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/70 bg-card/60"
      data-testid="antigravity-managed-card"
    >
      {writeDisabled ? (
        <div className="flex items-center gap-2 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
          <IconAlertCircle className="size-3.5 shrink-0" />
          <span>
            {readOnly
              ? "当前为只读视图（仅管理员可修改服务器本机运行时与账号）。"
              : "所在运行环境当前离线，上线后才可安装运行时或执行账号登录。"}
          </span>
        </div>
      ) : null}

      {/* 分区 1：ChisaBot 托管运行时 */}
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {"ChisaBot 托管运行时"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  runtimeBadge.tone === "ok"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : runtimeBadge.tone === "warn"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {runtimeBadge.label}
              </span>
              {runtime?.updateAvailable ? (
                <span className="inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                  {runtime.latestVersion
                    ? `新版本 ${formatVersion(runtime.latestVersion)}`
                    : "发现新版本"}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {
                "由 ChisaBot 自动拉取并校验官方 Antigravity CLI，与系统全局环境解耦。"
              }
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isInstalling ? (
              <Button
                disabled={writeDisabled || cancelInstallMutation.isPending}
                onClick={() => void handleCancelInstall()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconX className="size-3.5" />
                {cancelInstallMutation.isPending ? "取消中…" : "取消安装"}
              </Button>
            ) : !isRuntimeInstalled ? (
              <Button
                disabled={
                  writeDisabled ||
                  runtimeUnsupported ||
                  startInstallMutation.isPending
                }
                onClick={() => void handleInstall(false)}
                size="sm"
                type="button"
              >
                {startInstallMutation.isPending ? (
                  <IconLoader2 className="size-3.5 animate-spin" />
                ) : (
                  <IconDownload className="size-3.5" />
                )}
                {"一键安装 Antigravity"}
              </Button>
            ) : (
              <Button
                disabled={
                  writeDisabled ||
                  runtimeUnsupported ||
                  startInstallMutation.isPending
                }
                onClick={() => void handleInstall(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                {startInstallMutation.isPending ? (
                  <IconLoader2 className="size-3.5 animate-spin" />
                ) : (
                  <IconRefresh className="size-3.5" />
                )}
                {"检查更新 / 重新安装"}
              </Button>
            )}
          </div>
        </div>

        {/* 路径与托管目录紧凑信息 */}
        {activeBinaryPath || runtime?.toolsDir ? (
          <div className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {activeBinaryPath ? (
              <div className="flex items-start gap-1.5">
                <span className="shrink-0">{"当前路径："}</span>
                <code className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  {activeBinaryPath}
                </code>
              </div>
            ) : null}
            {runtime?.toolsDir ? (
              <div className="flex items-start gap-1.5">
                <IconFolder className="mt-0.5 size-3 shrink-0 opacity-75" />
                <span className="shrink-0">{"托管目录："}</span>
                <code className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  {runtime.toolsDir}
                </code>
              </div>
            ) : null}
          </div>
        ) : null}

        {runtimeUnsupported ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {runtime.unsupportedReason ||
              "当前宿主平台暂不支持自动托管安装，请在下方手动指定可执行文件路径。"}
          </div>
        ) : null}

        {/* 安装进度条 */}
        {isInstalling && installJob ? (
          <div
            className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/70 p-3"
            data-testid="antigravity-install-progress"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 font-medium">
                <IconLoader2 className="size-3.5 animate-spin text-primary" />
                <span>{installStageLabel}</span>
                {installJob.version ? (
                  <span className="font-mono text-muted-foreground">
                    {formatVersion(installJob.version)}
                  </span>
                ) : null}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {[
                  clampedPercent !== null ? `${clampedPercent}%` : null,
                  installJob.totalBytes && installJob.totalBytes > 0
                    ? `${formatBytes(installJob.downloadedBytes)} / ${formatBytes(installJob.totalBytes)}`
                    : installJob.downloadedBytes > 0
                      ? formatBytes(installJob.downloadedBytes)
                      : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <div
              aria-label="Antigravity 安装进度"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={clampedPercent ?? undefined}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-[width] duration-200",
                  clampedPercent === null && "animate-pulse",
                )}
                style={{
                  width: clampedPercent !== null ? `${clampedPercent}%` : "35%",
                }}
              />
            </div>
            {installJob.message ? (
              <div className="text-[11px] text-muted-foreground">
                {installJob.message}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 安装失败提示与重试 */}
        {installJob?.status === "failed" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <IconAlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {installJob.error ||
                  "安装失败，请检查网络连接或代理配置后重试。"}
              </span>
            </div>
            <Button
              disabled={
                writeDisabled ||
                runtimeUnsupported ||
                startInstallMutation.isPending
              }
              onClick={() => void handleInstall(true)}
              size="xs"
              type="button"
              variant="outline"
            >
              {"重试安装"}
            </Button>
          </div>
        ) : null}

        {installJob?.status === "cancelled" ? (
          <div className="text-xs text-muted-foreground">
            {"上次安装已取消，随时可重新开始安装。"}
          </div>
        ) : null}
      </div>

      {/* 分区 2：ChisaBot 独立账号登录 */}
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {"ChisaBot 独立账号登录"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                  isAuthenticated
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {isAuthenticated ? (
                  <>
                    <IconCircleCheck className="size-3" />
                    {authDisplayLabel
                      ? `已登录 · ${authDisplayLabel}`
                      : "已登录"}
                  </>
                ) : (
                  "未登录"
                )}
              </span>
            </div>
            <div className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <IconShieldCheck className="mt-0.5 size-3.5 shrink-0 opacity-75" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {effectiveHomePath
                  ? `独立账号目录：${effectiveHomePath}`
                  : "自动分配独立隔离账号目录（不读写宿主全局 ~/.gemini 或系统凭证库）"}
              </span>
            </div>
          </div>

          {!isLoginActive ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {isAuthenticated ? (
                <>
                  <Button
                    disabled={
                      writeDisabled ||
                      !isRuntimeInstalled ||
                      isInstalling ||
                      startLoginMutation.isPending ||
                      logoutMutation.isPending
                    }
                    onClick={() => void handleStartLogin(true)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <IconBrandGoogle className="size-3.5" />
                    {"切换账号 / 重新登录"}
                  </Button>
                  <Button
                    disabled={
                      writeDisabled ||
                      logoutMutation.isPending ||
                      startLoginMutation.isPending
                    }
                    onClick={() => void handleLogout()}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconLogout className="size-3.5" />
                    {logoutMutation.isPending ? "退出中…" : "退出登录"}
                  </Button>
                </>
              ) : (
                <Button
                  disabled={
                    writeDisabled ||
                    !isRuntimeInstalled ||
                    isInstalling ||
                    startLoginMutation.isPending
                  }
                  onClick={() => void handleStartLogin(false)}
                  size="sm"
                  type="button"
                >
                  {startLoginMutation.isPending ? (
                    <IconLoader2 className="size-3.5 animate-spin" />
                  ) : (
                    <IconBrandGoogle className="size-3.5" />
                  )}
                  {"登录 Google 账号"}
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {!isRuntimeInstalled && !isLoginActive ? (
          <div className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
            {"请先完成上方「一键安装 Antigravity」运行时后再登录 Google 账号。"}
          </div>
        ) : null}

        {/* 登录进行中（启动 / 提交 / 验证） */}
        {isLoginRunning && loginSession ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/70 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <IconLoader2 className="size-3.5 animate-spin text-primary" />
              <span>
                {loginSession.stage
                  ? LOGIN_STAGE_LABELS[loginSession.stage]
                  : "正在处理 Google 登录…"}
              </span>
              {loginSession.message ? (
                <span className="text-[11px] opacity-80">
                  {`· ${loginSession.message}`}
                </span>
              ) : null}
            </div>
            <Button
              disabled={writeDisabled || cancelLoginMutation.isPending}
              onClick={() => void handleCancelLogin()}
              size="xs"
              type="button"
              variant="outline"
            >
              {"取消"}
            </Button>
          </div>
        ) : null}

        {/* 等待浏览器 OOB 授权与提交授权码 */}
        {isAwaitingAuth && loginSession ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-background/80 p-3.5"
            data-testid="antigravity-login-awaiting"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                {"步骤 1：在浏览器完成 Google 授权"}
              </span>
              {isSafeExternalUrl(loginSession.authUrl) ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <a
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    href={loginSession.authUrl}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    <IconExternalLink className="size-3.5" />
                    {"打开 Google 授权页"}
                  </a>
                  <Button
                    onClick={() =>
                      void handleCopyAuthUrl(loginSession.authUrl ?? "")
                    }
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {copiedUrl ? (
                      <IconCheck className="size-3.5" />
                    ) : (
                      <IconCopy className="size-3.5" />
                    )}
                    {copiedUrl ? "已复制" : "复制链接"}
                  </Button>
                </div>
              ) : null}
            </div>

            {loginSession.userCode ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">{"确认码："}</span>
                <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold">
                  {loginSession.userCode}
                </code>
              </div>
            ) : null}

            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => void handleSubmitCode(event)}
            >
              <label
                className="text-xs font-medium text-foreground"
                htmlFor={`ag-auth-code-${instance.id}`}
              >
                {"步骤 2：粘贴授权码或回调页面完整 URL"}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Google 授权码或回调链接"
                  className="min-w-0 flex-1 font-mono text-xs"
                  disabled={writeDisabled || submitLoginMutation.isPending}
                  id={`ag-auth-code-${instance.id}`}
                  onChange={(e) => setAuthCode(e.target.value)}
                  placeholder="粘贴 Google 授权码，或回调页面完整 URL…"
                  value={authCode}
                />
                <Button
                  disabled={
                    writeDisabled ||
                    !authCode.trim() ||
                    submitLoginMutation.isPending
                  }
                  size="sm"
                  type="submit"
                >
                  {submitLoginMutation.isPending ? (
                    <IconLoader2 className="size-3.5 animate-spin" />
                  ) : null}
                  {"提交授权码"}
                </Button>
                <Button
                  disabled={writeDisabled || cancelLoginMutation.isPending}
                  onClick={() => void handleCancelLogin()}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {"取消"}
                </Button>
              </div>
            </form>

            <p className="text-[11px] text-muted-foreground">
              {
                "提示：授权后的登录凭据仅保存在当前实例的独立隔离目录，不影响本机其他工具与账号。"
              }
            </p>
          </div>
        ) : null}

        {loginSession?.status === "failed" ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <IconAlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {loginSession.error || "登录失败，请重新尝试。"}
            </span>
          </div>
        ) : null}

        {loginSession?.status === "cancelled" ? (
          <div className="text-xs text-muted-foreground">{"登录已取消。"}</div>
        ) : null}
      </div>
    </div>
  );
}
