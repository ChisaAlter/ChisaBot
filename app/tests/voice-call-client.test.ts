import { describe, expect, test } from "bun:test";
import {
  hasClientAec,
  parseVoiceClientEvent,
  parseVoiceServerEvent,
  serializeVoiceEvent,
  VOICE_SAMPLE_RATE,
} from "../../shared/voice-call";
import {
  buildVoiceWebSocketUrl,
  computeNormalizedAmplitude,
  computePcm16Amplitude,
  decodeBase64ToPcm16,
  detectAudioProcessingMode,
  encodePcm16ToBase64,
  float32ToPcm16,
  pcm16ToFloat32,
  resampleFloat32,
  resolveAudioProcessingFromTrack,
} from "../src/lib/voice/call-client";

describe("语音通话协议编解码", () => {
  test("客户端上行事件序列化与严格校验", () => {
    const appendJson = serializeVoiceEvent({
      type: "audio.append",
      audio: "AAAA",
    });
    expect(parseVoiceClientEvent(JSON.parse(appendJson))).toEqual({
      type: "audio.append",
      audio: "AAAA",
    });

    expect(
      parseVoiceClientEvent({ type: "playback.done", itemId: "t1:s0" }),
    ).toEqual({ type: "playback.done", itemId: "t1:s0" });
    expect(parseVoiceClientEvent({ type: "barge_in" })).toEqual({
      type: "barge_in",
    });
    expect(
      parseVoiceClientEvent({ type: "audio.append", audio: "" }),
    ).toBeNull();
    expect(parseVoiceClientEvent({ type: "unknown" })).toBeNull();
    expect(parseVoiceClientEvent(null)).toBeNull();
  });

  test("服务端下行事件序列化与严格校验", () => {
    const chunkEvent = {
      type: "assistant.audio.chunk" as const,
      turnId: "t1",
      itemId: "t1:s0",
      sentenceIndex: 0,
      text: "你好。",
      audio: "AQIDBA==",
    };
    expect(
      parseVoiceServerEvent(JSON.parse(serializeVoiceEvent(chunkEvent))),
    ).toEqual(chunkEvent);

    const commitEvent = {
      type: "assistant.spoken.commit" as const,
      turnId: "t1",
      itemId: "t1",
      spokenText: "你好。",
      draftText: "未播完草稿。",
      interrupted: true,
    };
    expect(parseVoiceServerEvent(commitEvent)).toEqual(commitEvent);

    expect(
      parseVoiceServerEvent({
        type: "state.change",
        state: "thinking",
        toolName: "web_search",
      }),
    ).toEqual({
      type: "state.change",
      state: "thinking",
      toolName: "web_search",
    });

    expect(
      parseVoiceServerEvent({ type: "state.change", state: "invalid-state" }),
    ).toBeNull();
    expect(hasClientAec("web-aec-v1")).toBe(true);
    expect(hasClientAec("native-aec3-v1")).toBe(true);
    expect(hasClientAec("legacy")).toBe(false);
  });

  test("根据页面协议自动生成 ws/wss 连接地址", () => {
    expect(
      buildVoiceWebSocketUrl("/api/voice/ws", {
        protocol: "https:",
        host: "bot.example.com",
      }),
    ).toBe("wss://bot.example.com/api/voice/ws");

    expect(
      buildVoiceWebSocketUrl("api/voice/ws", {
        protocol: "http:",
        host: "127.0.0.1:3000",
      }),
    ).toBe("ws://127.0.0.1:3000/api/voice/ws");
  });
});

