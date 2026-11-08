import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { z } from "zod";
import { createDatabase } from "../src/db/client";
import { createLocalConversations, type LocalHistoryMessage } from "../src/local-conversations";
import { createConversationBindings } from "../src/conversations/bindings";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createConversationRoutes } from "../src/conversations/routes";
import { createConfirmations, digestOf } from "../src/confirmations/service";
import { createConfirmationResumer } from "../src/conversations/confirmation-resume";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { createTurnRunner } from "../src/turns/run-turn";
import { resolveAttachmentParts } from "../src/channels/attachment-parts";
import { buildAgents, standingRoleMessage } from "../src/copilot";
import { filesFromToolResult, CHAT_FILES_MARKER } from "../../shared/chat-files";
import { createChatFiles } from "../src/chat-files/service";
import { renderUiTools } from "../src/generative-ui/render-ui";
import { RENDER_UI_SHOWN } from "../../shared/json-render/catalog";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const resources: (() => unknown | Promise<unknown>)[] = [];
afterAll(async () => { for (const close of resources.reverse()) await close(); }, 30_000);
const eventsOf = async (response: Response) => (await response.text()).split("\n").filter(line => line.startsWith("data: "))
  .map(line => JSON.parse(line.slice(6))) as Array<BaseEvent & Record<string, any>>;
// A decoded 1 x 1 sRGB PNG. Tiny placeholder strings can have valid headers but invalid pixels.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";
const cardSpec = JSON.stringify({ root: "card", elements: {
  card: { type: "Card", props: { title: "Delivered card" }, children: ["text"] },
  text: { type: "Text", props: { text: "A readable card without a final text reply." }, children: [] },
} });

