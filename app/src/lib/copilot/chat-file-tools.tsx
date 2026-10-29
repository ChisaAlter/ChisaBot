import { readImageDims } from "@/lib/image-dims";
import { useRenderTool } from "@copilotkit/react-core/v2";
import { IconPhoto } from "@tabler/icons-react";
import { memo } from "react";
import { z } from "zod";
import { type ChatFileView, filesFromToolResult } from "../../../../shared/chat-files";
import { FileCard, ImagePile } from "@/components/rich-previews/rich-previews";
import { type CardCheck, registerCardCheck } from "./tool-renderers";

/**
 * 机器人的图片 / 文件工具在聊天里的样子（DESIGN.md §56）。RENDER ONLY：工具在服务器上执行。
 *
 * - image_generate / image_edit：进行中 = 同尺寸骨架「正在画图…」；完成 = 单图卡 / 一摞（点开看大图、下载）。
 * - file_share：文件卡（类型图标、名字、类型 · 大小；图片出缩略图，PDF 能预览；下载）。
 * - 失败时不画东西：机器人会用话说明原因。画不画由下面导出的判断决定（和「这一轮算不算有回答」用同一个函数）。
 */
const imageParams = z.object({ prompt: z.string().optional(), aspect_ratio: z.string().optional(), source: z.string().optional() });
const shareParams = z.object({ path: z.string().optional(), title: z.string().optional() });

function aspectOf(value: unknown): string {
  return typeof value === "string" && /^\d+:\d+$/.test(value) ? value.replace(":", " / ") : "1 / 1";
}

/** 结果里的图片（报错、没给文件时为空）。 */
function toolImages(result?: string): ChatFileView[] {
  return filesFromToolResult(result).filter((f) => f.mimeType.startsWith("image/"));
}

/** image_generate / image_edit 完成后画不画卡片：结果里有图片才画，否则 ImageToolCard 返回 null。 */
export const imageToolDrawsCard: CardCheck = registerCardCheck(["image_generate", "image_edit"], ({ result }) => toolImages(result).length > 0);
/** file_share 完成后画不画卡片：结果里有文件才画，否则 FileToolCard 返回 null。 */
export const fileToolDrawsCard: CardCheck = registerCardCheck(["file_share"], ({ result }) => filesFromToolResult(result).length > 0);

const ImageToolCard = memo(function ImageToolCard({ running, result, aspect, editing }: { running: boolean; result?: string; aspect: string; editing: boolean }) {
  if (running) {
    return (
      <div className="cf-image-pending" data-testid="image-tool-pending" style={{ aspectRatio: aspect }}>
        <span className="cf-image-pending-label">
          <IconPhoto className="size-4" />
          {editing ? "正在改图…" : "正在画图…"}
        </span>
      </div>
    );
  }
  const images = toolImages(result);
  if (images.length === 0) return null;
  return (
    <div className="rp-stack cf-tool-result" data-align="start" data-testid="image-tool-result">
      <ImagePile images={images.map((f) => ({ src: f.url, name: f.name, alt: f.prompt ?? f.name, ...readImageDims(f.width, f.height) }))} />
    </div>
  );
});

const FileToolCard = memo(function FileToolCard({ running, result, name }: { running: boolean; result?: string; name: string }) {
  if (running) {
    return (
      <div className="rp-file cf-file-pending" data-testid="file-tool-pending">
        <span aria-hidden className="rp-file-icon sky-skel" />
        <span className="rp-file-text">
          <span className="rp-file-name">{name || "正在准备文件…"}</span>
          <span className="rp-file-meta">{"正在准备…"}</span>
        </span>
      </div>
    );
  }
  const files: ChatFileView[] = filesFromToolResult(result);
  if (files.length === 0) return null;
  return (
    <div className="rp-stack cf-tool-result" data-align="start" data-testid="file-tool-result">
      <div className="rp-files">
        {files.map((f) => (
          <FileCard key={f.id} mimeType={f.mimeType} name={f.name} probeSize={false} size={f.size} url={f.url} />
        ))}
      </div>
    </div>
  );
});

export function ChatFileTools() {
  useRenderTool({
    name: "image_generate",
    parameters: imageParams,
    render: ({ parameters, status, result }) => (
      <ImageToolCard aspect={aspectOf(parameters?.aspect_ratio)} editing={false} result={typeof result === "string" ? result : undefined} running={status !== "complete"} />
    ),
  });
  useRenderTool({
    name: "image_edit",
    parameters: imageParams,
    render: ({ parameters, status, result }) => (
      <ImageToolCard aspect={aspectOf(parameters?.aspect_ratio)} editing result={typeof result === "string" ? result : undefined} running={status !== "complete"} />
    ),
  });
  useRenderTool({
    name: "file_share",
    parameters: shareParams,
    render: ({ parameters, status, result }) => (
      <FileToolCard
        name={typeof parameters?.title === "string" && parameters.title ? parameters.title : typeof parameters?.path === "string" ? (parameters.path.split("/").pop() ?? "") : ""}
        result={typeof result === "string" ? result : undefined}
        running={status !== "complete"}
      />
    ),
  });
  return null;
}
