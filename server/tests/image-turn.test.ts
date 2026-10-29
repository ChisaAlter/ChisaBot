import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { LLMock } from "@copilotkit/aimock";
import { buildAgents, type RuntimeModel } from "../src/copilot";
import { createChatFiles } from "../src/chat-files/service";
import { turnAttachmentLoader } from "../src/chat-files/turn-attachments";
import { solidPng } from "../src/chat-files/vision-provider";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * 审查 M9-1（2026-10-29）：网页聊天「新话题 → 发一句文字 → 附一张图问图里内容」。
 * 线上管理员配了单独的识图模型，提示词每轮说「图片由识图模型转成文字描述给你」，可频道附件给的其实是原图、
 * 消息里没有描述——模型每轮先调 chat_files_recent 找图（带图轮首字 9.1–16.6 s），10 次里 1 次说「还没收到截图」。
 *
 * 这里用 aimock 当主模型、真的聊天文件服务（数据库）+ 线上同一个附件加载器（turnAttachmentLoader），
 * 断言模型这一轮收到了什么：主模型能看图 → 原图 + 「图片直接随这条消息给你」，没有「文字描述」的说法、
 * 一次模型请求就回答、没有 chat_files_recent；主模型看不了图 → 识图模型的描述，没有原图。
 */

const PNG = solidPng(200, 30, 30, 8);
const model: RuntimeModel = { provider: "openai", defaultModel: "gpt-5.5" };
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;

/**
 * 模型请求的原样请求体。aimock 自己的请求记录会把 Responses API 的 input 规范成纯文字，
 * 图片（input_image）在那里看不到，所以在它前面放一个只记录、原样转发的小代理。
 */
type Raw = {
  instructions?: string;
  input?: { role?: string; type?: string; content?: unknown }[];
  tools?: { name?: string; description?: string }[];
};

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "object" && part && "text" in part
              ? String((part as { text: unknown }).text)
              : "",
          )
          .join("")
      : "";
const imageParts = (content: unknown) =>
  (Array.isArray(content) ? content : []).filter(
    (part): part is { type: string; image_url?: string } =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: string }).type === "input_image",
  );

