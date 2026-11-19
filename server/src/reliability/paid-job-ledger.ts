import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../db/client";
import {
  atomicWriteFileUnique,
  readSecretFileStrictBytes,
} from "../security/file-hygiene";
import {
  createPerPrincipalQuota,
  PrincipalQuotaExceededError,
} from "../security/http-hardening";

/**
 * 付费外部调用幂等任务账本（Wave 10 §1.3）：
 *
 * 核心不变量：「同一请求键重放绝不重复扣费」。
 * 1. `request_key` 主键 + `input_hash` SHA-256 校验：同键不同输入立即返回 409 Conflict 防误重放；
 * 2. 提交前先落账 `submitting`，拿到 `provider_job_id` 后立刻持久化；重试/重启若已有
 *    `provider_job_id` 则直接断点恢复轮询而不重复提交，若无 `provider_job_id` 且处于不确定态则
 *    显式 409 拒绝自动重提；
 * 3. Per-principal 并发 ≤ 4（不共享全局桶）、单任务总时长 ≤ 20 分钟；
 * 4. 输出强制 magic-sniff 校验真实文件头、按内容 SHA-256 哈希命名、以 `0600` 唯一 tmp 原子落盘。
 */

export const MAX_PAID_JOB_CONCURRENCY_PER_PRINCIPAL = 4;
export const MAX_PAID_JOB_DURATION_MS = 20 * 60_000;
export const PAID_JOBS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS chisabot_paid_jobs (
  request_key text PRIMARY KEY,
  job_id text NOT NULL UNIQUE,
  principal_id text NOT NULL,
  kind text NOT NULL,
  provider_id text NOT NULL,
  provider_url text NOT NULL,
  model_id text NOT NULL,
  input_hash text NOT NULL,
  provider_job_id text,
  status text NOT NULL DEFAULT 'submitting',
  outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chisabot_paid_jobs_principal_status
  ON chisabot_paid_jobs (principal_id, status, updated_at DESC);
`;

export type PaidJobStatus =
  | "submitting"
  | "processing"
  | "pending"
  | "uncertain"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type PaidJobErrorCode =
  | "INPUT_MISMATCH"
  | "PRINCIPAL_MISMATCH"
  | "PROVIDER_URL_CHANGED"
  | "SUBMISSION_UNCERTAIN"
  | "TERMINAL_STATE"
  | "CONCURRENCY_LIMIT"
  | "TIMEOUT"
  | "INVALID_OUTPUT_MAGIC"
  | "INVALID_PROVIDER_JOB_ID"
  | "EXECUTION_FAILED";

export class PaidJobError extends Error {
  constructor(
    readonly status: number,
    readonly code: PaidJobErrorCode,
    message: string,
    readonly jobId?: string,
  ) {
    super(message);
    this.name = "PaidJobError";
  }
}

export type SavedPaidOutput = {
  filename: string;
  sha256: string;
  mimeType: PaidOutputMime;
  bytes: number;
};

export type PaidJobRecord = {
  requestKey: string;
  jobId: string;
  principalId: string;
  kind: string;
  providerId: string;
  providerUrl: string;
  modelId: string;
  inputHash: string;
  providerJobId: string | null;
  status: PaidJobStatus;
  outputs: SavedPaidOutput[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaidOutputMime =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "video/mp4"
  | "video/webm"
  | "audio/wav"
  | "audio/mpeg"
  | "audio/ogg"
  | "application/pdf";

const MIME_EXTENSIONS: Record<PaidOutputMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
};

const TERMINAL_FAILED_STATES: ReadonlySet<PaidJobStatus> = new Set([
  "failed",
  "cancelled",
  "timeout",
]);

const PROVIDER_JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** 确定性计算输入载荷 SHA-256 摘要，用于 `request_key` 重放一致性检验。 */
export function computePaidInputHash(input: {
  kind: string;
  providerId: string;
  modelId: string;
  payload: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startsWithBytes(
  bytes: Uint8Array,
  prefix: readonly number[],
): boolean {
  if (bytes.byteLength < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[offset + i] !== expected.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * 魔数嗅探付费任务输出字节，拒绝未知二进制、HTML 或脚本伪装为媒体文件。
 */
export function sniffPaidOutputMime(bytes: Uint8Array): PaidOutputMime | null {
  if (bytes.byteLength < 4) return null;
  if (
    startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  if (bytes.byteLength >= 12 && asciiAt(bytes, 4, "ftyp")) {
    return "video/mp4";
  }
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return "video/webm";
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) {
    return "audio/wav";
  }
  if (
    asciiAt(bytes, 0, "ID3") ||
    startsWithBytes(bytes, [0xff, 0xfb]) ||
    startsWithBytes(bytes, [0xff, 0xf3]) ||
    startsWithBytes(bytes, [0xff, 0xf2])
  ) {
    return "audio/mpeg";
  }
  if (asciiAt(bytes, 0, "OggS")) {
    return "audio/ogg";
  }
  if (asciiAt(bytes, 0, "%PDF-")) {
    return "application/pdf";
  }
  return null;
}

export type PaidJobStorageAdapter = {
  ensure(): Promise<void>;
  findByRequestKey(requestKey: string): Promise<PaidJobRecord | null>;
  insert(record: PaidJobRecord): Promise<boolean>;
  update(
    requestKey: string,
    patch: Partial<
      Pick<
        PaidJobRecord,
        "providerJobId" | "status" | "outputs" | "error" | "updatedAt"
      >
    >,
  ): Promise<PaidJobRecord>;
  listByPrincipal(
    principalId: string,
    limit?: number,
  ): Promise<PaidJobRecord[]>;
};

type DbRow = {
  request_key: string;
  job_id: string;
  principal_id: string;
  kind: string;
  provider_id: string;
  provider_url: string;
  model_id: string;
  input_hash: string;
  provider_job_id: string | null;
  status: PaidJobStatus;
  outputs: unknown;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToRecord(row: DbRow): PaidJobRecord {
  const outputs = Array.isArray(row.outputs)
    ? (row.outputs as SavedPaidOutput[])
    : typeof row.outputs === "string"
      ? ((JSON.parse(row.outputs) as SavedPaidOutput[]) ?? [])
      : [];
  return {
    requestKey: row.request_key,
    jobId: row.job_id,
    principalId: row.principal_id,
    kind: row.kind,
    providerId: row.provider_id,
    providerUrl: row.provider_url,
    modelId: row.model_id,
    inputHash: row.input_hash,
    providerJobId: row.provider_job_id,
    status: row.status,
    outputs,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createPostgresPaidJobStorage(
  database: Database,
): PaidJobStorageAdapter {
  const sql = database.$client;
  return {
    async ensure() {
      await sql.unsafe(PAID_JOBS_TABLE_SQL);
    },
    async findByRequestKey(requestKey) {
      const rows = await sql.unsafe<DbRow[]>(
        "SELECT * FROM chisabot_paid_jobs WHERE request_key = $1 LIMIT 1",
        [requestKey],
      );
      const first = rows[0];
      return first ? rowToRecord(first) : null;
    },
    async insert(record) {
      const rows = await sql.unsafe<{ request_key: string }[]>(
        `INSERT INTO chisabot_paid_jobs (
          request_key, job_id, principal_id, kind, provider_id, provider_url,
          model_id, input_hash, provider_job_id, status, outputs, error, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
        ON CONFLICT (request_key) DO NOTHING
        RETURNING request_key`,
        [
          record.requestKey,
          record.jobId,
          record.principalId,
          record.kind,
          record.providerId,
          record.providerUrl,
          record.modelId,
          record.inputHash,
          record.providerJobId,
          record.status,
          JSON.stringify(record.outputs),
          record.error,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return rows.length > 0;
    },
    async update(requestKey, patch) {
      const rows = await sql.unsafe<DbRow[]>(
        `UPDATE chisabot_paid_jobs
            SET provider_job_id = COALESCE($2, provider_job_id),
                status = COALESCE($3, status),
                outputs = COALESCE($4::jsonb, outputs),
                error = $5,
                updated_at = $6
          WHERE request_key = $1
        RETURNING *`,
        [
          requestKey,
          patch.providerJobId ?? null,
          patch.status ?? null,
          patch.outputs ? JSON.stringify(patch.outputs) : null,
          patch.error !== undefined ? patch.error : null,
          patch.updatedAt ?? new Date().toISOString(),
        ],
      );
      const updated = rows[0];
      if (!updated) {
        throw new PaidJobError(
          404,
          "EXECUTION_FAILED",
          `找不到付费任务账本记录：${requestKey}`,
        );
      }
      return rowToRecord(updated);
    },
    async listByPrincipal(principalId, limit = 50) {
      const rows = await sql.unsafe<DbRow[]>(
        `SELECT * FROM chisabot_paid_jobs
          WHERE principal_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [principalId, Math.max(1, Math.min(200, Math.floor(limit)))],
      );
      return rows.map(rowToRecord);
    },
  };
}

