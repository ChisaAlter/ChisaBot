import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../db/client";
import type { createPersonalNotifications } from "./personal-notifications";

const labels: Record<string, string> = {
  app: "核心服务",
  dsh: "DSH 执行服务",
  assistant: "助理任务或待核对结果",
  disk: "磁盘空间",
  certificate: "HTTPS 证书",
};
type HostObservation = {
  owner: string | null;
  incident: {
    id: string;
    startedAt: string;
    changedAt: string;
    revision: number;
    failures: string[];
    recoveredAt: string | null;
  } | null;
};

/** The root-owned monitor observation uses the same per-owner notification outbox as tasks. */
export function createHostNotifications(options: {
  updaterDir?: string;
  database: Database;
  deliver: ReturnType<typeof createPersonalNotifications>["deliver"];
}) {
  const file = options.updaterDir
    ? join(options.updaterDir, "state", "host-monitor.json")
    : null;
  return async function sweep() {
    if (!file) return;
    let observation: HostObservation;
    try {
      observation = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const { owner, incident } = observation;
    if (!owner || !incident) return;
    // Enabling notifications must not release an outage from before this connection existed.
    const [connection] = await options.database.$client.unsafe(
      `SELECT owner_user_id FROM chisabot_personal_sources
       WHERE owner_user_id=$1 AND notify_webhook_enc IS NOT NULL AND notify_connected_at<=$2::timestamptz`,
      [owner, incident.changedAt],
    );
    if (!connection) return;
    const failed = incident.failures
      .map((check) => labels[check])
      .filter(Boolean)
      .join("、");
    if (!failed) return;
    await options.deliver({
      id: `host:${incident.id}:failed:${incident.revision}`,
      owner,
      title: "ChisaBot 服务需要处理",
      message: `检测时间：${incident.changedAt}\n当次异常项：${failed}。请查看系统状态。`,
      path: "/admin/system-update",
    });
    if (incident.recoveredAt) {
      await options.deliver({
        id: `host:${incident.id}:recovered`,
        owner,
        title: "ChisaBot 服务已恢复",
        message: `恢复时间：${incident.recoveredAt}\n本次故障涉及的检查项已恢复正常。`,
        path: "/admin/system-update",
      });
    }
  };
}
