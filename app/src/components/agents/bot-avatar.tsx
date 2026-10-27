import { useQuery } from "@tanstack/react-query";
import Avatar from "boring-avatars";
import { memo, useState } from "react";
import { monogramOf } from "../../../../shared/bot-avatars";
import { type AvatarDraft, type BotAvatar as BotAvatarValue, botAvatarsQueryOptions } from "@/lib/agents/avatars";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { cn } from "@/lib/utils";

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
}) {
  const avatars = useQuery({ ...botAvatarsQueryOptions(), enabled: Boolean(agentId) });
  const saved = agentId ? avatars.data?.[agentId] : undefined;
  const shown: ShownAvatar = resolve(draft, saved);
  const roster = useQuery({ ...agentListQueryOptions(), enabled: name === undefined && Boolean(agentId) && shown.kind !== "pattern" });
  const label = name ?? roster.data?.find((agent) => agent.id === agentId)?.name ?? "";
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role 是动态表达式，静态分析看不出；运行时一定带有支持 aria-label 的 role
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label || undefined}
      className={cn("bot-ava", className)}
      data-avatar={shown.kind}
      role={decorative ? undefined : "img"}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.46)) }}
    >
      <AvatarFace name={label} seed={seed ?? agentId ?? label} shown={shown} size={size} />
    </span>
  );
});

type ShownAvatar =
  | { kind: "pattern" }
  | { kind: "image"; url: string }
  | { kind: "emoji"; emoji: string; color: string }
  | { kind: "monogram"; color: string };

function resolve(draft: AvatarDraft | undefined, saved: BotAvatarValue | undefined): ShownAvatar {
  if (draft && draft.kind !== "keep") {
    if (draft.kind === "default") return { kind: "pattern" };
    if (draft.kind === "image") return { kind: "image", url: draft.previewUrl };
    return draft;
  }
  if (!saved) return { kind: "pattern" };
  return saved;
}

function AvatarFace({ shown, name, seed, size }: { shown: ShownAvatar; name: string; seed: string; size: number }) {
  const [broken, setBroken] = useState<string | null>(null);
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
  if (shown.kind === "image")
    return <span className="bot-ava-face bot-ava-c-slate">{monogramOf(name)}</span>;
  if (shown.kind === "emoji")
    return <span className={`bot-ava-face is-emoji bot-ava-c-${shown.color}`}>{shown.emoji}</span>;
  if (shown.kind === "monogram")
    return <span className={`bot-ava-face bot-ava-c-${shown.color}`}>{monogramOf(name)}</span>;
  // size-full：不让祖先的图标选择器（[&_svg:not([class*='size-'])]:size-4）把它缩小。
  return <Avatar className="size-full" name={seed} size={size} />;
}
