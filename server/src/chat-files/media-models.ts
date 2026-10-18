import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { IMAGE_PROVIDER_PRESETS, type ImageProviderKind, type ImageSettingsView } from "../../../shared/chat-files";
import type {
  MediaAdminView,
  MediaDefaultsSummary,
  MediaPersonalView,
  MediaProbeResult,
  PersonalImageView,
  PersonalVisionView,
  VisionSettingsView,
} from "../../../shared/media-models";
import type { AppVariables } from "../auth/guards";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import { assertPublicUrl } from "../web/tools";
import { type ImageProviderConfig, probeImageModel } from "./image-provider";
import { askVisionModel, DESCRIBE_PROMPT, probeVisionModel, type VisionConfig } from "./vision-provider";

/**
 * 生图模型 / 识图模型的设置与解析（DESIGN.md §59）。
 *
 * 表（开机建，回滚安全：旧版本不读它们，管理员的生图默认仍在 chisabot_image_settings 那一行）：
 * - chisabot_image_settings（§56 原表）：管理员的生图默认，一行，不迁移、不改结构。
 * - chisabot_media_models：主键 (owner_user_id, kind)。owner '' = 管理员默认（目前只有识图），
 *   其他 = 某个人的个人设置。kind = image | vision；mode = default | follow | custom。
 * - chisabot_image_descriptions：识图模型对一张聊天图片的描述缓存，主键 (file_id, model_key)，
 *   model_key = 接口地址 + 模型名的哈希（换模型重新描述，换密钥不用）。
 *
 * 解析顺序：个人 custom（齐全）→ 个人 follow → 管理员默认。密钥 AES-GCM，只在发请求时解开，
 * 视图里只有末四位。普通用户的接口地址必须是公网地址（防止借服务器打内网）；管理员不限。
 */

type MediaRow = {
  owner_user_id: string;
  kind: "image" | "vision";
  mode: string;
  provider: string;
  base_url: string;
  model: string;
  edit_model: string;
  api_key: string | null;
  key_hint: string;
  updated_at: Date | string | null;
};

type ImageSettingsRow = {
  enabled: boolean;
  provider: ImageProviderKind;
  base_url: string;
  model: string;
  edit_model: string;
  api_key: string | null;
  key_hint: string;
  updated_at: Date | string | null;
};

export class MediaModelsError extends Error {}

