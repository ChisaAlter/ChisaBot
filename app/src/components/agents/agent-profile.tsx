import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { IconLayoutDashboard, IconTrash } from "@tabler/icons-react";
import { AgentDialog } from "@/components/agents/agent-dialog";
import { DeleteBotDialog } from "@/components/agents/delete-bot-dialog";
import { BotComputerAccess } from "@/components/devices/bot-computer-access";
import { useOpenBotChat } from "@/lib/channels/open-bot-chat";
import { showPanels } from "@/lib/panels/rail-open";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentQueryOptions } from "@/lib/agents/queries";

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3">
        <Skeleton className="size-20 shrink-0 rounded-full" />
        <div className="flex w-full flex-col items-center gap-1.5">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </header>
      <div className="grid gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * Who this coworker is, beside a conversation with it.
 *
 * A card, not a control panel: the panel answers "who am I talking to" — avatar, name, role — and
 * everything that changes the coworker lives in its own dialog, opened from the one button here.
 * It used to duplicate that dialog's whole surface (edit form, tokens, grants, delete), which made
 * two places to maintain and a sidebar that scrolled past the conversation it sat beside.
 */
export function AgentProfile({ agentId }: { agentId: string }) {
  /** The full dialog, opened over the chat rather than navigating away from it. */
  const [managing, setManaging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const openBotChat = useOpenBotChat();
  const agent = useQuery(agentQueryOptions(agentId));

  if (agent.isPending) {
    return <ProfileSkeleton />;
  }
  if (agent.error || !agent.data) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        {"无法加载这个机器人。"}
      </p>
    );
  }

  const profile = agent.data;

  return (
    <div className="flex w-full flex-col gap-6 p-8">
      <header className="flex flex-col items-center gap-3 text-center">
        <AbstractAvatar agentId={profile.id}
          name={profile.name}
          seed={profile.avatarSeed}
          size={80}
        />
        <div className="flex w-full flex-col items-center gap-0.5">
          <h1 className="w-full text-balance text-2xl font-semibold leading-tight tracking-tight">
            {profile.name}
          </h1>
          <p className="w-full text-balance text-sm text-muted-foreground">
            {profile.title}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-1.5">
          {profile.systemOwned ? <Tag>{"系统拥有"}</Tag> : null}
        </div>
      </header>

      <section className="grid gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {"它做什么"}
        </h2>
        <p className="text-sm whitespace-pre-wrap text-pretty">
          {profile.roleDescription}
        </p>
      </section>

      <div className="flex flex-col gap-2">
        <Button
          className="w-full text-sm!"
          onClick={() =>
            void openBotChat(agentId)
          }
        >
          {"去聊天"}
        </Button>
        <Button
          className="w-full text-sm!"
          onClick={() => setManaging(true)}
          variant="outline"
        >
          {"管理机器人"}
        </Button>
      </div>

      {/* 自定义面板：面板跟着当前机器人；宽窗口在右栏，窄窗口在抽屉里。 */}
      <section className="grid min-w-0 grid-cols-1 gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {"自定义面板"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {"它为你做的仪表盘、列表和小工具；也可以让它新建一个，或从面板库安装。"}
        </p>
        <Button className="w-full text-sm!" onClick={() => showPanels()} variant="outline">
          <IconLayoutDashboard />
          {"打开面板"}
        </Button>
      </section>

      <section className="grid min-w-0 grid-cols-1 gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {"电脑操作"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {"你关联的设备由所有机器人共用：它可以使用在线设备，只限每台设备开启的能力和允许的文件夹，每一步都有记录。"}
        </p>
        <BotComputerAccess agentId={agentId} botName={profile.name} compact />
      </section>

      {profile.canDelete ?? profile.canManage ? (
        <section className="bot-danger grid min-w-0 grid-cols-1 gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-destructive">
            {"删除机器人"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {profile.systemOwned
              ? "彻底删除这个部署自带的机器人，以及你与它的私人会话、记忆、定时任务和面板。删除会被记住，更新后也不会回来。此操作无法撤消。"
              : "彻底删除这个机器人，以及你与它的私人会话、记忆、定时任务和面板。此操作无法撤消。"}
          </p>
          <Button className="w-full text-sm!" onClick={() => setDeleting(true)} variant="destructive">
            <IconTrash />
            {"删除机器人…"}
          </Button>
          <DeleteBotDialog
            bot={{ id: agentId, name: profile.name }}
            onOpenChange={setDeleting}
            open={deleting}
            selectedBotId={agentId}
          />
        </section>
      ) : null}

      <AgentDialog
        agentId={agentId}
        onClose={() => setManaging(false)}
        open={managing}
      />
    </div>
  );
}
