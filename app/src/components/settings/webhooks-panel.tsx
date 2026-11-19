import {
  IconBolt,
  IconEye,
  IconEyeOff,
  IconKey,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { agoText } from "@/lib/im";
import { cn } from "@/lib/utils";
import {
  createWebhookRule,
  deleteWebhookRule,
  rotateWebhookSecret,
  toggleWebhookRule,
  WEBHOOK_RUN_STATUS_LABELS,
  WEBHOOK_RUN_STATUSES,
  WEBHOOK_TRIGGER_KINDS,
  WEBHOOK_VENDOR_META,
  type WebhookRuleView,
  type WebhookRunStatus,
  type WebhookTriggerKind,
  webhookKeys,
  webhookRunsQueryOptions,
  webhooksQueryOptions,
} from "@/lib/webhooks";

/**
 * 多 Webhook 规则与 7 态执行流水管理面板（挂载于 `/settings/schedules`）。
 *
 * - 支持全部 5 厂商签名族（Standard/Bearer、GitHub、Linear、Sentry、PagerDuty）；
 * - 一次性密钥弹窗默认遮罩，支持显示/隐藏切换与复制，关闭后立即清空组件内密钥 state；
 * - 停用或删除规则时提示自动取消的排队任务数；
 * - 7 态执行流水（queued/running/completed/failed/interrupted/cancelled/skipped）实时筛选。
 */

function statusBadgeTone(status: WebhookRunStatus): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "running":
    case "queued":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
    case "failed":
    case "interrupted":
      return "bg-destructive/15 text-destructive";
    case "cancelled":
    case "skipped":
      return "bg-muted text-muted-foreground";
  }
}

function fullIngressUrl(ingressPath: string): string {
  if (typeof window === "undefined") return ingressPath;
  return `${window.location.origin}${ingressPath}`;
}

