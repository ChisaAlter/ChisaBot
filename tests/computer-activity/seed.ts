/**
 * CB-101 验收用：通过真实的记录器（withComputerActivity）+ 真实的 activity store 往预览库写活动。
 * 网关是假的（不碰真电脑），但「记什么、怎么打码、拒绝怎么归类」走的都是上线代码。
 *
 *   DATABASE_URL=… BOT=… USER_ID=… THREAD=… bun tests/computer-activity/seed.ts history|live
 */
import { sql } from "drizzle-orm";
import {
  withActivityScope,
  withComputerActivity,
} from "../../server/src/computer/activity-recorder";
import { createActivityStore } from "../../server/src/computer/activity-store";
import { HumanHasControlError } from "../../server/src/computer/client";
import type { ComputerGateway } from "../../server/src/computer/gateway";
import { createDatabase } from "../../server/src/db/client";

const url = process.env.DATABASE_URL as string;
const bot = process.env.BOT as string;
const user = process.env.USER_ID ?? "dev-local-user";
const thread = process.env.THREAD ?? `cb101-thread-${bot}`;
const phase = process.argv[2] ?? "history";
const database = createDatabase(url);
const store = createActivityStore(database, url);

const fake = {
  status: async () => ({ state: "ready" }),
  screenshot: async () => ({ base64: "", url: "" }),
  navigate: async (_b: string, _a: unknown, target: string) => ({
    url: target,
    title: "Example Domain",
    text: "",
  }),
  click: async () => ({
    action: "click",
    element: { role: "link", name: "More information..." },
    url: "https://example.com/",
  }),
  type: async (_b: string, _a: unknown, input: { text: string }) => ({
    action: "type",
    element:
      input.text.length > 8
        ? { role: "textbox", name: "密码" }
        : { role: "searchbox", name: "搜索" },
    url: "https://example.com/",
  }),
  runCommand: async (_b: string, _a: unknown, input: { command: string }) => {
    if (input.command === "date" && phase === "history")
      throw new HumanHasControlError(
        "没有执行：这台计算机现在由用户接管着，等用户交还后再试。",
      );
    const fail = input.command.startsWith("cat missing");
    return {
      command: input.command,
      exitCode: fail ? 1 : 0,
      stdout: fail ? "" : `${input.command} 的输出\n第二行\n`,
      stderr: fail ? "cat: missing.txt: No such file or directory\n" : "",
      truncated: false,
      timedOut: false,
      elapsedMs: 40,
    };
  },
  readFile: async (_b: string, _a: unknown, input: { path: string }) => ({
    path: input.path,
    text: "secret body",
    truncated: false,
    bytes: 2048,
  }),
  humanInput: async () => ({}),
} as unknown as ComputerGateway;
const gateway = withComputerActivity(fake, { store: () => store });
const actor = { id: user };

async function ensureThread(prompt: string, runId: string) {
  await database.execute(sql`
    insert into openbot_local_threads (id, owner_user_id, agent_id, messages)
    values (${thread}, ${user}, ${bot}, ${JSON.stringify([{ id: `u-${runId}`, role: "user", content: prompt }])}::text::jsonb)
    on conflict (id) do update set messages = openbot_local_threads.messages || excluded.messages`);
}

let call = 0;
const JUMP_CALL = "cb101-jump-call";
const READ_CALL = "cb101-read-call";
async function agent<T>(
  runId: string,
  run: () => Promise<T>,
  fixedId?: string,
) {
  call += 1;
  const toolCallId = fixedId ?? `${phase}-${runId}-${call}-${Date.now()}`;
  return withActivityScope(
    { threadId: thread, runId, toolCallId, actorUserId: user },
    run,
  ).catch(() => undefined);
}

