import { type CSSProperties, useState } from "react";
import { usePreviewImage } from "@/components/rich-previews/rich-previews";
import { cn } from "@/lib/utils";
import { emptyMarkProps, InitialMark } from "./initial-mark";
import { ActionArea } from "./rich-context";
import { domainOf, hueOf, safeHttp, safeHttps } from "./rich-utils";

/**
 * 带图的商品 / 地点网格（DESIGN.md §72，CB-050，Hark 的商品网格）：图 + 名字 + 价格 + 一句卖点 + 角标，整张点开商品页。
 *
 * 图不直连第三方：有 `image` 先让服务器转存它，没有（或取不到）就用商品页 `url` 的 og:image
 * （都走 `/api/link-preview`，和链接卡 §48.3 同一套 SSRF 检查、限速、缓存）。都没有时是名字首字 + 稳定色相的底，
 * 不留破图。图位固定 1:1，图晚到不改卡片高度。
 */
type ProductItem = {
  name: string;
  price?: string | null;
  note?: string | null;
  badge?: string | null;
  url?: string | null;
  image?: string | null;
  source?: string | null;
};

function ProductPhoto({ name, image, url }: { name: string; image: string | null; url: string | null }) {
  const { src, loading } = usePreviewImage(image, url);
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        alt=""
        className="jr-product-img"
        decoding="async"
        loading="lazy"
        onError={() => setFailed(true)}
        src={src}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn("jr-product-ph", loading && "is-loading")}
      {...(loading ? {} : emptyMarkProps(name))}
      style={{ "--jr-hue": String(hueOf(name)) } as CSSProperties}
    >
      {loading ? null : <InitialMark kind="item" name={name} />}
    </span>
  );
}

export function Products({ items, columns }: { items: readonly ProductItem[] | null | undefined; columns?: number | null }) {
  const list = Array.isArray(items) ? items.filter((item) => item && typeof item.name === "string") : [];
  if (list.length === 0) return null;
  // 2 / 3 个时一排放完（不留空位）；4 个两排两列；更多时 3 列（模型写的 columns 只在 5 个以上时听，避免 3 个排成 2 列留个洞）。
  const cols = list.length <= 3 ? Math.max(2, list.length) : list.length === 4 ? 2 : Math.min(4, Math.max(2, columns ?? 3));
  return (
    <div className="jr-products jr-el" data-testid="jr-products" style={{ "--jr-cols": String(cols) } as CSSProperties}>
      {list.map((item, index) => {
        const href = safeHttp(item.url ?? undefined) ?? null;
        const image = safeHttps(item.image ?? undefined) ?? null;
        const site = item.source || (href ? domainOf(href) : "");
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: items carry no identity of their own.
          <div className="jr-product" data-testid="jr-product" key={index} style={{ "--jr-i": String(index) } as CSSProperties}>
            <ActionArea affordance="none" className="jr-product-a" item={{ href: href ?? undefined }} label={item.name}>
              <span className="jr-product-media">
                <ProductPhoto image={image} name={item.name} url={href} />
                {item.badge ? <span className="jr-product-badge">{item.badge}</span> : null}
              </span>
              <span className="jr-product-body">
                <span className="jr-product-name">{item.name}</span>
                {item.price ? <span className="jr-product-price">{item.price}</span> : null}
                {item.note ? <span className="jr-product-note">{item.note}</span> : null}
                {site ? <span className="jr-product-site">{site}</span> : null}
              </span>
            </ActionArea>
          </div>
        );
      })}
    </div>
  );
}
