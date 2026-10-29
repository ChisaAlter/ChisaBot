import {
  IconArrowUpRight,
  IconMessageReply,
  IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
import {
  type GivenLinkFields,
  linkHost,
  mergeLinkFields,
  needsLinkPreview,
} from "@/lib/rich-previews/link-fields";
import { cn } from "@/lib/utils";
import { previewClient, previewQuery } from "./link-preview-query";
import "./link-card.css";

/**
 * 链接卡（2026-10-29，照 Hark；DESIGN.md §48）。正文里单独一行的链接和 json-render 的 Link 共用这一个组件。
 *
 * - 卡片：深色半透明底、大圆角、柔和阴影，不用模糊。上半部是内缩一圈、自带圆角的预览图，下面两行标题（600），
 *   再下面一行灰色小字「站点 · 补充信息」。没有图时是紧凑横卡。
 * - 图片区跟着图片的宽高比（{@link linkMediaRatio}）：先用服务器量的 og:image 宽高；不知道时 GitHub 按 2:1、
 *   其它按 1.91:1 占位。骨架用同一个比例，内容到了不跳。
 * - 一条回复里多个链接：{@link LinkCardStack} 叠成错落的一叠（{@link linkStackSlots}）。
 * - 字段：给的优先，缺的用 `/api/link-preview` 补（{@link mergeLinkFields}）。
 * - 样式在 ./link-card.css，类名都以 lc- 开头。
 */

export type LinkStackSlot = "main" | "left" | "right";

/**
 * 一个来源 / 链接的数据（和 #391 `shared/reply-sources.ts` 的 `ReplySources.sources[i]` 同形：
 * `{ url, title, site, toolCallId }`），以后来源卡组可以直接 `<LinkCard {...source} />` /
 * `<LinkCardStack items={sources} />`，不用转换。标题一律当纯文本渲染（不走 innerHTML / markdown）。
 */
export type LinkSourceFields = {
  url: string;
  title?: string | null;
  /** 站点名（同 `siteName`；来源格式里叫 `site`）。 */
  site?: string | null;
  /** 产生这个来源的工具调用（来源卡组用来回指那一步）；卡片上只写进 data-tool-call。 */
  toolCallId?: string | null;
};

export type LinkCardProps = GivenLinkFields &
  LinkSourceFields & {
    /** 在一叠卡里的位置（{@link LinkCardStack} 给）；不给就是单独一张卡。 */
    slot?: LinkStackSlot;
    /** 一叠里的序号（层级、测试用）。 */
    stackIndex?: number;
    /** 层级（主位的卡在最前）。 */
    layer?: number;
    /** 一叠里的卡被点 / 聚焦时交给外层决定要不要挪到主位。 */
    onStackClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
    onStackFocus?: (event: ReactFocusEvent<HTMLAnchorElement>) => void;
    /** 显示「追问」按钮（默认显示）。 */
    followup?: boolean;
    className?: string;
  };

// ---------------------------------------------------------------------------------------------
// 图片区宽高比
// ---------------------------------------------------------------------------------------------

/** 不知道 og:image 多大时的占位比例：常见分享图 1200×630。 */
export const LINK_CARD_FALLBACK_RATIO = 1.91;
/** GitHub 的 og:image 是 1200×600。 */
export const LINK_CARD_GITHUB_RATIO = 2;
const MIN_RATIO = 4 / 3;
const MAX_RATIO = 2.4;

export type LinkMediaRatio = {
  /** 写进 `aspect-ratio` 的值（宽 / 高）。 */
  ratio: number;
  /** 宽高从哪来：服务器量的 / GitHub 占位 / 通用占位。 */
  source: "image" | "github" | "fallback";
  /** 接近方形（logo）：整张放进框里，不裁。 */
  square: boolean;
};

function isGithub(url: string): boolean {
  const host = linkHost(url).toLowerCase();
  return host === "github.com" || host.endsWith(".github.com");
}

/**
 * 图片区的宽高比：有宽高就按原图比例（限制在 4:3 – 2.4:1，宽图完整显示不裁）；接近方形的按 4:3 框、整张放进去；
 * 没有宽高时 GitHub 2:1、其它 1.91:1。
 */
export function linkMediaRatio(
  width: number | null | undefined,
  height: number | null | undefined,
  url: string,
): LinkMediaRatio {
  if (width && height && width > 0 && height > 0) {
    const raw = width / height;
    if (raw < 1.25) return { ratio: MIN_RATIO, source: "image", square: true };
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw));
    return {
      ratio: Math.round(ratio * 1000) / 1000,
      source: "image",
      square: false,
    };
  }
  if (isGithub(url))
    return { ratio: LINK_CARD_GITHUB_RATIO, source: "github", square: false };
  return { ratio: LINK_CARD_FALLBACK_RATIO, source: "fallback", square: false };
}

