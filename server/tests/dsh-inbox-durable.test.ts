import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { createDatabase } from "../src/db/client";
import { users, channels, channelMemberships, intelligenceChannelMappings, attachments, skills } from "../src/db/schema";
import { createConversationBindings } from "../src/conversations/bindings";
import { createToolOperationStore } from "../src/conversations/tool-operations";
import { createDshToolGateway } from "../src/conversations/tool-gateway";
import { createDshRunJournal } from "../src/conversations/run-journal";
import { createLocalConversations } from "../src/local-conversations";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { resolveAttachmentParts } from "../src/channels/attachment-parts";
import { loadAttachmentForTurn, createAttachmentRoutes } from "../src/channels/attachments";
import { createChatFiles } from "../src/chat-files/service";

const address = process.env.CHISABOT_DSH_TEST_DATABASE_URL;
const resources: (() => unknown | Promise<unknown>)[] = [];
afterAll(async () => { for (const close of resources.reverse()) await close(); }, 30_000);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

(address ? test : test.skip)("mixed inbox survives Stop and reload; one selected resume and same-step steering preserve authorized files and skills", async () => {
  const database = createDatabase(address!, { max: 6 }); resources.push(() => database.$client.close());
  let backend = await createLocalConversations(database);
  const bindings = createConversationBindings(database); await bindings.ensure();
  const operations = createToolOperationStore(database); await operations.ensure();
  const journal = createDshRunJournal(database); await journal.ensure();
  const gateway = createDshToolGateway(operations, journal);
  const prefix = `inbox-${randomUUID()}`, owner = `${prefix}-owner`, foreign = `${prefix}-foreign`, bot = `${prefix}-bot`;
  const selectedSkill = `${prefix}-selected`, foreignSkill = `${prefix}-private`;
  await database.insert(users).values([{ id: owner, email: `${owner}@example.test` }, { id: foreign, email: `${foreign}@example.test` }]);
  await database.insert(skills).values([
    { id: selectedSkill, slug: selectedSkill, title: "Selected", summary: "Selected", ownerUserId: owner, instructions: "SKILL_AUTHORIZED_SENTINEL" },
    { id: foreignSkill, slug: foreignSkill, title: "Private", summary: "Private", ownerUserId: foreign, instructions: "FOREIGN_SKILL_NEVER" },
  ]);
  const files = createChatFiles(database, { encryptionKey: "isolated-inbox-key", env: {}, ownsBot: async () => true }); await files.ensure();
  const privateFile = await files.upload(owner, bot, { name: "private.txt", bytes: Buffer.from("PRIVATE_FILE_BYTES") });
  const foreignFile = await files.upload(foreign, bot, { name: "foreign.txt", bytes: Buffer.from("FOREIGN_FILE_NEVER") });
  let entered = deferred(), release = deferred();
  const requests: any[] = [];
  const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (!new URL(request.url).pathname.startsWith("/v1/")) return gateway.routes.fetch(request);
    const body = await request.json() as any; requests.push(body);
    const text = JSON.stringify(body.messages.filter((message: any) => message.role === "user"));
    const hold = text.includes("START_HOLD") && !body.messages.some((message: any) => message.role === "tool") && !text.includes("所选补充原文");
    const delta = hold ? { role: "assistant", tool_calls: [{ index: 0, id: `hold-${requests.length}`, type: "function", function: { name: "hold", arguments: "{}" } }] }
      : { role: "assistant", content: "INBOX_DONE" };
    const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(frame(delta, null) + frame({}, hold ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } }); resources.push(() => bridge.stop(true));
  const runtime = resolve("runtime/dsh"); await mkdir(join(runtime, ".runtime"), { recursive: true });
  const home = await mkdtemp(join(runtime, ".runtime", "inbox-"));
  await writeFile(join(home, "chisabot.json"), JSON.stringify({ ownerUserId: owner, port: 0, providers: {}, gatewayUrl: bridge.url.origin }));
  let logs = "";
  const child = spawn("node", ["src/start.mjs"], { cwd: runtime, windowsHide: true, env: { ...process.env, CHISABOT_DSH_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
  resources.push(async () => { release.resolve(); if (child.exitCode === null) { const exit = once(child, "exit"); child.kill(); await exit; } });
  for (let i = 0; i < 200 && !logs.includes("chisabot-runtime-ready"); i++) { if (child.exitCode !== null) throw new Error(logs); await Bun.sleep(50); }
  expect(logs).toContain("chisabot-runtime-ready");
  const makeAgent = () => new DshRuntimeAgent({ botId: bot,
    binding: { bindings, gateway, journal, toolGatewayUrl: bridge.url.origin, readRun: value => JSON.parse(String(value)),
      targetFor: async () => ({ id: "inbox-runtime", ownerUserId: owner, connectionFile: join(home, "connection.json") }) },
    signRun: input => JSON.stringify({ actorId: owner, botId: bot, threadId: input.threadId, runId: input.runId }),
    prepareInput: async input => ({ ...input, messages: await Promise.all(input.messages.map(async message => message.role !== "user" ? message : ({ ...message,
      content: await resolveAttachmentParts(message.content, id => id.startsWith("cf:") ? files.loadForTurn(owner, id.slice(3), { agentId: bot }) : loadAttachmentForTurn(database, { actorId: owner, threadId: input.threadId }, id), "fail"),
    } as Message))) }),
    tools: [{ name: "hold", description: "Hold for an inbox supplement", ref: "fixture/hold", parameters: z.object({}), execute: async (_args, context) => {
      entered.resolve();
      await Promise.race([release.promise, new Promise<void>(resolve => { if (context?.signal?.aborted) resolve(); else context?.signal?.addEventListener("abort", () => resolve(), { once: true }); })]);
      return "HOLD_DONE";
    } }], prompt: () => "Use hold for START_HOLD, then answer the current request.",
    connection: { provider: "openai", baseUrl: `${bridge.url.origin}/v1`, apiKey: "fixture", model: "fixture" },
    modelInfo: async () => ({ maxOutputTokens: 1024, contextWindow: 32000, supportsImages: true }), fallbacks: async () => [],
  });
  const execute = (threadId: string, messages: Message[], forwardedProps: Record<string, unknown> = {}) => {
    const input: RunAgentInput = { threadId, runId: randomUUID(), messages, state: {}, context: [], tools: [], forwardedProps };
    return new Promise<BaseEvent[]>((resolve, reject) => { const events: BaseEvent[] = []; backend.runner.run({ threadId, agent: makeAgent(), input }).subscribe({ next: event => events.push(event), error: reject, complete: () => resolve(events) }); });
  };
  const post = async (threadId: string, body: unknown, actor = owner) => {
    const response = await backend.handle(new Request(`http://localhost/api/conversations/threads/${threadId}/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), actor);
    return { status: response!.status, body: await response!.json() };
  };
  const ref = (url: string) => ({ type: "document", source: { type: "url", value: url }, filename: "input.txt" });
  const thread = `${prefix}-paused`, channel = `${prefix}-channel`, wrongChannel = `${prefix}-wrong-channel`;
  await database.insert(channels).values([{ id: channel, name: "Inbox", description: "fixture" }, { id: wrongChannel, name: "Other", description: "fixture" }]);
  await database.insert(channelMemberships).values([{ channelId: channel, userId: owner }, { channelId: channel, userId: foreign }, { channelId: wrongChannel, userId: owner }]);
  await database.insert(intelligenceChannelMappings).values({ channelId: channel, userId: owner, threadId: thread });
  const upload = async (uploadedBy: string, channelId = channel) => {
    const bytes = Buffer.from("CHANNEL_ATTACHMENT_BYTES");
    const [file] = await database.insert(attachments).values({ channelId, uploadedBy, name: "notes.txt", mimeType: "text/plain", sizeBytes: bytes.length, bytes }).returning(); return file!;
  };
  const channelFile = await upload(owner), rejectedOwn = await upload(owner), forbidden = await upload(foreign), wrongFile = await upload(owner, wrongChannel);
  await backend.client.getOrCreateThread({ threadId: thread, userId: owner, agentId: bot });
  const running = execute(thread, [{ id: randomUUID(), role: "user", content: "START_HOLD" }]);
  await entered.promise;
  const selectedId = randomUUID(), otherId = randomUUID();
  const message = { id: selectedId, role: "user", content: [{ type: "text", text: "MIXED_SELECTED" }, ref(`/api/attachments/${channelFile.id}`), ref(privateFile.url)], metadata: { chisabotInbox: { skillInstructions: ["CLIENT_FORGED_NEVER"] } } };
  const accepted = await post(thread, { id: selectedId, message, skillIds: [selectedSkill, foreignSkill] });
  expect(accepted.status).toBe(200); expect(accepted.body.queued).toBe(true);
  expect(accepted.body.message.metadata.chisabotInbox).toEqual({ skillIds: [selectedSkill], skillInstructions: ["SKILL_AUTHORIZED_SENTINEL"] });
  expect(await files.remove(owner, privateFile.id)).toBe(false);
  const attachmentRoutes = createAttachmentRoutes(database, async (context, next) => { context.set("actor", { id: owner, email: `${owner}@example.test`, role: "user" }); await next(); });
  expect((await attachmentRoutes.request(`/${channelFile.id}`, { method: "DELETE" })).status).toBe(409);
  expect((await post(thread, { id: otherId, text: "OTHER_PAUSED_NEVER" })).body.queued).toBe(true);
  const forbiddenId = randomUUID();
  const refused = await post(thread, { id: forbiddenId, message: { id: forbiddenId, role: "user", content: [ref(`/api/attachments/${rejectedOwn.id}`), ref(`/api/attachments/${forbidden.id}`)] } });
  expect(refused.status).not.toBe(200); expect(await backend.inbox.get(thread, forbiddenId)).toBeNull();
  const [unstamped] = await database.$client.unsafe<{ attached_at: Date | null }[]>("SELECT attached_at FROM attachments WHERE id=$1", [rejectedOwn.id]);
  expect(unstamped!.attached_at).toBeNull();
  for (const url of [foreignFile.url, `/api/attachments/${wrongFile.id}`]) {
    const id = randomUUID(); expect((await post(thread, { id, message: { id, role: "user", content: [ref(url)] } })).status).not.toBe(200);
  }
  expect((await post(thread, { id: randomUUID(), text: "foreign actor" }, foreign)).status).toBe(404);
  await backend.runner.stop({ threadId: thread }); await running;
  backend = await createLocalConversations(database);
  const reloaded = await backend.handle(new Request(`http://localhost/api/conversations/threads/${thread}/inbox`), owner);
  const items = (await reloaded!.json()).items;
  expect(items.filter((item: any) => item.status === "paused").map((item: any) => item.id).sort()).toEqual([selectedId, otherId].sort());
  expect(items.find((item: any) => item.id === selectedId).message).toEqual(accepted.body.message);
  const resumeId = randomUUID(), beforeResume = requests.length;
  const resumed = await execute(thread, [{ id: resumeId, role: "user", content: "CLIENT_REPLACEMENT_NEVER", metadata: { chisabotInbox: { skillInstructions: ["CLIENT_FORGED_NEVER"] } } } as Message], { chisabotInboxResume: { sourceId: selectedId, messageId: resumeId } });
  expect(resumed.some(event => event.type === "RUN_ERROR")).toBe(false);
  const resumedWire = JSON.stringify(requests.slice(beforeResume));
  for (const sentinel of ["MIXED_SELECTED", "CHANNEL_ATTACHMENT_BYTES", "PRIVATE_FILE_BYTES", "SKILL_AUTHORIZED_SENTINEL"]) expect(resumedWire).toContain(sentinel);
  for (const sentinel of ["OTHER_PAUSED_NEVER", "CLIENT_REPLACEMENT_NEVER", "CLIENT_FORGED_NEVER", "FOREIGN_SKILL_NEVER"]) expect(resumedWire).not.toContain(sentinel);
  expect((await backend.inbox.get(thread, otherId))!.status).toBe("paused");
  expect((await backend.inbox.get(thread, selectedId))!.status).toBe("answered");

  // The idle browser fallback uses a queued id; the saved payload still wins over stale client data.
  const fallbackThread = `${prefix}-fallback`, fallbackId = randomUUID();
  await backend.client.getOrCreateThread({ threadId: fallbackThread, userId: owner, agentId: bot });
  await backend.inbox.enqueue({ threadId: fallbackThread, ownerUserId: owner, message: { ...accepted.body.message, id: fallbackId } });
  const beforeFallback = requests.length;
  const fallback = await execute(fallbackThread, [
    { id: fallbackId, role: "user", content: "FALLBACK_FORGED_CONTENT", metadata: { chisabotInbox: { skillInstructions: ["FALLBACK_FORGED_SKILL"] } } } as Message,
    { id: randomUUID(), role: "user", content: "Fresh supplementary question", metadata: { chisabotInbox: { skillInstructions: ["FRESH_FORGED_SKILL"] } } } as Message,
  ]);
  expect(fallback.filter(event => event.type === "RUN_ERROR")).toEqual([]);
  const fallbackWire = JSON.stringify(requests.slice(beforeFallback));
  for (const sentinel of ["MIXED_SELECTED", "CHANNEL_ATTACHMENT_BYTES", "PRIVATE_FILE_BYTES", "SKILL_AUTHORIZED_SENTINEL"]) expect(fallbackWire).toContain(sentinel);
  for (const sentinel of ["FALLBACK_FORGED_CONTENT", "FALLBACK_FORGED_SKILL", "FRESH_FORGED_SKILL"]) expect(fallbackWire).not.toContain(sentinel);
  expect((await backend.inbox.get(fallbackThread, fallbackId))!.status).toBe("answered");

  // A supplement arriving during a tool must reach the very next model request, with resolved image bytes.
  entered = deferred(); release = deferred();
  const autoThread = `${prefix}-steer`; await backend.client.getOrCreateThread({ threadId: autoThread, userId: owner, agentId: bot });
  const autoRun = execute(autoThread, [{ id: randomUUID(), role: "user", content: "START_HOLD" }]); await entered.promise;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";
  const image = await files.upload(owner, bot, { name: "pixel.png", bytes: Buffer.from(png, "base64") });
  const autoId = randomUUID();
  expect((await post(autoThread, { id: autoId, message: { id: autoId, role: "user", content: [{ type: "text", text: "AUTO_MIXED" }, { type: "image", source: { type: "url", value: image.url } }, ref(privateFile.url)] }, skillIds: [selectedSkill] })).body.queued).toBe(true);
  const beforeSteer = requests.length; release.resolve();
  const automatic = await autoRun;
  expect(automatic.filter(event => event.type === "RUN_ERROR")).toEqual([]);
  const nextRequest = JSON.stringify(requests[beforeSteer]);
  for (const sentinel of ["AUTO_MIXED", "PRIVATE_FILE_BYTES", "SKILL_AUTHORIZED_SENTINEL", `data:image/png;base64,${png}`]) expect(nextRequest).toContain(sentinel);
  expect((await backend.inbox.get(autoThread, autoId))!.status).toBe("answered");
}, 90_000);