function OneTimeSecretDialog({
  payload,
  onClose,
}: {
  payload: { title: string; ingressPath: string; secret: string } | null;
  onClose: () => void;
}) {
  const [revealed, setRevealed] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setRevealed(false);
      onClose();
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={Boolean(payload)}>
      <DialogContent className="max-w-lg" data-testid="webhook-secret-dialog">
        {payload ? (
          <>
            <DialogHeader>
              <DialogTitle>{"保存一次性 Webhook 签名密钥"}</DialogTitle>
              <DialogDescription>
                {`规则「${payload.title}」的签名密钥仅在此刻展示一次，关闭弹窗后将无法再次查看。`}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-3 space-y-3">
              <div className="space-y-1">
                <div className="font-medium text-muted-foreground text-xs">
                  {"入站请求地址（POST）"}
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs">
                    {fullIngressUrl(payload.ingressPath)}
                  </code>
                  <CopyButton
                    size="sm"
                    value={fullIngressUrl(payload.ingressPath)}
                    variant="outline"
                  >
                    {"复制地址"}
                  </CopyButton>
                </div>
              </div>

              <div className="space-y-1">
                <div className="font-medium text-muted-foreground text-xs">
                  {"一次性签名密钥（Signing Secret）"}
                </div>
                <div className="flex items-center gap-2">
                  <code
                    className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs"
                    data-private=""
                    data-testid="webhook-one-time-secret"
                  >
                    {revealed
                      ? payload.secret
                      : "•".repeat(Math.min(payload.secret.length, 32))}
                  </code>
                  <Button
                    aria-label={revealed ? "隐藏密钥" : "显示密钥"}
                    data-testid="webhook-secret-toggle"
                    onClick={() => setRevealed((prev) => !prev)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {revealed ? (
                      <IconEyeOff className="size-4" />
                    ) : (
                      <IconEye className="size-4" />
                    )}
                    {revealed ? "隐藏" : "显示"}
                  </Button>
                  <CopyButton
                    size="sm"
                    value={payload.secret}
                    variant="outline"
                  >
                    {"复制密钥"}
                  </CopyButton>
                </div>
              </div>
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                data-testid="webhook-secret-close"
                onClick={() => handleOpenChange(false)}
                size="sm"
                type="button"
              >
                {"我已妥善保存并关闭"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  bots,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: readonly { id: string; name: string }[];
  onCreated: (result: { rule: WebhookRuleView; secret: string | null }) => void;
}) {
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState(() => bots[0]?.id ?? "");
  const [kind, setKind] = useState<WebhookTriggerKind>("webhook");
  const [repository, setRepository] = useState("");
  const [eventTypesRaw, setEventTypesRaw] = useState("");
  const [secret, setSecret] = useState("");
  const [instruction, setInstruction] = useState("");

  const effectiveAgentId = agentId || bots[0]?.id || "";
  const vendor = WEBHOOK_VENDOR_META[kind];

  const createAction = useAsyncAction(
    async () => {
      if (!effectiveAgentId) {
        throw new Error("请先创建一个机器人后再添加 Webhook 规则。");
      }
      const eventTypes = eventTypesRaw
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const created = await createWebhookRule({
        title: title.trim(),
        agentId: effectiveAgentId,
        kind,
        instruction: instruction.trim(),
        ...(kind === "github" && repository.trim()
          ? { repository: repository.trim() }
          : {}),
        ...(eventTypes.length > 0 ? { eventTypes } : {}),
        ...(!vendor.generatedSecret && secret.trim()
          ? { secret: secret.trim() }
          : {}),
      });
      setTitle("");
      setRepository("");
      setEventTypesRaw("");
      setSecret("");
      setInstruction("");
      onOpenChange(false);
      onCreated(created);
    },
    { errorToast: (error) => error.message },
  );

  const canSubmit =
    Boolean(title.trim()) &&
    Boolean(effectiveAgentId) &&
    Boolean(instruction.trim());

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{"新建入站 Webhook 规则"}</DialogTitle>
          <DialogDescription>
            {"外部系统推送签名事件后，自动唤醒指定机器人执行任务并记录流水。"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-3">
          <form
            className="im-form"
            id="create-webhook-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit && createAction.state !== "pending") {
                void createAction.run();
              }
            }}
          >
            <label className="im-field" htmlFor="webhook-create-title">
              <span className="im-field-l">{"规则名称"}</span>
              <Input
                id="webhook-create-title"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：生产告警自动排查"
                value={title}
              />
            </label>

            <div className="im-grid">
              <label className="im-field" htmlFor="webhook-create-vendor">
                <span className="im-field-l">{"签名协议族"}</span>
                <Select
                  onValueChange={(value) => {
                    if (
                      typeof value === "string" &&
                      (WEBHOOK_TRIGGER_KINDS as readonly string[]).includes(
                        value,
                      )
                    ) {
                      setKind(value as WebhookTriggerKind);
                    }
                  }}
                  value={kind}
                >
                  <SelectTrigger id="webhook-create-vendor">
                    <SelectValue>{vendor.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WEBHOOK_TRIGGER_KINDS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {WEBHOOK_VENDOR_META[item].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="im-field-h">{vendor.note}</span>
              </label>

              <label className="im-field" htmlFor="webhook-create-bot">
                <span className="im-field-l">{"执行机器人"}</span>
                <Select
                  onValueChange={(value) => {
                    if (typeof value === "string" && value) setAgentId(value);
                  }}
                  value={effectiveAgentId}
                >
                  <SelectTrigger id="webhook-create-bot">
                    <SelectValue>
                      {bots.find((b) => b.id === effectiveAgentId)?.name ??
                        "选择机器人"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {bots.map((bot) => (
                      <SelectItem key={bot.id} value={bot.id}>
                        {bot.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            {kind === "github" ? (
              <label className="im-field" htmlFor="webhook-create-repo">
                <span className="im-field-l">{"限定 GitHub 仓库（可选）"}</span>
                <Input
                  className="font-mono"
                  id="webhook-create-repo"
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/repo"
                  spellCheck={false}
                  value={repository}
                />
              </label>
            ) : null}

            <label className="im-field" htmlFor="webhook-create-events">
              <span className="im-field-l">
                {"事件类型过滤（可选，逗号分隔）"}
              </span>
              <Input
                className="font-mono"
                id="webhook-create-events"
                onChange={(event) => setEventTypesRaw(event.target.value)}
                placeholder="例如：issues.opened, pull_request.opened（留空接收全部）"
                spellCheck={false}
                value={eventTypesRaw}
              />
            </label>

            {!vendor.generatedSecret ? (
              <label className="im-field" htmlFor="webhook-create-secret">
                <span className="im-field-l">
                  {`厂商签名密钥（${vendor.signatureHeader}，可稍后补充）`}
                </span>
                <Input
                  autoComplete="new-password"
                  className="font-mono"
                  id="webhook-create-secret"
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="粘贴第三方平台生成的签名密钥"
                  type="password"
                  value={secret}
                />
              </label>
            ) : null}

            <label className="im-field" htmlFor="webhook-create-instruction">
              <span className="im-field-l">{"触发后执行指令"}</span>
              <Textarea
                id="webhook-create-instruction"
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="例如：汇总告警堆栈、检查相关提交并给出修复建议。"
                rows={3}
                value={instruction}
              />
            </label>
          </form>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            {"取消"}
          </Button>
          <Button
            disabled={!canSubmit}
            feedback="save"
            form="create-webhook-form"
            size="sm"
            state={createAction.state}
            type="submit"
          >
            {"创建规则"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PasteVendorSecretDialog({
  rule,
  onClose,
  onSaved,
}: {
  rule: WebhookRuleView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pasted, setPasted] = useState("");
  const saveAction = useAsyncAction(
    async () => {
      if (!rule || !pasted.trim()) throw new Error("请粘贴厂商签名密钥。");
      await rotateWebhookSecret(rule.id, pasted.trim());
      setPasted("");
      onClose();
      onSaved();
    },
    { errorToast: (error) => error.message },
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setPasted("");
          onClose();
        }
      }}
      open={Boolean(rule)}
    >
      <DialogContent className="max-w-md">
        {rule ? (
          <>
            <DialogHeader>
              <DialogTitle>{`更新「${rule.title}」的厂商密钥`}</DialogTitle>
              <DialogDescription>
                {`粘贴 ${WEBHOOK_VENDOR_META[rule.kind].label} 提供的最新签名密钥，旧密钥会立即失效。`}
              </DialogDescription>
            </DialogHeader>
            <DialogBody className="mt-3">
              <label className="im-field" htmlFor="webhook-paste-secret">
                <span className="im-field-l">{"新签名密钥"}</span>
                <Input
                  autoComplete="new-password"
                  className="font-mono"
                  id="webhook-paste-secret"
                  onChange={(event) => setPasted(event.target.value)}
                  placeholder="粘贴厂商签名密钥"
                  type="password"
                  value={pasted}
                />
              </label>
            </DialogBody>
            <DialogFooter className="mt-4">
              <Button
                onClick={onClose}
                size="sm"
                type="button"
                variant="outline"
              >
                {"取消"}
              </Button>
              <Button
                disabled={!pasted.trim()}
                feedback="save"
                onClick={() => void saveAction.run()}
                size="sm"
                state={saveAction.state}
                type="button"
              >
                {"保存密钥"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** 多 Webhook 规则与 7 态执行流水管理面板。 */
export function WebhooksPanel() {
  const queryClient = useQueryClient();
  const rulesQuery = useQuery(webhooksQueryOptions());
  const botsQuery = useQuery(agentListQueryOptions());
  const [selectedStatus, setSelectedStatus] = useState<
    WebhookRunStatus | "all"
  >("all");
  const [selectedRuleId, setSelectedRuleId] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [oneTimeSecret, setOneTimeSecret] = useState<{
    title: string;
    ingressPath: string;
    secret: string;
  } | null>(null);
  const [pasteTarget, setPasteTarget] = useState<WebhookRuleView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runsQuery = useQuery(
    webhookRunsQueryOptions({
      ...(selectedRuleId !== "all" ? { triggerId: selectedRuleId } : {}),
      ...(selectedStatus !== "all" ? { status: selectedStatus } : {}),
      limit: 50,
    }),
  );

  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
  };

  const botNameById = new Map(
    (botsQuery.data ?? []).map((bot) => [bot.id, bot.name]),
  );

  async function handleToggle(rule: WebhookRuleView, enabled: boolean) {
    setBusyId(rule.id);
    try {
      const res = await toggleWebhookRule(rule.id, enabled);
      await refreshAll();
      toast.success(
        enabled
          ? `已启用「${rule.title}」`
          : res.cancelledRuns > 0
            ? `已停用「${rule.title}」，并自动取消 ${res.cancelledRuns} 条排队任务`
            : `已停用「${rule.title}」`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换状态失败");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRotate(rule: WebhookRuleView) {
    const meta = WEBHOOK_VENDOR_META[rule.kind];
    if (!meta.generatedSecret) {
      setPasteTarget(rule);
      return;
    }
    const ok = await confirmDialog({
      title: `重置「${rule.title}」的签名密钥？`,
      description:
        "重置后旧密钥立即失效，新密钥仅显示一次，请同步更新调用方配置。",
      confirmLabel: "立即重置",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(rule.id);
    try {
      const rotated = await rotateWebhookSecret(rule.id);
      await refreshAll();
      if (rotated.secret) {
        setOneTimeSecret({
          title: rule.title,
          ingressPath: rotated.rule.ingressPath,
          secret: rotated.secret,
        });
      }
      toast.success(`已重置「${rule.title}」的签名密钥。`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重置密钥失败");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(rule: WebhookRuleView) {
    const ok = await confirmDialog({
      title: `删除 Webhook 规则「${rule.title}」？`,
      description:
        "删除后该入站地址立即失效，密钥同步吊销，尚未执行的排队事件会自动取消。",
      confirmLabel: "删除规则",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(rule.id);
    try {
      const res = await deleteWebhookRule(rule.id);
      if (selectedRuleId === rule.id) setSelectedRuleId("all");
      await refreshAll();
      toast.success(
        res.cancelledRuns > 0
          ? `已删除「${rule.title}」，并取消 ${res.cancelledRuns} 条排队任务`
          : `已删除「${rule.title}」`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除规则失败");
    } finally {
      setBusyId(null);
    }
  }

  const rules = rulesQuery.data?.rules ?? [];
  const quota = rulesQuery.data?.quota;
  const runs = runsQuery.data?.runs ?? [];
  const counts = runsQuery.data?.counts;

  return (
    <PageSection
      action={
        <div className="flex flex-wrap items-center gap-2">
          {quota ? (
            <span className="text-muted-foreground text-xs">
              {`配额 ${quota.used} / ${quota.limit}`}
            </span>
          ) : null}
          <Button
            data-testid="webhook-create-btn"
            onClick={() => setCreateOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconPlus className="size-4" />
            {"新建 Webhook"}
          </Button>
        </div>
      }
      description="统一管理 Standard Webhooks / GitHub / Linear / Sentry / PagerDuty 签名入站规则与 7 态执行流水。停用或删除规则会自动取消排队中的事件。"
      settingItem="schedules.webhooks"
      title="入站 Webhook"
    >
      <div className="space-y-4" data-testid="webhooks-panel">
        {/* 规则列表 */}
        {rulesQuery.isPending ? (
          <PageSkeleton rows={2} />
        ) : rulesQuery.isError ? (
          <ErrorCard
            action={
              <Button
                onClick={() => void rulesQuery.refetch()}
                size="sm"
                variant="outline"
              >
                {"重试"}
              </Button>
            }
            description={rulesQuery.error.message}
            title="无法加载 Webhook 规则"
          />
        ) : rules.length === 0 ? (
          <Card className="p-5 text-center text-muted-foreground text-sm">
            {
              "还没有配置入站 Webhook 规则。点击右上角「新建 Webhook」创建一条签名规则。"
            }
          </Card>
        ) : (
          <div className="space-y-2.5" data-testid="webhook-rule-list">
            {rules.map((rule) => {
              const vendor = WEBHOOK_VENDOR_META[rule.kind];
              const ingressUrl = fullIngressUrl(rule.ingressPath);
              const busy = busyId === rule.id;
              return (
                <Card
                  className="space-y-2.5 p-4"
                  data-testid="webhook-rule-card"
                  key={rule.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <IconBolt className="size-4 shrink-0 text-primary" />
                        <span className="font-medium text-sm">
                          {rule.title}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {vendor.label}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {botNameById.get(rule.agentId) ?? rule.agentId}
                        </span>
                        {!rule.hasSecret ? (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                            {"待配置签名密钥"}
                          </span>
                        ) : null}
                      </div>
                      <p className="line-clamp-2 text-muted-foreground text-xs">
                        {rule.instruction}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        aria-label={
                          rule.enabled
                            ? `停用「${rule.title}」`
                            : `启用「${rule.title}」`
                        }
                        checked={rule.enabled}
                        disabled={busy}
                        onCheckedChange={(checked) =>
                          void handleToggle(rule, checked)
                        }
                      />
                      <Button
                        disabled={busy}
                        onClick={() => void handleRotate(rule)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <IconKey className="size-3.5" />
                        {vendor.generatedSecret ? "重置密钥" : "更新密钥"}
                      </Button>
                      <Button
                        aria-label={`删除「${rule.title}」`}
                        disabled={busy}
                        onClick={() => void handleDelete(rule)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconTrash className="size-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <code
                      className="min-w-0 flex-1 truncate rounded bg-muted/50 px-2 py-1 font-mono text-[11px]"
                      data-private=""
                    >
                      {ingressUrl}
                    </code>
                    <CopyButton size="sm" value={ingressUrl} variant="outline">
                      {"复制地址"}
                    </CopyButton>
                  </div>

                  {rule.repository || rule.eventTypes.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                      {rule.repository ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                          {`repo: ${rule.repository}`}
                        </span>
                      ) : null}
                      {rule.eventTypes.map((ev) => (
                        <span
                          className="rounded bg-muted px-1.5 py-0.5 font-mono"
                          key={ev}
                        >
                          {ev}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}

        {/* 7 态执行流水 */}
        <Card className="space-y-3 p-4" data-testid="webhook-runs-section">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-sm">{"执行流水（7 态）"}</span>
            <div className="flex flex-wrap items-center gap-2">
              {rules.length > 0 ? (
                <Select
                  onValueChange={(value) => {
                    if (typeof value === "string" && value) {
                      setSelectedRuleId(value);
                    }
                  }}
                  value={selectedRuleId}
                >
                  <SelectTrigger aria-label="按规则筛选" className="h-8 w-44">
                    <SelectValue>
                      {selectedRuleId === "all"
                        ? "全部规则"
                        : (rules.find((r) => r.id === selectedRuleId)?.title ??
                          "全部规则")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{"全部规则"}</SelectItem>
                    {rules.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button
                disabled={runsQuery.isFetching}
                onClick={() => void runsQuery.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconRefresh className="size-3.5" />
                {"刷新"}
              </Button>
            </div>
          </div>

          <div
            className="flex flex-wrap gap-1.5"
            data-testid="webhook-status-filters"
          >
            <Button
              onClick={() => setSelectedStatus("all")}
              size="sm"
              type="button"
              variant={selectedStatus === "all" ? "secondary" : "outline"}
            >
              {"全部"}
            </Button>
            {WEBHOOK_RUN_STATUSES.map((status) => (
              <Button
                key={status}
                onClick={() => setSelectedStatus(status)}
                size="sm"
                type="button"
                variant={selectedStatus === status ? "secondary" : "outline"}
              >
                {`${WEBHOOK_RUN_STATUS_LABELS[status]} (${counts?.[status] ?? 0})`}
              </Button>
            ))}
          </div>

          {runsQuery.isPending ? (
            <PageSkeleton rows={2} />
          ) : runsQuery.isError ? (
            <p className="text-destructive text-xs" role="alert">
              {runsQuery.error.message}
            </p>
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {"暂无匹配的 Webhook 执行记录。"}
            </p>
          ) : (
            <div className="space-y-2" data-testid="webhook-run-list">
              {runs.map((run) => (
                <div
                  className="flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs"
                  key={run.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 font-medium text-[11px]",
                          statusBadgeTone(run.status),
                        )}
                      >
                        {WEBHOOK_RUN_STATUS_LABELS[run.status]}
                      </span>
                      <span className="font-medium text-foreground">
                        {run.ruleTitle}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {`${run.source} · ${run.eventType}`}
                      </span>
                    </div>
                    <span className="text-muted-foreground">
                      {agoText(run.createdAt)}
                    </span>
                  </div>
                  {run.error ? (
                    <p className="text-destructive">{run.error}</p>
                  ) : run.replyPreview ? (
                    <p className="line-clamp-2 text-muted-foreground">
                      {run.replyPreview}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <CreateWebhookDialog
        bots={(botsQuery.data ?? []).map((b) => ({ id: b.id, name: b.name }))}
        onCreated={(created) => {
          void refreshAll();
          if (created.secret) {
            setOneTimeSecret({
              title: created.rule.title,
              ingressPath: created.rule.ingressPath,
              secret: created.secret,
            });
          } else {
            toast.success(`已创建规则「${created.rule.title}」。`);
          }
        }}
        onOpenChange={setCreateOpen}
        open={createOpen}
      />

      <OneTimeSecretDialog
        onClose={() => setOneTimeSecret(null)}
        payload={oneTimeSecret}
      />

      <PasteVendorSecretDialog
        onClose={() => setPasteTarget(null)}
        onSaved={() => {
          toast.success("签名密钥已更新。");
          void refreshAll();
        }}
        rule={pasteTarget}
      />
    </PageSection>
  );
}
