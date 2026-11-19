import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import desktopVoiceAudio from "../../pc/src/voice-audio.js";
import {
  SentenceChunker,
  sanitizeSpeechSentence,
  VOICE_FRAME_SAMPLES,
  VOICE_SAMPLE_RATE,
  VOICE_WS_PROTOCOL_PREFIX,
  type VoiceServerEvent,
} from "../../shared/voice-call";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";
import {
  analyzePcm16Frame,
  decodeBase64Pcm16,
  encodePcm16ToWav,
  VoiceActivityDetector,
} from "../src/voice/voice-audio";
import { VoiceOnset } from "../src/voice/voice-onset";
import { VoicePlaybackTracker } from "../src/voice/voice-playback";
import { createVoiceCallService } from "../src/voice/voice-routes";
import {
  VoiceSession,
  type VoiceSocketLike,
  type VoiceSpokenTurnRecord,
} from "../src/voice/voice-session";
import {
  createVoiceStreamTts,
  VoiceStreamTtsError,
} from "../src/voice/voice-stream-tts";

/** 生成指定帧数（每帧 20ms @ 24kHz）的正弦语音测试 PCM16LE 数据。 */
function makeSpeechPcm(
  frames: number,
  amplitude = 6_000,
  freqHz = 440,
): Buffer {
  const totalSamples = frames * VOICE_FRAME_SAMPLES;
  const buf = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * freqHz * i) / VOICE_SAMPLE_RATE) * amplitude,
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/** 生成指定帧数的静音 PCM16LE 数据。 */
function makeSilencePcm(frames: number): Buffer {
  return Buffer.alloc(frames * VOICE_FRAME_SAMPLES * 2);
}

/** 创建测试用假 WebSocket 连接，记录所有服务端推送事件与关闭码。 */
function createFakeSocket() {
  const sent: VoiceServerEvent[] = [];
  let readyState = 1;
  let bufferedAmount = 0;
  let closedCode: number | undefined;
  let closedReason: string | undefined;

  const ws: VoiceSocketLike & {
    sent: VoiceServerEvent[];
    setBufferedAmount: (bytes: number) => void;
    getClosed: () => { code?: number; reason?: string };
  } = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    sent,
    setBufferedAmount(bytes: number) {
      bufferedAmount = bytes;
    },
    getClosed() {
      return { code: closedCode, reason: closedReason };
    },
    send(data: string) {
      sent.push(JSON.parse(data) as VoiceServerEvent);
    },
    close(code?: number, reason?: string) {
      readyState = 3;
      closedCode = code;
      closedReason = reason;
    },
  };
  return ws;
}

function flushMicrotasks(rounds = 8): Promise<void> {
  return new Promise((resolve) => {
    let remaining = rounds;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(step, 5);
    };
    step();
  });
}

describe("SentenceChunker 流式增量分句器", () => {
  test("按中英文句末标点即时切句，保留小数点与英文缩写不误切", () => {
    const chunker = new SentenceChunker();

    expect(chunker.push("你好")).toEqual([]);
    expect(chunker.push("！")).toEqual(["你好！"]);

    expect(chunker.push("圆周率约等于 3.")).toEqual([]);
    expect(chunker.push("14，Dr.")).toEqual([]);
    expect(chunker.push(" Smith says hello. ")).toEqual([
      "圆周率约等于 3.14，Dr. Smith says hello.",
    ]);

    expect(chunker.push("Are you ready? Yes")).toEqual(["Are you ready?"]);
    expect(chunker.flush()).toBe("Yes");
    expect(chunker.flush()).toBeNull();
  });

  test("超过软上限优先在子句停顿点切分，超过硬上限按 UTF-16 安全边界保底切分", () => {
    const chunker = new SentenceChunker({
      softMaxChars: 24,
      hardMaxChars: 40,
      minClauseChars: 8,
    });
    const out = chunker.push(
      "这是一段没有句号但带有逗号的长文本，前面这里应该先切出来给语音合成播报",
    );
    expect(out.length).toBe(1);
    expect(out[0]).toBe("这是一段没有句号但带有逗号的长文本，");
    expect(chunker.flush()).toBe("前面这里应该先切出来给语音合成播报");

    // 无标点且带 emoji（UTF-16 代理对）时不会切碎代理对。
    const hardChunker = new SentenceChunker({
      softMaxChars: 16,
      hardMaxChars: 26,
      minClauseChars: 6,
    });
    const emojiWall = `${"哈".repeat(25)}🚀继续说`;
    const hardOut = hardChunker.push(emojiWall);
    expect(hardOut.length).toBe(1);
    expect(hardOut[0]).toBe("哈".repeat(25));
    expect(hardChunker.flush()).toBe("🚀继续说");
  });

  test("sanitizeSpeechSentence 清理 Markdown 标记同时保留可读正文", () => {
    expect(
      sanitizeSpeechSentence(
        "### **重点**：查看 [官方文档](https://example.com) 的 `voice-call` 说明",
      ),
    ).toBe("重点：查看 官方文档 的 voice-call 说明");
  });
});

