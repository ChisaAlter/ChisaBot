import { describe, expect, test } from "bun:test";
import {
  buildFfmpegKeyframeArgs,
  buildFfmpegWavArgs,
  FFMPEG_PROTOCOL_WHITELIST,
  type FfmpegSpawnFn,
  isDangerousPlaylistHeader,
  transcodeTo16kMonoWav,
} from "../src/audio/ffmpeg-transcode";
import { createSpeechService } from "../src/audio/speech-service";
import {
  MAX_AVATAR_IMAGE_DIMENSION,
  MAX_AVATAR_IMAGE_PIXELS,
  validateAvatarImage,
} from "../src/bot-avatars/validate-image";

function buildPng(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(33);
  const view = new DataView(buf.buffer);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13, false);
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  buf[24] = 8;
  buf[25] = 2;
  return buf;
}

function buildJpeg(
  width: number,
  height: number,
  sofMarker = 0xc0,
): Uint8Array {
  // SOI + APP0 (length 4) + SOF0/SOF2 (length 11) + EOI
  const buf = new Uint8Array(2 + 6 + 13 + 2);
  const view = new DataView(buf.buffer);
  let pos = 0;
  buf[pos++] = 0xff;
  buf[pos++] = 0xd8; // SOI
  buf[pos++] = 0xff;
  buf[pos++] = 0xe0; // APP0
  view.setUint16(pos, 4, false);
  pos += 4;
  buf[pos++] = 0xff;
  buf[pos++] = sofMarker;
  view.setUint16(pos, 11, false);
  buf[pos + 2] = 8; // precision
  view.setUint16(pos + 3, height, false);
  view.setUint16(pos + 5, width, false);
  pos += 11;
  buf[pos++] = 0xff;
  buf[pos++] = 0xd9; // EOI
  return buf;
}

function buildWebpVp8(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 22, true);
  buf.set(new TextEncoder().encode("WEBPVP8 "), 8);
  view.setUint32(16, 10, true);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return buf;
}

function buildWebpVp8l(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(25);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 17, true);
  buf.set(new TextEncoder().encode("WEBPVP8L"), 8);
  view.setUint32(16, 5, true);
  buf[20] = 0x2f;
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  view.setUint32(21, packed >>> 0, true);
  return buf;
}

function buildWebpVp8x(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(30);
  const view = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 22, true);
  buf.set(new TextEncoder().encode("WEBPVP8X"), 8);
  view.setUint32(16, 10, true);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >>> 8) & 0xff;
  buf[26] = (w >>> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >>> 8) & 0xff;
  buf[29] = (h >>> 16) & 0xff;
  return buf;
}

describe("头像二进制防像素炸弹校验（PNG / JPEG / WebP）", () => {
  test("正确解析合法 PNG、JPEG（SOF0/SOF2）与 WebP（VP8/VP8L/VP8X）像素尺寸", () => {
    const png = validateAvatarImage(buildPng(512, 384));
    expect(png).toEqual({
      ok: true,
      image: { mime: "image/png", width: 512, height: 384, pixels: 512 * 384 },
    });

    const jpg0 = validateAvatarImage(buildJpeg(1024, 768, 0xc0));
    expect(jpg0).toEqual({
      ok: true,
      image: {
        mime: "image/jpeg",
        width: 1024,
        height: 768,
        pixels: 1024 * 768,
      },
    });

    const jpg2 = validateAvatarImage(buildJpeg(640, 480, 0xc2));
    expect(jpg2).toEqual({
      ok: true,
      image: { mime: "image/jpeg", width: 640, height: 480, pixels: 640 * 480 },
    });

    const vp8 = validateAvatarImage(buildWebpVp8(256, 256));
    expect(vp8).toEqual({
      ok: true,
      image: { mime: "image/webp", width: 256, height: 256, pixels: 65536 },
    });

    const vp8l = validateAvatarImage(buildWebpVp8l(320, 180));
    expect(vp8l).toEqual({
      ok: true,
      image: { mime: "image/webp", width: 320, height: 180, pixels: 57600 },
    });

    const vp8x = validateAvatarImage(buildWebpVp8x(800, 600));
    expect(vp8x).toEqual({
      ok: true,
      image: { mime: "image/webp", width: 800, height: 600, pixels: 480000 },
    });
  });

  test("拦截超过 8192×8192 或总像素超过 33,554,432 的像素炸弹", () => {
    expect(MAX_AVATAR_IMAGE_DIMENSION).toBe(8192);
    expect(MAX_AVATAR_IMAGE_PIXELS).toBe(33_554_432);

    // 单边超 8192（PNG）
    const widePng = validateAvatarImage(buildPng(8193, 100));
    expect(widePng.ok).toBe(false);
    if (!widePng.ok) expect(widePng.code).toBe("pixel-bomb");

    // 边长在 8192 内但总像素 6000×6000 = 36,000,000 > 33,554,432（JPEG）
    const denseJpg = validateAvatarImage(buildJpeg(6000, 6000));
    expect(denseJpg.ok).toBe(false);
    if (!denseJpg.ok) expect(denseJpg.code).toBe("pixel-bomb");

    // WebP VP8X 超大像素炸弹
    const bombWebp = validateAvatarImage(buildWebpVp8x(9000, 9000));
    expect(bombWebp.ok).toBe(false);
    if (!bombWebp.ok) expect(bombWebp.code).toBe("pixel-bomb");

    // 刚好踩在合法上限 8192×4096 = 33,554,432 放行
    const exactLimit = validateAvatarImage(buildPng(8192, 4096));
    expect(exactLimit.ok).toBe(true);
  });

  test("拒绝畸形魔数、伪造扩展名（SVG/脚本）与截断文件头", () => {
    expect(validateAvatarImage(new Uint8Array(0)).ok).toBe(false);

    const fakeSvg = validateAvatarImage(
      new TextEncoder().encode("<svg onload='alert(1)'></svg>"),
    );
    expect(fakeSvg.ok).toBe(false);
    if (!fakeSvg.ok) expect(fakeSvg.code).toBe("unsupported-format");

    const truncatedPng = validateAvatarImage(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    );
    expect(truncatedPng.ok).toBe(false);
    if (!truncatedPng.ok) expect(truncatedPng.code).toBe("truncated");

    const truncatedJpeg = validateAvatarImage(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]),
    );
    expect(truncatedJpeg.ok).toBe(false);
    if (!truncatedJpeg.ok) expect(truncatedJpeg.code).toBe("truncated");

    const truncatedWebp = validateAvatarImage(
      new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 "),
    );
    expect(truncatedWebp.ok).toBe(false);
    if (!truncatedWebp.ok) expect(truncatedWebp.code).toBe("truncated");
  });
});

