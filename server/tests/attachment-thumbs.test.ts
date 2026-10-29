import { describe, expect, spyOn, test } from "bun:test";
import sharp from "sharp";
import {
  ATTACHMENT_THUMB_WIDTHS,
  attachmentThumbUrl,
  parseAttachmentThumbWidth,
  pickAttachmentThumbWidth,
} from "../../shared/attachments";
import {
  createThumbnailer,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUED,
  loadSharp,
  SHARP_LOAD_FAILED_WARNING,
  type SharpLike,
  type SharpModule,
} from "../src/channels/attachment-thumbs";

/** 一张带噪点的照片样的图：纯色图压得太好，测不出「比原图小」。 */
async function photo(
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp" | "gif" = "png",
): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 2654435761) >>> 24;
  }
  const buffer = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .toFormat(format)
    .toBuffer();
  return new Uint8Array(buffer);
}

const realSharp = async () => sharp as unknown as SharpLike;

/** 数一数真的缩了几次。 */
function countingSharp() {
  const calls = { count: 0 };
  const load = async (): Promise<SharpLike> =>
    ((input: Uint8Array, options: Parameters<SharpLike>[1]) => {
      calls.count += 1;
      return (sharp as unknown as SharpLike)(input, options);
    }) as SharpLike;
  return { calls, load };
}

describe("thumbnail width tiers", () => {
  test("only the fixed tiers parse, written exactly", () => {
    for (const width of ATTACHMENT_THUMB_WIDTHS) {
      expect(parseAttachmentThumbWidth(String(width))).toBe(width);
    }
    for (const value of [
      "",
      "0",
      "100",
      "481",
      "480.0",
      "0480",
      " 480",
      "-480",
      "1e3",
      "abc",
    ]) {
      expect(parseAttachmentThumbWidth(value)).toBeNull();
    }
  });

  test("picks the smallest tier that is sharp enough for the screen", () => {
    expect(pickAttachmentThumbWidth(220, 1)).toBe(240);
    expect(pickAttachmentThumbWidth(220, 2)).toBe(480);
    expect(pickAttachmentThumbWidth(320, 1)).toBe(480);
    expect(pickAttachmentThumbWidth(320, 2)).toBe(960);
    expect(pickAttachmentThumbWidth(320, 3)).toBe(960);
    expect(pickAttachmentThumbWidth(220, Number.NaN)).toBe(240);
  });

  test("builds the thumb url next to any existing query", () => {
    expect(attachmentThumbUrl("/api/attachments/x", 480)).toBe(
      "/api/attachments/x?w=480",
    );
    expect(attachmentThumbUrl("/api/attachments/x?v=2", 240)).toBe(
      "/api/attachments/x?v=2&w=240",
    );
  });
});

