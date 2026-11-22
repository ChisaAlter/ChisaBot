import {
  IconArrowUpRight,
  IconDownload,
  IconEye,
  IconFile,
  IconFileCode,
  IconFileSpreadsheet,
  IconFileText,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileZip,
  IconMessageReply,
} from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  type CSSProperties,
  memo,
  useMemo,
  useRef,
  useState,
} from "react";
import { useExternalConnection } from "@/hooks";
import { SmoothStreamdown } from "@/components/chat/smooth-markdown";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { dispatchComposerQuote } from "@/lib/chat/quote-event";
import { readImageDims } from "@/lib/image-dims";
import { markdownComponents } from "@/lib/markdown";
import {
  type ExtractedImage,
  extensionOf,
  extractRichContent,
  extractUserLinks,
  formatBytes,
  type LinkRef,
  splitLinkLines,
} from "@/lib/rich-previews/extract";
import { readFileText, remoteFileSize } from "@/lib/rich-previews/files";
import { DocxPreviewBody, isDocxFile } from "./docx-preview";
import { Lightbox, type LightboxImage } from "./lightbox";
import { LinkCardStack } from "./link-card";
import { hostOf, previewClient, previewQuery } from "./link-preview-query";

/**
 * 聊天富预览（2026-10-13；DESIGN.md §31）：
 * - 链接卡（DESIGN.md §48；2026-10-29 起和 json-render 的 Link 共用 ./link-card.tsx）：单独占一行的链接（最多 3 个）
 *   在正文下面变成 Hark 式链接卡——上半 og:image 大图、两行标题、「站点 · 标签」；没有图时是紧凑横卡。
 *   多个链接叠成错落的一叠（LinkCardStack：主位居中最前，其余放左右倾斜槽位）。
 *   整张可点、新标签页打开（PC / 安卓客户端交给系统浏览器）。
 *   数据来自 `GET /api/link-preview`（服务器只连公网、图片也由服务器转存，浏览器不直接访问第三方）。
 *   取的时候是同尺寸骨架；取不到就画「图标 + 域名」的兜底卡，照样能点。
 * - 图片：一张就是一张图卡；两张以上叠成一摞（每张轻微倾斜），悬停 / 聚焦 / 第一次轻点时摊开，点哪张
 *   就从哪张打开看大图（{@link Lightbox}）。
 * - 文件：图标 + 文件名 + 类型 · 大小 + 下载。
 *
 * 流式回复时：写完的行（后面已经有换行）立刻出卡；最后一行要等文字停下约 0.9 秒（或后面来了换行）才算写完，
 * 之前它如果像一行链接，就先藏起来、卡片位置放骨架——不会拿半截网址去取预览，也不会先闪一行网址。
 */

export type { LinkPreviewData } from "./link-preview-query";

