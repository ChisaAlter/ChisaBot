import type {
  InputContentDataSource,
  InputContentUrlSource,
} from "@ag-ui/core";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { newId } from "@/lib/new-id";

export type Attachment = {
  id: string;
  type: "image" | "audio" | "video" | "document";
  source: InputContentDataSource | InputContentUrlSource;
  filename?: string;
  size?: number;
  status: "uploading" | "ready";
  thumbnail?: string;
  metadata?: Record<string, unknown>;
};
export type AttachmentUploadResult = (
  | InputContentDataSource
  | InputContentUrlSource
) & { metadata?: Record<string, unknown> };
export type AttachmentUploadError = {
  reason: "file-too-large" | "invalid-type" | "upload-failed";
  file: File;
  message: string;
};
export type AttachmentsConfig = {
  enabled: boolean;
  accept?: string;
  maxSize?: number;
  maxConcurrentUploads?: number;
  onUpload?: (
    file: File,
  ) => AttachmentUploadResult | Promise<AttachmentUploadResult>;
  onUploadFailed?: (error: AttachmentUploadError) => void;
};

/** Composer-owned upload state. The channel transport owns authorization and cancellation. */
export function useAttachments({ config }: { config?: AttachmentsConfig }) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settings = useRef(config);
  settings.current = config;
  const mounted = useRef(true);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const removeAttachment = useCallback(
    (id: string) =>
      setAttachments((items) => items.filter((item) => item.id !== id)),
    [],
  );
  const restoreAttachments = useCallback((restored: readonly Attachment[]) => {
    setAttachments((current) => {
      const ids = new Set(current.map((item) => item.id));
      return [...current, ...restored.filter((item) => !ids.has(item.id))];
    });
  }, []);
  const processFiles = useCallback(
    async (files: File[] | FileList) => {
      const selected = settings.current;
      const upload = selected?.enabled ? selected.onUpload : undefined;
      if (!selected || !upload) return;
      // Stage every placeholder synchronously, including files queued behind an earlier upload.
      const uploads = Array.from(files, (file) => ({ file, id: newId() }));
      setAttachments((items) => [
        ...items,
        ...uploads.map(
          ({ file, id }): Attachment => ({
            id,
            filename: file.name,
            size: file.size,
            status: "uploading",
            type: file.type.startsWith("image/")
              ? "image"
              : file.type.startsWith("audio/")
                ? "audio"
                : file.type.startsWith("video/")
                  ? "video"
                  : "document",
            source: { type: "url", value: "", mimeType: file.type },
          }),
        ),
      ]);
      const pending = queue.current.then(async () => {
        for (const { file, id } of uploads) {
          try {
            if (
              selected.maxSize !== undefined &&
              file.size > selected.maxSize
            ) {
              selected.onUploadFailed?.({
                reason: "file-too-large",
                file,
                message: "文件超过上传大小限制。",
              });
              removeAttachment(id);
              continue;
            }
            const { metadata, ...source } = await upload(file);
            if (mounted.current)
              setAttachments((items) =>
                items.map((item) =>
                  item.id === id
                    ? { ...item, source, metadata, status: "ready" }
                    : item,
                ),
              );
          } catch (error) {
            if (mounted.current) removeAttachment(id);
            selected.onUploadFailed?.({
              reason: "upload-failed",
              file,
              message:
                error instanceof Error ? error.message : "上传失败，请重试。",
            });
          }
        }
      });
      queue.current = pending.catch(() => {});
      await pending;
    },
    [removeAttachment],
  );
  return {
    attachments,
    dragOver,
    enabled: Boolean(config?.enabled),
    fileInputRef,
    processFiles,
    removeAttachment,
    restoreAttachments,
    handleDragOver: useCallback((event: DragEvent) => {
      event.preventDefault();
      setDragOver(true);
    }, []),
    handleDragLeave: useCallback((event: DragEvent) => {
      event.preventDefault();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setDragOver(false);
    }, []),
  };
}
