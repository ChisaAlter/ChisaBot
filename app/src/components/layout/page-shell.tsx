import { IconChevronLeft } from "@tabler/icons-react";
import { Link, type LinkProps, useRouterState } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The frame every configuration screen sits in.
 *
 * WHAT THIS IS FIXING. Admin was nine pages that shared no layout: four container widths plus three
 * pages with no container at all, four heading sizes, four padding schemes, and a sidebar 20px wider
 * than the rest of the app. Three of those pages imported nothing from `components/ui` and drew
 * their own buttons, inputs and tables. The result did not read as a different screen, it read as a
 * different application — which is the impression an administrator forms at exactly the moment they
 * are deciding whether to trust it with credentials.
 *
 * The shape was never in doubt: Skills and Settings already had it. So this is that shape, extracted
 * once and used everywhere, INCLUDING by Skills and Settings. Leaving those two as hand-written
 * copies would mean three dialects rather than two, and the next screen somebody writes copies
 * whichever it happened to see first.
 */

/**
 * `prose` is the default because configuration is mostly reading. A measure of around 65 characters
 * is where prose stays comfortable, and a row of label-and-control has no business being wider than
 * the sentence explaining it.
 *
 * `wide` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. It is not a licence for anything else to be wide.
 */
type ShellWidth = "prose" | "wide";

/* DESIGN.md §10.3: list / settings pages 880, admin and design pages 1080. */
const WIDTHS: Record<ShellWidth, string> = {
  prose: "max-w-[880px]",
  wide: "max-w-[1080px]",
};

/** The eyebrow a page gets when it does not name one: the area it lives in. */
function areaOf(pathname: string): { label: string; to: string } | null {
  if (pathname.startsWith("/settings") || pathname.startsWith("/admin")) return { label: "设置", to: "/settings" };
  return null;
}

/**
 * The one page header (DESIGN.md §9.5): eyebrow / breadcrumb (12) → title (24/600) → description
 * (14, ≤620px) → actions on the right. Every screen drawn through PageShell gets exactly this.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  className,
  media,
}: {
  /** 标题左边的头像 / 图标（机器人资料页，DESIGN.md §47）。 */
  media?: React.ReactNode;
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("ph", media ? "has-media" : null, className)} data-slot="page-header">
      {media && eyebrow ? <div className="ph-eyebrow ph-eyebrow-row">{eyebrow}</div> : null}
      {media ? <div className="ph-media">{media}</div> : null}
      <div className="ph-main">
        {eyebrow && !media ? <div className="ph-eyebrow">{eyebrow}</div> : null}
        <h1 className="ph-title page-title">{title}</h1>
        {description ? <p className="ph-desc">{description}</p> : null}
      </div>
      {action ? <div className="ph-actions">{action}</div> : null}
    </header>
  );
}