describe("createThumbnailer", () => {
  test("shrinks a wide photo to the tier as WebP, smaller than the original", async () => {
    const original = await photo(1600, 1200);
    const thumbs = createThumbnailer({ load: realSharp });

    const result = await thumbs.thumbnail("a", 480, "image/png", original);

    expect(result.kind).toBe("thumb");
    if (result.kind !== "thumb") return;
    expect(result.mimeType).toBe("image/webp");
    expect(result.bytes.byteLength).toBeLessThan(original.byteLength);
    const meta = await sharp(result.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(360);
  });

  test("keeps the original when it is not wider than the tier", async () => {
    const thumbs = createThumbnailer({ load: realSharp });
    const original = await photo(400, 300, "jpeg");
    expect(
      (await thumbs.thumbnail("narrow", 480, "image/jpeg", original)).kind,
    ).toBe("original");
  });

  test("never touches GIFs or non-images", async () => {
    const { calls, load } = countingSharp();
    const thumbs = createThumbnailer({ load });
    const gif = await photo(800, 600, "gif");
    expect((await thumbs.thumbnail("g", 240, "image/gif", gif)).kind).toBe(
      "original",
    );
    expect(
      (await thumbs.thumbnail("t", 240, "text/plain", new Uint8Array(10))).kind,
    ).toBe("original");
    expect(calls.count).toBe(0);
  });

  test("falls back to the original when sharp is missing or the bytes do not decode", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const missing = createThumbnailer({ load: async () => null });
      expect(
        (
          await missing.thumbnail(
            "m",
            480,
            "image/png",
            await photo(1600, 1200),
          )
        ).kind,
      ).toBe("original");

      const broken = createThumbnailer({ load: realSharp });
      const garbage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      expect(
        (await broken.thumbnail("b", 480, "image/png", garbage)).kind,
      ).toBe("original");
    } finally {
      warn.mockRestore();
    }
  });

  test("remembers results, including 'use the original', and computes each once", async () => {
    const { calls, load } = countingSharp();
    const thumbs = createThumbnailer({ load });
    const original = await photo(1600, 1200);

    expect(thumbs.cached("c", 480)).toBeUndefined();
    const [first, second] = await Promise.all([
      thumbs.thumbnail("c", 480, "image/png", original),
      thumbs.thumbnail("c", 480, "image/png", original),
    ]);
    expect(calls.count).toBe(1);
    expect(first).toBe(second);
    expect(thumbs.cached("c", 480)).toBe(first);
    // 另一档是另一项。
    await thumbs.thumbnail("c", 240, "image/png", original);
    expect(calls.count).toBe(2);

    const narrow = await photo(200, 100);
    await thumbs.thumbnail("n", 240, "image/png", narrow);
    expect(thumbs.cached("n", 240)).toEqual({ kind: "original" });
  });

  test("evicts the least recently used entries past the byte budget", async () => {
    const original = await photo(1600, 1200);
    const probe = createThumbnailer({ load: realSharp });
    const one = await probe.thumbnail("p", 240, "image/png", original);
    if (one.kind !== "thumb") throw new Error("expected a thumbnail");
    const size = one.bytes.byteLength;

    // 正好放得下两张。
    const thumbs = createThumbnailer({
      load: realSharp,
      maxCacheBytes: size * 2 + 10,
    });
    await thumbs.thumbnail("a", 240, "image/png", original);
    await thumbs.thumbnail("b", 240, "image/png", original);
    thumbs.cached("a", 240); // a 刚用过，b 成了最久没用的
    await thumbs.thumbnail("c", 240, "image/png", original);

    expect(thumbs.cached("a", 240)?.kind).toBe("thumb");
    expect(thumbs.cached("b", 240)).toBeUndefined();
    expect(thumbs.cached("c", 240)?.kind).toBe("thumb");
  });

  test("does not cache an entry bigger than the per-entry limit", async () => {
    const thumbs = createThumbnailer({ load: realSharp, maxEntryBytes: 16 });
    const result = await thumbs.thumbnail(
      "big",
      480,
      "image/png",
      await photo(1600, 1200),
    );
    expect(result.kind).toBe("thumb");
    expect(thumbs.cached("big", 480)).toBeUndefined();
  });
});

/**
 * 一个假的 sharp：`toBuffer` 等测试放行才回来，记着同时有几张在缩。`gates` 放行成功，`fails` 里同一位置的
 * 函数让它异步失败（reject）。
 */
