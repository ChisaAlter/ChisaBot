import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { T } from "@/components/ui/button";
import { useOptionalSidebar } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { rememberLeftMode } from "@/lib/cloud-cc";
import { type LeftMode, modeTarget, preloadMode } from "@/lib/left-mode";

/** 方向键换到对面以后，焦点落在新页面的切换上（ARIA radio：方向键换选项，焦点跟着选中项走）。 */
let pendingModeFocus: LeftMode | null = null;

/**
 * 左栏最上面「机器人｜Claude Code」（ADR-0014 修订 ADR-0001，DESIGN.md §73.2 / §84）。
 *
 * 只有一颗，放在 `LeftRail` 里、两块内容之上（2026-10-21 用户要求两边同步）：机器人那边和 Claude Code
 * 那边看到的是同一个控件、同一个位置、同一套尺寸，切换时它不跟着淡入淡出。只有管理员看得到
 * （Claude Code 用的是管理员自己的 Claude 订阅）。切换是同一个外壳里的原地切换：外壳、顶栏、左栏容器
 * 都不动，只换左栏内容和主区；机器人回到上次停的对话，Claude Code 回到上次的会话。空闲时和指针移上来时先把对面预取好。
 */
export function LeftModeSwitch({ mode }: { mode: LeftMode }) {
  const user = useQuery(currentUserQueryOptions());
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sidebar = useOptionalSidebar();
  const admin = user.data?.role === "admin";
  const other: LeftMode = mode === "bots" ? "cc" : "bots";

  // 空闲时预取对面（分包 + 第一眼的数据），第一次点也不等。
  useEffect(() => {
    if (!admin) return;
    const run = () => preloadMode(router, queryClient, other);
    const idle = window.requestIdleCallback?.(run, { timeout: 3000 });
    const timer = idle === undefined ? window.setTimeout(run, 1500) : undefined;
    return () => {
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [admin, other, router, queryClient]);

  const warm = (next: LeftMode) => {
    if (next !== mode) preloadMode(router, queryClient, next);
  };
  const go = (next: LeftMode) => {
    if (next === mode) return;
    rememberLeftMode(next);
    // 手机上切换是在抽屉里点的：和以前一样收起抽屉，直接看到那边的主页面。
    if (sidebar?.isMobile) sidebar.setOpenMobile(false);
    void navigate(modeTarget(next) as Parameters<typeof navigate>[0]);
  };

  const botsRef = useRef<HTMLButtonElement | null>(null);
  const ccRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (pendingModeFocus !== mode) return;
    pendingModeFocus = null;
    (mode === "bots" ? botsRef : ccRef).current?.focus();
  }, [mode]);

  if (!admin) return null;

  /*
   * ARIA 的 radio 组：Tab 只停在当前选中那一项（roving tabindex），方向键换选项、焦点跟着走。
   * 只有两项，所以左右 / 上下都是「换到对面」。
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    if (
      key !== "ArrowRight" &&
      key !== "ArrowLeft" &&
      key !== "ArrowDown" &&
      key !== "ArrowUp"
    )
      return;
    event.preventDefault();
    const next: LeftMode = mode === "bots" ? "cc" : "bots";
    pendingModeFocus = next;
    go(next);
  };

  return (
    <div
      aria-label="左栏内容"
      aria-orientation="horizontal"
      className="sg-segmented cc-mode-switch"
      data-testid="left-mode-switch"
      onKeyDown={onKeyDown}
      role="radiogroup"
    >
      <button
        aria-checked={mode === "bots"}
        className="sg-segmented-item"
        onClick={() => go("bots")}
        onFocus={() => warm("bots")}
        onPointerEnter={() => warm("bots")}
        onPointerDown={() => warm("bots")}
        ref={botsRef}
        role="radio"
        tabIndex={mode === "bots" ? 0 : -1}
        type="button"
      >
        <T>{"机器人"}</T>
      </button>
      <button
        aria-checked={mode === "cc"}
        className="sg-segmented-item"
        data-testid="left-mode-cc"
        onClick={() => go("cc")}
        onFocus={() => warm("cc")}
        onPointerEnter={() => warm("cc")}
        onPointerDown={() => warm("cc")}
        ref={ccRef}
        role="radio"
        tabIndex={mode === "cc" ? 0 : -1}
        type="button"
      >
        <T>{"Claude Code"}</T>
      </button>
    </div>
  );
}