// ---------------------------------------------------------------------------------------------
// 一叠卡的槽位
// ---------------------------------------------------------------------------------------------

/** 一叠卡第一次出现时哪张在主位：三张时中间那张，其余第一张。 */
export function defaultLinkStackPrimary(total: number): number {
  return total >= 3 ? 1 : 0;
}

/**
 * 槽位分配：主位那张居中、抬高、在最前、不倾斜；其余按原来的顺序放进左右两个倾斜的槽位。
 * - 1 张：只有主位。
 * - 2 张：主位 + 右槽。
 * - 3 张：剩下两张按顺序放左槽、右槽。
 */
export function linkStackSlots(
  total: number,
  primary: number,
): LinkStackSlot[] {
  const n = Math.max(0, Math.min(3, Math.floor(total)));
  if (n === 0) return [];
  const main = Math.min(Math.max(0, Math.floor(primary)), n - 1);
  const rest: LinkStackSlot[] = n === 2 ? ["right"] : ["left", "right"];
  const slots: LinkStackSlot[] = [];
  let k = 0;
  for (let i = 0; i < n; i++)
    slots.push(i === main ? "main" : (rest[k++] ?? "right"));
  return slots;
}

/** 每个槽位的变换参数（CSS 变量；位移按卡宽算，手机上跟着缩）。只改 transform，不改布局。 */
export const LINK_STACK_GEOMETRY: Record<
  LinkStackSlot,
  { x: number; y: number; rot: number; scale: number }
> = {
  main: { x: 0, y: 0, rot: 0, scale: 1 },
  left: { x: -1, y: 0.24, rot: -4, scale: 0.94 },
  right: { x: 1, y: 0.3, rot: 3.5, scale: 0.94 },
};

function slotStyle(slot: LinkStackSlot | undefined, layer: number | undefined) {
  if (!slot) return undefined;
  const g = LINK_STACK_GEOMETRY[slot];
  return {
    "--lc-sx": String(g.x),
    "--lc-sy": String(g.y),
    "--lc-rot": `${g.rot}deg`,
    "--lc-sc": String(g.scale),
    zIndex: layer ?? 1,
  } as CSSProperties;
}

// ---------------------------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------------------------

function safeHref(url: unknown): string | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    return new URL(url.trim()).toString();
  } catch {
    return null;
  }
}

type ImageAttempt = {
  key: string | null;
  src: string | null;
  broken: boolean;
  square: boolean;
};

function freshAttempt(image: string | null): ImageAttempt {
  return { key: image, src: image, broken: false, square: false };
}

function isSquarish(img: HTMLImageElement): boolean {
  return img.naturalHeight > 0 && img.naturalWidth / img.naturalHeight < 1.25;
}