describe("分态 VAD 与起音状态机（VoiceOnset + VoiceActivityDetector）", () => {
  test("静默等待态低延迟（>=120ms）秒拾「好/嗯/停」单字短词且保留 pre-roll", () => {
    const starts: Array<{ audioStartMs: number; strict: boolean }> = [];
    const ends: Array<{ pcm: Buffer; durationMs: number }> = [];
    const vad = new VoiceActivityDetector({
      silenceMs: 200,
      onStart: (ev) =>
        starts.push({ audioStartMs: ev.audioStartMs, strict: ev.strict }),
      onEnd: (ev) => ends.push({ pcm: ev.pcm, durationMs: ev.durationMs }),
    });

    vad.setSpeaking(false);
    // 先喂 200ms 静音（10 帧），再喂 160ms 单字短词（8 帧），再喂 240ms 静音触发提交。
    vad.append(makeSilencePcm(10));
    vad.append(makeSpeechPcm(8));
    expect(starts.length).toBe(1);
    expect(starts[0]?.strict).toBe(false);
    // pre-roll 保留了开口前静音帧，所以 audioStartMs 明显早于确认时刻（320ms）。
    expect(starts[0]?.audioStartMs).toBeLessThan(200);

    vad.append(makeSilencePcm(12));
    expect(ends.length).toBe(1);
    expect(ends[0]?.pcm.byteLength).toBeGreaterThan(
      8 * VOICE_FRAME_SAMPLES * 2,
    );
  });

  test("扬声器播报态拒绝短回声脉冲，仅确认持续人声（voiced>=420ms & span>=500ms）且允许句内短停顿", () => {
    const starts: Array<{ strict: boolean }> = [];
    const vad = new VoiceActivityDetector({
      onStart: (ev) => starts.push({ strict: ev.strict }),
    });

    vad.setSpeaking(true);
    // 1. 300ms 回声瞬态（15 帧）+ 600ms 静音（30 帧）必须被拒绝，绝不误打断！
    vad.append(makeSpeechPcm(15));
    vad.append(makeSilencePcm(30));
    expect(starts.length).toBe(0);

    // 2. 用户持续插话：12 帧（240ms）+ 4 帧句内短停顿（80ms）+ 10 帧（200ms）→ voiced=440ms, span=520ms → 确认打断！
    vad.append(makeSpeechPcm(12));
    vad.append(makeSilencePcm(4));
    vad.append(makeSpeechPcm(10));
    expect(starts.length).toBe(1);
    expect(starts[0]?.strict).toBe(true);
  });

  test("播报结束后绝不中途放松已在播报期启动的候选窗", () => {
    const onset = new VoiceOnset();
    // 在 speaking=true 时开始 200ms（10 帧）疑似回声候选。
    for (let i = 0; i < 10; i += 1) {
      const res = onset.push(true, { speaking: true });
      expect(res.confirmed).toBe(false);
    }
    // 播报恰好在此时结束（speaking 翻转为 false），但已启动候选仍保持 strict，不能在 220ms 就立刻放行！
    const next = onset.push(true, { speaking: false });
    expect(next.confirmed).toBe(false);
    expect(onset.pending?.strict).toBe(true);
  });

  test("音频工具：WAV 编码头、base64 校验与直流偏移过滤", () => {
    const pcm = makeSpeechPcm(2);
    const wav = encodePcm16ToWav(pcm);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.byteLength).toBe(44 + pcm.byteLength);

    const decoded = decodeBase64Pcm16(pcm.toString("base64"));
    expect(decoded.equals(pcm)).toBe(true);
    expect(() => decodeBase64Pcm16("not-valid!!!")).toThrow();

    // 纯直流常数帧（ZCR = 0）即使能量高也应有 zcr=0。
    const dcFrame = Buffer.alloc(VOICE_FRAME_SAMPLES * 2);
    for (let i = 0; i < VOICE_FRAME_SAMPLES; i += 1) {
      dcFrame.writeInt16LE(1500, i * 2);
    }
    const metrics = analyzePcm16Frame(dcFrame);
    expect(metrics.zcr).toBe(0);
    expect(metrics.rms).toBeCloseTo(1500, 1);
  });
});

