import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { Children, type ReactNode } from "react";

import {
  type AsyncState,
  type Feedback,
  type FeedbackLabels,
  type MutationLike,
  resolveFeedback,
  useMutationFeedback,
} from "@/components/ui/async-action";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[var(--shadow-1)] hover:bg-[var(--ink-primary-hover)]",
        outline:
          "border-[var(--line-strong)] bg-[var(--glass-2)] hover:bg-[var(--glass-3)] hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-6 gap-1 px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 text-[13px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-5 text-[15px] has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-8 rounded-[10px]",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  render,
  /*
   * DIVERGES FROM UPSTREAM SHADCN. Base UI defaults `nativeButton` to `true`, which is right only
   * while the element really is a `<button>`. Six call sites here draw a router `Link` through
   * `render` instead — "New skill", "New agent", the sidebar's new-channel control, the two
   * empty-state returns, and `PageShell`'s back button, which is five routes in every state each of
   * them has — and every one of them warned at render that it had been told to expect a native
   * button and found an anchor. It was not only noise: Base UI was putting `type="button"` on an
   * anchor, which means nothing there, and withholding the `role="button"` and Space-to-activate
   * handling a non-button needs in order to behave like one.
   *
   * Replacing the element is exactly the case where the default is wrong, so the default follows
   * `render`, once here rather than at every call site. Passing `render` is not proof the result is
   * a non-button, only that we can no longer assume it is one, so a call site drawing a real
   * `<button>` through `render` passes `nativeButton` back explicitly — `combobox.tsx` is the one
   * that does.
   */
  nativeButton = render === undefined,
  /** Shorthand for `state="pending"` — kept for call sites that only know "busy or not". */
  loading = false,
  /**
   * DESIGN.md §2 state machine: idle → pending → success / error. Drive it with
   * `useMutationFeedback(mutation)` or `useAsyncAction(fn).state`.
   */
  state,
  /**
   * Status copy (a preset like "save" or `{ pending, success, error }`). With it the button
   * cross-fades between its idle children and "保存中… / 已保存 / 保存失败", sized to the widest so
   * nothing around it moves. Without it, non-idle states only swap the glyph in front of children.
   */
  feedback,
  /**
   * A TanStack mutation to follow instead of passing `state`: the button runs the state machine off
   * its status. `mutationWhen` narrows a mutation shared by several rows to this one.
   */
  mutation,
  mutationWhen = true,
  disabled,
  children,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
    state?: AsyncState;
    feedback?: Feedback;
    mutation?: MutationLike;
    mutationWhen?: boolean;
  }) {
  const followed = useMutationFeedback(
    mutation ?? IDLE_MUTATION,
    mutation !== undefined && mutationWhen,
  );
  const active: AsyncState =
    state && state !== "idle"
      ? state
      : followed !== "idle"
        ? followed
        : loading
          ? "pending"
          : "idle";
  const labels = resolveFeedback(feedback);
  const iconOnly = typeof size === "string" && size.startsWith("icon");
  const liveName = labels && active !== "idle" ? labels[active] : undefined;
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? "default"}
      data-btn-state={active}
      aria-busy={active === "pending" || undefined}
      data-loading={active === "pending" ? "true" : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || active === "pending"}
      nativeButton={nativeButton}
      render={render}
      {...props}
      // Single live accessible name matching the visible state (not stacked 复制/已复制/复制失败).
      aria-label={
        liveName ?? (props as { "aria-label"?: string })["aria-label"]
      }
    >
      <AsyncContent
        iconOnly={iconOnly}
        labels={labels}
        stacked={
          Boolean(labels) ||
          (iconOnly && (state !== undefined || mutation !== undefined))
        }
        state={active}
      >
        {children}
      </AsyncContent>
    </ButtonPrimitive>
  );
}

/**
 * The inside of an async button, for the rare control that cannot be `Button` (a glass pill with
 * its own look): put `data-btn-state={state}` on the element and this inside it.
 */
