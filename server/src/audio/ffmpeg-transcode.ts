/**
 * FFmpeg 统一音频转码与视频关键帧安全抽样封装。
 *
 * 安全红线：
 * - 强制 `-protocol_whitelist file,pipe`：阻断输入流中暗藏的 http/https/concat/hls 协议 SSRF 与任意文件读取；
 * - 仅走 `pipe:0` -> `pipe:1` 内存管道，零临时文件残留；
 * - 严格超时熔断与 32 MiB 输出字节上限，防解压/转码炸弹耗尽内存；
 * - 本机未安装 `ffmpeg`（ENOENT）或转码异常时优雅降级返回原始字节，绝不中断业务主链路。
 */

export const FFMPEG_PROTOCOL_WHITELIST = "file,pipe";
export const DEFAULT_FFMPEG_TIMEOUT_MS = 15_000;
export const MAX_TRANSCODED_WAV_BYTES = 32 * 1024 * 1024;
export const MAX_KEYFRAME_OUTPUT_BYTES = 8 * 1024 * 1024;

export type TranscodeToWavResult = {
  bytes: Uint8Array;
  transcoded: boolean;
  mimeType: string;
  reason?: string;
};

export type FfmpegSpawnProcess = {
  stdin?: {
    write(chunk: Uint8Array): number | Promise<number>;
    end(): void | Promise<void>;
  } | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
};

export type FfmpegSpawnFn = (
  cmd: string[],
  options: {
    stdin: "pipe";
    stdout: "pipe";
    stderr: "pipe";
  },
) => FfmpegSpawnProcess;

export type TranscodeToWavOptions = {
  ffmpegPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 仅用于单测注入假进程，生产默认走 `Bun.spawn`。 */
  spawn?: FfmpegSpawnFn;
};

/** 构造统一的 16kHz 单声道 WAV 转码参数（强制协议白名单）。 */
export function buildFfmpegWavArgs(): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    FFMPEG_PROTOCOL_WHITELIST,
    "-i",
    "pipe:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "wav",
    "pipe:1",
  ];
}

/** 构造安全视频等距关键帧抽样参数（单路 MJPEG 流经 pipe:1 输出，强制协议白名单）。 */
export function buildFfmpegKeyframeArgs(frameCount: number): string[] {
  const safeCount = Math.min(Math.max(Math.trunc(frameCount) || 4, 1), 8);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-protocol_whitelist",
    FFMPEG_PROTOCOL_WHITELIST,
    "-i",
    "pipe:0",
    "-vf",
    "fps=1/2,scale='min(768,iw)':-2",
    "-frames:v",
    String(safeCount),
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "5",
    "pipe:1",
  ];
}

const defaultSpawn: FfmpegSpawnFn = (cmd, options) =>
  Bun.spawn(cmd, options) as unknown as FfmpegSpawnProcess;

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
  onLimitExceeded: () => void,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        onLimitExceeded();
        await reader.cancel().catch(() => {});
        return { bytes: new Uint8Array(0), exceeded: true };
      }
      chunks.push(value);
    }
  } catch {
    return { bytes: new Uint8Array(0), exceeded: false };
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: merged, exceeded: false };
}

