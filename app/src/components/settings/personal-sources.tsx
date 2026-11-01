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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  IMAP_PRESETS,
  type PersonalSourcesStatusView,
} from "../../../../shared/personal-sources";
import { BotBubbles } from "@/components/chat/bot-bubbles";
import { sendPromptToChat } from "@/components/chat/quick-spotlight";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
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

export const personalSourcesKeys = {
  all: ["personal-sources"] as const,
};

async function fetchStatus(): Promise<PersonalSourcesStatusView> {
  const res = await fetch("/api/personal-sources", { credentials: "include" });
  if (!res.ok) throw new Error("无法读取个人日程与收件箱状态");
  return (await res.json()) as PersonalSourcesStatusView;
}

export function PersonalSourcesSection() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({
    queryKey: personalSourcesKeys.all,
    queryFn: fetchStatus,
  });

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
        await fetch("/api/personal-sources/weather-city", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ city }),
        });
        await queryClient.invalidateQueries({ queryKey: personalSourcesKeys.all });
      }
      const res = await fetch(
        `/api/personal-sources/morning-brief?city=${encodeURIComponent(city)}`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const data = (await res.json()) as { markdown?: string; error?: string };
      if (!res.ok || !data.markdown) {
        throw new Error(data.error || "生成晨报失败");
      }
      setBriefModalTitle("每日晨报卡片预览");
      setBriefMarkdown(data.markdown);
    },
    { errorToast: (err) => err.message },
  );

  const checkUpdates = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/check-updates", {
        method: "POST",
        credentials: "include",
      });
      const data = (await res.json()) as { markdown?: string; error?: string };
      if (!res.ok || !data.markdown) {
        throw new Error(data.error || "主动巡检失败");
      }
      setBriefModalTitle("⚡ 个人助理主动巡检动态");
      setBriefMarkdown(data.markdown);
      await queryClient.invalidateQueries({ queryKey: personalSourcesKeys.all });
    },
    { errorToast: (err) => err.message },
  );

  const simulateInboundWebhook = useAsyncAction(
    async () => {
      const path = status.data?.inboundWebhook?.path;
      if (!path) throw new Error("入站 Webhook 地址尚未就绪");
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          source: "GitHub Actions",
          title: "PR #306 实机全量测试通过，等待确认发布",
        }),
      });
      if (!res.ok) throw new Error("触发模拟事件失败");
      await queryClient.invalidateQueries({ queryKey: personalSourcesKeys.all });
      toast.success("已触发模拟入站事件！可点「⚡ 巡检动态」查看捕获结果");
    },
    { errorToast: (err) => err.message },
  );

  const rotateInboundToken = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/inbound-webhook/rotate", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("重置入站密钥失败");
      queryClient.setQueryData(personalSourcesKeys.all, await res.json());
      toast.success("已生成新的入站 Webhook 密钥");
    },
    { errorToast: (err) => err.message },
  );

  async function disconnectCalendar() {
    const ok = await confirmDialog({
      title: "断开日历？",
      description: "将从服务器移除你的 ICS 日历订阅地址，机器人不再读取你的日程。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch("/api/personal-sources/calendar", {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      queryClient.setQueryData(personalSourcesKeys.all, await res.json());
      toast.success("已断开日历");
    }
  }

  async function disconnectEmail() {
    const ok = await confirmDialog({
      title: "断开收件箱？",
      description: "将从服务器永久删除加密保存的邮箱专用密码，机器人不再读取你的收件箱。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch("/api/personal-sources/email", {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      queryClient.setQueryData(personalSourcesKeys.all, await res.json());
      toast.success("已断开收件箱");
    }
  }

  async function disconnectNotifyWebhook() {
    const ok = await confirmDialog({
      title: "断开随身通知推送？",
      description: "将移除已绑定的通知 Webhook 地址。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch("/api/personal-sources/notify-webhook", {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      queryClient.setQueryData(personalSourcesKeys.all, await res.json());
      toast.success("已断开随身通知推送");
    }
  }

  const testNotify = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/notify-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error || "发送测试通知失败");
      toast.success("测试通知已发出！");
    },
    { errorToast: (err) => err.message },
  );

  const cal = status.data?.calendar ?? null;
  const mail = status.data?.email ?? null;
  const notifyWh = status.data?.notifyWebhook ?? null;
  const inboundWh = status.data?.inboundWebhook ?? null;

  return (
    <PageSection
      description="轻量接入你的日历（ICS/WebCal）、邮箱（IMAP 收件箱读取 + SMTP 审批发信）、随身通知推送（飞书/钉钉/Bark Webhook）与外部事件触发器，并支持一键生成每日晨报卡片。"
      settingItem="connected-accounts.personal-calendar connected-accounts.personal-email connected-accounts.notify-webhook connected-accounts.morning-brief"
      title="日程、收件箱、通知推送与每日晨报"
    >
      <CalendarConnectDialog
        onOpenChange={setCalOpen}
        onSaved={(next) => queryClient.setQueryData(personalSourcesKeys.all, next)}
        open={calOpen}
      />
      <EmailConnectDialog
        onOpenChange={setMailOpen}
        onSaved={(next) => queryClient.setQueryData(personalSourcesKeys.all, next)}
        open={mailOpen}
      />
      <NotifyWebhookDialog
        onOpenChange={setNotifyOpen}
        onSaved={(next) => queryClient.setQueryData(personalSourcesKeys.all, next)}
        open={notifyOpen}
      />
      <Dialog
        onOpenChange={(open) => {
          if (!open) setBriefMarkdown(null);
        }}
        open={Boolean(briefMarkdown)}
      >
        <DialogContent className="im-dialog max-w-2xl" data-testid="morning-brief-preview-dialog">
          <DialogHeader>
            <DialogTitle>{briefModalTitle}</DialogTitle>
            <DialogDescription>
              {"在聊天中对机器人说「早安」或「巡检今日动态」，机器人也会自动调用对应工具生成这张结构化卡片。"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-2">
            {briefMarkdown ? <BotBubbles text={briefMarkdown} /> : null}
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
            <Button onClick={() => setBriefMarkdown(null)} type="button" variant="outline">
              {"关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {status.isPending ? (
        <PageSkeleton rows={2} />
      ) : (
        <div className="flex flex-col gap-3" data-testid="personal-sources-section">
          {/* 日历只读接入 */}
          <Card className="mem-card" data-testid="personal-calendar-card">
            <div className="im-row">
              <div className="im-row-main is-static">
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
                          <span className="gh-state is-ok">{"已连接（只读）"}</span>
                          <span className="device-cap-chip">
                            <T>{`${cal.eventCount} 个日程事件`}</T>
                          </span>
                          <span className="device-cap-chip">
                            <T>{cal.urlHint}</T>
                          </span>
                        </span>
                        <span className="mem-by">{`${agoText(cal.checkedAt)}同步 · 供 calendar_list_events 工具与晨报读取`}</span>
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
                  onClick={() => setCalOpen(true)}
                  size="sm"
                  variant={cal ? "outline" : "default"}
                >
                  {cal ? "更换日历" : "连接日历"}
                </Button>
                {cal ? (
                  <Button
                    aria-label="断开日历"
                    onClick={() => void disconnectCalendar()}
                    size="sm"
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
            <div className="im-row">
              <div className="im-row-main is-static">
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
                          <span className="gh-state is-ok">{"已连接（IMAP 收信 + SMTP 发信）"}</span>
                          <span className="device-cap-chip">
                            <T>{`未读 ${mail.unreadCount} 封`}</T>
                          </span>
                          <span className="device-cap-chip">
                            <T>{`${mail.imapHost}:${mail.imapPort}`}</T>
                          </span>
                        </span>
                        <span className="mem-by">{`${agoText(mail.checkedAt)}检查过 · 密码 AES-256-GCM 加密保存，代发邮件前必弹确认卡片`}</span>
                      </>
                    ) : (
                      "未连接 · 用应用专用密码连接 QQ / 163 / Gmail / Outlook / iCloud（支持收件箱摘要与确认后发信）"
                    )
                  }
                  title={mail ? mail.email : "电子邮箱（IMAP 收件箱 + SMTP 确认发信）"}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  data-testid="connect-email-btn"
                  onClick={() => setMailOpen(true)}
                  size="sm"
                  variant={mail ? "outline" : "default"}
                >
                  {mail ? "更换邮箱" : "连接邮箱"}
                </Button>
                {mail ? (
                  <Button
                    aria-label="断开收件箱"
                    onClick={() => void disconnectEmail()}
                    size="sm"
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
              <div className="im-row-main is-static">
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
                          {"支持飞书 / 钉钉 / 企业微信群机器人、Bark (iOS)、Server酱或自定义 Webhook，让机器人随时向你推送提醒。"}
                        </span>
                      )}
                      {inboundWh ? (
                        <span className="mem-by">
                          {`入站事件触发地址：${inboundWh.path}${inboundWh.lastSummary ? ` · 最近触发：${inboundWh.lastSummary}` : ""}`}
                        </span>
                      ) : null}
                    </>
                  }
                  title={notifyWh ? notifyWh.label : "随身通知推送 & 外部 Webhook 触发器"}
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
                      feedback={{ pending: "触发中…", success: "已触发", error: "失败" }}
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
                    feedback={{ pending: "推送中…", success: "已推送", error: "失败" }}
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
                  onClick={() => setNotifyOpen(true)}
                  size="sm"
                  variant={notifyWh ? "outline" : "default"}
                >
                  {notifyWh ? "更换推送" : "绑定通知推送"}
                </Button>
                {notifyWh ? (
                  <Button
                    aria-label="断开通知推送"
                    onClick={() => void disconnectNotifyWebhook()}
                    size="sm"
                    variant="ghost"
                  >
                    <IconPlugConnectedX className="size-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          </Card>

          {/* 每日晨报（Morning Brief）生成与城市设置 */}
          <Card className="mem-card" data-testid="morning-brief-config-card">
            <div className="im-row flex-wrap gap-3">
              <div className="im-row-main is-static">
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
                  feedback={{ pending: "巡检中…", success: "已巡检", error: "失败" }}
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
                  feedback={{ pending: "生成中…", success: "已生成", error: "失败" }}
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

const SAMPLE_ICS = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:sample-standup@chisabot",
    `DTSTART:${y}${m}${d}T100000`,
    `DTEND:${y}${m}${d}T103000`,
    "SUMMARY:产品体验走查 & 晨会同步",
    "LOCATION:飞书会议室 A",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:sample-review@chisabot",
    `DTSTART:${y}${m}${d}T150000`,
    `DTEND:${y}${m}${d}T160000`,
    "SUMMARY:ChisaBot 2.0 架构与卡片交互评审",
    "LOCATION:线上 Room 302",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
};

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

  const save = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          label: label.trim() || "我的日历",
          icsUrl: icsUrl.trim() || undefined,
          icsText: icsText.trim() || undefined,
        }),
      });
      const data = (await res.json()) as PersonalSourcesStatusView & { error?: string };
      if (!res.ok) throw new Error(data.error || "连接日历失败");
      onSaved(data);
      toast.success("日历已连接");
      onOpenChange(false);
    },
    { errorToast: (err) => err.message },
  );

  const valid = Boolean(icsUrl.trim() || icsText.trim().includes("BEGIN:VCALENDAR"));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg" data-testid="calendar-connect-dialog">
        <DialogHeader>
          <DialogTitle>{"连接个人日历（ICS 只读）"}</DialogTitle>
          <DialogDescription>
            {"粘贴 iCloud / Google / Outlook / 飞书日历的私密 ICS/WebCal 订阅链接，或直接粘贴 .ics 日历内容。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && save.state !== "pending") void save.run();
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
            <div className="im-field">
              <div className="flex items-center justify-between">
                <span className="gh-step-t">{"或直接粘贴 ICS 日历内容（离线/快速测试）"}</span>
                <button
                  className="text-xs text-primary hover:underline"
                  data-testid="calendar-fill-sample-btn"
                  onClick={() => setIcsText(SAMPLE_ICS())}
                  type="button"
                >
                  {"填入今日示例日程"}
                </button>
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
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button
              data-testid="calendar-save-btn"
              disabled={!valid}
              feedback={{ pending: "验证中…", success: "已连接", error: "失败" }}
              state={save.state}
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: PersonalSourcesStatusView) => void;
}) {
  const [email, setEmail] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [password, setPassword] = useState("");

  function handleEmailChange(val: string) {
    setEmail(val);
    const domain = val.split("@")[1]?.toLowerCase()?.trim();
    if (domain && IMAP_PRESETS[domain]) {
      setImapHost(IMAP_PRESETS[domain].host);
      setImapPort(String(IMAP_PRESETS[domain].port));
    }
  }

  const save = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: email.trim(),
          imapHost: imapHost.trim(),
          imapPort: Number(imapPort) || 993,
          password: password.trim(),
        }),
      });
      const data = (await res.json()) as PersonalSourcesStatusView & { error?: string };
      if (!res.ok) throw new Error(data.error || "连接邮箱失败");
      onSaved(data);
      setPassword("");
      toast.success("邮箱收件箱已连接");
      onOpenChange(false);
    },
    { errorToast: (err) => err.message },
  );

  const valid = email.includes("@") && password.trim().length >= 4 && imapHost.trim().length > 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg" data-testid="email-connect-dialog">
        <DialogHeader>
          <DialogTitle>{"连接电子邮箱（IMAP 收件箱 + SMTP 审批发信）"}</DialogTitle>
          <DialogDescription>
            {"请使用邮箱后台生成的「应用专用密码 / 客户端授权码」。密码经 AES-256-GCM 加密存储，支持读取收件箱摘要，且代发邮件前必弹审批确认卡片。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && save.state !== "pending") void save.run();
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
              <button
                className="text-xs text-primary hover:underline"
                data-testid="email-fill-demo-btn"
                onClick={() => {
                  setEmail("chisa@demo.imap.local");
                  setImapHost("demo.imap.local");
                  setImapPort("993");
                  setPassword("demo-app-pass-2026");
                }}
                type="button"
              >
                {"填入演示收件箱"}
              </button>
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
          </DialogBody>
          <DialogFooter className="mt-3">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button
              data-testid="email-save-btn"
              disabled={!valid}
              feedback={{ pending: "验证中…", success: "已连接", error: "连接失败" }}
              state={save.state}
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

  const save = useAsyncAction(
    async () => {
      const res = await fetch("/api/personal-sources/notify-webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          label: label.trim() || undefined,
          url: url.trim(),
        }),
      });
      const data = (await res.json()) as PersonalSourcesStatusView & { error?: string };
      if (!res.ok) throw new Error(data.error || "绑定通知推送失败");
      onSaved(data);
      toast.success("随身通知推送已绑定");
      onOpenChange(false);
    },
    { errorToast: (err) => err.message },
  );

  const valid = Boolean(url.trim().startsWith("http") || url.trim().toLowerCase() === "demo");

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg" data-testid="notify-webhook-dialog">
        <DialogHeader>
          <DialogTitle>{"绑定随身通知推送 Webhook"}</DialogTitle>
          <DialogDescription>
            {"填入飞书群机器人、钉钉群机器人、企业微信机器人、Bark (iOS)、Server酱或任意自定义 JSON Webhook 链接。"}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {"自动识别飞书 / 钉钉 / 企业微信 / Bark / Server酱 消息格式"}
              </span>
              <button
                className="text-xs text-primary hover:underline"
                data-testid="notify-fill-demo-btn"
                onClick={() => {
                  setLabel("演示随身通知");
                  setUrl("https://demo.webhook.local/push");
                }}
                type="button"
              >
                {"填入演示推送"}
              </button>
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
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button
              data-testid="notify-save-btn"
              disabled={!valid}
              feedback={{ pending: "保存中…", success: "已绑定", error: "失败" }}
              state={save.state}
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
