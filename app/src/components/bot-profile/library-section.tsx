import {
  IconBook,
  IconExternalLink,
  IconFileText,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import {
  type BotLibraryFileView,
  botLibraryKeys,
  botLibraryQueryOptions,
  deleteBotLibraryFile,
  MAX_BOT_LIBRARY_FILE_BYTES,
  MAX_BOT_LIBRARY_FILES,
  uploadBotLibraryFile,
} from "@/lib/bot-library";
import { agoText } from "@/lib/im";

/**
 * 机器人资料页「常驻参考资料库」分区：
 * - 上传 ≤20MB 文档（PDF / DOCX / Markdown / 纯文本等），后端自动建块索引供 `chat_file_search` 检索；
 * - 每回合仅向模型注入只读防注入清单，绝不重复全量上传大文件；
 * - 支持查看列表、预览下载与移除。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function BotLibrarySection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const library = useQuery(botLibraryQueryOptions(agentId));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const files = library.data?.files ?? [];
  const limit = library.data?.limit ?? MAX_BOT_LIBRARY_FILES;
  const atLimit = files.length >= limit;

  async function handleFileSelect(selected: File | undefined) {
    if (!selected || uploading) return;
    if (selected.size > MAX_BOT_LIBRARY_FILE_BYTES) {
      toast.error("单个参考资料文件不能超过 20 MB。");
      return;
    }
    setUploading(true);
    try {
      const saved = await uploadBotLibraryFile(agentId, selected);
      await queryClient.invalidateQueries({
        queryKey: botLibraryKeys.forBot(agentId),
      });
      toast.success(
        saved.chunkCount > 0
          ? `已加入常驻资料库「${saved.name}」（已建索引 ${saved.chunkCount} 块）`
          : `已加入常驻资料库「${saved.name}」`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove(file: BotLibraryFileView) {
    if (removingId) return;
    const ok = await confirmDialog({
      title: `从常驻资料库移除「${file.name}」？`,
      description: "移除后该机器人后续对话将不再看到这份参考资料。",
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    setRemovingId(file.fileId);
    try {
      await deleteBotLibraryFile(agentId, file.fileId);
      await queryClient.invalidateQueries({
        queryKey: botLibraryKeys.forBot(agentId),
      });
      toast.success(`已移除「${file.name}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "移除失败");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <PageSection
      action={
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {`${files.length} / ${limit}`}
          </span>
          <input
            accept=".pdf,.docx,.txt,.md,.markdown,.csv,.json,.log"
            className="hidden"
            data-testid="bot-library-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              void handleFileSelect(file);
            }}
            ref={inputRef}
            type="file"
          />
          <Button
            data-testid="bot-library-upload-btn"
            disabled={uploading || atLimit}
            onClick={() => inputRef.current?.click()}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconUpload className="size-3.5" />
            {uploading ? "上传中…" : "上传资料"}
          </Button>
        </div>
      }
      description="持久化挂载给这个机器人的参考资料（单文件 ≤20 MB）。每轮仅注入只读清单，机器人按需调用 chat_file_search 分块检索。"
      title="常驻参考资料库"
    >
      {library.isPending ? (
        <PageSkeleton rows={2} />
      ) : library.isError ? (
        <ErrorCard
          action={
            <Button
              onClick={() => void library.refetch()}
              size="sm"
              variant="outline"
            >
              {"重试"}
            </Button>
          }
          description={library.error.message}
          title="无法加载常驻参考资料库"
        />
      ) : files.length === 0 ? (
        <Card
          className="bp-card flex flex-col items-center gap-2 px-5 py-6 text-center text-muted-foreground text-sm"
          data-testid="bot-library-empty"
        >
          <IconBook className="size-5 opacity-60" />
          <span>
            {
              "还没有常驻参考资料。上传 PDF、DOCX、Markdown 或纯文本文档后，该机器人在每次对话里都能按需检索。"
            }
          </span>
        </Card>
      ) : (
        <Card className="bp-card divide-y" data-testid="bot-library-list">
          {files.map((file) => (
            <div
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              data-testid="bot-library-item"
              key={file.fileId}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <IconFileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={file.name}>
                    {file.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground text-xs">
                    <span>{formatSize(file.size)}</span>
                    <span>
                      {file.chunkCount > 0
                        ? `已建索引 ${file.chunkCount} 块`
                        : "仅元数据"}
                    </span>
                    <span>{agoText(file.createdAt)}</span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  aria-label={`打开「${file.name}」`}
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  href={file.url}
                  rel="noopener noreferrer"
                  target="_blank"
                  title="查看 / 下载原文件"
                >
                  <IconExternalLink className="size-4" />
                </a>
                <Button
                  aria-label={`移除「${file.name}」`}
                  disabled={removingId === file.fileId}
                  onClick={() => void handleRemove(file)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <IconTrash className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </PageSection>
  );
}
