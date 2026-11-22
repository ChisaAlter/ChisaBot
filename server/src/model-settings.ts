import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { normalizeModelBaseUrl } from "../../shared/model-base-url";
import type { ModelKeyPool, ModelPoolKey } from "./conversations/key-pool";
import {
  createCredentialStore,
  decryptSecret,
  encryptSecret,
  type CredentialExecutor,
} from "./credentials";
import type { Database } from "./db/client";
import { credentials, enterpriseSettings } from "./db/schema";

export type ModelConnectionConfig = {
  provider: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  useApiKey: boolean;
};
export type ModelConnectionPooledKeyInput = {
  id?: string;
  label: string;
  apiKey?: string;
  remove?: boolean;
};
export type ModelConnectionPooledKeyRuntime = {
  id: string;
  label: string;
  apiKey: string;
};
export type ModelConnectionPooledKeyProjection = {
  id: string;
  label: string;
  hasApiKey: boolean;
  healthy: boolean;
  cooldownUntil: number | null;
  lastStatus?: number;
};
export type ModelConnectionInput = ModelConnectionConfig & {
  apiKey?: string;
  pooledKeys?: ModelConnectionPooledKeyInput[];
};
export type ModelConnectionRuntime = ModelConnectionConfig & {
  apiKey: string | null;
  source?: "environment" | "saved";
  pooledKeys?: ModelConnectionPooledKeyRuntime[];
};
export type ModelConnectionProjection = ModelConnectionConfig & {
  hasApiKey: boolean;
  source: "environment" | "saved";
  pooledKeys?: ModelConnectionPooledKeyProjection[];
};
export type ModelConnectionTestResult = {
  ok: boolean;
  message: string;
  latencyMs: number;
};
export type ModelSettingsSnapshotPooledKey = {
  id: string;
  label: string;
  encryptedApiKey: string;
};
export type ModelSettingsSnapshot = {
  connection: ModelConnectionConfig;
  encryptedApiKey: string | null;
  pooledKeys?: ModelSettingsSnapshotPooledKey[];
};
export type ModelSettingsStore = {
  read: () => Promise<ModelSettingsSnapshot | null>;
  update: (
    change: (
      current: ModelSettingsSnapshot | null,
    ) => Promise<ModelSettingsSnapshot>,
    actorUserId?: string,
  ) => Promise<ModelSettingsSnapshot>;
};
export type ModelSettingsService = {
  get: () => Promise<ModelConnectionProjection>;
  save: (
    input: unknown,
    actorUserId?: string,
  ) => Promise<ModelConnectionProjection>;
  test: (input: unknown) => Promise<ModelConnectionTestResult>;
  resolve: () => Promise<ModelConnectionRuntime>;
};
export class ModelSettingsValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ModelSettingsValidationError";
  }
}
export class ModelSettingsStorageError extends Error {
  constructor() {
    super("模型配置暂时无法读取或保存，请稍后重试。");
    this.name = "ModelSettingsStorageError";
  }
}

const SETTINGS_KEY = "model_connection";
const CREDENTIAL_KEY_ID = "model-connection-api-key";
const POOLED_CREDENTIAL_KEY_PREFIX = `${CREDENTIAL_KEY_ID}:`;
const MAX_POOLED_KEYS = 32;
const PROBE_TIMEOUT_MS = 20_000;
const RESOLVE_CACHE_TTL_MS = 5_000;

function cloneModelConnectionRuntime(
  runtime: ModelConnectionRuntime,
): ModelConnectionRuntime {
  return {
    ...runtime,
    ...(runtime.pooledKeys
      ? { pooledKeys: runtime.pooledKeys.map((item) => ({ ...item })) }
      : {}),
  };
}

export function modelPoolId(
  connection: Pick<ModelConnectionConfig, "provider" | "baseUrl">,
): string {
  return `${connection.provider}:${normalizeModelBaseUrl(connection.provider, connection.baseUrl)}`;
}

function pooledCredentialKeyId(id: string): string {
  return `${POOLED_CREDENTIAL_KEY_PREFIX}${id}`;
}

