import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { MAX_AVATAR_BYTES } from "../../shared/bot-avatars";

/**
 * 审查 10-16：头像工具函数的单测——renderAvatar（压缩阶梯、透明）、loadAvatarSource（类型、大小、解码失败）、
 * saveAvatarDraft（各种草稿、失败信息、跨标签页广播）、头像表查询（404 当默认、500 报错）。
 * happy-dom 没有真 canvas / 图片解码：这里换成记录调用的替身，测的是我们的决策，不是浏览器的编码器。
 */

let avatars: typeof import("@/lib/agents/avatars");
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  avatars = await import("@/lib/agents/avatars");
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Op = string;
function fakeCanvas(encoder: (type: string, quality: number) => Blob | null) {
  const ops: Op[] = [];
  const context = {
    imageSmoothingQuality: "low",
    globalCompositeOperation: "source-over",
    fillStyle: "",
    fillRect: () =>
      ops.push(`fill:${context.globalCompositeOperation}:${context.fillStyle}`),
    drawImage: () => ops.push("draw"),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob: (
      done: (blob: Blob | null) => void,
      type: string,
      quality: number,
    ) => {
      ops.push(`encode:${type}:${quality}`);
      done(encoder(type, quality));
    },
  };
  const original = document.createElement.bind(document);
  document.createElement = ((tag: string) =>
    tag === "canvas" ? canvas : original(tag)) as typeof document.createElement;
  return { ops, restore: () => (document.createElement = original) };
}

const blobOf = (type: string, size: number) =>
  new Blob([new Uint8Array(size)], { type });

describe("renderAvatar", () => {
  test("keeps transparency: WebP is drawn without any fill (10-8)", async () => {
    const fake = fakeCanvas((type) => blobOf(type, 1000));
    try {
      const blob = await avatars.renderAvatar({} as CanvasImageSource, {
        x: 0,
        y: 0,
        size: 100,
      });
      expect(blob.type).toBe("image/webp");
      expect(fake.ops.some((op) => op.startsWith("fill"))).toBe(false);
    } finally {
      fake.restore();
    }
  });

  test("falls back to JPEG with a white backing only behind the image", async () => {
    const fake = fakeCanvas((type) =>
      type === "image/webp" ? blobOf("image/png", 10) : blobOf(type, 1000),
    );
    try {
      const blob = await avatars.renderAvatar({} as CanvasImageSource, {
        x: 0,
        y: 0,
        size: 100,
      });
      expect(blob.type).toBe("image/jpeg");
      expect(fake.ops).toContain("fill:destination-over:#ffffff");
    } finally {
      fake.restore();
    }
  });

  test("walks the quality ladder until it fits, then gives up with a sentence", async () => {
    const fake = fakeCanvas((type, quality) =>
      blobOf(type, quality > 0.6 ? MAX_AVATAR_BYTES + 1 : 100),
    );
    try {
      await avatars.renderAvatar({} as CanvasImageSource, {
        x: 0,
        y: 0,
        size: 100,
      });
      expect(
        fake.ops.filter((op) => op.startsWith("encode:image/webp")),
      ).toEqual([
        "encode:image/webp:0.86",
        "encode:image/webp:0.75",
        "encode:image/webp:0.6",
      ]);
    } finally {
      fake.restore();
    }
    const huge = fakeCanvas((type) => blobOf(type, MAX_AVATAR_BYTES + 1));
    try {
      await expect(
        avatars.renderAvatar({} as CanvasImageSource, {
          x: 0,
          y: 0,
          size: 100,
        }),
      ).rejects.toThrow("太大");
    } finally {
      huge.restore();
    }
  });
});

