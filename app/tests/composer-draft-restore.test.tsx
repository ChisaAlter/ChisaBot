import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { Composer } from "@/components/channels/composer/composer";
import {
  type PersistedDraftFile,
  readDraftAttachments,
  writeDraftAttachments,
} from "@/lib/chat/draft-attachment-store";
import {
  draftFilesAccepted,
  resetUiMemory,
  setDraftFileAccount,
} from "@/lib/chat/ui-memory";
import { installFetchBackedXhr } from "./fetch-backed-xhr";
import { settleReactWork } from "./settle-react-work";

/**
 * 内存 IndexedDB 桩：只实现 `draft-attachment-store.ts` 用到的子集，避免使用被门禁禁止的
 * `mock.module`，同时允许测试暂停 `store.get` 来稳定复现恢复期间并发选文件的竞态。
 */
function createMemoryIdb() {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  let holdGet: (() => Promise<void>) | null = null;

  function makeBound(lower: unknown[], upper: unknown[]) {
    return { lower, upper };
  }

  function compareTuple(a: unknown[], b: unknown[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] as string | number;
      const bv = b[i] as string | number;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  }

  const factory = {
    open(name: string) {
      const req: {
        result: unknown;
        error: Error | null;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        const isNew = !stores.has(name);
        if (isNew) stores.set(name, new Map());
        const createdStores = new Map<
          string,
          { keyPath: string; indexKeyPath?: [string, string] }
        >();
        const db = {
          createObjectStore(storeName: string, opts: { keyPath: string }) {
            const key = `${name}:${storeName}`;
            if (!stores.has(key)) stores.set(key, new Map());
            const meta: {
              keyPath: string;
              indexKeyPath?: [string, string];
            } = { keyPath: opts.keyPath };
            createdStores.set(storeName, meta);
            return {
              createIndex(_indexName: string, keyPath: [string, string]) {
                meta.indexKeyPath = keyPath;
              },
            };
          },
          transaction(storeName: string) {
            const tableKey = `${name}:${storeName}`;
            let table = stores.get(tableKey);
            if (!table) {
              table = new Map();
              stores.set(tableKey, table);
            }
            let pendingOps = 0;
            const tx: {
              oncomplete: (() => void) | null;
              onerror: (() => void) | null;
              onabort: (() => void) | null;
              error: Error | null;
              objectStore: (s: string) => unknown;
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore: () => storeApi,
            };

            const finishOp = () => {
              pendingOps--;
              if (pendingOps === 0) {
                queueMicrotask(() => tx.oncomplete?.());
              }
            };

            const scheduleOp = (work: () => void | Promise<void>) => {
              pendingOps++;
              queueMicrotask(async () => {
                await work();
                finishOp();
              });
            };

            const storeApi = {
              put(value: Record<string, unknown>) {
                table.set(String(value.key), value);
              },
              delete(key: string) {
                table.delete(String(key));
              },
              get(key: string) {
                const getReq: {
                  result: unknown;
                  onsuccess: (() => void) | null;
                } = {
                  result: undefined,
                  onsuccess: null,
                };
                scheduleOp(async () => {
                  if (holdGet) await holdGet();
                  getReq.result = table.get(String(key));
                  getReq.onsuccess?.();
                });
                return getReq;
              },
              index() {
                return {
                  openKeyCursor(range: { lower: unknown[]; upper: unknown[] }) {
                    const cursorReq: {
                      result: {
                        key: [string, number];
                        primaryKey: string;
                        continue: () => void;
                      } | null;
                      onsuccess: (() => void) | null;
                    } = {
                      result: null,
                      onsuccess: null,
                    };
                    const entries = [...table.values()]
                      .map((row) => ({
                        primaryKey: String(row.key),
                        key: [String(row.accountId), Number(row.at)] as [
                          string,
                          number,
                        ],
                      }))
                      .filter(
                        (item) =>
                          compareTuple(item.key, range.lower) >= 0 &&
                          compareTuple(item.key, range.upper) <= 0,
                      )
                      .sort((a, b) => compareTuple(b.key, a.key));
                    let idx = 0;
                    const step = () => {
                      scheduleOp(() => {
                        if (idx >= entries.length) {
                          cursorReq.result = null;
                          cursorReq.onsuccess?.();
                          return;
                        }
                        const current = entries[idx++];
                        cursorReq.result = {
                          key: current.key,
                          primaryKey: current.primaryKey,
                          continue: step,
                        };
                        cursorReq.onsuccess?.();
                      });
                    };
                    step();
                    return cursorReq;
                  },
                };
              },
            };
            // 确保即使同步调用 put/delete 也会在微任务后完成事务
            scheduleOp(() => {});
            return tx;
          },
          close() {},
        };
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };

  return {
    factory,
    keyRange: { bound: makeBound },
    clear() {
      stores.clear();
      holdGet = null;
    },
    setHoldGet(fn: (() => Promise<void>) | null) {
      holdGet = fn;
    },
  };
}

const memoryIdb = createMemoryIdb();
let originalIndexedDb: unknown;
let originalIdbKeyRange: unknown;
const originalFetch = globalThis.fetch;

type UploadAnswer =
  | number
  | { status: number; body?: unknown }
  | Promise<Response>;

let uploadAnswers: UploadAnswer[];
let uploadedFiles: string[];
let headHandler: (path: string) => Response | Promise<Response>;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  installFetchBackedXhr();
  originalIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
  originalIdbKeyRange = (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: memoryIdb.factory,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: memoryIdb.keyRange,
  });
});

