/**
 * 服务端 4 MiB 分块流式上传会话（`/api/chat-files/chunked/*`）。
 *
 * - 路由：
 *   - `POST   /api/chat-files/chunked/init`
 *   - `PUT    /api/chat-files/chunked/:uploadId/:index`
 *   - `POST   /api/chat-files/chunked/:uploadId/commit`
 *   - `DELETE /api/chat-files/chunked/:uploadId`
 * - 安全与回收保证：
 *   - 按 `ownerUserId` 严格隔离，跨用户访问返回 404；
 *   - 强制校验文件修改期指纹（`mtimeMs` + `size`），防上传半截文件被外部改写；
 *   - 临时文件集中放在任务专属唯一子目录，分块使用 `${partPath}.${pid}.${uuid}.tmp` 原子落盘；
 *   - commit / abort / 超时过期均在 `finally` 中核验边界后彻底删除临时子目录，零残留。
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ChatFileView } from "../../../shared/chat-files";
import {
  assertFileFingerprintUnchanged,
  buildAtomicTempPath,
  CHUNK_BYTES,
  CHUNKED_UPLOAD_TTL_MS,
  ChunkedTransferError,
  type ChunkPlan,
  computeChunkPlan,
  maxChunkedBytesForFile,
  normalizeTransferPath,
  sanitizeUploadFilename,
} from "../../../shared/chunked-transfer";
import type { AppVariables } from "../auth/guards";
import { detectMime, safeName } from "./service";

export class ChunkedUploadHttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 413 = 400,
  ) {
    super(message);
    this.name = "ChunkedUploadHttpError";
  }
}

export type ChunkedUploadServiceOptions = {
  ownsBot: (ownerUserId: string, agentId: string) => Promise<boolean>;
  commitFile: (
    ownerUserId: string,
    agentId: string,
    file: { name: string; bytes: Buffer; mimeType: string },
  ) => Promise<ChatFileView>;
  /** 临时根路径（默认位于系统临时目录下的专属隔离目录）。 */
  tempRoot?: string;
  ttlMs?: number;
  now?: () => number;
};

type UploadSession = {
  uploadId: string;
  ownerUserId: string;
  agentId: string;
  filename: string;
  mimeType: string | null;
  plan: ChunkPlan;
  expectedMtimeMs: number;
  expectedSize: number;
  expectedSha256: string | null;
  sessionDir: string;
  receivedChunks: Map<number, number>;
  createdAtMs: number;
  expiresAtMs: number;
  timer: ReturnType<typeof setTimeout>;
  committing: boolean;
  closed: boolean;
};

const initSchema = z
  .object({
    agentId: z.string().min(1).max(120),
    filename: z.string().min(1).max(255),
    mimeType: z.string().max(160).optional(),
    totalSize: z.number().int().positive(),
    mtimeMs: z.number().finite().nonnegative(),
    chunkSize: z.number().int().min(1).max(CHUNK_BYTES).optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "sha256 必须是 64 位十六进制字符串。")
      .optional(),
  })
  .strict();

const commitSchema = z
  .object({
    mtimeMs: z.number().finite().nonnegative().optional(),
    size: z.number().int().positive().optional(),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "sha256 必须是 64 位十六进制字符串。")
      .optional(),
  })
  .strict();

