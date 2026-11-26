import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MAX_IMAGE_BYTES, MAX_FILE_BYTES } from "../../shared/attachments";
import { MAX_BOT_LIBRARY_FILE_BYTES } from "../../shared/bot-library";
import type { BotLifecycleServices } from "../src/agents/lifecycle-routes";
import type { AgentProfile } from "../src/agents/profile-types";
import { createApp, UPLOAD_BODY_LIMIT_BYTES } from "../src/app";
import type { ChannelStore } from "../src/channels/routes";
import {
  type BotLibraryDatabase,
  createBotLibraryService,
} from "../src/chat-files/library-service";
import { createMediaPoolService } from "../src/chat-files/media-pool-service";
import type { ChatFileView } from "../src/chat-files/service";
import { loadConfig } from "../src/config";
import type { Database } from "../src/db/client";
import { testEnvironment } from "./support/environment";

const MEMBER = {
  id: "user-coexist-1",
  email: "member@chisabot.test",
  name: "Coexistence Tester",
  image: null,
};

const CHANNEL_ID = "ch-coexist-1";
const BOT_ID = "bot-coexist-1";
const BOT_LIBRARY_MULTIPART_ALLOWANCE = 512 * 1024;
const EXPECTED_ATTACHMENT_DOOR_ERROR = `上传的文件太大（上限 ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB）。请压缩或截一部分再发。`;

function makePngBytes(byteLength: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(byteLength));
  // Valid PNG signature so `sniffMimeType` classifies it as `image/png`.
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function makeAttachmentForm(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  mimeType: string,
  uploadGroup = "group-coexist-1",
): FormData {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: mimeType }));
  form.append("uploadGroup", uploadGroup);
  return form;
}

function makeBotProfile(id: string, ownerUserId: string): AgentProfile {
  const now = new Date();
  return {
    id,
    name: "星灵",
    title: "私人助手",
    roleDescription: "私人助手",
    ownerUserId,
    visibility: "private",
    systemOwned: false,
    deletedAt: null,
    avatarSeed: id,
    createdAt: now,
    updatedAt: now,
  } as AgentProfile;
}

function makeChannelStoreStub(): ChannelStore {
  const channel = {
    id: CHANNEL_ID,
    name: "星灵",
    agentIds: [BOT_ID],
    threadId: "thread-coexist-1",
    active: true,
    lastMessageAt: null,
  };
  return {
    create: async () => channel,
    direct: async () => channel,
    openThread: async () => channel,
    get: async (_actor, id) => (id === CHANNEL_ID ? channel : null),
    list: async () => ({ channels: [], nextCursor: null }),
    setPinned: async () => {},
    markRead: async () => {},
    softDelete: async () => true,
    recordActivity: async () => {},
    signalBusy: async () => {},
    signalChannelBusy: async () => {},
  };
}

function extractSqlParams(query: unknown): unknown[] {
  if (!query || typeof query !== "object") return [];
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return [];
  const values: unknown[] = [];
  for (const chunk of chunks) {
    if (
      typeof chunk === "string" ||
      typeof chunk === "number" ||
      Buffer.isBuffer(chunk)
    ) {
      values.push(chunk);
    } else if (
      chunk &&
      typeof chunk === "object" &&
      "value" in chunk &&
      !Array.isArray((chunk as { value: unknown }).value)
    ) {
      values.push((chunk as { value: unknown }).value);
    }
  }
  return values;
}

function makeAttachmentDatabaseStub() {
  const inserted: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }> = [];

  const database = {
    $client: {
      unsafe: async () => [],
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => [{ id: CHANNEL_ID }],
        }),
      }),
    }),
    transaction: async <T>(
      callback: (tx: {
        execute: (query: unknown) => Promise<unknown[]>;
      }) => Promise<T>,
    ): Promise<T> => {
      let executeCalls = 0;
      return callback({
        execute: async (query: unknown) => {
          executeCalls += 1;
          if (executeCalls === 1) {
            // pg_advisory_xact_lock
            return [];
          }
          // Extract interpolated values from the Drizzle `sql` template in
          // `channels/attachments.ts`: [actorId, channelId, ..., actorId, uploadGroup, name, mimeType, sizeBytes, bytes, ...]
          const params = extractSqlParams(query);
          const bytesIndex = params.findIndex((value) =>
            Buffer.isBuffer(value),
          );
          const sizeBytes =
            bytesIndex >= 1 && typeof params[bytesIndex - 1] === "number"
              ? (params[bytesIndex - 1] as number)
              : 0;
          const mimeType =
            bytesIndex >= 2 && typeof params[bytesIndex - 2] === "string"
              ? (params[bytesIndex - 2] as string)
              : "application/octet-stream";
          const name =
            bytesIndex >= 3 && typeof params[bytesIndex - 3] === "string"
              ? (params[bytesIndex - 3] as string)
              : "upload";
          const record = {
            id: `att-${inserted.length + 1}`,
            name,
            mimeType,
            sizeBytes,
          };
          inserted.push(record);
          return [
            {
              ...record,
              waiting: inserted.length - 1,
              held: inserted.length - 1,
              isMember: true,
            },
          ];
        },
      });
    },
  } as unknown as Database;

  return { database, inserted };
}

