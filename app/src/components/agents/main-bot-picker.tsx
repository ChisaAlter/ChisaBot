import { useQuery } from "@tanstack/react-query";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useMainBot } from "@/lib/settings/message-list";

/** 可以接任主机器人的：左栏看得见的、不是现在这个主机器人的。 */
export function mainBotCandidates<T extends { id: string; hidden?: boolean | null }>(
  roster: readonly T[] | undefined,
  currentMainId: string | null | undefined,
): T[] {
  return (roster ?? []).filter((bot) => !bot.hidden && bot.id !== currentMainId);
}

/**
 * 「换一个主机器人」的单选列表（CB-091）。左栏菜单的「更换主机器人…」和删除主机器人时的拦截页共用这一份。
 * 点一行就换，不再多一个「确定」：和左栏「设为主机器人」一样是立刻生效、可以再换回来的偏好。
 */
export function MainBotChoices({ onPicked }: { onPicked?: (agentId: string) => void }) {
  const { mainBotId, setMainBot } = useMainBot();
  const roster = useQuery(agentListQueryOptions());
  const candidates = mainBotCandidates(roster.data, mainBotId);
  if (roster.isPending) {
    return <p className="py-2 text-muted-foreground text-sm">{"正在读取机器人…"}</p>;
  }
  if (candidates.length === 0) {
    return (
      <p className="py-2 text-muted-foreground text-sm">{"没有别的机器人可以设为主机器人。"}</p>
    );
  }
  return (
    <ul aria-label={"选择新的主机器人"} className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto py-1">
      {candidates.map((bot) => (
        <li key={bot.id}>
          <button
            className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted"
            data-testid="main-bot-choice"
            onClick={() => {
              setMainBot(bot.id);
              onPicked?.(bot.id);
            }}
            type="button"
          >
            <ChannelAvatar participantIds={[bot.id]} size={32} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sm">{bot.name}</span>
              {bot.title ? (
                <span className="block truncate text-muted-foreground text-xs">{bot.title}</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 左栏主机器人菜单里的「更换主机器人…」。 */
export function MainBotPickerDialog({
  open,
  onOpenChange,
  currentName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{"更换主机器人"}</DialogTitle>
          <DialogDescription>
            {`现在是「${currentName}」。主机器人排在左栏最前面，打开 ChisaBot 时先面对它。`}
          </DialogDescription>
        </DialogHeader>
        {open ? <MainBotChoices onPicked={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
