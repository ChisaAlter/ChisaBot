import type { Database } from "../db/client";
import { CHAT_FILE_URL_PREFIX, CHAT_FILES_MARKER } from "../../../shared/chat-files";
import { type ImageDims, imageSize } from "./image-size";

export { imageSize, type ImageDims } from "./image-size";

/**
 * 图片宽高（DESIGN.md §83.2）：存图 / 生成图 / 转存链接预览图的时候顺手读出宽高，记在 `chisabot_image_dims`；
 * 读对话（存储读取、接入回放）时把宽高写进消息里的图片：
 * - 用户附件 / 聊天上传：图片 part 的 `metadata.width` / `metadata.height`（`metadata` 是 AG-UI 的 unknown，原样保留）；
 * - 机器人画的图、file_share 的图：工具结果末行 `⟦chisabot:files⟧[…]` 里每一项加 `width` / `height`；
 * - 链接预览：`/api/link-preview` 的回答加 `imageWidth` / `imageHeight`。
 * 网页据此先按宽高比留出框，图片晚到也不会把下面的消息推开。
 *
 * 只加不改：一张独立的小表（不动 attachments / chisabot_chat_files 的结构），旧客户端不看这些字段。
 * 以前存的图没有记录：第一次读到时从原表读文件头（前 256 KB，不够再读整张）算出来存上，以后直接查表。
 * 读不出来的记成 0×0，不再重算，也不往外给。
 *
 * 键：`a:<附件 uuid>`、`cf:<聊天文件 id>`、`lp:<链接预览资源 id>`。
 */

const HEAD_BYTES = 256 * 1024;
/** 一次读对话最多现算多少张旧图（每张一次小查询）；剩下的下次再算。 */
const LAZY_PER_CALL = 64;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSET = /^[a-f0-9]{40}$/;
const ATTACHMENT_PREFIX = "/api/attachments/";
const ASSET_PREFIX = "/api/link-preview/asset/";

