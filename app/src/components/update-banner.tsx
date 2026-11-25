import {
  IconDownload,
  IconRefresh,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useState } from "react";
import { confirmDialog } from "@/components/ui/confirm";
import { useExternalConnection } from "@/hooks";
import { refreshWouldInterrupt } from "@/lib/activity";
import { DURATION_MS, usePresenceMount, useRetainedValue } from "@/lib/motion";
import { pcBridge, usePcLocal } from "@/lib/pc-bridge";
import { presenceRef } from "@/lib/presence-flag";
import { useNewVersion } from "@/lib/version";

/** 自动刷新的轮询间隔：横幅出现后每这么久问一次「现在刷新会不会丢东西」。 */
export const UPDATE_AUTO_RELOAD_MS = 15_000;

/**
 * 「有新版本，点此刷新」（docs/online-update.md，DESIGN.md §22，CB-135）。
 *
 * 顶部居中的一枚玻璃胶囊（L3），只在服务器上的构建号和这页打包时的不一样时出现；可以关掉，同一个
 * 版本关掉后不再出现。与 PC 客户端更新互斥：当 PC 客户端正在下载或已准备好桌面端更新时，不展示网页刷新条、
 * 也不自动刷新，避免网页刷新与客户端重装/更新同时触发；当 PC 端降级为手动安装
 * （`status === "available" && manualInstall === true`）时，展示桌面端手动下载安装入口并调用 `bridge.installUpdate()`。
 *
 * 自动刷新：页面可能一直开着没人点，横幅出现期间每 {@link UPDATE_AUTO_RELOAD_MS} 问一次
 * `refreshWouldInterrupt()`——返回 null = 刷新无损（机器人没在回复、输入框上没挂没发出去的附件、
 * 没有没发出去的字；聊天输入框里的字记在 localStorage（`lib/chat/ui-memory.ts`），刷新回来还在，
 * 不算丢），这时自动换到新构建，不必等用户点。有损时横幅留着、继续等空下来；用户也可以随时先点——
 * 点击照旧先弹确认框，把各自会丢什么写清，确认后照样强刷。点 ✕ 关掉提示是明确说「现在不换」，
 * 自动刷新一并取消。
 */

type BannerPayload =
  | { kind: "manual"; version: string; key: string }
  | { kind: "web"; version: string };

export function UpdateBanner({
  bundled,
  pollMs,
  autoReloadMs = UPDATE_AUTO_RELOAD_MS,
  reload,
}: {
  bundled?: string;
  pollMs?: number;
  /** 自动刷新的轮询间隔（测试可调小）。 */
  autoReloadMs?: number;
  /** 测试注入；默认 window.location.reload。 */
  reload?: () => void;
} = {}) {
  const { available, dismiss } = useNewVersion({ bundled, pollMs });
  const [pcLocal] = usePcLocal();
  const bridge = pcBridge();
  const [dismissedManualKey, setDismissedManualKey] = useState<string | null>(
    null,
  );

  const manualVersion =
    pcLocal?.update?.status === "available" &&
    pcLocal.update.manualInstall === true
      ? (pcLocal.update.version?.trim() ?? "")
      : null;
  const manualKey =
    manualVersion !== null ? manualVersion || "__manual__" : null;
  const manualVisible = Boolean(manualKey && manualKey !== dismissedManualKey);

  const pcUpdateActive =
    pcLocal?.update?.status === "downloading" ||
    pcLocal?.update?.status === "downloaded";
  const doReload = reload ?? (() => window.location.reload());

  const webVisible = Boolean(
    available && !pcUpdateActive && manualKey === null,
  );
  const payload: BannerPayload | null =
    manualVisible && manualKey !== null
      ? { kind: "manual", version: manualVersion ?? "", key: manualKey }
      : webVisible && available
        ? { kind: "web", version: available.version }
        : null;

  const visible = Boolean(payload);
  const { mounted, onExited } = usePresenceMount(visible, DURATION_MS.exit);
  const retained = useRetainedValue(payload);

  // 自动换到新构建：只在无损（refreshWouldInterrupt() === null）时刷新，有损就等下一轮。
  // 点 ✕ 关掉 / PC 客户端更新在进行时这条连接断开，计时器随之清掉。
  useExternalConnection(
    webVisible ? `auto-reload\0${autoReloadMs}` : false,
    () => {
      const timer = window.setInterval(() => {
        if (refreshWouldInterrupt() !== null) return;
        window.clearInterval(timer);
        doReload();
      }, autoReloadMs);
      return () => window.clearInterval(timer);
    },
  );
  if (!mounted || !retained) return null;

  async function refresh() {
    const blocker = refreshWouldInterrupt();
    if (blocker) {
      const reasons = [
        blocker.running
          ? "刷新后回复会在后台继续，回来时可以在对话里看到结果；正在显示的流式内容会重新加载。"
          : "",
        blocker.attachments > 0
          ? `还有 ${blocker.attachments} 个附件没发出去，刷新后要重新选一遍（附件只在这个页面里，不像聊天草稿会记住）。`
          : "",
        blocker.unsent
          ? "刷新会清掉正在编辑的消息和还没提交的回答；聊天输入框里的草稿会记住，回来还在。"
          : "",
      ].filter(Boolean);
      const ok = await confirmDialog({
        title: blocker.running
          ? "机器人还在回复，现在刷新？"
          : blocker.attachments > 0
            ? "还有没发出去的附件，现在刷新？"
            : "还有没发出去的内容，现在刷新？",
        description: reasons.join(" "),
        confirmLabel: "仍然刷新",
      });
      if (!ok) return;
    }
    doReload();
  }

  const isManual = retained.kind === "manual";
  const manualVersionLabel =
    isManual && retained.version
      ? `v${retained.version.replace(/^v/i, "")}`
      : "";
  const manualText = manualVersionLabel
    ? `有新版本 ${manualVersionLabel} 可手动下载安装`
    : "有新版本可手动下载安装";

  return (
    <div
      className="update-banner"
      data-leaving={!visible ? "true" : undefined}
      data-surface="elevated"
      data-update-banner
      onAnimationEnd={(event) => {
        if (!visible && event.target === event.currentTarget) onExited();
      }}
      ref={presenceRef("has-update-banner")}
      role="status"
      aria-live="polite"
    >
      {isManual ? (
        <>
          <button
            className="update-banner-main"
            onClick={() => {
              void bridge?.installUpdate?.();
            }}
            type="button"
          >
            <IconSparkles
              aria-hidden
              className="update-banner-ic size-4 shrink-0"
            />
            <span className="update-banner-t">{manualText}</span>
            <IconDownload aria-hidden className="size-4 shrink-0" />
          </button>
          <button
            aria-label={"关闭新版本提示"}
            className="update-banner-x"
            onClick={() => setDismissedManualKey(retained.key)}
            type="button"
          >
            <IconX className="size-3.5" />
          </button>
        </>
      ) : (
        <>
          <button
            className="update-banner-main"
            onClick={() => void refresh()}
            type="button"
          >
            <IconSparkles
              aria-hidden
              className="update-banner-ic size-4 shrink-0"
            />
            <span className="update-banner-t">{"有新版本，点此刷新"}</span>
            <span className="update-banner-v">{retained.version}</span>
            <IconRefresh aria-hidden className="size-4 shrink-0" />
          </button>
          <button
            aria-label={"关闭新版本提示"}
            className="update-banner-x"
            onClick={dismiss}
            type="button"
          >
            <IconX className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
