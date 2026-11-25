import {
  IconBellRinging,
  IconCalendarEvent,
  IconCircleCheck,
  IconMail,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useRef, useState } from "react";
import { z } from "zod";
import {
  CalendarConnectDialog,
  EmailConnectDialog,
  formatPersonalSourceConnectedPrompt,
  NotifyWebhookDialog,
  type PersonalSourceKind,
} from "@/components/settings/personal-sources";
import { Button } from "@/components/ui/button";
import { useRenderTool } from "@/lib/chat/renderers";
import { useConversation } from "@/lib/conversations/conversation";
import {
  personalSourcesKeys,
  personalSourcesStatusQueryOptions,
} from "@/lib/personal-sources/queries";
import type { PersonalSourcesStatusView } from "../../../../shared/personal-sources";

const parameters = z.object({}).passthrough();

const TOOLS: readonly { name: string; kind: PersonalSourceKind }[] = [
  { name: "calendar_connect", kind: "calendar" },
  { name: "email_connect", kind: "email" },
  { name: "notify_webhook_connect", kind: "notify" },
];

function usePersonalSourceConnectRender(tool: (typeof TOOLS)[number]) {
  useRenderTool({
    name: tool.name,
    parameters,
    render: () => <PersonalSourceConnectCard kind={tool.kind} />,
  });
}

export function PersonalSourcesTool() {
  usePersonalSourceConnectRender(TOOLS[0]);
  usePersonalSourceConnectRender(TOOLS[1]);
  usePersonalSourceConnectRender(TOOLS[2]);
  return null;
}

const SOURCE_META: Record<
  PersonalSourceKind,
  {
    disconnectedTitle: string;
    disconnectedSub: string;
    connectLabel: string;
    replaceLabel: string;
  }
> = {
  calendar: {
    disconnectedTitle: "连接个人日历",
    disconnectedSub:
      "ICS 订阅链接只发往服务器，加密保存，不会进入聊天记录。",
    connectLabel: "连接日历",
    replaceLabel: "修改配置",
  },
  email: {
    disconnectedTitle: "连接电子邮箱",
    disconnectedSub:
      "应用专用密码只发往服务器，加密保存，不会进入聊天记录。",
    connectLabel: "连接邮箱",
    replaceLabel: "修改配置",
  },
  notify: {
    disconnectedTitle: "绑定随身通知推送",
    disconnectedSub:
      "Webhook 地址只发往服务器，加密保存，不会进入聊天记录。",
    connectLabel: "绑定推送",
    replaceLabel: "修改配置",
  },
};

function statusDetails(
  kind: PersonalSourceKind,
  data: PersonalSourcesStatusView | undefined,
): { connected: boolean; connectedTitle: string; connectedSub: string } {
  if (kind === "calendar") {
    const cal = data?.calendar ?? null;
    if (!cal) return { connected: false, connectedTitle: "", connectedSub: "" };
    return {
      connected: true,
      connectedTitle: `已连接日历 · ${cal.label || "我的日程"}`,
      connectedSub: `已同步 ${cal.eventCount} 个近期日程；修改订阅地址点右侧按钮即可。`,
    };
  }
  if (kind === "email") {
    const mail = data?.email ?? null;
    if (!mail) return { connected: false, connectedTitle: "", connectedSub: "" };
    return {
      connected: true,
      connectedTitle: `已连接邮箱 · ${mail.email}`,
      connectedSub: `IMAP ${mail.imapHost}，当前 ${mail.unreadCount} 封未读；修改授权码点右侧按钮即可。`,
    };
  }
  const notify = data?.notifyWebhook ?? null;
  if (!notify) {
    return { connected: false, connectedTitle: "", connectedSub: "" };
  }
  return {
    connected: true,
    connectedTitle: `已绑定推送 · ${notify.label || "随身通知"}`,
    connectedSub: "机器人现在可直接向你的通知渠道推送提醒。",
  };
}

function renderSourceIcon(kind: PersonalSourceKind, connected: boolean) {
  if (connected) return <IconCircleCheck className="size-5" />;
  if (kind === "calendar") return <IconCalendarEvent className="size-5" />;
  if (kind === "email") return <IconMail className="size-5" />;
  return <IconBellRinging className="size-5" />;
}

/**
 * 对话内个人数据源（日历 / 邮箱 / 随身通知）连接交互卡片：
 * 点按钮原地打开安全表单弹窗，保存后自动发送非敏感续聊消息通知 AI 继续后续步骤。
 */
export const PersonalSourceConnectCard = memo(
  function PersonalSourceConnectCard({ kind }: { kind: PersonalSourceKind }) {
    const [open, setOpen] = useState(false);
    const openedWhileConnectedRef = useRef(false);
    const conversation = useConversation();
    const queryClient = useQueryClient();
    const status = useQuery(personalSourcesStatusQueryOptions());

    const meta = SOURCE_META[kind];
    const details = statusDetails(kind, status.data);
    const title = details.connected
      ? details.connectedTitle
      : meta.disconnectedTitle;
    const sub = details.connected
      ? details.connectedSub
      : meta.disconnectedSub;

    const handleSaved = (next: PersonalSourcesStatusView) => {
      queryClient.setQueryData(personalSourcesKeys.all, next);
      conversation?.ask(
        formatPersonalSourceConnectedPrompt(
          kind,
          next,
          openedWhileConnectedRef.current,
        ),
      );
    };

    return (
      <div
        className="gh-card"
        data-source-kind={kind}
        data-state={details.connected ? "done" : "open"}
        data-surface="bubble"
        data-testid="personal-source-connect-card"
      >
        <div className="gh-card-h">
          <span className="gh-card-ico">
            {renderSourceIcon(kind, details.connected)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="gh-card-t">{title}</div>
            <div className="gh-card-s">{sub}</div>
          </div>
        </div>
        <div className="gh-card-f">
          <Button
            onClick={() => {
              openedWhileConnectedRef.current = details.connected;
              setOpen(true);
            }}
            size="sm"
            type="button"
            variant={details.connected ? "outline" : "default"}
          >
            {details.connected ? meta.replaceLabel : meta.connectLabel}
          </Button>
        </div>
        {kind === "calendar" ? (
          <CalendarConnectDialog
            onOpenChange={setOpen}
            onSaved={handleSaved}
            open={open}
          />
        ) : kind === "email" ? (
          <EmailConnectDialog
            connection={status.data?.email ?? null}
            onOpenChange={setOpen}
            onSaved={handleSaved}
            open={open}
          />
        ) : (
          <NotifyWebhookDialog
            onOpenChange={setOpen}
            onSaved={handleSaved}
            open={open}
          />
        )}
      </div>
    );
  },
);
