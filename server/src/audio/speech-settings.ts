import { z } from "zod";
import {
  DEFAULT_SPEECH_TTS_SPEED,
  DEFAULT_SPEECH_TTS_VOICE,
  type SpeechKeySource,
  type SpeechSettingsView,
  type SpeechTtsProvider,
} from "../../../shared/speech";
import { decryptSecret, encryptSecret } from "../credentials";
import type { Database } from "../db/client";
import type {
  SpeechAsrConfig,
  SpeechConfig,
  SpeechTtsConfig,
} from "./speech-service";

/**
 * 语音服务（ASR / TTS）管理员设置存储。
 *
 * - 运行时幂等建单行表 `chisabot_speech_settings`（id = 'default'），不改动 Drizzle 旧表结构。
 * - API 密钥采用 AES-256-GCM（`encryptSecret`/`decryptSecret`）加密落盘，视图仅返回来源与末四位提示。
 * - 解析优先级：DB 已存配置优先，未填项平滑回退到启动时传入的 `envSpeechConfig`（严禁直接读 process.env）。
 */

export class SpeechSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechSettingsValidationError";
  }
}

export type SpeechSettingsRow = {
  id: string;
  asr_enabled: boolean;
  asr_base_url: string;
  asr_model: string;
  asr_api_key: string | null;
  asr_key_hint: string;
  tts_enabled: boolean;
  tts_provider: string;
  tts_base_url: string;
  tts_model: string;
  tts_voice: string;
  tts_speed: number | string;
  tts_api_key: string | null;
  tts_key_hint: string;
  updated_at: Date | string | null;
  updated_by: string | null;
};

export type SpeechTestTtsOverride = {
  provider?: SpeechTtsProvider;
  baseUrl?: string;
  model?: string;
  voice?: string;
  speed?: number;
  apiKey?: string;
};

export type SpeechTestAsrOverride = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
};

export type SpeechSettingsStore = {
  ensure(): Promise<void>;
  view(): Promise<SpeechSettingsView>;
  save(actorId: string, raw: unknown): Promise<SpeechSettingsView>;
  resolveConfig(): Promise<SpeechConfig>;
  resolveForTestTts(
    override?: SpeechTestTtsOverride,
  ): Promise<SpeechTtsConfig | null>;
  resolveForTestAsr(
    override?: SpeechTestAsrOverride,
  ): Promise<SpeechAsrConfig | null>;
};

export type SpeechSettingsDatabase = {
  $client: Pick<Database["$client"], "unsafe">;
};

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

function keyHintOf(secret: string | undefined): string {
  const trimmed = secret?.trim() ?? "";
  return trimmed.length >= 8 ? trimmed.slice(-4) : "";
}

function normalizeSpeed(raw: number | string | undefined): number {
  const num = typeof raw === "string" ? Number(raw) : raw;
  if (
    typeof num === "number" &&
    Number.isFinite(num) &&
    num >= 0.25 &&
    num <= 4
  ) {
    return num;
  }
  return DEFAULT_SPEECH_TTS_SPEED;
}

function normalizeProvider(raw: string | undefined): SpeechTtsProvider {
  return raw === "fish" ? "fish" : "openai";
}

