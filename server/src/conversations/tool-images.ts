import { AsyncLocalStorage } from "node:async_hooks";

export type ToolImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export type ToolImagePart = {
  mediaType: ToolImageMediaType;
  data: string;
};

export type ToolImageCollectorOptions = {
  supportsImages: boolean;
  describeImage?: (part: ToolImagePart) => Promise<string | null>;
};

export type ToolImageCollectedResult = {
  content: string;
  images?: ToolImagePart[];
};

const MAX_TOOL_IMAGES = 4;
const MAX_TOOL_IMAGE_DATA_CHARS = 4 * 1024 * 1024;
const ALLOWED_TOOL_IMAGE_MEDIA_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const UNSUPPORTED_VISION_FALLBACK =
  "[截图已保存：当前对话模型不支持原生视觉读图，且未配置独立识图模型]";
const DESCRIBE_FAILED_FALLBACK =
  "[截图已保存：识图模型未能生成描述，当前对话模型不支持原生视觉读图]";

const collectorStorage = new AsyncLocalStorage<ToolImagePart[]>();

function appendNote(base: string, note: string): string {
  return base.length > 0 ? `${base}\n${note}` : note;
}

/**
 * 在当前工具调用的异步上下文内记录一张多模态图片；
 * 脱离 collector 调用时保持静默 no-op，确保非 DSH 链路或常规调用不受影响。
 */
export function emitToolImage(part: ToolImagePart): void {
  const collected = collectorStorage.getStore();
  if (!collected || collected.length >= MAX_TOOL_IMAGES) return;
  if (
    !part ||
    typeof part.mediaType !== "string" ||
    !ALLOWED_TOOL_IMAGE_MEDIA_TYPES.has(part.mediaType)
  )
    return;
  if (
    typeof part.data !== "string" ||
    part.data.trim().length === 0 ||
    part.data.length > MAX_TOOL_IMAGE_DATA_CHARS
  )
    return;
  collected.push({ mediaType: part.mediaType, data: part.data });
}

/**
 * 保持 `GrantedTool.execute` 返回纯字符串契约不变，
 * 在调用边界采集工具通过 `emitToolImage` 产出的图片，并在主模型不支持视觉时自动降级。
 */
export async function withToolImageCollector(
  options: ToolImageCollectorOptions,
  fn: () => Promise<string>,
): Promise<ToolImageCollectedResult> {
  const collected: ToolImagePart[] = [];
  const content = await collectorStorage.run(collected, fn);
  if (collected.length === 0) return { content };
  if (options.supportsImages) return { content, images: [...collected] };

  if (!options.describeImage) {
    return { content: appendNote(content, UNSUPPORTED_VISION_FALLBACK) };
  }

  const notes: string[] = [];
  for (const image of collected) {
    let summary: string | null = null;
    try {
      summary = await options.describeImage(image);
    } catch {
      summary = null;
    }
    const clean = typeof summary === "string" ? summary.trim() : "";
    notes.push(
      clean.length > 0 ? `[截图视觉摘要] ${clean}` : DESCRIBE_FAILED_FALLBACK,
    );
  }
  return { content: appendNote(content, notes.join("\n")) };
}
