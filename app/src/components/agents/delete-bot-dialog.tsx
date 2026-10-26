import { IconAlertTriangle, IconStarFilled, IconTrash } from "@tabler/icons-react";
import { useAsyncAction } from "@/components/ui/async-action";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { forgetDeletedBot } from "@/lib/agents/mutations";
import { agentApiPath, agentListQueryOptions } from "@/lib/agents/queries";
import {
  botResetPlanQueryOptions,
  type ResetPlan,
} from "@/lib/bot-lifecycle/queries";
import { client } from "@/lib/client";
import { useMainBot } from "@/lib/settings/message-list";
import { MainBotChoices, mainBotCandidates } from "@/components/agents/main-bot-picker";
import { useState } from "react";

type DeletableBot = { id: string; name: string };

/** What goes with the Bot, counted from the reset plan, in the words a person reads. */
function deletionLines(plan: ResetPlan): string[] {
  const lines: [number, string][] = [
    [plan.conversations, "个私人会话"],
    [plan.memorySources, "个记忆来源"],
    [plan.memories + plan.formedMemories, "条记忆"],
    [plan.schedules, "个定时任务"],
    [plan.responsibilities, "个长期职责"],
    [plan.followUps, "个待办跟进"],
    [plan.backgroundResearch, "项后台研究"],
    [plan.standingApprovals, "条常驻授权"],
  ];
  return lines
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
}

/**
 * Whether the page on screen belongs to this Bot, so deleting it should move somewhere else first:
 * its settings page, its new-chat page, the coworker dialog open on it, or one of its conversations.
 */
function useShowsBot(botId: string, selectedBotId: string | undefined) {
  const location = useRouterState({ select: (state) => state.location });
  const search = location.search as { agent?: unknown };
  return (
    selectedBotId === botId ||
    search.agent === botId ||
    location.pathname === `/bots/${encodeURIComponent(botId)}` ||
    location.pathname === `/bots/${botId}`
  );
}

/**
 * Deleting a Bot, from anywhere: its settings, the coworker dialog, or the sidebar row's menu.
 *
 * The server removes the Bot together with the person's private conversations, memories,
 * schedules, panels and grants, and clears it as main Bot. This dialog says so, with the real counts,
 * then leaves the Bot's page before forgetting every cached trace of it, so nothing on screen goes on
 * showing a Bot that no longer exists and no page refetches it into a 404.
 *
 * 主机器人不能直接删（CB-091）：每个删除入口（左栏菜单、资料页、聊天旁的资料卡）都打开这个弹窗，
 * 所以拦截只写在这里——先显示「更换主机器人… / 取消主机器人」，换掉之后同一个弹窗接着走删除。
 */
