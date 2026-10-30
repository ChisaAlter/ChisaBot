import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import sharp from "sharp";
import type { AppVariables } from "../src/auth/guards";
import {
  createThumbnailer,
  type SharpLike,
} from "../src/channels/attachment-thumbs";
import { createAttachmentRoutes } from "../src/channels/attachments";
import { createDatabase } from "../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * `GET /api/attachments/:id?w=`：缩略图。权限和原图一样（成员、频道没删），只认固定档位，缩不了就回原图，
 * 缓存命中时不再读原图字节。
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const testPrefix = `attachment-thumb-route-${randomUUID()}`;
const createdChannelIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  for (const id of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function actor(id: string): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  };
}

async function photo(width: number, height: number): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 2654435761) >>> 24;
  }
  return new Uint8Array(
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

/** 一个频道、一个成员、一个外人，和成员发过的一个附件。 */
async function fixture(file: {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}) {
  const memberId = `${testPrefix}-member-${randomUUID()}`;
  const strangerId = `${testPrefix}-stranger-${randomUUID()}`;
  await database.insert(users).values([
    { id: memberId, email: `${memberId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  createdUserIds.push(memberId, strangerId);
  const channelId = `${testPrefix}-channel-${randomUUID()}`;
  await database
    .insert(channels)
    .values({ id: channelId, name: "Thumb Test", description: "thumbs" });
  createdChannelIds.push(channelId);
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: memberId });
  const [row] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy: memberId,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.bytes.byteLength,
      bytes: Buffer.from(file.bytes),
      attachedAt: new Date(),
    })
    .returning({ id: attachments.id });
  return { id: row.id, channelId, memberId, strangerId };
}

/** 记下每次 select 选了哪些列，看缓存命中时有没有读 `bytes`。 */
function recordingSelections(selections: string[][]) {
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "select") return value.bind(target);
      return (fields?: Record<string, unknown>) => {
        selections.push(Object.keys(fields ?? {}));
        return (value as (...called: unknown[]) => unknown).call(
          target,
          fields,
        );
      };
    },
  }) as typeof database;
}

function app(
  actorId: string,
  options: {
    thumbs?: ReturnType<typeof createThumbnailer>;
    db?: typeof database;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.route(
    "/",
    createAttachmentRoutes(
      options.db ?? database,
      actor(actorId),
      options.thumbs ??
        createThumbnailer({ load: async () => sharp as unknown as SharpLike }),
    ),
  );
  return routes;
}

describe("GET /:id?w=", () => {
  test("serves a WebP thumbnail at the tier, smaller than the original", async () => {
    const original = await photo(1600, 1200);
    const { id, memberId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: original,
    });

    const response = await app(memberId).request(`http://test/${id}?w=480`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe(`"${id}-w480"`);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBeLessThan(original.byteLength / 4);
    const meta = await sharp(body).metadata();
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(360);

    // 不带 w 仍是原图，ETag 不变。
    const full = await app(memberId).request(`http://test/${id}`);
    expect(full.headers.get("Content-Type")).toBe("image/png");
    expect(full.headers.get("ETag")).toBe(`"${id}"`);
    expect((await full.arrayBuffer()).byteLength).toBe(original.byteLength);
  });

  test("refuses widths that are not a tier with 400, before looking at any row", async () => {
    const selections: string[][] = [];
    const { id, memberId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: await photo(800, 600),
    });
    const routes = app(memberId, { db: recordingSelections(selections) });
    for (const w of ["100", "481", "0480", "", "abc", "99999"]) {
      const response = await routes.request(`http://test/${id}?w=${w}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "w must be one of 240, 480, 960.",
      });
    }
    expect(selections).toEqual([]);
  });

  test("a stranger gets the same 404 with or without w", async () => {
    const { id, strangerId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: await photo(800, 600),
    });
    const routes = app(strangerId);
    const thumb = await routes.request(`http://test/${id}?w=240`);
    const full = await routes.request(`http://test/${id}`);
    expect(thumb.status).toBe(404);
    expect(full.status).toBe(404);
    expect(await thumb.json()).toEqual(await full.json());
  });

  test("a cached thumbnail does not read the original again, and still checks membership", async () => {
    const { id, channelId, memberId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: await photo(1600, 1200),
    });
    const thumbs = createThumbnailer({
      load: async () => sharp as unknown as SharpLike,
    });
    const selections: string[][] = [];
    const routes = app(memberId, {
      thumbs,
      db: recordingSelections(selections),
    });

    const first = await routes.request(`http://test/${id}?w=240`);
    expect(first.status).toBe(200);
    expect(selections.flat()).toContain("bytes");
    const firstBody = new Uint8Array(await first.arrayBuffer());

    selections.length = 0;
    const second = await routes.request(`http://test/${id}?w=240`);
    expect(second.status).toBe(200);
    expect(second.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(firstBody);
    expect(selections.length).toBeGreaterThan(0);
    expect(selections.flat()).not.toContain("bytes");

    // 移出频道以后，缓存里还有也拿不到。
    await database
      .delete(channelMemberships)
      .where(
        and(
          eq(channelMemberships.channelId, channelId),
          eq(channelMemberships.userId, memberId),
        ),
      );
    expect((await routes.request(`http://test/${id}?w=240`)).status).toBe(404);
  });

  test("revalidation with the thumbnail's ETag is a 304", async () => {
    const { id, memberId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: await photo(1600, 1200),
    });
    const routes = app(memberId);
    const response = await routes.request(`http://test/${id}?w=960`, {
      headers: { "If-None-Match": `"${id}-w960"` },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(`"${id}-w960"`);
    // 原图的 ETag 换不来缩略图的 304，反过来也一样。
    const mismatch = await routes.request(`http://test/${id}?w=960`, {
      headers: { "If-None-Match": `"${id}"` },
    });
    expect(mismatch.status).toBe(200);
  });

  test("falls back to the original bytes for non-images, narrow images and a missing sharp", async () => {
    const text = new TextEncoder().encode("hello");
    const doc = await fixture({
      name: "a.txt",
      mimeType: "text/plain",
      bytes: text,
    });
    const docResponse = await app(doc.memberId).request(
      `http://test/${doc.id}?w=240`,
    );
    expect(docResponse.status).toBe(200);
    expect(docResponse.headers.get("Content-Type")).toBe("text/plain");
    expect(await docResponse.text()).toBe("hello");

    const small = await photo(200, 100);
    const narrow = await fixture({
      name: "small.png",
      mimeType: "image/png",
      bytes: small,
    });
    const narrowResponse = await app(narrow.memberId).request(
      `http://test/${narrow.id}?w=240`,
    );
    expect(narrowResponse.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await narrowResponse.arrayBuffer())).toEqual(small);

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const big = await photo(1600, 1200);
      const missing = await fixture({
        name: "big.png",
        mimeType: "image/png",
        bytes: big,
      });
      const response = await app(missing.memberId, {
        thumbs: createThumbnailer({ load: async () => null }),
      }).request(`http://test/${missing.id}?w=480`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(big);
    } finally {
      warn.mockRestore();
    }
  });

  test("HEAD with w answers what the GET would", async () => {
    const { id, memberId } = await fixture({
      name: "photo.png",
      mimeType: "image/png",
      bytes: await photo(1600, 1200),
    });
    const routes = app(memberId);
    const head = await routes.request(`http://test/${id}?w=240`, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/webp");
    expect(head.headers.get("ETag")).toBe(`"${id}-w240"`);
  });
});
