import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { isStaleChunkError, reloadForStaleChunk } from "@/lib/stale-chunk";

/**
 * Whether a pending route is drawn inside a shell (app, settings, admin) that is already on screen.
 * Inside one, only the content area needs a placeholder; outside, the whole frame does.
 */
const ShellContext = createContext(false);

export function ShellBoundary({ children }: { children: ReactNode }) {
  return <ShellContext.Provider value={true}>{children}</ShellContext.Provider>;
}

/** After this long a load is no longer "a moment", and a gentle way out is fair to offer. */
const SLOW_HINT_MS = 10_000;

function useSlow(ms: number) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return slow;
}

function Bar({ w, h = 12 }: { w: string; h?: number }) {
  return <span className="sky-skel-bar block" style={{ width: w, height: h }} />;
}

/**
 * The full-frame placeholder: the sky, the top bar, the roster, the conversation and the panel
 * column as soft glass shapes. Mirrors the static markup in `index.html` so the hand-off from the
 * pre-JS shell to React is invisible.
 */
export function AppSkeleton({ failed = false }: { failed?: boolean }) {
  const slow = useSlow(SLOW_HINT_MS);
  return (
    <div aria-busy={!failed} aria-label="正在加载 ChisaBot" className={failed ? "sky-skel is-failed" : "sky-skel"} role={failed ? "alert" : "status"}>
      <div className="sky-skel-top">
        <span className="sky-skel-dot sky-skel-block" />
        <span className="sky-skel-seg sky-skel-glass" />
        <span className="sky-skel-right">
          <span className="sky-skel-search sky-skel-glass" />
          <span className="sky-skel-dot sky-skel-glass" />
        </span>
      </div>
      <div className="sky-skel-cols">
        <div className="sky-skel-col">
          <span className="sky-skel-block" style={{ height: 46, borderRadius: 999 }} />
          <div className="sky-skel-card">
            <Bar w="40%" h={10} />
            <Bar w="85%" />
            <Bar w="70%" />
            <Bar w="78%" />
          </div>
          <div className="sky-skel-card" style={{ flex: 1 }}>
            <Bar w="30%" h={10} />
            <Bar w="90%" />
            <Bar w="65%" />
            <Bar w="80%" />
            <Bar w="55%" />
          </div>
        </div>
        <div className="sky-skel-col sky-skel-main">
          <Bar w="34%" />
          <Bar w="52%" />
          <span className="sky-skel-block sky-skel-glass" style={{ width: "min(640px, 100%)", height: 96, borderRadius: 22 }} />
        </div>
        <div className="sky-skel-col">
          <span className="sky-skel-bar" style={{ width: "40%", height: 14, marginTop: 14 }} />
          <div className="sky-skel-card">
            <Bar w="50%" />
            <span className="sky-skel-block" style={{ height: 64 }} />
            <Bar w="35%" />
          </div>
        </div>
      </div>
      {failed ? (
        <div className="sky-skel-hint">
          <span>页面没能加载出来，请检查网络连接</span>
          <button onClick={() => window.location.reload()} type="button">重新加载</button>
        </div>
      ) : slow ? (
        <div className="sky-skel-hint">
          <span>加载时间比平时长一些…</span>
          <button onClick={() => window.location.reload()} type="button">重新加载</button>
        </div>
      ) : (
        // CB-100c：骨架本身很淡，首屏慢的时候看起来像白屏。前 10 秒给一句看得见的「正在加载」。
        <div aria-hidden className="sky-skel-hint is-loading" data-testid="startup-loading-caption">
          <span className="sky-skel-spinner" />
          <span>正在加载 ChisaBot…</span>
        </div>
      )}
    </div>
  );
}

/** Content-area placeholder for a route whose shell is already drawn. */
export function RouteSkeleton() {
  return (
    <div aria-busy="true" aria-label="正在加载" className="route-skel" role="status">
      <Bar w="28%" h={20} />
      <Bar w="52%" />
      <span className="sky-skel-block sky-skel-glass" style={{ height: 72, marginTop: 14 }} />
      <span className="sky-skel-block sky-skel-glass" style={{ height: 120 }} />
      <span className="sky-skel-block sky-skel-glass" style={{ height: 72 }} />
    </div>
  );
}

/** The router's default pending state: inline when a shell is on screen, the full frame otherwise. */
export function StartupPending() {
  return useContext(ShellContext) ? <RouteSkeleton /> : <AppSkeleton />;
}

export function StartupFailure({ error }: { error?: unknown } = {}) {
  const inShell = useContext(ShellContext);
  // 部署后旧页面要的分包已不存在：自动刷新一次拿新版本（lib/stale-chunk.ts），刷新前先显示骨架而不是报错。
  const stale = isStaleChunkError(error);
  const [reloading] = useState(() => stale && reloadForStaleChunk());
  if (reloading) return inShell ? <RouteSkeleton /> : <AppSkeleton />;
  if (inShell) {
    return (
      <div className="route-skel" role="alert">
        <div className="sky-skel-hint" style={{ position: "static", transform: "none", alignSelf: "center", marginTop: 80 }}>
          <span>无法加载此页面，请检查网络连接</span>
          <button onClick={() => window.location.reload()} type="button">重新加载</button>
        </div>
      </div>
    );
  }
  return <AppSkeleton failed />;
}
