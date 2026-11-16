import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import sharp from "sharp";
import { z } from "zod";
import type { DshHostClient } from "../../runtime/dsh/src/client.mjs";
import type { ConversationBinding } from "../../shared/conversations";
import { DshRuntimeAgent } from "../src/agents/dsh-runtime";
import { solidPng } from "../src/chat-files/vision-provider";
import { createChatShots } from "../src/chat-shots";
import type { ConversationBindings } from "../src/conversations/bindings";
import {
  createDshToolGateway,
  type DshToolRegistration,
} from "../src/conversations/tool-gateway";
import {
  emitToolImage,
  type ToolImagePart,
  withToolImageCollector,
} from "../src/conversations/tool-images";
import type {
  ToolOperationClaim,
  ToolOperationInput,
  ToolOperationResult,
  ToolOperationStore,
} from "../src/conversations/tool-operations";
import type { Database } from "../src/db/client";
import type { GrantedTool } from "../src/plugins/tools";
import type { WireBody } from "./support/wire-types";

type SettledRecord = {
  id: string;
  status: string;
  result: ToolOperationResult;
};

/** 仅用于测试的内存操作账本，校验写入持久层的内容绝不夹带图片 base64。 */
function createMemoryOperationStore() {
  const records = new Map<
    string,
    {
      input: ToolOperationInput;
      status: string;
      result?: ToolOperationResult;
    }
  >();
  const settledLog: SettledRecord[] = [];

  const store: ToolOperationStore = {
    async ensure() {},
    async waitingForConfirmation() {},
    async resumeConfirmation() {
      return { kind: "conflict" };
    },
    async claim(input: ToolOperationInput): Promise<ToolOperationClaim> {
      const existing = [...records.entries()].find(
        ([, entry]) =>
          entry.input.bindingId === input.bindingId &&
          entry.input.sessionId === input.sessionId &&
          entry.input.turn === input.turn &&
          entry.input.step === input.step &&
          entry.input.callId === input.callId,
      );
      if (existing) {
        const [id, entry] = existing;
        if (
          (entry.status === "completed" || entry.status === "failed") &&
          entry.result
        ) {
          return { kind: "completed", id, result: entry.result };
        }
        return { kind: "pending", id, state: entry.status };
      }
      const id = randomUUID();
      records.set(id, { input, status: "dispatching" });
      return { kind: "claimed", id };
    },
    async markOutcomeUnknown(id: string) {
      const entry = records.get(id);
      if (entry && entry.status === "dispatching") {
        entry.status = "outcome_unknown";
      }
    },
    async listUnknown() {
      return [];
    },
    async resolveOutcome() {
      return { record: undefined, alreadyAccepted: false };
    },
    async settle(id, status, result) {
      const entry = records.get(id);
      if (!entry) throw new Error("未找到对应的工具操作记录。");
      entry.status = status;
      entry.result = result;
      settledLog.push({ id, status, result });
    },
  };

  return { store, settledLog };
}

function createMemoryBindings(): ConversationBindings {
  const byThread = new Map<string, ConversationBinding>();
  return {
    async ensure() {},
    async get(threadId: string) {
      return byThread.get(threadId) ?? null;
    },
    async getOrCreate(input) {
      const revision = input.revision ?? 1;
      const existing = byThread.get(input.threadId);
      if (existing && existing.revision === revision) return existing;
      const created: ConversationBinding = {
        bindingId: randomUUID(),
        revision,
        ownerUserId: input.ownerUserId,
        threadId: input.threadId,
        botId: input.botId,
        runtimeId: input.runtimeId,
        sessionId: randomUUID(),
      };
      byThread.set(input.threadId, created);
      return created;
    },
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else files.push(full);
  }
  return files;
}

async function readSessionLogText(file: string): Promise<string> {
  if (file.endsWith(".zstd") || file.endsWith(".zst")) {
    const compressed = await readFile(file);
    return zstdDecompressSync(compressed).toString("utf8");
  }
  return readFile(file, "utf8");
}

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
}, 30_000);

