import { deflateSync } from "node:zlib";
import { ImageProviderError, openaiBase } from "./image-provider";

/**
 * 识图模型（DESIGN.md §59）：OpenAI 兼容的 POST {base}/chat/completions，消息里带一张
 * `image_url`（data: 网址）。GPT-4o、Qwen-VL、GLM-4V、MiniMax、new-api / One API 中转都是这个形状。
 */
export type VisionConfig = { baseUrl: string; model: string; apiKey: string };

const TIMEOUT_MS = 90_000;

function short(text: string, n = 240) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 给主模型的描述：先整体、再细节，图里的字原样抄出来。 */
export const DESCRIBE_PROMPT = [
  "请详细描述这张图片，给一个看不到图片的助手使用。用中文回答。",
  "1. 先用一两句话说这是什么图（照片 / 截图 / 文档 / 图表 / 插画…）和整体内容。",
  "2. 再写重要细节：人物、物体、位置关系、颜色、界面元素、数据。",
  "3. 图里所有能看清的文字逐字抄出来（OCR），保留原文语言和换行；表格尽量写成 Markdown 表格。",
  "只写看得到的内容，不要猜测，不要寒暄。",
].join("\n");

export async function askVisionModel(
  config: VisionConfig,
  image: { bytes: Buffer; mimeType: string },
  question: string,
  deps: { fetch: typeof fetch; signal?: AbortSignal; maxTokens?: number },
): Promise<string> {
  const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const response = await deps.fetch(`${openaiBase(config.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      max_tokens: deps.maxTokens ?? 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` } },
          ],
        },
      ],
    }),
    signal,
  });
  const raw = await response.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ImageProviderError(`识图接口返回的不是 JSON（HTTP ${response.status}）：${short(raw, 160)}`);
  }
  if (!response.ok) {
    const error = json.error as { message?: unknown } | string | undefined;
    const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : typeof json.message === "string" ? json.message : "";
    if (response.status === 401 || response.status === 403) throw new ImageProviderError("识图模型的密钥被拒绝（401/403）。");
    throw new ImageProviderError(`识图模型出错（HTTP ${response.status}）：${short(message || "未知错误")}`);
  }
  const choice = Array.isArray(json.choices) ? (json.choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
  const content = choice?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("")
        : "";
  // 有的看图模型（推理模型）先吐 <think>…</think>：去掉。
  const clean = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
  if (!clean) throw new ImageProviderError("识图模型没有返回文字（这个模型可能不支持图片输入）。");
  return clean;
}

/** 一张 32×32 的纯色 PNG（检查用，不依赖图片库）。 */
export function solidPng(r: number, g: number, b: number, size = 32): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** 检查：发一张小红图问颜色（会产生一次很小的调用费用）。 */
export async function probeVisionModel(config: VisionConfig, doFetch: typeof fetch): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  try {
    const answer = await askVisionModel(config, { bytes: solidPng(220, 30, 40), mimeType: "image/png" }, "这张图片是什么颜色？只回答颜色。", {
      fetch: doFetch,
      signal: AbortSignal.timeout(30_000),
      maxTokens: 50,
    });
    return { ok: true, message: `识图模型可用：问它一张红色小图的颜色，回答「${short(answer, 40)}」（${Date.now() - started} 毫秒）。` };
  } catch (error) {
    if (error instanceof ImageProviderError) return { ok: false, message: error.message };
    return { ok: false, message: `连不上识图接口：${error instanceof Error ? short(error.message, 120) : "未知错误"}` };
  }
}