export type EffectiveImage = { config: ImageProviderConfig; source: "personal" | "default" };
export type EffectiveVision =
  | { kind: "model"; config: VisionConfig; source: "personal" | "default"; label: string }
  /** 图片直接给主模型看。 */
  | { kind: "main" }
  /** 主模型看不了图，也没有识图模型。 */
  | { kind: "none" };

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);
const hint = (key: string) => (key.length >= 8 ? key.slice(-4) : "");
const httpUrl = z.string().trim().max(300).url("接口地址要写成 https://… 这样的网址").refine((v) => /^https?:\/\//i.test(v), "接口地址要以 http:// 或 https:// 开头");

export function modelKeyOf(config: { baseUrl: string; model: string }) {
  return createHash("sha256").update(`${config.baseUrl.trim().replace(/\/+$/, "")}\n${config.model.trim()}`).digest("hex").slice(0, 24);
}

/** 描述缓存里只认这么新的图片（老对话里的图第一次遇到时不批量描述，避免一轮里几十次调用）。 */
const DESCRIBE_FRESH_MS = 6 * 60 * 60 * 1000;

export function createMediaModels(
  database: Database,
  options: {
    encryptionKey: string;
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    /** 这个机器人当前的聊天模型能不能看图：true / false / 不知道（undefined，当作能）。 */
    mainModelSupportsImages?: (agentId: string) => Promise<boolean | undefined>;
    /** 某人是不是管理员（决定能不能填内网地址）。 */
    isAdmin?: (userId: string) => Promise<boolean>;
    /** 测试里换掉公网检查。 */
    assertPublic?: (url: string) => Promise<unknown>;
  },
) {
  const sql = database.$client;
  // Personal / admin image endpoints are checked with assertPublicUrl, but a 302 after that used to
  // hand the Bearer token to whatever Location said. Default to redirect:"error"; injected test
  // fetches keep their own redirect policy when they pass one.
  const rawFetch = options.fetch ?? fetch;
  // Narrow wrapper keeps redirect:"error" by default; cast back so callers that expect
  // `typeof fetch` (incl. Bun's `preconnect`) still typecheck.
  const doFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    rawFetch(input, { ...init, redirect: init?.redirect ?? "error" })) as typeof fetch;
  const env = options.env ?? process.env;
  const assertPublic = options.assertPublic ?? assertPublicUrl;

  async function ensure() {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_media_models (
        owner_user_id text NOT NULL,
        kind text NOT NULL,
        mode text NOT NULL,
        provider text NOT NULL DEFAULT 'openai',
        base_url text NOT NULL DEFAULT '',
        model text NOT NULL DEFAULT '',
        edit_model text NOT NULL DEFAULT '',
        api_key text,
        key_hint text NOT NULL DEFAULT '',
        updated_at timestamptz,
        updated_by text,
        PRIMARY KEY (owner_user_id, kind)
      );
      CREATE TABLE IF NOT EXISTS chisabot_image_descriptions (
        file_id text NOT NULL,
        model_key text NOT NULL,
        model text NOT NULL,
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (file_id, model_key)
      );
    `);
  }

  // ------------------------------------------------------------------ 管理员的生图默认（§56 原表）

  async function imageRow(): Promise<ImageSettingsRow | null> {
    const rows = await sql.unsafe<ImageSettingsRow[]>("SELECT * FROM chisabot_image_settings WHERE id = 'default'");
    return rows[0] ?? null;
  }

  function envKey(provider: ImageProviderKind): string {
    if (provider === "minimax") {
      if (env.MINIMAX_API_KEY?.trim()) return env.MINIMAX_API_KEY.trim();
      if (/minimax/i.test(env.OPENAI_BASE_URL ?? "") && env.OPENAI_API_KEY?.trim()) return env.OPENAI_API_KEY.trim();
      return "";
    }
    return env.IMAGE_API_KEY?.trim() ?? "";
  }

  async function imageDefaultView(): Promise<ImageSettingsView> {
    const row = await imageRow();
    const provider = (row?.provider ?? "minimax") as ImageProviderKind;
    const preset = IMAGE_PROVIDER_PRESETS[provider] ?? IMAGE_PROVIDER_PRESETS.minimax;
    const fromEnv = envKey(provider);
    const keySource = row?.api_key ? "saved" : fromEnv ? "environment" : "none";
    const baseUrl = row?.base_url || preset.baseUrl;
    const model = row?.model || preset.model;
    return {
      enabled: Boolean(row?.enabled),
      provider,
      baseUrl,
      model,
      editModel: row?.edit_model ?? "",
      keySource,
      keyHint: row?.api_key ? row.key_hint : hint(fromEnv),
      ready: Boolean(row?.enabled) && keySource !== "none" && Boolean(baseUrl) && Boolean(model),
      updatedAt: iso(row?.updated_at),
    };
  }

  /** 管理员默认的生图配置（解开密钥）；override 用于「检查」时用表单里还没保存的值。 */
  async function imageDefaultConfig(override?: Partial<ImageProviderConfig>): Promise<ImageProviderConfig | null> {
    const row = await imageRow();
    const view = await imageDefaultView();
    const provider = override?.provider ?? view.provider;
    const apiKey =
      override?.apiKey ||
      (row?.api_key && (!override?.provider || override.provider === view.provider) ? await decryptSecret(options.encryptionKey, row.api_key) : "") ||
      envKey(provider);
    if (!apiKey) return null;
    return {
      provider,
      baseUrl: override?.baseUrl || view.baseUrl || IMAGE_PROVIDER_PRESETS[provider].baseUrl,
      model: override?.model || view.model || IMAGE_PROVIDER_PRESETS[provider].model,
      editModel: override?.editModel ?? view.editModel,
      apiKey,
    };
  }

  const imageDefaultInput = z
    .object({
      enabled: z.boolean(),
      provider: z.enum(["minimax", "openai"]),
      baseUrl: httpUrl,
      model: z.string().trim().min(1, "要填模型名").max(120),
      editModel: z.string().trim().max(120).optional().default(""),
      /** 不传 = 保留已存的；空字符串 = 清掉已存的（改用环境变量）。 */
      apiKey: z.string().max(4000).optional(),
    })
    .strict();

  async function saveImageDefault(actorId: string, raw: unknown): Promise<ImageSettingsView> {
    const input = imageDefaultInput.parse(raw);
    const row = await imageRow();
    let sealed = row?.api_key ?? null;
    let keyHint = row?.key_hint ?? "";
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      sealed = key ? await encryptSecret(options.encryptionKey, key) : null;
      keyHint = hint(key);
    }
    await sql.unsafe(
      `INSERT INTO chisabot_image_settings (id, enabled, provider, base_url, model, edit_model, api_key, key_hint, updated_at, updated_by)
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (id) DO UPDATE SET enabled = $1, provider = $2, base_url = $3, model = $4, edit_model = $5, api_key = $6, key_hint = $7, updated_at = now(), updated_by = $8`,
      [input.enabled, input.provider, input.baseUrl, input.model, input.editModel ?? "", sealed, keyHint, actorId],
    );
    return imageDefaultView();
  }

  // ------------------------------------------------------------------ chisabot_media_models

  async function mediaRow(owner: string, kind: "image" | "vision"): Promise<MediaRow | null> {
    const rows = await sql.unsafe<MediaRow[]>("SELECT * FROM chisabot_media_models WHERE owner_user_id = $1 AND kind = $2", [owner, kind]);
    return rows[0] ?? null;
  }

  async function upsertMedia(
    owner: string,
    kind: "image" | "vision",
    actorId: string,
    input: { mode: string; provider?: string; baseUrl?: string; model?: string; editModel?: string; apiKey?: string },
  ) {
    const row = await mediaRow(owner, kind);
    let sealed = row?.api_key ?? null;
    let keyHint = row?.key_hint ?? "";
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      sealed = key ? await encryptSecret(options.encryptionKey, key) : null;
      keyHint = hint(key);
    }
    await sql.unsafe(
      `INSERT INTO chisabot_media_models (owner_user_id, kind, mode, provider, base_url, model, edit_model, api_key, key_hint, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)
       ON CONFLICT (owner_user_id, kind) DO UPDATE SET mode = $3, provider = $4, base_url = $5, model = $6, edit_model = $7, api_key = $8, key_hint = $9, updated_at = now(), updated_by = $10`,
      [
        owner,
        kind,
        input.mode,
        input.provider ?? row?.provider ?? "openai",
        input.baseUrl ?? row?.base_url ?? "",
        input.model ?? row?.model ?? "",
        input.editModel ?? row?.edit_model ?? "",
        sealed,
        keyHint,
        actorId,
      ],
    );
    return { sealed };
  }

  const complete = (row: MediaRow | null) => Boolean(row?.api_key && row.base_url && row.model);

  function visionView(row: MediaRow | null): VisionSettingsView {
    const mode = row?.mode === "custom" ? "custom" : "follow";
    return {
      mode,
      baseUrl: row?.base_url ?? "",
      model: row?.model ?? "",
      keySource: row?.api_key ? "saved" : "none",
      keyHint: row?.api_key ? row.key_hint : "",
      ready: mode === "custom" && complete(row),
      updatedAt: iso(row?.updated_at),
    };
  }

  function personalImageView(row: MediaRow | null): PersonalImageView {
    const provider = (row?.provider === "minimax" ? "minimax" : "openai") as ImageProviderKind;
    const mode = row?.mode === "custom" ? "custom" : "default";
    return {
      mode,
      provider,
      baseUrl: row?.base_url ?? "",
      model: row?.model ?? "",
      editModel: row?.edit_model ?? "",
      keySource: row?.api_key ? "saved" : "none",
      keyHint: row?.api_key ? row.key_hint : "",
      ready: mode === "custom" && complete(row),
      updatedAt: iso(row?.updated_at),
    };
  }

  function personalVisionView(row: MediaRow | null): PersonalVisionView {
    const mode = row?.mode === "custom" || row?.mode === "follow" ? row.mode : "default";
    return {
      mode,
      baseUrl: row?.base_url ?? "",
      model: row?.model ?? "",
      keySource: row?.api_key ? "saved" : "none",
      keyHint: row?.api_key ? row.key_hint : "",
      ready: mode === "custom" && complete(row),
      updatedAt: iso(row?.updated_at),
    };
  }

  async function adminView(): Promise<MediaAdminView> {
    return { image: await imageDefaultView(), vision: visionView(await mediaRow("", "vision")) };
  }

  async function defaultsSummary(): Promise<MediaDefaultsSummary> {
    const image = await imageDefaultView();
    const vision = visionView(await mediaRow("", "vision"));
    return {
      image: { ready: image.ready, provider: image.provider, model: image.model },
      vision: { mode: vision.mode, ready: vision.ready, model: vision.ready ? vision.model : "" },
    };
  }

  async function canUsePrivate(userId: string) {
    return options.isAdmin ? await options.isAdmin(userId).catch(() => false) : false;
  }

  async function personalView(userId: string): Promise<MediaPersonalView> {
    return {
      image: personalImageView(await mediaRow(userId, "image")),
      vision: personalVisionView(await mediaRow(userId, "vision")),
      defaults: await defaultsSummary(),
      privateUrlsAllowed: await canUsePrivate(userId),
    };
  }

  async function checkUrl(userId: string | null, url: string) {
    if (userId === null || (await canUsePrivate(userId))) return;
    try {
      await assertPublic(url);
    } catch (error) {
      throw new MediaModelsError(`接口地址不能用：${error instanceof Error ? error.message : "不是公网地址"}（个人设置只能填公网接口）。`);
    }
  }

  const visionInput = z
    .object({
      mode: z.enum(["follow", "custom"]),
      baseUrl: z.string().trim().max(300).optional(),
      model: z.string().trim().max(160).optional(),
      apiKey: z.string().max(4000).optional(),
    })
    .strict();

  /** custom 必须齐：地址、模型、密钥（新填的或已存的）。 */
  function requireComplete(input: { baseUrl?: string; model?: string; apiKey?: string }, row: MediaRow | null, what: string) {
    const baseUrl = httpUrl.safeParse(input.baseUrl ?? "");
    if (!baseUrl.success) throw new MediaModelsError(baseUrl.error.issues[0]?.message ?? "接口地址不对。");
    if (!input.model?.trim()) throw new MediaModelsError(`要填${what}的模型名。`);
    const hasKey = input.apiKey !== undefined ? Boolean(input.apiKey.trim()) : Boolean(row?.api_key);
    if (!hasKey) throw new MediaModelsError(`要填${what}的 API 密钥。`);
  }

  async function saveVisionDefault(actorId: string, raw: unknown): Promise<VisionSettingsView> {
    const input = visionInput.parse(raw);
    const row = await mediaRow("", "vision");
    if (input.mode === "custom") requireComplete(input, row, "识图模型");
    await upsertMedia("", "vision", actorId, {
      mode: input.mode,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    });
    return visionView(await mediaRow("", "vision"));
  }

  const personalImageInput = z
    .object({
      mode: z.enum(["default", "custom"]),
      provider: z.enum(["minimax", "openai"]).optional(),
      baseUrl: z.string().trim().max(300).optional(),
      model: z.string().trim().max(120).optional(),
      editModel: z.string().trim().max(120).optional(),
      apiKey: z.string().max(4000).optional(),
    })
    .strict();

  async function savePersonalImage(userId: string, raw: unknown): Promise<MediaPersonalView> {
    const input = personalImageInput.parse(raw);
    const row = await mediaRow(userId, "image");
    if (input.mode === "custom") {
      if (!input.provider) throw new MediaModelsError("要选接口类型。");
      requireComplete(input, row, "生图模型");
      await checkUrl(userId, input.baseUrl!);
    }
    await upsertMedia(userId, "image", userId, {
      mode: input.mode,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.editModel !== undefined ? { editModel: input.editModel } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    });
    return personalView(userId);
  }

  const personalVisionInput = visionInput.extend({ mode: z.enum(["default", "follow", "custom"]) }).strict();

  async function savePersonalVision(userId: string, raw: unknown): Promise<MediaPersonalView> {
    const input = personalVisionInput.parse(raw);
    const row = await mediaRow(userId, "vision");
    if (input.mode === "custom") {
      requireComplete(input, row, "识图模型");
      await checkUrl(userId, input.baseUrl!);
    }
    await upsertMedia(userId, "vision", userId, {
      mode: input.mode,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    });
    return personalView(userId);
  }

  // ------------------------------------------------------------------ 解析（给机器人用）

  async function rowImageConfig(row: MediaRow): Promise<ImageProviderConfig | null> {
    if (!row.api_key || !row.base_url || !row.model) return null;
    return {
      provider: row.provider === "minimax" ? "minimax" : "openai",
      baseUrl: row.base_url,
      model: row.model,
      editModel: row.edit_model,
      apiKey: await decryptSecret(options.encryptionKey, row.api_key),
    };
  }

  async function rowVisionConfig(row: MediaRow | null): Promise<VisionConfig | null> {
    if (!row?.api_key || !row.base_url || !row.model) return null;
    return { baseUrl: row.base_url, model: row.model, apiKey: await decryptSecret(options.encryptionKey, row.api_key) };
  }

  /** 这个人现在用哪个生图模型：个人 custom → 管理员默认（打开且齐全）→ 没有。 */
  async function imageFor(userId: string): Promise<EffectiveImage | null> {
    const mine = await mediaRow(userId, "image");
    if (mine?.mode === "custom") {
      const config = await rowImageConfig(mine);
      if (config) {
        if (!(await canUsePrivate(userId))) await checkUrl(userId, config.baseUrl);
        return { config, source: "personal" };
      }
    }
    const view = await imageDefaultView();
    if (!view.ready) return null;
    const config = await imageDefaultConfig();
    return config ? { config, source: "default" } : null;
  }

  async function imageViewFor(userId: string): Promise<{ ready: boolean; provider: ImageProviderKind; source: "personal" | "default" | null }> {
    const mine = await mediaRow(userId, "image");
    if (mine?.mode === "custom" && complete(mine)) return { ready: true, provider: mine.provider === "minimax" ? "minimax" : "openai", source: "personal" };
    const view = await imageDefaultView();
    return { ready: view.ready, provider: view.provider, source: view.ready ? "default" : null };
  }

  /**
   * 这个人、这个机器人的图片怎么给主模型：
   * 个人 custom → 个人 follow → 管理员 custom → 跟随主模型；跟随主模型但主模型明确看不了图时，
   * 退回管理员的识图模型（有的话），都没有就是 none。
   */
  async function visionFor(userId: string, agentId: string): Promise<EffectiveVision> {
    const mine = await mediaRow(userId, "vision");
    const admin = await mediaRow("", "vision");
    const model = async (row: MediaRow | null, source: "personal" | "default"): Promise<EffectiveVision | null> => {
      const config = await rowVisionConfig(row);
      if (!config) return null;
      if (source === "personal" && !(await canUsePrivate(userId))) {
        try {
          await assertPublic(config.baseUrl);
        } catch {
          return null;
        }
      }
      return { kind: "model", config, source, label: config.model };
    };
    if (mine?.mode === "custom") {
      const chosen = await model(mine, "personal");
      if (chosen) return chosen;
    }
    if (mine?.mode !== "follow" && admin?.mode === "custom") {
      const chosen = await model(admin, "default");
      if (chosen) return chosen;
    }
    const supports = options.mainModelSupportsImages ? await options.mainModelSupportsImages(agentId).catch(() => undefined) : undefined;
    if (supports !== false) return { kind: "main" };
    if (admin?.mode === "custom") {
      const fallback = await model(admin, "default");
      if (fallback) return fallback;
    }
    return { kind: "none" };
  }

  // ------------------------------------------------------------------ 描述缓存

  const inflight = new Map<string, Promise<string>>();

  async function cachedDescription(fileId: string, config: VisionConfig): Promise<string | null> {
    const rows = await sql.unsafe<{ text: string }[]>("SELECT text FROM chisabot_image_descriptions WHERE file_id = $1 AND model_key = $2", [fileId, modelKeyOf(config)]);
    return rows[0]?.text ?? null;
  }

  /**
   * 一张图的详细描述（含 OCR），按 (文件, 模型) 缓存。同一张图并发请求只调一次。
   * fresh = false（老图）且没有缓存时不调用，返回 null。
   */
  async function describe(fileId: string, image: { bytes: Buffer; mimeType: string }, config: VisionConfig, opts: { fresh: boolean }): Promise<string | null> {
    const cached = await cachedDescription(fileId, config);
    if (cached) return cached;
    if (!opts.fresh) return null;
    const key = `${fileId}:${modelKeyOf(config)}`;
    const running = inflight.get(key);
    if (running) return running;
    const job = (async () => {
      const text = await askVisionModel(config, image, DESCRIBE_PROMPT, { fetch: doFetch });
      await sql.unsafe(
        `INSERT INTO chisabot_image_descriptions (file_id, model_key, model, text) VALUES ($1, $2, $3, $4)
         ON CONFLICT (file_id, model_key) DO UPDATE SET text = $4, created_at = now()`,
        [fileId, modelKeyOf(config), config.model, text.slice(0, 20_000)],
      );
      return text;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  async function ask(config: VisionConfig, image: { bytes: Buffer; mimeType: string }, question: string, signal?: AbortSignal) {
    return askVisionModel(config, image, question, { fetch: doFetch, ...(signal ? { signal } : {}) });
  }

  async function forgetDescriptions(fileId: string) {
    await sql.unsafe("DELETE FROM chisabot_image_descriptions WHERE file_id = $1", [fileId]);
  }

  // ------------------------------------------------------------------ 检查

  const probeImageInput = z
    .object({
      scope: z.enum(["default", "personal"]),
      provider: z.enum(["minimax", "openai"]),
      baseUrl: httpUrl,
      model: z.string().trim().min(1, "要填模型名").max(120),
      apiKey: z.string().max(4000).optional(),
    })
    .strict();

  async function probeImage(userId: string, isAdmin: boolean, raw: unknown): Promise<MediaProbeResult> {
    const input = probeImageInput.parse(raw);
    const typed = input.apiKey?.trim() ?? "";
    let config: ImageProviderConfig | null;
    if (input.scope === "default") {
      if (!isAdmin) throw new MediaModelsError("只有管理员能检查默认模型。");
      config = await imageDefaultConfig({ provider: input.provider, baseUrl: input.baseUrl, model: input.model, ...(typed ? { apiKey: typed } : {}) });
      if (!config) return { ok: false, message: "没有密钥：填一个密钥，或者在部署环境变量里配置。" };
    } else {
      await checkUrl(userId, input.baseUrl);
      const row = await mediaRow(userId, "image");
      const key = typed || (row?.api_key ? await decryptSecret(options.encryptionKey, row.api_key) : "");
      if (!key) return { ok: false, message: "没有密钥：请先填 API 密钥。" };
      config = { provider: input.provider, baseUrl: input.baseUrl, model: input.model, apiKey: key };
    }
    return probeImageModel(config, doFetch);
  }

  const probeVisionInput = z
    .object({ scope: z.enum(["default", "personal"]), baseUrl: httpUrl, model: z.string().trim().min(1, "要填模型名").max(160), apiKey: z.string().max(4000).optional() })
    .strict();

  async function probeVision(userId: string, isAdmin: boolean, raw: unknown): Promise<MediaProbeResult> {
    const input = probeVisionInput.parse(raw);
    if (input.scope === "default" && !isAdmin) throw new MediaModelsError("只有管理员能检查默认模型。");
    if (input.scope === "personal") await checkUrl(userId, input.baseUrl);
    const row = await mediaRow(input.scope === "default" ? "" : userId, "vision");
    const key = input.apiKey?.trim() || (row?.api_key ? await decryptSecret(options.encryptionKey, row.api_key) : "");
    if (!key) return { ok: false, message: "没有密钥：请先填 API 密钥。" };
    return probeVisionModel({ baseUrl: input.baseUrl, model: input.model, apiKey: key }, doFetch);
  }

  // ------------------------------------------------------------------ 路由（/api/media-models）

  function routes(requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", requireUser);
    app.onError((error, c) => {
      if (error instanceof MediaModelsError) return c.json({ error: error.message }, 400);
      if (error instanceof z.ZodError) return c.json({ error: error.issues[0]?.message ?? "参数不对。" }, 400);
      console.error(JSON.stringify({ type: "media-models-error", error: error.name, route: c.req.path }));
      return c.json({ error: "模型设置暂时不可用，请重试。" }, 503);
    });
    const admin: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
      if (c.var.actor.role !== "admin") return c.json({ error: "只有管理员能改默认模型。" }, 403);
      await next();
    };
    const small = bodyLimit({ maxSize: 16_384 });
    app.get("/default", admin, async (c) => c.json(await adminView()));
    app.put("/default/image", admin, small, async (c) => c.json({ image: await saveImageDefault(c.var.actor.id, await c.req.json()) }));
    app.put("/default/vision", admin, small, async (c) => c.json({ vision: await saveVisionDefault(c.var.actor.id, await c.req.json()) }));
    app.get("/me", async (c) => c.json(await personalView(c.var.actor.id)));
    app.put("/me/image", small, async (c) => c.json(await savePersonalImage(c.var.actor.id, await c.req.json())));
    app.put("/me/vision", small, async (c) => c.json(await savePersonalVision(c.var.actor.id, await c.req.json())));
    app.post("/test/image", small, async (c) => c.json(await probeImage(c.var.actor.id, c.var.actor.role === "admin", await c.req.json())));
    app.post("/test/vision", small, async (c) => c.json(await probeVision(c.var.actor.id, c.var.actor.role === "admin", await c.req.json())));
    return app;
  }

  return {
    ensure,
    imageDefaultView,
    imageDefaultConfig,
    saveImageDefault,
    saveVisionDefault,
    savePersonalImage,
    savePersonalVision,
    adminView,
    personalView,
    imageFor,
    imageViewFor,
    visionFor,
    describe,
    cachedDescription,
    ask,
    forgetDescriptions,
    probeImage,
    probeVision,
    routes,
    DESCRIBE_FRESH_MS,
  };
}
export type MediaModels = ReturnType<typeof createMediaModels>;