describe("VoicePlaybackTracker 播放排空追踪器", () => {
  test("按字节估算时长 + playback.done 后保留 500ms 尾音保护 + 2000ms 丢包兜底 + 无 AEC 半双工门控", () => {
    let clock = 10_000;
    const tracker = new VoicePlaybackTracker({
      now: () => clock,
      tailGuardMs: 500,
      missingReceiptTimeoutMs: 2_000,
    });

    expect(tracker.isPlaying()).toBe(false);
    expect(tracker.shouldGateCapture(false)).toBe(false);

    // 下发 48,000 字节 = 1000ms @ 24kHz PCM16LE。
    tracker.append("s0", 48_000);
    expect(tracker.isPlaying()).toBe(true);
    // 无客户端 AEC 时自动半双工门控；有 AEC 时保持持续拾音。
    expect(tracker.shouldGateCapture(false)).toBe(true);
    expect(tracker.shouldGateCapture(true)).toBe(false);

    // 收到客户端排空回执后进入 500ms 尾音保护期。
    clock += 900;
    expect(tracker.finish("s0")).toBe(true);
    expect(tracker.isPlaying()).toBe(true);
    clock += 499;
    expect(tracker.isPlaying()).toBe(true);
    clock += 1;
    expect(tracker.isPlaying()).toBe(false);

    // 模拟回执丢失：下发 500ms 音频，超过 500 + 2000ms 兜底自动释放。
    tracker.append("s1", 24_000);
    clock += 2_499;
    expect(tracker.isPlaying()).toBe(true);
    clock += 2;
    expect(tracker.isPlaying()).toBe(false);
  });
});

describe("createVoiceStreamTts 流式 PCM16 TTS 合成器", () => {
  test("OpenAI 与 Fish Audio 请求格式正确，且按 2 字节采样边界切块防 OOM", async () => {
    const requests: Array<{
      url: string;
      headers: Record<string, string>;
      body: unknown;
    }> = [];

    const tts = createVoiceStreamTts({
      resolveConfig: () => ({
        provider: "fish",
        baseUrl: "https://api.fish.audio",
        model: "s1",
        voice: "ref-voice-1",
        speed: 1.1,
        apiKey: "secret-key",
      }),
      chunkBytes: 10,
      maxSentenceBytes: 32,
      transport: async (url, init) => {
        requests.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          body: JSON.parse(String(init.body)),
        });
        // 故意拆分奇数字节块（7 + 9 = 16 bytes）测试 2 字节采样边界重组与 10 字节切块。
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
            controller.enqueue(
              new Uint8Array([8, 9, 10, 11, 12, 13, 14, 15, 16]),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "audio/pcm" },
        });
      },
    });

    const out: Buffer[] = [];
    for await (const chunk of tts.stream({ text: "测试流式合成。" })) {
      expect(chunk.byteLength % 2).toBe(0);
      expect(chunk.byteLength).toBeLessThanOrEqual(10);
      out.push(chunk);
    }

    expect(Buffer.concat(out).byteLength).toBe(16);
    expect(requests[0]?.url).toBe("https://api.fish.audio/v1/tts");
    expect(requests[0]?.headers.authorization).toBe("Bearer secret-key");
    expect(requests[0]?.headers.model).toBe("s1");
    expect(requests[0]?.body).toEqual({
      text: "测试流式合成。",
      format: "pcm",
      sample_rate: VOICE_SAMPLE_RATE,
      latency: "balanced",
      prosody: { speed: 1.1 },
      reference_id: "ref-voice-1",
    });

    // 超出 maxSentenceBytes 必须直接拦截防 OOM。
    const oomTts = createVoiceStreamTts({
      resolveConfig: () => ({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "tts-1",
      }),
      chunkBytes: 10,
      maxSentenceBytes: 24_000,
      transport: async () =>
        new Response(new Uint8Array(25_000), {
          status: 200,
          headers: { "content-type": "audio/pcm" },
        }),
    });

    let caught: unknown;
    try {
      for await (const _chunk of oomTts.stream({ text: "超长音频" })) {
        // drain
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VoiceStreamTtsError);
  });
});

