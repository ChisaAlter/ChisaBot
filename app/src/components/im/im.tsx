import {
  IconAlertTriangle,
  IconBrandDingtalk,
  IconBrandQq,
  IconBrandTelegram,
  IconBrandWechat,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconFileText,
  IconMessageCircle,
  IconPencil,
  IconPlugConnected,
  IconQrcode,
  IconRefresh,
  IconRobot,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IM_PLATFORMS,
  IM_STATUS_LABEL,
  type ImConnectionView,
  type ImField,
  type ImPlatform,
  type ImPlatformInfo,
  imPlatform,
} from "../../../../shared/im";
import { PairQr } from "@/components/devices/pair-phone";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, ListRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { type AuthenticatedUser, authKeys } from "@/lib/auth/keys";
import {
  agoText,
  createImConnection,
  deleteImConnection,
  type ImConnectionInput,
  type ImQrStartResult,
  type ImTestResult,
  imKeys,
  imLogsQueryOptions,
  pollImQr,
  startImQr,
  testImConnection,
  testImDraft,
  updateImConnection,
} from "@/lib/im";
import { cn } from "@/lib/utils";

/**
 * 设置 → IM 接入（DESIGN.md §49）。一行一个连接：平台图标 · 名字 · 平台 / 机器人 / 最后消息 · 状态徽章 · 启用开关 · ⋯。
 * 添加 / 编辑在玻璃弹窗里：先选平台（新建时），支持扫码一键绑定或手动填写凭据、选机器人；保存前可以「测试连接」。
 */

const DOCS_URL = "https://github.com/ChisaAlter/ChisaBot/blob/main/docs/im.md";

export function PlatformIcon({ platform, className }: { platform: ImPlatform; className?: string }) {
  const Icon =
    platform === "qq_official" || platform === "onebot"
      ? IconBrandQq
      : platform === "weixin" || platform === "wecom_bot"
        ? IconBrandWechat
        : platform === "dingtalk"
          ? IconBrandDingtalk
          : platform === "telegram"
            ? IconBrandTelegram
            : IconMessageCircle;
  return (
    <span className={cn("im-ico", `is-${platform}`, className)}>
      <Icon className="size-5" />
    </span>
  );
}

export function ImStatusBadge({ connection }: { connection: Pick<ImConnectionView, "status"> }) {
  const tone =
    connection.status === "connected" ? "is-ok" : connection.status === "error" ? "is-danger" : connection.status === "disabled" ? "is-muted" : "is-warn";
  return (
    <span aria-live="polite" className={cn("device-badge", tone)}>
      <span aria-hidden className={cn("device-dot", connection.status === "connected" && "is-ok")} />
      <T>{IM_STATUS_LABEL[connection.status]}</T>
    </span>
  );
}

