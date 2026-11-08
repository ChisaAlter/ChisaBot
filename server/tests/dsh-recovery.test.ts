import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { HttpAgent } from "@ag-ui/client";
import { createDatabase } from "../src/db/client";
import { createManagedDshRuntimes } from "../src/conversations/managed-runtime";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { DshHostClient } from "../../runtime/dsh/src/client.mjs";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
(address ? test : test.skip)("API process restart rejoins a live managed Host without resubmitting its prompt", async () => {
  const resources: (() => unknown | Promise<unknown>)[] = [];
  try {
    const database = createDatabase(address!, { max: 2 });
    resources.push(() => database.$client.close());
    const suffix = randomUUID(), actorId = `recovery-${suffix}`, botId = `bot-${suffix}`, threadId = `thread-${suffix}`;
    let apiOrigin = "";
    let requests = 0;
    let finishModel!: () => void;
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname === "/steer") {
        if (!apiOrigin) return new Response("restarting", { status: 503 });
        return fetch(`${apiOrigin}/gateway/steer`, { method: "POST", headers: request.headers, body: await request.text() });
      }
      await request.json(); requests++;
      const encode = (delta: unknown, finish_reason: string | null = null) => new TextEncoder().encode(`data: ${JSON.stringify({ id: "restart", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encode({ role: "assistant", content: "Before restart. " }));
        finishModel = () => { controller.enqueue(encode({ content: "After restart." })); controller.enqueue(encode({}, "stop")); controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); };
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
    resources.push(() => bridge.stop(true));
    await mkdir(resolve("runtime/dsh/.runtime"), { recursive: true });
    const root = await mkdtemp(resolve("runtime/dsh/.runtime/recovery-"));
    const manager = createManagedDshRuntimes({ root, gatewayUrl: bridge.url.origin });
    const target = await manager.targetFor(actorId);
    const home = join(root, Buffer.from(actorId).toString("base64url"));
    const hostPid = Number(await readFile(join(home, "host.pid"), "utf8"));
    resources.push(() => { try { process.kill(hostPid); } catch {} });
    expect((await manager.targetFor(actorId)).connectionFile).toBe(target.connectionFile);
    const configPath = join(root, "api-test.json");
    let child: ChildProcess;
    let logs = "";
    const boot = async (recover: boolean) => {
      logs = "";
      await writeFile(configPath, JSON.stringify({ actorId, botId, modelUrl: bridge.url.origin, connectionFile: target.connectionFile, recover }));
      child = spawn(process.execPath, [resolve("server/tests/support/dsh-recovery-server.ts"), configPath], { windowsHide: true, env: { ...process.env, CHISABOT_DSH_TEST_DATABASE_URL: address }, stdio: ["ignore", "pipe", "pipe"] });
      child.stderr!.on("data", data => { logs += data; });
      child.stdout!.on("data", data => { logs += data; });
      for (let i = 0; i < 400; i++) {
        const line = logs.split(/\r?\n/).find(line => line.startsWith('{"ready":true'));
        if (line) { apiOrigin = JSON.parse(line).origin; return; }
        if (child.exitCode !== null) throw new Error(logs);
        await Bun.sleep(50);
      }
      throw new Error(`API did not start: ${logs}`);
    };
    const killApi = async () => {
      apiOrigin = "";
      if (child?.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    };
    resources.push(killApi);
    await boot(false);
    const input = { threadId, runId: randomUUID(), messages: [{ id: `message-${suffix}`, role: "user", content: "Continue across an API restart." }], state: {}, tools: [], context: [] };
    const admission = await fetch(`${apiOrigin}/api/conversations/${threadId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: botId, input }) });
    expect(admission.status).toBe(202);
    const receipt = await admission.json();
    for (let i = 0; i < 300 && !finishModel; i++) await Bun.sleep(20);
    expect(finishModel).toBeDefined();
    // Ensure the product snapshot actually contains the live prefix before killing its owner.
    let stored: any;
    for (let i = 0; i < 100; i++) {
      [stored] = await database.$client.unsafe("SELECT messages FROM openbot_local_threads WHERE id=$1", [threadId]);
      if (stored.messages.some((message: any) => message.content === "Before restart. ")) break;
      await Bun.sleep(20);
    }
    expect(stored.messages.some((message: any) => message.content === "Before restart. ")).toBe(true);
    await killApi();
    await boot(true);
    let prefixSeen!: () => void;
    const prefix = new Promise<void>(resolve => { prefixSeen = resolve; });
    const observer = new HttpAgent({ url: `${apiOrigin}/api/conversations/${threadId}/events`, fetch: (url, init) => fetch(url, { ...init, body: JSON.stringify({ commandId: receipt.commandId }) }) });
    const done = observer.runAgent({ threadId }, { onMessagesChanged: ({ messages }) => {
      if (messages.some(message => message.content === "Before restart. ")) prefixSeen();
    } });
    await prefix;
    finishModel();
    await done;
    const savedRun = await createDshRunJournal(database).get(threadId, receipt.runId);
    const runtime = await DshHostClient.connect(JSON.parse(await readFile(target.connectionFile, "utf8")).endpoint);
    const source = await runtime.eventsAfter(savedRun!.session_id, -1);
    await runtime.close();
    expect(requests).toBe(1);
    expect(observer.messages.filter(message => message.role === "assistant").map(message => message.content), JSON.stringify({ logs, baseline: savedRun?.baseline, source })).toEqual(["Before restart. After restart."]);
    expect((await createDshRunJournal(database).get(threadId, receipt.runId))?.status).toBe("settled");
  } finally { for (const close of resources.reverse()) await close(); }
}, 120_000);