describe("VoiceSession 全链路状态机（流式分句首字开口 + 真中止推理 + 仅已播报入史）", () => {
  test("流式分句 TTS：LLM 吐出首句立即推送音频，不等整轮推理结束", async () => {
    const ws = createFakeSocket();
    const spokenHistory: VoiceSpokenTurnRecord[] = [];
    let releaseSecondSentence: (() => void) | undefined;
    const secondSentenceGate = new Promise<void>((resolve) => {
      releaseSecondSentence = resolve;
    });

    const session = new VoiceSession({
      ws,
      userId: "u1",
      botId: "bot1",
      channelId: "ch1",
      audioProcessing: "web-aec-v1",
      silenceMs: 120,
      heartbeatMs: 0,
      maxSessionMs: 0,
      transcribe: async () => ({ text: "你好" }),
      runBotTurn: async ({ onTextDelta }) => {
        onTextDelta("第一句话先播出来。");
        await secondSentenceGate;
        onTextDelta("第二句话稍后到达。");
        return { replyText: "第一句话先播出来。第二句话稍后到达。" };
      },
      synthesizeStream: async function* ({ text }) {
        // 每句产出一块 960 字节（20ms）PCM。
        yield Buffer.alloc(960, text.charCodeAt(0) & 0xff);
      },
      recordSpokenTurn: (rec) => {
        spokenHistory.push(rec);
      },
    });

    // 模拟用户在静默态说出短词并停顿提交。
    const speechBase64 = makeSpeechPcm(8).toString("base64");
    const silenceBase64 = makeSilencePcm(8).toString("base64");
    session.handleRawMessage(
      JSON.stringify({ type: "audio.append", audio: speechBase64 }),
    );
    session.handleRawMessage(
      JSON.stringify({ type: "audio.append", audio: silenceBase64 }),
    );

    await flushMicrotasks(12);

    // 关键断言：第二句话的 gate 还没放行，第一句音频块已经到达客户端！
    const firstAudioChunks = ws.sent.filter(
      (e) => e.type === "assistant.audio.chunk",
    );
    expect(firstAudioChunks.length).toBe(1);
    expect(
      firstAudioChunks[0]?.type === "assistant.audio.chunk" &&
        firstAudioChunks[0].text,
    ).toBe("第一句话先播出来。");
    // 客户端尚未确认 playback.done，所以此时不入正式历史。
    expect(spokenHistory.length).toBe(0);

    // 放行第二句，随后客户端确认两句全部播放完成。
    releaseSecondSentence?.();
    await flushMicrotasks(12);

    const allAudioDone = ws.sent.filter(
      (e) => e.type === "assistant.audio.done",
    );
    expect(allAudioDone.length).toBe(2);

    for (const doneEv of allAudioDone) {
      if (doneEv.type === "assistant.audio.done") {
        session.handleRawMessage(
          JSON.stringify({ type: "playback.done", itemId: doneEv.itemId }),
        );
      }
    }
    await session.flushPendingCommits();

    expect(spokenHistory.length).toBe(1);
    expect(spokenHistory[0]?.spokenText).toBe(
      "第一句话先播出来。 第二句话稍后到达。",
    );
    expect(spokenHistory[0]?.draftText).toBeUndefined();
    expect(spokenHistory[0]?.interrupted).toBe(false);
    expect(session.currentState).toBe("listening");

    await session.close();
  });

  test("真打断中止在途推理与 TTS：立刻 abort() 信号，且仅把已确认播完句记入正式历史、未播完记草稿", async () => {
    const ws = createFakeSocket();
    const spokenHistory: VoiceSpokenTurnRecord[] = [];
    let capturedSignal: AbortSignal | undefined;
    let botTurnCount = 0;

    const session = new VoiceSession({
      ws,
      userId: "u1",
      botId: "bot1",
      channelId: "ch1",
      audioProcessing: "web-aec-v1",
      silenceMs: 120,
      heartbeatMs: 0,
      maxSessionMs: 0,
      transcribe: async () => ({
        text: botTurnCount === 0 ? "讲个长故事" : "停，换个话题",
      }),
      runBotTurn: async ({ signal, onTextDelta }) => {
        botTurnCount += 1;
        if (botTurnCount === 1) {
          capturedSignal = signal;
          onTextDelta("第一句已经播完。");
          onTextDelta("第二句还没来得及播完。");
          // 模拟长推理/工具仍在运行，直到被 signal 真正 abort。
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        onTextDelta("好的，我们换个话题。");
        return { replyText: "好的，我们换个话题。" };
      },
      synthesizeStream: async function* () {
        yield Buffer.alloc(4_800, 1);
      },
      recordSpokenTurn: (rec) => {
        spokenHistory.push(rec);
      },
    });

    // 第一轮：用户说话并提交。
    session.handleRawMessage(
      JSON.stringify({
        type: "audio.append",
        audio: makeSpeechPcm(8).toString("base64"),
      }),
    );
    session.handleRawMessage(
      JSON.stringify({
        type: "audio.append",
        audio: makeSilencePcm(8).toString("base64"),
      }),
    );
    await flushMicrotasks(12);

    // 客户端仅确认了第一句（s0）播完，尚未确认第二句（s1）。
    const doneEvents = ws.sent.filter((e) => e.type === "assistant.audio.done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(2);
    const firstItemId =
      doneEvents[0]?.type === "assistant.audio.done"
        ? doneEvents[0].itemId
        : "";
    session.handleRawMessage(
      JSON.stringify({ type: "playback.done", itemId: firstItemId }),
    );

    // 客户端或 VAD 触发打断！
    expect(capturedSignal?.aborted).toBe(false);
    session.handleRawMessage(JSON.stringify({ type: "barge_in" }));
    await session.flushPendingCommits();

    // 1. 在途推理的 AbortSignal 立刻被真中止！
    expect(capturedSignal?.aborted).toBe(true);
    // 2. 向客户端下发 barge_in 指令立即清空扬声器。
    expect(ws.sent.some((e) => e.type === "barge_in")).toBe(true);
    // 3. 正式历史仅记入已播报的第一句，未播完的第二句标记为未播报草稿。
    expect(spokenHistory.length).toBe(1);
    expect(spokenHistory[0]?.spokenText).toBe("第一句已经播完。");
    expect(spokenHistory[0]?.draftText).toBe("第二句还没来得及播完。");
    expect(spokenHistory[0]?.interrupted).toBe(true);

    // 4. 新话语零阻塞接管执行第二轮！
    session.handleRawMessage(
      JSON.stringify({
        type: "audio.append",
        audio: makeSpeechPcm(8).toString("base64"),
      }),
    );
    session.handleRawMessage(
      JSON.stringify({
        type: "audio.append",
        audio: makeSilencePcm(8).toString("base64"),
      }),
    );
    await flushMicrotasks(12);
    expect(botTurnCount).toBe(2);

    await session.close();
  });

  test("2MB 背压超限时主动断开慢客户端（WS 1013）", async () => {
    const ws = createFakeSocket();
    const session = new VoiceSession({
      ws,
      userId: "u1",
      botId: "bot1",
      channelId: "ch1",
      audioProcessing: "web-aec-v1",
      heartbeatMs: 0,
      maxSessionMs: 0,
      maxBackpressureBytes: 1_024,
      transcribe: async () => ({ text: "" }),
      synthesizeStream: async function* () {
        yield Buffer.alloc(4);
      },
      runBotTurn: async () => ({ replyText: "" }),
    });

    ws.setBufferedAmount(2_048);
    session.handleRawMessage(JSON.stringify({ type: "ping", ts: 123 }));
    expect(session.isClosed).toBe(true);
    expect(ws.getClosed().code).toBe(1013);
  });
});

describe("createVoiceCallService 票据防重放、严格 Origin 与并发上限", () => {
  function buildTestService(options?: {
    now?: () => number;
    asrReady?: boolean;
    ttsReady?: boolean;
  }) {
    const service = createVoiceCallService({
      now: options?.now,
      checkReady: async () => ({
        asrReady: options?.asrReady ?? true,
        ttsReady: options?.ttsReady ?? true,
      }),
      resolveTargetChannel: async (_actor, botId, channelId) =>
        botId === "missing"
          ? null
          : { channelId: channelId ?? `direct-${botId}` },
      transcribe: async () => ({ text: "" }),
      synthesizeStream: async function* () {
        yield Buffer.alloc(4);
      },
      runBotTurn: async () => ({ replyText: "" }),
      sessionDefaults: { heartbeatMs: 0, maxSessionMs: 0 },
    });

    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/api/voice",
      service.routes(async (c, next) => {
        const userId = c.req.header("x-test-user");
        if (!userId) return c.json({ error: "Authentication required." }, 401);
        const actor: AuthenticatedActor = {
          id: userId,
          email: `${userId}@example.com`,
          role: "user",
        };
        c.set("actor", actor);
        await next();
      }),
    );

    return { service, app };
  }

  test("60s 一次性随机票据防重放、过期失效、严格拒绝伪造 Origin 与自报 platform", async () => {
    let clock = 1_000_000;
    const { service, app } = buildTestService({ now: () => clock });

    // 未登录拒绝 401
    const unauth = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(unauth.status).toBe(401);

    // 传入未知 platform 字段被严格 schema 拦截（绝不信任客户端自报 platform）
    const withPlatform = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u1",
        },
        body: JSON.stringify({ botId: "bot-1", platform: "desktop" }),
      },
    );
    expect(withPlatform.status).toBe(400);

    // 正常签发 60s 票据
    const res = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u1",
        },
        body: JSON.stringify({
          botId: "bot-1",
          audioProcessing: "native-aec3-v1",
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const issued = (await res.json()) as { ticket: string; expiresAt: number };
    expect(issued.ticket.length).toBe(43);
    expect(issued.expiresAt).toBe(clock + 60_000);

    // 跨源 Origin / null / file:// 必须全部 403 拒绝！
    for (const badOrigin of ["https://evil.example.com", "null", "file://"]) {
      const badUpgrade = await service.prepareUpgrade(
        new Request("https://chat.example.com/api/voice/ws", {
          headers: {
            origin: badOrigin,
            "sec-websocket-protocol": `${VOICE_WS_PROTOCOL_PREFIX}${issued.ticket}`,
          },
        }),
      );
      expect(badUpgrade.ok).toBe(false);
      if (!badUpgrade.ok) expect(badUpgrade.status).toBe(403);
    }

    // 正常同源升级成功并原子消费票据
    const okUpgrade = await service.prepareUpgrade(
      new Request("https://chat.example.com/api/voice/ws", {
        headers: {
          origin: "https://chat.example.com",
          "sec-websocket-protocol": `${VOICE_WS_PROTOCOL_PREFIX}${issued.ticket}`,
        },
      }),
    );
    expect(okUpgrade.ok).toBe(true);
    if (okUpgrade.ok) {
      service.handleOpen(createFakeSocket(), okUpgrade.data);
    }

    // 同一票据二次重放必须 401 拒绝
    const replay = await service.prepareUpgrade(
      new Request("https://chat.example.com/api/voice/ws", {
        headers: {
          origin: "https://chat.example.com",
          "sec-websocket-protocol": `${VOICE_WS_PROTOCOL_PREFIX}${issued.ticket}`,
        },
      }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.status).toBe(401);

    // 过期票据测试（60s 后自动失效）
    const res2 = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u2",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    const issued2 = (await res2.json()) as { ticket: string };
    clock += 60_001;
    const expired = await service.prepareUpgrade(
      new Request("https://chat.example.com/api/voice/ws", {
        headers: {
          origin: "https://chat.example.com",
          "sec-websocket-protocol": `${VOICE_WS_PROTOCOL_PREFIX}${issued2.ticket}`,
        },
      }),
    );
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.status).toBe(401);

    await service.closeAll();
  });

  test("单用户并发 ≤ 1 与全局并发 ≤ 4，通话关闭后自动释放槽位", async () => {
    const { service, app } = buildTestService();
    const openDatas = [];

    // 4 个不同用户全部建立活跃通话
    for (const uid of ["u1", "u2", "u3", "u4"]) {
      const issuedRes = await app.request(
        "https://chat.example.com/api/voice/sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://chat.example.com",
            "x-test-user": uid,
          },
          body: JSON.stringify({ botId: "bot-1" }),
        },
      );
      expect(issuedRes.status).toBe(201);
      const { ticket } = (await issuedRes.json()) as { ticket: string };
      const up = await service.prepareUpgrade(
        new Request("https://chat.example.com/api/voice/ws", {
          headers: {
            origin: "https://chat.example.com",
            "sec-websocket-protocol": `${VOICE_WS_PROTOCOL_PREFIX}${ticket}`,
          },
        }),
      );
      expect(up.ok).toBe(true);
      if (up.ok) {
        service.handleOpen(createFakeSocket(), up.data);
        openDatas.push(up.data);
      }
    }
    expect(service.activeCallCount()).toBe(4);

    // u1 再发起第二路 → 409
    const dupUser = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u1",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(dupUser.status).toBe(409);

    // 第 5 个用户 u5 发起 → 全局上限 4 → 409
    const fifthUser = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u5",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(fifthUser.status).toBe(409);

    // 关闭 u1 通话后，u5 可正常签发
    const first = openDatas[0];
    if (first) service.handleClose(first);
    expect(service.activeCallCount()).toBe(3);

    const fifthRetry = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u5",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(fifthRetry.status).toBe(201);

    await service.closeAll();
  });

  test("ASR 或 TTS 未配置时返回 503 且 status.ready 为 false", async () => {
    const { app } = buildTestService({ asrReady: true, ttsReady: false });

    const statusRes = await app.request(
      "https://chat.example.com/api/voice/status",
      {
        headers: { "x-test-user": "u1" },
      },
    );
    expect(statusRes.status).toBe(200);
    expect(await statusRes.json()).toEqual({
      ready: false,
      asrReady: true,
      ttsReady: false,
      activeCalls: 0,
      maxCalls: 4,
    });

    const sessionRes = await app.request(
      "https://chat.example.com/api/voice/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chat.example.com",
          "x-test-user": "u1",
        },
        body: JSON.stringify({ botId: "bot-1" }),
      },
    );
    expect(sessionRes.status).toBe(503);
  });
});