export function buildConnectionPoolKeys(
  connection: Pick<
    ModelConnectionRuntime,
    "apiKey" | "pooledKeys" | "useApiKey"
  >,
): ModelPoolKey[] {
  if (!connection.useApiKey) return [];
  const pooled = (connection.pooledKeys ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    apiKey: item.apiKey,
  }));
  if (pooled.length === 0) {
    return connection.apiKey
      ? [{ id: "__primary__", label: "主密钥", apiKey: connection.apiKey }]
      : [];
  }
  const hasPrimaryValue =
    Boolean(connection.apiKey) &&
    pooled.some((item) => item.apiKey === connection.apiKey);
  if (connection.apiKey && !hasPrimaryValue) {
    return [
      { id: "__primary__", label: "主密钥", apiKey: connection.apiKey },
      ...pooled,
    ];
  }
  return pooled;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Base URLs deliberately permit private hosts for self-hosted Ollama and compatible gateways. */
export function parseModelConnectionInput(
  input: unknown,
): ModelConnectionInput {
  if (!isObject(input))
    throw new ModelSettingsValidationError("请填写模型连接配置。");
  if (input.provider !== "openai" && input.provider !== "anthropic") {
    throw new ModelSettingsValidationError(
      "请选择 OpenAI 兼容或 Anthropic 接口协议。",
    );
  }
  if (
    typeof input.model !== "string" ||
    !input.model.trim() ||
    input.model.length > 200 ||
    /\s/u.test(input.model.trim()) ||
    hasControlCharacters(input.model.trim())
  ) {
    throw new ModelSettingsValidationError(
      "请填写有效的模型名称，长度不超过 200 个字符且不能包含空白。",
    );
  }
  if (typeof input.baseUrl !== "string" || input.baseUrl.length > 2048) {
    throw new ModelSettingsValidationError(
      "请填写有效的 HTTP 或 HTTPS 接口地址。",
    );
  }
  let address: URL;
  try {
    address = new URL(input.baseUrl.trim());
  } catch {
    throw new ModelSettingsValidationError(
      "请填写有效的 HTTP 或 HTTPS 接口地址。",
    );
  }
  if (
    !/^https?:$/u.test(address.protocol) ||
    !address.hostname ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  ) {
    throw new ModelSettingsValidationError(
      "接口地址必须使用 HTTP 或 HTTPS，且不能包含登录信息、查询参数或锚点。",
    );
  }
  if (input.useApiKey !== undefined && typeof input.useApiKey !== "boolean") {
    throw new ModelSettingsValidationError("请选择是否使用 API Key。");
  }
  if (
    input.apiKey !== undefined &&
    (typeof input.apiKey !== "string" ||
      input.apiKey.length > 16_384 ||
      hasControlCharacters(input.apiKey))
  ) {
    throw new ModelSettingsValidationError("API Key 格式无效，请重新填写。");
  }
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const useApiKey = input.useApiKey !== false;
  if (!useApiKey && apiKey)
    throw new ModelSettingsValidationError(
      "已选择不使用 API Key，请清空密钥输入框。",
    );
  const pooledKeys = parsePooledKeysInput(input.pooledKeys, useApiKey);
  const baseUrl = normalizeModelBaseUrl(input.provider, address.toString());
  return {
    provider: input.provider,
    model: input.model.trim(),
    baseUrl,
    useApiKey,
    ...(apiKey ? { apiKey } : {}),
    ...(pooledKeys !== undefined ? { pooledKeys } : {}),
  };
}