export function AsyncContent({
  state,
  labels,
  stacked = true,
  iconOnly = false,
  children,
}: {
  state: AsyncState;
  labels: FeedbackLabels | null;
  stacked?: boolean;
  iconOnly?: boolean;
  children?: ReactNode;
}) {
  if (!stacked) {
    return (
      <>
        {state !== "idle" ? <StatusGlyph /> : null}
        {labelText(children)}
      </>
    );
  }
  return (
    <span className="btn-stack" data-state={state}>
      <span
        aria-hidden={state !== "idle" || undefined}
        className="btn-face"
        data-face="idle"
      >
        {labelText(children)}
      </span>
      <span
        aria-hidden={state === "idle" || undefined}
        className="btn-face"
        data-face="status"
      >
        <StatusGlyph />
        {labels && !iconOnly ? (
          <span aria-hidden="true" className="btn-labels">
            <span className="btn-t" data-for="pending">
              {labels.pending}
            </span>
            <span className="btn-t" data-for="success">
              {labels.success}
            </span>
            <span className="btn-t" data-for="error">
              {labels.error}
            </span>
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * DESIGN.md §82.2：按钮里的裸文字包一层 `.btn-t`（inline-block + `text-box: trim-both cap alphabetic`），
 * 让文字盒只剩「大写字母顶 → 基线」，再由按钮的 flex 居中。不包的话按钮居中的是字体的 ascent + descent，
 * 中文字形在文泉驿下偏上 1–2px、在 Noto Sans CJK 下偏上 0.5–1px；包了以后两种字体都在 ±0.5px 内。
 * 只包字符串 / 数字；图标和别的元素原样放着（`truncate` 的 span 不能包：裁掉的盒子会把字形裁掉）。
 */
export function labelText(children: ReactNode): ReactNode {
  if (typeof children === "string" || typeof children === "number")
    return <span className="btn-t">{edgePunct(String(children))}</span>;
  const items = Children.toArray(children);
  if (
    !items.some(
      (child) => typeof child === "string" || typeof child === "number",
    )
  )
    return children;
  // 连着的几段文字（「全部 」{n}）合成一个 span：分开包的话按钮的 gap 会插在它们中间。
  const out: ReactNode[] = [];
  let text: (string | number)[] = [];
  const flush = () => {
    if (!text.length) return;
    const joined = text.join("");
    out.push(
      joined.trim() ? (
        <span className="btn-t" key={`t${out.length}`}>
          {edgePunct(joined)}
        </span>
      ) : (
        joined
      ),
    );
    text = [];
  };
  for (const child of items) {
    if (typeof child === "string" || typeof child === "number")
      text.push(child);
    else {
      flush();
      out.push(child);
    }
  }
  flush();
  return out;
}

const OPEN_PUNCT = "（「『【〈《〔";
const CLOSE_PUNCT = "）」』】〉》〕";

/**
 * §82.7：标签首尾的全角括号 / 引号各包一层 `.t-open` / `.t-close`。字体不带 `halt` 时（<html data-no-halt>，
 * lib/halt.ts 量出来的）它们收掉空着的那半个字宽，「检查（不生成图片）」的墨迹才居中；带 halt 的字体不变。
 */
export function edgePunct(text: string): ReactNode {
  const head = text.length > 1 && OPEN_PUNCT.includes(text[0]!) ? text[0]! : "";
  const tail =
    text.length > 1 && CLOSE_PUNCT.includes(text[text.length - 1]!)
      ? text[text.length - 1]!
      : "";
  if (!head && !tail) return text;
  const middle = text.slice(head ? 1 : 0, tail ? -1 : undefined);
  return (
    <>
      {head ? <span className="t-open">{head}</span> : null}
      {middle}
      {tail ? <span className="t-close">{tail}</span> : null}
    </>
  );
}

/** 胶囊 / 小标签里的文字（不是 `Button` 的那些）用同一层，和按钮一样居中。 */
export function T({ children }: { children?: ReactNode }) {
  return (
    <span className="btn-t">
      {typeof children === "string" ? edgePunct(children) : children}
    </span>
  );
}

const IDLE_MUTATION: MutationLike = { status: "idle", submittedAt: 0 };

/**
 * One SVG for every non-idle state so pending → success is a morph, not a swap: the spinning arc
 * closes into a full ring and fades while the check (or ✕) draws itself. Colour and motion live in
 * styles.css under `.btn-glyph`, keyed off the button's `data-btn-state`.
 */
export function StatusGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="btn-glyph"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.4}
      viewBox="0 0 24 24"
    >
      <circle
        className="btn-glyph-ring"
        cx="12"
        cy="12"
        pathLength={100}
        r="9"
      />
      <path
        className="btn-glyph-check"
        d="M7.5 12.4l3.1 3.1 6-6.6"
        pathLength={100}
      />
      <path className="btn-glyph-x" d="M9 9l6 6M15 9l-6 6" pathLength={100} />
    </svg>
  );
}

export { Button, buttonVariants };