export function PageShell({
  action,
  children,
  className,
  description,
  eyebrow,
  media,
  title,
  width,
  backButton,
}: {
  /** 标题左边的头像 / 图标。 */
  media?: React.ReactNode;
  /** Sits at the header's right. For the page's one primary verb, if it has one. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  /** Overrides the default eyebrow (the area name, or the back link as a breadcrumb). */
  eyebrow?: React.ReactNode;
  title: string;
  /** Defaults to `wide` in admin (template E) and `prose` everywhere else. */
  width?: ShellWidth;
  backButton?: {
    linkProps: LinkProps;
    label: string;
  };
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const area = areaOf(pathname);
  const resolvedWidth: ShellWidth = width ?? (pathname.startsWith("/admin") ? "wide" : "prose");
  const sharedRail = pathname.startsWith("/settings") || pathname.startsWith("/admin");

  /*
   * The back link is a breadcrumb now, not a band of chrome above the page: "管理后台 / 插件 /"
   * then the title. The old 56px bar existed to hold the sidebar toggle, which the unified top bar
   * owns on every screen (DESIGN.md §13).
   */
  const crumbs =
    eyebrow ??
    (backButton ? (
      <>
        {area ? (
          <>
            <Link to={area.to}>{area.label}</Link>
            <span aria-hidden className="ph-crumb-sep">
              {"/"}
            </span>
          </>
        ) : null}
        <Link {...backButton.linkProps} className="ph-crumb-back">
          <IconChevronLeft className="size-3.5" />
          {backButton.label}
        </Link>
      </>
    ) : null);
  // Top-level pages carry no eyebrow: the left column already names the area (偏好设置 / 管理后台).

  return (
    /*
     * The scroller lives here because the shell is one viewport that never scrolls (panes scroll
     * inside it). `min-h-0` is the load-bearing half of `min-h-0 flex-1`: a flex item's default
     * `min-height: auto` would otherwise grow this past the pane and clip the page.
     */
    <div className="page-scroll min-h-0 flex-1 overflow-y-auto" data-slot="page-shell">
      <div
        className={cn(
          "page mx-auto flex w-full flex-col",
          WIDTHS[resolvedWidth],
          className,
        )}
        /*
         * 设置和管理后台共用一条左栏（DESIGN.md §34.2）：880 宽的页和 1080 宽的页左边必须在同一条线上，
         * 否则在左栏里切换分区时标题和卡片会左右跳。窄页按 1080 的左边对齐，右边留空。
         */
        style={
          sharedRail && resolvedWidth === "prose"
            ? { marginLeft: "max(0px, calc((100% - 1080px) / 2))", marginRight: "auto" }
            : undefined
        }
      >
        <PageHeader action={action} description={description} eyebrow={crumbs} media={media} title={title} />
        {children}
      </div>
    </div>
  );
}

/**
 * A titled group of rows.
 *
 * The gap above a section is deliberately large. These pages are lists of unrelated decisions, and
 * the space is what stops the eye running two of them together — it is doing the work a divider
 * would otherwise do, without drawing a line.
 */
export function PageSection({
  action,
  children,
  className,
  description,
  title,
  id,
  settingItem,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title?: string;
  /** 页内锚点（设置搜索跳转、「了解更多」，DESIGN.md §97）。 */
  id?: string;
  /** 设置搜索的稳定锚点：registry 里的 `页.项` id，多个用空格分开（lib/settings/locate.ts）。 */
  settingItem?: string;
}) {
  return (
    <section className={cn("page-section", className)} data-setting-item={settingItem} data-slot="page-section" id={id}>
      {title || description || action ? (
        <div className="sh">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="sh-title page-section-title">{title}</h2> : null}
            {description ? <p className="sh-desc">{description}</p> : null}
          </div>
          {action ? <div className="sh-actions">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The card that rows live in.
 *
 * Rows are `<Item size="sm">` with a `<Separator />` between them; this is only the border around
 * them. Rendering nothing when there is nothing is deliberate — an empty bordered box reads as a
 * thing that failed to load, where absence reads as nothing to see yet.
 */
export function PageRows({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    /*
     * The rows are squared off and the card clips them. `Item` carries `rounded-lg` of its own, which
     * inside a card of divided rows painted a hover as a floating pill: a middle row has no corners,
     * and the first and last cannot be concentric with the card while sitting a border inside it.
     */
    <div
      className={cn(
        "page-rows overflow-hidden",
        "[&_[data-slot=item]]:rounded-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * What a section says when it has nothing to list.
 *
 * Said in a sentence rather than drawn as an illustration with a heading: on a configuration screen
 * "nothing here yet" is a fact, not an event, and the page already told you what the section is for.
 */
export function PageEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="page-empty" data-slot="page-empty">
      {children}
    </p>
  );
}

/**
 * A list that has been asked for and has not arrived: rows the shape of the ones it will hold, in
 * the same glass card, so the page does not jump when the data lands.
 */
export function PageSkeleton({ rows = 3, tall = false }: { rows?: number; tall?: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-label={"正在加载"}
      className="page-rows page-skeleton"
      role="status"
    >
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态列表：只追加、不重排、没有稳定 id
        <div className="page-skeleton-row" key={index}>
          {tall ? null : <span className="sky-skel-glass page-skeleton-dot" />}
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span
              className="sky-skel-glass page-skeleton-bar"
              style={{ width: tall ? "100%" : `${58 - index * 9}%`, height: tall ? 120 : undefined }}
            />
            {tall ? null : (
              <span className="sky-skel-glass page-skeleton-bar is-sub" style={{ width: `${36 - index * 5}%` }} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