function parsePooledKeysInput(
  raw: unknown,
  useApiKey: boolean,
): ModelConnectionPooledKeyInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new ModelSettingsValidationError("备选 API Key 配置格式无效。");
  }
  if (raw.length > MAX_POOLED_KEYS) {
    throw new ModelSettingsValidationError(
      `备选 API Key 数量不能超过 ${MAX_POOLED_KEYS} 个。`,
    );
  }
  const seenIds = new Set<string>();
  const result: ModelConnectionPooledKeyInput[] = [];
  for (const item of raw) {
    if (!isObject(item)) {
      throw new ModelSettingsValidationError("备选 API Key 配置格式无效。");
    }
    if (item.remove !== undefined && typeof item.remove !== "boolean") {
      throw new ModelSettingsValidationError("备选 API Key 删除标记格式无效。");
    }
    const remove = item.remove === true;
    let id: string | undefined;
    if (item.id !== undefined) {
      if (
        typeof item.id !== "string" ||
        !item.id.trim() ||
        item.id.trim().length > 128 ||
        /\s/u.test(item.id.trim()) ||
        hasControlCharacters(item.id.trim())
      ) {
        throw new ModelSettingsValidationError("备选 API Key 标识格式无效。");
      }
      id = item.id.trim();
      if (seenIds.has(id)) {
        throw new ModelSettingsValidationError("备选 API Key 标识不能重复。");
      }
      seenIds.add(id);
    }
    let label = "";
    if (item.label !== undefined) {
      if (
        typeof item.label !== "string" ||
        item.label.trim().length > 100 ||
        hasControlCharacters(item.label.trim())
      ) {
        throw new ModelSettingsValidationError(
          "请填写有效的备选 API Key 名称，长度不超过 100 个字符。",
        );
      }
      label = item.label.trim();
    }
    if (!remove && !label) {
      throw new ModelSettingsValidationError(
        "请填写有效的备选 API Key 名称，长度不超过 100 个字符。",
      );
    }
    if (
      item.apiKey !== undefined &&
      (typeof item.apiKey !== "string" ||
        item.apiKey.length > 16_384 ||
        hasControlCharacters(item.apiKey))
    ) {
      throw new ModelSettingsValidationError("API Key 格式无效，请重新填写。");
    }
    const apiKey = typeof item.apiKey === "string" ? item.apiKey.trim() : "";
    if (!useApiKey && (!remove || apiKey)) {
      throw new ModelSettingsValidationError(
        "已选择不使用 API Key，请清空备选 API Key 配置。",
      );
    }
    result.push({
      ...(id ? { id } : {}),
      label,
      ...(apiKey ? { apiKey } : {}),
      ...(remove ? { remove: true } : {}),
    });
  }
  return result;
}

type SettingsTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type StoredPooledKey = {
  id: string;
  label: string;
  credentialId: string;
};
type StoredConnection = ModelConnectionConfig & {
  version: 1;
  credentialId: string | null;
  pooledKeys?: StoredPooledKey[];
};