/** 取预览时的占位：和有图的卡同一个尺寸（同一个图片比例）。给了标题就先把标题写上。 */
export function LinkCardSkeleton({
  url = "",
  title,
  site,
  slot,
  layer,
  className,
}: {
  url?: string;
  title?: string | null;
  site?: string | null;
  slot?: LinkStackSlot;
  layer?: number;
  className?: string;
}) {
  const media = linkMediaRatio(null, null, url);
  return (
    <div
      aria-hidden
      className={cn("lc-card lc-skel", className)}
      data-layout="image"
      data-slot={slot}
      data-testid="link-card-skeleton"
      style={slotStyle(slot, layer)}
    >
      <span
        className="lc-media lc-skel-block"
        data-ratio={media.source}
        style={{ aspectRatio: String(media.ratio) }}
      />
      <span className="lc-body">
        {title ? (
          <span className="lc-title">{title}</span>
        ) : (
          <span className="lc-title">
            <span
              className="lc-skel-bar"
              style={{ width: "86%" }}
            />
            <span
              className="lc-skel-bar"
              style={{ width: "58%" }}
            />
          </span>
        )}
        {site ? (
          <span className="lc-meta">{site}</span>
        ) : (
          <span className="lc-meta">
            <span
              className="lc-skel-bar"
              style={{ width: "42%" }}
            />
          </span>
        )}
      </span>
    </div>
  );
}

export function LinkCard({
  url,
  slot,
  stackIndex,
  layer,
  onStackClick,
  onStackFocus,
  followup = true,
  className,
  site,
  toolCallId,
  ...rest
}: LinkCardProps) {
  const given: GivenLinkFields = {
    ...rest,
    siteName: rest.siteName ?? site ?? null,
  };
  const href = safeHref(url);
  const needs = Boolean(href) && needsLinkPreview(given, href ?? undefined);
  const query = useQuery(
    { ...previewQuery(href ?? ""), enabled: needs },
    previewClient,
  );
  const fields = mergeLinkFields(href ?? url, given, query.data);
  const [iconBroken, setIconBroken] = useState(false);
  // 这张图试到哪一步了。按地址记：预览到了 / 换了一张图，就从头试（同一次渲染里就换，不等 effect，免得先闪一下图标）。
  const [attempt, setAttempt] = useState<ImageAttempt>(() =>
    freshAttempt(fields.image),
  );
  const img =
    attempt.key === fields.image ? attempt : freshAttempt(fields.image);

  if (!href) return null;
  const waiting = needs && query.isPending && !query.isError;
  if (waiting && !fields.image) {
    return (
      <LinkCardSkeleton
        className={className}
        layer={layer}
        site={given.title ? fields.site : null}
        slot={slot}
        title={given.title ? fields.title : null}
        url={href}
      />
    );
  }

  // 图彻底加载不出来：收成紧凑横卡，不留一大块空框（#380 的「不留空白」）。
  const hasImage = Boolean(fields.image) && !img.broken;
  const layout = hasImage ? "image" : "compact";
  const favicon = fields.favicon && !iconBroken ? fields.favicon : null;
  const line = fields.extra ? `${fields.site} · ${fields.extra}` : fields.site;
  const media = linkMediaRatio(fields.imageWidth, fields.imageHeight, href);
  const square = media.square || img.square;
  const size =
    fields.imageWidth && fields.imageHeight
      ? { width: fields.imageWidth, height: fields.imageHeight }
      : { width: 1200, height: Math.round(1200 / media.ratio) };
  const badge = (
    <span className="lc-badge">
      {favicon ? (
        <img
          alt=""
          decoding="async"
          height={28}
          onError={() => setIconBroken(true)}
          referrerPolicy="no-referrer"
          src={favicon}
          width={28}
        />
      ) : (
        <IconWorld aria-hidden />
      )}
    </span>
  );

  return (
    <a
      aria-label={`${fields.title}（${line}），在新窗口打开`}
      className={cn("lc-card", className)}
      data-degraded={
        fields.degraded || (needs && query.isError) ? "" : undefined
      }
      data-index={stackIndex}
      data-tool-call={toolCallId ?? undefined}
      data-layout={layout}
      data-primary={slot === "main" ? "" : undefined}
      data-slot={slot}
      data-testid="link-card"
      href={href}
      onClick={(event) => {
        event.stopPropagation();
        onStackClick?.(event);
      }}
      onFocus={onStackFocus}
      rel="noopener noreferrer"
      style={slotStyle(slot, layer)}
      target="_blank"
      title={
        fields.description
          ? `${fields.title}\n${fields.description}`
          : (query.data?.finalUrl ?? href)
      }
    >
      {hasImage ? (
        <span
          className="lc-media"
          data-ratio={media.source}
          data-square={square ? "" : undefined}
          style={{ aspectRatio: String(media.ratio) }}
        >
          <img
            alt=""
            decoding="async"
            draggable={false}
            height={size.height}
            loading="lazy"
            onError={() => {
              if (fields.imageFallback && img.src !== fields.imageFallback)
                setAttempt({ ...img, src: fields.imageFallback });
              else setAttempt({ ...img, broken: true });
            }}
            onLoad={(event) => {
              const sq = isSquarish(event.currentTarget);
              if (sq !== img.square) setAttempt({ ...img, square: sq });
            }}
            referrerPolicy="no-referrer"
            src={img.src ?? undefined}
            width={size.width}
          />
        </span>
      ) : (
        badge
      )}
      <span className="lc-body">
        <span className="lc-title">{fields.title}</span>
        <span className="lc-meta">
          <span className="lc-site">{line}</span>
        </span>
      </span>
      {followup ? (
        <button
          aria-label={`追问 ${fields.title}`}
          className="lc-followup"
          data-testid="card-followup-btn"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dispatchComposerQuote({
              text: `${fields.title} (${href})`,
              source: `链接 · ${line}`,
            });
          }}
          title={`针对「${fields.title}」继续追问`}
          type="button"
        >
          <IconMessageReply aria-hidden="true" className="size-3.5" />
          <span>{"追问"}</span>
        </button>
      ) : null}
      <IconArrowUpRight aria-hidden className="lc-go" />
    </a>
  );
}

