import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { Hono, type MiddlewareHandler } from "hono";
import type { GuardedResponse } from "../../shared/net/guarded-fetch";
import type { AppVariables } from "../src/auth/guards";
import { createBotAvatars } from "../src/bot-avatars/service";
import { createChunkedUploadService } from "../src/chat-files/chunked-upload";
import {
  createChatFiles,
  extractDocxText,
  extractPdfText,
} from "../src/chat-files/service";
import { startEgressPolicyPush } from "../src/computer/policy-network";
import type { ComputerProvider } from "../src/computer/provider";
import type { Database } from "../src/db/client";
import {
  acknowledgeOutgoingMessages,
  computeFederationMessageDigest,
  enqueueOutgoingMessage,
  type FederationPeerRecord,
  type FederationQueueState,
  receiveInboundMessages,
} from "../src/federation/queue";
import { createImService } from "../src/im/service";
import { createLinkPreviews, type PreviewFetch } from "../src/link-preview/service";
import { createSchedules } from "../src/schedules/service";
import { createTaskCenter } from "../src/task-center/service";
import { createWorkerService } from "../src/workers/service";

const TEST_USER: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next,
) => {
  c.set("actor", { id: "user-1", role: "user", email: "u@example.com" });
  await next();
};

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bot-avatars 304 ETag & zero-copy view", () => {
  test("If-None-Match hits 304 by querying only version (skipping bytea), and HEAD skips bytea", async () => {
    const queries: string[] = [];
    // Simulate a pooled slab Buffer slice (byteOffset > 0) to verify zero-copy view bounds.
    const slab = Buffer.concat([
      Buffer.from("PREFIX-NOISE-"),
      ONE_PIXEL_PNG,
      Buffer.from("-SUFFIX-NOISE"),
    ]);
    const slicedPng = slab.subarray(
      "PREFIX-NOISE-".length,
      "PREFIX-NOISE-".length + ONE_PIXEL_PNG.length,
    );

    const database = {
      $client: {
        unsafe: async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith("SELECT version FROM chisabot_bot_avatars")) {
            return [{ version: "abc123def456" }];
          }
          if (
            sql.startsWith(
              "SELECT mime, size_bytes, version FROM chisabot_bot_avatars",
            )
          ) {
            return [
              {
                mime: "image/png",
                size_bytes: ONE_PIXEL_PNG.length,
                version: "abc123def456",
              },
            ];
          }
          if (
            sql.startsWith(
              "SELECT image, mime, version FROM chisabot_bot_avatars",
            )
          ) {
            return [
              {
                image: slicedPng,
                mime: "image/png",
                version: "abc123def456",
              },
            ];
          }
          return [];
        },
      },
    } as unknown as Database;

    const avatars = createBotAvatars(database, {
      get: async () =>
        ({
          id: "bot-1",
          ownerUserId: "user-1",
          name: "Bot 1",
          visibility: "private",
        }) as never,
      list: async () => [],
    });
    const app = new Hono();
    app.route("/api/bot-avatars", avatars.routes(TEST_USER));

    // 1) Matching If-None-Match -> 304 without ever selecting `image` (bytea)
    const res304 = await app.request("/api/bot-avatars/bot-1/image", {
      headers: { "if-none-match": '"abc123def456"' },
    });
    expect(res304.status).toBe(304);
    expect(res304.headers.get("etag")).toBe('"abc123def456"');
    expect(queries.some((q) => q.includes("SELECT image"))).toBe(false);

    // 2) Weak ETag also matches 304
    const resWeak304 = await app.request("/api/bot-avatars/bot-1/image", {
      headers: { "if-none-match": 'W/"abc123def456"' },
    });
    expect(resWeak304.status).toBe(304);
    expect(queries.some((q) => q.includes("SELECT image"))).toBe(false);

    // 3) HEAD request reads metadata only, skips bytea
    const resHead = await app.request("/api/bot-avatars/bot-1/image", {
      method: "HEAD",
    });
    expect(resHead.status).toBe(200);
    expect(resHead.headers.get("content-length")).toBe(
      String(ONE_PIXEL_PNG.length),
    );
    expect(queries.some((q) => q.includes("SELECT image"))).toBe(false);

    // 4) Non-matching If-None-Match -> 200 with exact sliced bytes (no slab bleed)
    const res200 = await app.request("/api/bot-avatars/bot-1/image", {
      headers: { "if-none-match": '"stale"' },
    });
    expect(res200.status).toBe(200);
    const body = Buffer.from(await res200.arrayBuffer());
    expect(body.equals(ONE_PIXEL_PNG)).toBe(true);
  });
});

