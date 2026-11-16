import { useRef, useState } from "react";
import { useExternalConnection } from "@/hooks";
import { tryClient } from "@/lib/client";
import { recordServedVersion } from "@/lib/version-skew";
import { type BuildVersion, isNewerBuild } from "../../../shared/system-update";

/**
 * 网页的在线更新（docs/online-update.md）：打包时 vite 注入本次构建号（VITE_CHISABOT_BUILD_ID，
 * 和镜像标签相同），运行时每 5 分钟、以及切回前台 / 窗口获得焦点时问一次 /api/version；
 * 服务器上的构建号变了就显示「有新版本，点此刷新」。从不自动刷新。
 */
export const BUNDLED_BUILD_ID: string =
  import.meta.env.VITE_CHISABOT_BUILD_ID?.trim() || "dev";

export const VERSION_POLL_MS = 5 * 60_000;
/** 切回前台时，距上次检查不足这么久就不再问。 */
const FOCUS_MIN_GAP_MS = 30_000;

export async function fetchServedVersion(
  signal?: AbortSignal,
): Promise<BuildVersion | null> {
  try {
    const response = await tryClient("/api/version", {
      cache: "no-store",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as BuildVersion;
    if (body && typeof body.buildId === "string") {
      if (typeof body.version === "string") recordServedVersion(body.version);
      return body;
    }
    return null;
  } catch {
    return null;
  }
}

/** 有新版本时返回服务器上的版本；用户关掉提示后，同一个构建号不再提示。 */
export function useNewVersion(
  options: { bundled?: string; pollMs?: number } = {},
) {
  const bundled = options.bundled ?? BUNDLED_BUILD_ID;
  const pollMs = options.pollMs ?? VERSION_POLL_MS;
  const [served, setServed] = useState<BuildVersion | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const last = useRef(0);

  useExternalConnection(
    bundled && bundled !== "dev" ? `${bundled}\0${pollMs}` : false,
    (_key, signal) => {
      let inflight: AbortController | null = null;
      const onAbort = () => inflight?.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const check = async () => {
        if (inflight || signal.aborted) return;
        last.current = Date.now();
        const controller = new AbortController();
        inflight = controller;
        try {
          const next = await fetchServedVersion(controller.signal);
          if (!signal.aborted && next) setServed(next);
        } finally {
          if (inflight === controller) inflight = null;
        }
      };
      const timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void check();
      }, pollMs);
      const onFocus = () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - last.current >= FOCUS_MIN_GAP_MS) void check();
      };
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onFocus);
      // 首次检查稍后再做：刚打开的页面一定是最新的，不跟启动抢网络。
      const first = window.setTimeout(() => void check(), 20_000);
      return () => {
        signal.removeEventListener("abort", onAbort);
        window.clearInterval(timer);
        window.clearTimeout(first);
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onFocus);
      };
    },
  );

  const available =
    isNewerBuild(bundled, served) && served?.buildId !== dismissed
      ? served
      : null;
  return {
    available,
    dismiss: () => setDismissed(served?.buildId ?? null),
  };
}