/** 平台卡片网格：空状态和「添加连接」第一步都用它。 */
export function PlatformGrid({ onPick }: { onPick: (platform: ImPlatform) => void }) {
  return (
    <div className="im-platforms">
      {IM_PLATFORMS.map((platform) => (
        <button className="im-platform" key={platform.id} onClick={() => onPick(platform.id)} type="button">
          <PlatformIcon platform={platform.id} />
          <span className="min-w-0 flex-1">
            <span className="im-platform-t">
              {platform.name}
              <span className={cn("im-chip", platform.official ? "is-official" : "is-risk")}><T>{platform.official ? "官方" : "非官方"}</T></span>
              {platform.qrAuth ? <span className="im-chip is-official"><T>扫码绑定</T></span> : null}
            </span>
            <span className="im-platform-s">{platform.summary}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ConnectionRow({ connection, botName, onEdit, onLogs }: { connection: ImConnectionView; botName: string | null; onEdit: () => void; onLogs: () => void }) {
  const queryClient = useQueryClient();
  const info = imPlatform(connection.platform);
  const refresh = () => queryClient.invalidateQueries({ queryKey: imKeys.all });
  const [enabled, setEnabled] = useState(connection.enabled);
  useEffect(() => setEnabled(connection.enabled), [connection.enabled]);
  const toggle = useAsyncAction(
    async (next: boolean) => {
      setEnabled(next);
      try {
        await updateImConnection(connection.id, { enabled: next });
      } catch (error) {
        setEnabled(!next);
        throw error;
      }
      await refresh();
    },
    { errorToast: (error) => `${error.message}` },
  );
  const test = useAsyncAction(
    async () => {
      const result = await testImConnection(connection.id);
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
      await refresh();
    },
    { errorToast: (error) => `测试失败：${error.message}` },
  );
  const remove = useAsyncAction(
    async () => {
      await deleteImConnection(connection.id);
      await refresh();
    },
    { errorToast: (error) => `删除失败：${error.message}` },
  );
  const facts = [
    info?.name ?? connection.platform,
    connection.account,
    connection.lastMessageAt ? `最后消息 ${agoText(connection.lastMessageAt)}` : "还没有收到消息",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={cn("im-row", remove.state === "pending" && "is-busy")}>
      <button className="im-row-main" onClick={onEdit} type="button">
        <ListRow
          actions={<ImStatusBadge connection={{ status: enabled ? (connection.enabled ? connection.status : "connecting") : "disabled" }} />}
          icon={<PlatformIcon platform={connection.platform} />}
          sub={
            <>
              <span className="device-row-facts">{facts}</span>
              <span className="device-row-meta">
                <span className="im-bot-chip">
                  <IconRobot aria-hidden className="size-3.5" />
                  {botName ?? "机器人已不在"}
                </span>
                {connection.ownerUsers.length ? (
                  <span className="device-cap-chip"><T>{`主人 ${connection.ownerUsers.length} 人`}</T></span>
                ) : (
                  <span className="device-cap-chip is-ask"><T>{"未绑定主人"}</T></span>
                )}
                {connection.allowUsers.length ? <span className="device-cap-chip"><T>{`白名单 ${connection.allowUsers.length} 人`}</T></span> : null}
                {connection.allowDevices ? <span className="device-cap-chip is-ask"><T>{"可用电脑和设备"}</T></span> : null}
                {connection.allowPrivate ? <span className="device-cap-chip is-ask"><T>{"允许内网地址"}</T></span> : null}
              </span>
              {!connection.ownerUsers.length ? (
                <span className="im-row-warn">
                  {connection.allowUsers.length
                    ? "未绑定主人：白名单里的人能聊天，但没人能在 IM 里审批。在平台里给机器人发 /id 拿到你的 id，编辑连接填到「主人」里。"
                    : "未绑定主人：机器人不会回复任何人。在平台里给机器人发 /id 拿到你的 id，编辑连接填到「主人」里。"}
                </span>
              ) : null}
              {connection.enabled && connection.status === "error" && connection.statusDetail ? (
                <span className="im-row-error">{connection.statusDetail}</span>
              ) : null}
            </>
          }
          title={connection.name}
        />
      </button>
      <Switch
        aria-label={enabled ? `停用「${connection.name}」` : `启用「${connection.name}」`}
        checked={enabled}
        className="im-row-switch"
        disabled={toggle.state === "pending"}
        onCheckedChange={(next) => void toggle.run(next)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger render={<button aria-label={`「${connection.name}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />}>
          <IconDots className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-pop w-[220px] p-1.5">
          <DropdownMenuItem className="glass-mi" onClick={onEdit}>
            <IconPencil className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{"编辑…"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="glass-mi" disabled={test.state === "pending"} onClick={() => void test.run()}>
            <IconPlugConnected className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{test.state === "pending" ? "测试中…" : "测试连接"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="glass-mi" onClick={onLogs}>
            <IconFileText className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{"查看日志…"}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator className="glass-sep" />
          <DropdownMenuItem
            className="glass-mi is-danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `删除「${connection.name}」？`,
                description: "会断开这个平台账号，删掉保存的凭据和日志。机器人在网页上的对话记录会保留。",
                confirmLabel: "删除",
                destructive: true,
              });
              if (ok) void remove.run();
            }}
          >
            <IconTrash className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{"删除…"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 一个平台字段的输入框。密钥字段：已保存时占位写「已保存，留空不改」。 */
function FieldInput({ field, value, saved, onChange }: { field: ImField; value: string; saved: boolean; onChange: (value: string) => void }) {
  const id = `im-field-${field.key}`;
  return (
    <label className="im-field" htmlFor={id}>
      <span className="im-field-l">
        {field.label}
        {field.required ? <span className="im-req">{"必填"}</span> : null}
      </span>
      {field.type === "select" ? (
        <Select onValueChange={(next) => onChange(String(next))} value={value || field.default || field.options?.[0]?.value || ""}>
          <SelectTrigger className="w-full" id={id}>
            <SelectValue>{(current: string) => field.options?.find((option) => option.value === current)?.label ?? current}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.options?.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <Input
          autoComplete="off"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.type === "secret" && saved ? "已保存，留空不改" : field.placeholder ?? field.default ?? ""}
          spellCheck={false}
          type={field.type === "secret" ? "password" : "text"}
          value={value}
        />
      )}
      {field.help ? <span className="im-field-h">{field.help}</span> : null}
    </label>
  );
}

/** 多平台统一扫码授权（微信 / QQ 机器人 / 企业微信智能机器人 / 钉钉 / 飞书）：令牌留在服务器，浏览器只拿一次性键。 */
function PlatformQrLogin({
  platform,
  hint,
  baseUrl,
  domain,
  done,
  account,
  onDone,
}: {
  platform: ImPlatform;
  hint?: string;
  baseUrl?: string;
  domain?: string;
  done: boolean;
  account?: string | null;
  onDone: (loginKey: string, account: string | null, config?: Record<string, string>) => void;
}) {
  const [qr, setQr] = useState<ImQrStartResult | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "wait" | "scanned" | "expired" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const runId = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      runId.current += 1;
    };
  }, []);
  const start = async () => {
    const currentRun = ++runId.current;
    setStatus("loading");
    setError(null);
    try {
      const next = await startImQr({ platform, baseUrl, domain });
      if (!alive.current || runId.current !== currentRun) return;
      setQr(next);
      setStatus("wait");
      for (let round = 0; round < 60 && alive.current && runId.current === currentRun; round++) {
        const result = await pollImQr(next.qrcode);
        if (!alive.current || runId.current !== currentRun) return;
        if (result.status === "confirmed" && result.loginKey) {
          setQr(null);
          setStatus("idle");
          onDone(result.loginKey, result.account ?? null, result.config);
          return;
        }
        if (result.status === "expired") {
          setStatus("expired");
          return;
        }
        setStatus(result.status === "scanned" ? "scanned" : "wait");
      }
      if (alive.current && runId.current === currentRun) setStatus("expired");
    } catch (err) {
      if (!alive.current || runId.current !== currentRun) return;
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  if (done && !qr)
    return (
      <div className="im-wx is-done">
        <IconCheck className="size-5" />
        <span className="flex-1">{account ? `已扫码绑定（${account}）。保存后即可开始对话。` : "已授权。保存后即可开始收发消息。"}</span>
        <Button onClick={() => void start()} size="sm" variant="outline">
          {"重新扫码"}
        </Button>
      </div>
    );
  return (
    <div className="im-wx">
      {qr ? (
        <div className="im-wx-qr">
          {qr.qrKind === "image" && qr.url.startsWith("data:image/") ? (
            <img alt="扫码绑定二维码" className={cn("size-44 rounded-lg bg-white p-2", status === "expired" && "opacity-40")} src={qr.url} />
          ) : (
            <PairQr dim={status === "expired"} value={qr.url} />
          )}
          <span className="im-wx-s">
            {status === "scanned" ? "已扫码，请在手机上确认授权…" : status === "expired" ? "二维码过期了" : hint ?? "用对应手机客户端扫码绑定"}
          </span>
        </div>
      ) : (
        <span className="im-field-h">{hint ?? "支持直接扫码一键创建并绑定机器人凭据"}</span>
      )}
      {error ? <span className="im-row-error">{error}</span> : null}
      {!qr || status === "expired" || status === "error" ? (
        <Button disabled={status === "loading"} onClick={() => void start()} size="sm" type="button">
          {status === "expired" ? <IconRefresh /> : <IconQrcode />}
          {status === "loading" ? "获取二维码…" : status === "expired" ? "换一个二维码" : "扫码绑定"}
        </Button>
      ) : null}
    </div>
  );
}

type FormState = {
  name: string;
  agentId: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  allowUsers: string;
  ownerUsers: string;
  allowDevices: boolean;
  allowPrivate: boolean;
  qrLogin?: string;
  qrAccount?: string | null;
};

function initialForm(info: ImPlatformInfo, connection?: ImConnectionView, defaultBot?: string): FormState {
  const config: Record<string, string> = {};
  for (const field of info.fields) if (field.type !== "secret") config[field.key] = connection?.config[field.key] ?? field.default ?? "";
  return {
    name: connection?.name ?? info.name,
    agentId: connection?.agentId ?? defaultBot ?? "",
    config,
    secrets: {},
    allowUsers: (connection?.allowUsers ?? []).join("\n"),
    ownerUsers: (connection?.ownerUsers ?? []).join("\n"),
    allowDevices: connection?.allowDevices ?? false,
    allowPrivate: connection?.allowPrivate ?? false,
  };
}

/** 添加 / 编辑连接的弹窗。 */
export function ConnectionDialog({
  open,
  onOpenChange,
  connection,
  initialPlatform,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection?: ImConnectionView;
  initialPlatform?: ImPlatform | null;
}) {
  const queryClient = useQueryClient();
  const bots = useQuery({ ...agentListQueryOptions(), enabled: open });
  // 只读缓存里已登录的用户（_authed 进门时就查过）：不引入 auth/queries——它带着
  // login-redirect → md-cache 一整串，曾把设置页块图连出 browser ↔ vendor-markdown 循环（§41.5）。
  const me = useQuery<AuthenticatedUser | null>({ queryKey: authKeys.currentUser(), enabled: false });
  const isAdmin = me.data?.role === "admin";
  const roster = useMemo(() => (bots.data ?? []), [bots.data]);
  const [platform, setPlatform] = useState<ImPlatform | null>(connection?.platform ?? initialPlatform ?? null);
  const info = platform ? imPlatform(platform) : undefined;
  const [form, setForm] = useState<FormState | null>(null);
  const [stepsOpen, setStepsOpen] = useState(!connection);
  const [testResult, setTestResult] = useState<ImTestResult | null>(null);
  const [saved, setSaved] = useState<ImConnectionView | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 机器人列表晚到由下面那个 effect 补默认机器人；这里不依赖 roster，免得列表刷新时覆盖用户正在填的表单
  useEffect(() => {
    if (!open || !info) return;
    setForm(initialForm(info, connection, roster.find((bot) => bot.pinned)?.id ?? roster[0]?.id));
  }, [open, info, connection]);
  useEffect(() => {
    // 机器人列表晚到：新建时补上默认机器人。
    if (form && !form.agentId && roster.length) setForm({ ...form, agentId: roster.find((bot) => bot.pinned)?.id ?? roster[0]!.id });
  }, [roster, form]);

  const input = (): ImConnectionInput | null => {
    if (!form || !platform) return null;
    const secrets = Object.fromEntries(Object.entries(form.secrets).filter(([, value]) => value.trim()));
    return {
      platform,
      name: form.name,
      agentId: form.agentId,
      config: form.config,
      secrets,
      allowUsers: form.allowUsers.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean),
      ownerUsers: form.ownerUsers.split(/[\s,，]+/).map((item) => item.trim()).filter(Boolean),
      allowDevices: form.allowDevices,
      // 只有管理员发的「允许内网地址」服务器才认，非管理员不往请求里放。
      ...(isAdmin ? { allowPrivate: form.allowPrivate } : {}),
      ...(form.qrLogin ? { qrLogin: form.qrLogin, ...(platform === "weixin" ? { weixinLogin: form.qrLogin } : {}) } : {}),
    };
  };

  const save = useAsyncAction(async () => {
    const body = input();
    if (!body) return;
    const result = connection ? await updateImConnection(connection.id, body) : await createImConnection(body);
    await queryClient.invalidateQueries({ queryKey: imKeys.all });
    // 反向连接：保存后要把地址和 token 给协议端，先别关。
    if (result.reversePath && !connection) setSaved(result);
    else setTimeout(() => onOpenChange(false), 600);
  });
  const test = useAsyncAction(
    async () => {
      const body = input();
      if (!body) return;
      setTestResult(null);
      const result = await testImDraft({ ...body, ...(connection ? { id: connection.id } : {}) });
      setTestResult(result);
      // 没通过：按钮显示 ✕「测试失败」，原因在下面的红条里（不另弹提示）。
      if (!result.ok) throw new Error(result.detail);
    },
    { errorToast: false },
  );
  const resetTest = test.reset;
  useEffect(() => {
    if (!open) return;
    setPlatform(connection?.platform ?? initialPlatform ?? null);
    setTestResult(null);
    resetTest();
    setSaved(null);
    setStepsOpen(!connection);
  }, [open, connection, initialPlatform, resetTest]);

  const visible = (field: ImField) => !field.showIf || (form?.config[field.showIf.key] ?? "") === field.showIf.equals;
  const reverse = saved ?? (connection?.reversePath ? connection : null);
  const visibleFields = info ? info.fields.filter(visible) : [];
  const primaryFields = info?.qrAuth ? visibleFields.filter((field) => field.type === "select") : visibleFields;
  const manualFields = info?.qrAuth ? visibleFields.filter((field) => field.type !== "select" && !(platform === "weixin" && field.key === "token")) : [];
  const hasSavedSecrets = Boolean(connection && Object.values(connection.secrets).some(Boolean));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-xl">
        <DialogHeader>
          <DialogTitle>{connection ? `编辑「${connection.name}」` : info ? `接入${info.name}` : "添加 IM 连接"}</DialogTitle>
          <DialogDescription>
            {info ? info.summary : "选一个平台。每个连接把一个平台账号交给你的一个机器人来回复，并与网页端共享该机器人的会话。"}
          </DialogDescription>
        </DialogHeader>
        {!info ? (
          <DialogBody className="mt-2">
            <PlatformGrid onPick={setPlatform} />
          </DialogBody>
        ) : form ? (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (save.state !== "pending" && !saved) void save.run();
            }}
          >
            <DialogBody className="im-form mt-2">
              {info.risk ? (
                <div className={cn("im-note", !info.official && "is-risk")}>
                  <IconAlertTriangle className="size-4 shrink-0" />
                  <span>{info.risk}</span>
                </div>
              ) : null}
              <div className="im-steps">
                <button aria-expanded={stepsOpen} className="im-steps-h" onClick={() => setStepsOpen(!stepsOpen)} type="button">
                  <span className="flex-1">{"怎么获取这些信息"}</span>
                  <IconChevronDown className={cn("size-4 transition-transform", stepsOpen && "rotate-180")} />
                </button>
                {stepsOpen ? (
                  <ol>
                    {info.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                    <li className="is-link">
                      <a href={`${DOCS_URL}#${info.docAnchor}`} rel="noreferrer" target="_blank">
                        {"完整说明（docs/im.md）"}
                      </a>
                    </li>
                  </ol>
                ) : null}
              </div>
              <div className="im-grid">
                <label className="im-field" htmlFor="im-name">
                  <span className="im-field-l">{"名称"}</span>
                  <Input id="im-name" maxLength={40} onChange={(event) => setForm({ ...form, name: event.target.value })} value={form.name} />
                </label>
                <label className="im-field" htmlFor="im-bot">
                  <span className="im-field-l">
                    {"绑定机器人（与网页端共享对话）"}
                    <span className="im-req">{"必填"}</span>
                  </span>
                  <Select onValueChange={(next) => setForm({ ...form, agentId: String(next) })} value={form.agentId}>
                    <SelectTrigger className="w-full" id="im-bot">
                      <SelectValue>{(current: string) => roster.find((bot) => bot.id === current)?.name ?? (bots.isPending ? "加载中…" : "选择机器人")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {roster.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
                {primaryFields.map((field) => (
                  <FieldInput
                    field={field}
                    key={field.key}
                    onChange={(value) =>
                      field.type === "secret"
                        ? setForm({ ...form, secrets: { ...form.secrets, [field.key]: value } })
                        : setForm({ ...form, config: { ...form.config, [field.key]: value } })
                    }
                    saved={Boolean(connection?.secrets[field.key])}
                    value={field.type === "secret" ? form.secrets[field.key] ?? "" : form.config[field.key] ?? ""}
                  />
                ))}
              </div>
              {info.qrAuth && platform ? (
                <PlatformQrLogin
                  account={form.qrAccount ?? connection?.account}
                  baseUrl={form.config.baseUrl}
                  domain={form.config.domain}
                  done={Boolean(form.qrLogin || hasSavedSecrets)}
                  hint={info.qrHint}
                  onDone={(loginKey, account, nextConfig) =>
                    setForm({
                      ...form,
                      qrLogin: loginKey,
                      qrAccount: account,
                      config: nextConfig ? { ...form.config, ...nextConfig } : form.config,
                    })
                  }
                  platform={platform}
                />
              ) : null}
              {manualFields.length > 0 ? (
                <details className="im-adv">
                  <summary>{"手动填写凭据（已有应用时可选）"}</summary>
                  <div className="im-grid">
                    {manualFields.map((field) => (
                      <FieldInput
                        field={{ ...field, required: false }}
                        key={field.key}
                        onChange={(value) =>
                          field.type === "secret"
                            ? setForm({ ...form, secrets: { ...form.secrets, [field.key]: value } })
                            : setForm({ ...form, config: { ...form.config, [field.key]: value } })
                        }
                        saved={Boolean(connection?.secrets[field.key])}
                        value={field.type === "secret" ? form.secrets[field.key] ?? "" : form.config[field.key] ?? ""}
                      />
                    ))}
                  </div>
                </details>
              ) : null}
              {reverse?.reversePath ? (
                <div className="im-reverse">
                  <div className="im-field-l">{"在协议端新建「WebSocket 客户端」，填："}</div>
                  <div className="im-reverse-row">
                    <span>{"地址"}</span>
                    <code className="device-code">{`${location.origin.replace(/^http/, "ws")}${reverse.reversePath}`}</code>
                    <CopyButton size="sm" value={`${location.origin.replace(/^http/, "ws")}${reverse.reversePath}`} />
                  </div>
                  <div className="im-reverse-row">
                    <span>{"Token"}</span>
                    <code className="device-code">{reverse.reverseToken ?? ""}</code>
                    <CopyButton size="sm" value={reverse.reverseToken ?? ""} />
                  </div>
                </div>
              ) : null}
              <details className="im-adv">
                <summary>{"谁能用 · 权限"}</summary>
                <label className="im-field" htmlFor="im-owner">
                  <span className="im-field-l">{"主人的平台用户 id（一行一个）"}</span>
                  <Textarea id="im-owner" onChange={(event) => setForm({ ...form, ownerUsers: event.target.value })} placeholder={"在平台里给机器人发 /id 可以看到自己的 id"} rows={2} value={form.ownerUsers} />
                  <span className="im-field-h">{"主人本人的平台账号：能聊天，也是唯一能在私聊里回复「允许 / 拒绝」审批待确认操作的人。"}</span>
                </label>
                <label className="im-field" htmlFor="im-allow">
                  <span className="im-field-l">{"白名单（平台用户 id，一行一个；除主人外还能聊天的人）"}</span>
                  <Textarea id="im-allow" onChange={(event) => setForm({ ...form, allowUsers: event.target.value })} placeholder={"在平台里给机器人发 /id 可以看到自己的 id"} rows={3} value={form.allowUsers} />
                  <span className="im-field-h">{"白名单里的人可以聊天，但不能在 IM 里审批。主人和白名单都不填 = 机器人不理任何人（不是所有人可用）。"}</span>
                </label>
                <div className="im-switch-row">
                  <div className="min-w-0 flex-1">
                    <div className="im-field-l">{"允许使用电脑和设备"}</div>
                    <div className="im-field-h">
                      {"打开后，在这里和机器人聊天的人也能让它操作云端浏览器和你关联的设备（仍按设备的「询问」规则）。机器人以你的身份运行，请确认名单里都是信得过的人。"}
                    </div>
                  </div>
                  <Switch aria-label="允许使用电脑和设备" checked={form.allowDevices} onCheckedChange={(next) => setForm({ ...form, allowDevices: next })} />
                </div>
                {isAdmin ? (
                  <div className="im-switch-row">
                    <div className="min-w-0 flex-1">
                      <div className="im-field-l">{"允许内网地址（仅管理员可改）"}</div>
                      <div className="im-field-h">
                        {"打开后，这个连接里管理员配置的协议端地址可以指向本机 / 内网 / Docker 容器（例如 NapCat 就在同一台机器上），云元数据地址照样拦截；用户和模型给的网址永远不放行。协议端在内网又开不了这个开关时，请用反向 WebSocket。"}
                      </div>
                    </div>
                    <Switch aria-label="允许内网地址" checked={form.allowPrivate} onCheckedChange={(next) => setForm({ ...form, allowPrivate: next })} />
                  </div>
                ) : null}
              </details>
              <p className="im-field-h">{`群聊：${info.groupNote} 在平台里发 /new 开始新话题，/id 查看自己的 id。`}</p>
              {testResult ? (
                <div className={cn("im-test", testResult.ok ? "is-ok" : "is-bad")} role="status">
                  {testResult.ok ? <IconCheck className="size-4 shrink-0" /> : <IconAlertTriangle className="size-4 shrink-0" />}
                  <span>{testResult.detail}</span>
                </div>
              ) : null}
            </DialogBody>
            <DialogFooter className="mt-4">
              {!connection && !saved ? (
                <Button className="mr-auto" onClick={() => setPlatform(null)} type="button" variant="ghost">
                  {"换平台"}
                </Button>
              ) : null}
              <Button feedback={{ pending: "测试中…", success: "已测试", error: "测试失败" }} onClick={() => void test.run()} state={test.state} type="button" variant="outline">
                {"测试连接"}
              </Button>
              {saved ? (
                <Button onClick={() => onOpenChange(false)} type="button">
                  {"完成"}
                </Button>
              ) : (
                <Button disabled={!form.agentId} feedback="save" state={save.state} type="submit">
                  {connection ? "保存" : "保存并连接"}
                </Button>
              )}
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function LogsDialog({ connection, open, onOpenChange }: { connection: ImConnectionView | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const logs = useQuery({ ...imLogsQueryOptions(connection?.id ?? ""), enabled: open && Boolean(connection) });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{connection ? `「${connection.name}」的日志` : "日志"}</DialogTitle>
          <DialogDescription>{"最近 100 条：连接、收发消息和出错原因。消息只记前 80 个字。"}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-2">
          {logs.isPending ? (
            <div className="im-logs is-empty">{"加载中…"}</div>
          ) : logs.isError ? (
            <div className="im-logs is-empty">{logs.error.message}</div>
          ) : logs.data.length ? (
            <ol className="im-logs">
              {logs.data.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表：只追加、不重排、没有稳定 id
                <li className={cn("im-log", `is-${entry.level}`)} key={`${entry.at}-${index}`}>
                  <time dateTime={entry.at}>{new Date(entry.at).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <span>{entry.text}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="im-logs is-empty">{"还没有日志"}</div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectionList({ connections, onEdit, onLogs }: { connections: ImConnectionView[]; onEdit: (connection: ImConnectionView) => void; onLogs: (connection: ImConnectionView) => void }) {
  const bots = useQuery(agentListQueryOptions());
  const names = new Map((bots.data ?? []).map((bot) => [bot.id, bot.name]));
  return (
    <Card>
      {connections.map((connection) => (
        <ConnectionRow
          botName={bots.isPending ? "…" : names.get(connection.agentId) ?? null}
          connection={connection}
          key={connection.id}
          onEdit={() => onEdit(connection)}
          onLogs={() => onLogs(connection)}
        />
      ))}
    </Card>
  );
}