describe("link-preview single cache lookup, read-only asset serving, 304 & throttled prune", () => {
  test("eliminates duplicate cache lookup, serves immutable asset without UPDATE, supports 304, and throttles prune", async () => {
    const queries: string[] = [];
    const previews = new Map<
      string,
      { ok: boolean; data: unknown; expiresAt: number }
    >();
    const assets = new Map<string, { mime: string; data: Uint8Array }>();

    const database = {
      $client: {
        unsafe: async (sql: string, params: unknown[] = []) => {
          queries.push(sql);
          if (
            sql.startsWith(
              "SELECT ok, data, expires_at > now() AS fresh FROM chisabot_link_previews",
            )
          ) {
            const row = previews.get(params[0] as string);
            return row
              ? [
                  {
                    ok: row.ok,
                    data: row.data,
                    fresh: row.expiresAt > Date.now(),
                  },
                ]
              : [];
          }
          if (sql.includes("INSERT INTO chisabot_link_previews")) {
            const [key, , ok, data] = params as [
              string,
              string,
              boolean,
              string,
            ];
            previews.set(key, {
              ok,
              data: JSON.parse(data),
              expiresAt: Date.now() + 3_600_000,
            });
            return [];
          }
          if (sql.includes("INSERT INTO chisabot_link_preview_assets")) {
            const [id, mime, data] = params as [string, string, Uint8Array];
            assets.set(id, { mime, data });
            return [];
          }
          if (
            sql.startsWith(
              "SELECT mime, data FROM chisabot_link_preview_assets",
            )
          ) {
            const row = assets.get(params[0] as string);
            return row ? [row] : [];
          }
          if (
            sql.startsWith("SELECT 1 AS ok FROM chisabot_link_preview_assets")
          ) {
            return assets.has(params[0] as string) ? [{ ok: 1 }] : [];
          }
          return [];
        },
      },
    } as unknown as Database;

    const fakeFetch: PreviewFetch = async (url): Promise<GuardedResponse> => {
      if (url.endsWith("/og.png")) {
        return {
          url,
          status: 200,
          headers: { "content-type": "image/png" },
          contentType: "image/png",
          body: ONE_PIXEL_PNG,
          truncated: false,
        };
      }
      return {
        url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        contentType: "text/html; charset=utf-8",
        body: Buffer.from(
          `<html><head><title>Page</title><meta property="og:image" content="https://example.com/og.png"></head></html>`,
        ),
        truncated: false,
      };
    };

    const service = await createLinkPreviews(database, { fetch: fakeFetch });
    // Ensure indexes are created at boot
    expect(
      queries.some((q) =>
        q.includes("chisabot_link_previews_expires_at"),
      ),
    ).toBe(true);
    expect(
      queries.some((q) =>
        q.includes("chisabot_link_preview_assets_used_at"),
      ),
    ).toBe(true);

    const app = new Hono();
    app.route("/api/link-preview", service.routes(TEST_USER));

    // First miss builds cache and triggers prune once
    queries.length = 0;
    const first = await app.request(
      "/api/link-preview?url=https://example.com/a",
    );
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as {
      preview: { image: string | null };
    };
    expect(firstJson.preview.image).toMatch(/^\/api\/link-preview\/asset\//);
    const firstDeletes = queries.filter((q) => q.startsWith("DELETE FROM "));
    expect(firstDeletes.length).toBe(2);

    // Second miss on different URL should NOT re-run prune (throttled to 1h)
    queries.length = 0;
    const secondMiss = await app.request(
      "/api/link-preview?url=https://example.com/b",
    );
    expect(secondMiss.status).toBe(200);
    expect(queries.filter((q) => q.startsWith("DELETE FROM ")).length).toBe(0);

    // Cached hit must query chisabot_link_previews ONLY ONCE (no duplicate lookup)
    queries.length = 0;
    const hit = await app.request(
      "/api/link-preview?url=https://example.com/a",
    );
    expect(hit.status).toBe(200);
    const cacheSelects = queries.filter((q) =>
      q.includes("FROM chisabot_link_previews"),
    );
    expect(cacheSelects.length).toBe(1);

    // Asset GET: pure SELECT, zero UPDATE, returns ETag; matching If-None-Match returns 304
    const assetUrl = firstJson.preview.image as string;
    queries.length = 0;
    const assetRes = await app.request(assetUrl);
    expect(assetRes.status).toBe(200);
    const etag = assetRes.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(
      queries.some((q) => q.startsWith("UPDATE chisabot_link_preview_assets")),
    ).toBe(false);

    queries.length = 0;
    const asset304 = await app.request(assetUrl, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(asset304.status).toBe(304);
    expect(queries.some((q) => q.includes("SELECT mime, data"))).toBe(false);
  });
});

describe("chat-files HEAD skips bytea, async zlib extraction, chunked-upload single allocation", () => {
  test("HEAD /api/chat-files/:id queries metadata without bytes column", async () => {
    const fileId = randomUUID();
    const queries: string[] = [];
    const payload = Buffer.from("hello-chat-file-payload");

    const database = {
      $client: {
        unsafe: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("FROM chisabot_chat_files WHERE id = $1")) {
            const withBytes = sql.includes(", bytes FROM");
            return [
              {
                id: fileId,
                owner_user_id: "user-1",
                agent_id: "bot-1",
                kind: "upload",
                name: "demo.txt",
                mime_type: "text/plain",
                size_bytes: payload.length,
                workspace_path: null,
                prompt: null,
                model: null,
                source_id: null,
                created_at: new Date(),
                ...(withBytes ? { bytes: payload } : {}),
              },
            ];
          }
          return [];
        },
      },
    } as unknown as Database;

    const chatFiles = createChatFiles(database, {
      encryptionKey: "k".repeat(32),
      ownsBot: async () => true,
    });
    const app = new Hono();
    app.route("/api/chat-files", chatFiles.routes(TEST_USER));

    const headRes = await app.request(`/api/chat-files/${fileId}`, {
      method: "HEAD",
    });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).toBe(String(payload.length));
    expect(queries.some((q) => q.includes(", bytes FROM"))).toBe(false);

    const getRes = await app.request(`/api/chat-files/${fileId}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe("hello-chat-file-payload");
    expect(queries.some((q) => q.includes(", bytes FROM"))).toBe(true);
  });

  test("extractDocxText and extractPdfText run asynchronously via zlib threadpool", async () => {
    // Build a valid deflated DOCX entry and FlateDecode PDF
    const xml = Buffer.from(
      `<w:document><w:body><w:p><w:r><w:t>异步解压验证</w:t></w:r></w:p></w:body></w:document>`,
      "utf8",
    );
    const compressedXml = deflateRawSync(xml);
    const nameBuf = Buffer.from("word/document.xml", "utf8");
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(8, 8);
    lfh.writeUInt32LE(compressedXml.length, 18);
    lfh.writeUInt32LE(xml.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const zip = Buffer.concat([lfh, nameBuf, compressedXml]);

    const pdfStream = deflateSync(Buffer.from("BT (Async PDF OK) Tj ET", "utf8"));
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n"),
      pdfStream,
      Buffer.from("\nendstream\nendobj\n%%EOF"),
    ]);

    const [docxText, pdfText] = await Promise.all([
      extractDocxText(zip),
      extractPdfText(pdf),
    ]);
    expect(docxText).toContain("异步解压验证");
    expect(pdfText).toContain("Async PDF OK");
  });

  test("chunked-upload commits multi-chunk file with single allocation and strict byte-count check", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chisa-chunk-"));
    try {
      let committed: Buffer | null = null;
      const service = createChunkedUploadService({
        tempRoot: tempDir,
        ownsBot: async () => true,
        commitFile: async (_owner, _agent, input) => {
          committed = Buffer.from(input.bytes);
          return {
            id: randomUUID(),
            agentId: _agent,
            kind: "upload",
            name: input.name,
            mimeType: input.mimeType,
            sizeBytes: input.bytes.length,
            url: "/api/chat-files/demo",
            workspacePath: null,
            createdAt: new Date().toISOString(),
          };
        },
      });

      const partA = Buffer.alloc(4 * 1024 * 1024, 0x41);
      const partB = Buffer.from("tail-chunk-content-1234567890", "utf8");
      const full = Buffer.concat([partA, partB]);
      const sha256 = createHash("sha256").update(full).digest("hex");

      const init = await service.initSession("user-1", {
        agentId: "bot-1",
        filename: "sample.txt",
        totalSize: full.length,
        mimeType: "text/plain",
        sha256,
      });
      expect(init.totalChunks).toBe(2);

      await service.putChunk({
        ownerUserId: "user-1",
        uploadId: init.uploadId,
        index: 0,
        bytes: partA,
      });
      await service.putChunk({
        ownerUserId: "user-1",
        uploadId: init.uploadId,
        index: 1,
        bytes: partB,
      });
      const result = await service.commitSession("user-1", init.uploadId, {
        sha256,
      });
      expect(result.sizeBytes).toBe(full.length);
      expect(committed).not.toBeNull();
      expect(committed?.equals(full)).toBe(true);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("workers recovery skips redundant UPDATE when status is unchanged", () => {
  test("zero UPDATE when waiting status does not change; UPDATE once on transition; cancel wakes immediately", async () => {
    const workerId = "wrk-1";
    let workerStatus: "waiting" | "running" | "cancelled" = "waiting";
    const durableStatus: "waiting" | "running" = "waiting";
    const statusUpdates: string[] = [];

    const database = {
      $client: {
        unsafe: async (sql: string, params: unknown[] = []) => {
          if (
            sql.startsWith(
              "SELECT * FROM chisabot_workers WHERE status IN ('running','waiting')",
            )
          ) {
            return [
              {
                id: workerId,
                owner_user_id: "user-1",
                parent_thread_id: "thr-parent",
                agent_id: "bot-1",
                thread_id: "thr-worker",
                title: "bg",
                task: "do",
                status: workerStatus,
                plan: [],
                step: null,
                result: null,
                error: null,
                result_message_id: null,
                created_at: new Date(),
                started_at: new Date(),
                finished_at: null,
                updated_at: new Date(),
              },
            ];
          }
          if (sql === "SELECT * FROM chisabot_workers WHERE id = $1") {
            return [
              {
                id: workerId,
                owner_user_id: "user-1",
                parent_thread_id: "thr-parent",
                agent_id: "bot-1",
                thread_id: "thr-worker",
                title: "bg",
                task: "do",
                status: workerStatus,
                plan: [],
                step: null,
                result: null,
                error: null,
                result_message_id: null,
                created_at: new Date(),
                started_at: new Date(),
                finished_at: null,
                updated_at: new Date(),
              },
            ];
          }
          if (sql.includes("to_regclass('public.chisabot_dsh_runs')")) {
            return [{ available: true }];
          }
          if (sql.includes("FROM chisabot_dsh_runs")) {
            return [
              {
                run_id: "run-1",
                status: durableStatus,
                reply_text: null,
                error: null,
                messages: [],
              },
            ];
          }
          if (sql.startsWith("UPDATE chisabot_workers SET status=$2")) {
            statusUpdates.push(String(params[1]));
            workerStatus = params[1] as "waiting" | "running";
            return [];
          }
          if (sql.startsWith("UPDATE chisabot_workers SET status = 'cancelled'")) {
            workerStatus = "cancelled";
            return [];
          }
          return [];
        },
      },
    } as unknown as Database;

    const service = createWorkerService({
      database,
      inbox: {
        enqueue: async () => ({ id: "inb-1", threadId: "thr-parent", ownerUserId: "user-1", message: {} as never, status: "queued", createdAt: "" }),
      } as never,
      control: {
        isActive: () => false,
        stop: async () => true,
        steer: async () => true,
      } as never,
      runTurn: async () => ({ replyText: "ok" }),
    });

    await service.recover();
    // Wait briefly so first poll settles while status remains 'waiting'
    await sleep(60);
    expect(statusUpdates).toEqual([]);

    // Cancel immediately wakes recovery loop so it exits cleanly without hanging
    await service.cancel("thr-parent", workerId, "user-1", { quiet: true });
    expect(durableStatus).toBe("waiting");
    expect(statusUpdates).toEqual([]);
  });
});

describe("schedules & task-center adaptive backoff, wake(), to_regclass cache & indexes", () => {
  test("schedules caches to_regclass, throttles cancelOrphanSchedules, backs off, wakes, and cleans initial timer on stop()", async () => {
    const queries: string[] = [];
    const database = {
      $client: {
        unsafe: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("to_regclass('public.chisabot_dsh_runs')")) {
            return [{ available: true }];
          }
          return [];
        },
        begin: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ unsafe: async () => [] }),
      },
    } as unknown as Database;

    const schedules = createSchedules(database, {
      runTurn: async () => ({ replyText: "ok" }),
      initialDelayMs: 30,
      sweepDelaysMs: [40, 200],
    });

    // 1) ensure() creates partial index on chisabot_schedule_runs
    await schedules.ensure();
    expect(
      queries.some((q) => q.includes("chisabot_schedule_runs_active")),
    ).toBe(true);

    // 2) to_regclass was queried only once across ensure() + extra reclaimStuckRuns()
    await schedules.reclaimStuckRuns();
    await schedules.reclaimStuckRuns();
    const regclassCount = queries.filter((q) =>
      q.includes("to_regclass('public.chisabot_dsh_runs')"),
    ).length;
    expect(regclassCount).toBe(1);

    // 3) start() then immediate stop() cancels initial timer (0 ticks run)
    queries.length = 0;
    schedules.start();
    schedules.stop();
    await sleep(60);
    expect(queries.length).toBe(0);

    // 4) start() runs first tick, backs off, wake() triggers immediately, cancelOrphanSchedules runs only once
    schedules.start();
    await sleep(50);
    const sweepsAfterFirst = queries.filter((q) =>
      q.includes("FROM chisabot_schedules"),
    ).length;
    expect(sweepsAfterFirst).toBeGreaterThanOrEqual(1);

    // Trigger wake() to fire an extra sweep immediately without waiting 200ms
    const beforeWake = queries.filter((q) =>
      q.includes("UPDATE chisabot_schedule_runs r"),
    ).length;
    schedules.wake();
    await sleep(25);
    const afterWake = queries.filter((q) =>
      q.includes("UPDATE chisabot_schedule_runs r"),
    ).length;
    expect(afterWake).toBeGreaterThan(beforeWake);

    // cancelOrphanSchedules ran only once despite multiple ticks (hourly throttle)
    const orphanCancels = queries.filter((q) =>
      q.includes("机器人已删除，定时任务已自动取消"),
    ).length;
    expect(orphanCancels).toBe(1);

    schedules.stop();
  });

  test("task-center creates source/lease indexes, throttles recover(), backs off when idle, and wakes immediately", async () => {
    const queries: string[] = [];
    const tx = {
      unsafe: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT count(*)::int AS count")) {
          return [{ count: 0 }];
        }
        return [];
      },
    };
    const database = {
      $client: {
        unsafe: tx.unsafe,
        begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      },
    } as unknown as Database;

    const tc = createTaskCenter(database, {
      execute: async () => ({ summary: "ok" }),
      sweepDelaysMs: [35, 250],
      recoverIntervalMs: 60_000,
    });

    await tc.ensure();
    expect(
      queries.some((q) => q.includes("chisabot_task_center_sources_due")),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("chisabot_task_center_sources_running")),
    ).toBe(true);
    expect(
      queries.some((q) => q.includes("chisabot_task_center_tasks_lease")),
    ).toBe(true);

    queries.length = 0;
    tc.start();
    await sleep(60);
    // recover() runs once on boot; subsequent sweeps within recoverIntervalMs skip recover
    const initialSourceSelects = queries.filter((q) =>
      q.includes("FROM chisabot_task_center_sources WHERE enabled"),
    ).length;
    expect(initialSourceSelects).toBeGreaterThanOrEqual(1);

    const beforeWake = queries.filter((q) =>
      q.includes("FROM chisabot_task_center_sources WHERE enabled"),
    ).length;
    tc.wake();
    await sleep(25);
    const afterWake = queries.filter((q) =>
      q.includes("FROM chisabot_task_center_sources WHERE enabled"),
    ).length;
    expect(afterWake).toBeGreaterThan(beforeWake);

    const recoverRuns = queries.filter((q) =>
      q.includes("UPDATE chisabot_task_center_sources SET last_status='failed'"),
    ).length;
    expect(recoverRuns).toBe(1);

    await tc.stop();
  });

  test("im delivery loop creates thread index, backs off when idle, wakes immediately, and stops cleanly", async () => {
    const queries: string[] = [];
    const database = {
      $client: {
        unsafe: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("SELECT * FROM chisabot_im_connections")) {
            return [
              {
                id: "im_conn_1",
                owner_user_id: "user-1",
                platform: "onebot",
                name: "ob",
                agent_id: "bot-1",
                enabled: true,
                config: { wsUrl: "wss://example.com/ws" },
                secrets: null,
                allow_users: [],
                owner_users: ["u1"],
                allow_devices: false,
                allow_private: false,
                account: null,
                last_message_at: null,
                last_error: null,
                created_at: new Date(),
              },
            ];
          }
          return [];
        },
        begin: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ unsafe: async () => [] }),
      },
    } as unknown as Database;

    const fakeWs = () => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      return {
        readyState: 1,
        send: () => {},
        close: () => {},
        addEventListener: (event: string, fn: (...args: unknown[]) => void) => {
          const set = listeners.get(event) ?? new Set();
          set.add(fn);
          listeners.set(event, set);
        },
        removeEventListener: (
          event: string,
          fn: (...args: unknown[]) => void,
        ) => {
          listeners.get(event)?.delete(fn);
        },
      } as unknown as WebSocket;
    };

    const im = createImService({
      database,
      encryptionKey: "k".repeat(32),
      runTurn: async () => ({ replyText: "ok" }),
      botAvailable: async () => true,
      fetch: (async () => new Response("{}", { status: 200 })) as never,
      ws: fakeWs as never,
      deliveryDelaysMs: [25, 250],
    });

    await im.ensure();
    expect(queries.some((q) => q.includes("chisabot_im_chats_thread"))).toBe(
      true,
    );

    queries.length = 0;
    await im.startAll();
    // Wait for first idle recovery pass (at 25ms); next pass backs off to 250ms
    await sleep(60);
    const beforeWake = queries.filter((q) =>
      q.includes("FROM chisabot_im_inbox WHERE state='pending'"),
    ).length;
    expect(beforeWake).toBe(1);

    // wakeDeliveries() fires an immediate pass without waiting 250ms
    im.wakeDeliveries();
    await sleep(30);
    const afterWake = queries.filter((q) =>
      q.includes("FROM chisabot_im_inbox WHERE state='pending'"),
    ).length;
    expect(afterWake).toBeGreaterThan(beforeWake);

    await im.stopAll();
    const afterStop = queries.filter((q) =>
      q.includes("FROM chisabot_im_inbox WHERE state='pending'"),
    ).length;
    await sleep(60);
    expect(
      queries.filter((q) =>
        q.includes("FROM chisabot_im_inbox WHERE state='pending'"),
      ).length,
    ).toBe(afterStop);
  });
});

describe("policy-network skips redundant static pushes and federation batch queue is O(N+B)", () => {
  test("startEgressPolicyPush pushes once per run and repushes on restart or reconcile interval", async () => {
    let runId = "run-1";
    const pushedUrls: string[] = [];
    const provider: ComputerProvider = {
      locate: async () => "http://computer.local",
      list: async () => [
        { botId: "bot-1", status: "running", url: "http://computer.local" },
      ],
      sessionOf: async () => runId,
    };
    const fakeFetch = (async (url: string | URL) => {
      pushedUrls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const stop = startEgressPolicyPush({
      provider,
      intervalMs: 25,
      reconcileMs: 5_000,
      fetchImpl: fakeFetch,
    });
    try {
      await sleep(90);
      // Multiple 25ms ticks elapsed, but computer is already confirmed on run-1 -> only 1 push!
      expect(pushedUrls.length).toBe(1);

      // Computer restarts with a new session runId -> next tick pushes immediately
      runId = "run-2";
      await sleep(45);
      expect(pushedUrls.length).toBe(2);
    } finally {
      stop();
    }
  });

  test("receiveInboundMessages & acknowledgeOutgoingMessages handle full batches with quota and idempotency", () => {
    const state: FederationQueueState = {
      peers: [],
      invitations: [],
      messages: [],
    };
    const peer: FederationPeerRecord = {
      id: "peer-1",
      name: "Peer 1",
      url: "https://peer.example.com",
      publicKey: "pk",
      enabled: true,
      allowedBots: ["local-bot"],
      remoteBots: [{ id: "remote-bot", name: "Remote", description: "desc" }],
      capabilities: ["bot_message", "status_ack"],
      maxQueuedMessages: 25,
      maxHistoryMessages: 30,
      pairedAt: 1000,
      lastSyncAt: null,
      revokedAt: null,
    };
    const now = Date.now();
    const batch = Array.from({ length: 20 }, (_, i) => ({
      id: randomUUID(),
      fromAgentId: "remote-bot",
      toAgentId: "local-bot",
      text: `msg-${i}`,
      createdAt: now - i * 10,
    }));

    const accepted = receiveInboundMessages(state, peer, batch, now);
    expect(accepted.length).toBe(20);

    // Replaying the same batch is idempotent and does not trip quota
    const replayed = receiveInboundMessages(state, peer, batch, now + 1000);
    expect(replayed.length).toBe(20);
    expect(state.messages.length).toBe(20);

    // Outgoing enqueue + batch ack
    const out = enqueueOutgoingMessage(
      state,
      peer,
      { fromAgentId: "local-bot", toAgentId: "remote-bot", text: "ping" },
      now,
    );
    acknowledgeOutgoingMessages(
      state,
      peer,
      [
        {
          id: out.id,
          digest: computeFederationMessageDigest({
            id: out.id,
            fromAgentId: out.fromAgentId,
            toAgentId: out.toAgentId,
            text: "ping",
            createdAt: out.createdAt,
          }),
          state: "completed",
        },
      ],
      now + 2000,
    );
    expect(out.state).toBe("completed");
  });
});
