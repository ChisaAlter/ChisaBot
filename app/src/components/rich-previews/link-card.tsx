import { IconArrowUpRight, IconMessageReply } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useState } from "react";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
import {
  cleanLinkTitle,
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
 * - 没有预览图（2026-10-30 起不再收成小横卡）：同一张竖卡，图区画生成的横幅——站点主色渐变（认得的站用品牌色，
 *   其它按域名算一个稳定色相）+ 大号站点图标或首字 + 一行「owner/repo」/ 域名。GitHub 仓库的预览图是主人头像时
 *   （imageKind `avatar`）把头像画成横幅里的大圆头像。
 * - 字段：给的优先，缺的用 `/api/link-preview` 补（{@link mergeLinkFields}）。
 * - 取预览时画骨架，骨架和有图的卡尺寸完全一样（同一套类名、同一个预留框），内容到了不跳；
 *   最后没有图时原地换成横幅，尺寸不变。
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

/** 认得的站点用品牌色做横幅渐变（DESIGN.md §48.2）。 */
const BRAND_GRADIENTS: Record<string, readonly [string, string]> = {
  "github.com": ["#24292f", "#57606a"],
  "gitlab.com": ["#fc6d26", "#6e49cb"],
  "youtube.com": ["#ff0033", "#a8001f"],
  "bilibili.com": ["#fb7299", "#00a1d6"],
  "zhihu.com": ["#0066ff", "#003fa3"],
  "x.com": ["#14171a", "#3b4248"],
  "twitter.com": ["#1d9bf0", "#0b5d94"],
  "wikipedia.org": ["#5a6270", "#2f343c"],
  "npmjs.com": ["#cb3837", "#7d1f1e"],
};

/** 横幅的两个渐变色：品牌色，或按域名算一个稳定的色相。 */
export function bannerGradient(domain: string): readonly [string, string] {
  const host = domain.toLowerCase().replace(/^(www|m)\./, "");
  const brand =
    BRAND_GRADIENTS[host] ??
    Object.entries(BRAND_GRADIENTS).find(([d]) => host.endsWith(`.${d}`))?.[1];
  if (brand) return brand;
  let hash = 0;
  for (const ch of host) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const hue = hash % 360;
  return [`hsl(${hue} 62% 54%)`, `hsl(${(hue + 38) % 360} 58% 38%)`];
}

/** 横幅上那一行字：GitHub 仓库是 owner/repo，其它是域名。 */
export function bannerLabel(url: string, domain: string): string {
  try {
    const u = new URL(url);
    if (/^(www\.)?github\.com$/i.test(u.hostname)) {
      const [owner, repo] = u.pathname.split("/").filter(Boolean);
      if (owner && repo) return `${owner}/${repo.replace(/\.git$/, "")}`;
      if (owner) return owner;
    }
  } catch {
    /* 用域名 */
  }
  return domain;
}

function initialOf(label: string): string {
  const ch = Array.from(label.replace(/^www\./i, "").trim())[0] ?? "?";
  return ch.toUpperCase();
}

/** 没有预览图时图区画的横幅（和预览图同一个 40:21 框，尺寸不变）。 */
function LinkBanner({
  domain,
  label,
  avatar,
  favicon,
  onAvatarError,
  onIconError,
}: {
  domain: string;
  label: string;
  avatar: string | null;
  favicon: string | null;
  onAvatarError: () => void;
  onIconError: () => void;
}) {
  const [from, to] = bannerGradient(domain);
  return (
    <span
      className="lc-banner"
      data-testid="link-card-banner"
      style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
    >
      {avatar ? (
        <img
          alt=""
          className="lc-banner-avatar"
          decoding="async"
          height={72}
          onError={onAvatarError}
          referrerPolicy="no-referrer"
          src={avatar}
          width={72}
        />
      ) : favicon ? (
        <span className="lc-banner-mark">
          <img
            alt=""
            decoding="async"
            height={36}
            onError={onIconError}
            referrerPolicy="no-referrer"
            src={favicon}
            width={36}
          />
        </span>
      ) : (
        <span aria-hidden className="lc-banner-mark lc-banner-letter">
          {initialOf(label)}
        </span>
      )}
      <span className="lc-banner-label">{label}</span>
    </span>
  );
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

  // 一律竖版大卡（§48.2）：没有预览图时图区画横幅，不再收成小横卡。
  const title = cleanLinkTitle(fields.title);
  const favicon = fields.favicon && !iconBroken ? fields.favicon : null;
  const line = fields.extra ? `${fields.site} · ${fields.extra}` : fields.site;
  const size =
    fields.imageWidth && fields.imageHeight
      ? { width: fields.imageWidth, height: fields.imageHeight }
      : DEFAULT_IMAGE;
  const showPhoto = Boolean(img.src) && !img.broken && !fields.imageAvatar;
  const avatar = fields.imageAvatar && img.src && !img.broken ? img.src : null;

  return (
    <a
      aria-label={`${title}（${line}），在新窗口打开`}
      className={cn("lc-card", className)}
      data-degraded={
        fields.degraded || (needs && query.isError) ? "" : undefined
      }
      data-dimmed={deck?.dimmed ? "" : undefined}
      data-focused={deck?.focused ? "" : undefined}
      data-layout="image"
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
          ? `${title}\n${fields.description}`
          : (query.data?.finalUrl ?? href)
      }
    >
      <span
        className="lc-media"
        data-square={showPhoto && img.square ? "" : undefined}
        style={{ aspectRatio: LINK_CARD_IMAGE_RATIO }}
      >
        {showPhoto && img.src ? (
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
          <LinkBanner
            avatar={avatar}
            domain={fields.domain}
            favicon={favicon}
            label={bannerLabel(href, fields.domain)}
            onAvatarError={() => setAttempt({ ...img, broken: true })}
            onIconError={() => setIconBroken(true)}
          />
        )}
      </span>
      <span className="lc-body">
        <span className="lc-title">{title}</span>
        <span className="lc-meta">
          {favicon ? (
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
          aria-label={`追问 ${title}`}
          className="lc-followup"
          data-testid="card-followup-btn"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dispatchComposerQuote({
              text: `${title} (${href})`,
              source: `链接 · ${line}`,
            });
          }}
          title={`针对「${title}」继续追问`}
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
