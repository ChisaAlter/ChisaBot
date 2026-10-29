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
 *   补充信息 = 给的 meta / 标签 → 给的 description（模型写的一句话）→ GitHub 链接的短标签
 *   （「GitHub · v0.1.13」，{@link shortLinkLabel}）；和站点名或标题重复的不显示。
 * - 兜底（标题只剩域名）时站点那一格换成短地址，免得两行都是同一个域名。
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
};

export type MergedLinkFields = {
  title: string;
  /** 先试的预览图；没有就是 null（画紧凑横卡）。 */
  image: string | null;
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

/**
 * 底下灰字的短标签（没给 meta 时用）：GitHub 的发版 → 版本号（v0.1.13），PR / issue → #123，
 * 仓库首页 → owner/repo。别的站不猜，返回 null。
 */
export function shortLinkLabel(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  if (host !== "github.com") return null;
  const parts = u.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [owner, repo, kind, a, b] = parts;
  if (!owner || !repo) return null;
  if (kind === "releases" && a === "tag" && b) return b;
  if ((kind === "pull" || kind === "issues") && a && /^\d+$/.test(a))
    return `#${a}`;
  if (kind === undefined) return `${owner}/${repo}`;
  return null;
}

function bare(value: string): string {
  return value
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[\s._\-·|/]+/g, "");
}

/**
 * 标题是不是只写了站点名：和站点名、域名（去掉 www.）、域名主体（github.com → github）之一相同，忽略大小写、空格和标点。
 * 例：「GitHub」「github.com」「World Coffee Map」（站点名就是它）都算；「Release ChisaBot v0.1.13」不算。
 */
export function isSiteOnlyTitle(
  title: string | null | undefined,
  site: string | null | undefined,
  url: string,
): boolean {
  const t = bare(text(title));
  if (!t) return false;
  const host = linkHost(url).toLowerCase();
  const labels = host.split(".");
  const main = labels.length >= 2 ? labels[labels.length - 2] : host;
  return [text(site), host, main ?? ""].some(
    (candidate) => candidate !== "" && bare(candidate) === t,
  );
}

/**
 * 给的字段够不够画卡、还要不要去问 `/api/link-preview`：标题、图、站点名缺一个就要问；
 * 传了地址时，标题只是站点名也要问（换成 og:title）。
 */
export function needsLinkPreview(
  given: GivenLinkFields,
  url?: string,
): boolean {
  return (
    !text(given.title) ||
    !usableImage(given.image) ||
    !text(given.siteName) ||
    (url !== undefined && isSiteOnlyTitle(given.title, given.siteName, url))
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
  const title =
    (isWeakLinkTitle(givenTitle, ogTitle, names) ? ogTitle : givenTitle) ||
    text(preview?.title) ||
    domain;
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
  const extra =
    [text(given.meta), text(given.description), shortLinkLabel(url) ?? ""].find(
      (value) => value && !same(value, site) && !same(value, title),
    ) ?? null;
  if (title === site && title === domain) site = shortLinkUrl(url);
  return {
    title,
    image,
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