function makeLifecycleServicesStub(): BotLifecycleServices {
  const bot = makeBotProfile(BOT_ID, MEMBER.id);
  return {
    lifecycle: {
      get: async () => ({
        agentId: BOT_ID,
        paused: false,
        pausedAt: null,
        notify: "all",
      }),
      pause: async () => 0,
      resume: async () => {},
      setNotify: async () => {},
      pausedFor: async () => [],
      notifyFor: async () => ({}),
      routing: async () => ({
        progress: "all",
        decision: "all",
        question: "all",
      }),
      setRouting: async () => {},
    },
    reset: {
      plan: async () => ({ conversations: 0 }),
      execute: async () => ({ conversations: 0 }),
    },
    activity: {
      forBot: async () => ({ inProgress: [], scheduled: [], completed: [] }),
      stopHandoff: async () => ({ key: "hop-1", toBotId: "bot-2" }),
      attention: async () => [],
    },
    wakeUps: {
      cancel: async () => true,
    },
    profiles: {
      get: async (_actor, id) => (id === BOT_ID ? bot : null),
    },
  } as unknown as BotLifecycleServices;
}

function makeBotLibraryServiceStub() {
  const bot = makeBotProfile(BOT_ID, MEMBER.id);
  const links = new Map<
    string,
    { owner: string; agentId: string; fileId: string; createdAt: Date }
  >();
  const uploaded: Array<{ name: string; size: number }> = [];

  const database: BotLibraryDatabase = {
    $client: {
      unsafe: (async (query: string, params?: unknown[]) => {
        const trimmed = query.trim();
        if (trimmed.startsWith("CREATE TABLE")) return [];
        if (trimmed.startsWith("SELECT count(*)::int AS cnt")) {
          const owner = String(params?.[0] ?? "");
          const agentId = String(params?.[1] ?? "");
          const cnt = [...links.values()].filter(
            (row) => row.owner === owner && row.agentId === agentId,
          ).length;
          return [{ cnt }];
        }
        if (trimmed.startsWith("INSERT INTO chisabot_bot_library_files")) {
          const owner = String(params?.[0] ?? "");
          const agentId = String(params?.[1] ?? "");
          const fileId = String(params?.[2] ?? "");
          links.set(`${owner}:${agentId}:${fileId}`, {
            owner,
            agentId,
            fileId,
            createdAt: new Date(),
          });
          return [];
        }
        return [];
      }) as unknown as BotLibraryDatabase["$client"]["unsafe"],
    },
  };

  const chatFiles = {
    async upload(
      _owner: string,
      _agentId: string,
      file: { name: string; bytes: Buffer },
    ): Promise<ChatFileView> {
      const id = randomUUID();
      uploaded.push({ name: file.name, size: file.bytes.length });
      return {
        id,
        name: file.name,
        mimeType: "text/markdown",
        size: file.bytes.length,
        kind: "upload",
        url: `/api/chat-files/${id}`,
        workspacePath: `uploads/${file.name}`,
        createdAt: new Date().toISOString(),
      };
    },
    async remove(): Promise<boolean> {
      return true;
    },
  };

  const service = createBotLibraryService({
    database,
    chatFiles,
    profiles: {
      get: async (_actor, id) => (id === BOT_ID ? bot : null),
    },
  });

  return { service, uploaded };
}

function makeMediaPoolStub() {
  const database = {
    $client: {
      unsafe: async () => [],
    },
  };
  return createMediaPoolService(database as never, {} as never);
}

