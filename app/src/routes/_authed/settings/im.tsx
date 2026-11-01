import { IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { ImConnectionView, ImPlatform } from "../../../../../shared/im";
import { ConnectionDialog, ConnectionList, LogsDialog, PlatformGrid } from "@/components/im/im";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { ErrorCard } from "@/components/ui/skyglass";
import { imConnectionsQueryOptions } from "@/lib/im";

export const Route = createFileRoute("/_authed/settings/im")({
  component: ImPage,
});

/**
 * 设置 → IM 接入（DESIGN.md §49，docs/im.md）：把你的机器人接到 QQ、微信、飞书、企业微信、钉钉、Telegram。
 * 连接属于你一个人；每个连接选一个你的机器人来回复。
 */
function ImPage() {
  const list = useQuery(imConnectionsQueryOptions());
  const [dialog, setDialog] = useState<{ open: boolean; connection?: ImConnectionView; platform?: ImPlatform | null }>({ open: false });
  const [logsOf, setLogsOf] = useState<ImConnectionView | null>(null);
  const connections = list.data ?? [];
  const live = connections.filter((connection) => connection.status === "connected").length;
  return (
    <>
      <ConnectionDialog
        connection={dialog.connection}
        initialPlatform={dialog.platform}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        open={dialog.open}
      />
      <LogsDialog connection={logsOf} onOpenChange={(open) => !open && setLogsOf(null)} open={Boolean(logsOf)} />
      <PageShell
        action={
          <Button onClick={() => setDialog({ open: true, platform: null })} size="sm">
            <IconPlus />
            {"添加连接"}
          </Button>
        }
        description="把你的机器人接到 QQ、微信、飞书、企业微信、钉钉和 Telegram：在那边发消息，由你选的机器人回复。私聊直接回，群里 @ 它才回；当机器人遇到敏感操作需要审批时，你也可以直接在聊天软件里回复「允许」（或 /approve）、「拒绝」（或 /deny）完成远程批复。连接只属于你。"
        title="IM 接入"
      >
        {list.isPending ? (
          <PageSkeleton rows={2} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button className="mt-2" onClick={() => void list.refetch()} size="sm" variant="outline">
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="IM 连接暂时无法读取"
          />
        ) : connections.length ? (
          <PageSection
            description={`共 ${connections.length} 个，${live ? `${live} 个已连接` : "都没有连上"}。点一行编辑；右侧开关停用 / 启用，⋯ 里测试连接、看日志。`}
            settingItem="im.im-connections"
            title="我的连接"
          >
            <ConnectionList connections={connections} onEdit={(connection) => setDialog({ open: true, connection })} onLogs={setLogsOf} />
          </PageSection>
        ) : null}
        <PageSection
          description={connections.length ? "同一个平台可以接多个账号，每个连接各选一个机器人。" : "还没有连接。选一个平台开始，凭据加密保存在你的服务器上。"}
          title={connections.length ? "再接一个平台" : "选择平台"}
        >
          <PlatformGrid onPick={(platform) => setDialog({ open: true, platform })} />
        </PageSection>
      </PageShell>
    </>
  );
}
