import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createConversationBindings } from "../src/conversations/bindings";
import { backgroundCount } from "../src/conversations/capacity";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDatabase } from "../src/db/client";
import { createImService } from "../src/im/service";
import type { WsLike } from "../src/im/types";
import { createLocalConversations } from "../src/local-conversations";
import { createSchedules } from "../src/schedules/service";
import { createTaskCenterRuntime } from "../src/task-center/runtime";
import { createTurnRunner } from "../src/turns/run-turn";
import type { TurnRunner } from "../src/turns/types";
import { createWorkerService } from "../src/workers/service";
import type {
  Initiator,
  Row,
  WireBody,
  WireMessage,
} from "./support/wire-types";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const answer = "后台验收完成：产物已保存。";
async function until<T>(
  check: () => Promise<T | null | false | undefined>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline)
      throw new Error("Background result did not settle.");
    await Bun.sleep(50);
  }
}

/** The OneBot protocol endpoint acknowledges each delivery; no real platform/account is used. */
class ProtocolSocket implements WsLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  acknowledgeReplies = true;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(data: unknown) {
    const frame = JSON.parse(String(data));
    this.sent.push(frame);
    if (frame.action.startsWith("send_") && !this.acknowledgeReplies) return;
    setTimeout(
      () =>
        this.push({
          status: "ok",
          retcode: 0,
          echo: frame.echo,
          data:
            frame.action === "get_login_info"
              ? { user_id: 10001, nickname: "隔离协议端" }
              : { message_id: this.sent.length },
        }),
      1,
    );
  }
  push(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) });
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  replies() {
    return this.sent.filter((frame) => frame.action === "send_private_msg");
  }
}

