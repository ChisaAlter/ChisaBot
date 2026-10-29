import {
  IconAlertTriangle,
  IconFile,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { Skeleton } from "@/components/ui/skeleton";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { Collapse } from "./collapse";
import {
  type UploadProgressStore,
  uploadKey,
  useUploadPercent,
} from "./upload-progress";

/**
 * WHAT IS ON THE COMPOSER, DRAWN AS ITS OWN ROW ACROSS THE TOP.
 *
 * `PromptArea` will draw this strip itself, given `images` and `files`, and it did until this
 * existed. Three things were wrong with that, and all three come from the same fact: the strip is
 * inside the editor's column, and on the compact composer that column is the MIDDLE of a row whose
 * first child is the attach button.
 *
 * So the strip started 42px in from the composer's left edge, hanging off nothing, instead of
 * lining up with the frame the way every reference composer draws it. Its thumbnails are a
 * hardcoded `h-16 w-16` with no prop to say otherwise. And its padding is a hardcoded `pb-2`,
 * which this file previously reached in and overrode by class name.
 *
 * Each of those could be forced from outside with a selector into somebody else's DOM, and for a
 * while one of them was. Three of them stacked is a component we have forked in CSS without saying
 * so, and it breaks silently on the next `prompt-area` release. Fifty lines of our own markup is
 * the cheaper of the two.
 *
 * Both composer branches use this, so there is one strip in the app rather than a compact one and
 * a full-size one that drift.
 */

/**
 * `url` is empty while the upload is in flight — the SDK has no bytes to point at yet — which is
 * why `loading` is not merely cosmetic here: an `<img src="">` re-requests the whole page in some
 * browsers, and React says so in the console.
 */
export type StagedImage = {
  id: string;
  url: string;
  alt?: string;
  size?: number;
  loading: boolean;
};

/**
 * An upload that did not make it. It keeps its tile — the file is still in hand — with the reason
 * and a retry, instead of vanishing from the strip and leaving the person to pick it again.
 */
export type FailedUpload = {
  id: string;
  name: string;
  reason: string;
};

export type StagedFile = {
  id: string;
  name: string;
  size?: number;
  loading: boolean;
  /**
   * The model reads at most MAX_EXTRACTED_CHARACTERS of a text file, while
   * the pick ceiling is MAX_FILE_BYTES. A file over the first may be read
   * truncated — warned on the tile, never refused.
   */
  mayTruncate?: boolean;
  /**
   * The text itself, for a long paste folded into this card (see `LONG_PASTE_CHARS`). Present only
   * for those: the card's name becomes a button that opens the whole text.
   */
  preview?: string;
};

export function AttachmentStrip({
  failed = [],
  files,
  images,
  onDismissFailed,
  onRemove,
  onRetry,
  progress,
}: {
  failed?: readonly FailedUpload[];
  files: readonly StagedFile[];
  images: readonly StagedImage[];
  onDismissFailed?: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
  progress?: UploadProgressStore;
}) {
  const occupied = images.length > 0 || files.length > 0 || failed.length > 0;

  return (
    /*
     * `items-start` rather than a stretch, so a wrapped second line of thumbnails sits under the
     * first rather than growing to match the tallest thing on its own line.
     *
     * The list stays mounted while empty, which is what gives `Collapse` something to measure: a
     * box with nothing in it cannot report the height it is meant to animate to.
     *
     * `aria-hidden` is the price of that, and it is not optional. Height 0 under `overflow-hidden`
     * is a VISUAL state and nothing more — it does not take an element out of the accessibility
     * tree the way `display: none` does. Left as it was, a composer carrying nothing still offered
     * a screen reader a labelled list to walk into and announce as "Attachments, list, 0 items".
     * Empty and unheard is the state we want; empty is only half of it.
     *
     * Hiding a subtree that contains something focusable is its own defect, and this cannot commit
     * it: `occupied` is false exactly when both lists are empty, so there is nothing inside to
     * reach when the attribute is on.
     */
    <Collapse open={occupied}>
      <ul
        aria-hidden={!occupied}
        aria-label={"附件"}
        className="flex flex-wrap items-start gap-2 pb-3"
      >
        {images.map((image) => (
          <Staged key={image.id}>
            {image.loading || image.url === "" ? (
              /*
               * The placeholder stands in for the picture, so it carries the picture's role and
               * the picture's name — otherwise the tile is a shape and nothing else, and the only
               * thing a screen reader finds in it is a button offering to remove something
               * unnamed. The file tile has said "Uploading…" in plain text since it was written.
               *
               * A name, not an announcement. `role="status"` would make each of these a live
               * region, and a paste of eight images would interrupt eight times to say so.
               */
              <div className="relative size-20">
                <Skeleton
                  aria-label={`${image.alt ?? "附件"}，正在上传`}
                  className="size-20 rounded-xl"
                  role="img"
                />
                <UploadPercent
                  className="absolute inset-x-1 bottom-1 truncate rounded bg-background/80 px-1 text-center text-[11px] text-muted-foreground tabular-nums"
                  progressKey={uploadKey(image.alt, image.size)}
                  store={progress}
                />
              </div>
            ) : (
              <img
                alt={image.alt ?? "附件"}
                className="size-20 rounded-xl border border-border object-cover"
                src={image.url}
              />
            )}
            <RemoveButton
              name={image.alt ?? "attachment"}
              onRemove={() => onRemove(image.id)}
            />
          </Staged>
        ))}
        {files.map((file) => (
          /*
           * The same height as a thumbnail, so a message carrying one of each reads as one row of
           * attachments rather than as two things that happened to land next to each other.
           */
          <Staged
            className="flex h-20 w-40 flex-col justify-between rounded-xl border border-border bg-muted/40 p-2"
            key={file.id}
          >
            {/*
             * `shrink-0` because the tile's height is fixed and the text below it is not. A third
             * line, which is exactly what the truncation warning adds, takes the extra out of the
             * only child that can give: this icon. It renders visibly smaller on precisely the
             * tiles that carry the warning, which is the wrong moment to look broken.
             */}
            <IconFile className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              {file.preview === undefined ? (
                <p className="truncate font-medium text-xs" title={file.name}>
                  {file.name}
                </p>
              ) : (
                <PastedTextPreview name={file.name} text={file.preview} />
              )}
              {file.loading ? (
                <UploadPercent
                  className="text-muted-foreground text-xs tabular-nums"
                  progressKey={uploadKey(file.name, file.size)}
                  store={progress}
                />
              ) : file.size === undefined ? null : (
                /*
                 * ON THE SIZE LINE, NOT UNDER IT, AND THAT IS A LAYOUT CONSTRAINT RATHER THAN A
                 * PREFERENCE. The tile's height is fixed so that a file and a thumbnail read as
                 * one row. A third line does not fit: measured in Chromium at this repository's
                 * 15px root, the two in-flow children need 63.75px inside a 58px box. Something
                 * has to give, and the only choices are the icon shrinking to 13px or the text
                 * spilling past the border. Folding the warning onto this line keeps two.
                 *
                 * `truncate` is the guarantee, not the wording: `formatBytes` is unbounded, so a
                 * large enough file would wrap this line and put the third one back. The short
                 * phrasing is what keeps it from ellipsizing at any realistic size; `title`
                 * carries the sentence that actually explains it.
                 */
                <p
                  className="truncate text-muted-foreground text-xs"
                  title={
                    file.mayTruncate === true
                      ? "该模型读取此文件的头 120,000 个字符。"
                      : undefined
                  }
                >
                  {formatBytes(file.size)}
                  {file.mayTruncate === true ? "· 可能被截断" : null}
                </p>
              )}
            </div>
            <RemoveButton name={file.name} onRemove={() => onRemove(file.id)} />
          </Staged>
        ))}
        {failed.map((upload) => (
          <Staged
            className="flex h-20 w-40 flex-col justify-between rounded-xl border border-destructive border-dashed bg-destructive/5 p-2"
            key={upload.id}
          >
            <div className="flex items-center gap-1 pr-5">
              <IconAlertTriangle className="size-4 shrink-0 text-destructive" />
              <p className="truncate font-medium text-xs" title={upload.name}>
                {upload.name}
              </p>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-1">
              <p
                className="min-w-0 truncate text-destructive text-xs"
                role="alert"
                title={upload.reason}
              >
                {upload.reason}
              </p>
              <button
                aria-label={`重试上传 ${upload.name}`}
                className="touch-target relative flex shrink-0 items-center gap-0.5 rounded px-1 text-xs text-foreground hover:bg-muted"
                onClick={() => onRetry?.(upload.id)}
                type="button"
              >
                <IconRefresh className="size-3" />
                {"重试"}
              </button>
            </div>
            <RemoveButton
              name={upload.name}
              onRemove={() => onDismissFailed?.(upload.id)}
            />
          </Staged>
        ))}
      </ul>
    </Collapse>
  );
}

/**
 * One tile, arriving.
 *
 * Entrance only. It leaves the instant it is removed, because that is what the person asked for and
 * because an element held on screen by an animation is an element a test cannot prove is gone — see
 * the note on the collapse above.
 *
 * `layout` is what keeps the removal from reading as a glitch anyway: the tiles to the right of the
 * one that went slide into its place over the same 200ms rather than jumping on a single frame. It
 * is also why `scale` is motion's own prop here, where the rest of this app writes full transform
 * strings for hardware acceleration — a layout animation composes its own transform, and a literal
 * `transform` in `animate` would be overwritten by it mid-flight.
 */
function Staged({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <motion.li
      animate={{ opacity: 1, scale: 1 }}
      className={className ? `relative ${className}` : "relative"}
      initial={{ opacity: 0, scale: shouldReduceMotion ? 1 : 0.85 }}
      layout
      transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
    >
      {children}
    </motion.li>
  );
}

/**
 * The label names the file, because a composer carrying four attachments otherwise offers a screen
 * reader four buttons all called "Remove".
 *
 * Inside the tile rather than hanging off its corner: the strip animates its own height inside an
 * `overflow-hidden` box, and anything outside the tile is clipped while that runs.
 */
function RemoveButton({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <button
      aria-label={`移除 ${name}`}
      // `touch-target` widens the hit area to 44×44 with a pseudo-element (styles.css) while the
      // drawn circle stays 20px: a finger could not reliably land on the visible dot.
      className="touch-target absolute top-1 right-1 grid size-5 place-items-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      onClick={onRemove}
      type="button"
    >
      <IconX className="size-3" />
    </button>
  );
}

/**
 * A long paste, folded into a card, opened back up. The name is the button; the dialog shows the
 * whole text exactly as it will be sent.
 */
function PastedTextPreview({ name, text }: { name: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={`预览 ${name}`}
        className="block w-full truncate text-left font-medium text-xs underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
        title={`${name}（点开预览）`}
        type="button"
      >
        {name}
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <pre
              className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm"
              data-testid="pasted-text-preview"
            >
              {text}
            </pre>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 「上传中 63%」 once the first progress event has arrived, 「上传中…」 before it. Subscribes to the
 * progress store on its own, so a tick re-renders this line and nothing else.
 */
function UploadPercent({
  className,
  progressKey,
  store,
}: {
  className: string;
  progressKey: string;
  store: UploadProgressStore | undefined;
}) {
  const percent = useUploadPercent(store, progressKey);
  return (
    <p className={className} data-testid="upload-percent">
      {percent === undefined ? "上传中…" : `上传中 ${percent}%`}
    </p>
  );
}

/**
 * Whole kilobytes below a megabyte and one decimal above it. A staged attachment is capped at 8MB
 * (`shared/attachments.ts`), so this never has to reach gigabytes, and "0.1MB" for a 100KB text
 * file tells the reader less than "98KB" does.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