describe("loadAvatarSource", () => {
  const OriginalImage = globalThis.Image;
  let decodeFails = false;
  let dims = { w: 400, h: 300 };
  beforeEach(() => {
    decodeFails = false;
    dims = { w: 400, h: 300 };
    globalThis.Image = class {
      decoding = "";
      src = "";
      get naturalWidth() {
        return dims.w;
      }
      get naturalHeight() {
        return dims.h;
      }
      decode() {
        return decodeFails
          ? Promise.reject(new Error("bad"))
          : Promise.resolve();
      }
    } as unknown as typeof Image;
  });
  afterEach(() => {
    globalThis.Image = OriginalImage;
  });

  test("accepts the advertised formats", async () => {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/bmp",
    ]) {
      const loaded = await avatars.loadAvatarSource(
        new File([new Uint8Array(10)], "a", { type }),
      );
      expect(loaded.image.naturalWidth).toBe(400);
    }
  });

  test("rejects SVG and non-images with the same format list the picker shows (10-6)", async () => {
    for (const [name, type] of [
      ["v.svg", "image/svg+xml"],
      ["doc.pdf", "application/pdf"],
      // 不是每个浏览器都能解码（Chrome 解不了 HEIC），提示里也不写。
      ["photo.heic", "image/heic"],
      ["photo.avif", "image/avif"],
    ] as const) {
      await expect(
        avatars.loadAvatarSource(new File(["x"], name, { type })),
      ).rejects.toThrow(avatars.ACCEPTED_AVATAR_HINT);
    }
  });

  test("too big and undecodable files say so", async () => {
    const big = new File(
      [new Uint8Array(avatars.MAX_SOURCE_BYTES + 1)],
      "big.png",
      { type: "image/png" },
    );
    await expect(avatars.loadAvatarSource(big)).rejects.toThrow("15 MB");
    decodeFails = true;
    await expect(
      avatars.loadAvatarSource(
        new File(["x"], "fake.png", { type: "image/png" }),
      ),
    ).rejects.toThrow("打不开");
  });

  test("small images get a resolution hint, big ones don't (10-9)", () => {
    expect(avatars.smallSourceHint(16, 16)).toContain("16×16");
    expect(avatars.smallSourceHint(512, 512)).toBeNull();
  });
});

describe("saveAvatarDraft + sync", () => {
  const originalFetch = global.fetch;
  let calls: string[] = [];
  let status = 200;
  beforeEach(() => {
    calls = [];
    status = 200;
    global.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (status !== 200)
          return Response.json({ error: "服务器坏了" }, { status });
        return Response.json({
          avatars: { "bot-1": { kind: "emoji", emoji: "🐶", color: "sky" } },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("keep does nothing; default deletes; emoji puts; image puts the blob", async () => {
    const client = new QueryClient();
    await avatars.saveAvatarDraft(client, "bot-1", { kind: "keep" });
    expect(calls).toEqual([]);
    await avatars.saveAvatarDraft(client, "bot-1", { kind: "default" });
    await avatars.saveAvatarDraft(client, "bot-1", {
      kind: "emoji",
      emoji: "🐶",
      color: "sky",
    });
    await avatars.saveAvatarDraft(client, "bot-1", {
      kind: "image",
      blob: blobOf("image/webp", 10),
      previewUrl: "blob:x",
    });
    expect(calls).toEqual([
      "DELETE /api/bot-avatars/bot-1",
      "PUT /api/bot-avatars/bot-1",
      "PUT /api/bot-avatars/bot-1/image",
    ]);
  });

  test("a failed image upload throws the server's sentence", async () => {
    status = 500;
    await expect(
      avatars.saveAvatarDraft(new QueryClient(), "bot-1", {
        kind: "image",
        blob: blobOf("image/webp", 10),
        previewUrl: "blob:x",
      }),
    ).rejects.toThrow("服务器坏了");
  });

  test("a save in one tab invalidates the avatar table in another (10-2)", async () => {
    const otherTab = new QueryClient();
    otherTab.setQueryData(avatars.avatarKeys.all, {});
    const unsubscribe = avatars.subscribeAvatarSync(otherTab);
    try {
      // 另一个标签页的 BroadcastChannel 收得到；同一个实例自己发的收不到，所以这里另开一个频道发。
      const sender = new BroadcastChannel("chisabot:bot-avatars");
      sender.postMessage({ type: "avatar-changed", agentId: "bot-1" });
      sender.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        otherTab.getQueryState(avatars.avatarKeys.all)?.isInvalidated,
      ).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("window focus refetches the avatar table only once it is stale (10-2)", () => {
    const options = avatars.botAvatarsQueryOptions();
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.staleTime).toBe(5 * 60_000);
  });

  test("avatar table: 404 means everyone has the default; 500 is an error (10-3)", async () => {
    const fn = avatars.botAvatarsQueryOptions()
      .queryFn as () => Promise<unknown>;
    status = 404;
    expect(await fn()).toEqual({});
    status = 500;
    await expect(fn()).rejects.toThrow("无法加载头像");
    status = 200;
    expect(await fn()).toEqual({
      "bot-1": { kind: "emoji", emoji: "🐶", color: "sky" },
    });
  });
});
