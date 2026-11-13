import {
  IconBellRinging,
  IconBolt,
  IconCalendarEvent,
  IconCopy,
  IconMail,
  IconMessageReply,
  IconPlugConnectedX,
  IconRefresh,
  IconSparkles,
  IconSun,
} from "@tabler/icons-react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { sendPromptToChat } from "@/lib/chat/quote-event";
import {
  type EmailConnectionInput,
  type EmailConnectionView,
  IMAP_PRESETS,
  type PersonalSourcesStatusView,
  SMTP_PRESETS,
} from "../../../../shared/personal-sources";

const LazyBotBubbles = lazy(() =>
  import("@/components/chat/bot-bubbles").then((m) => ({
    default: m.BotBubbles,
  })),
);

import {
  useAsyncAction,
  useMutationFeedback,
} from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmDialog } from "@/components/ui/confirm";
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
import { Card, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { agoText } from "@/lib/im";
import {
  connectCalendarMutationOptions,
  connectEmailMutationOptions,
  bindNotifyWebhookMutationOptions,
  disconnectCalendarMutationOptions,
  disconnectEmailMutationOptions,
  disconnectNotifyWebhookMutationOptions,
  generateMorningBrief,
  rotateInboundTokenMutationOptions,
  runCheckUpdates,
  saveWeatherCity,
  sendTestNotification,
  simulateInboundEvent,
} from "@/lib/personal-sources/mutations";
import {
  personalSourcesKeys,
  personalSourcesStatusQueryOptions,
} from "@/lib/personal-sources/queries";

export { personalSourcesKeys };

export function PersonalSourcesSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery(personalSourcesStatusQueryOptions());

  const [calOpen, setCalOpen] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [briefMarkdown, setBriefMarkdown] = useState<string | null>(null);
  const [briefModalTitle, setBriefModalTitle] = useState("每日晨报卡片预览");
  const [cityInput, setCityInput] = useState("");

  useEffect(() => {
    if (status.data?.weatherCity) {
      setCityInput(status.data.weatherCity);
    }
  }, [status.data?.weatherCity]);

  useEffect(() => {
    if (!briefMarkdown) return;
    const onQuote = () => setBriefMarkdown(null);
    window.addEventListener("chisabot-quote", onQuote);
    return () => window.removeEventListener("chisabot-quote", onQuote);
  }, [briefMarkdown]);

  const generateBrief = useAsyncAction(
    async () => {
      const city = cityInput.trim() || status.data?.weatherCity || "上海";
      if (city !== status.data?.weatherCity) {
        await saveWeatherCity(city);
        await queryClient.invalidateQueries({
          queryKey: personalSourcesKeys.all,
        });
      }
      const markdown = await generateMorningBrief(city);
      setBriefModalTitle("每日晨报卡片预览");
      setBriefMarkdown(markdown);
    },
    { errorToast: (err) => err.message },
  );

  const checkUpdates = useAsyncAction(
    async () => {
      const markdown = await runCheckUpdates();
      setBriefModalTitle("⚡ 个人助理主动巡检动态");
      setBriefMarkdown(markdown);
      await queryClient.invalidateQueries({
        queryKey: personalSourcesKeys.all,
      });
    },
    { errorToast: (err) => err.message },
  );

  const simulateInboundWebhook = useAsyncAction(
    async () => {
      const path = status.data?.inboundWebhook?.path;
      if (!path) throw new Error("入站 Webhook 地址尚未就绪");
      await simulateInboundEvent(path);
      await queryClient.invalidateQueries({
        queryKey: personalSourcesKeys.all,
      });
      toast.success("已触发模拟入站事件！可点「⚡ 巡检动态」查看捕获结果");
    },
    { errorToast: (err) => err.message },
  );

  const rotateInboundTokenMutation = useMutation(
    rotateInboundTokenMutationOptions(queryClient),
  );
  const rotateInboundToken = useAsyncAction(
    async () => {
      await rotateInboundTokenMutation.mutateAsync();
      toast.success("已生成新的入站 Webhook 密钥");
    },
    { errorToast: (err) => err.message },
  );

  const disconnectCalendarMutation = useMutation(
    disconnectCalendarMutationOptions(queryClient),
  );
  const disconnectCalendarAction = useAsyncAction(
    async () => {
      await disconnectCalendarMutation.mutateAsync();
      toast.success("已断开日历");
    },
    { errorToast: (err) => `断开日历失败：${err.message}` },
  );
  const disconnectEmailMutation = useMutation(
    disconnectEmailMutationOptions(queryClient),
  );
  const disconnectEmailAction = useAsyncAction(
    async () => {
      await disconnectEmailMutation.mutateAsync();
      toast.success("已断开收件箱");
    },
    { errorToast: (err) => `断开收件箱失败：${err.message}` },
  );
  const disconnectNotifyMutation = useMutation(
    disconnectNotifyWebhookMutationOptions(queryClient),
  );
  const disconnectNotifyAction = useAsyncAction(
    async () => {
      await disconnectNotifyMutation.mutateAsync();
      toast.success("已断开随身通知推送");
    },
    { errorToast: (err) => `断开通知推送失败：${err.message}` },
  );

  async function disconnectCalendar() {
    const ok = await confirmDialog({
      title: "断开日历？",
      description:
        "将从服务器移除你的 ICS 日历订阅地址，机器人不再读取你的日程。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    await disconnectCalendarAction.run();
  }

  async function disconnectEmail() {
    const ok = await confirmDialog({
      title: "断开收件箱？",
      description:
        "将从服务器永久删除加密保存的邮箱专用密码，机器人不再读取你的收件箱。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    await disconnectEmailAction.run();
  }

  async function disconnectNotifyWebhook() {
    const ok = await confirmDialog({
      title: "断开随身通知推送？",
      description: "将移除已绑定的通知 Webhook 地址。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    await disconnectNotifyAction.run();
  }

  const testNotify = useAsyncAction(
    async () => {
      try {
        await sendTestNotification(crypto.randomUUID());
      } finally {
        await queryClient.invalidateQueries({
          queryKey: personalSourcesKeys.all,
        });
      }
      toast.success("通知平台已接受测试通知");
    },
    { errorToast: (err) => err.message },
  );

  const cal = status.data?.calendar ?? null;
  const mail = status.data?.email ?? null;
  const notifyWh = status.data?.notifyWebhook ?? null;
  const inboundWh = status.data?.inboundWebhook ?? null;

  return (
    <PageSection
      description="连接只读日历（ICS/WebCal）、邮件头摘要与 SMTP 发信、随身通知推送，以及每日晨报。"
      settingItem="connected-accounts.personal-calendar connected-accounts.personal-email connected-accounts.notify-webhook connected-accounts.morning-brief"
      title="日程、收件箱、通知推送与每日晨报"
    >
      <CalendarConnectDialog
        onOpenChange={setCalOpen}
        onSaved={(next) =>
          queryClient.setQueryData(personalSourcesKeys.all, next)
        }
        open={calOpen}
      />
      <EmailConnectDialog
        key={mail?.connectedAt ?? "new-email"}
        connection={mail}
        onOpenChange={setMailOpen}
        onSaved={(next) =>
          queryClient.setQueryData(personalSourcesKeys.all, next)
        }
        open={mailOpen}
      />
      <NotifyWebhookDialog
        onOpenChange={setNotifyOpen}
        onSaved={(next) =>
          queryClient.setQueryData(personalSourcesKeys.all, next)
        }
        open={notifyOpen}
      />
      <Dialog
        onOpenChange={(open) => {
          if (!open) setBriefMarkdown(null);
        }}
        open={Boolean(briefMarkdown)}
      >
        <DialogContent
          className="im-dialog max-w-2xl"
          data-testid="morning-brief-preview-dialog"
        >
          <DialogHeader>
            <DialogTitle>{briefModalTitle}</DialogTitle>
            <DialogDescription>
              {
                "在聊天中对机器人说「早安」或「巡检今日动态」，机器人也会自动调用对应工具生成这张结构化卡片。"
              }
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-2">
            {briefMarkdown ? (
              <Suspense
                fallback={
                  <div className="text-sm text-muted-foreground">
                    {briefMarkdown}
                  </div>
                }
              >
                <LazyBotBubbles text={briefMarkdown} />
              </Suspense>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4 sm:justify-between">
            <Button
              data-testid="brief-dialog-send-chat-btn"
              onClick={() => {
                setBriefMarkdown(null);
                sendPromptToChat(
                  navigate,
                  "请根据刚才的晨报与动态巡检结果，帮我梳理今天最优先的 3 项行动计划",
                  briefModalTitle,
                );
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconMessageReply className="size-3.5" />
              {"带入聊天继续追问"}
            </Button>
            <Button
              onClick={() => setBriefMarkdown(null)}
              type="button"
              variant="outline"
            >
              {"关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {status.isPending ? (
        <PageSkeleton rows={2} />
      ) : status.isError ? (
        <p role="alert" className="text-sm text-destructive">
          连接状态读取失败。
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void status.refetch()}
          >
            重新读取
          </Button>
        </p>
      ) : (
        <div
          className="flex flex-col gap-3"
          data-testid="personal-sources-section"
        >
          {/* 日历只读接入 */}
          <Card className="mem-card" data-testid="personal-calendar-card">
            <div className="im-row flex-wrap">
              <div className="im-row-main is-static max-sm:!basis-full">
                <ListRow
                  icon={
                    <span className="gh-mark">
                      <IconCalendarEvent className="size-5" />
                    </span>
                  }
                  sub={
                    cal ? (
                      <>
                        <span className="device-row-meta">
                          <span className="gh-state is-ok">
                            {"已连接（只读）"}
                          </span>
                          <span className="device-cap-chip">
                            <T>{`${cal.eventCount} 个日程事件`}</T>
                          </span>
                          <span className="device-cap-chip">
                            <T>{cal.urlHint}</T>
                          </span>
                        </span>
                        <span className="mem-by">{`${agoText(cal.checkedAt)}同步 · ${cal.timeZone || "Asia/Shanghai"} · 聊天与晨报共用`}</span>
                      </>
                    ) : (
                      "未连接 · 支持 Apple iCloud / Google / Outlook / 飞书日历的 ICS 订阅链接或直接粘贴 ICS"
                    )
                  }
                  title={cal ? cal.label : "个人日历（ICS / WebCal 只读）"}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  data-testid="connect-calendar-btn"
                  disabled={disconnectCalendarAction.state === "pending"}
                  onClick={() => setCalOpen(true)}
                  size="sm"
                  variant={cal ? "outline" : "default"}
                >
                  {cal ? "更换日历" : "连接日历"}
                </Button>
                {cal ? (
                  <Button
                    aria-label="断开日历"
                    className="w-10 rounded-full"
                    feedback={{
                      pending: "断开中…",
                      success: "已断开",
                      error: "断开失败",
                    }}
                    onClick={() => void disconnectCalendar()}
                    size="icon"
                    state={disconnectCalendarAction.state}
                    variant="ghost"
                  >
                    <IconPlugConnectedX className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          {/* 邮箱 IMAP 收信 + SMTP 审批发信 */}
          <Card className="mem-card" data-testid="personal-email-card">
            <div className="im-row flex-wrap">
              <div className="im-row-main is-static max-sm:!basis-full">
                <ListRow
                  icon={
                    <span className="gh-mark">
                      <IconMail className="size-5" />
                    </span>
                  }
                  sub={
                    mail ? (
                      <>
                        <span className="device-row-meta">
                          <span className="gh-state is-ok">
                            {"收件箱已验证"}
                          </span>
                          <span className="device-cap-chip">
                            <T>{`未读 ${mail.unreadCount} 封`}</T>
                          </span>
                          <span className="device-cap-chip">
                            <T>{`${mail.imapHost}:${mail.imapPort}`}</T>
                          </span>
                          <span
                            className={
                              mail.smtpCheckedAt
                                ? "gh-state is-ok"
                                : "device-cap-chip"
                            }
                          >
                            {mail.smtpCheckedAt
                              ? "SMTP 连接已验证"
                              : "SMTP 连接未验证"}
                          </span>
                        </span>
                        <span className="mem-by">{`${agoText(mail.checkedAt)}检查过 · 读取标题、发件人与时间；发信按审批偏好确认`}</span>
                        {mail.smtpCheckedAt ? (
                          <span className="mem-by">{`发信：${mail.smtpHost}:${mail.smtpPort}`}</span>
                        ) : null}
                      </>
                    ) : (
                      "未连接 · 用应用专用密码连接 QQ / 163 / Gmail / Outlook / iCloud（支持收件箱摘要与确认后发信）"
                    )
                  }
                  title={
                    mail
                      ? mail.email
                      : "电子邮箱（IMAP 收件箱 + SMTP 确认发信）"
                  }
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  data-testid="connect-email-btn"
                  disabled={disconnectEmailAction.state === "pending"}
                  onClick={() => setMailOpen(true)}
                  size="sm"
                  variant={mail ? "outline" : "default"}
                >
                  {mail ? "配置邮箱" : "连接邮箱"}
                </Button>
                {mail ? (
                  <Button
                    aria-label="断开收件箱"
                    className="w-10 rounded-full"
                    feedback={{
                      pending: "断开中…",
                      success: "已断开",
                      error: "断开失败",
                    }}
                    onClick={() => void disconnectEmail()}
                    size="icon"
                    state={disconnectEmailAction.state}
                    variant="ghost"
                  >
                    <IconPlugConnectedX className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          {/* 随身通知推送 & 外部事件入站 Webhook */}
          <Card className="mem-card" data-testid="personal-webhook-card">
            <div className="im-row flex-wrap gap-3">
              <div className="im-row-main is-static max-sm:!basis-full">
                <ListRow
                  icon={
                    <span className="gh-mark">
                      <IconBellRinging className="size-5" />
                    </span>
                  }
                  sub={
                    <>
                      {notifyWh ? (
                        <span className="device-row-meta">
                          <span className="gh-state is-ok">{`已绑定推送 · ${notifyWh.label}`}</span>
                          <span className="device-cap-chip">
                            <T>{notifyWh.urlHint}</T>
                          </span>
                        </span>
                      ) : (
                        <span className="mem-body">
                          {
                            "支持飞书 / 钉钉 / 企业微信群机器人、Bark (iOS)、Server酱或自定义 Webhook，让机器人随时向你推送提醒。"
                          }
                        </span>
                      )}
                      {inboundWh ? (
                        <span className="mem-by">
                          {inboundWh.lastSummary
                            ? `最近入站事件：${inboundWh.lastSummary}`
                            : "入站地址含私密密钥，可通过右侧按钮复制。"}
                        </span>
                      ) : null}
                    </>
                  }
                  title={
                    notifyWh
                      ? notifyWh.label
                      : "随身通知推送 & 外部 Webhook 触发器"
                  }
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {inboundWh ? (
                  <>
                    <Button
                      data-testid="copy-inbound-webhook-btn"
                      onClick={() => {
                        const fullUrl = `${window.location.origin}${inboundWh.path}`;
                        void navigator.clipboard?.writeText(fullUrl);
                        toast.success("已复制入站 Webhook 完整地址");
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      <IconCopy className="mr-1 size-3.5" />
                      {"复制入站地址"}
                    </Button>
                    <Button
                      data-testid="test-inbound-webhook-btn"
                      feedback={{
                        pending: "触发中…",
                        success: "已触发",
                        error: "失败",
                      }}
                      onClick={() => void simulateInboundWebhook.run()}
                      size="sm"
                      state={simulateInboundWebhook.state}
                      title="发送一条模拟外部事件到入站 Webhook"
                      variant="ghost"
                    >
                      <IconBolt className="mr-1 size-3.5 text-amber-500" />
                      {"模拟入站事件"}
                    </Button>
                    <Button
                      aria-label="重置入站 Webhook 密钥"
                      data-testid="rotate-inbound-webhook-btn"
                      onClick={() => void rotateInboundToken.run()}
                      size="sm"
                      title="重置入站 Webhook 密钥"
                      variant="ghost"
                    >
                      <IconRefresh className="size-3.5" />
                    </Button>
                  </>
                ) : null}
                {notifyWh ? (
                  <Button
                    data-testid="test-notify-webhook-btn"
                    disabled={disconnectNotifyAction.state === "pending"}
                    feedback={{
                      pending: "推送中…",
                      success: "已推送",
                      error: "失败",
                    }}
                    onClick={() => void testNotify.run()}
                    size="sm"
                    state={testNotify.state}
                    variant="outline"
                  >
                    {"测试推送"}
                  </Button>
                ) : null}
                <Button
                  data-testid="connect-notify-webhook-btn"
                  disabled={disconnectNotifyAction.state === "pending"}
                  onClick={() => setNotifyOpen(true)}
                  size="sm"
                  variant={notifyWh ? "outline" : "default"}
                >
                  {notifyWh ? "更换推送" : "绑定通知推送"}
                </Button>
                {notifyWh ? (
                  <Button
                    aria-label="断开通知推送"
                    className="w-10 rounded-full"
                    feedback={{
                      pending: "断开中…",
                      success: "已断开",
                      error: "断开失败",
                    }}
                    onClick={() => void disconnectNotifyWebhook()}
                    size="icon"
                    state={disconnectNotifyAction.state}
                    variant="ghost"
                  >
                    <IconPlugConnectedX className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          <section
            className="px-1 py-2"
            aria-label="最近发送记录"
            data-testid="personal-deliveries"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">最近发送记录</h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void status.refetch()}
              >
                刷新记录
              </Button>
            </div>
            {status.data?.deliveries?.length ? (
              <ul className="divide-y divide-border/60">
                {status.data.deliveries.map((item) => (
                  <li className="py-3 text-sm" key={item.id}>
                    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                      <span className="min-w-0 break-words font-medium">
                        {item.title}
                      </span>
                      <span
                        className={
                          item.state === "outcome_unknown" ||
                          item.state === "failed"
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }
                      >
                        {
                          {
                            queued: "等待发送",
                            sending: "正在发送",
                            sent: "平台已接受",
                            failed: "发送失败",
                            outcome_unknown: "结果待核对",
                            cancelled: "已取消",
                          }[item.state]
                        }
                      </span>
                    </div>
                    <p className="mt-1 break-words text-muted-foreground">
                      {item.target} · {agoText(item.createdAt)}
                    </p>
                    {item.error ? (
                      <p className="mt-1 break-words text-muted-foreground">
                        {item.error}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                还没有邮件或通知发送记录。
              </p>
            )}
          </section>
          {/* 每日晨报（Morning Brief）生成与城市设置 */}
          <Card className="mem-card" data-testid="morning-brief-config-card">
            <div className="im-row flex-wrap gap-3">
              <div className="im-row-main is-static max-sm:!basis-full">
                <ListRow
                  icon={
                    <span className="gh-mark">
                      <IconSun className="size-5" />
                    </span>
                  }
                  sub="汇总实时天气、今日日历安排、重要未读邮件、定时任务与近期记忆，生成可交互的「每日晨报卡片」或「主动巡检动态」。"
                  title="每日晨报卡片 & 主动动态巡检（Morning Brief）"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="晨报天气城市"
                  className="h-8 w-28 text-xs"
                  data-testid="morning-brief-city-input"
                  onChange={(e) => setCityInput(e.target.value)}
                  placeholder="城市（如 上海）"
                  value={cityInput}
                />
                <Button
                  data-testid="personal-check-updates-btn"
                  feedback={{
                    pending: "巡检中…",
                    success: "已巡检",
                    error: "失败",
                  }}
                  onClick={() => void checkUpdates.run()}
                  size="sm"
                  state={checkUpdates.state}
                  variant="outline"
                >
                  <IconBolt className="size-3.5 text-amber-500" />
                  {"巡检动态"}
                </Button>
                <Button
                  data-testid="generate-morning-brief-btn"
                  feedback={{
                    pending: "生成中…",
                    success: "已生成",
                    error: "失败",
                  }}
                  onClick={() => void generateBrief.run()}
                  size="sm"
                  state={generateBrief.state}
                >
                  <IconSparkles className="mr-1 size-3.5" />
                  {"预览今日晨报"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </PageSection>
  );
}

function CalendarConnectDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: PersonalSourcesStatusView) => void;
}) {
  const [label, setLabel] = useState("我的日程");
  const [icsUrl, setIcsUrl] = useState("");
  const [icsText, setIcsText] = useState("");
  const [timeZone, setTimeZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
  );

  const queryClient = useQueryClient();
  const save = useMutation(connectCalendarMutationOptions(queryClient));
  const saveState = useMutationFeedback(save);
  const submit = () => {
    save.mutate(
      {
        label: label.trim() || "我的日历",
        icsUrl: icsUrl.trim() || undefined,
        icsText: icsText.trim() || undefined,
        timeZone,
      },
      {
        onSuccess: (data) => {
          onSaved(data);
          toast.success("日历已连接");
          onOpenChange(false);
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const valid = Boolean(
    icsUrl.trim() || icsText.trim().includes("BEGIN:VCALENDAR"),
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="im-dialog max-w-lg"
        data-testid="calendar-connect-dialog"
      >
        <DialogHeader>
          <DialogTitle>{"连接个人日历（ICS 只读）"}</DialogTitle>
          <DialogDescription>
            {
              "粘贴 iCloud / Google / Outlook / 飞书日历的私密 ICS/WebCal 订阅链接，或直接粘贴 .ics 日历内容。"
            }
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && saveState !== "pending") submit();
          }}
        >
          <DialogBody className="im-form mt-2 flex flex-col gap-3">
            <label className="im-field">
              <span className="gh-step-t">{"日历名称"}</span>
              <Input
                data-testid="calendar-label-input"
                onChange={(e) => setLabel(e.target.value)}
                placeholder="工作与个人日程"
                value={label}
              />
            </label>
            <label className="im-field">
              <span className="gh-step-t">{"ICS / WebCal 订阅地址"}</span>
              <Input
                className="font-mono text-xs"
                data-testid="calendar-url-input"
                onChange={(e) => setIcsUrl(e.target.value)}
                placeholder="https://calendar.google.com/calendar/ical/.../basic.ics 或 webcal://..."
                value={icsUrl}
              />
            </label>
            <label className="im-field">
              <span className="gh-step-t">
                日历时区（无时区日程采用此设置）
              </span>
              <Input
                data-testid="calendar-timezone-input"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                placeholder="Asia/Shanghai"
              />
            </label>
            <div className="im-field">
              <div className="flex items-center justify-between">
                <span className="gh-step-t">{"或直接粘贴 ICS 日历内容"}</span>
              </div>
              <textarea
                className="min-h-[110px] w-full rounded-lg border border-border/70 bg-background/60 p-2.5 font-mono text-xs outline-none focus:border-primary"
                data-testid="calendar-ics-textarea"
                onChange={(e) => setIcsText(e.target.value)}
                placeholder="BEGIN:VCALENDAR..."
                value={icsText}
              />
            </div>
          </DialogBody>
          <DialogFooter className="mt-3">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              data-testid="calendar-save-btn"
              disabled={!valid}
              feedback={{
                pending: "验证中…",
                success: "已连接",
                error: "失败",
              }}
              state={saveState}
              type="submit"
            >
              {"保存并连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EmailConnectDialog({
  open,
  onOpenChange,
  onSaved,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: PersonalSourcesStatusView) => void;
  connection: EmailConnectionView | null;
}) {
  const [email, setEmail] = useState(connection?.email ?? "");
  const [imapHost, setImapHost] = useState(connection?.imapHost ?? "");
  const [imapPort, setImapPort] = useState(String(connection?.imapPort ?? 993));
  const [password, setPassword] = useState("");
  const [configureSmtp, setConfigureSmtp] = useState(
    Boolean(connection?.smtpCheckedAt),
  );
  const [smtpHost, setSmtpHost] = useState(connection?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(connection?.smtpPort ?? 465));
  const [smtpUser, setSmtpUser] = useState(connection?.smtpUser ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");

  useEffect(() => {
    if (!open) {
      setPassword("");
      setSmtpPassword("");
    }
  }, [open]);

  function setSmtpPreset(domain: string) {
    const preset = SMTP_PRESETS[domain];
    setSmtpHost(preset?.host ?? "");
    setSmtpPort(String(preset?.port ?? 465));
  }

  function handleEmailChange(val: string) {
    setEmail(val);
    const domain = val.split("@")[1]?.toLowerCase()?.trim();
    if (domain && IMAP_PRESETS[domain]) {
      setImapHost(IMAP_PRESETS[domain].host);
      setImapPort(String(IMAP_PRESETS[domain].port));
    }
    if (domain) setSmtpPreset(domain);
  }

  const queryClient = useQueryClient();
  const save = useMutation(connectEmailMutationOptions(queryClient));
  const saveState = useMutationFeedback(save);
  const submit = () => {
    save.mutate(
      {
        email: email.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort) || 993,
        password: password.trim(),
        ...(configureSmtp
          ? {
              smtp: {
                host: smtpHost.trim(),
                port: Number(smtpPort),
                ...(smtpUser.trim() ? { user: smtpUser.trim() } : {}),
                ...(smtpPassword ? { password: smtpPassword } : {}),
              },
            }
          : {}),
      } satisfies EmailConnectionInput,
      {
        onSuccess: (data) => {
          onSaved(data);
          setPassword("");
          setSmtpPassword("");
          toast.success(
            configureSmtp ? "收信与发信连接已验证" : "邮箱收件箱已连接",
          );
          onOpenChange(false);
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const valid =
    email.includes("@") &&
    password.trim().length >= 4 &&
    imapHost.trim().length > 0 &&
    (!configureSmtp || smtpHost.trim().length > 0);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="im-dialog max-w-lg"
        data-testid="email-connect-dialog"
      >
        <DialogHeader>
          <DialogTitle>{"连接电子邮箱"}</DialogTitle>
          <DialogDescription>
            {
              "使用邮箱后台的应用专用密码或客户端授权码，密码会加密保存。收件箱读取邮件标题、发件人和时间，不读取正文或附件。"
            }
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && saveState !== "pending") submit();
          }}
        >
          <DialogBody className="im-form mt-2 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { key: "qq", label: "QQ 邮箱", domain: "qq.com" },
                  { key: "163", label: "163 邮箱", domain: "163.com" },
                  { key: "gmail", label: "Gmail", domain: "gmail.com" },
                  { key: "outlook", label: "Outlook", domain: "outlook.com" },
                  { key: "icloud", label: "iCloud", domain: "icloud.com" },
                ].map((preset) => (
                  <button
                    className="rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    data-testid={`email-preset-${preset.key}`}
                    key={preset.key}
                    onClick={() => {
                      const info = IMAP_PRESETS[preset.domain];
                      if (info) {
                        setImapHost(info.host);
                        setImapPort(String(info.port));
                        setSmtpPreset(preset.domain);
                        if (!email.includes("@")) {
                          setEmail(`user@${preset.domain}`);
                        }
                      }
                    }}
                    type="button"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="im-field">
              <span className="gh-step-t">{"邮箱地址"}</span>
              <Input
                data-testid="email-address-input"
                onChange={(e) => handleEmailChange(e.target.value)}
                placeholder="you@qq.com / you@gmail.com"
                value={email}
              />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="im-field col-span-2">
                <span className="gh-step-t">{"IMAP 服务器 (SSL)"}</span>
                <Input
                  className="font-mono text-xs"
                  data-testid="email-host-input"
                  onChange={(e) => setImapHost(e.target.value)}
                  placeholder="imap.qq.com"
                  value={imapHost}
                />
              </label>
              <label className="im-field">
                <span className="gh-step-t">{"端口"}</span>
                <Input
                  className="font-mono text-xs"
                  data-testid="email-port-input"
                  onChange={(e) => setImapPort(e.target.value)}
                  placeholder="993"
                  value={imapPort}
                />
              </label>
            </div>
            <label className="im-field">
              <span className="gh-step-t">{"应用专用密码 / 授权码"}</span>
              <Input
                autoComplete="new-password"
                className="font-mono"
                data-testid="email-password-input"
                onChange={(e) => setPassword(e.target.value)}
                placeholder="•••• •••• •••• ••••"
                type="password"
                value={password}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={configureSmtp}
                onCheckedChange={(checked) => setConfigureSmtp(checked)}
                data-testid="email-configure-smtp"
              />
              配置并验证 SMTP 发信连接
            </label>
            {configureSmtp ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                  验证时只登录发信服务器，不发送邮件。
                </p>
                <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-2">
                  <label className="im-field">
                    <span className="gh-step-t">SMTP 发信服务器</span>
                    <Input
                      data-testid="email-smtp-host-input"
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.example.com"
                      value={smtpHost}
                    />
                  </label>
                  <label className="im-field">
                    <span className="gh-step-t">端口</span>
                    <select
                      className="h-10 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      data-testid="email-smtp-port-input"
                    >
                      <option value="465">465 · TLS</option>
                      <option value="587">587 · STARTTLS</option>
                    </select>
                  </label>
                </div>
                <label className="im-field">
                  <span className="gh-step-t">SMTP 用户名</span>
                  <Input
                    data-testid="email-smtp-user-input"
                    value={smtpUser}
                    onChange={(e) => setSmtpUser(e.target.value)}
                    placeholder={email || "默认使用邮箱地址"}
                    autoComplete="username"
                  />
                </label>
                <label className="im-field">
                  <span className="gh-step-t">
                    SMTP 专用密码 / 授权码（可选）
                  </span>
                  <Input
                    data-testid="email-smtp-password-input"
                    type="password"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    placeholder="留空使用上面的收信密码"
                    autoComplete="new-password"
                  />
                </label>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                本次只验证收件箱；需要发信时，可在这里填写 SMTP 参数并验证连接。
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-3">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              data-testid="email-save-btn"
              disabled={!valid}
              feedback={{
                pending: "验证中…",
                success: "已连接",
                error: "连接失败",
              }}
              state={saveState}
              type="submit"
            >
              {"验证并连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NotifyWebhookDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: PersonalSourcesStatusView) => void;
}) {
  const [label, setLabel] = useState("我的随身通知");
  const [url, setUrl] = useState("");

  const queryClient = useQueryClient();
  const save = useMutation(bindNotifyWebhookMutationOptions(queryClient));
  const saveState = useMutationFeedback(save);
  const submit = () => {
    save.mutate(
      {
        label: label.trim() || undefined,
        url: url.trim(),
      },
      {
        onSuccess: (data) => {
          onSaved(data);
          toast.success("随身通知推送已绑定");
          onOpenChange(false);
        },
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const valid = Boolean(url.trim().startsWith("https://"));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="im-dialog max-w-lg"
        data-testid="notify-webhook-dialog"
      >
        <DialogHeader>
          <DialogTitle>{"绑定随身通知推送 Webhook"}</DialogTitle>
          <DialogDescription>
            {
              "填入飞书群机器人、钉钉群机器人、企业微信机器人、Bark (iOS)、Server酱或任意自定义 JSON Webhook 链接。"
            }
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && saveState !== "pending") submit();
          }}
        >
          <DialogBody className="im-form mt-2 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {"自动识别飞书 / 钉钉 / 企业微信 / Bark / Server酱 消息格式"}
              </span>
            </div>
            <label className="im-field">
              <span className="gh-step-t">{"通知渠道名称"}</span>
              <Input
                data-testid="notify-label-input"
                onChange={(e) => setLabel(e.target.value)}
                placeholder="飞书提醒 / Bark 手机推送"
                value={label}
              />
            </label>
            <label className="im-field">
              <span className="gh-step-t">{"Webhook URL"}</span>
              <Input
                className="font-mono text-xs"
                data-testid="notify-url-input"
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/... 或 https://api.day.app/..."
                value={url}
              />
            </label>
          </DialogBody>
          <DialogFooter className="mt-3">
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="ghost"
            >
              {"取消"}
            </Button>
            <Button
              data-testid="notify-save-btn"
              disabled={!valid}
              feedback={{
                pending: "保存中…",
                success: "已绑定",
                error: "失败",
              }}
              state={saveState}
              type="submit"
            >
              {"保存并启用"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
