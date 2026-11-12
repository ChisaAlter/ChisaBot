/**
 * 服务器本机智能体受控宿主（environmentId = "server"）。
 *
 * 直接在服务端进程内复用同构运行时 `pc/src/agent-runtime/index.js`：
 * - 工作目录严格受限于 `CHISABOT_SERVER_AGENT_ROOTS` 或管理员在设置中指定的 `workspaceRoots`；
 * - 共享同一套 worktree / 临时副本 / 沙盒隔离、Diff 统计、ACP 客户端、影子 Home 与嵌套互调本地桥。
 */

import { createRequire } from "node:module";
import os from "node:os";
import { SERVER_ENVIRONMENT_ID } from "../../../shared/agent-providers";
import { defaultCapabilities } from "../../../shared/devices";
import type { DeviceRecord } from "../devices/store";

const requireCjs = createRequire(import.meta.url);

type RuntimeInstance = {
  handle: (message: Record<string, unknown>) => boolean;
  onOnline: () => void;
  detect: () => Promise<void>;
  readonly detection: unknown;
  readonly running: number;
  stopAll: () => void;
};

const { createAgentRuntime } = requireCjs(
  "../../../pc/src/agent-runtime/index.js",
) as {
  createAgentRuntime: (options: {
    send: (message: { type: string } & Record<string, unknown>) => boolean;
    log?: (line: string) => void;
    isPaused?: () => boolean;
  }) => RuntimeInstance;
};

export function parseEnvServerRoots(
  rawInput = process.env.CHISABOT_SERVER_AGENT_ROOTS,
): string[] {
  const raw = rawInput?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // 非 JSON 数组，按分号或换行切分
  }
  return raw
    .split(/[;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildServerDeviceRecord(
  ownerUserId: string,
  allowedRoots: string[],
): DeviceRecord {
  return {
    id: SERVER_ENVIRONMENT_ID,
    ownerUserId,
    name: "服务器本机",
    platform: process.platform,
    osVersion: os.release(),
    hostname: os.hostname(),
    arch: process.arch,
    clientVersion: "server-host",
    capabilities: {
      ...defaultCapabilities(),
      shell: "allow",
      files_read: "allow",
      files_write: "allow",
    },
    allowedRoots,
    paused: false,
    revoked: false,
    lastSeenAt: new Date().toISOString(),
    lastIp: "127.0.0.1",
    createdAt: new Date(0).toISOString(),
    botIds: [],
    lastUsedBy: null,
    tokenHash: "server",
  };
}

export type ServerAgentHost = ReturnType<typeof createServerAgentHost>;

export function createServerAgentHost(options: {
  onMessage: (message: { type: string } & Record<string, unknown>) => void;
}) {
  let paused = false;
  const runtime = createAgentRuntime({
    send: (message) => {
      queueMicrotask(() => {
        options.onMessage(message);
      });
      return true;
    },
    log: (line) => {
      console.warn(
        JSON.stringify({
          type: "server-agent-host",
          message: line.slice(0, 300),
        }),
      );
    },
    isPaused: () => paused,
  });

  return {
    id: SERVER_ENVIRONMENT_ID,
    sendRaw(message: { type: string } & Record<string, unknown>): boolean {
      return runtime.handle(message);
    },
    async detect() {
      await runtime.detect();
    },
    setPaused(next: boolean) {
      paused = next;
      if (paused) runtime.stopAll();
    },
    stopAll() {
      runtime.stopAll();
    },
    get running() {
      return runtime.running;
    },
  };
}