describe.skipIf(!url)(
  "新话题：先发一句文字，再附一张图问图里内容（M9-1）",
  () => {
    const database = url ? createDatabase(url, TEST_POOL) : (null as never);
    const owner = `imgturn-${randomUUID().slice(0, 8)}`;
    const bot = `agent_${randomUUID()}`;
    let mainSees: boolean | undefined;
    const visionCalls: string[] = [];
    const files = url
      ? createChatFiles(database, {
          encryptionKey: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("base64"),
          fetch: (async (u: string) => {
            visionCalls.push(String(u));
            return Response.json({
              choices: [
                { message: { content: "一张红色方块，右下角写着 编号 7" } },
              ],
            });
          }) as unknown as typeof fetch,
          ownsBot: async (o, b) => o === owner && b === bot,
          mainModelSupportsImages: async () => mainSees,
          isAdmin: async () => false,
          assertPublic: async () => {},
        })
      : (null as never);
    const llm = new LLMock();
    const originalBase = process.env.OPENAI_BASE_URL;
    const raw: Raw[] = [];
    let proxy: ReturnType<typeof Bun.serve> | null = null;
    const loadedFor: (string | undefined)[] = [];
    const loader = url
      ? turnAttachmentLoader(files, async (_actor, _thread, id) => {
          // 频道成员 / 会话校验在 channels 的测试里；这里只要这条附件的内容。
          if (id !== "att-shot") return null;
          return { mimeType: "image/png", name: "截图.png", bytes: PNG };
        })(owner)
      : (null as never);

    beforeAll(async () => {
      await files.ensure();
      // 这个人自己配了识图模型（和线上「有单独的识图模型」同一种 kind="model"），不动部署级默认。
      await files.media.savePersonalVision(owner, {
        mode: "custom",
        baseUrl: "https://vl.example.com/v1",
        model: "vl-test",
        apiKey: "sk-test-vision-0001",
      });
      const upstream = (await llm.start()).replace(/\/$/, "");
      proxy = Bun.serve({
        port: 0,
        async fetch(request) {
          const body = await request.text();
          if (request.method === "POST") raw.push(JSON.parse(body) as Raw);
          const target = new URL(request.url);
          const headers = new Headers(request.headers);
          headers.delete("host");
          headers.delete("content-length");
          return fetch(
            `${upstream}${target.pathname.replace(/^\/v1/, "/v1")}${target.search}`,
            {
              method: request.method,
              headers,
              body: request.method === "POST" ? body : undefined,
            },
          );
        },
      });
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${proxy.port}${new URL(upstream).pathname.replace(/\/$/, "")}`;
      llm.onMessage(/你好/, { content: "你好！有什么可以帮你？" });
      llm.onMessage(/图里写了什么/, {
        content: "图里是一个红色方块，右下角写着「编号 7」。",
      });
    });
    afterAll(async () => {
      if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = originalBase;
      proxy?.stop(true);
      await llm.stop();
      await database.$client.unsafe(
        "DELETE FROM chisabot_media_models WHERE owner_user_id = $1",
        [owner],
      );
      await database.$client.unsafe(
        "DELETE FROM chisabot_image_descriptions WHERE file_id = 'att:att-shot'",
      );
    });

    async function turn(messages: RunAgentInput["messages"]) {
      const agents = await buildAgents(
        [
          {
            id: bot,
            name: "助手",
            type: "built_in",
            systemPrompt: "你是通用助手。",
          },
        ],
        model,
        "synthetic-fixture-key",
        undefined,
        async (botId) => files.tools(owner, botId),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        async (id, threadId, agentId) => {
          loadedFor.push(agentId);
          return loader(id, threadId, agentId);
        },
        undefined,
        undefined,
        async (botId) => files.guidance(owner, botId),
      );
      const agent = agents[bot]?.clone();
      if (!agent) throw new Error("bot missing");
      // runAgent 而不是 run：线上运行时也是这样跑的，中间件（每轮的文件说明在 PersonalMemoryMiddleware 里）才会生效。
      const events: BaseEvent[] = [];
      agent.threadId = `thread-${randomUUID()}`;
      agent.setMessages(messages);
      await agent.runAgent(
        { runId: `run-${randomUUID()}` },
        { onEvent: ({ event }) => void events.push(event) },
      );
      return events;
    }

    const history: RunAgentInput["messages"] = [
      { id: "m1", role: "user", content: "你好" },
      { id: "m2", role: "assistant", content: "你好！有什么可以帮你？" },
    ];
    const imageTurn = [
      ...history,
      {
        id: "m3",
        role: "user" as const,
        content: [
          { type: "text", text: "图里写了什么？" },
          {
            type: "image",
            source: { type: "url", value: "/api/attachments/att-shot" },
            metadata: { attachmentId: "att-shot", filename: "截图.png" },
          },
        ],
      },
    ] as RunAgentInput["messages"];

    const lastUser = (entry: Raw) =>
      [...(entry.input ?? [])].reverse().find((m) => m.role === "user");
    const system = (entry: Raw) =>
      [
        entry.instructions ?? "",
        ...(entry.input ?? [])
          .filter((m) => m.role === "system" || m.role === "developer")
          .map((m) => text(m.content)),
      ].join("\n");
    const toolCalls = (events: BaseEvent[]) =>
      events
        .filter((e) => e.type === EventType.TOOL_CALL_START)
        .map((e) => (e as { toolCallName?: string }).toolCallName);

    test("主模型能看图：原图随消息给模型，提示词说直接看图，一次请求就回答，不调 chat_files_recent", async () => {
      mainSees = undefined;
      raw.length = 0;
      const first = await turn([{ id: "m1", role: "user", content: "你好" }]);
      expect(first.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      raw.length = 0;
      visionCalls.length = 0;
      const events = await turn(imageTurn);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      // 一次模型请求就回答：没有先调工具再回来的第二轮。
      expect(raw.length).toBe(1);
      const [request] = raw;
      const asked = lastUser(request!);
      expect(text(asked?.content)).toContain("图里写了什么");
      const images = imageParts(asked?.content);
      expect(images.length).toBe(1);
      expect(images[0]!.image_url).toBe(
        `data:image/png;base64,${PNG.toString("base64")}`,
      );
      const prompt = system(request!);
      expect(prompt).toContain("直接随这条消息给你");
      expect(prompt).toContain("不要先调 chat_files_recent");
      expect(prompt).not.toContain("转成文字描述");
      expect(JSON.stringify(request!.tools ?? [])).not.toContain(
        "只拿到了文字描述",
      );
      expect(toolCalls(events)).not.toContain("chat_files_recent");
      expect(toolCalls(events)).toEqual([]);
      expect(visionCalls).toEqual([]);
      expect(loadedFor.at(-1)).toBe(bot);
    });

    test("主模型看不了图：图片换成识图模型的描述，提示词也说是描述", async () => {
      mainSees = false;
      raw.length = 0;
      visionCalls.length = 0;
      const events = await turn(imageTurn);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const [request] = raw;
      const asked = lastUser(request!);
      expect(imageParts(asked?.content)).toEqual([]);
      expect(text(asked?.content)).toContain("编号 7");
      expect(text(asked?.content)).toContain("当前聊天模型不能看图片");
      expect(system(request!)).toContain("转成文字描述");
      expect(visionCalls).toEqual([
        "https://vl.example.com/v1/chat/completions",
      ]);
      mainSees = undefined;
    });
  },
);