export function DeleteBotDialog({
  bot,
  open,
  onOpenChange,
  selectedBotId,
  onDeleted,
}: {
  bot: DeletableBot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Bot the sidebar shows as selected, if the caller knows it. */
  selectedBotId?: string;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { mainBotId, setMainBot } = useMainBot();
  const showsBot = useShowsBot(bot.id, selectedBotId);
  const isMain = mainBotId === bot.id;
  /** 主机器人拦截页里点了「更换主机器人…」：在同一个弹窗里列出候选，不叠第二个弹窗。 */
  const [choosing, setChoosing] = useState(false);
  const roster = useQuery({ ...agentListQueryOptions(), enabled: open });
  const profile = roster.data?.find((a) => a.id === bot.id);
  const visible = (roster.data ?? []).filter((a) => !a.hidden);
  const lastBot = roster.isSuccess && visible.length === 1 && visible[0]?.id === bot.id;
  const hasOtherBots = mainBotCandidates(roster.data, bot.id).length > 0;
  const plan = useQuery({ ...botResetPlanQueryOptions(bot.id), enabled: open && !isMain });
  const lines = plan.data ? deletionLines(plan.data) : [];

  const remove = useMutation({
    mutationFn: async () => {
      await client(agentApiPath(bot.id), {
        method: "DELETE",
        fallback: "无法删除此机器人",
      });
    },
  });
  /*
   * Driven by hand rather than by `mutation={remove}` so the dialog can stay up long enough for the
   * button to land on ✓ 已删除 (DESIGN.md §2) before it closes and the caches move on.
   */
  const removeAction = useAsyncAction(
    async () => {
      await remove.mutateAsync();
      return true;
    },
    { errorToast: false },
  );
  const settling = removeAction.state !== "idle";
  const confirmDelete = async () => {
    if (!(await removeAction.run())) return;
    // ✓ 已删除 画完（约 300ms）就关，不再多停（DESIGN.md §34.6）。
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    onOpenChange(false);
    if (showsBot) {
      const fallbackBot = !isMain && mainBotId ? mainBotId : null;
      if (fallbackBot)
        await navigate({ to: "/channel/new", search: { agent: fallbackBot } });
      else {
        // Forget it first: "/" lands on the last-used Bot, which must not be the one just deleted.
        await forgetDeletedBot(queryClient, bot.id);
        await navigate({ to: "/" });
        onDeleted?.();
        return;
      }
    }
    await forgetDeletedBot(queryClient, bot.id);
    onDeleted?.();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!remove.isPending && !settling) {
          if (!next) {
            remove.reset();
            setChoosing(false);
          }
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <DialogContent className="max-w-md" showCloseButton={false}>
        {isMain && !settling ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-foreground">
                  <IconStarFilled className="size-4" />
                </span>
                <span className="min-w-0 break-words">{`「${bot.name}」是你的主机器人`}</span>
              </DialogTitle>
              <DialogDescription>
                {choosing
                  ? "选一个新的主机器人。换好之后，可以接着删除它。"
                  : "主机器人不能直接删除。先换一个主机器人，或者取消主机器人，再删除它。"}
              </DialogDescription>
            </DialogHeader>
            {choosing ? (
              <div className="mt-2" data-testid="main-bot-guard-choices">
                <MainBotChoices onPicked={() => setChoosing(false)} />
              </div>
            ) : null}
            <DialogFooter className="mt-4">
              <Button
                onClick={() => {
                  setChoosing(false);
                  onOpenChange(false);
                }}
                variant="outline"
              >
                {"取消"}
              </Button>
              {choosing ? null : (
                <>
                  <Button data-testid="main-bot-guard-unset" onClick={() => setMainBot(null)} variant="outline">
                    {"取消主机器人"}
                  </Button>
                  {hasOtherBots ? (
                    <Button data-testid="main-bot-guard-replace" onClick={() => setChoosing(true)}>
                      {"更换主机器人…"}
                    </Button>
                  ) : null}
                </>
              )}
            </DialogFooter>
          </>
        ) : (
          <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-destructive/12 text-destructive">
              <IconTrash className="size-4" />
            </span>
            <span className="min-w-0 break-words">{`删除机器人「${bot.name}」？`}</span>
          </DialogTitle>
          <DialogDescription>
            {
              "机器人会被彻底删除，并从左栏移除。你与它的私人会话、它为你记住的内容、定时任务、长期职责、面板和授权也会一并删除。"
            }
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-2 text-sm">
          {plan.isPending ? (
            <p className="text-muted-foreground">{"正在统计将删除的内容…"}</p>
          ) : lines.length > 0 ? (
            <p>
              <span className="text-muted-foreground">{"将删除："}</span>
              {lines.join("、")}
            </p>
          ) : plan.data ? (
            <p className="text-muted-foreground">{"没有你与它的私人数据需要删除。"}</p>
          ) : null}
          {plan.data && plan.data.sharedConversationsKept > 0 ? (
            <p className="text-muted-foreground">
              {`${plan.data.sharedConversationsKept} 个与他人共享的会话会保留，便于其他成员查看记录。`}
            </p>
          ) : null}
          {profile?.systemOwned ? (
            <p className="text-muted-foreground">
              {"它是部署自带的机器人。删除会被记住，重启或更新后也不会再出现。"}
            </p>
          ) : null}
          {lastBot ? (
            <p className="text-muted-foreground">
              {"这是你唯一的机器人，删除后会自动新建一个默认的「助手」。"}
            </p>
          ) : null}
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <IconAlertTriangle className="size-4 shrink-0" />
            {"此操作无法撤消。"}
          </p>
        </div>

        {remove.error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        <DialogFooter className="mt-4">
          <Button
            disabled={remove.isPending || settling}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            {"取消"}
          </Button>
          <Button
            feedback="delete"
            onClick={() => void confirmDelete()}
            state={removeAction.state}
            variant="destructive"
          >
            {"删除机器人"}
          </Button>
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