/** 校验两个端点地址是否同源（协议 + 主机 + 端口一致），防止将旧密钥跨源发往新主机。 */
export function sameSpeechOrigin(
  a: string | undefined,
  b: string | undefined,
): boolean {
  const left = a?.trim();
  const right = b?.trim();
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** 严格校验语音服务端点 URL：仅允许 http/https，拒绝 userinfo、query 与 hash。 */
export function parseSpeechEndpointUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new SpeechSettingsValidationError(`${label}不能为空。`);
  }
  if (trimmed.length > 300) {
    throw new SpeechSettingsValidationError(
      `${label}长度不能超过 300 个字符。`,
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SpeechSettingsValidationError(
      `${label}必须是合法的 HTTP(S) URL。`,
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    trimmed.includes("?") ||
    trimmed.includes("#")
  ) {
    throw new SpeechSettingsValidationError(
      `${label}必须是 HTTP(S) URL，且不能包含用户名密码、查询参数或片段。`,
    );
  }
  return url.href.replace(/\/+$/, "");
}

const speechSettingsInputSchema = z
  .object({
    asr: z
      .object({
        enabled: z.boolean({ error: "ASR 开关必须是布尔值。" }),
        baseUrl: z
          .string({ error: "ASR 接口地址必须是字符串。" })
          .trim()
          .max(300, "ASR 接口地址过长。"),
        model: z
          .string({ error: "ASR 模型名必须是字符串。" })
          .trim()
          .max(160, "ASR 模型名过长。"),
        apiKey: z.string().max(4000, "ASR API 密钥过长。").optional(),
        clearApiKey: z.boolean().optional(),
      })
      .strict(),
    tts: z
      .object({
        enabled: z.boolean({ error: "TTS 开关必须是布尔值。" }),
        provider: z.enum(["openai", "fish"], {
          error: "TTS 服务商仅支持 openai 或 fish。",
        }),
        baseUrl: z
          .string({ error: "TTS 接口地址必须是字符串。" })
          .trim()
          .max(300, "TTS 接口地址过长。"),
        model: z
          .string({ error: "TTS 模型名必须是字符串。" })
          .trim()
          .max(160, "TTS 模型名过长。"),
        voice: z
          .string({ error: "默认音色必须是字符串。" })
          .trim()
          .max(128, "默认音色名称过长。"),
        speed: z
          .number({ error: "默认语速必须是数字。" })
          .finite("默认语速必须是有效数字。")
          .min(0.25, "默认语速不能低于 0.25。")
          .max(4, "默认语速不能高于 4.0。")
          .optional(),
        apiKey: z.string().max(4000, "TTS API 密钥过长。").optional(),
        clearApiKey: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export function createSpeechSettingsStore(
  database: SpeechSettingsDatabase,
  options: {
    encryptionKey: string;
    envSpeechConfig?: SpeechConfig;
  },
): SpeechSettingsStore {
  const sql = database.$client;
  const envConfig = options.envSpeechConfig ?? {};

  async function ensure(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS chisabot_speech_settings (
        id text PRIMARY KEY DEFAULT 'default',
        asr_enabled boolean NOT NULL DEFAULT false,
        asr_base_url text NOT NULL DEFAULT '',
        asr_model text NOT NULL DEFAULT '',
        asr_api_key text,
        asr_key_hint text NOT NULL DEFAULT '',
        tts_enabled boolean NOT NULL DEFAULT false,
        tts_provider text NOT NULL DEFAULT 'openai',
        tts_base_url text NOT NULL DEFAULT '',
        tts_model text NOT NULL DEFAULT '',
        tts_voice text NOT NULL DEFAULT '',
        tts_speed double precision NOT NULL DEFAULT 1.0,
        tts_api_key text,
        tts_key_hint text NOT NULL DEFAULT '',
        updated_at timestamptz,
        updated_by text
      );
    `);
  }

  async function readRow(): Promise<SpeechSettingsRow | null> {
    const rows = await sql.unsafe<SpeechSettingsRow[]>(
      "SELECT * FROM chisabot_speech_settings WHERE id = 'default'",
    );
    return rows[0] ?? null;
  }

  async function resolveScopedKey(params: {
    explicitKey?: string;
    targetBaseUrl: string;
    targetProvider?: SpeechTtsProvider;
    savedSealed: string | null | undefined;
    savedBaseUrl: string | undefined;
    savedProvider?: SpeechTtsProvider;
    envApiKey: string | undefined;
    envBaseUrl: string | undefined;
    envProvider?: SpeechTtsProvider;
  }): Promise<string | undefined> {
    const explicit = params.explicitKey?.trim();
    if (explicit) return explicit;

    const savedProviderMatches =
      params.targetProvider === undefined ||
      params.targetProvider === params.savedProvider;
    if (
      params.savedSealed &&
      savedProviderMatches &&
      sameSpeechOrigin(params.targetBaseUrl, params.savedBaseUrl)
    ) {
      const plaintext = await decryptSecret(
        options.encryptionKey,
        params.savedSealed,
      );
      if (plaintext.trim()) return plaintext.trim();
    }

    const envProviderMatches =
      params.targetProvider === undefined ||
      params.targetProvider === params.envProvider;
    const envSecret = params.envApiKey?.trim();
    if (
      envSecret &&
      envProviderMatches &&
      sameSpeechOrigin(params.targetBaseUrl, params.envBaseUrl)
    ) {
      return envSecret;
    }

    return undefined;
  }

  function buildView(row: SpeechSettingsRow | null): SpeechSettingsView {
    const asrEnv = envConfig.asr;
    const ttsEnv = envConfig.tts;

    const asrEnabled = row ? Boolean(row.asr_enabled) : Boolean(asrEnv);
    const asrBaseUrl = row?.asr_base_url.trim() || asrEnv?.baseUrl || "";
    const asrModel = row?.asr_model.trim() || asrEnv?.model || "";
    const asrEnvMatches =
      Boolean(asrEnv?.apiKey) && sameSpeechOrigin(asrBaseUrl, asrEnv?.baseUrl);
    const asrKeySource: SpeechKeySource = row?.asr_api_key
      ? "saved"
      : asrEnvMatches
        ? "environment"
        : "none";
    const asrKeyHint = row?.asr_api_key
      ? row.asr_key_hint
      : asrEnvMatches
        ? keyHintOf(asrEnv?.apiKey)
        : "";

    const ttsEnabled = row ? Boolean(row.tts_enabled) : Boolean(ttsEnv);
    const ttsProvider = row
      ? normalizeProvider(row.tts_provider)
      : normalizeProvider(ttsEnv?.provider);
    const ttsBaseUrl = row?.tts_base_url.trim() || ttsEnv?.baseUrl || "";
    const ttsModel = row?.tts_model.trim() || ttsEnv?.model || "";
    const ttsVoice =
      row?.tts_voice.trim() ||
      ttsEnv?.voice ||
      (ttsProvider === "openai" ? DEFAULT_SPEECH_TTS_VOICE : "");
    const ttsSpeed = row
      ? normalizeSpeed(row.tts_speed)
      : normalizeSpeed(ttsEnv?.speed);
    const ttsEnvMatches =
      Boolean(ttsEnv?.apiKey) &&
      sameSpeechOrigin(ttsBaseUrl, ttsEnv?.baseUrl) &&
      ttsProvider === normalizeProvider(ttsEnv?.provider);
    const ttsKeySource: SpeechKeySource = row?.tts_api_key
      ? "saved"
      : ttsEnvMatches
        ? "environment"
        : "none";
    const ttsKeyHint = row?.tts_api_key
      ? row.tts_key_hint
      : ttsEnvMatches
        ? keyHintOf(ttsEnv?.apiKey)
        : "";

    return {
      asr: {
        enabled: asrEnabled,
        baseUrl: asrBaseUrl,
        model: asrModel,
      },
      tts: {
        enabled: ttsEnabled,
        provider: ttsProvider,
        baseUrl: ttsBaseUrl,
        model: ttsModel,
        voice: ttsVoice,
        speed: ttsSpeed,
      },
      asrKeySource,
      asrKeyHint,
      ttsKeySource,
      ttsKeyHint,
      updatedAt: iso(row?.updated_at),
    };
  }

  async function view(): Promise<SpeechSettingsView> {
    return buildView(await readRow());
  }

  async function resolveConfig(): Promise<SpeechConfig> {
    const row = await readRow();
    const merged = buildView(row);
    const savedAsrBaseUrl = row
      ? row.asr_base_url.trim() || envConfig.asr?.baseUrl || ""
      : undefined;
    const savedTtsBaseUrl = row
      ? row.tts_base_url.trim() || envConfig.tts?.baseUrl || ""
      : undefined;
    const savedTtsProvider = row
      ? normalizeProvider(row.tts_provider)
      : undefined;
    const envTtsProvider = normalizeProvider(envConfig.tts?.provider);

    let asr: SpeechAsrConfig | undefined;
    if (merged.asr.enabled && merged.asr.baseUrl && merged.asr.model) {
      const apiKey = await resolveScopedKey({
        targetBaseUrl: merged.asr.baseUrl,
        savedSealed: row?.asr_api_key,
        savedBaseUrl: savedAsrBaseUrl,
        envApiKey: envConfig.asr?.apiKey,
        envBaseUrl: envConfig.asr?.baseUrl,
      });
      asr = {
        baseUrl: merged.asr.baseUrl,
        model: merged.asr.model,
        ...(apiKey ? { apiKey } : {}),
      };
    }

    let tts: SpeechTtsConfig | undefined;
    if (
      merged.tts.enabled &&
      merged.tts.baseUrl &&
      (merged.tts.provider === "fish" || merged.tts.model)
    ) {
      const apiKey = await resolveScopedKey({
        targetBaseUrl: merged.tts.baseUrl,
        targetProvider: merged.tts.provider,
        savedSealed: row?.tts_api_key,
        savedBaseUrl: savedTtsBaseUrl,
        savedProvider: savedTtsProvider,
        envApiKey: envConfig.tts?.apiKey,
        envBaseUrl: envConfig.tts?.baseUrl,
        envProvider: envTtsProvider,
      });
      const speedFromDb =
        row !== null || envConfig.tts?.speed !== undefined
          ? merged.tts.speed
          : undefined;
      tts = {
        provider: merged.tts.provider,
        baseUrl: merged.tts.baseUrl,
        model: merged.tts.model,
        ...(merged.tts.voice ? { voice: merged.tts.voice } : {}),
        ...(speedFromDb !== undefined ? { speed: speedFromDb } : {}),
        ...(apiKey ? { apiKey } : {}),
      };
    }

    return {
      ...(asr ? { asr } : {}),
      ...(tts ? { tts } : {}),
    };
  }

  async function save(
    actorId: string,
    raw: unknown,
  ): Promise<SpeechSettingsView> {
    const parsed = speechSettingsInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SpeechSettingsValidationError(
        parsed.error.issues[0]?.message ?? "语音服务配置参数无效。",
      );
    }
    const input = parsed.data;

    const normalizedAsrBaseUrl = input.asr.baseUrl
      ? parseSpeechEndpointUrl(input.asr.baseUrl, "ASR 接口地址")
      : "";
    const effectiveAsrBaseUrl =
      normalizedAsrBaseUrl || envConfig.asr?.baseUrl || "";
    const effectiveAsrModel = input.asr.model || envConfig.asr?.model || "";
    if (input.asr.enabled) {
      if (!effectiveAsrBaseUrl) {
        throw new SpeechSettingsValidationError(
          "启用 ASR 语音识别时必须填写接口地址。",
        );
      }
      if (!effectiveAsrModel) {
        throw new SpeechSettingsValidationError(
          "启用 ASR 语音识别时必须填写模型名称。",
        );
      }
    }

    const normalizedTtsBaseUrl = input.tts.baseUrl
      ? parseSpeechEndpointUrl(input.tts.baseUrl, "TTS 接口地址")
      : "";
    const effectiveTtsBaseUrl =
      normalizedTtsBaseUrl || envConfig.tts?.baseUrl || "";
    const effectiveTtsModel = input.tts.model || envConfig.tts?.model || "";
    if (input.tts.enabled) {
      if (!effectiveTtsBaseUrl) {
        throw new SpeechSettingsValidationError(
          "启用 TTS 语音合成时必须填写接口地址。",
        );
      }
      if (input.tts.provider === "openai" && !effectiveTtsModel) {
        throw new SpeechSettingsValidationError(
          "启用 OpenAI 兼容 TTS 时必须填写模型名称。",
        );
      }
    }

    const row = await readRow();
    const prevAsrBaseUrl = row
      ? row.asr_base_url.trim() || envConfig.asr?.baseUrl || ""
      : "";
    const prevTtsBaseUrl = row
      ? row.tts_base_url.trim() || envConfig.tts?.baseUrl || ""
      : "";
    const prevTtsProvider = row
      ? normalizeProvider(row.tts_provider)
      : normalizeProvider(envConfig.tts?.provider);

    // 同源（TTS 同时要求同厂商）且未填新密钥时保留原已存密钥；跨源/切厂商或显式 clearApiKey 时绝不继承旧密钥。
    const canKeepSavedAsrKey = sameSpeechOrigin(
      effectiveAsrBaseUrl,
      prevAsrBaseUrl,
    );
    let asrSealed = canKeepSavedAsrKey ? (row?.asr_api_key ?? null) : null;
    let asrKeyHint = canKeepSavedAsrKey ? (row?.asr_key_hint ?? "") : "";
    const nextAsrKey = input.asr.apiKey?.trim() ?? "";
    if (input.asr.clearApiKey) {
      asrSealed = null;
      asrKeyHint = "";
    } else if (nextAsrKey) {
      asrSealed = await encryptSecret(options.encryptionKey, nextAsrKey);
      asrKeyHint = keyHintOf(nextAsrKey);
    }

    const canKeepSavedTtsKey =
      sameSpeechOrigin(effectiveTtsBaseUrl, prevTtsBaseUrl) &&
      input.tts.provider === prevTtsProvider;
    let ttsSealed = canKeepSavedTtsKey ? (row?.tts_api_key ?? null) : null;
    let ttsKeyHint = canKeepSavedTtsKey ? (row?.tts_key_hint ?? "") : "";
    const nextTtsKey = input.tts.apiKey?.trim() ?? "";
    if (input.tts.clearApiKey) {
      ttsSealed = null;
      ttsKeyHint = "";
    } else if (nextTtsKey) {
      ttsSealed = await encryptSecret(options.encryptionKey, nextTtsKey);
      ttsKeyHint = keyHintOf(nextTtsKey);
    }

    const ttsSpeed = normalizeSpeed(input.tts.speed ?? row?.tts_speed);

    await sql.unsafe(
      `INSERT INTO chisabot_speech_settings (
         id,
         asr_enabled,
         asr_base_url,
         asr_model,
         asr_api_key,
         asr_key_hint,
         tts_enabled,
         tts_provider,
         tts_base_url,
         tts_model,
         tts_voice,
         tts_speed,
         tts_api_key,
         tts_key_hint,
         updated_at,
         updated_by
       )
       VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), $14)
       ON CONFLICT (id) DO UPDATE SET
         asr_enabled = $1,
         asr_base_url = $2,
         asr_model = $3,
         asr_api_key = $4,
         asr_key_hint = $5,
         tts_enabled = $6,
         tts_provider = $7,
         tts_base_url = $8,
         tts_model = $9,
         tts_voice = $10,
         tts_speed = $11,
         tts_api_key = $12,
         tts_key_hint = $13,
         updated_at = now(),
         updated_by = $14`,
      [
        input.asr.enabled,
        normalizedAsrBaseUrl,
        input.asr.model,
        asrSealed,
        asrKeyHint,
        input.tts.enabled,
        input.tts.provider,
        normalizedTtsBaseUrl,
        input.tts.model,
        input.tts.voice,
        ttsSpeed,
        ttsSealed,
        ttsKeyHint,
        actorId,
      ],
    );

    return view();
  }

  async function resolveForTestTts(
    override?: SpeechTestTtsOverride,
  ): Promise<SpeechTtsConfig | null> {
    const row = await readRow();
    const merged = buildView(row);
    const provider = override?.provider ?? merged.tts.provider;
    const rawBaseUrl = override?.baseUrl?.trim() || merged.tts.baseUrl;
    if (!rawBaseUrl) return null;
    const baseUrl = parseSpeechEndpointUrl(rawBaseUrl, "TTS 接口地址");
    const model =
      override?.model !== undefined ? override.model.trim() : merged.tts.model;
    if (provider === "openai" && !model) return null;
    const voice =
      override?.voice !== undefined ? override.voice.trim() : merged.tts.voice;
    const speed =
      override?.speed !== undefined
        ? normalizeSpeed(override.speed)
        : merged.tts.speed;
    const savedTtsBaseUrl = row
      ? row.tts_base_url.trim() || envConfig.tts?.baseUrl || ""
      : undefined;
    const apiKey = await resolveScopedKey({
      explicitKey: override?.apiKey,
      targetBaseUrl: baseUrl,
      targetProvider: provider,
      savedSealed: row?.tts_api_key,
      savedBaseUrl: savedTtsBaseUrl,
      savedProvider: row ? normalizeProvider(row.tts_provider) : undefined,
      envApiKey: envConfig.tts?.apiKey,
      envBaseUrl: envConfig.tts?.baseUrl,
      envProvider: normalizeProvider(envConfig.tts?.provider),
    });
    return {
      provider,
      baseUrl,
      model,
      ...(voice ? { voice } : {}),
      speed,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  async function resolveForTestAsr(
    override?: SpeechTestAsrOverride,
  ): Promise<SpeechAsrConfig | null> {
    const row = await readRow();
    const merged = buildView(row);
    const rawBaseUrl = override?.baseUrl?.trim() || merged.asr.baseUrl;
    if (!rawBaseUrl) return null;
    const baseUrl = parseSpeechEndpointUrl(rawBaseUrl, "ASR 接口地址");
    const model =
      override?.model !== undefined ? override.model.trim() : merged.asr.model;
    if (!model) return null;
    const savedAsrBaseUrl = row
      ? row.asr_base_url.trim() || envConfig.asr?.baseUrl || ""
      : undefined;
    const apiKey = await resolveScopedKey({
      explicitKey: override?.apiKey,
      targetBaseUrl: baseUrl,
      savedSealed: row?.asr_api_key,
      savedBaseUrl: savedAsrBaseUrl,
      envApiKey: envConfig.asr?.apiKey,
      envBaseUrl: envConfig.asr?.baseUrl,
    });
    return {
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    };
  }

  return {
    ensure,
    view,
    save,
    resolveConfig,
    resolveForTestTts,
    resolveForTestAsr,
  };
}