function unrefTimer(timer: ReturnType<typeof setTimeout>) {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

export function createChunkedUploadService(
  options: ChunkedUploadServiceOptions,
) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CHUNKED_UPLOAD_TTL_MS;
  const baseTempRoot = path.resolve(
    options.tempRoot ??
      path.join(os.tmpdir(), "chisabot-chunked-uploads", `pid-${process.pid}`),
  );
  const sessions = new Map<string, UploadSession>();

  /** 递归清理前先验证解析后的绝对边界，且不跟随目录联接/符号链接。 */
  async function safeRemoveSessionDir(sessionDir: string): Promise<void> {
    const resolvedRoot = await fsp
      .realpath(baseTempRoot)
      .catch(() => path.resolve(baseTempRoot));
    const resolvedDir = path.resolve(sessionDir);
    const normRoot = normalizeTransferPath(
      resolvedRoot,
      path.sep,
    ).toLowerCase();
    const normDir = normalizeTransferPath(resolvedDir, path.sep).toLowerCase();
    if (normDir === normRoot || !normDir.startsWith(`${normRoot}/`)) {
      return;
    }
    const stat = await fsp.lstat(resolvedDir).catch(() => null);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      await fsp.unlink(resolvedDir).catch(() => {});
      return;
    }
    await fsp.rm(resolvedDir, { recursive: true, force: true }).catch(() => {});
  }

  async function destroySession(session: UploadSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timer);
    sessions.delete(session.uploadId);
    await safeRemoveSessionDir(session.sessionDir);
  }

  async function requireOwnedSession(
    ownerUserId: string,
    uploadId: string,
  ): Promise<UploadSession> {
    const session = sessions.get(uploadId);
    if (!session || session.closed || session.ownerUserId !== ownerUserId) {
      throw new ChunkedUploadHttpError("找不到该分块上传会话。", 404);
    }
    if (session.expiresAtMs <= now()) {
      await destroySession(session);
      throw new ChunkedUploadHttpError("分块上传会话已超时过期。", 410);
    }
    return session;
  }

  async function initSession(
    ownerUserId: string,
    rawInput: z.infer<typeof initSchema>,
  ) {
    if (!(await options.ownsBot(ownerUserId, rawInput.agentId))) {
      throw new ChunkedUploadHttpError("找不到这个机器人。", 404);
    }
    let filename: string;
    let plan: ChunkPlan;
    try {
      filename = sanitizeUploadFilename(rawInput.filename);
      const maxBytes = maxChunkedBytesForFile(filename, rawInput.mimeType);
      plan = computeChunkPlan(rawInput.totalSize, {
        chunkSize: rawInput.chunkSize ?? CHUNK_BYTES,
        maxBytes,
      });
    } catch (error) {
      if (error instanceof ChunkedTransferError) {
        throw new ChunkedUploadHttpError(
          error.message,
          error.code === "TOO_LARGE" ? 413 : 400,
        );
      }
      throw error;
    }

    const uploadId = `up_${randomUUID().replace(/-/g, "")}`;
    const sessionDir = path.join(
      baseTempRoot,
      `${uploadId}-${randomUUID().slice(0, 8)}`,
    );
    await fsp.mkdir(sessionDir, { recursive: true, mode: 0o700 });

    const createdAtMs = now();
    const expiresAtMs = createdAtMs + ttlMs;
    const timer = setTimeout(() => {
      const current = sessions.get(uploadId);
      if (current && !current.committing) {
        void destroySession(current);
      }
    }, ttlMs);
    unrefTimer(timer);

    const session: UploadSession = {
      uploadId,
      ownerUserId,
      agentId: rawInput.agentId,
      filename,
      mimeType: rawInput.mimeType ?? null,
      plan,
      expectedMtimeMs: rawInput.mtimeMs,
      expectedSize: rawInput.totalSize,
      expectedSha256: rawInput.sha256 ? rawInput.sha256.toLowerCase() : null,
      sessionDir,
      receivedChunks: new Map(),
      createdAtMs,
      expiresAtMs,
      timer,
      committing: false,
      closed: false,
    };
    sessions.set(uploadId, session);

    return {
      uploadId,
      chunkSize: plan.chunkSize,
      totalChunks: plan.totalChunks,
      totalSize: plan.totalSize,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async function putChunk(input: {
    ownerUserId: string;
    uploadId: string;
    index: number;
    bytes: Buffer;
    currentMtimeMs?: number;
    currentSize?: number;
  }) {
    const session = await requireOwnedSession(
      input.ownerUserId,
      input.uploadId,
    );
    if (session.committing) {
      throw new ChunkedUploadHttpError(
        "会话正在合并提交中，不能再写入分块。",
        409,
      );
    }
    if (
      !Number.isInteger(input.index) ||
      input.index < 0 ||
      input.index >= session.plan.totalChunks
    ) {
      throw new ChunkedUploadHttpError(
        `分块索引越界（应为 0..${session.plan.totalChunks - 1}）。`,
        400,
      );
    }

    if (input.currentMtimeMs !== undefined || input.currentSize !== undefined) {
      try {
        assertFileFingerprintUnchanged(
          { size: session.expectedSize, mtimeMs: session.expectedMtimeMs },
          {
            size: input.currentSize ?? session.expectedSize,
            mtimeMs: input.currentMtimeMs ?? session.expectedMtimeMs,
          },
        );
      } catch (error) {
        await destroySession(session);
        throw new ChunkedUploadHttpError(
          error instanceof Error ? error.message : "上传期间文件发生变更。",
          409,
        );
      }
    }

    const descriptor = session.plan.chunks[input.index];
    if (!descriptor || input.bytes.length !== descriptor.length) {
      throw new ChunkedUploadHttpError(
        `分块 ${input.index} 字节数不匹配（收到 ${input.bytes.length}，期望 ${descriptor?.length ?? 0}）。`,
        400,
      );
    }

    const partPath = path.join(session.sessionDir, `chunk-${input.index}.part`);
    const tmpPath = buildAtomicTempPath(partPath, process.pid, randomUUID());
    let handle: fsp.FileHandle | null = null;
    let renamed = false;
    try {
      handle = await fsp.open(
        tmpPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(tmpPath, partPath);
      renamed = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (!renamed) await fsp.rm(tmpPath, { force: true }).catch(() => {});
    }

    session.receivedChunks.set(input.index, input.bytes.length);
    return {
      uploadId: session.uploadId,
      index: input.index,
      receivedBytes: input.bytes.length,
      receivedChunks: session.receivedChunks.size,
      totalChunks: session.plan.totalChunks,
    };
  }

  async function commitSession(
    ownerUserId: string,
    uploadId: string,
    rawBody: z.infer<typeof commitSchema> = {},
  ): Promise<ChatFileView> {
    const session = await requireOwnedSession(ownerUserId, uploadId);
    if (session.committing) {
      throw new ChunkedUploadHttpError(
        "会话正在合并提交中，请勿重复提交。",
        409,
      );
    }
    session.committing = true;

    try {
      if (rawBody.mtimeMs !== undefined || rawBody.size !== undefined) {
        try {
          assertFileFingerprintUnchanged(
            { size: session.expectedSize, mtimeMs: session.expectedMtimeMs },
            {
              size: rawBody.size ?? session.expectedSize,
              mtimeMs: rawBody.mtimeMs ?? session.expectedMtimeMs,
            },
          );
        } catch (error) {
          throw new ChunkedUploadHttpError(
            error instanceof Error ? error.message : "上传期间文件发生变更。",
            409,
          );
        }
      }

      if (session.receivedChunks.size !== session.plan.totalChunks) {
        const missing: number[] = [];
        for (let i = 0; i < session.plan.totalChunks; i += 1) {
          if (!session.receivedChunks.has(i)) missing.push(i);
        }
        throw new ChunkedUploadHttpError(
          `分块不完整，缺少分块：${missing.slice(0, 10).join(", ")}。`,
          400,
        );
      }

      const buffers: Buffer[] = [];
      const hash = createHash("sha256");
      let assembledSize = 0;
      for (let i = 0; i < session.plan.totalChunks; i += 1) {
        const partPath = path.join(session.sessionDir, `chunk-${i}.part`);
        const chunkBytes = await fsp.readFile(partPath);
        hash.update(chunkBytes);
        buffers.push(chunkBytes);
        assembledSize += chunkBytes.length;
      }

      if (assembledSize !== session.plan.totalSize) {
        throw new ChunkedUploadHttpError(
          `合并后文件大小不匹配（实际 ${assembledSize}，期望 ${session.plan.totalSize}）。`,
          400,
        );
      }

      const expectedSha =
        (rawBody.sha256 ?? session.expectedSha256)?.toLowerCase() ?? null;
      const actualSha = hash.digest("hex");
      if (expectedSha && actualSha !== expectedSha) {
        throw new ChunkedUploadHttpError(
          "文件 SHA-256 校验失败，已拒绝提交。",
          400,
        );
      }

      const fullBuffer = Buffer.concat(buffers, assembledSize);
      const cleanedName = safeName(session.filename);
      const detected = detectMime(fullBuffer, cleanedName);
      const mimeType =
        detected !== "application/octet-stream"
          ? detected
          : session.mimeType || detected;

      return await options.commitFile(session.ownerUserId, session.agentId, {
        name: cleanedName,
        bytes: fullBuffer,
        mimeType,
      });
    } finally {
      await destroySession(session);
    }
  }

  async function abortSession(
    ownerUserId: string,
    uploadId: string,
  ): Promise<void> {
    const session = await requireOwnedSession(ownerUserId, uploadId);
    await destroySession(session);
  }

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);

    app.onError((error, c) => {
      if (error instanceof ChunkedUploadHttpError) {
        return c.json({ error: error.message }, error.status);
      }
      if (error instanceof z.ZodError) {
        return c.json({ error: error.issues[0]?.message ?? "参数无效。" }, 400);
      }
      return c.json({ error: "分块上传服务暂时不可用。" }, 503);
    });

    app.post("/init", bodyLimit({ maxSize: 32_768 }), async (c) => {
      const body = initSchema.parse(await c.req.json());
      const session = await initSession(c.var.actor.id, body);
      return c.json(session, 201);
    });

    app.put(
      "/:uploadId/:index",
      bodyLimit({
        maxSize: CHUNK_BYTES + 64 * 1024,
        onError: (c) =>
          c.json(
            { error: `单块体积超过 ${CHUNK_BYTES} 字节（4 MiB）上限。` },
            413,
          ),
      }),
      async (c) => {
        const indexRaw = c.req.param("index");
        if (!/^\d+$/.test(indexRaw)) {
          throw new ChunkedUploadHttpError("分块索引必须是非负整数。", 400);
        }
        const mtimeHeader = c.req.header("x-file-mtime-ms");
        const sizeHeader = c.req.header("x-file-size");
        const currentMtimeMs =
          mtimeHeader !== undefined ? Number(mtimeHeader) : undefined;
        const currentSize =
          sizeHeader !== undefined ? Number(sizeHeader) : undefined;
        const bytes = Buffer.from(await c.req.arrayBuffer());
        const result = await putChunk({
          ownerUserId: c.var.actor.id,
          uploadId: c.req.param("uploadId"),
          index: Number(indexRaw),
          bytes,
          ...(currentMtimeMs !== undefined ? { currentMtimeMs } : {}),
          ...(currentSize !== undefined ? { currentSize } : {}),
        });
        return c.json(result);
      },
    );

    app.post("/:uploadId/commit", bodyLimit({ maxSize: 32_768 }), async (c) => {
      const rawJson = await c.req.json().catch(() => ({}));
      const body = commitSchema.parse(rawJson ?? {});
      const file = await commitSession(
        c.var.actor.id,
        c.req.param("uploadId"),
        body,
      );
      return c.json({ file }, 201);
    });

    app.delete("/:uploadId", async (c) => {
      await abortSession(c.var.actor.id, c.req.param("uploadId"));
      return c.body(null, 204);
    });

    return app;
  }

  async function dispose(): Promise<void> {
    const all = [...sessions.values()];
    for (const session of all) {
      await destroySession(session);
    }
    await fsp
      .rm(baseTempRoot, { recursive: true, force: true })
      .catch(() => {});
  }

  return {
    initSession,
    putChunk,
    commitSession,
    abortSession,
    routes,
    dispose,
    get activeCount() {
      return sessions.size;
    },
    get tempRoot() {
      return baseTempRoot;
    },
  };
}

export type ChunkedUploadService = ReturnType<
  typeof createChunkedUploadService
>;
