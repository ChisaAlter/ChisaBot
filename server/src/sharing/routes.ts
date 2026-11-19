import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { SHARE_LIMITS } from "../../../shared/sharing";
import type { AppVariables } from "../auth/guards";
import { SharePackageError } from "./package";
import type { SharingActor, SharingService } from "./service";
import { ZipFormatError } from "./zip";

/**
 * `/api/sharing/*` 路由（受 `requireUser` 与按端点分级的 `bodyLimit` 保护）：
 * - `POST /export/draft`：组装指定 Bot 脱敏审阅草稿
 * - `POST /export/zip`：按用户确认勾选清单校验脱敏并下载 `.zip`
 * - `POST /import/preview`：解析上传 ZIP，返回审阅清单、缺失依赖与安全体检
 * - `POST /import/commit`：按 `importId + selectedMemoryIndices` 执行幂等断点续导
 */

const DRAFT_BODY_LIMIT_BYTES = 64 * 1024;
const EXPORT_ZIP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
// 20 MiB ZIP 经 base64 或 multipart 封装后约为 ~27 MiB，留出封装余量，并在解包前强判解码后字节 <= 20 MiB
const IMPORT_BODY_LIMIT_BYTES = 28 * 1024 * 1024;

const exportDraftSchema = z
  .object({
    botId: z.string().trim().min(1, "请指定要导出的机器人 ID。").max(128),
  })
  .strict();

const exportZipSchema = z
  .object({
    botId: z.string().trim().min(1, "请指定要导出的机器人 ID。").max(128),
    selectedSkillSlugs: z.array(z.string().max(60)).max(200).optional(),
    selectedScheduleIndices: z
      .array(z.number().int().min(0).max(500))
      .max(200)
      .optional(),
    selectedMemoryIndices: z
      .array(z.number().int().min(0).max(1000))
      .max(500)
      .optional(),
    botOverrides: z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        title: z.string().trim().min(1).max(160).optional(),
        roleDescription: z.string().max(30_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const importJsonBaseSchema = z.object({
  zipBase64: z.string().min(1, "缺少 ZIP 数据。"),
});

const importCommitJsonSchema = z.object({
  zipBase64: z.string().min(1, "缺少 ZIP 数据。"),
  importId: z.string().trim().min(8).max(128),
  packageDigest: z.string().trim().length(64).optional(),
  selectedMemoryIndices: z
    .array(z.number().int().min(0).max(1000))
    .max(500)
    .optional(),
});

function decodeBase64Zip(raw: string): Buffer {
  const cleaned = raw.trim().replace(/^data:application\/zip;base64,/i, "");
  // 先按 base64 长度快速上限拦截（~4/3 膨胀）
  if (
    cleaned.length >
    Math.ceil((SHARE_LIMITS.maxZipArchiveBytes * 4) / 3) + 16
  ) {
    throw new SharePackageError("上传的 ZIP 压缩包超出 20 MiB 上限。", 413);
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) {
    throw new SharePackageError("ZIP base64 编码无效或为空。", 400);
  }
  if (bytes.length > SHARE_LIMITS.maxZipArchiveBytes) {
    throw new SharePackageError("上传的 ZIP 压缩包超出 20 MiB 上限。", 413);
  }
  return bytes;
}

function parseSelectedIndicesField(raw: unknown): number[] {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      const n = Number(item);
      if (!Number.isInteger(n) || n < 0) {
        throw new SharePackageError("记忆勾选索引必须为非负整数。", 400);
      }
      return n;
    });
  }
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SharePackageError("selectedMemoryIndices JSON 格式无效。", 400);
    }
    if (!Array.isArray(parsed)) {
      throw new SharePackageError("selectedMemoryIndices 必须是数组。", 400);
    }
    return parseSelectedIndicesField(parsed);
  }
  throw new SharePackageError("selectedMemoryIndices 格式无效。", 400);
}

