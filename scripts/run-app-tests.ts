#!/usr/bin/env bun
/**
 * 一次跑完 `app/tests` —— 仅将确需独立干净启动环境的用例放进**独立进程**。
 *
 * `mock.module()` 已被 `app/tests/no-mock-module.test.ts` 零白名单禁用。
 * 剩余隔离名单只保留：改 `document` / 启动骨架的用例（startup-resilience）、
 * 带严格首屏或帧耗时阈值的微基准（tail-first-paint、theme-glass-perf）、
 * 以及首次 import 时一次性读取全局 `requestAnimationFrame` / `prefers-reduced-motion` 的动画测试。
 *
 * 用法：`bun run test:app`（会先跑 pretest:app 生成 app-config，和 `bun test` 的 pretest 一样）。
 */
import { Glob } from "bun";

const ISOLATED = [
  "app/tests/startup-resilience.test.tsx",
  "app/tests/tail-first-paint.test.ts",
  // motion 第一次 import 时才看有没有 requestAnimationFrame；变形动画的测试要在「先注册 DOM、后加载组件」的干净进程里跑。
  "app/tests/shape-avatar.test.tsx",
  "app/tests/avatar-morph.test.tsx",
  "app/tests/avatar-morph-reduced.test.tsx",
  "app/tests/avatar-perf-still.test.tsx",
  "app/tests/bot-work-mark.test.tsx",
  /*
   * Motion 在**第一次 import 时**就把 `prefers-reduced-motion` 记下来了（它自己的全局状态），之后再改
   * `matchMedia` 也不认。这份用例在 `beforeAll` 里把 matchMedia 换成「开了减少动效」，所以必须自己一个进程；
   * 跟别的文件一起跑时永远拿到「没开」，断言的是检查项而不是代码（2026-10-22 起单列）。
   */
  "app/tests/message-scroll-reduced-motion.test.tsx",
  "app/tests/theme-glass-perf.test.tsx",
];

const files = [...new Glob("app/tests/**/*.test.{ts,tsx}").scanSync(".")]
  .map((file) => file.replaceAll("\\", "/"))
  .sort();

const isolated = files.filter((file) => ISOLATED.includes(file));
const rest = files.filter((file) => !ISOLATED.includes(file));

if (isolated.length !== ISOLATED.length) {
  console.error(
    `run-app-tests: 有隔离文件不见了（期望 ${ISOLATED.length}，找到 ${isolated.length}）。改过文件名就把 ISOLATED 一起改。`,
  );
  process.exit(1);
}

function run(paths: string[], label: string): number {
  if (paths.length === 0) return 0;
  console.log(`\n▸ ${label}（${paths.length} 个文件）`);
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", ...paths],
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return result.exitCode ?? 1;
}

const main = run(rest, "app 测试（共享进程）");
let alone = 0;
for (const file of isolated) {
  alone = run([file], `app 测试（独立进程：${file}）`) || alone;
}
process.exit(main !== 0 || alone !== 0 ? 1 : 0);