// ---------------------------------------------------------------------------------------------
// 一叠卡
// ---------------------------------------------------------------------------------------------

/** 一叠里的一项：来源格式（{@link LinkSourceFields}）+ 正文链接的标签（meta）。 */
export type LinkStackItem = LinkSourceFields & { meta?: string | null };

/** 换主位后的锁定时间：不短于 link-card.css 的 transition（--dur-2，220ms）。这段时间里不再换主位，免得卡片在指针下来回换。 */
export const LINK_STACK_MOVE_MS = 250;

function cardIndexOf(target: EventTarget | null): number | null {
  const el =
    target instanceof Element
      ? target.closest<HTMLElement>(".lc-card[data-index]")
      : null;
  if (!el) return null;
  const n = Number(el.dataset.index);
  return Number.isInteger(n) ? n : null;
}

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * 一条回复里的多个链接（最多 3 个）：文字气泡下面一叠错落的卡。
 *
 * - 主位（居中、抬高、最前、不倾斜）+ 左右两个倾斜槽位（{@link linkStackSlots}）。
 * - 鼠标移到哪张卡上，那张就挪到主位；鼠标移开后**保持最后一张在主位**，不复位。
 *   挪动期间（{@link LINK_STACK_MOVE_MS}）不换；挪完时指针下面如果换成了别的卡，要等指针离开那张卡再进来才换，
 *   免得卡片在静止的指针下来回跳。
 * - 触屏：第一次点把卡挪到主位、不打开；点主位的卡才打开。鼠标点击直接打开。
 * - 键盘聚焦（:focus-visible）也挪到主位。
 * - 只改 transform（槽位写成 CSS 变量），层级跟着主位换；减少动态效果时没有过渡，直接切换（CSS）。
 */
