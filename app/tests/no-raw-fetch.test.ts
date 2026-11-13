import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * 浏览器端的所有请求都必须走 app/src/lib/client.ts 的 client / tryClient：
 * 它统一带凭据、序列化 JSON、把失败状态翻成带服务器原话的 Error，还给每个请求挂上默认时限。
 * 散落的裸 fetch / XMLHttpRequest 会各自悄悄丢掉其中一两件（历史上就发生过：四个私有 request
 * 助手，其中一个丢了 body.error 提取）。新代码不许再开这个口子。
 *
 * `fetch(` 的判定要求前一个字符不是 `.` 也不是标识符字符：refetch()、agent.fetch()、
 * myfetch() 都不是裸 fetch；`window.fetch(` / `globalThis.fetch(` / `new XMLHttpRequest` 全部算。
 */
const RAW_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /(^|[^.$\w])fetch\(/, what: "fetch(" },
  { pattern: /(?:window|globalThis)\.fetch\(/, what: "window.fetch(" },
  { pattern: /new XMLHttpRequest/, what: "new XMLHttpRequest" },
];

/**
 * 仍然允许裸传输的文件和原因。一个文件要能上这份名单，它碰的必须是 fetch / XMLHttpRequest
 * 给不了、或 client 接不了的东西（上传进度、keepalive 之外的流式运行时、非 /api 的资源）。
 * 给组件里的请求找借口不算理由——那正是要拦的。
 */
const ALLOWED: Record<string, string> = {
  "lib/client.ts": "唯一实现 fetch 的地方：所有请求从这里出去。",
  "lib/chat/session-client.ts":
    "AG-UI 会话运行时自己的传输（命令、流、重连），不走业务 client。",
  "components/sky-background.tsx":
    "壁纸运行时加载 /wallpaper_core.html 静态资源（从不打 /api），带自己的超时与退避。",
  "components/channels/composer/attachments.ts":
    "XMLHttpRequest 是唯一有上传进度事件的 API，分片附件上传靠它报进度。",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function rawCallsIn(source: string): string[] {
  return RAW_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
    ({ what }) => what,
  );
}

test("app/src 里不许有裸 fetch / XMLHttpRequest（一律走 lib/client.ts）", () => {
  const root = path.join(import.meta.dir, "../src");
  const offenders = files(root)
    .map((file) => ({
      rel: path.relative(root, file).replaceAll("\\", "/"),
      source: readFileSync(file, "utf8"),
    }))
    .filter(
      ({ rel, source }) => !(rel in ALLOWED) && rawCallsIn(source).length > 0,
    )
    .map(({ rel, source }) => `${rel}（${rawCallsIn(source).join("、")}）`);
  expect(offenders).toEqual([]);
});

test("白名单不过期：名单里的文件必须仍然真的含有裸调用", () => {
  const root = path.join(import.meta.dir, "../src");
  const stale = Object.keys(ALLOWED).filter((rel) => {
    const full = path.join(root, rel);
    try {
      return rawCallsIn(readFileSync(full, "utf8")).length === 0;
    } catch {
      return true;
    }
  });
  expect(stale).toEqual([]);
});
