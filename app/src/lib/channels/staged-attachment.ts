import { attachmentUrl } from "@/lib/channels/attachments";
import { tryClient } from "@/lib/client";

/**
 * Give back the staged row a removed chip stood for.
 *
 * BEST-EFFORT, AND DELIBERATELY UNINSPECTED. The chip is gone from the strip before this is called,
 * because that is what the person asked for; making that wait on a round trip, or reporting what
 * comes back, would put an error in front of somebody for a request they never made. There are two
 * such answers — 404 for a non-uploader, 409 for an attachment already sent — and neither is
 * actionable. `cull-staged-attachments.ts` is the backstop for whatever this misses.
 */
export function releaseStagedAttachment(attachmentId: string): void {
  void tryClient(attachmentUrl(attachmentId), { method: "DELETE" }).catch(
    () => undefined,
  );
}