export function LinkCardStack({
  items,
  pending = false,
  pendingUrl,
}: {
  items: readonly LinkStackItem[];
  /** 流式中最后一行像是一行链接：多放一个骨架占位。 */
  pending?: boolean;
  /** 骨架那行已经写出来的网址：骨架按它的站点定图片比例，和出来的真卡一样大。 */
  pendingUrl?: string;
}) {
  // 流式中也照样出最多 3 张真卡；还没满 3 张时才多放一个骨架。
  const shown = items.slice(0, 3);
  const withSkeleton = pending && shown.length < 3;
  const total = shown.length + (withSkeleton ? 1 : 0);
  // 用户悬停 / 聚焦 / 点过之前不记主位：卡片流式进来时跟着张数重算默认（1 → 3 张时换到中间那张）；
  // 选过之后保持用户选的那张，再进来卡也不动。
  const [chosen, setChosen] = useState<number | null>(null);
  const lockUntil = useRef(0);
  // 换完主位后指针下的那张卡：指针离开它之前不算「移到这张卡上」。
  const ignore = useRef<number | "next" | null>(null);
  const pointerType = useRef<string>("mouse");
  if (total === 0) return null;
  const main = Math.min(chosen ?? defaultLinkStackPrimary(total), total - 1);
  const slots = linkStackSlots(total, main);
  const isStack = total > 1;

  const promote = (index: number) => {
    if (index === main) {
      // 移到 / 聚焦的就是主位那张：也算用户选过了，之后再进来卡不换主位。
      if (chosen === null) setChosen(index);
      return;
    }
    setChosen(index);
    lockUntil.current = performance.now() + LINK_STACK_MOVE_MS;
    ignore.current = "next";
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerType.current = event.pointerType;
    if (event.pointerType !== "mouse" || !isStack) return;
    if (performance.now() < lockUntil.current) return;
    const index = cardIndexOf(event.target);
    if (ignore.current === "next") ignore.current = index;
    if (index === null) {
      ignore.current = null;
      return;
    }
    if (ignore.current === index) return;
    ignore.current = null;
    promote(index);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerType.current = event.pointerType;
  };

  const layers = slots.map((slot) =>
    slot === "main" ? 30 : slot === "left" ? 20 : 10,
  );

  return (
    <div
      className="lc-stack"
      data-count={total}
      data-deck={isStack ? "" : undefined}
      data-testid="link-cards"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      style={
        {
          "--lc-left": slots.includes("left") ? "1" : "0",
          "--lc-right": slots.includes("right") ? "1" : "0",
        } as CSSProperties
      }
    >
      <div className="lc-stack-track">
        {shown.map((item, i) => (
          <LinkCard
            // 同一个网址可能出现两次（来源列表不一定去重），带上序号免得 key 撞。
            key={`${i}:${item.url}`}
            layer={isStack ? layers[i] : undefined}
            meta={item.meta}
            site={item.site}
            toolCallId={item.toolCallId}
            onStackClick={
              isStack
                ? (event) => {
                    // 触屏第一次点：挪到主位，不打开；鼠标直接打开。键盘聚焦时已经挪到主位，回车直接打开。
                    if (pointerType.current !== "mouse" && i !== main) {
                      event.preventDefault();
                      promote(i);
                    }
                  }
                : undefined
            }
            onStackFocus={
              isStack
                ? (event) => {
                    if (isFocusVisible(event.currentTarget)) promote(i);
                  }
                : undefined
            }
            slot={isStack ? slots[i] : undefined}
            stackIndex={i}
            title={item.title}
            url={item.url}
          />
        ))}
        {withSkeleton ? (
          <LinkCardSkeleton
            key="pending"
            url={pendingUrl}
            layer={isStack ? layers[shown.length] : undefined}
            slot={isStack ? slots[shown.length] : undefined}
          />
        ) : null}
      </div>
    </div>
  );
}