function buildCoexistenceApp(options: { authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? true;
  let authGuardCalls = 0;
  const attachmentStub = makeAttachmentDatabaseStub();
  const botLibraryStub = makeBotLibraryServiceStub();
  const mediaPool = makeMediaPoolStub();

  const auth = authenticated
    ? ({
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => {
            authGuardCalls += 1;
            return { user: MEMBER };
          },
        },
      } as never)
    : ({
        handler: () => new Response(null, { status: 204 }),
        api: {
          getSession: async () => {
            authGuardCalls += 1;
            return null;
          },
        },
      } as never);

  const app = createApp(
    loadConfig(testEnvironment()),
    auth,
    { rolesForUser: async () => ["user"] },
    undefined, // auditReader
    undefined, // credentialService
    undefined, // packageStatusReader
    undefined, // conversationHandler
    undefined, // computerGateway
    undefined, // computerPolicy
    undefined, // agentProfileStore
    makeChannelStoreStub(), // channelStore -> mounts /api/channels (createChannelRoutes) FIRST
    undefined, // channelEvents
    undefined, // auditStore
    undefined, // componentStore
    undefined, // pluginStore
    undefined, // sandboxedStore
    undefined, // threadIdentity
    undefined, // peopleStore
    undefined, // _removedIdentityProviders
    undefined, // _intentRouter
    undefined, // pageFrames
    undefined, // _removedRoutineRunner
    undefined, // _removedRoutineStore
    undefined, // onboardingStore
    undefined, // userInstructions
    attachmentStub.database, // attachmentDatabase -> mounts /api/channels (channelAttachments) SECOND
    undefined, // _removedHostAccessBroker
    undefined, // desktopHostToken
    undefined, // deploymentToolCaller
    undefined, // composio
    undefined, // modelProviderProxy
    undefined, // userPreferences
    undefined, // _removedVoiceSessions
    undefined, // _removedLearning
    {
      lifecycle: makeLifecycleServicesStub(), // mounts /api/bots (createBotLifecycleRoutes) FIRST
    },
    undefined, // localBackend
    undefined, // modelSettings
    undefined, // agentModels
    undefined, // modelCatalog
    undefined, // panels
    undefined, // magpie
    {
      // Mirrors server/src/index.ts:6345 & 6400 mounting sibling /api/bots sub-routers via extraRoutes.
      extraRoutes: ({ requireUser }) => [
        ["/api/bots", botLibraryStub.service.routes(requireUser)],
        ["/api/bots", mediaPool.botAvatarRoutes(requireUser)],
      ],
    },
  );

  return {
    app,
    insertedAttachments: attachmentStub.inserted,
    uploadedLibraryFiles: botLibraryStub.uploaded,
    authGuardCalls: () => authGuardCalls,
  };
}

