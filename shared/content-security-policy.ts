/**
 * 主应用页面的内容安全策略（审查 S1 的放大因素：应用页面以前没有任何 CSP）。
 *
 * 先以 `Content-Security-Policy-Report-Only` 下发：浏览器只在控制台报告违规、不拦截，确认没有误伤后
 * 再改成强制。生产由 server（APP_DIST_DIR）出页面，安装版由 app/serve.ts 出页面，两处共用这一份。
 *
 * index.html 里的内联脚本（主题、设备形态、启动兜底、构建时注入的天空脚本）按 sha256 列进 script-src，
 * 不用 'unsafe-inline'，这样报告里出现的内联脚本就一定是不该有的。
 *
 * 改成强制之前要先处理（违规都会出现在报告里）：
 * - 'unsafe-eval'：sky-background.tsx 用 `new Function` 跑 /wallpaper_core.html 的脚本，改成 `<script src>` 后去掉。
 * - HTML 微应用卡片的 srcdoc iframe 会继承父页面的 CSP，卡片里的内联脚本会被报告；强制前要换成独立来源或 blob。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";

/** 浏览器直接访问的第三方接口（天空 / 天气壁纸）。 */
const CONNECT_ORIGINS = [
  "https://api.open-meteo.com",
  "https://air-quality-api.open-meteo.com",
  "https://geocoding-api.open-meteo.com",
];

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** HTML 里每段内联 `<script>`（没有 src）的 CSP 哈希源，如 `'sha256-…'`。 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attributes)) continue;
    const body = match[2] ?? "";
    hashes.add(
      `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
    );
  }
  return [...hashes];
}

/** 主应用页面的策略。`scriptHashes` 来自 {@link inlineScriptHashes}。 */
export function appContentSecurityPolicy(
  scriptHashes: readonly string[] = [],
): string {
  return [
    "default-src 'self'",
    [
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
      ...scriptHashes,
    ].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    ["connect-src 'self'", ...CONNECT_ORIGINS].join(" "),
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: https:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/**
 * 读构建产物 index.html 算出策略；按文件的修改时间和大小缓存，在线更新换了 index.html 也会跟着变。
 * 读不到（还没构建）时返回不带哈希的策略，不影响出页面。
 */
export function createAppCspReader(
  indexHtmlPath: string,
): () => Promise<string> {
  let cached: { key: string; policy: string } | null = null;
  return async () => {
    try {
      const info = await stat(indexHtmlPath);
      const key = `${info.mtimeMs}:${info.size}`;
      if (cached?.key === key) return cached.policy;
      const policy = appContentSecurityPolicy(
        inlineScriptHashes(await readFile(indexHtmlPath, "utf8")),
      );
      cached = { key, policy };
      return policy;
    } catch {
      return appContentSecurityPolicy();
    }
  };
}