describe("DSH 工具多模态图片收集与非视觉降级", () => {
  test("withToolImageCollector 在无图、超限、非法 MIME 与并发隔离场景下行为正确", async () => {
    // 脱离 collector 调用 emitToolImage 应保持静默无副作用。
    emitToolImage({ mediaType: "image/png", data: "ZmFrZQ==" });

    const noImage = await withToolImageCollector(
      { supportsImages: true },
      async () => "纯文本返回",
    );
    expect(noImage).toEqual({ content: "纯文本返回" });
    expect("images" in noImage).toBe(false);

    const collected = await withToolImageCollector(
      { supportsImages: true },
      async () => {
        emitToolImage({
          mediaType: "image/bmp" as ToolImagePart["mediaType"],
          data: "aW52YWxpZC1taW1l",
        });
        emitToolImage({ mediaType: "image/png", data: "" });
        emitToolImage({ mediaType: "image/png", data: "   " });
        emitToolImage({
          mediaType: "image/png",
          data: "A".repeat(4 * 1024 * 1024 + 1),
        });
        emitToolImage({ mediaType: "image/png", data: "img-1" });
        emitToolImage({ mediaType: "image/jpeg", data: "img-2" });
        emitToolImage({ mediaType: "image/webp", data: "img-3" });
        emitToolImage({ mediaType: "image/gif", data: "img-4" });
        emitToolImage({ mediaType: "image/png", data: "img-5-ignored" });
        return "完成采集";
      },
    );
    expect(collected.content).toBe("完成采集");
    expect(collected.images).toEqual([
      { mediaType: "image/png", data: "img-1" },
      { mediaType: "image/jpeg", data: "img-2" },
      { mediaType: "image/webp", data: "img-3" },
      { mediaType: "image/gif", data: "img-4" },
    ]);

    // 两个并发 collector 互相隔离，不会串收对方图片。
    const [first, second] = await Promise.all([
      withToolImageCollector({ supportsImages: true }, async () => {
        emitToolImage({ mediaType: "image/png", data: "task-a" });
        await Bun.sleep(15);
        return "a";
      }),
      withToolImageCollector({ supportsImages: true }, async () => {
        await Bun.sleep(5);
        emitToolImage({ mediaType: "image/jpeg", data: "task-b" });
        return "b";
      }),
    ]);
    expect(first.images).toEqual([{ mediaType: "image/png", data: "task-a" }]);
    expect(second.images).toEqual([
      { mediaType: "image/jpeg", data: "task-b" },
    ]);
  });

  test("withToolImageCollector 在 supportsImages 为 false 时绝不回吐图片并正确降级", async () => {
    const describedParts: ToolImagePart[] = [];
    const withVision = await withToolImageCollector(
      {
        supportsImages: false,
        describeImage: async (part) => {
          describedParts.push(part);
          if (part.mediaType === "image/png") return "按钮写着提交";
          if (part.mediaType === "image/jpeg") throw new Error("识图超时");
          return null;
        },
      },
      async () => {
        emitToolImage({ mediaType: "image/png", data: "png-data" });
        emitToolImage({ mediaType: "image/jpeg", data: "jpeg-data" });
        emitToolImage({ mediaType: "image/webp", data: "webp-data" });
        return "已截图";
      },
    );
    expect(describedParts).toHaveLength(3);
    expect("images" in withVision).toBe(false);
    expect(withVision.content).toContain("已截图");
    expect(withVision.content).toContain("[截图视觉摘要] 按钮写着提交");
    expect(withVision.content).toContain(
      "[截图已保存：识图模型未能生成描述，当前对话模型不支持原生视觉读图]",
    );

    const withoutVision = await withToolImageCollector(
      { supportsImages: false },
      async () => {
        emitToolImage({ mediaType: "image/jpeg", data: "jpeg-data" });
        return "已保存截图";
      },
    );
    expect("images" in withoutVision).toBe(false);
    expect(withoutVision.content).toBe(
      "已保存截图\n[截图已保存：当前对话模型不支持原生视觉读图，且未配置独立识图模型]",
    );
  });

  test("chat-shots saveScreenshot 经 sharp 压缩后在 collector 内发射 JPEG 图片，外部调用保持无害", async () => {
    const queries: string[] = [];
    const fakeDatabase = {
      $client: {
        unsafe: async (query: string) => {
          queries.push(query);
          return [];
        },
      },
    } as unknown as Database;

    const shots = await createChatShots(fakeDatabase);
    const pngBase64 = solidPng(20, 120, 220, 24).toString("base64");

    // 工具上下文外调用不应报错。
    const directResult = await shots.saveScreenshot(
      "user-1",
      "bot-1",
      "shot-outside",
      { base64: pngBase64, url: "https://example.com" },
    );
    expect(directResult).toEqual({
      ok: true,
      shown: true,
      url: "https://example.com",
    });

    // 工具上下文内调用应收集到压缩后的 JPEG 图片。
    const collected = await withToolImageCollector(
      { supportsImages: true },
      async () => {
        const res = await shots.saveScreenshot(
          "user-1",
          "bot-1",
          "shot-inside",
          { base64: pngBase64 },
        );
        return JSON.stringify(res);
      },
    );
    expect(JSON.parse(collected.content)).toEqual({
      ok: true,
      shown: true,
      url: null,
    });
    expect(collected.images).toHaveLength(1);
    const emitted = collected.images?.[0];
    expect(emitted?.mediaType).toBe("image/jpeg");
    expect(emitted?.data.length).toBeGreaterThan(0);
    const decoded = Buffer.from(emitted?.data ?? "", "base64");
    expect(decoded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(
      queries.some((sql) => sql.includes("INSERT INTO chisabot_chat_shots")),
    ).toBe(true);
  });

  test("createDshToolGateway 仅在 HTTP /execute 响应返回 images，持久化 settle 账本绝不落盘 base64", async () => {
    const { store, settledLog } = createMemoryOperationStore();
    const gateway = createDshToolGateway(store);
    const imageBase64 = solidPng(10, 200, 30, 16).toString("base64");
    const tool: GrantedTool = {
      name: "take_shot",
      description: "返回测试图片的工具",
      ref: "test/take_shot",
      parameters: z.object({ label: z.string() }),
      execute: async (args) => {
        const parsed = args as { label: string };
        emitToolImage({ mediaType: "image/png", data: imageBase64 });
        return `截图完成:${parsed.label}`;
      },
    };

    const callEndpoint = async (options: {
      supportsImages: boolean;
      describeImage?: (part: ToolImagePart) => Promise<string | null>;
    }) => {
      const bindingId = randomUUID();
      const sessionId = randomUUID();
      const runId = randomUUID();
      const callId = `call-${randomUUID()}`;
      const identity = {
        sessionId,
        runId,
        threadId: `thread-${randomUUID()}`,
        botId: "bot-1",
        actorId: "actor-1",
        revision: 1,
        generation: "gen-1",
      };
      const toolCallId = `${sessionId}:0:0:${callId}`;
      const messages: Message[] = [
        { id: "u1", role: "user", content: "看看页面" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: toolCallId,
              type: "function",
              function: {
                name: tool.name,
                arguments: JSON.stringify({ label: "demo" }),
              },
            },
          ],
        },
      ];
      const reg = gateway.register({
        bindingId,
        identity,
        input: {
          threadId: identity.threadId,
          runId,
          messages,
          tools: [],
          context: [],
          state: {},
        },
        tools: [tool],
        signal: new AbortController().signal,
        supportsImages: options.supportsImages,
        ...(options.describeImage
          ? { describeImage: options.describeImage }
          : {}),
        continuationMessages: async () => messages,
      });
      const response = await gateway.routes.request("/execute", {
        method: "POST",
        headers: {
          authorization: `Bearer ${reg.capability}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          binding: identity,
          callId,
          name: tool.name,
          args: { label: "demo" },
          turn: 0,
          step: 0,
          throughSeq: 0,
        }),
      });
      reg.close();
      return (await response.json()) as Record<string, unknown>;
    };

    const visionHttp = await callEndpoint({ supportsImages: true });
    expect(visionHttp.content).toBe("截图完成:demo");
    expect(visionHttp.images).toEqual([
      { mediaType: "image/png", data: imageBase64 },
    ]);

    const settledVision = settledLog[0];
    expect(settledVision?.status).toBe("completed");
    expect(settledVision?.result).toEqual({ content: "截图完成:demo" });
    expect("images" in (settledVision?.result ?? {})).toBe(false);
    expect(JSON.stringify(settledVision?.result)).not.toContain(imageBase64);

    const textOnlyHttp = await callEndpoint({
      supportsImages: false,
      describeImage: async () => "主界面红色块",
    });
    expect(textOnlyHttp.content).toBe(
      "截图完成:demo\n[截图视觉摘要] 主界面红色块",
    );
    expect("images" in textOnlyHttp).toBe(false);
    const settledText = settledLog[1];
    expect(settledText?.result).toEqual({
      content: "截图完成:demo\n[截图视觉摘要] 主界面红色块",
    });
    expect(JSON.stringify(settledText?.result)).not.toContain(imageBase64);
  });

  test("真实 Node DSH Host 与 dsh-attachment-local 端到端链路：接纳附件、同步 render、JSONL 零 base64 泄漏、非视觉模型自动降级与 plan 模式兼容", async () => {
    const pngBuffer = solidPng(220, 40, 40, 16);
    const jpegBuffer = await sharp(solidPng(30, 180, 90, 16))
      .jpeg({ quality: 85 })
      .toBuffer();
    const pngBase64 = pngBuffer.toString("base64");
    const jpegBase64 = jpegBuffer.toString("base64");

    const { store: operationStore, settledLog } = createMemoryOperationStore();
    const registeredCalls: Pick<
      DshToolRegistration,
      "supportsImages" | "describeImage"
    >[] = [];
    const innerGateway = createDshToolGateway(operationStore);
    const gateway: typeof innerGateway = {
      ...innerGateway,
      register(registration) {
        registeredCalls.push({
          supportsImages: registration.supportsImages,
          describeImage: registration.describeImage,
        });
        return innerGateway.register(registration);
      },
    };

    const upstreamRequests: WireBody[] = [];
    const bridge = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (
          url.pathname === "/execute" ||
          url.pathname === "/steer" ||
          url.pathname.startsWith("/model/")
        ) {
          return gateway.routes.fetch(request);
        }
        if (url.pathname === "/plan/cancel") {
          return Response.json({ ok: true });
        }
        if (url.pathname === "/plan") {
          const planBody = (await request.json().catch(() => ({}))) as {
            threadId?: string;
            runId?: string;
          };
          const threadId = planBody.threadId ?? "plan-thread";
          const runId = planBody.runId ?? "plan-run";
          const messageId = `plan-msg-${randomUUID()}`;
          const sse = [
            { type: "RUN_STARTED", threadId, runId },
            { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
            { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "plan 完成" },
            { type: "TEXT_MESSAGE_END", messageId },
            { type: "RUN_FINISHED", threadId, runId },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join("");
          return new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        const body = (await request.json()) as WireBody;
        upstreamRequests.push(body);
        const hasTool = body.messages.some(
          (message) => message.role === "tool",
        );
        const deltas = hasTool
          ? [
              {
                role: "assistant",
                content: "已完成观察。",
              },
            ]
          : [
              { role: "assistant", content: "准备调用截图工具。" },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-shot-1",
                    type: "function",
                    function: {
                      name: "capture_view",
                      arguments: '{"target":"canvas"}',
                    },
                  },
                ],
              },
            ];
        const frames = deltas.map(
          (delta) =>
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`,
        );
        frames.push(
          `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: hasTool ? "stop" : "tool_calls",
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
        return new Response(frames.join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    cleanups.push(() => bridge.stop(true));

    const runtimeDir = resolve("runtime/dsh");
    const runtimeTmpBase = join(tmpdir(), "chisabot-dsh-mm-");
    const home = await mkdtemp(runtimeTmpBase);
    const actorId = `mm-actor-${randomUUID()}`;
    const botId = `mm-bot-${randomUUID()}`;

    await writeFile(
      join(home, "chisabot.json"),
      JSON.stringify({
        ownerUserId: actorId,
        port: 0,
        providers: {},
        gatewayUrl: bridge.url.origin,
      }),
    );

    let hostLogs = "";
    const child = spawn("node", ["src/start.mjs"], {
      cwd: runtimeDir,
      windowsHide: true,
      env: { ...process.env, CHISABOT_DSH_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      hostLogs += chunk;
    });
    child.stderr.on("data", (chunk) => {
      hostLogs += chunk;
    });
    cleanups.push(async () => {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    });

    for (
      let i = 0;
      i < 200 && !hostLogs.includes("chisabot-runtime-ready");
      i += 1
    ) {
      if (child.exitCode !== null) throw new Error(hostLogs);
      await Bun.sleep(100);
    }
    expect(hostLogs).toContain("chisabot-runtime-ready");

    const { endpoint } = JSON.parse(
      await readFile(join(home, "connection.json"), "utf8"),
    ) as { endpoint: string };
    const { DshHostClient: ClientCtor } = (await import(
      "../../runtime/dsh/src/client.mjs"
    )) as { DshHostClient: typeof DshHostClient };
    const client = await ClientCtor.connect(endpoint);
    cleanups.push(() => client.close());

    const bindings = createMemoryBindings();
    const captureTool: GrantedTool = {
      name: "capture_view",
      description: "捕获测试视图",
      ref: "test/capture_view",
      parameters: z.object({ target: z.string() }),
      execute: async (args) => {
        const parsed = args as { target: string };
        emitToolImage({ mediaType: "image/png", data: pngBase64 });
        emitToolImage({ mediaType: "image/jpeg", data: jpegBase64 });
        return `已捕获视图:${parsed.target}`;
      },
    };

    const describeImage = async (part: ToolImagePart) =>
      `描述(${part.mediaType})`;

    const runScenario = async (options: {
      model: string;
      supportsImages: boolean;
      plan?: boolean;
    }) => {
      const threadId = `thread-${randomUUID()}`;
      const runId = `run-${randomUUID()}`;
      const agent = new DshRuntimeAgent({
        botId,
        binding: {
          bindings,
          gateway,
          toolGatewayUrl: bridge.url.origin,
          targetFor: async () => ({
            id: "test-host",
            ownerUserId: actorId,
            connectionFile: join(home, "connection.json"),
          }),
          readRun: (raw) => JSON.parse(String(raw)),
        },
        signRun: (value) =>
          JSON.stringify({
            actorId,
            botId,
            runId: value.runId,
            threadId: value.threadId,
          }),
        tools: [captureTool],
        prompt: () => "请调用 capture_view 工具查看画面并回答。",
        connection: {
          provider: "openai",
          baseUrl: `${bridge.url.origin}/upstream/v1`,
          apiKey: "test-api-key",
          model: options.model,
        },
        ...(options.plan
          ? {
              plan: {
                provider: "claude",
                endpoint: new URL(`${bridge.url.origin}/plan`),
                token: "plan-token",
              },
            }
          : {}),
        describeImage,
        modelInfo: async () => ({
          maxOutputTokens: 1024,
          contextWindow: 32_000,
          supportsImages: options.supportsImages,
        }),
        fallbacks: async () => [],
      });
      const input: RunAgentInput = {
        threadId,
        runId,
        messages: [
          {
            id: `user-${randomUUID()}`,
            role: "user",
            content: "请截图看看",
          },
        ],
        state: {},
        tools: [],
        context: [],
      };
      const events = await lastValueFrom(agent.run(input).pipe(toArray()));
      const binding = await bindings.get(threadId);
      return { events, binding };
    };

    // 场景 1：主模型支持视觉 -> 原生多模态返回，DSH 落盘 attachment 引用且 JSONL 零 base64。
    const visionStartRequests = upstreamRequests.length;
    const visionStartSettled = settledLog.length;
    const visionResult = await runScenario({
      model: "vision-model",
      supportsImages: true,
    });
    expect(
      visionResult.events.find(
        (event: BaseEvent) => event.type === "RUN_ERROR",
      ),
      JSON.stringify({ events: visionResult.events, hostLogs }),
    ).toBeUndefined();
    expect(registeredCalls[0]?.supportsImages).toBe(true);
    expect(registeredCalls[0]?.describeImage).toBe(describeImage);

    const visionRequests = upstreamRequests.slice(visionStartRequests);
    expect(visionRequests.length).toBe(2);
    const secondCallMessages = visionRequests[1]?.messages ?? [];
    const secondCallToolMsg = secondCallMessages.find(
      (message) => message.role === "tool",
    ) as { role: string; content: unknown } | undefined;
    expect(String(secondCallToolMsg?.content ?? "")).toContain(
      "已捕获视图:canvas",
    );
    const attachedImageUserMsg = secondCallMessages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: string }).type === "image_url",
        ),
    ) as
      | {
          role: string;
          content: Array<{
            type: string;
            text?: string;
            image_url?: { url: string };
          }>;
        }
      | undefined;
    expect(attachedImageUserMsg).toBeDefined();
    const attachedImageParts = (attachedImageUserMsg?.content ?? []).filter(
      (part) => part.type === "image_url",
    );
    expect(attachedImageParts.length).toBe(2);
    expect(
      attachedImageParts.every((part) =>
        part.image_url?.url.startsWith("data:image/"),
      ),
    ).toBe(true);

    const visionSessionId = visionResult.binding?.sessionId ?? "";
    const dshEvents = await client.events(visionSessionId);
    const toolResultEvent = dshEvents.records.find(
      (record) => record.event.type === "tool/result",
    )?.event as
      | {
          type: string;
          data: {
            message: {
              content: Array<{
                type: string;
                text?: string;
                attachment?: { attachmentId: string; mediaType: string };
              }>;
            };
          };
        }
      | undefined;
    expect(toolResultEvent).toBeDefined();
    const renderedBlocks = toolResultEvent?.data.message.content ?? [];
    expect(renderedBlocks[0]).toEqual({
      type: "text",
      text: "已捕获视图:canvas",
    });
    const attachmentBlocks = renderedBlocks.filter(
      (block) => block.type === "image",
    );
    expect(attachmentBlocks).toHaveLength(2);
    expect(attachmentBlocks[0]?.attachment?.attachmentId).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(attachmentBlocks[1]?.attachment?.attachmentId).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(dshEvents)).not.toContain(pngBase64);
    expect(JSON.stringify(dshEvents)).not.toContain(jpegBase64);

    // 验证磁盘 JSONL 会话日志中零裸 base64 泄漏。
    const allHomeFiles = await collectFiles(home);
    const jsonlFiles = allHomeFiles.filter(
      (file) => file.endsWith(".jsonl") || file.endsWith(".jsonl.zstd"),
    );
    expect(jsonlFiles.length, JSON.stringify(allHomeFiles)).toBeGreaterThan(0);
    for (const file of jsonlFiles) {
      const text = await readSessionLogText(file);
      expect(text).not.toContain(pngBase64);
      expect(text).not.toContain(jpegBase64);
    }

    // 验证操作账本落盘内容零 base64。
    const visionSettled = settledLog.slice(visionStartSettled);
    expect(visionSettled).toHaveLength(1);
    expect(visionSettled[0]?.result).toEqual({ content: "已捕获视图:canvas" });
    expect(JSON.stringify(visionSettled[0]?.result)).not.toContain(pngBase64);
    expect(JSON.stringify(visionSettled[0]?.result)).not.toContain(jpegBase64);

    // 场景 2：主模型不支持视觉 -> 自动调用 describeImage 降级，不发送任何 image_url 给模型。
    const textStartRequests = upstreamRequests.length;
    const textResult = await runScenario({
      model: "text-only-model",
      supportsImages: false,
    });
    expect(
      textResult.events.find((event: BaseEvent) => event.type === "RUN_ERROR"),
      JSON.stringify({ events: textResult.events, hostLogs }),
    ).toBeUndefined();
    expect(registeredCalls[1]?.supportsImages).toBe(false);
    expect(registeredCalls[1]?.describeImage).toBe(describeImage);

    const textRequests = upstreamRequests.slice(textStartRequests);
    expect(textRequests.length).toBe(2);
    const textToolMsg = textRequests[1]?.messages.find(
      (message) => message.role === "tool",
    ) as { role: string; content: unknown } | undefined;
    expect(JSON.stringify(textToolMsg?.content)).toContain(
      "[截图视觉摘要] 描述(image/png)",
    );
    expect(JSON.stringify(textToolMsg?.content)).toContain(
      "[截图视觉摘要] 描述(image/jpeg)",
    );
    expect(JSON.stringify(textToolMsg?.content)).not.toContain("image_url");

    // 场景 3：plan 模式下即使 modelInfo 为 false，注册给网关的 supportsImages 依然为 true。
    await runScenario({
      model: "plan-ignored",
      supportsImages: false,
      plan: true,
    });
    expect(registeredCalls[2]?.supportsImages).toBe(true);
    expect(registeredCalls[2]?.describeImage).toBe(describeImage);
  }, 60_000);

  test("plugin.mjs 在无 ctx.attachments.admitPromptContent 时剥离裸 base64 并保留同步降级提示", () => {
    const script = `
      import assert from "node:assert/strict";
      import { mkdtemp, rm } from "node:fs/promises";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { Session } from "@deepseek-ai/dsh-session";
      import { apply } from "./src/plugin.mjs";

      const home = await mkdtemp(join(tmpdir(), "plugin-no-attach-"));
      try {
        const routes = new Map();
        const sessionHandlers = [];
        let registeredTool;
        let setupFn;
        const fakeSession = new Session("sess-1");
        const fakeAgent = {
          session: fakeSession,
          status: "idle",
          model: { select: () => {} },
          inbox: { nextTurn: [], nextStep: [] },
          cancel: () => {},
        };
        const fakeAgentCtx = {
          systemPrompt: { section: () => () => {}, context: () => () => {} },
          tools: { register: (def) => { registeredTool = def; return () => {}; } },
          on: () => () => {},
        };
        const fakeCtx = {
          credentials: { unset: async () => {}, set: async () => {} },
          plugin: async () => ({ update: async () => {}, dispose: async () => {} }),
          llm: { registerAdapter: () => {} },
          on: (event, fn) => { if (event === "session/event") sessionHandlers.push(fn); },
          effect: (fn) => { fn(); },
          connection: {
            authenticatedUrl: (origin) => origin,
            fetch: {
              register: (def) => {
                routes.set(def.path, def.fetch);
                return () => {};
              },
            },
          },
          webServer: { getOrigin: () => "http://127.0.0.1:0" },
          sessions: { flush: async () => {}, get: () => fakeSession },
          sessionPersistence: { stat: async () => false },
          agents: {
            create: async (opts) => {
              setupFn = opts.setup;
              setupFn(fakeAgentCtx, fakeAgent);
              return { agent: fakeAgent, dispose: async () => {} };
            },
          },
        };

        const originalFetch = globalThis.fetch;
        globalThis.fetch = async (url) => {
          if (String(url).endsWith("/execute")) {
            return Response.json({
              content: "工具正文",
              images: [{ mediaType: "image/png", data: "RAW_BASE64_SHOULD_STRIP" }],
            });
          }
          throw new Error("unexpected fetch: " + url);
        };

        try {
          await apply(fakeCtx, {
            home,
            ownerUserId: "actor-1",
            gatewayUrl: "http://127.0.0.1:19999",
            gatewayTokenEnv: "TEST_TOKEN",
            providers: {},
          });
          const bindFetch = routes.get("/api/chisabot/bind");
          const bindResponse = await bindFetch(
            new Request("http://localhost/api/chisabot/bind", {
              method: "POST",
              body: JSON.stringify({
                sessionId: "sess-1",
                runId: "run-1",
                threadId: "thread-1",
                botId: "bot-1",
                actorId: "actor-1",
                revision: 1,
                prompt: "sys",
                toolCapability: "cap-1",
                model: { primary: { provider: "p", model: "m" } },
                tools: [
                  {
                    name: "demo_shot",
                    description: "shot",
                    parameters: { type: "object", properties: {} },
                  },
                ],
              }),
            }),
          );
          const bindBody = await bindResponse.text();
          assert.equal(bindResponse.status, 200, bindBody);
          for (const handler of sessionHandlers) {
            handler(fakeSession, {
              type: "tool/call",
              seq: 1,
              data: { callId: "c1", name: "demo_shot", turn: 0, step: 0 },
            });
          }
          const value = await registeredTool.execute({}, {
            callId: "c1",
            signal: new AbortController().signal,
          });
          assert.equal("images" in value, false);
          assert.equal(JSON.stringify(value).includes("RAW_BASE64_SHOULD_STRIP"), false);
          const blocks = registeredTool.output.render({}, value);
          assert.equal(blocks.length, 1);
          assert.equal(blocks[0].type, "text");
          assert.match(blocks[0].text, /工具正文/);
          assert.match(blocks[0].text, /未启用附件存储/);
        } finally {
          globalThis.fetch = originalFetch;
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    `;
    const run = spawnSync("node", ["--input-type=module", "-e", script], {
      cwd: resolve("runtime/dsh"),
      encoding: "utf8",
    });
    expect(run.status, run.stderr || run.stdout).toBe(0);
  });
});
