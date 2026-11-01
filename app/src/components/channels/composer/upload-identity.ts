import { uploadKey } from "./upload-progress";

/**
 * WHICH UPLOAD IS WHICH, BY THE ATTACHMENT'S OWN LOCAL ID RATHER THAN BY ITS FILE NAME + SIZE.
 *
 * Name + size is not an identity: two `截图.png` of the same byte count (or the same file picked
 * twice) uploading at once shared one key, so the second upload's AbortController overwrote the
 * first's — taking the first chip off cancelled the SECOND request, and that request's failure was
 * then swallowed as "cancelled on purpose".
 *
 * The SDK hands `onUpload` / `onUploadFailed` the very `File` object `processFiles` was given, so
 * each `File` gets a local id the moment `stageFiles` stages it, and every per-upload record
 * (abort controller, cancelled flag, progress, pasted-text preview) is keyed by that id.
 *
 * The SDK's placeholder card is the one thing that cannot say which `File` it stands for: it mints
 * its own id and carries only `filename` and `size`. So name + size survives as the FALLBACK used to
 * match a placeholder to its upload — and even then it is matched first-in, first-out: the SDK
 * appends placeholders in exactly the order the files were staged, so two identical name + size
 * pairs are told apart by position, not confused.
 */
export type UploadIdentity = {
  /** Mint a fresh local id for a file about to be handed to `processFiles`. */
  assign(file: File): string;
  /** The key a file's upload is recorded under (its local id; name + size if it never got one). */
  keyOfFile(file: File): string;
  /** Drop a file that will never get a placeholder (refused before the SDK drew one). */
  forget(file: File): void;
  /** Match newly drawn placeholders to staged files, and forget cards that are gone. */
  bind(attachments: readonly AttachmentLike[]): void;
  /** The key an attachment card's upload is recorded under. */
  keyOf(attachment: AttachmentLike): string;
};

type AttachmentLike = { id: string; filename?: string; size?: number };

export function createUploadIdentity(mint: () => string): UploadIdentity {
  const ids = new WeakMap<File, string>();
  /** Staged files whose placeholder has not been seen yet, in staging order. */
  const pending: { id: string; name: string; size: number }[] = [];
  /** SDK attachment id → local id. */
  const bound = new Map<string, string>();

  return {
    assign(file) {
      const id = mint();
      ids.set(file, id);
      pending.push({ id, name: file.name, size: file.size });
      return id;
    },
    keyOfFile(file) {
      return ids.get(file) ?? uploadKey(file.name, file.size);
    },
    forget(file) {
      const id = ids.get(file);
      if (id === undefined) return;
      const index = pending.findIndex((entry) => entry.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    bind(attachments) {
      const live = new Set<string>();
      for (const attachment of attachments) {
        live.add(attachment.id);
        if (bound.has(attachment.id)) continue;
        const index = pending.findIndex(
          (entry) =>
            entry.name === attachment.filename &&
            entry.size === attachment.size,
        );
        if (index < 0) continue;
        const [entry] = pending.splice(index, 1);
        if (entry) bound.set(attachment.id, entry.id);
      }
      for (const id of bound.keys()) {
        if (!live.has(id)) bound.delete(id);
      }
    },
    keyOf(attachment) {
      return (
        bound.get(attachment.id) ??
        uploadKey(attachment.filename, attachment.size)
      );
    },
  };
}