(address ? describe : describe.skip)(
  "DSH background business entry points without a browser",
  () => {
    const owner = `background-${randomUUID()}`,
      bot = `${owner}-bot`;
    const cleanups: (() => unknown | Promise<unknown>)[] = [];
    let database: ReturnType<typeof createDatabase>;
    let backend: Awaited<ReturnType<typeof createLocalConversations>>;
    let runTurn: TurnRunner;
    let effects = "";
    const modelRequests: unknown[] = [];
    let pauseNextModel = false;
    const held = new Map<string, () => void>();
    const holdMarkers = new Set<string>();
    let shortTurn: TurnRunner;

    beforeAll(async () => {
      database = createDatabase(address!, { max: 6 });
      cleanups.push(() => database.$client.close());
      backend = await createLocalConversations(database);
      const bindings = createConversationBindings(database),
        operations = createToolOperationStore(database),
        journal = createDshRunJournal(database);
      await bindings.ensure();
      await operations.ensure();
      const gateway = createDshToolGateway(operations, journal);
      const runtime = resolve("runtime/dsh");
      await mkdir(join(runtime, ".runtime"), { recursive: true });
      const home = await mkdtemp(join(runtime, ".runtime", "background-"));
      effects = join(home, "effects.txt");
      await writeFile(effects, "");
      const bridge = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          if (!new URL(request.url).pathname.startsWith("/v1/"))
            return gateway.routes.fetch(request);
          const body = (await request.json()) as WireBody;
          modelRequests.push(body);
          const marker = [...holdMarkers].find((value) =>
            JSON.stringify(body.messages).includes(value),
          );
          if (marker) {
            holdMarkers.delete(marker);
            await new Promise<void>((resolve) => held.set(marker, resolve));
            held.delete(marker);
          }
          if (pauseNextModel) {
            pauseNextModel = false;
            await Bun.sleep(1000);
          }
          const latestUser = body.messages.findLastIndex(
            (message: WireMessage) => message.role === "user",
          );
          const hasResult = body.messages
            .slice(latestUser + 1)
            .some((message: WireMessage) => message.role === "tool");
          const delta = hasResult
            ? { role: "assistant", content: answer }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "write-receipt",
                    type: "function",
                    function: { name: "write_receipt", arguments: "{}" },
                  },
                ],
              };
          const chunk = (value: unknown, finish_reason: string | null) =>
            `data: ${JSON.stringify({ id: "background", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
          return new Response(
            chunk(delta, null) +
              chunk({}, hasResult ? "stop" : "tool_calls") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      cleanups.push(() => bridge.stop(true));
      await writeFile(
        join(home, "chisabot.json"),
        JSON.stringify({
          ownerUserId: owner,
          port: 0,
          providers: {},
          gatewayUrl: bridge.url.origin,
        }),
      );
      const child = spawn("node", ["src/start.mjs"], {
        cwd: runtime,
        env: { ...process.env, CHISABOT_DSH_HOME: home },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      cleanups.push(async () => {
        if (child.exitCode === null) {
          const done = once(child, "exit");
          child.kill();
          await done;
        }
      });
      await until(async () => {
        if (child.exitCode !== null) throw new Error(output);
        return output.includes("chisabot-runtime-ready");
      }, 60_000);
      const buildAgentFor = async (input: {
        ownerUserId: string;
        agentId: string;
        initiator: Initiator;
      }) =>
        new DshRuntimeAgent({
          botId: input.agentId,
          binding: {
            bindings,
            journal,
            gateway,
            toolGatewayUrl: bridge.url.origin,
            targetFor: async (actor) => ({
              id: "background-host",
              ownerUserId: actor,
              connectionFile: join(home, "connection.json"),
            }),
            readRun: (value) => JSON.parse(String(value)),
          },
          signRun: (value) =>
            JSON.stringify({
              actorId: input.ownerUserId,
              botId: input.agentId,
              runId: value.runId,
              threadId: value.threadId,
              initiator: input.initiator,
            }),
          tools: [
            {
              name: "write_receipt",
              ref: "test/receipt",
              description: "Write one isolated receipt.",
              parameters: z.object({}),
              execute: async () => {
                await appendFile(effects, "receipt\n");
                return "Receipt saved.";
              },
            },
          ],
          prompt: () => "Use write_receipt once then report the result.",
          connection: {
            provider: "openai",
            baseUrl: `${bridge.url.origin}/v1`,
            apiKey: null,
            useApiKey: false,
            model: "background",
          },
          modelInfo: async () => ({
            contextWindow: 32000,
            maxOutputTokens: 1024,
          }),
          fallbacks: async () => [],
        });
      runTurn = createTurnRunner({
        intelligence: backend.client,
        runner: backend.runner,
        buildAgentFor,
      });
      shortTurn = createTurnRunner({
        intelligence: backend.client,
        runner: backend.runner,
        buildAgentFor,
        turnTimeoutMs: 700,
      });
    }, 90_000);
    afterAll(async () => {
      for (const close of cleanups.reverse()) await close();
    }, 30_000);
    const effectCount = async () =>
      (await readFile(effects, "utf8")).trim().split("\n").filter(Boolean)
        .length;
    const history = async (threadId: string) =>
      (await backend.client.getThreadMessages({ threadId, userId: owner }))
        .messages;

    test("shared background capacity spans worker, schedule and task-center; foreground and queued Stop stay usable", async () => {
      const parentThreadId = `${owner}-capacity-parent`,
        scheduleThread = `${owner}-capacity-schedule`;
      for (const threadId of [parentThreadId, scheduleThread])
        await backend.client.getOrCreateThread({
          threadId,
          userId: owner,
          agentId: bot,
        });
      const workers = createWorkerService({
        database,
        inbox: backend.inbox,
        control: backend.control,
        runTurn,
        agentOfThread: async () => bot,
      });
      await workers.ensure();
      const schedules = createSchedules(database, {
        runTurn,
        botAvailable: async () => true,
      });
      await schedules.ensure();
      cleanups.push(() => schedules.stop());
      holdMarkers.add("CAPACITY_WORKER");
      holdMarkers.add("CAPACITY_SCHEDULE");
      const worker = await workers.start({
        ownerUserId: owner,
        agentId: bot,
        parentThreadId,
        title: "容量任务",
        task: "CAPACITY_WORKER 保存验收产物",
      });
      const schedule = await schedules.create({
        owner,
        agentId: bot,
        threadId: scheduleThread,
        title: "容量定时",
        instruction: "CAPACITY_SCHEDULE 保存验收产物",
        when: { repeat: "once", in_minutes: 30 },
      });
      await schedules.runNow(owner, schedule.id);
      await until(async () => held.size === 2);
      expect(await backgroundCount(database.$client, owner)).toBe(2);
      const center = createTaskCenterRuntime({
        database,
        runTurn,
        personalSources: {
          scanCalendar: async () => [],
          scanEmails: async () => [],
          status: async () => ({}),
        } as never,
        github: {
          listOpenItems: async () => [],
          status: async () => ({}),
        } as never,
        botAvailable: async () => true,
        defaultAgentFor: async () => bot,
      });
      await center.ensure();
      cleanups.push(() => center.stop());
      const task = await center.createTask(owner, {
        title: "容量任务中心",
        description: "CAPACITY_CENTER 保存验收产物",
        level: 2,
        risk: "read",
        agentId: bot,
        completion: { criteria: "返回产物回执", required: [] },
      });
      await center.controlTask(owner, task.id, "start");
      await center.sweep();
      const queuedTask = await until(
        async () =>
          (
            await database.$client.unsafe<Row[]>(
              "SELECT r.* FROM chisabot_local_runs r WHERE r.status='capacity_wait' AND r.thread_id LIKE $1",
              [`task-center:${task.id}:%`],
            )
          )[0],
      );
      expect((await center.getTask(owner, task.id))?.attempts).toBe(1);
      expect(JSON.stringify(modelRequests)).not.toContain("CAPACITY_CENTER");
      const queuedThread = `${owner}-queued-and-foreground`;
      const cancelled = new AbortController();
      const queuedDone = runTurn({
        ownerUserId: owner,
        agentId: bot,
        threadId: queuedThread,
        routineId: "capacity-cancel",
        runId: "capacity-cancel",
        instruction: "CAPACITY_CANCEL",
        signal: cancelled.signal,
      }).catch((error) => error);
      await until(
        async () =>
          (
            await database.$client.unsafe<Row[]>(
              "SELECT 1 FROM chisabot_local_runs WHERE thread_id=$1 AND status='capacity_wait'",
              [queuedThread],
            )
          )[0],
      );
      holdMarkers.add("CAPACITY_FOREGROUND");
      const foreground = runTurn({
        ownerUserId: owner,
        agentId: bot,
        threadId: queuedThread,
        routineId: "foreground",
        instruction: "CAPACITY_FOREGROUND",
        initiator: { kind: "person" },
      });
      await until(async () => held.has("CAPACITY_FOREGROUND"));
      cancelled.abort();
      expect(await queuedDone).toBeInstanceOf(Error);
      expect(held.has("CAPACITY_FOREGROUND")).toBe(true);
      expect(JSON.stringify(modelRequests)).not.toContain("CAPACITY_CANCEL");
      held.get("CAPACITY_FOREGROUND")!();
      await foreground;
      const short = shortTurn({
        ownerUserId: owner,
        agentId: bot,
        threadId: `${owner}-short-queue`,
        routineId: "short",
        instruction: "CAPACITY_SHORT",
      });
      await until(
        async () =>
          (
            await database.$client.unsafe<Row[]>(
              "SELECT 1 FROM chisabot_local_runs WHERE thread_id=$1 AND status='capacity_wait'",
              [`${owner}-short-queue`],
            )
          )[0],
      );
      await Bun.sleep(1000); // Beyond this turn's execution budget; no model has been called.
      expect(JSON.stringify(modelRequests)).not.toContain("CAPACITY_SHORT");
      expect(await backgroundCount(database.$client, owner)).toBe(2);
      held.get("CAPACITY_WORKER")!();
      held.get("CAPACITY_SCHEDULE")!();
      expect((await short).replyText).toBe(answer);
      await until(
        async () =>
          (await center.getTask(owner, task.id))?.status === "succeeded",
      );
      expect((await center.getTask(owner, task.id))?.attempts).toBe(1);
      await until(
        async () => (await workers.get(worker.id))?.status === "done",
      );
      expect(
        (
          await database.$client.unsafe<Row[]>(
            "SELECT status FROM chisabot_local_runs WHERE thread_id=$1 AND run_id=$2",
            [queuedTask.thread_id, queuedTask.run_id],
          )
        )[0]?.status,
      ).toBe("finished");
      await until(async () => !backend.control.isActive(parentThreadId));
      expect(await backgroundCount(database.$client, owner)).toBe(0);
    }, 45_000);

    test("scheduled firing stores the governed result and settles its schedule row", async () => {
      const threadId = `${owner}-schedule`;
      await backend.client.getOrCreateThread({
        threadId,
        userId: owner,
        agentId: bot,
      });
      const schedules = createSchedules(database, {
        runTurn,
        botAvailable: async () => true,
      });
      await schedules.ensure();
      cleanups.push(() => schedules.stop());
      const schedule = await schedules.create({
        owner,
        agentId: bot,
        threadId,
        title: "隔离提醒",
        instruction: "保存验收产物",
        when: { repeat: "once", in_minutes: 30 },
      });
      const before = await effectCount();
      const fired = await schedules.runNow(owner, schedule.id);
      const saved = await until(async () => {
        const [row] = await database.$client.unsafe<
          { status: string; result: string }[]
        >("SELECT status,result FROM chisabot_schedule_runs WHERE id=$1", [
          fired.runId,
        ]);
        return row?.status === "running" ? null : row;
      });
      expect(saved.status).toBe("ok");
      expect(saved.result).toBe(answer);
      expect(
        (await history(threadId)).some(
          (message) =>
            message.role === "assistant" && message.content === answer,
        ),
      ).toBe(true);
      expect(await effectCount()).toBe(before + 1);
      const [journal] = await database.$client.unsafe<{ initiator: unknown }[]>(
        "SELECT initiator FROM chisabot_dsh_runs WHERE thread_id=$1",
        [threadId],
      );
      expect(journal?.initiator).toEqual({
        kind: "routine",
        id: `schedule:${schedule.id}`,
      });
    }, 40_000);

    test("worker completion returns to its parent and a recovered result is never executed again", async () => {
      const parentThreadId = `${owner}-parent`;
      await backend.client.getOrCreateThread({
        threadId: parentThreadId,
        userId: owner,
        agentId: bot,
      });
      const workerOptions = {
        database,
        inbox: backend.inbox,
        control: backend.control,
        runTurn,
        agentOfThread: async () => bot,
      };
      const workers = createWorkerService(workerOptions);
      await workers.ensure();
      const before = await effectCount();
      const worker = await workers.start({
        ownerUserId: owner,
        agentId: bot,
        parentThreadId,
        title: "保存产物",
        task: "保存验收产物",
      });
      const completed = await until(async () => {
        const result = await workers.get(worker.id);
        return result?.status === "done" && result.resultMessageId
          ? result
          : null;
      });
      await until(async () =>
        (await history(parentThreadId)).some(
          (message) =>
            message.role === "assistant" && message.content === answer,
        ),
      );
      expect(completed.summary).toBe(answer);
      expect(await effectCount()).toBe(before + 2);

      // Crash boundary: the kernel settled, but the worker owner has not recorded its final state.
      const lost = randomUUID(),
        hidden = `worker-${lost}`;
      await runTurn({
        ownerUserId: owner,
        agentId: bot,
        threadId: hidden,
        routineId: `worker:${lost}`,
        instruction: "保存验收产物",
      });
      await database.$client.unsafe(
        "INSERT INTO chisabot_workers(id,owner_user_id,parent_thread_id,agent_id,thread_id,title,task,status) VALUES($1,$2,$3,$4,$5,'恢复任务','保存产物','running')",
        [lost, owner, parentThreadId, bot, hidden],
      );
      const callsBeforeRecovery = modelRequests.length;
      await createWorkerService(workerOptions).recover();
      await until(async () => (await workers.get(lost))?.status === "done");
      await until(async () =>
        (await history(parentThreadId)).some(
          (message) => message.id === `worker-result-${lost}`,
        ),
      );
      await until(
        async () =>
          (await history(parentThreadId)).filter(
            (message) =>
              message.role === "assistant" && message.content === answer,
          ).length === 2,
      );
      await until(
        async () =>
          !(await backend.runner.isRunning({ threadId: parentThreadId })),
      );
      const [hiddenRuns] = await database.$client.unsafe<{ count: number }[]>(
        "SELECT count(*)::int AS count FROM chisabot_dsh_runs WHERE thread_id=$1",
        [hidden],
      );
      expect(hiddenRuns?.count).toBe(1);
      expect(modelRequests.length - callsBeforeRecovery).toBe(2); // Parent delivery only.
    }, 60_000);

    test("task-center lease recovery consumes the same persisted execution attempt", async () => {
      const taskOptions = {
        database,
        runTurn,
        personalSources: {
          scanCalendar: async () => [],
          scanEmails: async () => [],
          status: async () => ({}),
        } as never,
        github: {
          listOpenItems: async () => [],
          status: async () => ({}),
        } as never,
        botAvailable: async () => true,
        defaultAgentFor: async () => bot,
      };
      const center = createTaskCenterRuntime(taskOptions);
      await center.ensure();
      cleanups.push(() => center.stop());
      const task = await center.createTask(owner, {
        title: "任务中心验收",
        description: "保存验收产物",
        level: 2,
        risk: "read",
        agentId: bot,
        completion: {
          criteria: "写入隔离工具回执并返回结果总结",
          required: [],
        },
      });
      await center.controlTask(owner, task.id, "start");
      await center.sweep();
      const complete = await until(async () => {
        const result = await center.getTask(owner, task.id);
        return result?.status === "succeeded" ? result : null;
      });
      expect(complete.summary).toBe(answer);
      expect(complete.attempts).toBe(1);
      const before = await effectCount(),
        calls = modelRequests.length;
      await database.$client.unsafe(
        "UPDATE chisabot_task_center_tasks SET status='running',summary=NULL,lease_owner='lost-api',lease_expires_at=now()-interval '1 minute',finished_at=NULL WHERE id=$1",
        [task.id],
      );
      const restarted = createTaskCenterRuntime(taskOptions);
      cleanups.push(() => restarted.stop());
      await restarted.sweep();
      const restored = await until(async () => {
        const result = await restarted.getTask(owner, task.id);
        return result?.status === "succeeded" ? result : null;
      });
      expect(restored.attempts).toBe(1);
      expect(restored.summary).toBe(answer);
      expect(await effectCount()).toBe(before);
      expect(modelRequests.length).toBe(calls);
    }, 45_000);

    test("worker owner recovery observes a still-running Host instead of marking the task failed", async () => {
      const id = randomUUID(),
        hidden = `worker-${id}`,
        parentThreadId = `${owner}-live-parent`;
      await backend.client.getOrCreateThread({
        threadId: parentThreadId,
        userId: owner,
        agentId: bot,
      });
      const workers = createWorkerService({
        database,
        inbox: backend.inbox,
        control: backend.control,
        runTurn,
        agentOfThread: async () => bot,
      });
      await workers.ensure();
      pauseNextModel = true;
      const executing = runTurn({
        ownerUserId: owner,
        agentId: bot,
        threadId: hidden,
        routineId: `worker:${id}`,
        instruction: "保存验收产物",
      });
      await until(async () => {
        const [run] = await database.$client.unsafe(
          "SELECT 1 FROM chisabot_dsh_runs WHERE thread_id=$1 AND status='observing'",
          [hidden],
        );
        return run;
      });
      await database.$client.unsafe(
        "INSERT INTO chisabot_workers(id,owner_user_id,parent_thread_id,agent_id,thread_id,title,task,status) VALUES($1,$2,$3,$4,$5,'恢复活动任务','保存产物','running')",
        [id, owner, parentThreadId, bot, hidden],
      );
      expect(await workers.recover()).toBe(0);
      expect((await workers.get(id))?.status).toBe("running");
      await executing;
      await until(async () => (await workers.get(id))?.status === "done");
      await until(async () =>
        (await history(parentThreadId)).some(
          (message) =>
            message.role === "assistant" && message.content === answer,
        ),
      );
      await until(
        async () =>
          !(await backend.runner.isRunning({ threadId: parentThreadId })),
      );
      const [count] = await database.$client.unsafe<{ count: number }[]>(
        "SELECT count(*)::int AS count FROM chisabot_dsh_runs WHERE thread_id=$1",
        [hidden],
      );
      expect(count?.count).toBe(1);
    }, 40_000);

    test("IM adapter delivers a real DSH reply and duplicate platform input reuses the receipt", async () => {
      const sockets: ProtocolSocket[] = [];
      const imOptions = {
        database,
        runTurn,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        botAvailable: async () => true,
        resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
        ws: () => {
          const socket = new ProtocolSocket();
          sockets.push(socket);
          return socket;
        },
      };
      const im = createImService(imOptions);
      await im.ensure();
      cleanups.push(() => im.stopAll());
      const connection = await im.create(owner, {
        platform: "onebot",
        name: "隔离 IM",
        agentId: bot,
        config: { mode: "forward", url: "ws://protocol.example.test:3001" },
        ownerUsers: ["555"],
      });
      const socket = await until(async () =>
        sockets[0]?.readyState === 1 ? sockets[0] : null,
      );
      const inbound = {
        post_type: "message",
        message_type: "private",
        self_id: 10001,
        user_id: 555,
        message_id: 100,
        message: "保存验收产物",
      };
      const before = await effectCount();
      socket.push(inbound);
      const reply = await until(async () => socket.replies()[0]);
      expect(reply.params.message[0].data.text).toBe(answer);
      expect(await effectCount()).toBe(before + 1);
      const delivered = await until(async () =>
        (await im.deliveries(owner, connection.id)).find(
          (record) => record.state === "sent",
        ),
      );
      expect(delivered.receipt?.messageIds).toHaveLength(1);
      await im.stopAll();
      const restarted = createImService(imOptions);
      cleanups.push(() => restarted.stopAll());
      await restarted.startAll();
      const restoredSocket = await until(async () =>
        sockets.at(-1)?.readyState === 1 && sockets.at(-1) !== socket
          ? sockets.at(-1)
          : null,
      );
      const calls = modelRequests.length;
      restoredSocket.push(inbound);
      await until(async () =>
        (await restarted.logs(owner, connection.id))?.some((line) =>
          line.text.includes("原消息已有交付记录"),
        ),
      );
      expect(restoredSocket.replies()).toHaveLength(0);
      expect(await effectCount()).toBe(before + 1);
      expect(modelRequests.length).toBe(calls);
      const [thread] = await database.$client.unsafe<{ thread_id: string }[]>(
        "SELECT thread_id FROM chisabot_im_chats WHERE connection_id=$1",
        [connection.id],
      );
      expect(
        (await history(thread!.thread_id)).filter(
          (message) => message.role === "user",
        ),
      ).toHaveLength(1);
      // A saved push can wait offline. A duplicate handoff keeps its exact first body.
      await restarted.stopAll();
      const queuedId = `${connection.id}:offline`;
      await restarted.pushToThread(
        thread!.thread_id,
        "完整的离线回复\n第二行",
        { deliveryId: queuedId },
      );
      await restarted.pushToThread(
        thread!.thread_id,
        "这段不同的文本不应覆盖首次回复",
        { deliveryId: queuedId },
      );
      const resumed = createImService(imOptions);
      cleanups.push(() => resumed.stopAll());
      await resumed.startAll();
      const resumedSocket = await until(async () =>
        sockets.at(-1)?.readyState === 1 && sockets.at(-1) !== restoredSocket
          ? sockets.at(-1)
          : null,
      );
      await resumed.recoverDeliveries();
      await until(async () =>
        (await resumed.deliveries(owner, connection.id)).find(
          (record) =>
            record.id === `push:${queuedId}` && record.state === "sent",
        ),
      );
      expect(
        resumedSocket
          .replies()
          .map((reply) => reply.params.message[0].data.text),
      ).toEqual(["完整的离线回复\n第二行"]);
      await resumed.stopAll();
      await restarted.remove(owner, connection.id);
    }, 40_000);

    test("IM recovers a committed model result and preserves a lost platform acknowledgement without resend", async () => {
      const sockets: ProtocolSocket[] = [];
      let im: ReturnType<typeof createImService>;
      let interrupted = false;
      const imOptions = {
        database,
        encryptionKey: Buffer.alloc(32, 7).toString("base64"),
        botAvailable: async () => true,
        runTurn: (async (input) => {
          const result = await runTurn(input);
          if (!interrupted) {
            interrupted = true;
            await im.stopAll();
            throw new Error("API stopped after model commit");
          }
          return result;
        }) as TurnRunner,
        resolveDns: async () => [{ address: "93.184.216.34", family: 4 }],
        ws: () => {
          const socket = new ProtocolSocket();
          sockets.push(socket);
          return socket;
        },
      };
      im = createImService(imOptions);
      await im.ensure();
      cleanups.push(() => im.stopAll());
      const connection = await im.create(owner, {
        platform: "onebot",
        name: "交付恢复",
        agentId: bot,
        config: { mode: "forward", url: "ws://protocol.example.test:3001" },
        ownerUsers: ["555"],
      });
      const socket = await until(async () =>
        sockets[0]?.readyState === 1 ? sockets[0] : null,
      );
      socket.push({
        post_type: "message",
        message_type: "private",
        self_id: 10001,
        user_id: 555,
        message_id: 201,
        message: "保存验收产物",
      });
      await until(async () => interrupted && socket.readyState === 3);
      const before = await effectCount(),
        calls = modelRequests.length;
      expect(socket.replies()).toHaveLength(0);
      expect(await im.deliveries(owner, connection.id)).toHaveLength(0);
      const restarted = createImService(imOptions);
      cleanups.push(() => restarted.stopAll());
      await restarted.startAll();
      const next = await until(async () =>
        sockets.at(-1)?.readyState === 1 && sockets.at(-1) !== socket
          ? sockets.at(-1)
          : null,
      );
      await until(async () =>
        (await restarted.deliveries(owner, connection.id)).some(
          (record) => record.state === "sent",
        ),
      );
      expect(
        next.replies().map((reply) => reply.params.message[0].data.text),
      ).toEqual([answer]);
      expect(await effectCount()).toBe(before);
      expect(modelRequests.length).toBe(calls);
      const [chat] = await database.$client.unsafe<{ thread_id: string }[]>(
        "SELECT thread_id FROM chisabot_im_chats WHERE connection_id=$1",
        [connection.id],
      );

      // The platform receives this message but loses its acknowledgement; a parallel owner must not steal the active send.
      next.acknowledgeReplies = false;
      const lostId = `${connection.id}:ack-lost`;
      const sending = restarted
        .pushToThread(chat!.thread_id, "平台收到但确认丢失的完整正文", {
          deliveryId: lostId,
        })
        .catch((error) => error);
      await until(async () => next.replies().length === 2);
      const second = createImService(imOptions);
      cleanups.push(() => second.stopAll());
      await second.startAll();
      const secondSocket = await until(async () =>
        sockets.at(-1)?.readyState === 1 && sockets.at(-1) !== next
          ? sockets.at(-1)
          : null,
      );
      await second.recoverDeliveries();
      expect(
        (await second.deliveries(owner, connection.id)).find(
          (record) => record.id === `push:${lostId}`,
        )?.state,
      ).toBe("sending");
      expect(secondSocket.replies()).toHaveLength(0);
      await restarted.stopAll();
      await sending;
      await second.recoverDeliveries();
      const uncertain = (await second.deliveries(owner, connection.id)).find(
        (record) => record.id === `push:${lostId}`,
      );
      expect(uncertain?.state).toBe("outcome_unknown");
      expect(uncertain?.text).toBe("平台收到但确认丢失的完整正文");
      expect(secondSocket.replies()).toHaveLength(0);
      expect(await effectCount()).toBe(before);
      expect(modelRequests.length).toBe(calls);

      // Persisted sending without a live sender models an API death before its completion write.
      await second.stopAll();
      const abandonedId = `${connection.id}:abandoned`;
      await second.pushToThread(chat!.thread_id, "崩溃前已开始发送的正文", {
        deliveryId: abandonedId,
      });
      await database.$client.unsafe(
        "UPDATE chisabot_im_outbox SET state='sending' WHERE id=$1",
        [`push:${abandonedId}`],
      );
      const third = createImService(imOptions);
      cleanups.push(() => third.stopAll());
      await third.startAll();
      const thirdSocket = await until(async () =>
        sockets.at(-1)?.readyState === 1 && sockets.at(-1) !== secondSocket
          ? sockets.at(-1)
          : null,
      );
      await third.recoverDeliveries();
      expect(
        (await third.deliveries(owner, connection.id)).find(
          (record) => record.id === `push:${abandonedId}`,
        )?.state,
      ).toBe("outcome_unknown");
      expect(thirdSocket.replies()).toHaveLength(0);

      // A schedule owner disappears after the Host commits, before it can hand off the IM reply.
      let scheduleAtHandoff = false;
      const schedules = createSchedules(database, {
        runTurn,
        runImTurn: runTurn,
        botAvailable: async () => true,
        pushToIm: async () => {
          scheduleAtHandoff = true;
          await new Promise<void>(() => {});
        },
      });
      await schedules.ensure();
      cleanups.push(() => schedules.stop());
      const schedule = await schedules.create({
        owner,
        agentId: bot,
        threadId: chat!.thread_id,
        imConnectionId: connection.id,
        title: "恢复定时推送",
        instruction: "保存验收产物",
        when: { repeat: "once", in_minutes: 30 },
      });
      const fired = await schedules.runNow(owner, schedule.id);
      await until(async () => scheduleAtHandoff);
      const scheduleCalls = modelRequests.length,
        scheduleEffects = await effectCount();
      const resumedSchedules = createSchedules(database, {
        runTurn,
        runImTurn: runTurn,
        botAvailable: async () => true,
        pushToIm: (threadId, text, opts) =>
          third.pushToThread(threadId, text, opts),
      });
      await resumedSchedules.ensure();
      cleanups.push(() => resumedSchedules.stop());
      const scheduledReply = await until(async () =>
        (await third.deliveries(owner, connection.id)).find(
          (record) =>
            record.id === `push:schedule:${fired.runId}` &&
            record.state === "sent",
        ),
      );
      expect(scheduledReply.text).toBe(answer);
      expect(
        thirdSocket.replies().map((reply) => reply.params.message[0].data.text),
      ).toEqual([answer]);
      expect(modelRequests.length).toBe(scheduleCalls);
      expect(await effectCount()).toBe(scheduleEffects);
      await third.remove(owner, connection.id);
      expect(
        (await third.deliveries(owner, connection.id)).find(
          (record) => record.id === `push:${abandonedId}`,
        )?.text,
      ).toBe("崩溃前已开始发送的正文");
    }, 50_000);
  },
);