describe("PCM16 重采样、编码与振幅计算", () => {
  test("48kHz 与 44.1kHz 线性插值重采样至 24kHz 保持长度与波形连续", () => {
    const src48k = new Float32Array(960); // 20ms @ 48kHz
    for (let i = 0; i < src48k.length; i += 1) {
      src48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5;
    }
    const dst24k = resampleFloat32(src48k, 48_000, VOICE_SAMPLE_RATE);
    expect(dst24k.length).toBe(480);
    // 峰值接近原始幅值 0.5
    let maxAbs = 0;
    for (const v of dst24k) {
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
    expect(maxAbs).toBeGreaterThan(0.48);
    expect(maxAbs).toBeLessThanOrEqual(0.51);

    // 44.1kHz -> 24kHz
    const src44k = new Float32Array(441); // 10ms @ 44.1kHz
    const dstFrom44k = resampleFloat32(src44k, 44_100, VOICE_SAMPLE_RATE);
    expect(dstFrom44k.length).toBe(240);

    // 同采样率返回独立副本
    const same = resampleFloat32(new Float32Array([0.2, -0.4]), 24_000, 24_000);
    expect(Array.from(same)).toEqual([Math.fround(0.2), Math.fround(-0.4)]);
  });

  test("Float32 <-> PCM16 量化夹持与 Base64 编解码无损往返", () => {
    const input = new Float32Array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5]);
    const pcm = float32ToPcm16(input);
    expect(Array.from(pcm)).toEqual([
      -32768, -32768, -16384, 0, 16384, 32767, 32767,
    ]);

    const base64 = encodePcm16ToBase64(pcm);
    const decoded = decodeBase64ToPcm16(base64);
    expect(Array.from(decoded)).toEqual(Array.from(pcm));

    const back = pcm16ToFloat32(decoded);
    expect(back[0]).toBeCloseTo(-1, 4);
    expect(back[2]).toBeCloseTo(-0.5, 4);
    expect(back[3]).toBe(0);
    expect(back[5]).toBeCloseTo(1, 4);
  });

  test("RMS 归一化振幅正确映射静音、人声与过载封顶", () => {
    expect(computeNormalizedAmplitude(new Float32Array(128))).toBe(0);
    expect(computePcm16Amplitude(new Int16Array(128))).toBe(0);

    const speech = new Float32Array(480);
    for (let i = 0; i < speech.length; i += 1) {
      speech[i] = Math.sin((2 * Math.PI * 300 * i) / VOICE_SAMPLE_RATE) * 0.2;
    }
    const amp = computeNormalizedAmplitude(speech);
    // 0.2 / sqrt(2) * 3.2 ≈ 0.4525
    expect(amp).toBeGreaterThan(0.4);
    expect(amp).toBeLessThan(0.55);

    const pcmAmp = computePcm16Amplitude(float32ToPcm16(speech));
    expect(Math.abs(pcmAmp - amp)).toBeLessThan(0.01);

    // 极响信号严格钳制在 1.0
    const loud = new Float32Array(64).fill(1);
    expect(computeNormalizedAmplitude(loud)).toBe(1);
  });

  test("审查回归 P1：无 AEC 浏览器与关闭 echoCancellation 的音轨正确降级为 legacy", () => {
    expect(
      detectAudioProcessingMode({
        getSupportedConstraints: () => ({ echoCancellation: true }),
      }),
    ).toBe("web-aec-v1");

    expect(
      detectAudioProcessingMode({
        getSupportedConstraints: () => ({ echoCancellation: false }),
      }),
    ).toBe("legacy");

    expect(
      detectAudioProcessingMode({
        getSupportedConstraints: () => ({}),
      }),
    ).toBe("legacy");

    expect(detectAudioProcessingMode(null)).toBe("legacy");

    // 音轨实际设置未启用回声消除时强制降级 legacy，启用时保留原模式
    expect(
      resolveAudioProcessingFromTrack("web-aec-v1", {
        getAudioTracks: () => [
          { getSettings: () => ({ echoCancellation: false }) },
        ],
      }),
    ).toBe("legacy");
    expect(
      resolveAudioProcessingFromTrack("native-aec3-v1", {
        getAudioTracks: () => [
          { getSettings: () => ({ echoCancellation: true }) },
        ],
      }),
    ).toBe("native-aec3-v1");
  });
});