async function runFfmpegPipe(
  inputBytes: Uint8Array,
  args: string[],
  options: TranscodeToWavOptions,
  defaultMaxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  const ffmpegPath = options.ffmpegPath?.trim() || "ffmpeg";
  const timeoutMs = Math.max(
    500,
    options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
  );
  const maxOutputBytes = Math.max(
    1024,
    options.maxOutputBytes ?? defaultMaxBytes,
  );
  const spawnFn = options.spawn ?? defaultSpawn;

  let proc: FfmpegSpawnProcess;
  try {
    proc = spawnFn([ffmpegPath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { ok: false, reason: "ffmpeg-unavailable" };
  }

  let timedOut = false;
  let exceeded = false;
  const killSafely = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // 进程可能已退出
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killSafely();
  }, timeoutMs);

  try {
    const writeInput = (async () => {
      try {
        if (proc.stdin) {
          await proc.stdin.write(inputBytes);
          await proc.stdin.end();
        }
      } catch {
        // ffmpeg 提前退出或输入不可解码时会触发 EPIPE，交给退出码判定
      }
    })();

    const readStdout = readBoundedStream(proc.stdout, maxOutputBytes, () => {
      exceeded = true;
      killSafely();
    });
    const drainStderr = readBoundedStream(proc.stderr, 32 * 1024, () => {});

    const [, out, , exitCode] = await Promise.all([
      writeInput,
      readStdout,
      drainStderr,
      proc.exited.catch(() => -1),
    ]);

    if (timedOut) return { ok: false, reason: "timeout" };
    if (exceeded || out.exceeded)
      return { ok: false, reason: "output-too-large" };
    if (exitCode !== 0 || out.bytes.byteLength === 0) {
      return { ok: false, reason: `ffmpeg-exit-${exitCode}` };
    }
    return { ok: true, bytes: out.bytes };
  } catch {
    killSafely();
    return { ok: false, reason: "ffmpeg-error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 将任意音频字节转码为 16kHz 单声道 WAV。
 * 若本机未安装 ffmpeg、超时、输出超 32 MiB 或转码失败，则优雅降级返回原始字节且不抛错。
 */
export async function transcodeTo16kMonoWav(
  inputBytes: Uint8Array,
  options: TranscodeToWavOptions = {},
): Promise<TranscodeToWavResult> {
  if (inputBytes.byteLength === 0) {
    return {
      bytes: inputBytes,
      transcoded: false,
      mimeType: "application/octet-stream",
      reason: "empty-input",
    };
  }

  const result = await runFfmpegPipe(
    inputBytes,
    buildFfmpegWavArgs(),
    options,
    MAX_TRANSCODED_WAV_BYTES,
  );
  if (!result.ok) {
    return {
      bytes: inputBytes,
      transcoded: false,
      mimeType: "application/octet-stream",
      reason: result.reason,
    };
  }
  return {
    bytes: result.bytes,
    transcoded: true,
    mimeType: "audio/wav",
  };
}

/** 从连续 MJPEG 字节流中按 JPEG SOI (FF D8) / EOI (FF D9) 切分单帧。 */
export function splitMjpegFrames(stream: Uint8Array): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let i = 0; i < stream.length - 1; i += 1) {
    if (start < 0 && stream[i] === 0xff && stream[i + 1] === 0xd8) {
      start = i;
      i += 1;
      continue;
    }
    if (start >= 0 && stream[i] === 0xff && stream[i + 1] === 0xd9) {
      frames.push(Buffer.from(stream.subarray(start, i + 2)));
      start = -1;
      i += 1;
    }
  }
  return frames;
}

/**
 * 使用 FFmpeg（严格 `-protocol_whitelist file,pipe`）从视频中抽取最多 `frameCount` 张关键帧 JPEG。
 * 本机无 ffmpeg 或抽帧失败时优雅返回空数组。
 */
export async function extractVideoKeyframes(
  inputBytes: Uint8Array,
  options: TranscodeToWavOptions & { frameCount?: number } = {},
): Promise<Buffer[]> {
  if (inputBytes.byteLength === 0) return [];
  const count = Math.min(Math.max(Math.trunc(options.frameCount ?? 4), 1), 8);
  const result = await runFfmpegPipe(
    inputBytes,
    buildFfmpegKeyframeArgs(count),
    options,
    MAX_KEYFRAME_OUTPUT_BYTES,
  );
  if (!result.ok) return [];
  return splitMjpegFrames(result.bytes).slice(0, count);
}

/**
 * 使用安全 FFmpeg 管道将过大的 AI 生成头像缩放到 256×256 JPEG（≤256KB）；无 ffmpeg 时返回 null。
 */
export async function shrinkAvatarImageToJpeg(
  inputBytes: Uint8Array,
  options: TranscodeToWavOptions = {},
): Promise<Uint8Array | null> {
  if (inputBytes.byteLength === 0) return null;
  const result = await runFfmpegPipe(
    inputBytes,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      FFMPEG_PROTOCOL_WHITELIST,
      "-i",
      "pipe:0",
      "-vf",
      "scale=256:256:force_original_aspect_ratio=increase,crop=256:256",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-q:v",
      "4",
      "pipe:1",
    ],
    options,
    256 * 1024,
  );
  return result.ok ? result.bytes : null;
}
