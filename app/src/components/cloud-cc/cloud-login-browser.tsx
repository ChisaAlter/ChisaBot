import { IconArrowLeft, IconLoader2, IconLock, IconRefresh, IconShieldCheck, IconAlertTriangle, IconWorld } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CcBrowserInput, CcBrowserOp, ClaudeAuth } from "../../../../shared/cloud-cc";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

type Egress = Extract<CcBrowserOp, { op: "state" }>["egress"];
const SPECIAL = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * 「在云端完成登录」（DESIGN.md §73.8）：云端节点容器里的浏览器画面嵌在设置页里，你在这里点、打字，授权页跳到回调地址时
 * 节点自动拿到授权码完成 `claude auth login`。你的浏览器不碰 claude.com，登录和 Claude Code 用同一个出口 IP。
 * 键盘：点画面后输入（中文输入法、粘贴都可以）；密码只经过这条连接打进远程浏览器，不记录。
 */
export function CloudLoginBrowser({ onDone, onCancel, phone }: { onDone: (claude: ClaudeAuth) => void; onCancel: (error?: string) => void; phone: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const [login, setLogin] = useState<{ id: string; width: number; height: number; expiresAt: string } | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [egress, setEgress] = useState<Egress | null>(null);
  const [phase, setPhase] = useState<"starting" | "live" | "captured" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const queue = useRef<CcBrowserInput[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loginRef = useRef(login);
  loginRef.current = login;
  const doneRef = useRef(false);

  // 开始：按容器宽度定远程画面大小（桌面最宽 1000，手机就是屏宽）
  useLayoutEffect(() => {
    let cancelled = false;
    const w = wrap.current?.clientWidth ?? 800;
    const width = Math.max(320, Math.min(phone ? Math.round(w) : 1000, 1280));
    const height = phone ? 640 : 680;
    client("/api/cloud-workspace/claude/login/browser", { method: "POST", body: { width, height, mobile: phone }, fallback: "没能在云端打开浏览器" })
      .then((r) => r.json() as Promise<{ id: string; width: number; height: number; expiresAt: string }>)
      .then((r) => {
        if (cancelled) {
          void client(`/api/cloud-workspace/claude/login/${encodeURIComponent(r.id)}`, { method: "DELETE" }).catch(() => {});
          return;
        }
        setLogin(r);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setPhase("error");
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [phone]);

  // 画面流
  useEffect(() => {
    if (!login) return;
    const source = new EventSource(`/api/cloud-workspace/claude/login/browser/${encodeURIComponent(login.id)}/stream`, { withCredentials: true });
    source.onmessage = (event) => {
      let op: CcBrowserOp | { op: "ping" };
      try {
        op = JSON.parse(event.data);
      } catch {
        return;
      }
      if (op.op === "frame") {
        setFrame(`data:image/jpeg;base64,${op.data}`);
        setPhase((p) => (p === "starting" ? "live" : p));
      } else if (op.op === "state") {
        if (op.url !== undefined) setUrl(op.url);
        if (op.egress) setEgress(op.egress);
        if (op.captured) setPhase("captured");
        if (op.closed && !doneRef.current) {
          setPhase("error");
          setError(op.reason === "取消" ? null : `云端浏览器关了（${op.reason ?? "未知原因"}）。可以重新开始，或者用粘贴授权码。`);
        }
      } else if (op.op === "done") {
        doneRef.current = true;
        source.close();
        if (op.ok) onDone(op.claude);
        else {
          setPhase("error");
          setError(op.error ?? "登录没有成功");
        }
      }
    };
    return () => source.close();
  }, [login, onDone]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = login ? Math.max(0, Date.parse(login.expiresAt) - now) : 0;

  // 离开页面：关掉远程浏览器
  useEffect(
    () => () => {
      const l = loginRef.current;
      if (l && !doneRef.current) void client(`/api/cloud-workspace/claude/login/${encodeURIComponent(l.id)}`, { method: "DELETE" }).catch(() => {});
    },
    [],
  );

  // 输入按顺序发：同一时间只有一个请求在路上（并发的请求可能乱序，Tab 和回车颠倒就点错了）
  const inFlight = useRef(false);
  const flush = useCallback(() => {
    flushTimer.current = null;
    const l = loginRef.current;
    if (!l || !queue.current.length || inFlight.current) return;
    const events = queue.current.splice(0, 200);
    inFlight.current = true;
    void client(`/api/cloud-workspace/claude/login/browser/${encodeURIComponent(l.id)}/input`, { method: "POST", body: { events } })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (queue.current.length) flush();
      });
  }, []);
  const push = useCallback(
    (e: CcBrowserInput, soon = false) => {
      const q = queue.current;
      // 连续的移动只留最后一个
      if (e.t === "mouse" && e.type === "mouseMoved" && q.length && q[q.length - 1]!.t === "mouse" && (q[q.length - 1] as { type: string }).type === "mouseMoved") q[q.length - 1] = e;
      else q.push(e);
      if (soon) {
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flush();
      } else if (!flushTimer.current) flushTimer.current = setTimeout(flush, 60);
    },
    [flush],
  );

  const point = (clientX: number, clientY: number) => {
    const r = img.current?.getBoundingClientRect();
    if (!r || !login) return { x: 0, y: 0 };
    return { x: Math.round(((clientX - r.left) / r.width) * login.width), y: Math.round(((clientY - r.top) / r.height) * login.height) };
  };
  const pressed = useRef(false);
  const cancel = async () => {
    const l = loginRef.current;
    doneRef.current = true;
    if (l) await client(`/api/cloud-workspace/claude/login/${encodeURIComponent(l.id)}`, { method: "DELETE" }).catch(() => {});
    onCancel();
  };
  const mins = `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <div className={cn("cc-rb", phone && "is-phone")} data-phase={phase} data-testid="cc-remote-browser" ref={wrap}>
      <div className="cc-rb-bar">
        <button aria-label="后退" className="cc-icon-btn" disabled={phase !== "live"} onClick={() => push({ t: "nav", action: "back" }, true)} type="button">
          <IconArrowLeft className="size-4" />
        </button>
        <button aria-label="刷新" className="cc-icon-btn" disabled={phase !== "live"} onClick={() => push({ t: "nav", action: "reload" }, true)} type="button">
          <IconRefresh className="size-4" />
        </button>
        <div className="cc-rb-url" data-testid="cc-rb-url" title={url}>
          {url.startsWith("https://") ? <IconLock className="size-3.5 flex-none text-[var(--success)]" /> : <IconWorld className="size-3.5 flex-none opacity-60" />}
          <span>{url ? url.replace(/^https?:\/\//, "") : "正在打开…"}</span>
        </div>
        {login ? <span className="cc-rb-time">{mins}</span> : null}
      </div>
      <div className="cc-rb-screen" style={login ? { aspectRatio: `${login.width} / ${login.height}` } : undefined}>
        {frame ? (
          <img
            alt="云端浏览器画面"
            className={cn("cc-rb-img", focused && "is-focused")}
            data-testid="cc-rb-img"
            draggable={false}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.preventDefault();
              pressed.current = true;
              keys.current?.focus({ preventScroll: true });
              push({ t: "mouse", type: "mouseMoved", ...point(e.clientX, e.clientY) });
              push({ t: "mouse", type: "mousePressed", buttons: 1, clickCount: e.detail || 1, ...point(e.clientX, e.clientY) }, true);
            }}
            onPointerMove={(e) => push({ t: "mouse", type: "mouseMoved", buttons: pressed.current ? 1 : 0, ...point(e.clientX, e.clientY) })}
            onPointerUp={(e) => {
              pressed.current = false;
              push({ t: "mouse", type: "mouseReleased", clickCount: e.detail || 1, ...point(e.clientX, e.clientY) }, true);
            }}
            onWheel={(e) => push({ t: "wheel", dx: e.deltaX, dy: e.deltaY, ...point(e.clientX, e.clientY) })}
            ref={img}
            src={frame}
          />
        ) : (
          <div className="cc-rb-wait">
            {phase === "error" ? <IconAlertTriangle className="size-6 text-[var(--danger)]" /> : <IconLoader2 className="size-6 animate-spin opacity-70" />}
            <span>{phase === "error" ? (error ?? "已取消") : "正在云端打开浏览器…"}</span>
          </div>
        )}
        {phase === "captured" ? (
          <div className="cc-rb-cover" data-testid="cc-rb-captured" role="status">
            <IconLoader2 className="size-5 animate-spin" />
            {"已拿到授权，正在完成登录…"}
          </div>
        ) : null}
        <textarea
          aria-label="向云端浏览器输入"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="cc-rb-keys"
          data-testid="cc-rb-keys"
          onBlur={() => setFocused(false)}
          onCompositionEnd={(e) => {
            if (e.data) push({ t: "text", text: e.data }, true);
            e.currentTarget.value = "";
          }}
          onFocus={() => setFocused(true)}
          onInput={(e) => {
            const ne = e.nativeEvent as InputEvent;
            if (ne.isComposing) return;
            if (ne.data && (ne.inputType === "insertText" || ne.inputType === "insertReplacementText")) push({ t: "text", text: ne.data }, true);
            e.currentTarget.value = "";
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (SPECIAL.has(e.key)) {
              e.preventDefault();
              push({ t: "key", key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, true);
            } else if ((e.ctrlKey || e.metaKey) && e.key.length === 1 && e.key.toLowerCase() === "a") {
              e.preventDefault();
              push({ t: "key", key: "a", ctrl: e.ctrlKey, meta: e.metaKey }, true);
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text/plain");
            e.preventDefault();
            if (text) push({ t: "text", text }, true);
          }}
          ref={keys}
          spellCheck={false}
          tabIndex={-1}
        />
      </div>
      <div className="cc-rb-foot">
        {egress ? (
          <span className={cn("cc-pill", egress.match ? "is-ok" : "is-warn")} data-testid="cc-rb-egress">
            {egress.match ? <IconShieldCheck className="size-3.5" /> : <IconAlertTriangle className="size-3.5" />}
            {egress.match
              ? `出口 IP ${egress.browser} · 和 Claude Code 一致${egress.viaProxy ? " · 经上游代理" : ""}`
              : `出口 IP：浏览器 ${egress.browser ?? "?"} / Claude Code ${egress.node ?? "?"}`}
          </span>
        ) : (
          <span className="cc-rb-hint">{"浏览器在云端运行：你的电脑不会访问 claude.com。"}</span>
        )}
        <span className="cc-rb-actions">
          {phase === "error" ? (
            <Button data-testid="cc-rb-back" onClick={() => onCancel(error ?? undefined)} size="sm" variant="outline">
              {"返回"}
            </Button>
          ) : (
            <Button data-testid="cc-rb-cancel" disabled={phase === "captured"} onClick={() => void cancel()} size="sm" variant="ghost">
              {"取消"}
            </Button>
          )}
        </span>
      </div>
      <p className="cc-rb-tip">{phone ? "点画面里的输入框再打字。登录完成会自动回到这里。" : "点画面里的输入框再打字（可以粘贴）。在里面登录 Claude 并点「授权」，完成后自动回到这里。"}</p>
    </div>
  );
}
