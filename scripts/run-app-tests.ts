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

if (files.length === 0) {
  console.error("run-app-tests: 未发现任何 app/tests 测试文件。");
  process.exit(1);
}

if (isolated.length !== ISOLATED.length) {
  console.error(
    `run-app-tests: 有隔离文件不见了（期望 ${ISOLATED.length}，找到 ${isolated.length}）。改过文件名就把 ISOLATED 一起改。`,
  );
  process.exit(1);
}

async function run(
  paths: string[],
  label: string,
): Promise<{ exitCode: number; passed: number }> {
  if (paths.length === 0) return { exitCode: 0, passed: 0 };
  console.log(`\n▸ ${label}（${paths.length} 个文件）`);
  const child = Bun.spawn([process.execPath, "test", ...paths], {
    env: process.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    target: NodeJS.WriteStream,
  ) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      target.write(text);
    }
    const tail = decoder.decode();
    if (tail) {
      output += tail;
      target.write(tail);
    }
  };
  await Promise.all([
    drain(child.stdout, process.stdout),
    drain(child.stderr, process.stderr),
  ]);
  const exitCode = (await child.exited) ?? 1;
  const passed = Number(output.match(/\b(\d+) pass\b/)?.[1] ?? 0);
  if (exitCode === 0 && passed === 0) {
    console.error(
      `run-app-tests: ${label} 退出码为 0 但未检测到任何通过的用例（0 pass），拒绝静默通过。`,
    );
    return { exitCode: 1, passed: 0 };
  }
  return { exitCode, passed };
}

const main = await run(rest, "app 测试（共享进程）");
let totalPassed = main.passed;
let alone = 0;
for (const file of isolated) {
  const res = await run([file], `app 测试（独立进程：${file}）`);
  totalPassed += res.passed;
  if (res.exitCode !== 0) alone = res.exitCode;
}
if (totalPassed === 0) {
  console.error("run-app-tests: 总通过用例数为 0，拒绝静默通过。");
  process.exit(1);
}
process.exit(main.exitCode !== 0 || alone !== 0 ? 1 : 0);
