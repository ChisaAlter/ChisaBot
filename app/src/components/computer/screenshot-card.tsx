import { IconCamera, IconLoader2 } from "@tabler/icons-react";
import { useState } from "react";
import { Lightbox } from "@/components/rich-previews/lightbox";

/**
 * 用户明确要「截个图」时，对话里放一张缩略图（2026-10-13，Hark 第二轮）。
 *
 * 以前没有截图工具，机器人只能说「我没有截图工具」——可画面明明就在右栏。现在 computer_screenshot
 * 截当前画面：缩成 JPEG，对话里显示缩略图，点开看大图。图片不进模型上下文、也不进会话记录（太大）。
 *
 * 第四轮（2026-10-13）：同时交给服务器按人存一份（/api/chat-shots/:工具调用 id，server/src/chat-shots.ts），
 * 换设备、换浏览器打开同一会话也看得到；本机 localStorage 只是缓存，省一次下载。
 */
const KEY = "chisabot-shots";
const KEEP = 24;

type Stored = Record<string, { src: string; url?: string; at: number }>;
function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Stored;
  } catch {
    return {};
  }
}
export function keepShot(id: string, src: string, url?: string, botId?: string) {
  void fetch(`/api/chat-shots/${encodeURIComponent(id)}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataUrl: src, ...(url ? { url } : {}), ...(botId ? { botId } : {}) }),
  }).catch(() => {});
  try {
    const all = load();
    all[id] = { src, ...(url ? { url } : {}), at: Date.now() };
    const ids = Object.keys(all).sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0));
    for (const old of ids.slice(KEEP)) delete all[old];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 本机存不下就算了：这张图只是锦上添花，画面本来就在右栏。
  }
}
export function shotFor(id: string | undefined) {
  return id ? load()[id] : undefined;
}
export function clearRememberedShots() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** 把 PNG 缩成宽 ≤960 的 JPEG（约 60–120KB），够看清又不撑爆本机存储。 */
export async function shrinkPng(base64: string): Promise<string> {
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  await img.decode();
  const scale = Math.min(1, 960 / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.78);
}

export function ScreenshotCard({ id, running, failed, url }: { id?: string; running: boolean; failed?: string; url?: string }) {
  const [open, setOpen] = useState(false);
  const [remoteGone, setRemoteGone] = useState(false);
  const local = shotFor(id);
  // 本机没有缓存（换了设备）就读服务器那份；读不到（过期清理了）再退回一行字。
  const shot = local ?? (id && !remoteGone ? { src: `/api/chat-shots/${encodeURIComponent(id)}`, url: undefined, at: 0, remote: true } : undefined);
  let host = url ?? shot?.url ?? "";
  try {
    if (host) host = new URL(host).hostname.replace(/^www\./, "");
  } catch {}
  if (running)
    return (
      <span className="shot-card shot-card-line">
        <IconLoader2 className="size-4 animate-spin" /> 正在截图…
      </span>
    );
  if (failed || !shot)
    return (
      <span className="shot-card shot-card-line" title={failed}>
        <IconCamera className="size-4" /> {failed ? "没截到图" : `截图${host ? ` · ${host}` : ""}`}
      </span>
    );
  return (
    <>
      <button className="shot-card" onClick={() => setOpen(true)} title="点开看大图" type="button">
        <img
          alt={`${host || "页面"}的截图`}
          data-shot-source={local ? "local" : "server"}
          onError={() => {
            if (!local) setRemoteGone(true);
          }}
          src={shot.src}
        />
        {host ? <span className="shot-card-host">{host}</span> : null}
      </button>
      {/* 点开用和聊天图片同一个看大图（缩放、下载、Esc，DESIGN.md §31）。 */}
      {open ? (
        <Lightbox
          images={[{ src: shot.src, alt: `${host || "页面"}的截图`, name: `截图${host ? `-${host}` : ""}.jpg` }]}
          onClose={() => setOpen(false)}
          startIndex={0}
        />
      ) : null}
    </>
  );
}
