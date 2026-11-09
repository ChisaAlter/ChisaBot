import { afterAll, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { fallbackLanguageModel } from "../src/agents/model-fallback";
import { filePartsToText } from "../src/agents/request-sanitize";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const bodies: Record<string, unknown>[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    bodies.push((await request.json()) as Record<string, unknown>);
    return Response.json({
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: "deepseek-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "看到了一张图。" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});
afterAll(() => server.stop(true));

const imagePrompt = [
  {
    role: "user",
    content: [
      { type: "text", text: "图里是什么？" },
      { type: "file", mediaType: "image/png", data: PNG, filename: "a.png" },
    ],
  },
];

test("filePartsToText keeps image parts and still converts documents", () => {
  const options = {
    prompt: [
      {
        role: "user",
        content: [
          ...imagePrompt[0]!.content,
          {
            type: "file",
            mediaType: "application/pdf",
            data: "JVBERi0=",
            filename: "b.pdf",
          },
        ],
      },
    ],
  };
  const out = filePartsToText(options) as {
    prompt: { content: { type: string; mediaType?: string }[] }[];
  };
  const parts = out.prompt[0]!.content;
  expect(parts[1]).toBe(options.prompt[0]!.content[1]);
  expect(parts[2]!.type).toBe("text");
});

test("a DeepSeek request built through the fallback wrapper carries the image as image_url", async () => {
  const model = createOpenAI({
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "isolated-fixture",
  }).chat("deepseek-chat");
  const wrapped = fallbackLanguageModel(model, "deepseek/deepseek-chat", {
    candidates: async () => [],
    build: () => model,
    supportsFiles: () => false,
    firstOutputMs: 0,
    log: () => {},
  });
  const result = await wrapped.doGenerate({
    prompt: imagePrompt,
  } as unknown as Parameters<typeof model.doGenerate>[0]);
  expect(result.content).toEqual([{ type: "text", text: "看到了一张图。" }]);
  const body = bodies.at(-1) as {
    messages: { role: string; content: unknown }[];
  };
  const user = body.messages.find((message) => message.role === "user");
  const text = JSON.stringify(user?.content);
  expect(text).toContain('"type":"image_url"');
  expect(text).toContain(`data:image/png;base64,${PNG}`);
  expect(text).not.toContain("cannot receive files");
});
