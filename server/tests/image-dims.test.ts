import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CHAT_FILES_MARKER,
  filesFromToolResult,
} from "../../shared/chat-files";
import { createChatFiles } from "../src/chat-files/service";
import { createDatabase } from "../src/db/client";
import {
  createImageDims,
  eventWithDims,
  imageKeyForUrl,
  imageSize,
  withDims,
} from "../src/image-dims";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 37×21 的小图（PIL 生成）；jpeg_rot 带 EXIF 方向 6（转 90°），画出来是 21×37。 */
const FX: Record<string, string> = {
  png: "iVBORw0KGgoAAAANSUhEUgAAACUAAAAVCAIAAABOhrD5AAAAJklEQVR4nGOUqzjBQEfARE/LRu0btW/UvlH7Ru0btW/UvlH7qAAAVx0BiGHvRxAAAAAASUVORK5CYII=",
  gif: "R0lGODdhJQAVAIEAAB54yAAAAAAAAAAAACwAAAAAJQAVAEAILwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqRJkgEBADs=",
  webp_lossy:
    "UklGRkgAAABXRUJQVlA4IDwAAABwAwCdASolABUAPtFmrFEoJaQipWgBABoJZwDQRoAAK/fMIAAA/t+AP9qbFVPO7/xvN5rWcMXOz3nAAAA=",
  webp_lossless: "UklGRh4AAABXRUJQVlA4TBEAAAAvJAAFAAdQvHoUuf+BiOh/AAA=",
  webp_alpha:
    "UklGRmwAAABXRUJQVlA4WAoAAAAQAAAAJAAAFAAAQUxQSAoAAAABB1DAiAhERP8DVlA4IDwAAABwAwCdASolABUAPtFmrFEoJaQipWgBABoJZwDQRoAAK/fMIAAA/t+AP9qbFVPO7/xvN5rWcMXOz3nAAAA=",
  jpeg_rot:
    "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAVACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCvRRRXoHAFFFFABRRRQAUUUUAFFFFABRRRQB//2Q==",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAVACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCvRRRXoHAFFFFABRRRQAUUUUAFFFFABRRRQB//2Q==",
};
const bytes = (name: string) =>
  new Uint8Array(Buffer.from(FX[name]!, "base64"));

describe("imageSize (DESIGN.md §83.2)", () => {
  test.each([
    "png",
    "gif",
    "webp_lossy",
    "webp_lossless",
    "webp_alpha",
    "jpeg",
  ])("%s → 37×21", (name) => {
    expect(imageSize(bytes(name))).toEqual({ width: 37, height: 21 });
  });
  test("JPEG with EXIF orientation 6 swaps to the drawn size", () => {
    expect(imageSize(bytes("jpeg_rot"))).toEqual({ width: 21, height: 37 });
  });
  test("garbage, truncated, svg → null", () => {
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageSize(bytes("png").subarray(0, 20))).toBeNull();
    expect(imageSize(bytes("jpeg").subarray(0, 30))).toBeNull();
    expect(
      imageSize(new TextEncoder().encode("<svg width='10' height='10'></svg>")),
    ).toBeNull();
  });
});

describe("imageKeyForUrl", () => {
  const id = "5245264d-dfdd-4590-88c9-7d3b21ccc0aa";
  test("site image urls map to keys; others do not", () => {
    expect(imageKeyForUrl(`/api/attachments/${id}`)).toBe(`a:${id}`);
    expect(imageKeyForUrl(`/api/attachments/${id.toUpperCase()}?v=2`)).toBe(
      `a:${id}`,
    );
    expect(imageKeyForUrl(`/api/chat-files/${id}`)).toBe(`cf:${id}`);
    expect(imageKeyForUrl(`/api/link-preview/asset/${"a".repeat(40)}`)).toBe(
      `lp:${"a".repeat(40)}`,
    );
    expect(imageKeyForUrl("/api/attachments/../x")).toBeNull();
    expect(imageKeyForUrl("https://example.com/a.png")).toBeNull();
    expect(imageKeyForUrl(42)).toBeNull();
  });
});