async function readSnapshot(
  transaction: SettingsTransaction,
  lock: "share" | "update",
) {
  const [row] = await transaction
    .select({ value: enterpriseSettings.value })
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, SETTINGS_KEY))
    .for(lock);
  if (!row) return null;
  if (
    !isObject(row.value) ||
    row.value.version !== 1 ||
    (row.value.credentialId !== null &&
      typeof row.value.credentialId !== "string")
  ) {
    throw new ModelSettingsStorageError();
  }
  const parsed = parseModelConnectionInput({
    provider: row.value.provider,
    model: row.value.model,
    baseUrl: row.value.baseUrl,
    useApiKey: row.value.useApiKey,
  });
  const connection: ModelConnectionConfig = {
    provider: parsed.provider,
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    useApiKey: parsed.useApiKey,
  };
  const credentialId = row.value.credentialId as string | null;
  let encryptedApiKey: string | null = null;
  if (connection.useApiKey && credentialId) {
    const [credential] = await transaction
      .select({
        kind: credentials.kind,
        provider: credentials.provider,
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(eq(credentials.id, credentialId));
    if (
      credential &&
      !credential.revokedAt &&
      credential.kind === "model" &&
      credential.provider === connection.provider
    ) {
      encryptedApiKey = credential.encryptedValue;
    }
  }
  const rawStoredPool = row.value.pooledKeys;
  const storedPoolEntries: StoredPooledKey[] = [];
  if (rawStoredPool !== undefined) {
    if (!Array.isArray(rawStoredPool)) {
      throw new ModelSettingsStorageError();
    }
    for (const item of rawStoredPool) {
      if (
        !isObject(item) ||
        typeof item.id !== "string" ||
        typeof item.label !== "string" ||
        typeof item.credentialId !== "string"
      ) {
        throw new ModelSettingsStorageError();
      }
      storedPoolEntries.push({
        id: item.id,
        label: item.label,
        credentialId: item.credentialId,
      });
    }
  }
  const pooledCredentialIds = new Map<string, string>();
  for (const entry of storedPoolEntries) {
    pooledCredentialIds.set(entry.id, entry.credentialId);
  }
  const snapshotPooledKeys: ModelSettingsSnapshotPooledKey[] = [];
  if (connection.useApiKey && storedPoolEntries.length > 0) {
    const credIds = storedPoolEntries.map((item) => item.credentialId);
    const credRows = await transaction
      .select({
        id: credentials.id,
        kind: credentials.kind,
        provider: credentials.provider,
        encryptedValue: credentials.encryptedValue,
        revokedAt: credentials.revokedAt,
      })
      .from(credentials)
      .where(inArray(credentials.id, credIds));
    const credById = new Map(credRows.map((row) => [row.id, row]));
    for (const entry of storedPoolEntries) {
      const credential = credById.get(entry.credentialId);
      if (
        credential &&
        !credential.revokedAt &&
        credential.kind === "model" &&
        credential.provider === connection.provider
      ) {
        snapshotPooledKeys.push({
          id: entry.id,
          label: entry.label,
          encryptedApiKey: credential.encryptedValue,
        });
      }
    }
  }
  const snapshot: ModelSettingsSnapshot = {
    connection,
    encryptedApiKey,
    ...(snapshotPooledKeys.length > 0
      ? { pooledKeys: snapshotPooledKeys }
      : {}),
  };
  return {
    credentialId,
    pooledCredentialIds,
    snapshot,
  };
}

/**
 * The settings row and the referenced encrypted credential commit together. A transaction lock
 * serializes first saves too, when no row exists yet. Readers hold a shared row lock until they have
 * read its credential, so they cannot combine a previous model with a newly rotated key.
 */
export function createModelSettingsStore(
  database: Database,
): ModelSettingsStore {
  const vault = createCredentialStore(database);
  return {
    async read() {
      try {
        return await database.transaction(
          async (transaction) =>
            (await readSnapshot(transaction, "share"))?.snapshot ?? null,
        );
      } catch {
        throw new ModelSettingsStorageError();
      }
    },
    async update(change, actorUserId) {
      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtext(${SETTINGS_KEY}))`,
          );
          const current = await readSnapshot(transaction, "update");
          const next = await change(current?.snapshot ?? null);
          let credentialId: string | null = null;
          if (next.connection.useApiKey && next.encryptedApiKey) {
            if (
              current?.credentialId &&
              current.snapshot.connection.provider ===
                next.connection.provider &&
              current.snapshot.encryptedApiKey === next.encryptedApiKey
            ) {
              credentialId = current.credentialId;
            } else {
              const credential = {
                kind: "model" as const,
                provider: next.connection.provider,
                keyId: CREDENTIAL_KEY_ID,
                metadata: {},
                encryptedValue: next.encryptedApiKey,
              };
              const previous = await vault.findLiveByKey(
                credential,
                transaction as CredentialExecutor,
              );
              const stored = previous
                ? await vault.rotate(
                    { ...credential, previousCredentialId: previous.id },
                    transaction as CredentialExecutor,
                  )
                : await vault.create(
                    credential,
                    transaction as CredentialExecutor,
                  );
              credentialId = stored.id;
            }
          }
          if (
            current?.credentialId &&
            current.credentialId !== credentialId &&
            current.snapshot.encryptedApiKey &&
            current.snapshot.connection.provider !== next.connection.provider
          ) {
            await vault.revoke(
              current.credentialId,
              transaction as CredentialExecutor,
            );
          } else if (
            !next.connection.useApiKey &&
            current?.credentialId &&
            current.snapshot.encryptedApiKey
          ) {
            await vault.revoke(
              current.credentialId,
              transaction as CredentialExecutor,
            );
          }

          const currentPoolById = new Map(
            (current?.snapshot.pooledKeys ?? []).map((item) => [item.id, item]),
          );
          const storedPooledKeys: StoredPooledKey[] = [];
          const activePooledCredentialIds = new Set<string>();
          if (next.connection.useApiKey && next.pooledKeys) {
            for (const entry of next.pooledKeys) {
              const prevCredId = current?.pooledCredentialIds.get(entry.id);
              const prevEntry = currentPoolById.get(entry.id);
              if (
                prevCredId &&
                prevEntry &&
                current?.snapshot.connection.provider ===
                  next.connection.provider &&
                prevEntry.encryptedApiKey === entry.encryptedApiKey
              ) {
                storedPooledKeys.push({
                  id: entry.id,
                  label: entry.label,
                  credentialId: prevCredId,
                });
                activePooledCredentialIds.add(prevCredId);
              } else {
                const credential = {
                  kind: "model" as const,
                  provider: next.connection.provider,
                  keyId: pooledCredentialKeyId(entry.id),
                  metadata: { label: entry.label },
                  encryptedValue: entry.encryptedApiKey,
                };
                const previous = await vault.findLiveByKey(
                  credential,
                  transaction as CredentialExecutor,
                );
                const stored = previous
                  ? await vault.rotate(
                      { ...credential, previousCredentialId: previous.id },
                      transaction as CredentialExecutor,
                    )
                  : await vault.create(
                      credential,
                      transaction as CredentialExecutor,
                    );
                storedPooledKeys.push({
                  id: entry.id,
                  label: entry.label,
                  credentialId: stored.id,
                });
                activePooledCredentialIds.add(stored.id);
              }
            }
          }
          if (current?.pooledCredentialIds) {
            for (const oldCredId of current.pooledCredentialIds.values()) {
              if (!activePooledCredentialIds.has(oldCredId)) {
                await vault.revoke(
                  oldCredId,
                  transaction as CredentialExecutor,
                );
              }
            }
          }

          const value: StoredConnection = {
            version: 1,
            ...next.connection,
            credentialId,
            ...(storedPooledKeys.length > 0
              ? { pooledKeys: storedPooledKeys }
              : {}),
          };
          const updatedAt = new Date();
          await transaction
            .insert(enterpriseSettings)
            .values({
              key: SETTINGS_KEY,
              value,
              updatedBy: actorUserId ?? null,
              updatedAt,
            })
            .onConflictDoUpdate({
              target: enterpriseSettings.key,
              set: {
                value,
                updatedBy: actorUserId ?? null,
                updatedAt,
              },
            });
          return next;
        });
      } catch (error) {
        if (error instanceof ModelSettingsValidationError) throw error;
        // Drizzle errors can contain bound credential envelopes. Never expose their messages.
        throw new ModelSettingsStorageError();
      }
    },
  };
}

function configuration(input: ModelConnectionConfig): ModelConnectionConfig {
  return {
    provider: input.provider,
    model: input.model,
    baseUrl: normalizeModelBaseUrl(input.provider, input.baseUrl),
    useApiKey: input.useApiKey,
  };
}

function checkKeyReuse(
  input: ModelConnectionConfig,
  active: ModelConnectionConfig,
) {
  if (
    input.provider !== active.provider ||
    normalizeModelBaseUrl(input.provider, input.baseUrl) !==
      normalizeModelBaseUrl(active.provider, active.baseUrl)
  ) {
    throw new ModelSettingsValidationError(
      "更换接口协议或地址时，请填写对应的新 API Key，或选择不使用 API Key。",
    );
  }
}

export function withModelPoolStatus(
  proj: ModelConnectionProjection,
  keyPool: ModelKeyPool,
  poolId: string = modelPoolId(proj),
  now: number = Date.now(),
): ModelConnectionProjection {
  if (!proj.pooledKeys || proj.pooledKeys.length === 0) return proj;
  const statuses = keyPool.getPoolStatus(
    poolId,
    proj.pooledKeys.map((item) => ({ id: item.id, label: item.label })),
    now,
  );
  const byId = new Map(statuses.map((item) => [item.id, item]));
  return {
    ...proj,
    pooledKeys: proj.pooledKeys.map((item) => {
      const status = byId.get(item.id);
      if (!status) return item;
      return {
        id: item.id,
        label: item.label,
        hasApiKey: item.hasApiKey,
        healthy: status.healthy,
        cooldownUntil: status.cooldownUntil,
        ...(status.lastStatus !== undefined
          ? { lastStatus: status.lastStatus }
          : {}),
      };
    }),
  };
}

function projection(
  runtime: ModelConnectionConfig,
  hasApiKey: boolean,
  source: "saved" | "environment",
  pooledKeys?: ReadonlyArray<{ id: string; label: string }>,
): ModelConnectionProjection {
  const activePooled = runtime.useApiKey && pooledKeys ? pooledKeys : [];
  return {
    ...configuration(runtime),
    hasApiKey: runtime.useApiKey && (hasApiKey || activePooled.length > 0),
    source,
    ...(activePooled.length > 0
      ? {
          pooledKeys: activePooled.map((item) => ({
            id: item.id,
            label: item.label,
            hasApiKey: true,
            healthy: true,
            cooldownUntil: null,
          })),
        }
      : {}),
  };
}

function probeFailure(status: number, body?: unknown) {
  // Classify only documented error codes; upstream prose may contain request secrets.
  if (
    isObject(body) &&
    (body.code === "real_name_required" ||
      body.type === "real_name_required" ||
      (isObject(body.error) &&
        (body.error.code === "real_name_required" ||
          body.error.type === "real_name_required")))
  ) {
    return "模型服务要求账号完成实名认证，请在服务商平台完成认证后重试。（real_name_required）";
  }
  if (status === 401 || status === 403)
    return "认证失败，请检查 API Key 及接口访问权限。";
  if (status === 404) return "找不到模型接口或模型，请检查接口地址和模型名称。";
  if (status === 429)
    return "接口请求受限或额度不足，请检查账户额度并稍后重试。";
  if (status >= 500) return "模型服务暂时不可用，请稍后重试。";
  return "模型服务拒绝了请求，请检查协议、模型名称和接口地址。";
}

async function readProbeJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createModelSettingsService(options: {
  store: ModelSettingsStore;
  encryptionKey: string;
  fallback: Omit<ModelConnectionConfig, "useApiKey"> & { useApiKey?: boolean };
  fallbackApiKey: () => Promise<string | null>;
  fetch?: typeof fetch;
  keyPool?: ModelKeyPool;
  poolId?: string;
  now?: () => number;
  resolveCacheTtlMs?: number;
}): ModelSettingsService {
  const fallback = configuration(parseModelConnectionInput(options.fallback));
  const request = options.fetch ?? fetch;
  const nowFn = options.now ?? Date.now;
  const resolveCacheTtlMs =
    options.resolveCacheTtlMs ?? RESOLVE_CACHE_TTL_MS;
  let resolveGeneration = 0;
  let cachedResolve: {
    value: ModelConnectionRuntime;
    expiresAt: number;
    generation: number;
  } | null = null;
  let inflightResolve: {
    generation: number;
    promise: Promise<ModelConnectionRuntime>;
  } | null = null;
  function invalidateResolveCache() {
    resolveGeneration += 1;
    cachedResolve = null;
    inflightResolve = null;
  }
  function poolIdFor(
    connection: Pick<ModelConnectionConfig, "provider" | "baseUrl">,
  ) {
    return options.poolId ?? modelPoolId(connection);
  }
  function syncPoolFromRuntime(runtime: ModelConnectionRuntime) {
    if (!options.keyPool) return;
    const pid = poolIdFor(runtime);
    const poolKeys = buildConnectionPoolKeys(runtime);
    if (poolKeys.length > 0) {
      options.keyPool.setPool(pid, poolKeys);
    } else {
      options.keyPool.deletePool(pid);
    }
  }
  function projectWithPool(
    proj: ModelConnectionProjection,
  ): ModelConnectionProjection {
    if (!options.keyPool) return proj;
    return withModelPoolStatus(proj, options.keyPool, poolIdFor(proj), nowFn());
  }
  async function fallbackRuntime(): Promise<ModelConnectionRuntime> {
    return {
      ...fallback,
      apiKey: fallback.useApiKey ? await options.fallbackApiKey() : null,
      source: "environment",
    };
  }
  async function runtimeFrom(
    snapshot: ModelSettingsSnapshot,
  ): Promise<ModelConnectionRuntime> {
    try {
      const decryptPrimary =
        snapshot.connection.useApiKey && snapshot.encryptedApiKey
          ? decryptSecret(options.encryptionKey, snapshot.encryptedApiKey)
          : Promise.resolve(null);
      const decryptPooled =
        snapshot.connection.useApiKey && snapshot.pooledKeys?.length
          ? Promise.all(
              snapshot.pooledKeys.map(async (entry) => ({
                id: entry.id,
                label: entry.label,
                apiKey: await decryptSecret(
                  options.encryptionKey,
                  entry.encryptedApiKey,
                ),
              })),
            )
          : Promise.resolve<ModelConnectionPooledKeyRuntime[]>([]);
      const [apiKey, pooledKeys] = await Promise.all([
        decryptPrimary,
        decryptPooled,
      ]);
      return {
        ...configuration(snapshot.connection),
        source: "saved",
        apiKey,
        ...(pooledKeys.length > 0 ? { pooledKeys } : {}),
      };
    } catch {
      throw new ModelSettingsStorageError();
    }
  }
  async function resolve(): Promise<ModelConnectionRuntime> {
    const now = nowFn();
    if (
      resolveCacheTtlMs > 0 &&
      cachedResolve &&
      cachedResolve.generation === resolveGeneration &&
      now < cachedResolve.expiresAt
    ) {
      return cloneModelConnectionRuntime(cachedResolve.value);
    }
    const generation = resolveGeneration;
    if (inflightResolve && inflightResolve.generation === generation) {
      return cloneModelConnectionRuntime(await inflightResolve.promise);
    }
    const promise = (async () => {
      const saved = await options.store.read();
      const runtime = saved ? await runtimeFrom(saved) : await fallbackRuntime();
      syncPoolFromRuntime(runtime);
      if (resolveCacheTtlMs > 0 && resolveGeneration === generation) {
        cachedResolve = {
          value: cloneModelConnectionRuntime(runtime),
          expiresAt: nowFn() + resolveCacheTtlMs,
          generation,
        };
      }
      return runtime;
    })();
    inflightResolve = { generation, promise };
    try {
      return cloneModelConnectionRuntime(await promise);
    } finally {
      if (inflightResolve?.promise === promise) {
        inflightResolve = null;
      }
    }
  }
  return {
    resolve,
    async get() {
      const saved = await options.store.read();
      if (saved)
        return projectWithPool(
          projection(
            saved.connection,
            Boolean(saved.encryptedApiKey),
            "saved",
            saved.pooledKeys,
          ),
        );
      const current = await fallbackRuntime();
      return projectWithPool(
        projection(current, Boolean(current.apiKey), "environment"),
      );
    },
    async save(value, actorUserId) {
      const input = parseModelConnectionInput(value);
      // A fallback credential is read before the write opens a transaction. This remains safe with
      // a one-connection pool, unlike reading the vault on another connection while holding a lock.
      const previouslySaved =
        input.useApiKey && (!input.apiKey || input.pooledKeys !== undefined)
          ? await options.store.read()
          : null;
      const previousFallback =
        input.useApiKey && !input.apiKey && !previouslySaved
          ? await fallbackRuntime()
          : { ...fallback, apiKey: null };
      const encryptedNewKey = input.apiKey
        ? await encryptSecret(options.encryptionKey, input.apiKey)
        : null;
      const encryptedFallbackKey = previousFallback.apiKey
        ? await encryptSecret(options.encryptionKey, previousFallback.apiKey)
        : null;
      const preparedPooled =
        input.useApiKey && input.pooledKeys
          ? await Promise.all(
              input.pooledKeys.map(async (item) => {
                if (item.remove) {
                  return {
                    remove: true as const,
                    id: item.id,
                  };
                }
                return {
                  remove: false as const,
                  id: item.id ?? randomUUID(),
                  label: item.label,
                  encryptedApiKey: item.apiKey
                    ? await encryptSecret(options.encryptionKey, item.apiKey)
                    : null,
                };
              }),
            )
          : undefined;
      invalidateResolveCache();
      const saved = await options.store.update(async (current) => {
        const currentPoolById = new Map(
          (current?.pooledKeys ?? []).map((item) => [item.id, item]),
        );
        let resolvedPooled: ModelSettingsSnapshotPooledKey[] | undefined;
        if (!input.useApiKey) {
          resolvedPooled = undefined;
        } else if (preparedPooled !== undefined) {
          const nextEntries: ModelSettingsSnapshotPooledKey[] = [];
          const seenResolvedIds = new Set<string>();
          for (const item of preparedPooled) {
            if (item.remove) continue;
            if (seenResolvedIds.has(item.id)) {
              throw new ModelSettingsValidationError(
                "备选 API Key 标识不能重复。",
              );
            }
            seenResolvedIds.add(item.id);
            let encryptedPoolSecret = item.encryptedApiKey;
            if (!encryptedPoolSecret) {
              checkKeyReuse(input, current?.connection ?? previousFallback);
              encryptedPoolSecret =
                currentPoolById.get(item.id)?.encryptedApiKey ?? null;
              if (!encryptedPoolSecret) {
                throw new ModelSettingsValidationError(
                  "新增备选 API Key 时必须填写密钥，或确认要保留的 Key 标识存在。",
                );
              }
            }
            nextEntries.push({
              id: item.id,
              label: item.label,
              encryptedApiKey: encryptedPoolSecret,
            });
          }
          resolvedPooled = nextEntries;
        } else if (
          current?.pooledKeys &&
          current.pooledKeys.length > 0 &&
          current.connection.provider === input.provider &&
          normalizeModelBaseUrl(
            current.connection.provider,
            current.connection.baseUrl,
          ) === input.baseUrl
        ) {
          resolvedPooled = current.pooledKeys;
        }

        let encryptedApiKey = encryptedNewKey;
        if (input.useApiKey && !input.apiKey) {
          checkKeyReuse(input, current?.connection ?? previousFallback);
          encryptedApiKey = current
            ? current.encryptedApiKey
            : encryptedFallbackKey;
          if (
            !encryptedApiKey &&
            (!resolvedPooled || resolvedPooled.length === 0)
          )
            throw new ModelSettingsValidationError(
              "请填写 API Key，或选择不使用 API Key。",
            );
        }
        return {
          connection: configuration(input),
          encryptedApiKey: input.useApiKey ? encryptedApiKey : null,
          ...(resolvedPooled && resolvedPooled.length > 0
            ? { pooledKeys: resolvedPooled }
            : {}),
        };
      }, actorUserId);
      invalidateResolveCache();
      if (options.keyPool) {
        if (previouslySaved) {
          const oldPid = poolIdFor(previouslySaved.connection);
          const newPid = poolIdFor(saved.connection);
          if (oldPid !== newPid) {
            options.keyPool.deletePool(oldPid);
          }
        }
        syncPoolFromRuntime(await runtimeFrom(saved));
      }
      return projectWithPool(
        projection(
          saved.connection,
          Boolean(saved.encryptedApiKey),
          "saved",
          saved.pooledKeys,
        ),
      );
    },
    async test(value) {
      const input = parseModelConnectionInput(value);
      let apiKey =
        input.apiKey ??
        input.pooledKeys?.find((item) => !item.remove && item.apiKey)?.apiKey ??
        null;
      if (input.useApiKey && !apiKey) {
        const active = await resolve();
        checkKeyReuse(input, active);
        apiKey = active.apiKey ?? active.pooledKeys?.[0]?.apiKey ?? null;
        if (!apiKey)
          throw new ModelSettingsValidationError(
            "请填写 API Key，或选择不使用 API Key。",
          );
      }
      const start = performance.now();
      const finish = (
        ok: boolean,
        message: string,
      ): ModelConnectionTestResult => ({
        ok,
        message,
        latencyMs: Math.round(performance.now() - start),
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (input.provider === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        if (apiKey) headers["x-api-key"] = apiKey;
      } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const payload = {
        model: input.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        ...(input.provider === "openai" &&
        /^(?:gpt-5|o[134])(?:[-.]|$)/u.test(input.model)
          ? { max_completion_tokens: 128 }
          : { max_tokens: 32 }),
        stream: false,
      };
      try {
        const response = await request(
          `${input.baseUrl}/${input.provider === "anthropic" ? "messages" : "chat/completions"}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            redirect: "error",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          },
        );
        if (!response.ok) {
          let errorBody: unknown;
          try {
            errorBody = await readProbeJson(response);
          } catch {
            // Invalid, oversized or unreadable error bodies keep their safe HTTP classification.
          }
          return finish(false, probeFailure(response.status, errorBody));
        }
        let body: unknown;
        try {
          body = await readProbeJson(response);
        } catch {
          return finish(
            false,
            "接口返回格式不符合所选协议，请检查接口地址和协议。",
          );
        }
        const valid =
          isObject(body) &&
          (input.provider === "anthropic"
            ? body.type === "message" &&
              Array.isArray(body.content) &&
              body.content.length > 0 &&
              body.content.every(
                (block) =>
                  isObject(block) &&
                  ((block.type === "text" && typeof block.text === "string") ||
                    (block.type === "thinking" &&
                      typeof block.thinking === "string")),
              )
            : Array.isArray(body.choices) &&
              body.choices.length > 0 &&
              isObject(body.choices[0]) &&
              isObject(body.choices[0].message) &&
              (typeof body.choices[0].message.content === "string" ||
                typeof body.choices[0].message.reasoning_content === "string"));
        return valid
          ? finish(true, "连接成功，模型接口可以正常响应。")
          : finish(false, "接口返回格式不符合所选协议，请检查接口地址和协议。");
      } catch {
        return finish(
          false,
          "无法连接模型服务或请求超时，请检查地址、网络和服务状态。",
        );
      }
    },
  };
}
