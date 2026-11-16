import { accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDshMaintenanceRoot } from "../config";

export class ConversationMaintenanceError extends Error {
  readonly status = 503;
  constructor() {
    super("服务正在更新，请稍后重试。已接收的消息会保留。");
    this.name = "ConversationMaintenanceError";
  }
}

/** The updater closes admission before draining and backing up the persistent runtime volume. */
export function conversationAdmissionClosed(): boolean {
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
