/**
 * 头像变形的自测：打包 harness.tsx，用 Playwright 无头 Chromium 打开，
 * 量待机帧数、3 个 working 时的长任务 / 帧间隔 / 每帧变形耗时，并录 webm（+ 截帧拼 GIF）。
 * Bun 打包，Node 跑 Playwright（Windows 上 Bun 跑 Playwright 的 pipe 启动会卡住）。
 * 用法：bun app/scripts/avatar-morph-harness/run.ts <输出目录>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const repo = resolve(here, "../../..");
const out = resolve(process.argv[2] ?? join(repo, "tmp-avatar-morph"));
mkdirSync(out, { recursive: true });

const built = await Bun.build({
  entrypoints: [join(here, "harness.tsx")],
  target: "browser",
  minify: true,
  tsconfig: join(repo, "app/tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
} as Parameters<typeof Bun.build>[0]);
if (!built.success) throw new AggregateError(built.logs, "build failed");
const js = await built.outputs[0].text();
const css = readFileSync(join(repo, "app/src/styles.css"), "utf8")
  .split("\n")
  .filter((line) =>
    /^\.sa\b|^\.sa[-[ ,]|^@keyframes sa-|^html\.dark \.sa|^\.bot-ava \{|^@media \(prefers-reduced-motion: reduce\) \{ \.sa/.test(
      line,
    ),
  )
  .join("\n");
writeFileSync(
  join(out, "harness.html"),
  `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font:14px system-ui}.bot-ava{display:inline-flex;border-radius:999px;overflow:visible}${css}</style><div id="root"></div><script type="module">${js.replace(/<\/script/g, "<\\/script")}</script>`,
);

const child = Bun.spawnSync(["node", join(here, "measure.mjs"), out], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
process.exit(child.exitCode ?? 1);