async function extractZipFromRequest(req: Request): Promise<{
  zipBytes: Buffer;
  form?: FormData;
  jsonBody?: Record<string, unknown>;
}> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") ?? form.get("zip");
    if (!(file instanceof Blob)) {
      throw new SharePackageError("请通过表单字段 file 上传 .zip 文件。", 400);
    }
    if (file.size > SHARE_LIMITS.maxZipArchiveBytes) {
      throw new SharePackageError("上传的 ZIP 压缩包超出 20 MiB 上限。", 413);
    }
    const zipBytes = Buffer.from(await file.arrayBuffer());
    return { zipBytes, form };
  }

  if (
    contentType.includes("application/zip") ||
    contentType.includes("application/octet-stream")
  ) {
    const zipBytes = Buffer.from(await req.arrayBuffer());
    if (zipBytes.length > SHARE_LIMITS.maxZipArchiveBytes) {
      throw new SharePackageError("上传的 ZIP 压缩包超出 20 MiB 上限。", 413);
    }
    return { zipBytes };
  }

  const parsed = (await req.json()) as Record<string, unknown>;
  const { zipBase64 } = importJsonBaseSchema.parse(parsed);
  return { zipBytes: decodeBase64Zip(zipBase64), jsonBody: parsed };
}

function actorOf(c: { var: AppVariables }): SharingActor {
  return {
    id: c.var.actor.id,
    role: c.var.actor.role === "admin" ? "admin" : "user",
  };
}

export function createSharingRoutes(
  service: SharingService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", requireUser);
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json(
        { error: error.issues[0]?.message ?? "请求参数格式不正确。" },
        400,
      );
    }
    if (error instanceof ZipFormatError) {
      return c.json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof SharePackageError) {
      return c.json(
        {
          error: error.message,
          ...(error.findings.length > 0 ? { findings: error.findings } : {}),
        },
        error.status,
      );
    }
    console.error(
      JSON.stringify({
        type: "sharing-route-error",
        route: c.req.path,
        error: error.name,
      }),
    );
    return c.json({ error: "配方分享服务暂时不可用，请重试。" }, 503);
  });

  app.post(
    "/export/draft",
    bodyLimit({ maxSize: DRAFT_BODY_LIMIT_BYTES }),
    async (c) => {
      const body = exportDraftSchema.parse(await c.req.json());
      const draft = await service.buildExportDraft(actorOf(c), body.botId);
      return c.json({ draft });
    },
  );

  app.post(
    "/export/zip",
    bodyLimit({ maxSize: EXPORT_ZIP_BODY_LIMIT_BYTES }),
    async (c) => {
      const body = exportZipSchema.parse(await c.req.json());
      const packed = await service.exportZip(actorOf(c), body);
      return new Response(new Uint8Array(packed.bytes), {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(packed.bytes.length),
          "content-disposition": `attachment; filename="${packed.filename}"`,
          "cache-control": "no-store",
          "x-share-package-digest": packed.digest,
        },
      });
    },
  );

  app.post(
    "/import/preview",
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT_BYTES }),
    async (c) => {
      const { zipBytes } = await extractZipFromRequest(c.req.raw);
      const preview = await service.previewImport(actorOf(c), zipBytes);
      return c.json({ preview });
    },
  );

  app.post(
    "/import/commit",
    bodyLimit({ maxSize: IMPORT_BODY_LIMIT_BYTES }),
    async (c) => {
      const extracted = await extractZipFromRequest(c.req.raw);
      let importId: string;
      let packageDigest: string | undefined;
      let selectedMemoryIndices: number[] = [];

      if (extracted.form) {
        const rawImportId = extracted.form.get("importId");
        if (typeof rawImportId !== "string" || !rawImportId.trim()) {
          return c.json({ error: "缺少 importId 参数。" }, 400);
        }
        importId = rawImportId.trim();
        const rawDigest = extracted.form.get("packageDigest");
        if (typeof rawDigest === "string" && rawDigest.trim()) {
          packageDigest = rawDigest.trim();
        }
        selectedMemoryIndices = parseSelectedIndicesField(
          extracted.form.get("selectedMemoryIndices"),
        );
      } else if (extracted.jsonBody) {
        const parsed = importCommitJsonSchema.parse(extracted.jsonBody);
        importId = parsed.importId;
        packageDigest = parsed.packageDigest;
        selectedMemoryIndices = parsed.selectedMemoryIndices ?? [];
      } else {
        const headerImportId = c.req.header("x-import-id")?.trim() ?? "";
        if (!headerImportId) {
          return c.json({ error: "缺少 importId 参数。" }, 400);
        }
        importId = headerImportId;
        packageDigest = c.req.header("x-package-digest")?.trim() || undefined;
      }

      const result = await service.commitImport(actorOf(c), {
        zipBytes: extracted.zipBytes,
        importId,
        ...(packageDigest ? { packageDigest } : {}),
        selectedMemoryIndices,
      });
      return c.json({ result });
    },
  );

  return app;
}
