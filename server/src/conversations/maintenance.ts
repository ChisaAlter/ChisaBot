import { accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDshMaintenanceRoot } from "../config";
import { ConversationMaintenanceError, isQuiescing } from "../runtime/quiesce";

export { ConversationMaintenanceError };

/** The updater closes admission before draining and backing up the persistent runtime volume. */
export function conversationAdmissionClosed(): boolean {
  if (isQuiescing()) return true;
  const root = readDshMaintenanceRoot();
  if (!root) return false;
  try {
    accessSync(join(resolve(root), ".maintenance"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConversationMaintenanceError();
  }
}

export function assertConversationAdmissionOpen(): void {
  if (conversationAdmissionClosed()) throw new ConversationMaintenanceError();
}
