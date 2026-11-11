import {
  classifyAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "@/lib/channels/attachments";
import type { Attachment } from "./attachment-state";
import { DRAFT_TTL_MS, type DraftFileSubmission } from "./ui-memory";

export type PersistedDraftFile = {
  id: string;
  file: File;
  attachment?: Attachment;
  submission?: DraftFileSubmission;
};

export type DraftAttachmentSnapshot = {
  files: PersistedDraftFile[];
  at: number;
};

type StoredDraft = DraftAttachmentSnapshot & {
  key: string;
  accountId: string;
};

const DB_NAME = "chisabot-chat-drafts";
const STORE_NAME = "attachments";
const ACCOUNT_TIME_INDEX = "account-time";
const MAX_DRAFT_FILE_THREADS = 12;
const pending = new Map<string, Promise<unknown>>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不能保存附件草稿，刷新后附件将丢失。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, {
        keyPath: "key",
      });
      store.createIndex(ACCOUNT_TIME_INDEX, ["accountId", "at"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开附件草稿存储。"));
  });
}

/** Serialize account writes and reads, including retention, in their call order. */
function inOrder<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(accountId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(work);
  pending.set(accountId, operation);
  void operation
    .finally(() => {
      if (pending.get(accountId) === operation) pending.delete(accountId);
    })
    .catch(() => undefined);
  return operation;
}

function keyOf(accountId: string, draftKey: string): string {
  if (!accountId || !draftKey) throw new Error("附件草稿缺少账号或对话。");
  return JSON.stringify([accountId, draftKey]);
}

/** Visit only index keys: pruning never reads or copies the stored file blobs. */
function prune(
  store: IDBObjectStore,
  accountId: string,
  at: number,
  complete: () => void = () => {},
): void {
  const range = IDBKeyRange.bound(
    [accountId, 0],
    [accountId, Number.MAX_SAFE_INTEGER],
  );
  const cursor = store.index(ACCOUNT_TIME_INDEX).openKeyCursor(range, "prev");
  let kept = 0;
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) {
      complete();
      return;
    }
    const storedAt = (row.key as [string, number])[1];
    if (at - storedAt > DRAFT_TTL_MS || kept >= MAX_DRAFT_FILE_THREADS) {
      store.delete(row.primaryKey);
    } else {
      kept += 1;
    }
    row.continue();
  };
}

async function transact<T>(
  operation: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const database = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      let value!: T;
      operation(transaction.objectStore(STORE_NAME), (next) => {
        value = next;
      });
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("附件草稿保存失败。"));
      transaction.onabort = () =>
        reject(
          transaction.error ??
            new Error("附件草稿保存中止，请检查浏览器存储空间。"),
        );
    });
  } finally {
    database.close();
  }
}

/** Original files stay local; account and conversation form the complete key. */
export async function writeDraftAttachments(
  accountId: string,
  draftKey: string,
  files: readonly PersistedDraftFile[],
): Promise<void> {
  const key = keyOf(accountId, draftKey);
  // Sending keeps its files until admission while the next draft remains editable.
  const limit = MAX_ATTACHMENTS_PER_MESSAGE * 2;
  if (files.length > limit) {
    throw new Error(`当前与发送中的附件草稿最多保存 ${limit} 个文件。`);
  }
  for (const { file } of files) {
    const limit =
      classifyAttachment(file.type) === "text"
        ? MAX_FILE_BYTES
        : MAX_IMAGE_BYTES;
    if (file.size > limit) {
      throw new Error(`附件“${file.name}”超过保存上限。`);
    }
  }
  // Snapshot metadata now, before an older IndexedDB operation finishes.
  const snapshot = files.map(({ id, file, attachment, submission }) => ({
    id,
    file,
    ...(attachment ? { attachment: structuredClone(attachment) } : {}),
    ...(submission ? { submission: { ...submission } } : {}),
  }));
  const at = Date.now();
  return inOrder(accountId, () =>
    transact<void>((store, done) => {
      if (snapshot.length) {
        store.put({
          key,
          accountId,
          at,
          files: snapshot,
        } satisfies StoredDraft);
      } else {
        store.delete(key);
      }
      prune(store, accountId, at);
      done(undefined);
    }),
  );
}

/** Does not consume the draft: only acceptance/removal may clear its files. */
export async function readDraftAttachments(
  accountId: string,
  draftKey: string,
): Promise<DraftAttachmentSnapshot | null> {
  const key = keyOf(accountId, draftKey);
  return inOrder(accountId, () =>
    transact<DraftAttachmentSnapshot | null>((store, done) => {
      const at = Date.now();
      prune(store, accountId, at, () => {
        const request = store.get(key);
        request.onsuccess = () => {
          const row = request.result as StoredDraft | undefined;
          done(row ? { files: row.files, at: row.at } : null);
        };
      });
    }),
  );
}