describe("PC Electron 桌面端原生音频钩子", () => {
  test("硬件 AEC3 能力协商、首选约束生成与设备枚举规范化", async () => {
    expect(desktopVoiceAudio.detectDesktopAudioProcessing("win32")).toBe(
      "native-aec3-v1",
    );
    expect(desktopVoiceAudio.detectDesktopAudioProcessing("darwin")).toBe(
      "native-aec3-v1",
    );
    expect(desktopVoiceAudio.detectDesktopAudioProcessing("linux")).toBe(
      "web-aec-v1",
    );

    const preferred = desktopVoiceAudio.buildPreferredVoiceConstraints({
      platform: "win32",
      deviceId: "mic-usb-1",
    });
    expect(preferred.audioProcessing).toBe("native-aec3-v1");
    expect(preferred.constraints.echoCancellation).toBe(true);
    expect(preferred.constraints.deviceId).toEqual({ exact: "mic-usb-1" });

    const listed = await desktopVoiceAudio.enumerateAudioDevices({
      enumerateDevices: async () => [
        { deviceId: "default", groupId: "g1", kind: "audioinput", label: "" },
        {
          deviceId: "spk-1",
          groupId: "g2",
          kind: "audiooutput",
          label: "桌面音箱",
        },
        {
          deviceId: "cam-1",
          groupId: "g3",
          kind: "videoinput",
          label: "摄像头",
        },
      ],
    });
    expect(listed.inputs).toHaveLength(1);
    expect(listed.inputs[0]?.isDefault).toBe(true);
    expect(listed.inputs[0]?.label).toBe("默认麦克风");
    expect(listed.outputs).toHaveLength(1);
    expect(listed.outputs[0]?.label).toBe("桌面音箱");
  });
});
