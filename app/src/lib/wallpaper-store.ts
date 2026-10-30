/**
 * 自定义壁纸图片的持久化存储（IndexedDB）。
 *
 * 壁纸是几 MB 的 Data URL，放进 localStorage 很容易超出配额（约 5 MB），
 * 超限后写入会被静默吞掉，刷新后壁纸就没了。所以图片数据统一存在 IndexedDB，
 * localStorage 里只留一个占位标记 {@link WALLPAPER_IDB_MARKER}。
 *
 * 后端可以替换（测试注入内存实现）；浏览器里默认用 IndexedDB。
 */

export const WALLPAPER_IDB_MARKER = "idb:custom-wallpaper";

const DB_NAME = "chisabot-appearance";
const STORE_NAME = "wallpaper";
const RECORD_KEY = "custom";

export type WallpaperBackend = {
  get(): Promise<string | null>;
  put(dataUrl: string): Promise<void>;
  remove(): Promise<void>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("打开 IndexedDB 失败"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = run(tx.objectStore(STORE_NAME));
      let value: T | undefined;
      if (req)
        req.onsuccess = () => {
          value = req.result as T;
        };
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
      tx.onabort = () =>
        reject(
          tx.error ?? new Error("IndexedDB 事务被中止（可能超出存储配额）"),
        );
    });
  } finally {
    db.close();
  }
}

export const indexedDbWallpaperBackend: WallpaperBackend = {
  async get() {
    const v = await withStore<unknown>("readonly", (s) => s.get(RECORD_KEY));
    return typeof v === "string" && v ? v : null;
  },
  async put(dataUrl) {
    await withStore("readwrite", (s) => s.put(dataUrl, RECORD_KEY));
  },
  async remove() {
    await withStore("readwrite", (s) => s.delete(RECORD_KEY));
  },
};

let backend: WallpaperBackend = indexedDbWallpaperBackend;

export function getWallpaperBackend(): WallpaperBackend {
  return backend;
}

/** 测试用：替换存储后端，返回原来的后端。 */
export function setWallpaperBackend(next: WallpaperBackend): WallpaperBackend {
  const prev = backend;
  backend = next;
  return prev;
}
