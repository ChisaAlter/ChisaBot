import {
  IconCheck,
  IconCode,
  IconDownload,
  IconHistory,
  IconKey,
  IconPlayerPause,
  IconPlug,
  IconRefresh,
  IconShieldCheck,
  IconTrash,
  IconUpload,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  type AppPackageSummary,
  type AppPackageValidationResult,
  appPackageDetailQueryOptions,
  appPackagesKeys,
  appPackagesQueryOptions,
  clearAppPackageOAuth,
  deleteAppPackage,
  disableAppPackage,
  exportAppPackage,
  importAppPackage,
  installAppPackage,
  mcpEnhancementQueryOptions,
  rollbackAppPackage,
  startAppPackageOAuth,
  updateAppPackageConfig,
  updateAppPackageOAuth,
  updateMcpEnhancement,
  validateAppPackage,
} from "@/lib/app-packages";

const RUNTIME_LABELS: Record<AppPackageSummary["runtime"]["kind"], string> = {
  "node-stdio": "隔离沙箱 Node MCP",
  "remote-mcp": "远端 MCP",
  "skills-only": "纯技能包",
};

function formatDateTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function triggerJsonDownload(filename: string, payload: unknown): void {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * AI 自研可执行微应用与单 JSON 插件包管理面板（挂载于 插件与 MCP 页）。
 * - 草稿审阅卡：显示 runtime / SHA-256 packageDigest / 源码预览 / 权限声明 → 显式批准安装；
 * - 配置与 Host 托管 OAuth 绑定；
 * - 不可变版本历史与一键回滚；
 * - 单 JSON 校验导入与严格脱敏导出。
 */
export function AppPackagesPanel({ settingItem }: { settingItem?: string }) {
  const queryClient = useQueryClient();
  const appsQuery = useQuery(appPackagesQueryOptions());

  const [reviewId, setReviewId] = useState<string | null>(null);
  const [configApp, setConfigApp] = useState<AppPackageSummary | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [oauthTokenDraft, setOAuthTokenDraft] = useState({
    accessToken: "",
    refreshToken: "",
    headerName: "",
  });
  const [historyApp, setHistoryApp] = useState<AppPackageSummary | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [validationResult, setValidationResult] =
    useState<AppPackageValidationResult | null>(null);

  const detailQuery = useQuery(
    appPackageDetailQueryOptions(reviewId ?? "", reviewId !== null),
  );

  const refreshAll = () =>
    queryClient.invalidateQueries({ queryKey: appPackagesKeys.all });

  const installMutation = useMutation({
    mutationFn: installAppPackage,
    onSuccess: (res) => {
      void refreshAll();
      if (reviewId) {
        void queryClient.invalidateQueries({
          queryKey: appPackagesKeys.detail(reviewId),
        });
      }
      if (res.probeError) {
        toast.info(
          `已批准安装「${res.app.name["zh-CN"]}」，但工具探测提示：${res.probeError}`,
        );
      } else {
        toast.success(`已批准并启用「${res.app.name["zh-CN"]}」`);
      }
      setReviewId(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const disableMutation = useMutation({
    mutationFn: disableAppPackage,
    onSuccess: (app) => {
      void refreshAll();
      toast.success(`已停用「${app.name["zh-CN"]}」并回收沙箱进程`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const configMutation = useMutation({
    mutationFn: updateAppPackageConfig,
    onSuccess: (app) => {
      void refreshAll();
      toast.success(`已加密保存「${app.name["zh-CN"]}」配置`);
      setConfigApp(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const oauthMutation = useMutation({
    mutationFn: updateAppPackageOAuth,
    onSuccess: (app) => {
      void refreshAll();
      toast.success(`已更新「${app.name["zh-CN"]}」Host 托管认证令牌`);
      setOAuthTokenDraft({ accessToken: "", refreshToken: "", headerName: "" });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const clearOAuthMutation = useMutation({
    mutationFn: clearAppPackageOAuth,
    onSuccess: (app) => {
      void refreshAll();
      toast.success(`已清空「${app.name["zh-CN"]}」认证令牌`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rollbackMutation = useMutation({
    mutationFn: rollbackAppPackage,
    onSuccess: (app) => {
      void refreshAll();
      toast.success(`已回滚「${app.name["zh-CN"]}」至 v${app.version}`);
      setHistoryApp(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAppPackage,
    onSuccess: () => {
      void refreshAll();
      toast.success("已删除微应用及其版本记录");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const validateMutation = useMutation({
    mutationFn: validateAppPackage,
    onSuccess: (res) => {
      setValidationResult(res);
      if (res.valid) {
        toast.success(`静态预检通过（摘要 ${res.digest?.slice(0, 12)}…）`);
      } else {
        toast.error(res.errors[0]?.message ?? "静态预检未通过");
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const importMutation = useMutation({
    mutationFn: importAppPackage,
    onSuccess: (res) => {
      void refreshAll();
      toast.success(
        `已导入草稿「${res.app.name["zh-CN"]}」v${res.app.version}（待审阅安装）`,
      );
      setImportOpen(false);
      setImportText("");
      setValidationResult(null);
      setReviewId(res.app.id);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function openConfigDialog(app: AppPackageSummary): void {
    const initial: Record<string, string> = {};
    for (const field of app.configSchema) {
      initial[field.key] = field.secret
        ? ""
        : (app.nonSecretValues[field.key] ?? field.defaultValue ?? "");
    }
    setConfigDraft(initial);
    setOAuthTokenDraft({ accessToken: "", refreshToken: "", headerName: "" });
    setConfigApp(app);
  }

  async function handleExport(app: AppPackageSummary): Promise<void> {
    try {
      const pkg = await exportAppPackage(app.id);
      triggerJsonDownload(`${app.id}-${app.version}.chisabot-app.json`, pkg);
      toast.success("已导出脱敏单 JSON 应用包（不含任何密钥或 OAuth 令牌）");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败");
    }
  }

  async function handleStartOAuth(app: AppPackageSummary): Promise<void> {
    try {
      const { authorizationUrl } = await startAppPackageOAuth(app.id);
      window.location.href = authorizationUrl;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "无法发起 OAuth2 授权",
      );
    }
  }

  async function handleFileSelect(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportText(text);
    setValidationResult(null);
  }

  const apps = appsQuery.data?.apps ?? [];
  const oauthCallbackUrl = appsQuery.data?.oauthCallbackUrl ?? null;

  return (
    <>
      <PageSection
        action={
          <div className="flex items-center gap-2">
            <Button
              disabled={appsQuery.isFetching}
              onClick={() => void appsQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconRefresh className="size-3.5" />
              {"刷新"}
            </Button>
            <Button
              data-testid="import-app-package-btn"
              onClick={() => {
                setImportOpen(true);
                setValidationResult(null);
              }}
              size="sm"
              type="button"
            >
              <IconUpload className="size-3.5" />
              {"导入应用包 JSON"}
            </Button>
          </div>
        }
        description="AI 在对话中通过 app-builder 提交的微应用或手动导入的单 JSON 插件包。草稿与升级新版均须经你审阅源码、权限声明与 SHA-256 摘要后手动批准才会运行。"
        settingItem={settingItem}
        title="AI 自研微应用与 MCP 包"
      >
        <div className="space-y-3" data-testid="app-packages-panel" id="app-packages">
          {appsQuery.isPending ? (
            <PageSkeleton rows={2} />
          ) : appsQuery.error ? (
            <p className="text-destructive text-sm" role="alert">
              {appsQuery.error.message}
            </p>
          ) : apps.length === 0 ? (
            <PageEmpty>
              {"暂无自研微应用。你可以在对话中让 AI 编写后端微应用并提交草稿，或点击右上角导入单 JSON 包。"}
            </PageEmpty>
          ) : (
            <div className="space-y-3">
              {apps.map((app) => (
                <div
                  className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-3"
                  data-testid={`app-package-card-${app.id}`}
                  key={app.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-sm">
                          {app.name["zh-CN"] || app.name.en}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {`${app.id}@${app.version}`}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {RUNTIME_LABELS[app.runtime.kind]}
                        </span>
                        {app.needsReview ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 text-xs dark:text-amber-400">
                            {app.installed ? "新版待重审" : "草稿待审阅"}
                          </span>
                        ) : app.enabled ? (
                          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-600 text-xs dark:text-emerald-400">
                            {"已批准运行"}
                          </span>
                        ) : (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                            {"已停用"}
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {app.description["zh-CN"] || app.description.en}
                      </p>
                      <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
                        <span className="font-mono">
                          {`SHA-256: ${app.currentDigest.slice(0, 16)}…`}
                        </span>
                        <span>
                          {`网络白名单: ${app.permissions.network.length > 0 ? app.permissions.network.join(", ") : "无外网声明"}`}
                        </span>
                        {app.oauth ? (
                          <span>
                            {`认证: ${app.oauth.type}（${app.oauthConnected ? "已连接" : "未连接"}）`}
                          </span>
                        ) : null}
                        {app.skills.length > 0 ? (
                          <span>{`捆绑技能: ${app.skills.length} 个`}</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        data-testid={`review-app-${app.id}`}
                        onClick={() => setReviewId(app.id)}
                        size="sm"
                        type="button"
                        variant={app.needsReview ? "default" : "outline"}
                      >
                        <IconCode className="size-3.5" />
                        {app.needsReview ? "审阅源码并安装" : "源码与摘要"}
                      </Button>
                      {app.enabled && !app.needsReview ? (
                        <Button
                          disabled={disableMutation.isPending}
                          onClick={() => disableMutation.mutate(app.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <IconPlayerPause className="size-3.5" />
                          {"停用"}
                        </Button>
                      ) : null}
                      {app.configSchema.length > 0 || app.oauth ? (
                        <Button
                          onClick={() => openConfigDialog(app)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <IconKey className="size-3.5" />
                          {"配置 / OAuth"}
                        </Button>
                      ) : null}
                      {app.revisions.length > 0 ? (
                        <Button
                          onClick={() => setHistoryApp(app)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <IconHistory className="size-3.5" />
                          {`版本 (${app.revisions.length})`}
                        </Button>
                      ) : null}
                      <Button
                        onClick={() => void handleExport(app)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <IconDownload className="size-3.5" />
                        {"脱敏导出"}
                      </Button>
                      <Button
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(app.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconTrash className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PageSection>

      {/* 审阅源码、权限声明、SHA-256 摘要并显式批准安装对话框 */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setReviewId(null);
        }}
        open={reviewId !== null}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {detailQuery.data
                ? `审阅微应用「${detailQuery.data.name["zh-CN"]}」v${detailQuery.data.version}`
                : "加载源码审阅信息…"}
            </DialogTitle>
            <DialogDescription>
              {"核对运行时、网络权限声明、SHA-256 摘要与完整源码；批准安装将把执行权严格锚定到当前摘要。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[65vh] overflow-y-auto space-y-4">
            {detailQuery.isPending ? (
              <PageSkeleton rows={3} />
            ) : detailQuery.error || !detailQuery.data ? (
              <p className="text-destructive text-sm">
                {detailQuery.error?.message ?? "无法读取应用详情。"}
              </p>
            ) : (
              <>
                <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5 text-xs">
                  <div>
                    <span className="text-muted-foreground">{"完整 SHA-256 摘要："}</span>
                    <span className="break-all font-mono">
                      {detailQuery.data.currentDigest}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{"运行态："}</span>
                    <span>
                      {RUNTIME_LABELS[detailQuery.data.runtime.kind]}
                      {detailQuery.data.runtime.kind === "node-stdio"
                        ? ` · 入口 ${detailQuery.data.runtime.entry} · 内存上限 ${detailQuery.data.runtime.memoryLimitMb ?? 128} MiB`
                        : detailQuery.data.runtime.kind === "remote-mcp"
                          ? ` · ${detailQuery.data.runtime.url} (${detailQuery.data.runtime.transport})`
                          : ""}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">{"声明网络源："}</span>
                    <span>
                      {detailQuery.data.permissions.network.length > 0
                        ? detailQuery.data.permissions.network.join("、")
                        : "无"}
                    </span>
                  </div>
                  {detailQuery.data.approvedDigest &&
                  detailQuery.data.approvedDigest !==
                    detailQuery.data.currentDigest ? (
                    <div className="text-amber-600 dark:text-amber-400">
                      {`注意：此前批准的摘要为 ${detailQuery.data.approvedDigest.slice(0, 16)}…，当前版本摘要已变化，需重新批准。`}
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <div className="font-medium text-xs text-muted-foreground">
                    {`源码文件清单（共 ${detailQuery.data.files.length} 个文件）`}
                  </div>
                  {detailQuery.data.files.map((file) => (
                    <div
                      className="rounded-lg border overflow-hidden"
                      key={file.path}
                    >
                      <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 font-mono text-xs">
                        <span>{file.path}</span>
                        <span className="text-muted-foreground">
                          {`${file.bytes} B · ${file.sha256.slice(0, 10)}`}
                        </span>
                      </div>
                      {file.preview !== null ? (
                        <pre className="max-h-60 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap break-all">
                          {file.preview}
                        </pre>
                      ) : (
                        <div className="p-3 text-muted-foreground text-xs">
                          {"二进制文件（base64），已通过静态格式与大小校验。"}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => setReviewId(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {"关闭"}
            </Button>
            {detailQuery.data ? (
              <Button
                data-testid="approve-install-app-btn"
                disabled={installMutation.isPending}
                onClick={() =>
                  installMutation.mutate({
                    id: detailQuery.data.id,
                    expectedDigest: detailQuery.data.currentDigest,
                    probe: detailQuery.data.runtime.kind === "node-stdio",
                  })
                }
                size="sm"
                type="button"
              >
                <IconShieldCheck className="size-3.5" />
                {installMutation.isPending
                  ? "正在批准并校验…"
                  : "确认摘要并批准安装启用"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 配置与 Host 托管 OAuth 对话框 */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfigApp(null);
        }}
        open={configApp !== null}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {configApp ? `配置与 OAuth · ${configApp.name["zh-CN"]}` : "配置"}
            </DialogTitle>
            <DialogDescription>
              {"所有密钥与 OAuth 令牌均使用 AES-256-GCM 加密封存于服务端，绝不会随脱敏包导出，也不会泄露给普通进程环境变量。"}
            </DialogDescription>
          </DialogHeader>
          {configApp ? (
            <DialogBody className="max-h-[65vh] overflow-y-auto space-y-5">
              {configApp.configSchema.length > 0 ? (
                <FieldGroup>
                  {configApp.configSchema.map((field) => {
                    const isConfigured = configApp.configuredKeys.includes(
                      field.key,
                    );
                    return (
                      <Field key={field.key}>
                        <FieldLabel>
                          {`${field.name["zh-CN"] || field.key} (${field.key})`}
                          {field.required ? " *" : ""}
                          {field.secret && isConfigured ? " · 已加密保存" : ""}
                        </FieldLabel>
                        <Input
                          onChange={(e) =>
                            setConfigDraft((prev) => ({
                              ...prev,
                              [field.key]: e.target.value,
                            }))
                          }
                          placeholder={
                            field.secret && isConfigured
                              ? "留空保持现有密文，输入新值可覆盖"
                              : (field.defaultValue ?? "")
                          }
                          type={field.secret ? "password" : "text"}
                          value={configDraft[field.key] ?? ""}
                        />
                      </Field>
                    );
                  })}
                  <div className="flex justify-end">
                    <Button
                      disabled={configMutation.isPending}
                      onClick={() =>
                        configMutation.mutate({
                          id: configApp.id,
                          values: configDraft,
                        })
                      }
                      size="sm"
                      type="button"
                    >
                      <IconCheck className="size-3.5" />
                      {configMutation.isPending ? "保存中…" : "保存配置"}
                    </Button>
                  </div>
                </FieldGroup>
              ) : null}

              {configApp.oauth ? (
                <div className="rounded-lg border p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-sm">
                      {`Host 托管认证（${configApp.oauth.type}）`}
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {configApp.oauthConnected ? "已连接令牌" : "未绑定"}
                    </span>
                  </div>
                  {configApp.oauth.type === "oauth2" && oauthCallbackUrl ? (
                    <div className="text-muted-foreground text-xs">
                      {"OAuth2 回调地址："}
                      <code className="break-all font-mono">
                        {oauthCallbackUrl}
                      </code>
                    </div>
                  ) : null}
                  <FieldGroup>
                    <Field>
                      <FieldLabel>{"Access Token / API Key"}</FieldLabel>
                      <Input
                        onChange={(e) =>
                          setOAuthTokenDraft((prev) => ({
                            ...prev,
                            accessToken: e.target.value,
                          }))
                        }
                        placeholder="输入令牌（保存后仅加密封存，触发沙箱重启生效）"
                        type="password"
                        value={oauthTokenDraft.accessToken}
                      />
                    </Field>
                    {configApp.oauth.type === "oauth2" ? (
                      <Field>
                        <FieldLabel>{"Refresh Token（可选）"}</FieldLabel>
                        <Input
                          onChange={(e) =>
                            setOAuthTokenDraft((prev) => ({
                              ...prev,
                              refreshToken: e.target.value,
                            }))
                          }
                          placeholder="配置后令牌过期时 Host 自动刷新并重启子进程"
                          type="password"
                          value={oauthTokenDraft.refreshToken}
                        />
                      </Field>
                    ) : null}
                  </FieldGroup>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={
                        oauthMutation.isPending ||
                        (!oauthTokenDraft.accessToken.trim() &&
                          !oauthTokenDraft.refreshToken.trim())
                      }
                      onClick={() =>
                        oauthMutation.mutate({
                          id: configApp.id,
                          ...(oauthTokenDraft.accessToken.trim()
                            ? {
                                accessToken:
                                  oauthTokenDraft.accessToken.trim(),
                              }
                            : {}),
                          ...(oauthTokenDraft.refreshToken.trim()
                            ? {
                                refreshToken:
                                  oauthTokenDraft.refreshToken.trim(),
                              }
                            : {}),
                        })
                      }
                      size="sm"
                      type="button"
                    >
                      {"保存托管令牌"}
                    </Button>
                    {configApp.oauth.type === "oauth2" && oauthCallbackUrl ? (
                      <Button
                        onClick={() => void handleStartOAuth(configApp)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <IconPlug className="size-3.5" />
                        {"发起 OAuth2 授权"}
                      </Button>
                    ) : null}
                    {configApp.oauthConnected ? (
                      <Button
                        disabled={clearOAuthMutation.isPending}
                        onClick={() => clearOAuthMutation.mutate(configApp.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {"解绑令牌"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfigApp(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {"关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 不可变版本历史与一键回滚对话框 */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setHistoryApp(null);
        }}
        open={historyApp !== null}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {historyApp ? `不可变版本栈 · ${historyApp.name["zh-CN"]}` : "版本"}
            </DialogTitle>
            <DialogDescription>
              {"每个版本均按 SHA-256 摘要不可变存储，可一键回滚到任意历史版本。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto space-y-2">
            {(historyApp?.revisions ?? []).map((rev) => {
              const isCurrent = rev.digest === historyApp?.currentDigest;
              const isApproved = rev.digest === historyApp?.approvedDigest;
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-xs"
                  key={rev.digest}
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 font-medium">
                      <span>{`v${rev.version}`}</span>
                      <span className="font-mono text-muted-foreground">
                        {rev.digest.slice(0, 14)}
                      </span>
                      {isCurrent ? (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">
                          {"当前版本"}
                        </span>
                      ) : null}
                      {isApproved ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                          {"已批准摘要"}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground">
                      {`${formatDateTime(rev.createdAt)} · ${rev.createdBy} · ${rev.fileCount} 文件`}
                    </div>
                  </div>
                  {!isCurrent && historyApp ? (
                    <Button
                      disabled={rollbackMutation.isPending}
                      onClick={() =>
                        rollbackMutation.mutate({
                          id: historyApp.id,
                          digest: rev.digest,
                          approve: true,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {"回滚并启用"}
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => setHistoryApp(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {"关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 单 JSON 导入与预检对话框 */}
      <Dialog onOpenChange={setImportOpen} open={importOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{"导入单 JSON 微应用包（chisabot-app/v1）"}</DialogTitle>
            <DialogDescription>
              {"导入后仅落入草稿区，绝不会自动执行代码。你可以先预检静态安全项与 SHA-256 摘要，再导入并审阅安装。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                accept=".json,application/json"
                onChange={(e) => void handleFileSelect(e)}
                type="file"
              />
            </div>
            <Textarea
              className="min-h-48 font-mono text-xs"
              onChange={(e) => {
                setImportText(e.target.value);
                setValidationResult(null);
              }}
              placeholder='粘贴 {"format": "chisabot-app/v1", ...} 单 JSON 应用包'
              value={importText}
            />
            {validationResult ? (
              <div className="rounded-lg border p-3 text-xs space-y-1">
                <div
                  className={
                    validationResult.valid
                      ? "font-medium text-emerald-600 dark:text-emerald-400"
                      : "font-medium text-destructive"
                  }
                >
                  {validationResult.valid
                    ? `预检通过 · ${validationResult.fileCount} 文件 · ${validationResult.totalBytes} B · SHA-256 ${validationResult.digest?.slice(0, 16)}…`
                    : `预检发现 ${validationResult.errors.length} 项错误`}
                </div>
                {validationResult.errors.map((issue) => (
                  <div
                    className="text-destructive"
                    key={`${issue.path}:${issue.code}`}
                  >
                    {`[${issue.path}] ${issue.message}`}
                  </div>
                ))}
                {validationResult.warnings.map((issue) => (
                  <div
                    className="text-amber-600 dark:text-amber-400"
                    key={`${issue.path}:${issue.code}`}
                  >
                    {`[提示 ${issue.path}] ${issue.message}`}
                  </div>
                ))}
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => setImportOpen(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              disabled={validateMutation.isPending || !importText.trim()}
              onClick={() => validateMutation.mutate(importText)}
              size="sm"
              type="button"
              variant="outline"
            >
              {validateMutation.isPending ? "预检中…" : "静态安全预检"}
            </Button>
            <Button
              disabled={importMutation.isPending || !importText.trim()}
              onClick={() => importMutation.mutate(importText)}
              size="sm"
              type="button"
            >
              {importMutation.isPending ? "导入中…" : "导入为草稿"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 单个远端 MCP 连接器的高级增强设置卡片（挂载于 `/admin/plugins/$key`）：
 * - 传输协议切换（Streamable HTTP / SSE）；
 * - 自定义指令 `customInstructions`；
 * - 单工具级启停开关（`disabledTools[]`）；
 * - 加密自定义 Header；
 * - `mcp-last-good` 降级保护快照展示。
 */
export function McpEnhancementsCard({
  serverId,
  toolNames,
}: {
  serverId: string;
  toolNames: readonly string[];
}) {
  const queryClient = useQueryClient();
  const enhancementQuery = useQuery(mcpEnhancementQueryOptions(serverId));

  const [transportDraft, setTransportDraft] = useState<
    "streamable-http" | "sse" | null
  >(null);
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(
    null,
  );
  const [headerKey, setHeaderKey] = useState("");
  const [headerVal, setHeaderVal] = useState("");

  const saveMutation = useMutation({
    mutationFn: (patch: Parameters<typeof updateMcpEnhancement>[1]) =>
      updateMcpEnhancement(serverId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        appPackagesKeys.mcpEnhancement(serverId),
        updated,
      );
      setTransportDraft(null);
      setInstructionsDraft(null);
      setHeaderKey("");
      setHeaderVal("");
      toast.success("远端 MCP 增强设置已保存");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = enhancementQuery.data;
  if (enhancementQuery.isPending || !data) return null;

  const activeTransport = transportDraft ?? data.transport;
  const activeInstructions = instructionsDraft ?? data.customInstructions;
  const disabledSet = new Set(data.disabledTools);

  return (
    <PageSection
      description="配置 SSE / Streamable HTTP 传输、连接器专属提示词、单工具级启停开关、加密自定义 Header，并查看 mcp-last-good 降级保护状态。"
      title="MCP 高级增强与降级保护"
    >
      <div className="space-y-4 rounded-xl border border-border/70 bg-card/60 p-4">
        {data.lastGood?.degraded ? (
          <div
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs space-y-1"
            role="status"
          >
            <div className="font-medium text-amber-700 dark:text-amber-300">
              {`mcp-last-good 降级保护已启用：已保留最近一次可用工具快照（${data.lastGood.tools.length} 个工具，捕获于 ${formatDateTime(data.lastGood.capturedAt)}），未清零现有配置。`}
            </div>
            {data.lastGood.lastProbeError ? (
              <div className="text-muted-foreground">
                {`最近探测错误：${data.lastGood.lastProbeError}`}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel>{"远端传输协议"}</FieldLabel>
            <Select
              onValueChange={(value) => {
                if (value === "streamable-http" || value === "sse") {
                  setTransportDraft(value);
                }
              }}
              value={activeTransport}
            >
              <SelectTrigger>
                <SelectValue>
                  {activeTransport === "sse"
                    ? "SSE（Server-Sent Events）"
                    : "Streamable HTTP"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="streamable-http">
                  {"Streamable HTTP（推荐）"}
                </SelectItem>
                <SelectItem value="sse">
                  {"SSE（Server-Sent Events）"}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel>
              {`自定义加密 Header（已存 ${data.customHeaderKeys.length} 项）`}
            </FieldLabel>
            <div className="flex gap-2">
              <Input
                onChange={(e) => setHeaderKey(e.target.value)}
                placeholder="Header 名（如 X-Tenant-Id）"
                value={headerKey}
              />
              <Input
                onChange={(e) => setHeaderVal(e.target.value)}
                placeholder="加密值"
                type="password"
                value={headerVal}
              />
              <Button
                disabled={
                  saveMutation.isPending ||
                  !headerKey.trim() ||
                  !headerVal.trim()
                }
                onClick={() =>
                  saveMutation.mutate({
                    customHeaders: { [headerKey.trim()]: headerVal.trim() },
                  })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {"添加"}
              </Button>
            </div>
            {data.customHeaderKeys.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.customHeaderKeys.map((key) => (
                  <span
                    className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono text-xs"
                    key={key}
                  >
                    {key}
                    <button
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        saveMutation.mutate({ clearHeaderKeys: [key] })
                      }
                      type="button"
                    >
                      {"×"}
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </Field>
        </div>

        <Field>
          <FieldLabel>{"连接器专属使用指引（customInstructions）"}</FieldLabel>
          <Textarea
            className="min-h-20 text-xs"
            onChange={(e) => setInstructionsDraft(e.target.value)}
            placeholder="填写后仅在机器人持有此连接器的可用工具时自动注入系统提示词，例如调用顺序、字段约定或业务注意项。"
            value={activeInstructions}
          />
        </Field>

        <div className="flex justify-end">
          <Button
            disabled={saveMutation.isPending}
            onClick={() =>
              saveMutation.mutate({
                transport: activeTransport,
                customInstructions: activeInstructions,
              })
            }
            size="sm"
            type="button"
          >
            {saveMutation.isPending ? "保存中…" : "保存传输与使用指引"}
          </Button>
        </div>

        {toolNames.length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <div className="font-medium text-xs text-muted-foreground">
              {"单工具级启停开关（停用后对全部机器人立即隐藏且调用时硬拒绝）"}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {toolNames.map((toolName) => {
                const enabled = !disabledSet.has(toolName);
                return (
                  <div
                    className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs"
                    key={toolName}
                  >
                    <span className="truncate font-mono">{toolName}</span>
                    <Switch
                      checked={enabled}
                      disabled={saveMutation.isPending}
                      onCheckedChange={(checked) => {
                        const next = new Set(data.disabledTools);
                        if (checked) next.delete(toolName);
                        else next.add(toolName);
                        saveMutation.mutate({ disabledTools: [...next] });
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </PageSection>
  );
}