if (phase === "history") {
  await database.execute(
    sql`delete from computer_activity_steps where computer_id = ${bot}`,
  );
  await database.execute(
    sql`update openbot_local_threads set messages = '[]'::jsonb where id = ${thread}`,
  );
  // 时间断言用：三步之间隔开 1 秒以上，记下每一步写入前后的真实时间，
  // activity.mjs 拿界面上每条的 <time> 来对（v0.1.78 每条都显示同一个时间）。
  await ensureThread("按顺序读三份计时文件", "run-t");
  const timed: { subject: string; before: number; after: number }[] = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const subject = `timing/step-${i}.md`;
    const before = Date.now();
    await agent("run-t", () =>
      gateway.readFile(bot, actor, { path: subject } as never),
    );
    timed.push({ subject, before, after: Date.now() });
  }
  if (process.env.TIMES_OUT)
    (await import("node:fs")).writeFileSync(
      process.env.TIMES_OUT,
      JSON.stringify(timed),
    );
  // 足够多的旧记录，让面板能滚动。
  await ensureThread("先把归档文件夹里的报告读一遍", "run-0");
  for (let i = 0; i < 14; i++)
    await agent("run-0", () =>
      gateway.readFile(bot, actor, { path: `archive/report-${i}.md` } as never),
    );
  await ensureThread(
    "帮我看看 example.com 上写了什么，再检查一下工作区",
    "run-1",
  );
  await agent(
    "run-1",
    () =>
      gateway.navigate(
        bot,
        actor,
        "https://example.com/?token=SECRET123&lang=zh",
        "x",
      ),
    JUMP_CALL,
  );
  await agent("run-1", () =>
    gateway.click(bot, actor, { ref: "e1" } as never, undefined as never),
  );
  await agent("run-1", () =>
    gateway.type(
      bot,
      actor,
      { ref: "e2", text: "hunter2-Pa55word!" } as never,
      undefined as never,
    ),
  );
  for (const command of ["ls -la", "pwd", "whoami", "uname -a"])
    await agent("run-1", () =>
      gateway.runCommand(bot, actor, { command } as never),
    );
  await agent("run-1", () =>
    gateway.runCommand(bot, actor, { command: "cat missing.txt" } as never),
  );
  await agent("run-1", () =>
    gateway.runCommand(bot, actor, { command: "date" } as never),
  );
  // 聊天里这次工具调用要能跳到活动记录：对话里写上同一个 toolCallId 的调用和结果。
  await agent(
    "run-1",
    () => gateway.readFile(bot, actor, { path: "notes/todo.md" } as never),
    READ_CALL,
  );
  await database.execute(sql`
    update openbot_local_threads set messages = messages || ${JSON.stringify([
      {
        id: "a-jump",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: JUMP_CALL,
            type: "function",
            function: {
              name: "computer_navigate",
              arguments: JSON.stringify({ url: "https://example.com/" }),
            },
          },
        ],
      },
      {
        id: "t-jump",
        role: "tool",
        toolCallId: JUMP_CALL,
        content: JSON.stringify({
          ok: true,
          url: "https://example.com/",
          title: "Example Domain",
        }),
      },
      {
        id: "a-read",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: READ_CALL,
            type: "function",
            function: {
              name: "computer_read_file",
              arguments: JSON.stringify({ path: "notes/todo.md" }),
            },
          },
        ],
      },
      {
        id: "t-read",
        role: "tool",
        toolCallId: READ_CALL,
        content: JSON.stringify({
          ok: true,
          path: "notes/todo.md",
          bytes: 2048,
        }),
      },
      {
        id: "a-done",
        role: "assistant",
        content: "看完了，工作区里有一份待办。",
      },
    ])}::text::jsonb where id = ${thread}`);
  for (let i = 0; i < 3; i++) {
    await withActivityScope({ human: true, actorUserId: user }, () =>
      gateway.humanInput(bot, {
        kind: "type",
        text: "我自己输入的私人内容",
      } as never),
    );
  }
} else {
  await ensureThread("再打开一次看看", "run-2");
  await agent("run-2", () =>
    gateway.navigate(bot, actor, "https://example.org/login?code=OTP999", "x"),
  );
}
await new Promise((resolve) => setTimeout(resolve, 300));
await store.stop();
process.exit(0);