describe("Route bodyLimit coexistence across shared Hono mount prefixes", () => {
  describe("/api/channels: createChannelRoutes (512 KiB) vs channelAttachments (8 MiB + 64 KiB)", () => {
    test("allows 600 KiB, 1 MiB, and exact 8 MiB PNG uploads with uploadGroup and non-ASCII filename", async () => {
      const { app, insertedAttachments } = buildCoexistenceApp();
      const cases = [
        { size: 600 * 1024, filename: "截屏_600KB_测试图片.png" },
        { size: 1024 * 1024, filename: "截屏_1MB_测试图片.png" },
        { size: MAX_IMAGE_BYTES, filename: "截屏_8MB上限_高清大图.png" },
      ];

      for (const item of cases) {
        const response = await app.request(
          `/api/channels/${CHANNEL_ID}/attachments`,
          {
            method: "POST",
            body: makeAttachmentForm(
              makePngBytes(item.size),
              item.filename,
              "image/png",
            ),
          },
        );
        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          id: string;
          name: string;
          mimeType: string;
          sizeBytes: number;
        };
        expect(body.name).toBe(item.filename);
        expect(body.mimeType).toBe("image/png");
        expect(body.sizeBytes).toBe(item.size);
      }

      expect(insertedAttachments).toHaveLength(3);
    });

    test("allows 600 KiB text upload and lets handler reject 1 MiB + 1 text upload with text-specific 413", async () => {
      const { app } = buildCoexistenceApp();

      const okBytes = new Uint8Array(new ArrayBuffer(600 * 1024));
      okBytes.fill(0x61); // 'a'
      const okResponse = await app.request(
        `/api/channels/${CHANNEL_ID}/attachments`,
        {
          method: "POST",
          body: makeAttachmentForm(okBytes, "notes.txt", "text/plain"),
        },
      );
      expect(okResponse.status).toBe(201);

      const overTextBytes = new Uint8Array(new ArrayBuffer(MAX_FILE_BYTES + 1));
      overTextBytes.fill(0x61);
      const overTextResponse = await app.request(
        `/api/channels/${CHANNEL_ID}/attachments`,
        {
          method: "POST",
          body: makeAttachmentForm(overTextBytes, "big.txt", "text/plain"),
        },
      );
      expect(overTextResponse.status).toBe(413);
      const overTextBody = (await overTextResponse.json()) as { error: string };
      expect(overTextBody.error).not.toBe("频道请求体过大。");
      expect(overTextBody.error).toContain("1MB");
    });

    test("rejects > UPLOAD_BODY_LIMIT_BYTES (8 MiB + 64 KiB + 1) at attachment door before requireUser", async () => {
      const { app, authGuardCalls } = buildCoexistenceApp({
        authenticated: false,
      });
      const oversized = new Uint8Array(
        new ArrayBuffer(UPLOAD_BODY_LIMIT_BYTES + 1),
      );
      const response = await app.request(
        `/api/channels/${CHANNEL_ID}/attachments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(oversized.byteLength),
          },
          body: oversized,
        },
      );
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: EXPECTED_ATTACHMENT_DOOR_ERROR,
      });
      expect(authGuardCalls()).toBe(0);
    });

    test("still enforces 512 KiB channelBodyLimit pre-auth on every createChannelRoutes write route", async () => {
      const { app, authGuardCalls } = buildCoexistenceApp({
        authenticated: false,
      });
      const oversizedJson = JSON.stringify({
        pad: "x".repeat(512 * 1024 + 64),
      });
      const writeRoutes: Array<{ method: string; path: string }> = [
        { method: "POST", path: "/api/channels" },
        { method: "POST", path: `/api/channels/${CHANNEL_ID}/activity` },
        { method: "POST", path: `/api/channels/${CHANNEL_ID}/busy` },
        { method: "PUT", path: `/api/channels/${CHANNEL_ID}/pin` },
        { method: "PUT", path: `/api/channels/${CHANNEL_ID}/read` },
        { method: "DELETE", path: `/api/channels/${CHANNEL_ID}` },
        { method: "POST", path: "/api/channels/open-thread" },
      ];

      for (const route of writeRoutes) {
        const response = await app.request(route.path, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: oversizedJson,
        });
        expect(response.status).toBe(413);
        const body = (await response.json()) as { error: string };
        expect(body).toEqual({ error: "频道请求体过大。" });
        expect(body.error).not.toBe(EXPECTED_ATTACHMENT_DOOR_ERROR);
      }

      // Pre-auth DoS protection: none of the oversized write calls reached requireUser.
      expect(authGuardCalls()).toBe(0);
    });

    test("passes small and bodyless channel write requests without 413", async () => {
      const { app } = buildCoexistenceApp();

      const created = await app.request("/api/channels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: [BOT_ID] }),
      });
      expect(created.status).toBe(201);

      const activity = await app.request(
        `/api/channels/${CHANNEL_ID}/activity`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: "hello",
            agentId: null,
            at: new Date().toISOString(),
          }),
        },
      );
      expect(activity.status).toBe(204);

      const busy = await app.request(`/api/channels/${CHANNEL_ID}/busy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: true }),
      });
      expect(busy.status).toBe(204);

      const pin = await app.request(`/api/channels/${CHANNEL_ID}/pin`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
      expect(pin.status).toBe(200);

      const read = await app.request(`/api/channels/${CHANNEL_ID}/read`, {
        method: "PUT",
      });
      expect(read.status).toBe(204);

      const deleted = await app.request(`/api/channels/${CHANNEL_ID}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(204);

      const opened = await app.request("/api/channels/open-thread", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: BOT_ID, threadId: "thread-coexist-1" }),
      });
      expect(opened.status).toBe(200);

      // Bodyless POST reaches JSON validation (400), never 413.
      const bodylessPost = await app.request("/api/channels", {
        method: "POST",
      });
      expect(bodylessPost.status).toBe(400);
    });
  });

  describe("/api/bots: createBotLifecycleRoutes (128 KiB) vs botLibrary (20 MiB + 512 KiB) & botAvatarRoutes", () => {
    test("allows 200 KiB and 1 MiB multipart uploads to POST /api/bots/:agentId/library", async () => {
      const { app, uploadedLibraryFiles } = buildCoexistenceApp();
      const sizes = [200 * 1024, 1024 * 1024];

      for (const size of sizes) {
        const form = new FormData();
        const bytes = new Uint8Array(new ArrayBuffer(size));
        bytes.fill(0x62); // 'b'
        form.append(
          "file",
          new File([bytes], `资料_${size}.md`, { type: "text/markdown" }),
        );
        const response = await app.request(`/api/bots/${BOT_ID}/library`, {
          method: "POST",
          body: form,
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as {
          file: { name: string; size: number };
        };
        expect(body.file.name).toBe(`资料_${size}.md`);
        expect(body.file.size).toBe(size);
      }

      expect(uploadedLibraryFiles).toHaveLength(2);
    });

    test("rejects POST /api/bots/:agentId/library exceeding 20 MiB + 512 KiB with library-service 413", async () => {
      const { app } = buildCoexistenceApp();
      const overCeiling =
        MAX_BOT_LIBRARY_FILE_BYTES + BOT_LIBRARY_MULTIPART_ALLOWANCE + 1;
      const response = await app.request(`/api/bots/${BOT_ID}/library`, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(overCeiling),
        },
        // Provide a small body while declaring content-length > 20 MiB + 512 KiB
        // so hono/body-limit enforces the header ceiling without allocating 20.5 MiB.
        body: "x",
      });
      expect(response.status).toBe(413);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("资料文件大小超过上限（最大 20.0 MB）。");
      expect(body.error).not.toBe("请求体过大。");
    });

    test("does not shadow sibling POST /api/bots/:agentId/avatar/generate with lifecycle 128 KiB limit", async () => {
      const { app } = buildCoexistenceApp();
      const oversizedForBoth = JSON.stringify({
        prompt: "a".repeat(200 * 1024),
      });
      const response = await app.request(
        `/api/bots/${BOT_ID}/avatar/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: oversizedForBoth,
        },
      );
      // Reaches media-pool-service.ts's own 16 KiB bodyLimit + onError handler (502),
      // proving createBotLifecycleRoutes's 128 KiB middleware did not intercept it with 413 {"error":"请求体过大。"}.
      expect(response.status).not.toBe(413);
      expect(await response.json()).toEqual({
        error: "生成头像失败，请稍后重试。",
      });
    });

    test("still enforces 128 KiB lifecycleBodyLimit pre-auth on every createBotLifecycleRoutes write route", async () => {
      const { app, authGuardCalls } = buildCoexistenceApp({
        authenticated: false,
      });
      const oversizedJson = JSON.stringify({
        pad: "x".repeat(128 * 1024 + 64),
      });
      const writeRoutes: Array<{ method: string; path: string }> = [
        { method: "PUT", path: "/api/bots/routing/progress" },
        { method: "POST", path: `/api/bots/${BOT_ID}/pause` },
        { method: "POST", path: `/api/bots/${BOT_ID}/resume` },
        { method: "PUT", path: `/api/bots/${BOT_ID}/notifications` },
        { method: "POST", path: `/api/bots/${BOT_ID}/reset` },
        {
          method: "POST",
          path: `/api/bots/${BOT_ID}/activity/handoffs/stop`,
        },
        { method: "POST", path: `/api/bots/${BOT_ID}/follow-ups/cancel` },
      ];

      for (const route of writeRoutes) {
        const response = await app.request(route.path, {
          method: route.method,
          headers: { "content-type": "application/json" },
          body: oversizedJson,
        });
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ error: "请求体过大。" });
      }

      // Pre-auth DoS protection: none of the oversized write calls reached requireUser.
      expect(authGuardCalls()).toBe(0);
    });

    test("passes small and bodyless bot lifecycle write requests without 413", async () => {
      const { app } = buildCoexistenceApp();

      const pause = await app.request(`/api/bots/${BOT_ID}/pause`, {
        method: "POST",
      });
      expect(pause.status).toBe(200);

      const resume = await app.request(`/api/bots/${BOT_ID}/resume`, {
        method: "POST",
      });
      expect(resume.status).toBe(200);

      const routing = await app.request("/api/bots/routing/progress", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transports: "all" }),
      });
      expect(routing.status).toBe(200);

      const notify = await app.request(`/api/bots/${BOT_ID}/notifications`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notify: "all" }),
      });
      expect(notify.status).toBe(200);

      const reset = await app.request(`/api/bots/${BOT_ID}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      expect(reset.status).toBe(200);

      const stopHandoff = await app.request(
        `/api/bots/${BOT_ID}/activity/handoffs/stop`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "hop-1" }),
        },
      );
      expect(stopHandoff.status).toBe(200);

      const cancelFollowUp = await app.request(
        `/api/bots/${BOT_ID}/follow-ups/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "wake-1" }),
        },
      );
      expect(cancelFollowUp.status).toBe(200);
    });
  });
});
