/**
 * 让机器人在自己的浏览器里打开它自己写的网页。
 *
 * 机器人能用 computer_write_file 在工作区（/workspace）里写一个 HTML，但浏览器只允许打开 http(s)：
 * `file://` 被 request-validation.ts 拒绝（也不应该放开——那等于把整个容器的文件系统交给网页）。
 * 以前的结果就是机器人说「我写个页面然后在浏览器里打开」，然后什么都打不开，接管时只看到一块白。
 *
 * 做法：给工作区一个虚拟网址 `https://workspace.local/<路径>`。这个域名从不出网：浏览器上下文里的
 * 路由在请求发出之前就拦下它，用 workspace.ts 读文件（同一套路径限制：不许绝对路径、`..`、软链出界）
 * 原样返回。所以它不经过出站代理，也不受网络策略影响，只能读到机器人自己工作区里的文件。
 *
 * 只给两种请求返回内容：顶层页面的导航，以及本身就在 workspace.local 上的页面发出的请求（页面里的
 * 图片、样式、脚本）。别的网站嵌一个 `<script src="https://workspace.local/…">` 拿不到任何东西。
 *
 * 纯函数放在这里、不碰 Playwright，测试可以直接导入；安装路由的那一点在 index.ts。
 */

export const WORKSPACE_HOST = "workspace.local";
export const WORKSPACE_ORIGIN = `https://${WORKSPACE_HOST}`;

/** 是不是工作区的虚拟网址（http 或 https 都认，主机名不分大小写）。 */
export function isWorkspaceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.toLowerCase() === WORKSPACE_HOST
    );
  } catch {
    return false;
  }
}

/**
 * 虚拟网址 → 工作区里的相对路径。目录（以 / 结尾或空路径）补 index.html。
 * 不是工作区网址时返回 null。路径是否越界由 workspace.ts 判断，这里只负责解码。
 */
export function workspacePathFromUrl(url: string): string | null {
  if (!isWorkspaceUrl(url)) return null;
  const parsed = new URL(url);
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  path = path.replace(/^\/+/, "");
  if (path === "" || path.endsWith("/")) path += "index.html";
  return path;
}

/**
 * 机器人写出来的本地地址 → 工作区虚拟网址。
 *
 * `file:///workspace/page.html`、`file://workspace/page.html` 这类指向工作区的 file 地址换成
 * `https://workspace.local/page.html`；其他一律原样返回（之后照常被 http(s) 检查拒绝）。
 * 模型很自然会写 file://，与其让它失败再解释，不如直接打开它的意思。
 */
export function workspaceUrlFor(input: string): string {
  const text = input.trim();
  if (!/^file:/i.test(text)) return input;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return input;
  }
  let path: string;
  try {
    path = decodeURIComponent(`${parsed.hostname ? `/${parsed.hostname}` : ""}${parsed.pathname}`);
  } catch {
    return input;
  }
  const match = /^\/+workspace(?:\/+(.*))?$/i.exec(path);
  if (!match) return input;
  const rest = (match[1] ?? "")
    .split("/")
    .filter((part) => part !== "")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${WORKSPACE_ORIGIN}/${rest}${parsed.search}${parsed.hash}`;
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  wasm: "application/wasm",
};

export function contentTypeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * 这个请求能不能拿到工作区文件：顶层导航，或者发起它的页面本身就在 workspace.local 上。
 */
export function workspaceRequestAllowed(request: {
  isNavigationRequest: boolean;
  isMainFrame: boolean;
  frameUrl: string | null;
}): boolean {
  if (request.isNavigationRequest && request.isMainFrame) return true;
  return request.frameUrl !== null && isWorkspaceUrl(request.frameUrl);
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

/** 文件不在 / 读不了时给浏览器的一页（中文，浅色，和「浏览器空闲」同一个语气）。 */
export function workspaceProblemPage(path: string, problem: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHtml(path)}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.6 system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:linear-gradient(160deg,#e0f0ff,#f6faff);color:#334155">
<div style="text-align:center;max-width:32em;padding:24px"><div style="font-weight:600;font-size:16px;color:#0f172a">打不开工作区文件</div>
<div style="margin-top:6px">${escapeHtml(path)}</div><div style="margin-top:6px;color:#64748b">${escapeHtml(problem)}</div></div></body></html>`;
}
