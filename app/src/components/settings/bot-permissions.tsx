import { IconAlertCircle, IconHandStop } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { BOT_PERMISSION_INFO, BOT_PERMISSION_MODES, type BotPermissionMode } from "../../../../shared/bot-permission";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { PageSection } from "@/components/layout/page-shell";
import { Card, ListRow } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { botPermissionQueryOptions, useSetBotPermission } from "@/lib/bot-permission";
import { cn } from "@/lib/utils";

const ICON: Record<BotPermissionMode, typeof IconHandStop> = { ask: IconHandStop, full: IconAlertCircle };

/** 设置 → 机器人 → 权限与审批 顶部：每个机器人一行「请求批准 / 完全访问」（和聊天输入框里的开关是同一个值，DESIGN.md §97）。 */
export function BotPermissionsSection() {
  const bots = useQuery(agentListQueryOptions());
  const list = (bots.data ?? []).filter((bot) => !(bot as { deletedAt?: unknown }).deletedAt);
  return (
    <PageSection
      description="和聊天输入框左下角的开关是同一个设置。「请求批准」：在电脑上运行命令、改写文件、安装软件前先问你；「完全访问」：这些直接做。"
      id="bot-permissions"
      settingItem="permissions.bot-permission"
      title="每个机器人的权限"
    >
      <Card className="mem-card">
        {bots.isPending ? (
          <p className="px-4 py-3 text-sm text-muted-foreground" role="status">
            加载机器人…
          </p>
        ) : bots.isError ? (
          <p className="px-4 py-3 text-sm text-destructive" role="alert">
            {bots.error.message}
          </p>
        ) : list.length ? (
          list.map((bot) => <BotPermissionRow bot={bot} key={bot.id} />)
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">还没有机器人。</p>
        )}
      </Card>
    </PageSection>
  );
}

function BotPermissionRow({ bot }: { bot: AgentProfile }) {
  const state = useQuery(botPermissionQueryOptions(bot.id));
  const { choose, mutation } = useSetBotPermission(bot.id, bot.name);
  const mode = state.data?.mode ?? "ask";
  // 分段选择的键盘约定（2026-10-20）：Tab 停在选中档，方向键换档、焦点跟随。
  const keys = useSegmentedKeys<BotPermissionMode>({
    value: mode,
    values: BOT_PERMISSION_MODES,
    onChange: (next) => void pick(next),
    disabled: !state.data || mutation.isPending,
  });
  async function pick(next: BotPermissionMode) {
    if (next === mode && state.data?.stored) return;
    try {
      if (await choose(next)) toast.success(next === "full" ? `「${bot.name}」已开启完全访问` : `「${bot.name}」已改为请求批准`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "权限没保存上，请重试");
    }
  }
  return (
    <ListRow
      actions={
        <div aria-label={`「${bot.name}」的权限`} className="sg-segmented perm-seg" data-testid="bot-permission-seg" {...keys.groupProps} ref={keys.groupRef} role="radiogroup">
          {BOT_PERMISSION_MODES.map((option) => {
            const Icon = ICON[option];
            return (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
              <button
                aria-checked={state.data ? mode === option : false}
                className={cn("sg-segmented-item", `is-${option}`)}
                disabled={!state.data || mutation.isPending}
                key={option}
                onClick={() => void pick(option)}
                role="radio"
                tabIndex={keys.itemTabIndex(option)}
                type="button"
              >
                <Icon className="size-3.5" />
                {BOT_PERMISSION_INFO[option].label}
              </button>
            );
          })}
        </div>
      }
      icon={<BotAvatar agentId={bot.id} name={bot.name} size={40} />}
      sub={
        state.isError
          ? (state.error?.message ?? "读不到权限")
          : state.data && !state.data.stored
            ? `沿用下面「操作你的电脑」：${BOT_PERMISSION_INFO[mode].label}`
            : BOT_PERMISSION_INFO[mode].description
      }
      title={bot.name}
    />
  );
}

/** 「了解更多」落到这里：两档各是什么意思、哪些照旧拦着。 */
export function BotPermissionsAbout() {
  return (
    <PageSection id="about" title="请求批准和完全访问是什么">
      <Card className="mem-card perm-about">
        <div className="perm-about-row">
          <IconHandStop className="perm-about-ico" />
          <div>
            <p className="perm-about-t">请求批准（默认）</p>
            <p className="perm-about-s">
              机器人要在你的电脑上运行命令、改写文件、安装软件、读写允许的文件夹以外的路径时，先在聊天里出一张确认卡片（电脑上也会弹窗），你点「确认」才做。
              设备上设成「直接执行」的能力本来就不问。
            </p>
          </div>
        </div>
        <div className="perm-about-row is-full">
          <IconAlertCircle className="perm-about-ico" />
          <div>
            <p className="perm-about-t">完全访问</p>
            <p className="perm-about-s">
              上面这些不再问你，机器人直接做；允许的文件夹以外的路径会自动加进去（活动记录里能看到）。只对这一个机器人生效，打开时要你确认一次，改动会记进活动记录。
            </p>
          </div>
        </div>
        <div className="perm-about-row">
          <div className="perm-about-ico" />
          <div>
            <p className="perm-about-t">完全访问也放不开的</p>
            <p className="perm-about-s">
              付款购买一律先问；设备上「关闭」的能力、紧急停止、已撤销的设备、管理员身份运行（要设备自己的完全访问）、权限规则里禁止的事、PC 上的「强制本机审批」、你写的「先问我」规则，都照旧。
              对外发消息、删除按下面的偏好处理，不受这个开关影响。
            </p>
          </div>
        </div>
      </Card>
    </PageSection>
  );
}
