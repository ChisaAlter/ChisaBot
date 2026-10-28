#!/usr/bin/env bun
/**
 * 一次跑完 `app/tests` —— 但把「整包替换模块」的那两份文件放进**独立进程**。
 *
 * 为什么不是直接 `bun test app/tests`：Bun 的 `mock.module()` 是**进程级**的，而且 1.3.14 里
 * `mock.restore()` 换不回来（最小复现见 docs/test-suite.md；重注册真模块也一样）。所有测试文件的
 * import 在开跑前就解析好了，事后再怎么还原都来不及。结果是：
 *
 *   app/tests/approval-tools.test.tsx、app/tests/turn-unfinished.test.tsx
 *   把 `@copilotkit/react-core/v2` 整包换成替身 → 后面用真 SDK 的文件（channel-history-refresh、
 *   failed-send-attachments…）在同一个进程里拿到替身，`copilotkit.applyHeadersToAgent` 不存在，
 *   成片崩；单独跑这些文件却全绿。
 *
 * 所以分两次进程跑：先跑「其余全部」，再跑这两份。任何一次非 0 退出，整体就非 0。
 *
 * 用法：`bun run test:app`（会先跑 pretest:app 生成 app-config，和 `bun test` 的 pretest 一样）。
 */
import { Glob } from "bun";

/**
 * 需要**自己一个进程**的测试文件。两种原因：
 *
 * 1. 用 `mock.module()` 替换模块（含通过 fixture 间接替换的）。Bun 的 mock 是进程级的，换不回来，
 *    而且一个文件里的替身会漏给后面所有文件。
 * 2. 依赖「干净的全局环境」：改 `document` / 启动骨架的（startup-resilience），或者带性能阈值的
 *    微基准（tail-first-paint）——在共享进程里跑会被前面的文件影响，单跑却全绿。
 *
 * 往这里加文件之前先想清楚：能改成 mock 局部缝、或者把全局状态收拾干净的，就别扔进隔离名单。
 */
const ISOLATED = [
  "app/tests/approval-tools.test.tsx",
  "app/tests/turn-unfinished.test.tsx",
  "app/tests/approvals-rules.test.tsx",
  "app/tests/device-connection-card.test.tsx",
  "app/tests/channel-new-error-state.test.tsx",
  "app/tests/home-fallback-routing.test.tsx",
  "app/tests/startup-resilience.test.tsx",
  "app/tests/tail-first-paint.test.ts",
  // motion 第一次 import 时才看有没有 requestAnimationFrame；变形动画的测试要在「先注册 DOM、后加载组件」的干净进程里跑。
  "app/tests/shape-avatar.test.tsx",
  /*
   * Motion 在**第一次 import 时**就把 `prefers-reduced-motion` 记下来了（它自己的全局状态），之后再改
   * `matchMedia` 也不认。这份用例在 `beforeAll` 里把 matchMedia 换成「开了减少动效」，所以必须自己一个进程；
   * 跟别的文件一起跑时永远拿到「没开」，断言的是检查项而不是代码（2026-10-22 起单列）。
   */
  "app/tests/message-scroll-reduced-motion.test.tsx",
  // 把 @tanstack/react-router 的 Link 换成替身（进程级）；共享进程里会漏给 agent-roster-error 等用真 Link 断言 aria-label 的文件。
  "app/tests/schedule-fired.test.tsx",
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