export function createInMemoryPaidJobStorage(): PaidJobStorageAdapter {
  const records = new Map<string, PaidJobRecord>();
  return {
    async ensure() {},
    async findByRequestKey(requestKey) {
      const hit = records.get(requestKey);
      return hit
        ? { ...hit, outputs: hit.outputs.map((item) => ({ ...item })) }
        : null;
    },
    async insert(record) {
      if (records.has(record.requestKey)) return false;
      records.set(record.requestKey, {
        ...record,
        outputs: record.outputs.map((item) => ({ ...item })),
      });
      return true;
    },
    async update(requestKey, patch) {
      const current = records.get(requestKey);
      if (!current) {
        throw new PaidJobError(
          404,
          "EXECUTION_FAILED",
          `找不到付费任务账本记录：${requestKey}`,
        );
      }
      const next: PaidJobRecord = {
        ...current,
        ...(patch.providerJobId !== undefined
          ? { providerJobId: patch.providerJobId }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.outputs !== undefined
          ? { outputs: patch.outputs.map((item) => ({ ...item })) }
          : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        updatedAt: patch.updatedAt ?? new Date().toISOString(),
      };
      records.set(requestKey, next);
      return { ...next, outputs: next.outputs.map((item) => ({ ...item })) };
    },
    async listByPrincipal(principalId, limit = 50) {
      return [...records.values()]
        .filter((item) => item.principalId === principalId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map((item) => ({
          ...item,
          outputs: item.outputs.map((out) => ({ ...out })),
        }));
    },
  };
}

export type PaidJobRawOutput = {
  bytes: Uint8Array;
  declaredMimeType?: string;
};

export type PaidJobSubmissionOutcome =
  | { status: "completed"; providerJobId?: string; outputs: PaidJobRawOutput[] }
  | { status: "processing"; providerJobId: string };

export type PaidJobExecutionRequest = {
  requestKey: string;
  principalId: string;
  kind: string;
  providerId: string;
  providerUrl: string;
  modelId: string;
  payload: unknown;
  signal?: AbortSignal;
  submit: (signal: AbortSignal) => Promise<PaidJobSubmissionOutcome>;
  poll: (
    providerJobId: string,
    signal: AbortSignal,
  ) => Promise<PaidJobRawOutput[]>;
};

export type PaidJobCompletedResult = {
  jobId: string;
  requestKey: string;
  providerJobId: string | null;
  resumed: boolean;
  fromCache: boolean;
  outputs: Array<SavedPaidOutput & { filePath: string; bytesData: Buffer }>;
};

export function createPaidJobLedger(options: {
  outputDir: string;
  database?: Database;
  storage?: PaidJobStorageAdapter;
  maxConcurrentPerPrincipal?: number;
  maxDurationMs?: number;
  now?: () => number;
}) {
  const storage =
    options.storage ??
    (options.database
      ? createPostgresPaidJobStorage(options.database)
      : createInMemoryPaidJobStorage());
  const maxConcurrent =
    options.maxConcurrentPerPrincipal ?? MAX_PAID_JOB_CONCURRENCY_PER_PRINCIPAL;
  const maxDurationMs = options.maxDurationMs ?? MAX_PAID_JOB_DURATION_MS;
  const nowFn = options.now ?? Date.now;
  const principalQuota = createPerPrincipalQuota(maxConcurrent, {
    label: "付费外部任务",
  });
  const inFlight = new Map<
    string,
    {
      principalId: string;
      inputHash: string;
      promise: Promise<PaidJobCompletedResult>;
    }
  >();

  async function saveOutputs(
    outputs: readonly PaidJobRawOutput[],
  ): Promise<Array<SavedPaidOutput & { filePath: string; bytesData: Buffer }>> {
    if (outputs.length === 0) {
      throw new PaidJobError(
        502,
        "EXECUTION_FAILED",
        "付费外部任务未返回任何输出产物。",
      );
    }
    await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
    const saved: Array<
      SavedPaidOutput & { filePath: string; bytesData: Buffer }
    > = [];
    for (const item of outputs) {
      const sniffed = sniffPaidOutputMime(item.bytes);
      if (!sniffed) {
        throw new PaidJobError(
          502,
          "INVALID_OUTPUT_MAGIC",
          "输出字节未通过魔数白名单校验，已拒绝落盘。",
        );
      }
      if (
        item.declaredMimeType &&
        item.declaredMimeType.trim().toLowerCase() !== sniffed
      ) {
        throw new PaidJobError(
          502,
          "INVALID_OUTPUT_MAGIC",
          `输出声明类型（${item.declaredMimeType}）与真实魔数（${sniffed}）不一致，已拒绝落盘。`,
        );
      }
      const digest = sha256Bytes(item.bytes);
      const ext = MIME_EXTENSIONS[sniffed];
      const filename = `${digest}.${ext}`;
      const filePath = join(options.outputDir, filename);
      await atomicWriteFileUnique(filePath, item.bytes, { mode: 0o600 });
      saved.push({
        filename,
        sha256: digest,
        mimeType: sniffed,
        bytes: item.bytes.byteLength,
        filePath,
        bytesData: Buffer.from(item.bytes),
      });
    }
    return saved;
  }

  async function readCachedOutputs(
    job: PaidJobRecord,
  ): Promise<PaidJobCompletedResult> {
    const outputs: Array<
      SavedPaidOutput & { filePath: string; bytesData: Buffer }
    > = [];
    for (const item of job.outputs) {
      const filePath = join(options.outputDir, item.filename);
      let bytesData: Buffer;
      try {
        bytesData = await readSecretFileStrictBytes(filePath, {
          maxBytes: 256 * 1024 * 1024,
        });
      } catch {
        bytesData = await readFile(filePath);
      }
      outputs.push({ ...item, filePath, bytesData });
    }
    return {
      jobId: job.jobId,
      requestKey: job.requestKey,
      providerJobId: job.providerJobId,
      resumed: false,
      fromCache: true,
      outputs,
    };
  }

  function createDeadlineController(externalSignal?: AbortSignal): {
    signal: AbortSignal;
    wasTimedOut: () => boolean;
    cleanup: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason ?? new Error("cancelled"));
    };
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else if (externalSignal) {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    // 显式使用 setTimeout 驱动超时，并在 finally cleanup 中可靠 clearTimeout。
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("paid_job_timeout"));
    }, maxDurationMs);
    return {
      signal: controller.signal,
      wasTimedOut: () => timedOut,
      cleanup: () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      },
    };
  }

  async function runExecution(
    job: PaidJobRecord,
    req: PaidJobExecutionRequest,
    shouldSubmit: boolean,
  ): Promise<PaidJobCompletedResult> {
    let releaseQuota: (() => void) | undefined;
    try {
      releaseQuota = principalQuota.acquire(req.principalId);
    } catch (error) {
      if (error instanceof PrincipalQuotaExceededError) {
        throw new PaidJobError(
          429,
          "CONCURRENCY_LIMIT",
          `当前主体付费任务并发已达上限（≤${maxConcurrent}），请等待已有任务完成。`,
          job.jobId,
        );
      }
      throw error;
    }

    const deadline = createDeadlineController(req.signal);
    let currentProviderJobId = job.providerJobId;

    try {
      let rawOutputs: PaidJobRawOutput[];
      if (shouldSubmit) {
        const submitted = await req.submit(deadline.signal);
        if (submitted.providerJobId) {
          if (!PROVIDER_JOB_ID_RE.test(submitted.providerJobId)) {
            throw new PaidJobError(
              502,
              "INVALID_PROVIDER_JOB_ID",
              "上游返回了非法格式的任务 ID。",
              job.jobId,
            );
          }
          currentProviderJobId = submitted.providerJobId;
          await storage.update(job.requestKey, {
            providerJobId: currentProviderJobId,
            status: "processing",
            error: null,
            updatedAt: new Date(nowFn()).toISOString(),
          });
        }
        if (submitted.status === "completed") {
          rawOutputs = submitted.outputs;
        } else {
          rawOutputs = await req.poll(submitted.providerJobId, deadline.signal);
        }
      } else {
        if (!currentProviderJobId) {
          throw new PaidJobError(
            409,
            "SUBMISSION_UNCERTAIN",
            `任务 ${job.jobId} 缺少上游 providerJobId，无法确认是否已扣费，拒绝自动重提。`,
            job.jobId,
          );
        }
        rawOutputs = await req.poll(currentProviderJobId, deadline.signal);
      }

      const saved = await saveOutputs(rawOutputs);
      await storage.update(job.requestKey, {
        providerJobId: currentProviderJobId,
        status: "completed",
        outputs: saved.map(({ filename, sha256, mimeType, bytes }) => ({
          filename,
          sha256,
          mimeType,
          bytes,
        })),
        error: null,
        updatedAt: new Date(nowFn()).toISOString(),
      });

      return {
        jobId: job.jobId,
        requestKey: job.requestKey,
        providerJobId: currentProviderJobId,
        resumed: !shouldSubmit,
        fromCache: false,
        outputs: saved,
      };
    } catch (error) {
      const isTimeout = deadline.wasTimedOut();
      const isExternalCancel = !isTimeout && Boolean(req.signal?.aborted);
      const nextStatus: PaidJobStatus = isTimeout
        ? "timeout"
        : isExternalCancel
          ? currentProviderJobId
            ? "pending"
            : "cancelled"
          : error instanceof PaidJobError &&
              error.status >= 400 &&
              error.status < 500
            ? "failed"
            : currentProviderJobId
              ? "pending"
              : "uncertain";

      const errorMessage =
        error instanceof Error
          ? error.message.slice(0, 400)
          : String(error).slice(0, 400);

      await storage
        .update(job.requestKey, {
          providerJobId: currentProviderJobId,
          status: nextStatus,
          error: errorMessage,
          updatedAt: new Date(nowFn()).toISOString(),
        })
        .catch(() => {});

      if (isTimeout) {
        throw new PaidJobError(
          504,
          "TIMEOUT",
          `付费任务超过最大总时长（${Math.round(maxDurationMs / 60_000)} 分钟），已中止。`,
          job.jobId,
        );
      }
      if (error instanceof PaidJobError) throw error;
      throw new PaidJobError(
        502,
        "EXECUTION_FAILED",
        `付费任务执行失败（job ${job.jobId}）：${errorMessage}`,
        job.jobId,
      );
    } finally {
      deadline.cleanup();
      releaseQuota();
    }
  }

  async function execute(
    req: PaidJobExecutionRequest,
  ): Promise<PaidJobCompletedResult> {
    const requestKey = req.requestKey.trim();
    const principalId = req.principalId.trim();
    if (!requestKey || !principalId) {
      throw new PaidJobError(
        400,
        "EXECUTION_FAILED",
        "requestKey 与 principalId 不能为空。",
      );
    }
    const inputHash = computePaidInputHash({
      kind: req.kind,
      providerId: req.providerId,
      modelId: req.modelId,
      payload: req.payload,
    });

    const active = inFlight.get(requestKey);
    if (active) {
      if (active.principalId !== principalId) {
        throw new PaidJobError(
          403,
          "PRINCIPAL_MISMATCH",
          "请求键属于其他主体，禁止跨主体访问。",
        );
      }
      if (active.inputHash !== inputHash) {
        throw new PaidJobError(
          409,
          "INPUT_MISMATCH",
          "同一 request_key 的输入载荷已变更，拒绝重放（409 Conflict）。",
        );
      }
      return active.promise;
    }

    let existing = await storage.findByRequestKey(requestKey);
    let shouldSubmit = false;

    if (!existing) {
      const nowIso = new Date(nowFn()).toISOString();
      const created: PaidJobRecord = {
        requestKey,
        jobId: `pjob_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        principalId,
        kind: req.kind,
        providerId: req.providerId,
        providerUrl: req.providerUrl,
        modelId: req.modelId,
        inputHash,
        providerJobId: null,
        status: "submitting",
        outputs: [],
        error: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const inserted = await storage.insert(created);
      if (inserted) {
        existing = created;
        shouldSubmit = true;
      } else {
        existing = await storage.findByRequestKey(requestKey);
      }
    }

    if (!existing) {
      throw new PaidJobError(
        500,
        "EXECUTION_FAILED",
        "无法读取刚创建的付费任务账本记录。",
      );
    }

    if (existing.principalId !== principalId) {
      throw new PaidJobError(
        403,
        "PRINCIPAL_MISMATCH",
        "请求键属于其他主体，禁止跨主体访问。",
        existing.jobId,
      );
    }
    if (existing.inputHash !== inputHash) {
      throw new PaidJobError(
        409,
        "INPUT_MISMATCH",
        "同一 request_key 的输入内容哈希不匹配，拒绝误重放（409 Conflict）。",
        existing.jobId,
      );
    }

    if (!shouldSubmit) {
      if (existing.status === "completed") {
        return readCachedOutputs(existing);
      }
      if (TERMINAL_FAILED_STATES.has(existing.status)) {
        throw new PaidJobError(
          409,
          "TERMINAL_STATE",
          `付费任务 ${existing.jobId} 已终态（${existing.status}），请使用新 request_key 发起。`,
          existing.jobId,
        );
      }
      if (!existing.providerJobId) {
        throw new PaidJobError(
          409,
          "SUBMISSION_UNCERTAIN",
          `付费任务 ${existing.jobId} 提交结果不确定（缺少 provider_job_id），拒绝自动重复扣费。`,
          existing.jobId,
        );
      }
      if (existing.providerUrl !== req.providerUrl) {
        throw new PaidJobError(
          409,
          "PROVIDER_URL_CHANGED",
          "付费任务续接时提供方地址发生变化，已拒绝恢复。",
          existing.jobId,
        );
      }
    }

    const promise = runExecution(existing, req, shouldSubmit);
    inFlight.set(requestKey, { principalId, inputHash, promise });
    try {
      return await promise;
    } finally {
      inFlight.delete(requestKey);
    }
  }

  return {
    ensure: () => storage.ensure(),
    execute,
    get: (requestKey: string) => storage.findByRequestKey(requestKey),
    listByPrincipal: (principalId: string, limit?: number) =>
      storage.listByPrincipal(principalId, limit),
    activeCountForPrincipal: (principalId: string) =>
      principalQuota.count(principalId),
  };
}
