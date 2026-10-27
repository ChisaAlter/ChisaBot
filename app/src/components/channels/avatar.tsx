import { memo } from "react";
import { BotAvatar } from "@/components/agents/bot-avatar";
import { cn } from "@/lib/utils";

/**
 * Memoized roster avatar. Each face is the shared round `BotAvatar` (uploaded image / emoji / monogram,
 * else the default pattern seeded by the id — DESIGN.md §81). Row updates usually change preview/timestamp only, and
 * `use-channel-events` preserves participant id arrays for unchanged rows.
 *
 * `size-full` opts the generated SVG out of ancestor icon selectors such as
 * `[&_svg:not([class*='size-'])]:size-4`.
 *
 * `typing` overlays a working indicator at the bottom-right — three bouncing dots, so a channel
 * whose agent is mid-turn reads as busy from the roster without moving the row's layout.
 */
export const ChannelAvatar = memo(function ChannelAvatar({
  participantIds,
  size = 32,
  typing = false,
  selected = false,
  working,
}: {
  participantIds: string[];
  size?: number;
  typing?: boolean;
  /** 只让形象头像做「在跑」的表情，不加右下角的小圆点（机器人列表用）；不给就跟 `typing`。 */
  working?: boolean;
  /** 这一行正是当前打开的对话：形象头像会做出「被选中」的表情。 */
  selected?: boolean;
}) {
  const channelSize = participantIds?.length;

  const avatar =
    channelSize === 1 ? (
      <BotAvatar agentId={participantIds[0]} decorative selected={selected} size={size} working={working ?? typing} />
    ) : (
      <div className="flex flex-row items-center size-full">
        {participantIds.slice(0, 3).map((c, i, shown) => (
          <div
            className="shrink-0 border-2 border-sidebar rounded-full flex items-center justify-center"
            key={c}
            style={{
              height: size / (shown.length / 2),
              width: size / (shown.length / 2),
              transform: `translateX(${i * -75}%)`,
            }}
          >
            <BotAvatar agentId={c} decorative selected={selected} size={size / (shown.length / 2)} working={working ?? typing} />
          </div>
        ))}
      </div>
    );

  return (
    <div className="relative" style={{ height: size, width: size }}>
      {avatar}
      {typing ? <TypingBadge /> : null}
    </div>
  );
});

/**
 * Three bouncing dots in a small badge, ringed in the sidebar's own colour so it sits on the
 * avatar as a badge rather than floating over it. The staggered negative delays start each dot at
 * a different point in the same bounce, which is what makes the three read as one wave.
 */
function TypingBadge() {
  return (
    <div className="absolute -bottom-0.5 -right-0.5 flex items-center gap-0.5 rounded-full bg-sidebar p-0.5 ring-2 ring-sidebar">
      <span className="sr-only">{"正在处理中…"}</span>
      <Dot className="[animation-delay:-0.3s]" />
      <Dot className="[animation-delay:-0.15s]" />
      <Dot />
    </div>
  );
}

function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("size-1 rounded-full bg-primary animate-bounce", className)}
    />
  );
}
