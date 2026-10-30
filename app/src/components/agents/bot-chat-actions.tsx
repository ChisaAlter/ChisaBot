import {
  IconDeviceDesktop,
  IconHistory,
  IconMessagePlus,
} from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useComputerAttention } from "@/components/computer/computer-controls";
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type BotChatContext, publishBotChat } from "@/lib/agents/bot-chat-context";
import { getHotkey } from "@/lib/hotkeys/hotkeys";
import { useHotkey } from "@/lib/hotkeys/use-hotkey";
import { cn } from "@/lib/utils";

type RegisterProps = {
  agentId: string | undefined;
  settingsOpen?: boolean;
  /** Absent where the page has no settings pane (the empty chat): the row menu links instead. */
  onSettingsChange?: (open: boolean) => void;
  computerOpen?: boolean;
  onComputerChange?: (open: boolean) => void;
  onNewTopic?: () => void;
  /** 打开「历史对话」（DESIGN.md §42.6）。 */
  onHistory?: () => void;
  /** Already on an empty topic: 新话题 has nothing to clear. */
  freshTopic?: boolean;
  /** Shown in the roster when the Bot is hidden from it (e.g. the browser Bot). */
  fallbackName?: string;
};

/**
 * DESIGN v4.1：聊天列不再有头部。页面只登记「这个对话的机器人控件」（设置窗格、计算机、新话题），
 * 左栏里这个机器人的那一行读取它：「⋯」菜单和计算机提示都在那一行里。渲染为空。
 *
 * 计算机「需要你」时自动打开计算机、Shift+T 新话题，这两件事仍由页面这里负责（不依赖左栏是否展开）。
 */
export function RegisterBotChat({
  agentId,
  settingsOpen = false,
  onSettingsChange,
  computerOpen = false,
  onComputerChange,
  onNewTopic,
  onHistory,
  freshTopic = false,
  fallbackName,
}: RegisterProps) {
  const noop = useCallback(() => {}, []);
  const needsYou = useComputerAttention(onComputerChange ? agentId : undefined, onComputerChange ?? noop);
  useHotkey("new-topic", () => {
    if (!freshTopic && onNewTopic) onNewTopic();
  });
  // Handlers change identity every render; the published snapshot only changes with the state.
  const latest = useRef({ settingsOpen, onSettingsChange, computerOpen, onComputerChange, onNewTopic, onHistory });
  latest.current = { settingsOpen, onSettingsChange, computerOpen, onComputerChange, onNewTopic, onHistory };
  const canHistory = Boolean(onHistory);
  const canSettings = Boolean(onSettingsChange);
  const canComputer = Boolean(onComputerChange);
  const canNewTopic = Boolean(onNewTopic) && !freshTopic;
  const snapshot = useMemo<BotChatContext | null>(
    () =>
      agentId
        ? {
            agentId,
            fallbackName,
            settingsOpen,
            computerOpen,
            needsYou,
            freshTopic,
            canSettings,
            canComputer,
            canNewTopic,
            canHistory,
            openHistory: () => latest.current.onHistory?.(),
            toggleSettings: () => latest.current.onSettingsChange?.(!latest.current.settingsOpen),
            toggleComputer: () => latest.current.onComputerChange?.(!latest.current.computerOpen),
            newTopic: () => latest.current.onNewTopic?.(),
          }
        : null,
    [agentId, fallbackName, settingsOpen, computerOpen, needsYou, freshTopic, canSettings, canComputer, canNewTopic, canHistory],
  );
  useEffect(() => (snapshot ? publishBotChat(snapshot) : undefined), [snapshot]);
  return null;
}

/** 左栏机器人行里的计算机提示：只在计算机已打开或需要你时出现（琥珀色圆点 = 需要你）。 */
export function BotRowComputerChip({ chat }: { chat: BotChatContext | null }) {
  if (!chat || !chat.canComputer || !(chat.computerOpen || chat.needsYou)) return null;
  const label = chat.needsYou ? "计算机需要你" : chat.computerOpen ? "关闭计算机" : "打开计算机";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-expanded={chat.computerOpen}
            aria-label={label}
            className={cn("glass-bot-comp", chat.computerOpen && "is-on")}
            onClick={chat.toggleComputer}
            type="button"
          />
        }
      >
        <IconDeviceDesktop className="size-4" />
        {chat.needsYou ? <span aria-hidden className="glass-bot-comp-dot" /> : null}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 机器人「⋯」菜单里和对话有关的两项：历史对话 · 新话题（DESIGN.md §57 导航收敛）。
 *
 * 以前还有「机器人设置」（聊天旁的资料窗格，和资料页重复）和「查看计算机」（右栏「面板 | 计算机」切换和机器人行的
 * 计算机图标都能做到），都去掉了；「机器人资料」在菜单第一项。
 * 对正在打开的这个机器人直接操作当前对话；对其他机器人，新话题去它的空聊天。
 */
export function BotChatMenuItems({
  agentId,
  chat,
  onDone,
}: {
  agentId: string;
  chat: BotChatContext | null;
  /** 选完一项之后（例如手机抽屉里的菜单要收起抽屉，M3-11）。 */
  onDone?: () => void;
}) {
  const navigate = useNavigate();
  const icon = "size-[18px] shrink-0 opacity-80";
  const topicKey = getHotkey("new-topic").combo;
  return (
    <>
      {chat?.canHistory ? (
        <DropdownMenuItem className="glass-mi" onClick={() => {
            chat.openHistory?.();
            onDone?.();
          }}
        >
          <IconHistory className={icon} />
          <span className="min-w-0 flex-1">{"历史对话"}</span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        className="glass-mi"
        disabled={Boolean(chat?.freshTopic)}
        onClick={() => {
          if (chat?.canNewTopic) chat.newTopic();
          else void navigate({ to: "/channel/new", search: { agent: agentId, topic: "new" } });
          onDone?.();
        }}
      >
        <IconMessagePlus className={icon} />
        <span className="min-w-0 flex-1">
          <span className="block">{"新话题"}</span>
          <span className="glass-mi-sub">{"清空上下文，旧对话保留"}</span>
        </span>
        {chat ? (
          <DropdownMenuShortcut className="glass-mi-key">
            {topicKey.shift ? "Shift+" : ""}
            {topicKey.key.toUpperCase()}
          </DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    </>
  );
}