describe("withDims / eventWithDims (pure)", () => {
  const a = "5245264d-dfdd-4590-88c9-7d3b21ccc0aa";
  const c = "4022671e-28cf-4136-a25f-6e67209d7953";
  const dims = new Map([
    [`a:${a}`, { width: 640, height: 480 }],
    [`cf:${c}`, { width: 1024, height: 576 }],
  ]);
  const user = {
    id: "m1",
    role: "user",
    content: [
      { type: "text", text: "看看" },
      {
        type: "image",
        source: { type: "url", value: `/api/attachments/${a}` },
        metadata: { attachmentId: a, filename: "x.png" },
      },
      {
        type: "image",
        source: {
          type: "url",
          value: "/api/attachments/00000000-0000-0000-0000-000000000000",
        },
      },
    ],
  };
  const files = [
    {
      id: c,
      name: "boat.png",
      mimeType: "image/png",
      size: 1,
      kind: "generated",
      url: `/api/chat-files/${c}`,
      workspacePath: null,
      createdAt: "x",
    },
  ];
  const toolText = `画好了。\n${CHAT_FILES_MARKER}${JSON.stringify(files)}`;

  test("image parts get metadata.width/height, other metadata kept, unknown left alone", () => {
    const out = withDims(user, dims);
    expect(out).not.toBe(user);
    expect(out.content[1]).toMatchObject({
      metadata: { attachmentId: a, filename: "x.png", width: 640, height: 480 },
    });
    expect(out.content[2]).toBe(user.content[2]);
    expect(user.content[1]!.metadata).toEqual({
      attachmentId: a,
      filename: "x.png",
    }); // input not mutated
  });
  test("tool result marker gets width/height, plain and JSON-wrapped", () => {
    const tool = withDims({ id: "t1", role: "tool", content: toolText }, dims);
    expect(filesFromToolResult(tool.content)[0]).toMatchObject({
      width: 1024,
      height: 576,
    });
    expect(tool.content.startsWith("画好了。")).toBe(true);
    const wrapped = withDims(
      { id: "t2", role: "tool", content: JSON.stringify(toolText) },
      dims,
    );
    expect(wrapped.content.startsWith('"')).toBe(true);
    expect(filesFromToolResult(wrapped.content)[0]).toMatchObject({
      width: 1024,
      height: 576,
    });
  });
  test("nothing known → same object", () => {
    const msg = { id: "m2", role: "assistant", content: "hi" };
    expect(withDims(msg, dims)).toBe(msg);
    expect(withDims(user, new Map())).toBe(user);
  });
  test("events: RUN_STARTED input, MESSAGES_SNAPSHOT, TOOL_CALL_RESULT", () => {
    const started = eventWithDims(
      { type: "RUN_STARTED", input: { messages: [user], context: [] } },
      dims,
    );
    expect(started.input.messages[0]!.content[1]).toMatchObject({
      metadata: { width: 640 },
    });
    const snap = eventWithDims(
      { type: "MESSAGES_SNAPSHOT", messages: [user] },
      dims,
    );
    expect(snap.messages[0]!.content[1]).toMatchObject({
      metadata: { height: 480 },
    });
    const result = eventWithDims(
      { type: "TOOL_CALL_RESULT", content: toolText },
      dims,
    );
    expect(filesFromToolResult(result.content)[0]).toMatchObject({
      width: 1024,
    });
    const other = { type: "TEXT_MESSAGE_CONTENT", delta: "x" };
    expect(eventWithDims(other, dims)).toBe(other);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("image dims store", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const owner = `imgdim-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID()}`;
  const files = url
    ? createChatFiles(database, {
        encryptionKey: Buffer.alloc(32).toString("base64"),
        ownsBot: async (o, b) => o === owner && b === bot,
        env: {},
      })
    : (null as never);
  const dimsStore = url ? createImageDims(database) : (null as never);

  beforeAll(async () => {
    await files.ensure();
    await dimsStore.ensure();
  });
  afterAll(async () => {
    const ids = await database.$client.unsafe<{ id: string }[]>(
      "SELECT id FROM chisabot_chat_files WHERE owner_user_id = $1",
      [owner],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_image_dims WHERE key = ANY(string_to_array($1, ','))",
      [ids.map((r) => `cf:${r.id}`).join(",")],
    );
    await database.$client.unsafe(
      "DELETE FROM chisabot_chat_files WHERE owner_user_id = $1",
      [owner],
    );
  });

  test("upload records dims and returns them in the view", async () => {
    const view = await files.upload(owner, bot, {
      name: "p.webp",
      bytes: Buffer.from(bytes("webp_alpha")),
    });
    expect(view).toMatchObject({ width: 37, height: 21 });
    const [row] = await database.$client.unsafe<
      { width: number; height: number }[]
    >("SELECT width, height FROM chisabot_image_dims WHERE key = $1", [
      `cf:${view.id}`,
    ]);
    expect(row).toEqual({ width: 37, height: 21 });
    const text = await files.upload(owner, bot, {
      name: "t.txt",
      bytes: Buffer.from("hello"),
    });
    expect(text.width).toBeUndefined();
  });

  test("old images without a record are measured lazily on first read, then cached", async () => {
    const id = randomUUID();
    await database.$client.unsafe(
      "INSERT INTO chisabot_chat_files (id, owner_user_id, agent_id, kind, name, mime_type, size_bytes, bytes) VALUES ($1, $2, $3, 'upload', 'old.jpg', 'image/jpeg', $4, $5)",
      [
        id,
        owner,
        bot,
        bytes("jpeg_rot").length,
        Buffer.from(bytes("jpeg_rot")),
      ],
    );
    const messages = [
      {
        id: "u",
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "url", value: `/api/chat-files/${id}` },
          },
        ],
      },
    ];
    const [out] = await dimsStore.annotateMessages(messages);
    expect((out as (typeof messages)[number]).content[0]).toMatchObject({
      metadata: { width: 21, height: 37 },
    });
    const [row] = await database.$client.unsafe<{ width: number }[]>(
      "SELECT width FROM chisabot_image_dims WHERE key = $1",
      [`cf:${id}`],
    );
    expect(row?.width).toBe(21);
    // 不存在 / 不是图：记成 0×0，不往外给。
    const missing = randomUUID();
    const none = await dimsStore.lookup([`cf:${missing}`]);
    expect(none.size).toBe(0);
    const [zero] = await database.$client.unsafe<{ width: number }[]>(
      "SELECT width FROM chisabot_image_dims WHERE key = $1",
      [`cf:${missing}`],
    );
    expect(zero?.width).toBe(0);
    await database.$client.unsafe(
      "DELETE FROM chisabot_image_dims WHERE key = $1",
      [`cf:${missing}`],
    );
  });
});
