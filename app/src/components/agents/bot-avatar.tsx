import { useQuery, useQueryClient } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { memo, useEffect, useState } from "react";
import { ShapeAvatar } from "@/components/agents/shape-avatar";
import {
  type AvatarDraft,
  type BotAvatar as BotAvatarValue,
  botAvatarsQueryOptions,
  subscribeAvatarSync,
} from "@/lib/agents/avatars";
import { useBotActivity } from "@/lib/agents/bot-activity";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";
import {
  type AvatarShape,
  monogramOf,
  type ShapeColor,
} from "../../../../shared/bot-avatars";

/**
 * 机器人头像，到处都是这一个（DESIGN.md §81）：左栏、聊天页、资料页、机器人列表、新建 / 编辑表单。
 * 永远是圆形。顺序：表单里的草稿（`draft`）→ 服务器上的头像 → 默认花纹（boring-avatars，按 `seed`，老机器人不变）。
 * 上传的图片读不出来（被删了、离线）时退回名字首字。
 */
export const BotAvatar = memo(function BotAvatar({
  agentId,
  name,
  seed,
  size = 32,
  draft,
  className,
  decorative = false,
  selected = false,
  thinking = false,
  working = false,
}: {
  agentId?: string;
  /** 不给就从机器人列表（已在缓存里）里找；只有首字头像要用。 */
  name?: string;
  /** 默认花纹的种子；不给就用 agentId（左栏一直是这样）。 */
  seed?: string;
  size?: number;
  /** 表单里还没保存的改动。 */
  draft?: AvatarDraft;
  className?: string;
  /** 旁边已经写了名字时不再朗读一遍。 */
  decorative?: boolean;
  /** 形象头像的表情：被选中 / 机器人在跑。其他种类的头像不受影响（跑的时候由调用处自己加标记）。 */
  selected?: boolean;
  /** 在想（这一轮在跑但没有工具在跑）：变形比 working 轻。 */
  thinking?: boolean;
  working?: boolean;
}) {
  // 打开着的对话页发布的实时状态（lib/agents/bot-activity.ts）比调用处给的（服务器的 busy）更细，有就用它。
  const live = useBotActivity(agentId);
  const isWorking = live ? live === "working" : working;
  const isThinking = live ? live === "thinking" : thinking;
  const interrupted = live === "interrupted";
  const avatars = useQuery({
    ...botAvatarsQueryOptions(),
    enabled: Boolean(agentId),
  });
  const queryClient = useQueryClient();
  // 别的标签页存了头像就重新拉（审查 10-2）；一页上所有头像共用一个 BroadcastChannel。
  useEffect(
    () => (agentId ? subscribeAvatarSync(queryClient) : undefined),
    [agentId, queryClient],
  );
  const saved = agentId ? avatars.data?.[agentId] : undefined;
  // 审查 10-3：头像表还没回来（冷启动）或拉失败（500）时不能先画默认花纹——有自定义头像的机器人会「闪一下花纹」。
  // 加载中是中性的空圆；失败退到石板灰首字（和图片 404 的兜底一样）。
  const unknown: ShownAvatar | null =
    agentId && !avatars.data && (!draft || draft.kind === "keep")
      ? avatars.isError
        ? { kind: "unknown-error" }
        : { kind: "loading" }
      : null;
  const shown: ShownAvatar = unknown ?? resolve(draft, saved);
  const roster = useQuery({
    ...agentListQueryOptions(),
    enabled:
      name === undefined &&
      Boolean(agentId) &&
      shown.kind !== "pattern" &&
      shown.kind !== "loading",
  });
  const label =
    name ?? roster.data?.find((agent) => agent.id === agentId)?.name ?? "";
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 是动态表达式，静态分析看不出；运行时一定带有支持 aria-label 的 role
    <span
      aria-hidden={decorative || undefined}
      aria-busy={shown.kind === "loading" || undefined}
      aria-label={decorative ? undefined : label || undefined}
      className={cn("bot-ava", className)}
      data-avatar={shown.kind}
      role={decorative ? undefined : "img"}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.46)),
      }}
    >
      <AvatarFace
        name={label}
        seed={seed ?? agentId ?? label}
        selected={selected}
        shown={shown}
        size={size}
        interrupted={interrupted}
        thinking={isThinking}
        working={isWorking}
      />
    </span>
  );
});

type ShownAvatar =
  | { kind: "pattern" }
  | { kind: "loading" }
  | { kind: "unknown-error" }
  | { kind: "image"; url: string }
  | { kind: "emoji"; emoji: string; color: string }
  | { kind: "monogram"; color: string }
  | { kind: "shape"; shape: AvatarShape; color: ShapeColor };

function resolve(
  draft: AvatarDraft | undefined,
  saved: BotAvatarValue | undefined,
): ShownAvatar {
  if (draft && draft.kind !== "keep") {
    if (draft.kind === "default") return { kind: "pattern" };
    if (draft.kind === "image") return { kind: "image", url: draft.previewUrl };
    return draft;
  }
  if (!saved) return { kind: "pattern" };
  return saved;
}

function AvatarFace({
  shown,
  name,
  seed,
  size,
  selected,
  thinking,
  working,
  interrupted,
}: {
  shown: ShownAvatar;
  name: string;
  seed: string;
  size: number;
  selected: boolean;
  thinking: boolean;
  working: boolean;
  interrupted: boolean;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  if (shown.kind === "shape")
    return (
      <ShapeAvatar
        color={shown.color}
        interrupted={interrupted}
        selected={selected}
        shape={shown.shape}
        size={size}
        thinking={thinking}
        working={working}
      />
    );
  if (shown.kind === "image" && broken !== shown.url)
    return (
      <img
        alt=""
        className="bot-ava-img"
        decoding="async"
        draggable={false}
        height={size}
        onError={() => setBroken(shown.url)}
        src={shown.url}
        width={size}
      />
    );
  if (shown.kind === "loading")
    return <span className="bot-ava-face bot-ava-placeholder" />;
  if (shown.kind === "image" || shown.kind === "unknown-error")
    return (
      <span className="bot-ava-face bot-ava-c-slate">{monogramOf(name)}</span>
    );
  if (shown.kind === "emoji")
    return (
      <span className={`bot-ava-face is-emoji bot-ava-c-${shown.color}`}>
        {shown.emoji}
      </span>
    );
  if (shown.kind === "monogram")
    return (
      <span className={`bot-ava-face bot-ava-c-${shown.color}`}>
        {monogramOf(name)}
      </span>
    );
  // size-full：不让祖先的图标选择器（[&_svg:not([class*='size-'])]:size-4）把它缩小。
  return <Avatar className="size-full" name={seed} size={size} />;
}