const HAS_HTTP_URL_RE = /https?:\/\//i;
const HTTP_SCHEME_RE = /^https?:/i;
const PARTIAL_LINK_HEAD_RE = /^[ \t]*(?:\*\*|__)*[hH<[]/;
const EMPTY_EXTRACTED_IMAGES: readonly ExtractedImage[] = [];
const EMPTY_FILES: readonly NonNullable<MessageMedia["files"]>[number][] = [];
const EMPTY_LINK_LINES = {
  links: [] as LinkRef[],
  display: "",
  pending: false,
  pendingUrl: undefined as string | undefined,
};

function lastLineOf(text: string): string {
  const nl = text.lastIndexOf("\n");
  return nl === -1 ? text : text.slice(nl + 1);
}

function mayHaveRichPreviews(text: string, media?: MessageMedia): boolean {
  if (
    (media?.images && media.images.length > 0) ||
    (media?.files && media.files.length > 0)
  ) {
    return true;
  }
  if (!text) return false;
  return text.includes("![") || HAS_HTTP_URL_RE.test(text);
}

/**
 * 一张第三方图片 / 一个网页的预览图，经服务器转存后的本站地址（商品网格用，DESIGN.md §72）：
 * 有图片地址先用图片地址（服务器下载、认成图片后存起来），否则用网页的 og:image；都没有返回 null。
 * 走同一个 `/api/link-preview`（只连公网、按人限速、缓存 24 小时），浏览器不直接去第三方拉图。
 */
export function usePreviewImage(
  image: string | null,
  page: string | null,
): { src: string | null; loading: boolean } {
  const first = useQuery(
    { ...previewQuery(image ?? ""), enabled: Boolean(image) },
    previewClient,
  );
  const needPage =
    Boolean(page) &&
    (!image || first.isError || (first.isSuccess && !first.data?.image));
  const second = useQuery(
    { ...previewQuery(page ?? ""), enabled: needPage },
    previewClient,
  );
  const src =
    (first.data?.image ?? null) ||
    (needPage ? (second.data?.image ?? null) : null);
  const loading =
    (Boolean(image) && first.isLoading) || (needPage && second.isLoading);
  return { src, loading };
}

/**
 * 文字停下 `ms` 毫秒后才返回它（流式回复时不追着半截文字跑）。
 *
 * 刚挂载时当作已经写完（历史消息、重放的记录立刻出卡）；之后每变一次都要再停 `ms` 才算写完。
 * 用单一定时器 + 截止时间戳避免流式 60fps 每帧拆装 effect/setTimeout；显式 `streaming === false` 直接返回零定时器。
 */
export function useSettledText(
  text: string,
  ms = 900,
  streaming?: boolean,
  initiallyUnsettled = false,
): string {
  const [settled, setSettled] = useState(() =>
    initiallyUnsettled && streaming !== false ? "" : text,
  );
  const latestRef = useRef(text);
  const deadlineRef = useRef(
    initiallyUnsettled && streaming !== false ? Date.now() + ms : 0,
  );
  if (latestRef.current !== text) {
    latestRef.current = text;
    if (streaming !== false) {
      deadlineRef.current = Date.now() + ms;
    }
  }
  const active = streaming !== false && settled !== text;
  useExternalConnection(active ? `settled:${ms}` : false, () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const wait = Math.max(0, deadlineRef.current - Date.now());
      timer = setTimeout(() => {
        timer = null;
        const remaining = deadlineRef.current - Date.now();
        if (remaining > 0) {
          schedule();
          return;
        }
        setSettled(latestRef.current);
      }, wait);
    };
    schedule();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  });
  return streaming === false ? text : settled;
}

// ---------------------------------------------------------------------------------------------
// 链接卡
// ---------------------------------------------------------------------------------------------

/**
 * 看过的图片多大（按地址记，只在这个页面里）。再画同一张图（切回这段对话、虚拟列表重画）时直接把宽高写在
 * `<img>` 上，浏览器先留出位置，图片加载完不再把下面的消息往下推（DESIGN.md §83）。
 *
 * 键是**实际加载的地址**：画缩略图时是 `?w=` 那个地址，记的是缩略图的天然尺寸；原图地址下只放原图自己的尺寸
 * （服务器给的宽高，或者真的加载了原图）。以前缩略图的尺寸也记在原图地址下，别处按原图地址画（看大图、正文里的
 * markdown 图）就拿到了缩略图的尺寸。服务器忙或缩不了时 `?w=` 回的是原图，记下的也就是原图尺寸，同样对。
 */
const imageSizes = new Map<string, { width: number; height: number }>();
const IMAGE_SIZE_LIMIT = 500;

function rememberSize(src: string, size: { width: number; height: number }) {
  if (imageSizes.has(src)) return;
  if (imageSizes.size >= IMAGE_SIZE_LIMIT) {
    const oldest = imageSizes.keys().next();
    if (!oldest.done) imageSizes.delete(oldest.value);
  }
  imageSizes.set(src, size);
}

function rememberImageSize(src: string, img: HTMLImageElement) {
  if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
  rememberSize(src, { width: img.naturalWidth, height: img.naturalHeight });
}

/**
 * 还不知道宽高（老消息、读不出尺寸的图）时先占的框：固定 240×180，加载完知道了尺寸再换成真比例，
 * 图片加载前后这一轮的高度不会从 0 跳到几百像素。
 */
export const UNKNOWN_IMAGE_BOX: CSSProperties = {
  width: "240px",
  aspectRatio: "4 / 3",
};

/**
 * 记得尺寸就先把框留好：宽度按样式的上限（宽 318、高 300，见 styles.css「图片：单张」）缩，高度跟着宽高比。
 * `aspect-ratio` 让窄屏上 max-width 把宽度压小时高度一起变小。
 * 不知道尺寸、也还没加载完：固定占位框（`UNKNOWN_IMAGE_BOX`）；加载完仍读不出尺寸（比如没有固有尺寸的图）就不再限定。
 */
function reservedImageBox(
  image: PileImage,
  loaded: boolean,
): CSSProperties | undefined {
  const given = readImageDims(image.width, image.height);
  if (given) rememberSize(image.src, given);
  const size = given ?? imageSizes.get(image.thumb ?? image.src);
  if (!size) return loaded ? undefined : UNKNOWN_IMAGE_BOX;
  const scale = Math.min(1, 318 / size.width, 300 / size.height);
  return {
    width: `${Math.round(size.width * scale)}px`,
    aspectRatio: `${size.width} / ${size.height}`,
  };
}