function gatedSharp() {
  const state = { started: [] as number[], active: 0, peak: 0 };
  const gates: Array<() => void> = [];
  const fails: Array<() => void> = [];
  const load = async (): Promise<SharpLike> =>
    ((input: Uint8Array) => {
      state.started.push(input.byteLength);
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      const chain = {
        metadata: async () => ({ width: 2000, height: 1000, pages: 1 }),
        rotate: () => chain,
        resize: () => chain,
        timeout: () => chain,
        webp: () => chain,
        toBuffer: () =>
          new Promise<Uint8Array>((resolve, reject) => {
            gates.push(() => {
              fails.shift();
              state.active -= 1;
              resolve(new Uint8Array(10));
            });
            fails.push(() => {
              gates.shift();
              state.active -= 1;
              reject(new Error("libvips: VipsJpeg: premature end of input"));
            });
          }),
      };
      return chain;
    }) as unknown as SharpLike;
  return { state, gates, fails, load };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("concurrency limit", () => {
  test("at most two thumbnails are computed at once; the third waits its turn", async () => {
    expect(DEFAULT_MAX_CONCURRENT).toBe(2);
    const fake = gatedSharp();
    const thumbs = createThumbnailer({ load: fake.load });
    const original = (size: number) => new Uint8Array(size);

    const first = thumbs.thumbnail("a", 240, "image/png", original(1001));
    const second = thumbs.thumbnail("b", 240, "image/png", original(1002));
    const third = thumbs.thumbnail("c", 240, "image/png", original(1003));
    await flush();

    // 前两张在缩，第三张还没碰到 sharp。
    expect(fake.state.started).toEqual([1001, 1002]);
    expect(fake.state.active).toBe(2);
    let thirdDone = false;
    void third.then(() => {
      thirdDone = true;
    });

    // 放掉第一张：第三张接上，同时在缩的仍是两张。
    fake.gates.shift()?.();
    expect((await first).kind).toBe("thumb");
    await flush();
    expect(fake.state.started).toEqual([1001, 1002, 1003]);
    expect(fake.state.active).toBe(2);
    expect(thirdDone).toBe(false);

    fake.gates.shift()?.();
    fake.gates.shift()?.();
    expect((await second).kind).toBe("thumb");
    expect((await third).kind).toBe("thumb");
    expect(fake.state.peak).toBe(2);
  });

  test("a failed thumbnail gives its slot back", async () => {
    let calls = 0;
    const thumbs = createThumbnailer({
      maxConcurrent: 1,
      load: async () =>
        ((input: Uint8Array) => {
          calls += 1;
          if (input.byteLength === 1) throw new Error("corrupt");
          return (sharp as unknown as SharpLike)(input, {
            limitInputPixels: 1e8,
            failOn: "error",
          });
        }) as unknown as SharpLike,
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        (await thumbs.thumbnail("bad", 240, "image/png", new Uint8Array(1)))
          .kind,
      ).toBe("original");
    } finally {
      warn.mockRestore();
    }
    const good = await thumbs.thumbnail(
      "good",
      240,
      "image/png",
      await photo(800, 600),
    );
    expect(good.kind).toBe("thumb");
    expect(calls).toBe(2);
  });

  test("GIFs and other non-resizable originals do not queue behind work in progress", async () => {
    const fake = gatedSharp();
    const thumbs = createThumbnailer({ load: fake.load, maxConcurrent: 1 });
    const busy = thumbs.thumbnail("a", 240, "image/png", new Uint8Array(1001));
    await flush();
    // 唯一的名额被占着，GIF 照样马上回原图。
    expect(
      (await thumbs.thumbnail("g", 240, "image/gif", new Uint8Array(5))).kind,
    ).toBe("original");
    fake.gates.shift()?.();
    await busy;
  });

  test("a real cache hit answers at once and never takes a place in the queue", async () => {
    const fake = gatedSharp();
    const thumbs = createThumbnailer({
      load: fake.load,
      maxConcurrent: 1,
      maxQueued: 0,
    });
    const first = thumbs.thumbnail(
      "hit",
      240,
      "image/png",
      new Uint8Array(1001),
    );
    await flush();
    fake.gates.shift()?.();
    const cached = await first;
    expect(cached.kind).toBe("thumb");

    // 唯一的名额被占着、队列长度为 0：不是命中的话只能回原图。
    const busy = thumbs.thumbnail(
      "busy",
      240,
      "image/png",
      new Uint8Array(1002),
    );
    await flush();
    expect(fake.state.active).toBe(1);
    const again = await thumbs.thumbnail(
      "hit",
      240,
      "image/png",
      new Uint8Array(1001),
    );
    expect(again).toBe(cached);
    expect(fake.state.started).toEqual([1001, 1002]);

    fake.gates.shift()?.();
    await busy;
  });

  test("an asynchronous failure (toBuffer rejects) gives its slot back", async () => {
    const fake = gatedSharp();
    const thumbs = createThumbnailer({ load: fake.load, maxConcurrent: 1 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bad = thumbs.thumbnail(
        "bad",
        240,
        "image/png",
        new Uint8Array(1001),
      );
      const next = thumbs.thumbnail(
        "next",
        240,
        "image/png",
        new Uint8Array(1002),
      );
      await flush();
      expect(fake.state.started).toEqual([1001]);

      fake.fails.shift()?.();
      expect((await bad).kind).toBe("original");
      await flush();
      // 名额交给了排着的那一张，没有卡住。
      expect(fake.state.started).toEqual([1001, 1002]);
      expect(fake.state.active).toBe(1);
      fake.gates.shift()?.();
      expect((await next).kind).toBe("thumb");

      // 名额回到空闲：再来一张直接开始。
      const later = thumbs.thumbnail(
        "later",
        240,
        "image/png",
        new Uint8Array(1003),
      );
      await flush();
      expect(fake.state.started).toEqual([1001, 1002, 1003]);
      fake.gates.shift()?.();
      expect((await later).kind).toBe("thumb");
    } finally {
      warn.mockRestore();
    }
  });

  test("the same item asked for again while it waits shares one place in the queue", async () => {
    const fake = gatedSharp();
    const thumbs = createThumbnailer({
      load: fake.load,
      maxConcurrent: 1,
      maxQueued: 1,
    });
    const busy = thumbs.thumbnail("a", 240, "image/png", new Uint8Array(1001));
    const queued = thumbs.thumbnail(
      "q",
      240,
      "image/png",
      new Uint8Array(1002),
    );
    const twice = thumbs.thumbnail("q", 240, "image/png", new Uint8Array(1002));
    await flush();
    // 同一项共用同一个 Promise，只占一个排队位置。
    expect(twice).toBe(queued);

    fake.gates.shift()?.();
    await busy;
    await flush();
    fake.gates.shift()?.();
    expect((await queued).kind).toBe("thumb");
    expect(await twice).toBe(await queued);
    expect(fake.state.started).toEqual([1001, 1002]);
  });

  test("past eight waiting, a new request gets the original at once and is not cached", async () => {
    expect(DEFAULT_MAX_QUEUED).toBe(8);
    const fake = gatedSharp();
    const thumbs = createThumbnailer({ load: fake.load });
    const running = Array.from({ length: DEFAULT_MAX_CONCURRENT }, (_, i) =>
      thumbs.thumbnail(`run${i}`, 240, "image/png", new Uint8Array(2000 + i)),
    );
    const waiting = Array.from({ length: DEFAULT_MAX_QUEUED }, (_, i) =>
      thumbs.thumbnail(`wait${i}`, 240, "image/png", new Uint8Array(3000 + i)),
    );
    await flush();
    expect(fake.state.started).toHaveLength(DEFAULT_MAX_CONCURRENT);

    // 第九个排队的：不等，直接回原图，没碰 sharp。
    const overflow = await thumbs.thumbnail(
      "over",
      240,
      "image/png",
      new Uint8Array(4000),
    );
    expect(overflow).toEqual({ kind: "original" });
    expect(fake.state.started).toHaveLength(DEFAULT_MAX_CONCURRENT);
    // 只是这一刻忙：不记进缓存，下次再来还会试着缩。
    expect(thumbs.cached("over", 240)).toBeUndefined();

    // 放掉全部，排着的都缩完。
    for (let i = 0; i < DEFAULT_MAX_CONCURRENT + DEFAULT_MAX_QUEUED; i++) {
      await flush();
      fake.gates.shift()?.();
    }
    const results = await Promise.all([...running, ...waiting]);
    expect(results.every((result) => result.kind === "thumb")).toBe(true);
    expect(fake.state.peak).toBe(DEFAULT_MAX_CONCURRENT);

    // 空下来以后，同一项能正常缩。
    const retry = thumbs.thumbnail(
      "over",
      240,
      "image/png",
      new Uint8Array(4000),
    );
    await flush();
    fake.gates.shift()?.();
    expect((await retry).kind).toBe("thumb");
  });
});

describe("loading sharp", () => {
  test("sets one libvips thread and no libvips cache", async () => {
    const calls: string[] = [];
    const module: SharpModule = {
      default: Object.assign(() => ({}), {
        cache: (enabled: boolean) => calls.push(`cache(${enabled})`),
        concurrency: (threads: number) => calls.push(`concurrency(${threads})`),
      }),
    };
    expect(await loadSharp(async () => module)).not.toBeNull();
    expect(calls).toEqual(["cache(false)", "concurrency(1)"]);
  });

  test("the real module loads on this machine and ends up single-threaded", async () => {
    expect(await loadSharp()).not.toBeNull();
    expect(sharp.concurrency()).toBe(1);
  });

  test("a failed load warns once, clearly, and every image falls back to the original", async () => {
    const warnings: Array<[string, string]> = [];
    let imports = 0;
    const thumbs = createThumbnailer({
      load: () =>
        loadSharp(
          async () => {
            imports += 1;
            throw new Error(
              'Could not load the "sharp" module using the linux-x64 runtime',
            );
          },
          (message, detail) => warnings.push([message, detail]),
        ),
    });
    const original = await photo(800, 600);
    const results = await Promise.all([
      thumbs.thumbnail("a", 240, "image/png", original),
      thumbs.thumbnail("b", 480, "image/png", original),
    ]);
    results.push(await thumbs.thumbnail("c", 240, "image/jpeg", original));

    expect(results.map((result) => result.kind)).toEqual([
      "original",
      "original",
      "original",
    ]);
    expect(imports).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe(SHARP_LOAD_FAILED_WARNING);
    expect(warnings[0]?.[0]).toContain("thumbnails (?w=) are OFF");
    expect(warnings[0]?.[1]).toContain("linux-x64");
  });

  test("the default warning goes to console.warn", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await loadSharp(async () => {
          throw new Error("missing");
        }),
      ).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe(SHARP_LOAD_FAILED_WARNING);
    } finally {
      warn.mockRestore();
    }
  });
});