(address ? describe : describe.skip)("DSH attachments, edited branches and AG-UI compatibility", () => {
  let database: ReturnType<typeof createDatabase>;
  let backend: Awaited<ReturnType<typeof createLocalConversations>>;
  let bindings: ReturnType<typeof createConversationBindings>;
  let journal: ReturnType<typeof createDshRunJournal>;
  let routes: ReturnType<typeof createConversationRoutes>;
  let confirmations: ReturnType<typeof createConfirmations>;
  let chatFiles: ReturnType<typeof createChatFiles>;
  let agent: DshRuntimeAgent;
  let card: { id: string; threadId: string } | undefined;
  let effects = 0;
  const requests: any[] = [];
  const suffix = randomUUID(), owner = `boundaries-${suffix}`, bot = `${owner}-bot`, thread = `${owner}-thread`;
  const imageId = `${owner}-image`, askApprovalId = `${owner}-approval`, editedId = `${owner}-edited`;
  let home = "";
  let modelServer: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    database = createDatabase(address!, { max: 4 }); resources.push(() => database.$client.close());
    backend = await createLocalConversations(database);
    bindings = createConversationBindings(database); await bindings.ensure();
    journal = createDshRunJournal(database); await journal.ensure();
    confirmations = createConfirmations(database); await confirmations.ensure();
    confirmations.setOnOpened(value => { card = value as typeof card; });
    const operations = createToolOperationStore(database); await operations.ensure();
    const gateway = createDshToolGateway(operations, journal);
    modelServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/v1/")) return gateway.routes.fetch(request);
      const body = await request.json() as any; requests.push(body);
      // DSH appends a runtime-context user record on a new Session; select the explicit fixture
      // request rather than mistaking that machine context for the person's newest request.
      const text = body.messages.filter((message: any) => message.role === "user")
        .map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
        .findLast((content: string) => ["pause-before-edit", "edited-branch", "file-only", "card-only", "empty-only"].includes(content));
      let delta: Record<string, unknown> = { role: "assistant", content: text?.includes("edited-branch") ? "Edited branch answered." : "Image received." };
      let finish = "stop";
      if (text?.includes("pause-before-edit")) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: "protected-call", type: "function", function: { name: "protected_operation", arguments: '{"value":"original"}' } }] };
        finish = "tool_calls";
      } else if (text === "empty-only") delta = { role: "assistant", content: "" };
      else if (text === "file-only" || text === "card-only") {
        const result = body.messages.findLast((message: any) => message.role === "tool");
        if (!result) {
          delta = { role: "assistant", tool_calls: [{ index: 0, id: "delivery-call", type: "function", function: text === "file-only"
            ? { name: "file_share", arguments: '{}' } : { name: "render_ui", arguments: JSON.stringify({ title: "Delivered card", spec: cardSpec }) } }] };
          finish = "tool_calls";
        } else delta = { role: "assistant", content: "" };
      }
      const chunk = (change: unknown, reason: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model,
        choices: [{ index: 0, delta: change, finish_reason: reason }] })}\n\n`;
      return new Response(chunk(delta) + chunk({}, finish) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    } }); resources.push(() => modelServer.stop(true));
    const runtime = resolve("runtime/dsh"); await mkdir(join(runtime, ".runtime"), { recursive: true });
    home = await mkdtemp(join(runtime, ".runtime", "history-"));
    chatFiles = createChatFiles(database, { encryptionKey: "isolated-boundaries-file-key", env: {},
      ownsBot: async (actor, agentId) => actor === owner && agentId === bot,
      workspace: { write: async () => false, read: async () => ({ name: "delivered.txt", bytes: await readFile(join(home, "delivered.txt")) }) },
    });
    await chatFiles.ensure();
    await writeFile(join(home, "chisabot.json"), JSON.stringify({ ownerUserId: owner, port: 0, providers: {}, gatewayUrl: modelServer.url.origin }));
    let log = "";
    const child = spawn("node", ["src/start.mjs"], { cwd: runtime, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
    resources.push(async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
    for (let at = 0; at < 300 && !log.includes("chisabot-runtime-ready"); at++) { if (child.exitCode !== null) throw new Error(log); await Bun.sleep(100); }
    expect(log).toContain("chisabot-runtime-ready");
    agent = new DshRuntimeAgent({ botId: bot, binding: { bindings, journal, gateway, toolGatewayUrl: modelServer.url.origin,
      readRun: signed => JSON.parse(String(signed)), targetFor: async () => ({ id: "history-runtime", ownerUserId: owner, connectionFile: join(home, "connection.json") }),
      revisionFor: async id => { const [row] = await database.$client.unsafe<{ n: number }[]>("SELECT (count(*)+1)::integer AS n FROM chisabot_thread_truncations WHERE thread_id=$1", [id]); return row!.n; },
    }, signRun: input => JSON.stringify({ actorId: owner, botId: bot, threadId: input.threadId, runId: input.runId }),
      prepareInput: async input => ({ ...input, messages: await Promise.all(input.messages.map(async message => message.role !== "user" ? message : ({ ...message,
        content: await resolveAttachmentParts(message.content, async id => id === imageId ? { mimeType: "image/png", name: "pixel.png", bytes: Buffer.from(png, "base64") } : null, "fail"),
      } as Message))) }),
      tools: [{ name: "protected_operation", ref: "test/protected", description: "An isolated approved action.", parameters: z.object({ value: z.string() }), execute: async args => {
        const decision = await confirmations.check({ ownerUserId: owner, agentId: bot, category: "message", tool: "protected_operation", title: "Isolated approval", target: "fixture", matchText: "fixture", digest: digestOf("protected_operation", args) });
        if (!decision.ok) return decision.message; effects++; return "done";
      } }, { name: "file_share", ref: "test/file", description: "Deliver one isolated artifact.", parameters: z.object({}), execute: async () => {
        await writeFile(join(home, "delivered.txt"), "isolated artifact");
        const file = await chatFiles.share(owner, bot, "delivered.txt");
        return `${CHAT_FILES_MARKER}${JSON.stringify([file])}`;
      } }, ...renderUiTools()], prompt: () => "Follow the fixture request.", connection: { provider: "openai", baseUrl: `${modelServer.url.origin}/v1`, useApiKey: false, apiKey: null, model: "vision-fixture" },
      modelInfo: async () => ({ contextWindow: 32000, maxOutputTokens: 1024, supportsImages: true }), fallbacks: async () => [],
    });
    routes = createConversationRoutes({ backend, identifyActor: async () => ({ id: owner, role: "user" }), resolver: {
      resolveAgentForActor: async () => agent.clone(), resolveAgentsForActor: async () => ({ [bot]: agent.clone() }),
    } });
  }, 40_000);

  const inputFor = (id: string, content: Message["content"], threadId = thread): RunAgentInput => ({ threadId, runId: randomUUID(), messages: [{ id, role: "user", content } as Message], tools: [], state: {}, context: [] });
  const legacyRun = async (input: RunAgentInput) => eventsOf(await routes.request(`/api/copilotkit/agent/${bot}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }));

  test("authorized image bytes reach the real Host provider and remain references in visible history", async () => {
    const events = await legacyRun(inputFor(imageId, [{ type: "text", text: "Inspect the attached pixel." }, { type: "image", source: { type: "url", value: `/api/attachments/${imageId}` } }]));
    expect(events.find(event => event.type === "RUN_ERROR")).toBeUndefined();
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    expect(JSON.stringify(requests[0].messages)).toContain(`data:image/png;base64,${png}`);
    const stored = await backend.client.getThreadMessages({ threadId: thread, userId: owner });
    expect(JSON.stringify(stored.messages)).toContain(`/api/attachments/${imageId}`);
    expect(JSON.stringify(stored.messages)).not.toContain(png);
  }, 30_000);

  test("an edit immediately fences an approved old branch and new execution uses a new Session", async () => {
    const waiting = await legacyRun(inputFor(askApprovalId, "pause-before-edit"));
    expect(waiting.at(-1)?.outcome?.type, JSON.stringify({ waiting, requests })).toBe("interrupt");
    const oldBinding = await bindings.get(thread); expect(oldBinding).not.toBeNull();
    await confirmations.decide(owner, card!.id, "approve");
    const requestCount = requests.length;
    const response = await backend.handle(new Request(`http://localhost/api/copilotkit/threads/${thread}/truncate`, { method: "POST", body: JSON.stringify({ fromMessageId: askApprovalId, mode: "edit" }) }), owner);
    expect(response?.status).toBe(200);
    expect(await bindings.get(thread)).toBeNull();
    const runTurn = createTurnRunner({ intelligence: backend.client, runner: backend.runner, buildAgentFor: async () => agent.clone() });
    const resume = createConfirmationResumer({ database, backend, confirmations, runTurn, buildAgentFor: async () => agent.clone() });
    await resume(owner, card!.id);
    expect(effects).toBe(0); expect(requests.length).toBe(requestCount);
    const [archive] = await database.$client.unsafe<{ previous_messages: Message[] }[]>("SELECT previous_messages FROM chisabot_thread_truncations WHERE thread_id=$1 ORDER BY id DESC LIMIT 1", [thread]);
    expect(archive?.previous_messages.some(message => message.id === askApprovalId)).toBe(true);
    const result = await legacyRun(inputFor(editedId, "edited-branch"));
    expect(result.find(event => event.type === "RUN_ERROR")).toBeUndefined();
    const nextBinding = await bindings.get(thread);
    expect(nextBinding?.sessionId).not.toBe(oldBinding?.sessionId); expect(nextBinding?.revision).toBe(2);
    const stored = await backend.client.getThreadMessages({ threadId: thread, userId: owner });
    expect(stored.messages.some(message => message.id === imageId)).toBe(true);
    expect(stored.messages.some(message => message.id === askApprovalId)).toBe(false);
    expect(stored.messages.some(message => message.content === "Edited branch answered.")).toBe(true);
    expect(JSON.stringify(requests.at(-1).messages)).not.toContain("pause-before-edit");
    const connected = await eventsOf(await routes.request(`/api/copilotkit/agent/${bot}/connect`, { method: "POST", body: JSON.stringify({ threadId: thread }) }));
    expect(connected.find(event => event.type === "MESSAGES_SNAPSHOT")?.messages.some((message: Message) => message.id === editedId)).toBe(true);
    expect(connected.at(-1)?.type).toBe("RUN_FINISHED");
  }, 30_000);

  test("file-only delivery retains the artifact and a successful terminal", async () => {
    const fileThread = `${thread}-files`;
    const events = await legacyRun(inputFor(`${imageId}-file`, "file-only", fileThread));
    expect(events.find(event => event.type === "RUN_ERROR"), JSON.stringify(events)).toBeUndefined();
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const stored = await backend.client.getThreadMessages({ threadId: fileThread, userId: owner });
    const artifacts = stored.messages.filter(message => message.role === "tool").flatMap(message => filesFromToolResult(message.content));
    expect(artifacts.map(file => file.name), JSON.stringify({ events, messages: stored.messages, requests })).toEqual(["delivered.txt"]);
    const files = chatFiles.routes(async (context, next) => { context.set("actor", { id: context.req.header("x-actor") ?? owner, role: "user" }); await next(); });
    const download = await files.request(`/${artifacts[0]!.id}?download=1`);
    expect(download.status).toBe(200); expect(await download.text()).toBe("isolated artifact");
    expect(download.headers.get("content-disposition")).toContain("delivered.txt");
    expect((await files.request(`/${artifacts[0]!.id}`, { headers: { "x-actor": "another-account" } })).status).toBe(404);
    // An artifact from an earlier request must not turn a genuinely empty new answer into success.
    const empty = await legacyRun(inputFor(`${imageId}-empty`, "empty-only", fileThread));
    expect(empty.find(event => event.type === "RUN_ERROR")?.message).toContain("no content");
  }, 30_000);

  test("card-only delivery retains a validated render_ui result and a successful terminal", async () => {
    const cardThread = `${thread}-cards`;
    const events = await legacyRun(inputFor(`${imageId}-card`, "card-only", cardThread));
    expect(events.find(event => event.type === "RUN_ERROR"), JSON.stringify(events)).toBeUndefined();
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const stored = await backend.client.getThreadMessages({ threadId: cardThread, userId: owner });
    expect(stored.messages.some(message => message.role === "tool" && String(message.content).startsWith(RENDER_UI_SHOWN))).toBe(true);
    const rendered = (stored.messages as LocalHistoryMessage[]).flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []).find(call => call.name === "render_ui");
    const storedArgs: unknown = rendered?.args;
    expect(typeof storedArgs === "string" ? JSON.parse(storedArgs) : storedArgs).toEqual({ title: "Delivered card", spec: cardSpec });
    const empty = await legacyRun(inputFor(`${imageId}-empty-card`, "empty-only", cardThread));
    expect(empty.find(event => event.type === "RUN_ERROR")?.message).toContain("no content");
  }, 30_000);

  test("a registered external AG-UI Bot still answers and reconnects over legacy client routes", async () => {
    const remoteId = `${bot}-remote`, remoteThread = `${thread}-remote`;
    let remoteCalls = 0;
    const remote = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const input = await request.json() as RunAgentInput; remoteCalls++;
      const waiting = input.messages.some(message => message.role === "user" && message.content === "Wait until stopped.");
      const events = [{ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId }, { type: "TEXT_MESSAGE_START", messageId: "remote-answer", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "remote-answer", delta: "Remote compatible." }, { type: "TEXT_MESSAGE_END", messageId: "remote-answer" }, { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId }];
      if (waiting) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(events.slice(0, 3).map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
      } }), { headers: { "content-type": "text/event-stream" } });
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } }); resources.push(() => remote.stop(true));
    const built = await buildAgents([{ id: remoteId, name: "External fixture", type: "remote_ag_ui", endpoint: remote.url.origin,
      standingMessage: standingRoleMessage({ id: remoteId, name: "External fixture", title: "Compatibility", roleDescription: "Reply to requests." }) }], { provider: "openai", defaultModel: "unused" }, null);
    const remoteRoutes = createConversationRoutes({ backend, identifyActor: async () => ({ id: owner, role: "user" }), resolver: { resolveAgentForActor: async () => built[remoteId]!.clone(), resolveAgentsForActor: async () => built } });
    const input = inputFor(`${remoteId}-user`, "Hello", remoteThread);
    const events = await eventsOf(await remoteRoutes.request(`/api/copilotkit/agent/${remoteId}/run`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } }));
    expect(events.find(event => event.type === "RUN_ERROR"), JSON.stringify(events)).toBeUndefined();
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
    const replay = await eventsOf(await remoteRoutes.request(`/api/copilotkit/agent/${remoteId}/connect`, { method: "POST", body: JSON.stringify({ threadId: remoteThread }) }));
    expect(JSON.stringify(replay)).toContain("Remote compatible."); expect(remoteCalls).toBe(1);
    const stopThread = `${remoteThread}-stop`;
    const active = await remoteRoutes.request(`/api/copilotkit/agent/${remoteId}/run`, { method: "POST", body: JSON.stringify(inputFor(`${remoteId}-stop`, "Wait until stopped.", stopThread)), headers: { "content-type": "application/json" } });
    const stoppedEvents = eventsOf(active);
    for (let at = 0; at < 100 && remoteCalls < 2; at++) await Bun.sleep(20);
    expect(remoteCalls).toBe(2);
    const stopped = await remoteRoutes.request(`/api/copilotkit/agent/${remoteId}/stop/${stopThread}`, { method: "POST", body: "{}" });
    expect(stopped.status).toBe(200); expect(await stopped.json()).toMatchObject({ stopped: true });
    expect((await stoppedEvents).at(-1)?.type).toBe("RUN_FINISHED");
    const [run] = await database.$client.unsafe<{ status: string }[]>("SELECT status FROM openbot_local_runs WHERE thread_id=$1", [stopThread]);
    expect(run?.status).toBe("stopped");
  }, 30_000);
});
