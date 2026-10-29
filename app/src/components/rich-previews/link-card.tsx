import {
  IconArrowUpRight,
  IconMessageReply,
  IconWorld,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
import {
  type GivenLinkFields,
  mergeLinkFields,
  needsLinkPreview,
} from "@/lib/rich-previews/link-fields";
import { cn } from "@/lib/utils";
import { previewClient, previewQuery } from "./link-preview-query";
import "./link-card.css";

/**
 * 链接卡（2026-10-29，照 Hark 的做法；DESIGN.md §48）。正文里单独一行的链接和 json-render 的 Link 共用这一个组件。
 *
 * - 有预览图：固定宽约 280px 的竖卡。上半部 og:image 大图（object-fit: cover，上方两个角圆角，框按 40:21 预留），
 *   下面两行粗体标题，再下面一行浅色「站点 · 补充信息」。
 * - 没有预览图：同宽的紧凑横卡（左边站点图标，右边标题 + 站点行）。
 * - 字段：给的优先，缺的用 `/api/link-preview` 补（{@link mergeLinkFields}）。
 * - 取预览时画骨架，骨架和有图的卡尺寸完全一样（同一套类名、同一个预留框），内容到了不跳；
 *   只有「最后确实没有图」时收成紧凑横卡。
 * - 半透明底色 + 内侧高光边，不用 backdrop-filter（聊天里卡片多，模糊太贵）。样式在 ./link-card.css，类名都以 lc- 开头。
 */

export type LinkCardDeck = {
  index: number;
  total: number;
  focused?: boolean;
  dimmed?: boolean;
  onHoverChange?: (hovered: boolean) => void;
};

export type LinkCardProps = GivenLinkFields & {
  url: string;
  /** 多张卡叠成一摞时的位置（正文链接卡）。 */
  deck?: LinkCardDeck;
  /** 显示「追问」按钮（默认显示）。 */
  followup?: boolean;
  className?: string;
};

/** 预留给预览图的宽高比（og:image 常见的 1200×630）。骨架和卡片用同一个值。 */
export const LINK_CARD_IMAGE_RATIO = "40 / 21";
const DEFAULT_IMAGE = { width: 1200, height: 630 };

const DECK_ROTATIONS: Record<number, readonly number[]> = {
  1: [0],
  2: [-4.5, 4.5],
  3: [-6, 0.5, 6],
};
const DECK_OFFSET_Y: Record<number, readonly number[]> = {
  1: [0],
  2: [0, 12],
  3: [10, -2, 14],
};

export function linkDeckStyle(
  index: number,
  total: number,
  focused = false,
): CSSProperties | undefined {
  if (total <= 1) return undefined;
  const rots = DECK_ROTATIONS[Math.min(total, 3)] ?? [];
  const ys = DECK_OFFSET_Y[Math.min(total, 3)] ?? [];
  return {
    "--lc-rot": `${rots[index % rots.length] ?? 0}deg`,
    "--lc-y": `${ys[index % ys.length] ?? 0}px`,
    // 聚焦的那张置顶（不在 CSS 里用 !important 盖内联层级）。
    zIndex: focused ? 30 : index + 1,
  } as CSSProperties;
}

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

/** 取预览时的占位：和有图的卡同一个尺寸。给了标题就先把标题写上。 */
export function LinkCardSkeleton({
  title,
  site,
  style,
  className,
}: {
  title?: string | null;
  site?: string | null;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn("lc-card lc-skel", className)}
      data-layout="image"
      data-testid="link-card-skeleton"
      style={style}
    >
      <span
        className="lc-media sky-skel-block"
        style={{ aspectRatio: LINK_CARD_IMAGE_RATIO }}
      />
      <span className="lc-body">
        {title ? (
          <span className="lc-title">{title}</span>
        ) : (
          <span className="lc-title">
            <span
              className="lc-skel-bar sky-skel-bar"
              style={{ width: "86%" }}
            />
            <span
              className="lc-skel-bar sky-skel-bar"
              style={{ width: "58%" }}
            />
          </span>
        )}
        {site ? (
          <span className="lc-meta">{site}</span>
        ) : (
          <span className="lc-meta">
            <span
              className="lc-skel-bar sky-skel-bar"
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
  deck,
  followup = true,
  className,
  ...given
}: LinkCardProps) {
  const href = safeHref(url);
  const needs = Boolean(href) && needsLinkPreview(given);
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
  const deckStyle = deck
    ? linkDeckStyle(deck.index, deck.total, deck.focused)
    : undefined;
  const waiting = needs && query.isPending && !query.isError;
  if (waiting && !fields.image) {
    return (
      <LinkCardSkeleton
        className={className}
        site={given.title ? fields.site : null}
        style={deckStyle}
        title={given.title ? fields.title : null}
      />
    );
  }

  const layout = fields.image ? "image" : "compact";
  const favicon = fields.favicon && !iconBroken ? fields.favicon : null;
  const line = fields.extra ? `${fields.site} · ${fields.extra}` : fields.site;
  const size =
    fields.imageWidth && fields.imageHeight
      ? { width: fields.imageWidth, height: fields.imageHeight }
      : DEFAULT_IMAGE;
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
      data-dimmed={deck?.dimmed ? "" : undefined}
      data-focused={deck?.focused ? "" : undefined}
      data-layout={layout}
      data-testid="link-card"
      href={href}
      onBlur={() => deck?.onHoverChange?.(false)}
      onClick={(event) => event.stopPropagation()}
      onFocus={() => deck?.onHoverChange?.(true)}
      onMouseEnter={() => deck?.onHoverChange?.(true)}
      onMouseLeave={() => deck?.onHoverChange?.(false)}
      rel="noopener noreferrer"
      style={deckStyle}
      target="_blank"
      title={
        fields.description
          ? `${fields.title}\n${fields.description}`
          : (query.data?.finalUrl ?? href)
      }
    >
      {layout === "image" ? (
        <span
          className="lc-media"
          data-square={img.square ? "" : undefined}
          style={{ aspectRatio: LINK_CARD_IMAGE_RATIO }}
        >
          {img.src && !img.broken ? (
            <img
              alt=""
              decoding="async"
              height={size.height}
              loading="lazy"
              onError={() => {
                if (fields.imageFallback && img.src !== fields.imageFallback)
                  setAttempt({ ...img, src: fields.imageFallback });
                else setAttempt({ ...img, broken: true });
              }}
              onLoad={(event) => {
                const square = isSquarish(event.currentTarget);
                if (square !== img.square) setAttempt({ ...img, square });
              }}
              referrerPolicy="no-referrer"
              src={img.src}
              width={size.width}
            />
          ) : (
            badge
          )}
        </span>
      ) : (
        badge
      )}
      <span className="lc-body">
        <span className="lc-title">{fields.title}</span>
        <span className="lc-meta">
          {layout === "image" && favicon ? (
            <img
              alt=""
              className="lc-icon"
              height={14}
              onError={() => setIconBroken(true)}
              src={favicon}
              width={14}
            />
          ) : null}
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