/** 测试用：记住的尺寸。 */
export function rememberedImageSize(src: string) {
  return imageSizes.get(src);
}

function LinkPreviewCardsInner({
  links,
  pending = false,
  pendingUrl,
}: {
  links: readonly LinkRef[];
  /** 流式中最后一行像是一行链接：多放一个骨架占位。 */
  pending?: boolean;
  /** 骨架那行已经写出来的网址（GitHub 的按 2:1 占位）。 */
  pendingUrl?: string;
}) {
  if (links.length === 0 && !pending) return null;
  return (
    <LinkCardStack
      items={links.map((link) => ({ url: link.url, meta: link.label }))}
      pending={pending}
      pendingUrl={pendingUrl}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// 图片：单张 / 错落扇形牌组
// ---------------------------------------------------------------------------------------------

export type PileImage = LightboxImage & {
  caption?: string | undefined;
  href?: string | undefined;
};

export type ImagePileSlot = {
  sx: number;
  sy: number;
  rot: number;
  scale: number;
  z: number;
};

export type ImagePileGeometry = {
  leftSpan: number;
  rightSpan: number;
  dropSpan: number;
  slots: readonly ImagePileSlot[];
};

const MAX_IN_PILE = 4;

const IMAGE_PILE_GEOMETRIES: Record<2 | 3 | 4, ImagePileGeometry> = {
  2: {
    leftSpan: 0.42,
    rightSpan: 0.42,
    dropSpan: 0.32,
    slots: [
      { sx: -0.42, sy: 0, rot: -2.8, scale: 1, z: 20 },
      { sx: 0.42, sy: 0.32, rot: 3.5, scale: 0.95, z: 10 },
    ],
  },
  3: {
    leftSpan: 0.82,
    rightSpan: 0.82,
    dropSpan: 0.38,
    slots: [
      { sx: -0.82, sy: 0.28, rot: -4, scale: 0.94, z: 20 },
      { sx: 0, sy: 0, rot: 0, scale: 1, z: 30 },
      { sx: 0.82, sy: 0.38, rot: 3.5, scale: 0.94, z: 10 },
    ],
  },
  4: {
    leftSpan: 1.02,
    rightSpan: 1.02,
    dropSpan: 0.28,
    slots: [
      { sx: -1.02, sy: 0.26, rot: -5, scale: 0.92, z: 10 },
      { sx: -0.34, sy: 0.04, rot: -1.8, scale: 0.97, z: 25 },
      { sx: 0.34, sy: 0, rot: 1.8, scale: 1, z: 30 },
      { sx: 1.02, sy: 0.28, rot: 4.5, scale: 0.93, z: 20 },
    ],
  },
};

export function imagePileGeometry(total: number): ImagePileGeometry {
  if (total <= 2) return IMAGE_PILE_GEOMETRIES[2];
  if (total === 3) return IMAGE_PILE_GEOMETRIES[3];
  return IMAGE_PILE_GEOMETRIES[4];
}

function safeImageHref(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function keyImages(items: readonly PileImage[]) {
  const counts = new Map<string, number>();
  return items.map((image, i) => {
    const seen = (counts.get(image.src) ?? 0) + 1;
    counts.set(image.src, seen);
    return {
      image,
      index: i,
      key: `${image.src}#${seen}`,
    };
  });
}

export function ImagePile({
  images,
  align = "start",
}: {
  images: readonly PileImage[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [broken, setBroken] = useState<Record<string, boolean>>({});
  /** 加载完的图：没有宽高的那张换下占位框（尺寸那时记进了 `imageSizes`）。 */
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const shown = useMemo(
    () => images.filter((image) => !broken[image.src]),
    [images, broken],
  );

  if (images.length === 0) return null;
  /*
   * 一张都没剩（全加载失败）：以前这里 `return null`，一个只带一张图的轮次就变成空白——
   * 不留破图、也不留任何说明（2026-10-20 清基线时由 transcript-attachments 的用例发现）。
   * 现在留一句「看不到」，和文档卡、看大图用的是同一种说法。
   */
  if (shown.length === 0) {
    return (
      <div className="rp-images" data-align={align}>
        <p className="text-sm text-muted-foreground">
          {images.length === 1 ? "看不到这张附件了。" : "看不到这几个附件了。"}
        </p>
      </div>
    );
  }
  const markBroken = (src: string) => setBroken((b) => ({ ...b, [src]: true }));

  const single = shown.length === 1 ? shown[0] : undefined;
  if (single) {
    const image = single;
    const actualSrc = image.thumb ?? image.src;
    return (
      <div className="rp-images" data-align={align}>
        <button
          aria-label={`查看图片${image.name ? `：${image.name}` : ""}`}
          className="rp-image-single"
          onClick={() => setOpen(0)}
          type="button"
        >
          <img
            alt={image.alt || image.name || "图片"}
            decoding="async"
            loading="lazy"
            onError={() => markBroken(image.src)}
            onLoad={(event) => {
              rememberImageSize(actualSrc, event.currentTarget);
              if (!loaded[actualSrc])
                setLoaded((current) => ({ ...current, [actualSrc]: true }));
            }}
            ref={(img) => {
              if (img?.complete) rememberImageSize(actualSrc, img);
            }}
            src={actualSrc}
            style={reservedImageBox(image, loaded[actualSrc] === true)}
          />
        </button>
        {open !== null ? (
          <Lightbox
            images={shown}
            onClose={() => setOpen(null)}
            startIndex={open}
          />
        ) : null}
      </div>
    );
  }

  const visible = shown.slice(0, MAX_IN_PILE);
  const extra = shown.length - visible.length;
  const keyed = keyImages(visible);
  const geometry = imagePileGeometry(visible.length);
  const hasCaption = visible.some(
    (item) => typeof item.caption === "string" && item.caption.trim() !== "",
  );
  const coarse =
    typeof window !== "undefined" &&
    window.matchMedia?.("(hover: none)").matches;
  return (
    <div className="rp-images" data-align={align}>
      {/* biome-ignore lint/a11y/useSemanticElements: 一摞图片是一组按钮，不是表单（fieldset 会带来表单语义和默认样式） */}
      <div
        aria-label={`${shown.length} 张图片`}
        className="rp-pile"
        data-captioned={hasCaption ? "" : undefined}
        data-count={visible.length}
        data-focused={hoveredIndex !== null ? "" : undefined}
        onBlur={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setHoveredIndex(null);
          }
        }}
        onMouseLeave={() => {
          if (!coarse) setHoveredIndex(null);
        }}
        role="group"
        style={
          {
            "--rp-left": String(geometry.leftSpan),
            "--rp-right": String(geometry.rightSpan),
            "--rp-drop": String(geometry.dropSpan),
            "--rp-n": String(visible.length),
          } as CSSProperties
        }
      >
        {keyed.map(({ image, index: i, key }) => {
          const slot = geometry.slots[i] ?? {
            sx: 0,
            sy: 0,
            rot: 0,
            scale: 1,
            z: 1,
          };
          const isFocused = hoveredIndex === i;
          const isDimmed = hoveredIndex !== null && hoveredIndex !== i;
          const caption = image.caption?.trim() || "";
          const href = safeImageHref(image.href);
          const site = href ? hostOf(href) : "";
          const label = caption || image.name || `图片 ${i + 1}`;
          return (
            <div
              className="rp-pile-item"
              data-dimmed={isDimmed ? "" : undefined}
              data-focused={isFocused ? "" : undefined}
              key={key}
              style={
                {
                  "--rp-i": String(i),
                  "--rp-sx": String(slot.sx),
                  "--rp-sy": String(slot.sy),
                  "--rp-rot": `${slot.rot}deg`,
                  "--rp-sc": String(slot.scale),
                  zIndex: isFocused ? 35 : slot.z,
                } as CSSProperties
              }
            >
              <button
                aria-label={`查看第 ${i + 1} 张图片（共 ${shown.length} 张）`}
                className="rp-pile-card"
                data-dimmed={isDimmed ? "" : undefined}
                data-focused={isFocused ? "" : undefined}
                onBlur={() => setHoveredIndex(null)}
                onClick={() => setOpen(i)}
                onFocus={() => setHoveredIndex(i)}
                onMouseEnter={() => !coarse && setHoveredIndex(i)}
                onMouseLeave={() => !coarse && setHoveredIndex(null)}
                type="button"
              >
                <span className="rp-pile-media">
                  <img
                    alt={image.alt || label}
                    decoding="async"
                    draggable={false}
                    loading="lazy"
                    onError={() => markBroken(image.src)}
                    src={image.thumb ?? image.src}
                  />
                  {i === visible.length - 1 && extra > 0 ? (
                    <span className="rp-pile-more">+{extra}</span>
                  ) : null}
                </span>
                {hasCaption ? (
                  <span className="rp-pile-body">
                    <span className="rp-pile-caption">{caption || label}</span>
                    {site ? <span className="rp-pile-site">{site}</span> : null}
                  </span>
                ) : null}
              </button>
              {href ? (
                <a
                  aria-label={`打开原页：${label}`}
                  className="rp-pile-go"
                  href={href}
                  onClick={(event) => event.stopPropagation()}
                  rel="noopener noreferrer"
                  target="_blank"
                  title={site || href}
                >
                  <IconArrowUpRight aria-hidden className="size-3.5" />
                </a>
              ) : null}
            </div>
          );
        })}
      </div>
      {open !== null ? (
        <Lightbox
          images={shown}
          onClose={() => setOpen(null)}
          startIndex={open}
        />
      ) : null}
    </div>
  );
}

/** 网址指向第三方的图片：先请服务器转存（同一个链接预览接口），浏览器只读本站的副本。 */
function useResolvedImages(images: readonly ExtractedImage[]): PileImage[] {
  const external = useMemo(
    () => images.filter((image) => HTTP_SCHEME_RE.test(image.src)),
    [images],
  );
  const results = useQueries(
    {
      queries: external.map((image) => previewQuery(image.src)),
    },
    previewClient,
  );
  return images.flatMap((image): PileImage[] => {
    if (!HTTP_SCHEME_RE.test(image.src))
      return [{ src: image.src, alt: image.alt }];
    const result = results[external.indexOf(image)];
    const data = result?.data;
    if (!data?.image || data.imageKind !== "direct") return [];
    return [
      {
        src: data.image,
        alt: image.alt,
        name: data.title,
        ...readImageDims(data.imageWidth, data.imageHeight),
      },
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// 文件卡
// ---------------------------------------------------------------------------------------------

function fileIcon(ext: string) {
  if (ext === "pdf") return IconFileTypePdf;
  if (["doc", "docx", "rtf", "odt"].includes(ext)) return IconFileTypeDoc;
  if (["xls", "xlsx", "csv", "tsv", "ods", "numbers"].includes(ext))
    return IconFileSpreadsheet;
  if (["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"].includes(ext))
    return IconFileZip;
  if (
    [
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "go",
      "rs",
      "java",
      "c",
      "cpp",
      "h",
      "json",
      "yaml",
      "yml",
      "toml",
      "sh",
      "html",
      "css",
      "sql",
      "xml",
    ].includes(ext)
  )
    return IconFileCode;
  if (["txt", "md", "log"].includes(ext)) return IconFileText;
  return IconFile;
}

/** 同站文件的大小：HEAD 一下读 content-length（拿不到就不显示）。 */
function useRemoteSize(
  url: string,
  known: number | null | undefined,
  probe: boolean,
): number | null {
  const sameOrigin = url.startsWith("/") && !url.startsWith("//");
  const { data } = useQuery(
    {
      queryKey: ["file-size", url],
      enabled: probe && sameOrigin && (known === undefined || known === null),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      queryFn: () => remoteFileSize(url),
    },
    previewClient,
  );
  return known ?? data ?? null;
}

function lastSegment(url: string): string {
  const raw = url.split("?")[0]?.split("/").pop() || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const READABLE_TEXT_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "go",
  "rs",
  "sh",
  "sql",
]);

function FileCardInner({
  url,
  name,
  size,
  mimeType,
  metaSuffix,
  probeSize = true,
}: {
  url: string;
  name?: string;
  size?: number | null;
  mimeType?: string;
  /** 资料页等场景追加的时间说明（例如「3 小时前」）。 */
  metaSuffix?: string | null;
  /** 调用方自己已经 HEAD 过（频道附件），就别再问一次。 */
  probeSize?: boolean;
}) {
  const label = name || lastSegment(url) || "未命名文件";
  const ext = (
    extensionOf(label) ||
    (mimeType?.split("/")[1] ?? "").replace(/^x-/, "").slice(0, 6)
  ).toLowerCase();
  const bytes = useRemoteSize(url, size, probeSize);
  const Icon = fileIcon(ext);
  const meta = [
    ext ? ext.toUpperCase() : "文件",
    formatBytes(bytes),
    metaSuffix,
  ]
    .filter(Boolean)
    .join(" · ");
  // 本站文件才预览（DESIGN.md §56、§111）：位图出缩略图、点开看大图；PDF / .docx 出「预览」；文本/Markdown 点开弹窗阅读。
  const sameOrigin = url.startsWith("/") && !url.startsWith("//");
  const isImage =
    sameOrigin && /^image\/(png|jpeg|gif|webp)$/.test(mimeType ?? "");
  const isPdf = sameOrigin && (mimeType === "application/pdf" || ext === "pdf");
  const isDocx = sameOrigin && isDocxFile(ext, mimeType);
  const isTextDoc =
    sameOrigin &&
    !isImage &&
    !isPdf &&
    !isDocx &&
    (READABLE_TEXT_EXTS.has(ext) ||
      Boolean(mimeType?.startsWith("text/")) ||
      mimeType === "application/json");
  const isMarkdownDoc =
    ext === "md" || ext === "markdown" || mimeType === "text/markdown";
  const downloadHref = url.startsWith("/api/chat-files/")
    ? `${url}?download=1`
    : url;
  const [viewing, setViewing] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const textQuery = useQuery(
    {
      queryKey: ["file-text-preview", url],
      enabled: viewing && isTextDoc,
      staleTime: 5 * 60_000,
      retry: false,
      queryFn: () => readFileText(url),
    },
    previewClient,
  );
  const canPreviewModal =
    (isImage && !thumbBroken) || isPdf || isDocx || isTextDoc;
  return (
    <div
      className="rp-file"
      data-preview={
        isImage && !thumbBroken
          ? "image"
          : isPdf
            ? "pdf"
            : isDocx
              ? "docx"
              : isTextDoc
                ? "text"
                : undefined
      }
    >
      {isImage && !thumbBroken ? (
        <button
          aria-label={`查看 ${label}`}
          className="rp-file-thumb"
          onClick={() => setViewing(true)}
          type="button"
        >
          <img
            alt=""
            decoding="async"
            loading="lazy"
            onError={() => setThumbBroken(true)}
            src={url}
          />
        </button>
      ) : (
        <span aria-hidden className="rp-file-icon" data-ext={ext || undefined}>
          <Icon className="size-5" />
        </span>
      )}
      <a
        className="rp-file-text"
        href={url}
        onClick={(event) => {
          if (canPreviewModal) {
            event.preventDefault();
            setViewing(true);
          }
        }}
        rel="noopener noreferrer"
        target="_blank"
        title={label}
      >
        <span className="rp-file-name">{label}</span>
        <span className="rp-file-meta">{meta}</span>
      </a>
      {isPdf || isDocx || isTextDoc ? (
        <button
          aria-label={`预览 ${label}`}
          className="rp-file-dl"
          data-testid="file-preview"
          onClick={() => setViewing(true)}
          title="预览"
          type="button"
        >
          <IconEye className="size-4" />
        </button>
      ) : null}
      <button
        aria-label={`追问 ${label}`}
        className="rp-file-dl"
        data-testid="card-followup-btn"
        onClick={(e) => {
          e.stopPropagation();
          dispatchComposerQuote({
            text: `${label} (${meta})`,
            source: `文件 · ${label}`,
          });
        }}
        title={`针对「${label}」继续追问`}
        type="button"
      >
        <IconMessageReply className="size-4" />
      </button>
      <a
        aria-label={`下载 ${label}`}
        className="rp-file-dl"
        download={label}
        href={downloadHref}
        title="下载"
      >
        <IconDownload className="size-4" />
      </a>
      {viewing && isImage ? (
        <Lightbox
          images={[{ src: url, name: label, alt: label }]}
          onClose={() => setViewing(false)}
          startIndex={0}
        />
      ) : null}
      {isPdf ? (
        <Dialog onOpenChange={setViewing} open={viewing}>
          <DialogContent className="rp-pdf-dialog">
            <DialogHeader>
              <DialogTitle className="truncate">{label}</DialogTitle>
            </DialogHeader>
            {viewing ? (
              <iframe className="rp-pdf-frame" src={url} title={label} />
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      {isDocx ? (
        <Dialog onOpenChange={setViewing} open={viewing}>
          <DialogContent className="rp-docx-dialog">
            <DialogHeader className="chat-doc-dialog-head">
              <div className="chat-doc-dialog-title-wrap">
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <DialogTitle className="truncate">{label}</DialogTitle>
              </div>
              <div className="chat-doc-dialog-actions mr-7">
                <button
                  aria-label={`追问 ${label}`}
                  className="rp-file-dl"
                  data-testid="docx-dialog-followup-btn"
                  onClick={() => {
                    setViewing(false);
                    dispatchComposerQuote({
                      text: `${label} (${meta})`,
                      source: `文件 · ${label}`,
                    });
                  }}
                  title={`针对「${label}」继续追问`}
                  type="button"
                >
                  <IconMessageReply className="size-4" />
                </button>
                <a
                  aria-label={`下载 ${label}`}
                  className="rp-file-dl"
                  download={label}
                  href={downloadHref}
                  title="下载"
                >
                  <IconDownload className="size-4" />
                </a>
              </div>
            </DialogHeader>
            {viewing ? <DocxPreviewBody knownBytes={bytes} url={url} /> : null}
          </DialogContent>
        </Dialog>
      ) : null}
      {isTextDoc ? (
        <Dialog onOpenChange={setViewing} open={viewing}>
          <DialogContent className="chat-doc-dialog">
            <DialogHeader className="chat-doc-dialog-head">
              <div className="chat-doc-dialog-title-wrap">
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <DialogTitle className="truncate">{label}</DialogTitle>
              </div>
              <div className="chat-doc-dialog-actions mr-7">
                {typeof textQuery.data === "string" ? (
                  <CopyButton
                    className="chat-draft-copy"
                    size="sm"
                    value={textQuery.data}
                    variant="ghost"
                  >
                    {"复制"}
                  </CopyButton>
                ) : null}
                <a
                  aria-label={`下载 ${label}`}
                  className="rp-file-dl"
                  download={label}
                  href={downloadHref}
                  title="下载"
                >
                  <IconDownload className="size-4" />
                </a>
              </div>
            </DialogHeader>
            <div className="chat-doc-dialog-body">
              {textQuery.isPending ? (
                <p className="text-sm text-muted-foreground">
                  {"正在加载文档内容…"}
                </p>
              ) : textQuery.isError ? (
                <p className="text-sm text-muted-foreground">
                  {"无法预览该文件，请点击右上角下载查看。"}
                </p>
              ) : isMarkdownDoc ? (
                <div className="chat-doc-inner">
                  <SmoothStreamdown components={markdownComponents as never}>
                    {textQuery.data ?? ""}
                  </SmoothStreamdown>
                </div>
              ) : (
                <pre className="rp-doc-pre">{textQuery.data ?? ""}</pre>
              )}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 一条消息下面的全部预览
// ---------------------------------------------------------------------------------------------

export type MessageMedia = {
  images?: readonly PileImage[];
  files?: readonly {
    url: string;
    name?: string;
    size?: number | null;
    mimeType?: string;
  }[];
};

type MessageRichPreviewsProps = {
  text: string;
  align?: "start" | "end";
  media?: MessageMedia;
};

function MessageRichPreviewsStack({
  align,
  images,
  files,
  links,
  pending,
  pendingUrl,
}: {
  align: "start" | "end";
  images: readonly PileImage[];
  files: readonly NonNullable<MessageMedia["files"]>[number][];
  links: readonly LinkRef[];
  pending: boolean;
  pendingUrl?: string | undefined;
}) {
  if (
    images.length === 0 &&
    files.length === 0 &&
    links.length === 0 &&
    !pending
  )
    return null;
  return (
    <div className="rp-stack" data-align={align}>
      {images.length > 0 ? <ImagePile align={align} images={images} /> : null}
      {files.length > 0 ? (
        <div className="rp-files">
          {files.map((file) => (
            <FileCard key={file.url} {...file} />
          ))}
        </div>
      ) : null}
      <LinkPreviewCards
        links={links}
        pending={pending}
        pendingUrl={pendingUrl}
      />
    </div>
  );
}

/** 仅在消息中真正包含外链 Markdown 图片时挂载，避免无图消息创建空 QueriesObserver。 */
function MessageRichPreviewsWithExternalImages({
  align,
  foundImages,
  mediaImages,
  files,
  links,
  pending,
  pendingUrl,
}: {
  align: "start" | "end";
  foundImages: readonly ExtractedImage[];
  mediaImages: readonly PileImage[] | undefined;
  files: readonly NonNullable<MessageMedia["files"]>[number][];
  links: readonly LinkRef[];
  pending: boolean;
  pendingUrl?: string | undefined;
}) {
  const fromText = useResolvedImages(foundImages);
  const images = useMemo(
    () => (mediaImages?.length ? [...mediaImages, ...fromText] : fromText),
    [mediaImages, fromText],
  );
  return (
    <MessageRichPreviewsStack
      align={align}
      files={files}
      images={images}
      links={links}
      pending={pending}
      pendingUrl={pendingUrl}
    />
  );
}

function MessageRichPreviewsInner({
  text,
  align = "start",
  media,
  initiallyUnsettled = false,
}: MessageRichPreviewsProps & { initiallyUnsettled?: boolean }) {
  const isUser = align === "end";
  const settled = useSettledText(
    text,
    900,
    isUser ? false : undefined,
    initiallyUnsettled,
  );
  // 用户消息是一次发完的；机器人消息在文字停下前最后一行不算写完。
  const final = isUser || settled === text;
  const split = useMemo(
    () => (isUser ? EMPTY_LINK_LINES : splitLinkLines(text, { final })),
    [isUser, text, final],
  );
  const foundImages = useMemo(
    () =>
      settled.includes("![")
        ? extractRichContent(settled).images
        : EMPTY_EXTRACTED_IMAGES,
    [settled],
  );
  const hasExternalImages = useMemo(
    () => foundImages.some((image) => HTTP_SCHEME_RE.test(image.src)),
    [foundImages],
  );
  const imageSet = useMemo(
    () =>
      foundImages.length > 0
        ? new Set(foundImages.map((i) => i.src))
        : null,
    [foundImages],
  );
  // 用户的消息：句子中间的链接也出卡（extractUserLinks）；机器人的只认单独一行的（§48）。
  const userLinks = useMemo(
    () => (isUser && HAS_HTTP_URL_RE.test(text) ? extractUserLinks(text) : null),
    [isUser, text],
  );
  const links = useMemo(() => {
    const raw = userLinks ?? split.links;
    if (!imageSet || raw.length === 0) return raw;
    return raw.filter((l) => !imageSet.has(l.url));
  }, [userLinks, split.links, imageSet]);
  const localImages = useMemo<readonly PileImage[]>(() => {
    if (hasExternalImages) return [];
    const mediaImgs = media?.images ?? [];
    if (foundImages.length === 0) return mediaImgs;
    const fromLocal = foundImages.map((image) => ({
      src: image.src,
      alt: image.alt,
    }));
    return mediaImgs.length > 0 ? [...mediaImgs, ...fromLocal] : fromLocal;
  }, [hasExternalImages, media?.images, foundImages]);
  const files = media?.files ?? EMPTY_FILES;
  if (hasExternalImages) {
    return (
      <MessageRichPreviewsWithExternalImages
        align={align}
        files={files}
        foundImages={foundImages}
        links={links}
        mediaImages={media?.images}
        pending={split.pending}
        pendingUrl={split.pendingUrl}
      />
    );
  }
  return (
    <MessageRichPreviewsStack
      align={align}
      files={files}
      images={localImages}
      links={links}
      pending={split.pending}
      pendingUrl={split.pendingUrl}
    />
  );
}

/**
 * 给 Markdown 渲染的正文：出了链接卡的那几行拿掉（和 {@link MessageRichPreviews} 用同一套判断，DESIGN.md §48）。
 * 只用于机器人消息；用户自己的消息原样显示。
 */
export function useDisplayText(text: string, streaming?: boolean): string {
  const settled = useSettledText(text, 900, streaming);
  const final = streaming === false || settled === text;
  return useMemo(() => {
    if (!text) return text ?? "";
    // 快速路径：不含任何 http(s):// 且非半截链接行开头时不可能提取链接卡，跳过逐行 split 与正则扫描。
    if (
      !HAS_HTTP_URL_RE.test(text) &&
      (final || !PARTIAL_LINK_HEAD_RE.test(lastLineOf(text)))
    ) {
      return text;
    }
    return splitLinkLines(text, { final }).display;
  }, [text, final]);
}

export function LinkPreviewCards(
  props: Parameters<typeof LinkPreviewCardsInner>[0],
) {
  return <LinkPreviewCardsInner {...props} />;
}

export function FileCard(props: Parameters<typeof FileCardInner>[0]) {
  return <FileCardInner {...props} />;
}

export const MessageRichPreviews = memo(function MessageRichPreviews(
  props: MessageRichPreviewsProps,
) {
  // 记录首次挂载时的文本：流式回答若原本无链接、半途长出链接，须按「未落定」初始化，避免半截网址立刻发请求。
  const initialTextRef = useRef(props.text);
  const grewSinceMount = props.text !== initialTextRef.current;
  if (!mayHaveRichPreviews(props.text, props.media)) {
    return null;
  }
  return (
    <MessageRichPreviewsInner
      {...props}
      initiallyUnsettled={grewSinceMount}
    />
  );
});

/** 机器人的 Markdown 正文（频道聊天用）：出卡的链接行拿掉，内联图片不画。 */
export function RichBotStreamdown({
  text,
  components,
}: {
  text: string;
  components: Record<string, unknown>;
}) {
  const display = useDisplayText(text);
  return (
    <SmoothStreamdown components={components as never}>
      {display}
    </SmoothStreamdown>
  );
}

/** Markdown 里的内联图片不在正文里画（避免浏览器直连第三方、也避免和下面的图片卡重复）。 */
export function HiddenMarkdownImage() {
  return null;
}

export { hostOf };
