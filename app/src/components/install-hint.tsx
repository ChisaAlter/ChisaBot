import {
  IconDeviceDesktopDown,
  IconDeviceMobileDown,
  IconPlus,
  IconShare2,
  IconX,
} from "@tabler/icons-react";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isPhone, isStandalone } from "@/lib/device";
import {
  installHintDismissed,
  rememberInstallHintDismiss,
  rememberInstallHintSnooze,
} from "@/lib/install-hint-storage";
import {
  isIOSSafari,
  isNativeClient,
  promptInstall,
  useInstallState,
} from "@/lib/pwa";

/**
 * 「安装 ChisaBot 应用」（DESIGN.md §40.3）。
 *
 * 浏览器里打开网页版时，在顶栏下面居中出现一枚可关闭的玻璃胶囊（与「有新版本」同一种）：
 * - Chrome / Edge（安卓、Windows、macOS…）：浏览器说可以安装时出现，「安装」弹出浏览器自己的安装确认；
 * - iPhone / iPad 的 Safari：点开是一张小卡片，教「点分享 → 添加到主屏幕」；
 * - ChisaBot PC、安卓客户端、已经安装后打开（独立窗口）、引导页：都不出现。
 * 打开页面 8 秒后才出现，不在加载的第一秒打扰；× 永久关掉，安装取消则 14 天暂避（localStorage）。
 * 「有新版本」提示在的时候让位（styles.css）。
 * DOG-03 / dogfood friction 2026-10-19：仅在 beforeinstallprompt（或 iOS Safari）时出现；
 * 装成或点「不再提示」永久关掉；点「安装」后取消/超时 → 14 天内不再出现（DESIGN.md §40.3）；
 * 显示时 body 带 data-install-hint，正文顶距让出胶囊高度，避免盖住标题。
 */
const DELAY_MS = 8000;

export function InstallHint() {
  const { canPrompt, installed } = useInstallState();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(
    () => typeof window !== "undefined" && installHintDismissed(),
  );
  const [iosOpen, setIosOpen] = useState(false);
  const ios = typeof window !== "undefined" && isIOSSafari();

  // 只在浏览器真的可安装（beforeinstallprompt）或 iOS Safari 指引时出现——不可装就别占聊天顶。
  const eligible =
    !gone &&
    !installed &&
    !isStandalone() &&
    !isNativeClient() &&
    (canPrompt || ios) &&
    !pathname.startsWith("/onboarding");

  useEffect(() => {
    if (!eligible || ready) return;
    if (installHintDismissed()) {
      setGone(true);
      return;
    }
    const timer = window.setTimeout(() => setReady(true), DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [eligible, ready]);

  // 关掉动画期间仍占位，避免正文顶距猛地缩回盖住标题一闪。
  const visible = Boolean(eligible && ready && !gone);
  useEffect(() => {
    if (!visible) {
      document.body.removeAttribute("data-install-hint");
      return;
    }
    document.body.setAttribute("data-install-hint", "open");
    return () => document.body.removeAttribute("data-install-hint");
  }, [visible]);

  if (!eligible || !ready || gone) return null;

  const close = (remember: boolean) => {
    if (remember) rememberInstallHintDismiss();
    setClosing(true);
    window.setTimeout(() => setGone(true), 160);
  };

  const install = async () => {
    if (ios) {
      setIosOpen((open) => !open);
      return;
    }
    // 装成 → 永久关掉；取消/超时 → 14 天 snooze（不再每个会话都盖住聊天）；
    // 「不再提示」仍走右上角 X（close(true) → rememberInstallHintDismiss）。
    const accepted = await promptInstall();
    if (accepted) {
      close(true);
      return;
    }
    rememberInstallHintSnooze();
    close(false);
  };

  const DeviceIcon = isPhone() ? IconDeviceMobileDown : IconDeviceDesktopDown;

  return (
    <div
      className="install-hint"
      data-state={closing ? "closed" : "open"}
      role="status"
      aria-live="polite"
    >
      <div className="install-hint-row">
        <button
          className="install-hint-main"
          onClick={() => void install()}
          type="button"
          aria-expanded={ios ? iosOpen : undefined}
        >
          <img
            alt=""
            className="install-hint-logo"
            height={24}
            src="/pwa-any-192.png"
            width={24}
          />
          <span className="install-hint-t">{"安装 ChisaBot 应用"}</span>
          <span className="install-hint-go">
            <DeviceIcon aria-hidden className="size-4" />
            {ios ? "怎么装" : "安装"}
          </span>
        </button>
        <button
          aria-label={"不再提示安装"}
          className="install-hint-x"
          onClick={() => close(true)}
          type="button"
        >
          <IconX className="size-4" />
        </button>
      </div>
      {ios && iosOpen ? (
        <ol className="install-hint-ios">
          <li>
            <span>{"点浏览器的"}</span>
            <span className="install-hint-key">
              <IconShare2 aria-hidden className="size-4" />
              {"分享"}
            </span>
            <span>{"按钮"}</span>
          </li>
          <li>
            <span>{"选择"}</span>
            <span className="install-hint-key">
              <IconPlus aria-hidden className="size-4" />
              {"添加到主屏幕"}
            </span>
          </li>
          <li>{"以后从主屏幕的 ChisaBot 图标打开，全屏、像应用一样使用。"}</li>
        </ol>
      ) : null}
    </div>
  );
}
