/**
 * 链接卡显示什么（2026-10-29，Hark 式链接卡）：模型 / 正文给的字段和 `/api/link-preview` 取到的字段合在一起。
 *
 * - 给了的字段优先（json-render Link 里模型写的 title / image / meta，正文链接的 `[标签](网址)`）；
 *   缺的预览图、标题、站点名用预览补上。
 * - 例外（小爱审查 #380）：给的标题只是站点名 / 域名（「GitHub」「github.com」），或者整个被 og:title 包含
 *   （「ChisaBot」⊂「GitHub - ChisaAlter/ChisaBot」），说明它比 og:title 信息少，改用 og:title。
 *   比较忽略大小写和首尾空白。
 * - 预览图：给的 https 图在前，预览的本站转存图（/api/link-preview/asset/…）在后，前一张加载失败就换后一张。
 * - 底下一行是「站点 · 补充信息」：站点 = 给的站点名 → 预览的 og:site_name → 域名；
 *   补充信息 = 给的 meta / 标签 → 给的 description（模型写的一句话）；和站点名或标题重复的不显示。
 * - 兜底（标题只剩域名）时站点那一格换成短地址，免得两行都是同一个域名。
 *
 * - 标题去掉开头的「GitHub - 」（旧缓存里的 GitHub 标题；卡上标题固定两行，前缀太占地方）。
 * - GitHub 仓库的星标（预览的 `stars`）在没有别的补充信息时当补充信息：「★ 1.2k」。
 *
 * 纯函数，测试见 app/tests/link-card-unified.test.tsx。
 */

export type GivenLinkFields = {
  title?: string | null;
  image?: string | null;
  siteName?: string | null;
  meta?: string | null;
  description?: string | null;
};

export type PreviewLinkFields = {
  title?: string;
  siteName?: string;
  domain?: string;
  description?: string;
  image?: string | null;
  imageKind?: string;
  favicon?: string | null;
  imageWidth?: number;
  imageHeight?: number;
  finalUrl?: string;
  degraded?: boolean;
  stars?: number;
};

export type MergedLinkFields = {
  title: string;
  /** 先试的预览图；没有就是 null（卡片画生成的横幅，仍是竖版大卡）。 */
  image: string | null;
  /** 预览图是不是 GitHub 仓库主人的头像（方图，画成横幅里的大头像）。 */
  imageAvatar: boolean;
  /** `image` 加载失败时换这张（给的图失败 → 预览图）；没有就 null。 */
  imageFallback: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  site: string;
  extra: string | null;
  domain: string;
  favicon: string | null;
  description: string | null;
  degraded: boolean;
};

/** 卡片标题：去掉开头的「GitHub - 」。 */
export function cleanLinkTitle(title: string): string {
  return title.replace(/^GitHub\s*[-–—]\s*/i, "").trim() || title;
}

/** 星标数的短写法：999、1.2k、12k、1.3m。 */
export function formatStars(stars: number): string {
  if (stars < 1000) return String(stars);
  if (stars < 10_000)
    return `${(stars / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (stars < 1_000_000) return `${Math.round(stars / 1000)}k`;
  return `${(stars / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * 给的标题是不是比 og:title 信息少：等于站点名、域名（含 / 不含 www.、只取主名如 github），
 * 或者整个被 og:title 包含。两边都已经 text() 过（压空白、去首尾空白）；比较忽略大小写。
 */
export function isWeakLinkTitle(
  given: string,
  ogTitle: string,
  names: readonly string[],
): boolean {
  if (!given || !ogTitle || same(given, ogTitle)) return false;
  const bare = given.replace(/^www\./i, "");
  if (names.some((name) => name && (same(given, name) || same(bare, name))))
    return true;
  return ogTitle.toLowerCase().includes(given.toLowerCase());
}

function domainNames(domain: string): string[] {
  const bare = domain.replace(/^www\./i, "");
  return [domain, bare, bare.split(".")[0] ?? ""];
}

/** 只认 https 的完整地址和本站的 /api/ 相对地址（转存图）。 */
export function usableImage(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  if (raw.startsWith("/api/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** 兜底卡用的短地址：github.com/ChisaAlter/Chis… */
export function shortLinkUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/$/, "");
    const value = `${u.hostname.replace(/^www\./, "")}${path}`;
    return value.length > 48 ? `${value.slice(0, 47)}…` : value;
  } catch {
    return url;
  }
}

/** 给的字段够不够画卡、还要不要去问 `/api/link-preview`：标题、图、站点名缺一个就要问。 */
export function needsLinkPreview(given: GivenLinkFields): boolean {
  return (
    !text(given.title) || !usableImage(given.image) || !text(given.siteName)
  );
}

export function mergeLinkFields(
  url: string,
  given: GivenLinkFields,
  preview?: PreviewLinkFields | null,
): MergedLinkFields {
  const domain = text(preview?.domain) || linkHost(url);
  const degraded = preview?.degraded === true;
  const givenTitle = text(given.title);
  const ogTitle = degraded ? "" : text(preview?.title);
  const names = [
    text(given.siteName),
    text(preview?.siteName),
    ...domainNames(domain),
    ...domainNames(linkHost(url)),
  ];
  const title = cleanLinkTitle(
    (isWeakLinkTitle(givenTitle, ogTitle, names) ? ogTitle : givenTitle) ||
      text(preview?.title) ||
      domain,
  );
  const givenImage = usableImage(given.image);
  const previewImage =
    preview && preview.imageKind !== "none" ? usableImage(preview.image) : null;
  const image = givenImage ?? previewImage;
  const imageFallback =
    givenImage && previewImage && previewImage !== givenImage
      ? previewImage
      : null;
  // 宽高只对预览图有效（服务器量的）；先用给的图时不知道它多大。
  const sized = image === previewImage && previewImage !== null;
  const width = sized ? Number(preview?.imageWidth) : Number.NaN;
  const height = sized ? Number(preview?.imageHeight) : Number.NaN;
  let site = text(given.siteName) || text(preview?.siteName) || domain;
  const stars =
    typeof preview?.stars === "number" && preview.stars >= 0
      ? `★ ${formatStars(preview.stars)}`
      : "";
  const extra =
    [text(given.meta), text(given.description), stars].find(
      (value) => value && !same(value, site) && !same(value, title),
    ) ?? null;
  if (title === site && title === domain) site = shortLinkUrl(url);
  return {
    title,
    image,
    imageAvatar:
      image !== null &&
      image === previewImage &&
      preview?.imageKind === "avatar",
    imageFallback,
    imageWidth: width > 0 ? Math.round(width) : null,
    imageHeight: height > 0 ? Math.round(height) : null,
    site,
    extra,
    domain,
    favicon: usableImage(preview?.favicon),
    description: text(given.description) || text(preview?.description) || null,
    degraded,
  };
}