describe("FFmpeg 安全音频转码与 SpeechService 前置集成", () => {
  test("buildFfmpegWavArgs 与 buildFfmpegKeyframeArgs 强制纯管道 -protocol_whitelist pipe（不含 file）", () => {
    expect(FFMPEG_PROTOCOL_WHITELIST).toBe("pipe");
    for (const args of [buildFfmpegWavArgs(), buildFfmpegKeyframeArgs(4)]) {
      const wlIdx = args.indexOf("-protocol_whitelist");
      expect(wlIdx).toBeGreaterThanOrEqual(0);
      expect(args[wlIdx + 1]).toBe("pipe");
      expect(args).not.toContain("file,pipe");
      expect(args).toContain("pipe:0");
      expect(args).toContain("pipe:1");
    }
    const wavArgs = buildFfmpegWavArgs();
    expect(wavArgs).toContain("16000");
    expect(wavArgs).toContain("wav");
  });

  test("拒绝 ffconcat / #EXTM3U 播放列表头与超限输入（零子进程调用）", async () => {
    let spawned = false;
    const neverSpawn: FfmpegSpawnFn = () => {
      spawned = true;
      throw new Error("should not spawn");
    };

    const ffconcat = new TextEncoder().encode(
      "ffconcat version 1.0\nfile '/etc/passwd'\n",
    );
    expect(isDangerousPlaylistHeader(ffconcat)).toBe(true);
    const res1 = await transcodeTo16kMonoWav(ffconcat, { spawn: neverSpawn });
    expect(res1.transcoded).toBe(false);
    expect(res1.reason).toBe("playlist-input-rejected");
    expect(spawned).toBe(false);

    const hlsPlaylist = new TextEncoder().encode(
      "\uFEFF#EXTM3U\n#EXT-X-TARGETDURATION:10\nfile:///etc/hosts\n",
    );
    expect(isDangerousPlaylistHeader(hlsPlaylist)).toBe(true);
    const res2 = await transcodeTo16kMonoWav(hlsPlaylist, {
      spawn: neverSpawn,
    });
    expect(res2.transcoded).toBe(false);
    expect(res2.reason).toBe("playlist-input-rejected");
    expect(spawned).toBe(false);

    // 正常 Ogg 二进制不误拦
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
    expect(isDangerousPlaylistHeader(ogg)).toBe(false);

    // 输入超过 maxInputBytes 拦截
    const tooBig = new Uint8Array(2048);
    const res3 = await transcodeTo16kMonoWav(tooBig, {
      maxInputBytes: 1024,
      spawn: neverSpawn,
    });
    expect(res3.transcoded).toBe(false);
    expect(res3.reason).toBe("input-too-large");
    expect(spawned).toBe(false);
  });

  test("成功转码返回 WAV 字节；输出超限、真实超时强杀、大 stderr 与无 ffmpeg 均优雅处理", async () => {
    const original = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]);
    const fakeWav = new TextEncoder().encode("RIFF\x24\x00\x00\x00WAVEfmt ");

    // 1. 正常转码（含超 64 KiB 大量 stderr 持续排空不阻塞）
    let capturedCmd: string[] = [];
    let stderrChunksRead = 0;
    const okSpawn: FfmpegSpawnFn = (cmd) => {
      capturedCmd = cmd;
      return {
        stdin: { write: () => original.length, end: () => {} },
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(fakeWav);
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          pull(controller) {
            if (stderrChunksRead < 8) {
              stderrChunksRead += 1;
              controller.enqueue(new Uint8Array(16 * 1024));
            } else {
              controller.close();
            }
          },
        }),
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    const ok = await transcodeTo16kMonoWav(original, {
      ffmpegPath: "/usr/bin/ffmpeg",
      spawn: okSpawn,
    });
    expect(ok.transcoded).toBe(true);
    expect(ok.mimeType).toBe("audio/wav");
    expect(ok.bytes).toEqual(fakeWav);
    expect(stderrChunksRead).toBe(8);
    expect(capturedCmd[0]).toBe("/usr/bin/ffmpeg");
    expect(capturedCmd).toContain("pipe");
    expect(capturedCmd).not.toContain("file,pipe");

    // 2. 本机未安装 ffmpeg（ENOENT）：优雅降级返回原始字节不抛错
    const missingSpawn: FfmpegSpawnFn = () => {
      throw new Error("ENOENT: ffmpeg not found");
    };
    const missing = await transcodeTo16kMonoWav(original, {
      spawn: missingSpawn,
    });
    expect(missing.transcoded).toBe(false);
    expect(missing.reason).toBe("ffmpeg-unavailable");
    expect(missing.bytes).toEqual(original);

    // 3. 输出超过上限触发 kill 并优雅降级
    let killedOnOverflow = false;
    const hugeSpawn: FfmpegSpawnFn = () => ({
      stdin: { write: () => original.length, end: () => {} },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2048));
          controller.close();
        },
      }),
      stderr: null,
      exited: Promise.resolve(0),
      kill: () => {
        killedOnOverflow = true;
      },
    });
    const overflow = await transcodeTo16kMonoWav(original, {
      maxOutputBytes: 1024,
      spawn: hugeSpawn,
    });
    expect(overflow.transcoded).toBe(false);
    expect(overflow.reason).toBe("output-too-large");
    expect(killedOnOverflow).toBe(true);
    expect(overflow.bytes).toEqual(original);

    // 4. 真实超时触发 SIGKILL 强杀并优雅降级
    const killSignals: Array<number | NodeJS.Signals | undefined> = [];
    let resolveHangingExit: ((code: number) => void) | null = null;
    const hangingSpawn: FfmpegSpawnFn = () => ({
      stdin: { write: () => original.length, end: () => {} },
      stdout: new ReadableStream({
        start() {
          // 模拟进程卡死不产出数据也不关闭
        },
      }),
      stderr: null,
      exited: new Promise<number>((resolve) => {
        resolveHangingExit = resolve;
      }),
      kill: (sig) => {
        killSignals.push(sig);
        resolveHangingExit?.(137);
      },
    });
    const timedOut = await transcodeTo16kMonoWav(original, {
      timeoutMs: 60,
      spawn: hangingSpawn,
    });
    expect(timedOut.transcoded).toBe(false);
    expect(timedOut.reason).toBe("timeout");
    expect(killSignals).toContain("SIGKILL");
    expect(timedOut.bytes).toEqual(original);
  });

  test("speechService.transcribeAudio 对非 wav 音频前置转码，对 wav 直接放行", async () => {
    const fakeWav = new TextEncoder().encode("RIFF\x24\x00\x00\x00WAVEfmt ");
    let transcodeCalls = 0;
    const uploadedMimes: string[] = [];
    const uploadedNames: string[] = [];

    const service = createSpeechService({
      getConfig: () => ({
        asr: {
          baseUrl: "https://asr.example.test/v1",
          model: "whisper-1",
          apiKey: "asr-key",
        },
      }),
      transcodeAudio: async () => {
        transcodeCalls += 1;
        return {
          bytes: fakeWav,
          transcoded: true,
          mimeType: "audio/wav",
        };
      },
      transport: async (_url, init) => {
        if (init.body instanceof FormData) {
          const uploaded = init.body.get("file");
          if (uploaded instanceof File) {
            uploadedMimes.push(uploaded.type);
            uploadedNames.push(uploaded.name);
          }
        }
        return Response.json({ text: "你好世界" });
      },
    });

    // 非 wav（ogg）触发转码并转换为 .wav 上送
    const oggRes = await service.transcribeAudio({
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    });
    expect(oggRes.text).toBe("你好世界");
    expect(transcodeCalls).toBe(1);
    expect(uploadedMimes[0]).toBe("audio/wav");
    expect(uploadedNames[0]).toBe("voice.wav");

    // 已是 wav 不重复转码
    await service.transcribeAudio({
      data: fakeWav,
      mimeType: "audio/wav",
      fileName: "already.wav",
    });
    expect(transcodeCalls).toBe(1);
    expect(uploadedMimes[1]).toBe("audio/wav");
  });
});
