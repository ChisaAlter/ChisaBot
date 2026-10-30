import { Popover } from "@base-ui/react/popover";
import { IconAlertCircle, IconCheck, IconHandStop, IconLoader2 } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { memo, useRef, useState } from "react";
import { BOT_PERMISSION_INFO, BOT_PERMISSION_MODES, type BotPermissionMode } from "../../../../shared/bot-permission";
import { toast } from "@/components/ui/toast";
import { agentQueryOptions } from "@/lib/agents/queries";
import { botPermissionQueryOptions, useSetBotPermission } from "@/lib/bot-permission";
import { cn } from "@/lib/utils";

const ICON: Record<BotPermissionMode, typeof IconHandStop> = { ask: IconHandStop, full: IconAlertCircle };

/**
 * 输入框左下角、「+」后面的权限开关（DESIGN.md §97）：「请求批准」淡色、「完全访问」橙色；
 * 点开是一张小卡片「应如何批准 <机器人> 的操作？」，两档单选，切到完全访问先确认一次。手机上收成一个图标。
 * 档位存在服务器（按机器人），服务器执行时照它放行或出确认卡片——这里只是开关。
 */
function PermissionChipImpl({ agentId, disabled = false }: { agentId: string; disabled?: boolean }) {
  const state = useQuery(botPermissionQueryOptions(agentId));
  const agent = useQuery(agentQueryOptions(agentId));
  const botName = agent.data?.name;
  const { choose, mutation } = useSetBotPermission(agentId, botName);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  if (!agentId) return null;
  const mode: BotPermissionMode = state.data?.mode ?? "ask";
  const Icon = ICON[mode];
  const saving = mutation.isPending;

  async function pick(next: BotPermissionMode) {
    if (next === mode && state.data?.stored) {
      setOpen(false);
      return;
    }
    setOpen(false);
    try {
      const done = await choose(next);
      if (done) toast.success(next === "full" ? "已开启完全访问" : "已改为请求批准");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "权限没保存上，请重试");
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
    event.preventDefault();
  }

  const title = `应如何批准${botName ? `「${botName}」` : "机器人"}的操作？`;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus());
      }}
    >
      <Popover.Trigger
        aria-label={`权限：${BOT_PERMISSION_INFO[mode].label}`}
        className={cn("perm-chip", `is-${mode}`, (state.isPending || saving) && "is-busy")}
        data-testid="permission-chip"
        disabled={disabled || state.isError}
        title={state.isError ? (state.error?.message ?? "无法读取机器人权限") : `${BOT_PERMISSION_INFO[mode].label}：${BOT_PERMISSION_INFO[mode].description}`}
        type="button"
      >
        {saving ? <IconLoader2 className="perm-chip-icon animate-spin" /> : <Icon className="perm-chip-icon" />}
        <span className="perm-chip-label">{BOT_PERMISSION_INFO[mode].short}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" className="isolate z-50" side="top" sideOffset={8}>
          <Popover.Popup aria-label={title} className="perm-popover" data-testid="permission-popover">
            <div className="perm-popover-head">
              <span className="perm-popover-title">{title}</span>
              <Link className="perm-popover-more" onClick={() => setOpen(false)} to="/settings/approvals" hash="about">
                了解更多
              </Link>
            </div>
            <div aria-label="权限档位" className="perm-popover-list" onKeyDown={onKeyDown} ref={listRef} role="menu">
              {BOT_PERMISSION_MODES.map((option) => {
                const OptionIcon = ICON[option];
                const on = option === mode;
                return (
                  <button
                    aria-checked={on}
                    className={cn("perm-option", `is-${option}`, on && "is-on")}
                    data-mode={option}
                    key={option}
                    onClick={() => void pick(option)}
                    role="menuitemradio"
                    tabIndex={on ? 0 : -1}
                    type="button"
                  >
                    <OptionIcon className="perm-option-icon" />
                    <span className="perm-option-text">
                      <span className="perm-option-title">{BOT_PERMISSION_INFO[option].label}</span>
                      <span className="perm-option-sub">{BOT_PERMISSION_INFO[option].description}</span>
                    </span>
                    <IconCheck aria-hidden className={cn("perm-option-check", !on && "invisible")} />
                  </button>
                );
              })}
            </div>
            {state.data && !state.data.stored ? (
              <p className="perm-popover-foot">没单独设过：现在沿用 设置 → 权限与审批 里「操作你的电脑」。</p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** 流式时父组件每个 token 都会重渲；props 没变就跳过（jank FIX-PLAN §5 / P2-1）。 */
PermissionChipImpl.displayName = "PermissionChip";
export const PermissionChip = memo(PermissionChipImpl);