afterAll(async () => {
  await settleReactWork();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: originalIndexedDb,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    configurable: true,
    value: originalIdbKeyRange,
  });
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  memoryIdb.clear();
  resetUiMemory();
  window.localStorage.clear();
  setDraftFileAccount("acc-1");
  uploadAnswers = [];
  uploadedFiles = [];
  headHandler = () =>
    new Response(null, {
      status: 200,
      headers: { "X-ChisaBot-Attachment-State": "staged" },
    });
  installFetchBackedXhr();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost",
    );
    if (init?.method === "HEAD") {
      return await headHandler(url.pathname);
    }
    if (init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (/\/api\/channels\/[^/]+\/attachments$/.test(url.pathname)) {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      uploadedFiles.push(file.name);
      const next = uploadAnswers.shift() ?? 201;
      if (next instanceof Promise) return await next;
      if (typeof next === "object") {
        return new Response(JSON.stringify(next.body ?? {}), {
          status: next.status,
          headers: { "content-type": "application/json" },
        });
      }
      if (next !== 201) {
        return new Response(JSON.stringify({ error: `上传失败(${next})` }), {
          status: next,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json(
        {
          id: `att-${uploadedFiles.length}`,
          name: file.name,
          mimeType: file.type || "image/png",
        },
        { status: 201 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  memoryIdb.setHoldGet(null);
  setDraftFileAccount(null);
  globalThis.fetch = originalFetch;
});

function pickFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  fireEvent.change(input);
}

function png(name = "image.png") {
  return new File(["png-bytes"], name, { type: "image/png" });
}

test("(a1) 上传失败持久化 failedReason，重挂载恢复显示真实失败原因而非“上传尚未完成，点击重试。”", async () => {
  uploadAnswers = [{ status: 500, body: { error: "图片解码失败" } }];
  const first = render(
    <Composer channelId="ch-1" compact draftKey="ch-1" onSubmit={() => {}} />,
  );

  pickFiles(first.container, [png("broken.png")]);
  await waitFor(() => expect(first.getByText("图片解码失败")).toBeTruthy());

  // 等待 IndexedDB 异步写入完成
  await waitFor(async () => {
    const saved = await readDraftAttachments("acc-1", "ch-1");
    expect(saved?.files.length).toBe(1);
    expect(saved?.files[0]?.failedReason).toBe("图片解码失败");
  });

  first.unmount();

  const second = render(
    <Composer channelId="ch-1" compact draftKey="ch-1" onSubmit={() => {}} />,
  );
  await waitFor(() => expect(second.getByText("图片解码失败")).toBeTruthy());
  expect(second.queryByText("上传尚未完成，点击重试。")).toBeNull();
});

test("(a2) 真正中断的草稿与服务端 404 失效的草稿分别显示准确文案", async () => {
  const interruptedEntry: PersistedDraftFile = {
    id: "interrupted-1",
    file: png("interrupted.png"),
  };
  const missingEntry: PersistedDraftFile = {
    id: "missing-1",
    file: png("missing.png"),
    attachment: {
      id: "sdk-missing-1",
      type: "image",
      filename: "missing.png",
      status: "ready",
      source: {
        type: "url",
        value: "/api/attachments/srv-missing",
        mimeType: "image/png",
      },
      metadata: { attachmentId: "srv-missing", filename: "missing.png" },
    },
  };
  await writeDraftAttachments("acc-1", "ch-2", [
    interruptedEntry,
    missingEntry,
  ]);
  headHandler = () => new Response(null, { status: 404 });

  const view = render(
    <Composer channelId="ch-2" compact draftKey="ch-2" onSubmit={() => {}} />,
  );

  await waitFor(() => {
    expect(view.getByText("上传尚未完成，点击重试。")).toBeTruthy();
    expect(view.getByText("附件已失效，点击重试。")).toBeTruthy();
  });
});

test("(b1) 对“上传尚未完成”、失效附件和失败上传点击重试均可重新上传成功", async () => {
  const interruptedEntry: PersistedDraftFile = {
    id: "int-1",
    file: png("int.png"),
  };
  const failedEntry: PersistedDraftFile = {
    id: "fail-1",
    file: png("fail.png"),
    failedReason: "服务端暂时不可用",
  };
  const missingEntry: PersistedDraftFile = {
    id: "miss-1",
    file: png("miss.png"),
    attachment: {
      id: "sdk-miss-1",
      type: "image",
      filename: "miss.png",
      status: "ready",
      source: {
        type: "url",
        value: "/api/attachments/srv-miss",
        mimeType: "image/png",
      },
      metadata: { attachmentId: "srv-miss", filename: "miss.png" },
    },
  };
  await writeDraftAttachments("acc-1", "ch-3", [
    interruptedEntry,
    failedEntry,
    missingEntry,
  ]);
  headHandler = () => new Response(null, { status: 404 });
  uploadAnswers = [201, 201, 201];

  const view = render(
    <Composer channelId="ch-3" compact draftKey="ch-3" onSubmit={() => {}} />,
  );

  await waitFor(() => {
    expect(view.getByLabelText("重试上传 int.png")).toBeTruthy();
    expect(view.getByLabelText("重试上传 fail.png")).toBeTruthy();
    expect(view.getByLabelText("重试上传 miss.png")).toBeTruthy();
  });

  await act(async () => {
    fireEvent.click(view.getByLabelText("重试上传 int.png"));
    fireEvent.click(view.getByLabelText("重试上传 fail.png"));
    fireEvent.click(view.getByLabelText("重试上传 miss.png"));
  });

  await waitFor(() => {
    expect(view.queryByLabelText("移除 int.png")).not.toBeNull();
    expect(view.queryByLabelText("移除 fail.png")).not.toBeNull();
    expect(view.queryByLabelText("移除 miss.png")).not.toBeNull();
  });
  expect(uploadedFiles).toEqual(["int.png", "fail.png", "miss.png"]);

  const persisted = await readDraftAttachments("acc-1", "ch-3");
  expect(persisted?.files.length).toBe(3);
  expect(persisted?.files.every((f) => f.attachment && !f.failedReason)).toBe(
    true,
  );
});

test("(b2) disabled 时点击重试不会静默删掉失败卡片或本地草稿", async () => {
  uploadAnswers = [{ status: 500, body: { error: "临时网络错误" } }];
  const view = render(
    <Composer channelId="ch-4" compact draftKey="ch-4" onSubmit={() => {}} />,
  );

  pickFiles(view.container, [png("keep-me.png")]);
  await waitFor(() => expect(view.getByText("临时网络错误")).toBeTruthy());

  // 变为 disabled 后点重试
  view.rerender(
    <Composer
      channelId="ch-4"
      compact
      disabled
      draftKey="ch-4"
      onSubmit={() => {}}
    />,
  );

  await act(async () => {
    fireEvent.click(view.getByLabelText("重试上传 keep-me.png"));
  });

  expect(view.getByLabelText("重试上传 keep-me.png")).toBeTruthy();
  expect(view.getByText("临时网络错误")).toBeTruthy();
  expect(uploadedFiles).toEqual(["keep-me.png"]);

  const persisted = await readDraftAttachments("acc-1", "ch-4");
  expect(persisted?.files.length).toBe(1);
  expect(persisted?.files[0]?.file.name).toBe("keep-me.png");
});

test("(c1) 草稿恢复进行中选入新文件不会擦除 IndexedDB 已有附件，且两者都保留", async () => {
  const existingEntry: PersistedDraftFile = {
    id: "old-1",
    file: png("old.png"),
    attachment: {
      id: "sdk-old-1",
      type: "image",
      filename: "old.png",
      status: "ready",
      source: {
        type: "url",
        value: "/api/attachments/srv-old-1",
        mimeType: "image/png",
      },
      metadata: { attachmentId: "srv-old-1", filename: "old.png" },
    },
  };
  await writeDraftAttachments("acc-1", "ch-5", [existingEntry]);

  let releaseHead: () => void = () => {};
  const headGate = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  headHandler = async () => {
    await headGate;
    return new Response(null, {
      status: 200,
      headers: { "X-ChisaBot-Attachment-State": "staged" },
    });
  };
  uploadAnswers = [201];

  const view = render(
    <Composer
      channelId="ch-5"
      chatFileAgentId={null}
      compact
      draftKey="ch-5"
      onSubmit={() => {}}
      queuedAttachmentCount={0}
    />,
  );

  // 等待 HEAD 请求发出（此时恢复正在进行中）
  await waitFor(() =>
    expect(view.container.querySelector("form")).toBeTruthy(),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });

  // 恢复尚未完成时：变更 queuedAttachmentCount / chatFileAgentId 并附加新文件
  view.rerender(
    <Composer
      channelId="ch-5"
      chatFileAgentId="agent-1"
      compact
      draftKey="ch-5"
      onSubmit={() => {}}
      queuedAttachmentCount={1}
    />,
  );
  pickFiles(view.container, [png("new.png")]);

  await waitFor(() =>
    expect(view.queryByLabelText("移除 new.png")).not.toBeNull(),
  );

  // 即使在恢复完成前查看 IndexedDB，old.png 也未被擦除
  const mid = await readDraftAttachments("acc-1", "ch-5");
  expect(mid?.files.map((f) => f.file.name).sort()).toEqual([
    "new.png",
    "old.png",
  ]);

  // 放行 HEAD，恢复完成
  releaseHead();
  await waitFor(() => {
    expect(view.queryByLabelText("移除 old.png")).not.toBeNull();
    expect(view.queryByLabelText("移除 new.png")).not.toBeNull();
  });

  const finalSaved = await readDraftAttachments("acc-1", "ch-5");
  expect(finalSaved?.files.map((f) => f.file.name).sort()).toEqual([
    "new.png",
    "old.png",
  ]);
});

test("(c2) 挂载时 accountId 尚未就绪，稍后就绪仍能正确恢复草稿且不误删 IndexedDB", async () => {
  await writeDraftAttachments("acc-late", "ch-6", [
    {
      id: "late-1",
      file: png("late.png"),
      attachment: {
        id: "sdk-late-1",
        type: "image",
        filename: "late.png",
        status: "ready",
        source: {
          type: "url",
          value: "/api/attachments/srv-late-1",
          mimeType: "image/png",
        },
        metadata: { attachmentId: "srv-late-1", filename: "late.png" },
      },
    },
  ]);

  setDraftFileAccount(null);
  const view = render(
    <Composer channelId="ch-6" compact draftKey="ch-6" onSubmit={() => {}} />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
  expect(view.queryByLabelText("移除 late.png")).toBeNull();

  // accountId 晚到并触发重渲染
  setDraftFileAccount("acc-late");
  view.rerender(
    <Composer
      channelId="ch-6"
      chatFileAgentId="agent-1"
      compact
      draftKey="ch-6"
      onSubmit={() => {}}
    />,
  );

  await waitFor(() =>
    expect(view.queryByLabelText("移除 late.png")).not.toBeNull(),
  );
});

test("(c3) StrictMode 双挂载期间收到 accepted 事件，被接纳的附件不会在二次挂载恢复时复活", async () => {
  await writeDraftAttachments("acc-1", "ch-7", [
    {
      id: "acc-item-1",
      file: png("sent-during-restore.png"),
      attachment: {
        id: "sdk-sent-1",
        type: "image",
        filename: "sent-during-restore.png",
        status: "ready",
        source: {
          type: "url",
          value: "/api/attachments/srv-sent-1",
          mimeType: "image/png",
        },
        metadata: {
          attachmentId: "srv-sent-1",
          filename: "sent-during-restore.png",
        },
      },
    },
  ]);

  let holdFirstGet = true;
  let releaseFirstGet: () => void = () => {};
  const firstGetGate = new Promise<void>((resolve) => {
    releaseFirstGet = resolve;
  });
  memoryIdb.setHoldGet(async () => {
    if (!holdFirstGet) return;
    holdFirstGet = false;
    await firstGetGate;
  });

  const view = render(
    <StrictMode>
      <Composer channelId="ch-7" compact draftKey="ch-7" onSubmit={() => {}} />
    </StrictMode>,
  );

  // 在第一次挂载的异步恢复尚未结束时广播 accepted
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
    draftFilesAccepted([{ metadata: { attachmentId: "srv-sent-1" } }]);
    releaseFirstGet();
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(view.queryByLabelText("移除 sent-during-restore.png")).toBeNull();
});

test("(c4) 同一挂载实例切换 draftKey 会重置已读状态并恢复新草稿", async () => {
  await writeDraftAttachments("acc-1", "ch-8a", [
    {
      id: "a-1",
      file: png("draft-a.png"),
      failedReason: "A 失败",
    },
  ]);
  await writeDraftAttachments("acc-1", "ch-8b", [
    {
      id: "b-1",
      file: png("draft-b.png"),
      failedReason: "B 失败",
    },
  ]);

  const view = render(
    <Composer channelId="ch-8a" compact draftKey="ch-8a" onSubmit={() => {}} />,
  );
  await waitFor(() => expect(view.getByText("A 失败")).toBeTruthy());

  view.rerender(
    <Composer channelId="ch-8b" compact draftKey="ch-8b" onSubmit={() => {}} />,
  );
  await waitFor(() => expect(view.getByText("B 失败")).toBeTruthy());
});