/** 本站图片地址 → 键；不是本站认识的图片地址返回 null。 */
export function imageKeyForUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const path = url.split(/[?#]/)[0] ?? "";
  if (path.startsWith(ATTACHMENT_PREFIX)) {
    const id = path.slice(ATTACHMENT_PREFIX.length);
    return UUID.test(id) ? `a:${id.toLowerCase()}` : null;
  }
  if (path.startsWith(CHAT_FILE_URL_PREFIX)) {
    const id = path.slice(CHAT_FILE_URL_PREFIX.length);
    return UUID.test(id) ? `cf:${id.toLowerCase()}` : null;
  }
  if (path.startsWith(ASSET_PREFIX)) {
    const id = path.slice(ASSET_PREFIX.length);
    return ASSET.test(id) ? `lp:${id}` : null;
  }
  return null;
}

type Row = { id: string; head: Uint8Array | null; size: number | null };

const SOURCES: Record<string, { head: string; full: string }> = {
  a: {
    head: `SELECT id::text AS id, substring(bytes from 1 for ${HEAD_BYTES}) AS head, size_bytes AS size FROM attachments WHERE id::text = ANY(string_to_array($1, ',')) AND mime_type LIKE 'image/%'`,
    full: "SELECT bytes AS head FROM attachments WHERE id::text = $1",
  },
  cf: {
    head: `SELECT id, substring(bytes from 1 for ${HEAD_BYTES}) AS head, size_bytes AS size FROM chisabot_chat_files WHERE id = ANY(string_to_array($1, ',')) AND mime_type LIKE 'image/%'`,
    full: "SELECT bytes AS head FROM chisabot_chat_files WHERE id = $1",
  },
  lp: {
    head: `SELECT id, substring(data from 1 for ${HEAD_BYTES}) AS head, length(data) AS size FROM chisabot_link_preview_assets WHERE id = ANY(string_to_array($1, ','))`,
    full: "SELECT data AS head FROM chisabot_link_preview_assets WHERE id = $1",
  },
};

export type ImageDimsStore = ReturnType<typeof createImageDims>;

export function createImageDims(database: Database) {
  const sql = database.$client;
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= sql
      .unsafe(`CREATE TABLE IF NOT EXISTS chisabot_image_dims (
        key text PRIMARY KEY,
        width integer NOT NULL,
        height integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      .then(() => undefined)
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
    return ready;
  };

  async function save(entries: readonly [string, ImageDims | null][]) {
    if (entries.length === 0) return;
    await ensure();
    await sql.unsafe(
      `INSERT INTO chisabot_image_dims (key, width, height)
       SELECT * FROM unnest(string_to_array($1, ','), string_to_array($2, ',')::int[], string_to_array($3, ',')::int[])
       ON CONFLICT (key) DO UPDATE SET width = EXCLUDED.width, height = EXCLUDED.height`,
      [entries.map(([key]) => key).join(","), entries.map(([, d]) => d?.width ?? 0).join(","), entries.map(([, d]) => d?.height ?? 0).join(",")],
    );
  }

  /** 存图的时候调用：读出宽高、记下、返回（不是图片 / 读不出返回 null）。永不抛错。 */
  async function remember(key: string, bytes: Uint8Array): Promise<ImageDims | null> {
    const dims = imageSize(bytes);
    try {
      await save([[key, dims]]);
    } catch (error) {
      console.error(JSON.stringify({ type: "image-dims-save-failed", error: error instanceof Error ? error.name : "UnknownError" }));
    }
    return dims;
  }

  /** 旧图：从原表读文件头算出来。 */
  async function compute(keys: readonly string[]): Promise<Map<string, ImageDims | null>> {
    const out = new Map<string, ImageDims | null>();
    const byKind = new Map<string, string[]>();
    for (const key of keys.slice(0, LAZY_PER_CALL)) {
      const at = key.indexOf(":");
      const kind = key.slice(0, at);
      if (!SOURCES[kind]) continue;
      byKind.set(kind, [...(byKind.get(kind) ?? []), key.slice(at + 1)]);
    }
    for (const [kind, ids] of byKind) {
      const source = SOURCES[kind];
      if (!source) continue;
      let rows: Row[] = [];
      try {
        rows = await sql.unsafe<Row[]>(source.head, [ids.join(",")]);
      } catch {
        continue; // 表不存在（测试库、没开的功能）：这一类先不算
      }
      // 没有这一行（删了 / 不是图片）：记成读不出，下次不再查。
      for (const id of ids) out.set(`${kind}:${id}`, null);
      for (const row of rows) {
        const head = row.head ? new Uint8Array(row.head) : new Uint8Array();
        let dims = imageSize(head);
        if (!dims && row.size !== null && Number(row.size) > head.length) {
          const full = await sql.unsafe<{ head: Uint8Array }[]>(source.full, [row.id]).catch(() => []);
          if (full[0]?.head) dims = imageSize(new Uint8Array(full[0].head));
        }
        out.set(`${kind}:${kind === "lp" ? row.id : row.id.toLowerCase()}`, dims);
      }
    }
    return out;
  }

  /** 这些键的宽高（只回有的）。缺的现算并存上。出错返回空表——读对话不能因为它失败。 */
  async function lookup(keys: Iterable<string>): Promise<Map<string, ImageDims>> {
    const wanted = [...new Set(keys)];
    const found = new Map<string, ImageDims>();
    if (wanted.length === 0) return found;
    try {
      await ensure();
      const rows = await sql.unsafe<{ key: string; width: number; height: number }[]>(
        "SELECT key, width, height FROM chisabot_image_dims WHERE key = ANY(string_to_array($1, ','))",
        [wanted.join(",")],
      );
      const known = new Set<string>();
      for (const row of rows) {
        known.add(row.key);
        if (row.width > 0 && row.height > 0) found.set(row.key, { width: row.width, height: row.height });
      }
      const missing = wanted.filter((key) => !known.has(key));
      if (missing.length > 0) {
        const computed = await compute(missing);
        await save([...computed]);
        for (const [key, dims] of computed) if (dims) found.set(key, dims);
      }
    } catch (error) {
      console.error(JSON.stringify({ type: "image-dims-lookup-failed", error: error instanceof Error ? error.name : "UnknownError" }));
    }
    return found;
  }

  /** 给一批消息里的图片写上宽高。不改传进来的对象。 */
  async function annotateMessages<T>(messages: readonly T[]): Promise<T[]> {
    const keys = new Set<string>();
    for (const message of messages) collectFromMessage(message, keys);
    if (keys.size === 0) return [...messages];
    const dims = await lookup(keys);
    if (dims.size === 0) return [...messages];
    return messages.map((message) => withDims(message, dims));
  }

  /** 接入回放的事件：RUN_STARTED.input.messages、MESSAGES_SNAPSHOT.messages、TOOL_CALL_RESULT.content。 */
  async function annotateEvents<T>(events: readonly T[]): Promise<T[]> {
    const keys = new Set<string>();
    for (const event of events) collectFromEvent(event, keys);
    if (keys.size === 0) return [...events];
    const dims = await lookup(keys);
    if (dims.size === 0) return [...events];
    return events.map((event) => eventWithDims(event, dims));
  }

  return { ensure, remember, lookup, annotateMessages, annotateEvents };
}

/** 同一个数据库一份（各处直接取，不用在 index.ts 里层层传）。 */
const stores = new WeakMap<object, ImageDimsStore>();
export function imageDimsFor(database: Database): ImageDimsStore {
  let store = stores.get(database);
  if (!store) {
    store = createImageDims(database);
    stores.set(database, store);
  }
  return store;
}

// ------------------------------------------------------------------ 消息 / 事件里找图、写宽高（纯函数，测试直接用）

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null;

function partKey(part: unknown): string | null {
  if (!isRec(part) || !isRec(part.source) || part.source.type !== "url") return null;
  return imageKeyForUrl(part.source.value);
}

/** 工具结果的文本（可能被 AG-UI 再 JSON 编码一次）里的文件清单。 */
function markerFiles(content: unknown): { files: Rec[]; rebuild: (files: Rec[]) => string } | null {
  if (typeof content !== "string" || !content.includes(CHAT_FILES_MARKER)) return null;
  let text = content;
  let wrapped = false;
  const trimmed = content.trim();
  if (trimmed.startsWith('"')) {
    try {
      const inner = JSON.parse(trimmed) as unknown;
      if (typeof inner === "string") {
        text = inner;
        wrapped = true;
      }
    } catch {}
  }
  const at = text.lastIndexOf(CHAT_FILES_MARKER);
  if (at < 0) return null;
  let files: unknown;
  try {
    files = JSON.parse(text.slice(at + CHAT_FILES_MARKER.length).trim());
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;
  const head = text.slice(0, at + CHAT_FILES_MARKER.length);
  return {
    files: files.filter(isRec),
    rebuild: (next) => {
      const rebuilt = `${head}${JSON.stringify(next)}`;
      return wrapped ? JSON.stringify(rebuilt) : rebuilt;
    },
  };
}

function collectFromContent(content: unknown, keys: Set<string>) {
  if (Array.isArray(content)) {
    for (const part of content) {
      const key = partKey(part);
      if (key) keys.add(key);
    }
    return;
  }
  const marker = markerFiles(content);
  if (marker) for (const file of marker.files) {
    const key = imageKeyForUrl(file.url);
    if (key) keys.add(key);
  }
}

export function collectFromMessage(message: unknown, keys: Set<string>) {
  if (isRec(message)) collectFromContent(message.content, keys);
}

export function collectFromEvent(event: unknown, keys: Set<string>) {
  if (!isRec(event)) return;
  if (isRec(event.input) && Array.isArray(event.input.messages)) for (const m of event.input.messages) collectFromMessage(m, keys);
  if (Array.isArray(event.messages)) for (const m of event.messages) collectFromMessage(m, keys);
  if (typeof event.content === "string") collectFromContent(event.content, keys);
}

function contentWithDims(content: unknown, dims: ReadonlyMap<string, ImageDims>): unknown {
  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((part) => {
      const key = partKey(part);
      const size = key ? dims.get(key) : undefined;
      if (!size || !isRec(part)) return part;
      const metadata = isRec(part.metadata) ? part.metadata : {};
      if (metadata.width === size.width && metadata.height === size.height) return part;
      changed = true;
      return { ...part, metadata: { ...metadata, width: size.width, height: size.height } };
    });
    return changed ? next : content;
  }
  const marker = markerFiles(content);
  if (!marker) return content;
  let changed = false;
  const files = marker.files.map((file) => {
    const key = imageKeyForUrl(file.url);
    const size = key ? dims.get(key) : undefined;
    if (!size || (file.width === size.width && file.height === size.height)) return file;
    changed = true;
    return { ...file, width: size.width, height: size.height };
  });
  return changed ? marker.rebuild(files) : content;
}

export function withDims<T>(message: T, dims: ReadonlyMap<string, ImageDims>): T {
  if (!isRec(message)) return message;
  const content = contentWithDims(message.content, dims);
  return content === message.content ? message : ({ ...message, content } as T);
}

export function eventWithDims<T>(event: T, dims: ReadonlyMap<string, ImageDims>): T {
  if (!isRec(event)) return event;
  let next: Rec = event;
  if (isRec(event.input) && Array.isArray(event.input.messages)) {
    const messages = event.input.messages.map((m) => withDims(m, dims));
    if (messages.some((m, i) => m !== (event.input as Rec & { messages: unknown[] }).messages[i])) next = { ...next, input: { ...event.input, messages } };
  }
  if (Array.isArray(event.messages)) {
    const messages = event.messages.map((m) => withDims(m, dims));
    if (messages.some((m, i) => m !== (event.messages as unknown[])[i])) next = { ...next, messages };
  }
  if (typeof event.content === "string") {
    const content = contentWithDims(event.content, dims);
    if (content !== event.content) next = { ...next, content };
  }
  return next as T;
}
