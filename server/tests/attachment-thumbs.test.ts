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
  type SharpLike,
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
