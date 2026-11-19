/**
 * ChisaBot 双向实时语音通话共享协议、状态定义与流式增量分句器。
 *
 * 前后端共用：不依赖 Node 或 DOM 专有 API。
 */

export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_FRAME_MS = 20;
export const VOICE_FRAME_SAMPLES = (VOICE_SAMPLE_RATE * VOICE_FRAME_MS) / 1000; // 480
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * 2; // 960 bytes (PCM16LE mono)
export const VOICE_MAX_AUDIO_BASE64_LEN = 256_000;
/** 单条 WS 原始消息字节上限（256KB base64 音频 + 8KB JSON 封包余量），在解码与 JSON.parse 前强制拦截。 */
export const VOICE_MAX_WS_PAYLOAD_BYTES = VOICE_MAX_AUDIO_BASE64_LEN + 8 * 1024;
export const VOICE_TICKET_TTL_MS = 60_000;
export const VOICE_MAX_GLOBAL_CALLS = 4;
export const VOICE_MAX_USER_CALLS = 1;
export const VOICE_MAX_SESSION_MS = 30 * 60_000;
export const VOICE_HEARTBEAT_MS = 30_000;
export const VOICE_MAX_BACKPRESSURE_BYTES = 2 * 1024 * 1024;
export const VOICE_WS_PATH = "/api/voice/ws";
export const VOICE_WS_PROTOCOL_PREFIX = "chisabot-voice-ticket.";

export const VOICE_AUDIO_PROCESSING_MODES = [
  "web-aec-v1",
  "native-aec3-v1",
  "legacy",
] as const;

export type VoiceAudioProcessing =
  (typeof VOICE_AUDIO_PROCESSING_MODES)[number];

export const VOICE_CALL_STATES = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "error",
] as const;

export type VoiceCallState = (typeof VOICE_CALL_STATES)[number];

export type VoiceSessionCreateRequest = {
  botId: string;
  channelId?: string;
  audioProcessing?: VoiceAudioProcessing;
  voice?: string;
  speed?: number;
};

export type VoiceSessionTicketResponse = {
  ticket: string;
  callId: string;
  websocketPath: string;
  sampleRate: number;
  audioProcessing: VoiceAudioProcessing;
  expiresAt: number;
};

export type VoiceStatusResponse = {
  ready: boolean;
  asrReady: boolean;
  ttsReady: boolean;
  activeCalls: number;
  maxCalls: number;
};

export type VoiceClientEvent =
  | { type: "audio.append"; audio: string }
  | { type: "audio.commit" }
  | { type: "playback.done"; itemId: string }
  | { type: "barge_in" }
  | { type: "ping"; ts?: number }
  | { type: "session.close" };

export type VoiceServerEvent =
  | {
      type: "session.ready";
      callId: string;
      sampleRate: number;
      audioProcessing: VoiceAudioProcessing;
    }
  | {
      type: "state.change";
      state: VoiceCallState;
      detail?: string;
      toolName?: string;
    }
  | { type: "transcript.delta"; turnId: string; text: string }
  | { type: "transcript.final"; turnId: string; text: string }
  | {
      type: "assistant.text.delta";
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "assistant.audio.chunk";
      turnId: string;
      itemId: string;
      sentenceIndex: number;
      text: string;
      audio: string;
    }
  | {
      type: "assistant.audio.done";
      turnId: string;
      itemId: string;
      sentenceIndex: number;
      text: string;
    }
  | {
      type: "assistant.spoken.commit";
      turnId: string;
      itemId: string;
      spokenText: string;
      draftText?: string;
      interrupted: boolean;
    }
  | { type: "barge_in"; turnId?: string; reason: "vad" | "client" }
  | { type: "pong"; ts?: number }
  | { type: "error"; code: string; message: string; recoverable?: boolean };

export function isVoiceAudioProcessing(
  value: unknown,
): value is VoiceAudioProcessing {
  return (
    typeof value === "string" &&
    (VOICE_AUDIO_PROCESSING_MODES as readonly string[]).includes(value)
  );
}

export function isVoiceCallState(value: unknown): value is VoiceCallState {
  return (
    typeof value === "string" &&
    (VOICE_CALL_STATES as readonly string[]).includes(value)
  );
}

/** 是否启用了客户端回声消除（有 AEC 时服务端保持持续拾音并启用播报态严格打断确认）。 */
export function hasClientAec(mode: VoiceAudioProcessing): boolean {
  return mode === "web-aec-v1" || mode === "native-aec3-v1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验并解析客户端上行事件。 */
export function parseVoiceClientEvent(raw: unknown): VoiceClientEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "audio.append":
      if (typeof raw.audio !== "string" || raw.audio.length === 0) return null;
      return { type: "audio.append", audio: raw.audio };
    case "audio.commit":
      return { type: "audio.commit" };
    case "playback.done":
      if (
        typeof raw.itemId !== "string" ||
        raw.itemId.length === 0 ||
        raw.itemId.length > 200
      ) {
        return null;
      }
      return { type: "playback.done", itemId: raw.itemId };
    case "barge_in":
      return { type: "barge_in" };
    case "ping":
      return {
        type: "ping",
        ...(typeof raw.ts === "number" && Number.isFinite(raw.ts)
          ? { ts: raw.ts }
          : {}),
      };
    case "session.close":
      return { type: "session.close" };
    default:
      return null;
  }
}

/** 校验并解析服务端下行事件。 */
export function parseVoiceServerEvent(raw: unknown): VoiceServerEvent | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "session.ready":
      if (
        typeof raw.callId !== "string" ||
        typeof raw.sampleRate !== "number" ||
        !isVoiceAudioProcessing(raw.audioProcessing)
      ) {
        return null;
      }
      return {
        type: "session.ready",
        callId: raw.callId,
        sampleRate: raw.sampleRate,
        audioProcessing: raw.audioProcessing,
      };
    case "state.change":
      if (!isVoiceCallState(raw.state)) return null;
      return {
        type: "state.change",
        state: raw.state,
        ...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
        ...(typeof raw.toolName === "string" ? { toolName: raw.toolName } : {}),
      };
    case "transcript.delta":
      if (typeof raw.turnId !== "string" || typeof raw.text !== "string") {
        return null;
      }
      return { type: "transcript.delta", turnId: raw.turnId, text: raw.text };
    case "transcript.final":
      if (typeof raw.turnId !== "string" || typeof raw.text !== "string") {
        return null;
      }
      return { type: "transcript.final", turnId: raw.turnId, text: raw.text };
    case "assistant.text.delta":
      if (
        typeof raw.turnId !== "string" ||
        typeof raw.itemId !== "string" ||
        typeof raw.delta !== "string"
      ) {
        return null;
      }
      return {
        type: "assistant.text.delta",
        turnId: raw.turnId,
        itemId: raw.itemId,
        delta: raw.delta,
      };
    case "assistant.audio.chunk":
      if (
        typeof raw.turnId !== "string" ||
        typeof raw.itemId !== "string" ||
        typeof raw.sentenceIndex !== "number" ||
        typeof raw.text !== "string" ||
        typeof raw.audio !== "string"
      ) {
        return null;
      }
      return {
        type: "assistant.audio.chunk",
        turnId: raw.turnId,
        itemId: raw.itemId,
        sentenceIndex: raw.sentenceIndex,
        text: raw.text,
        audio: raw.audio,
      };
    case "assistant.audio.done":
      if (
        typeof raw.turnId !== "string" ||
        typeof raw.itemId !== "string" ||
        typeof raw.sentenceIndex !== "number" ||
        typeof raw.text !== "string"
      ) {
        return null;
      }
      return {
        type: "assistant.audio.done",
        turnId: raw.turnId,
        itemId: raw.itemId,
        sentenceIndex: raw.sentenceIndex,
        text: raw.text,
      };
    case "assistant.spoken.commit":
      if (
        typeof raw.turnId !== "string" ||
        typeof raw.itemId !== "string" ||
        typeof raw.spokenText !== "string" ||
        typeof raw.interrupted !== "boolean"
      ) {
        return null;
      }
      return {
        type: "assistant.spoken.commit",
        turnId: raw.turnId,
        itemId: raw.itemId,
        spokenText: raw.spokenText,
        ...(typeof raw.draftText === "string"
          ? { draftText: raw.draftText }
          : {}),
        interrupted: raw.interrupted,
      };
    case "barge_in":
      if (raw.reason !== "vad" && raw.reason !== "client") return null;
      return {
        type: "barge_in",
        ...(typeof raw.turnId === "string" ? { turnId: raw.turnId } : {}),
        reason: raw.reason,
      };
    case "pong":
      return {
        type: "pong",
        ...(typeof raw.ts === "number" && Number.isFinite(raw.ts)
          ? { ts: raw.ts }
          : {}),
      };
    case "error":
      if (typeof raw.code !== "string" || typeof raw.message !== "string") {
        return null;
      }
      return {
        type: "error",
        code: raw.code,
        message: raw.message,
        ...(typeof raw.recoverable === "boolean"
          ? { recoverable: raw.recoverable }
          : {}),
      };
    default:
      return null;
  }
}

export function serializeVoiceEvent(
  event: VoiceClientEvent | VoiceServerEvent,
): string {
  return JSON.stringify(event);
}

/** 轻量清理单句中的 Markdown 语法，避免 TTS 朗读出星号、反引号或 URL。 */
export function sanitizeSpeechSentence(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/```[^\n]*\n?[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:>\s*)+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?)(?<=\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?)(?<=\S)~~/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/https?:\/\/[^\s<>()[\]"']+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type SentenceChunkerOptions = {
  /** 句末强标点触发切句的最小可见字符数（默认 2，保证「好的。」类短句秒播）。 */
  minChars?: number;
  /** 软长度上限：超过后优先在逗号/分号/顿号/空格等子句停顿点切分（默认 80）。 */
  softMaxChars?: number;
  /** 硬长度上限：无任何标点时的保底切分长度（默认 160）。 */
  hardMaxChars?: number;
  /** 子句停顿点距离句首的最小长度（默认 16）。 */
  minClauseChars?: number;
};

const HARD_TERMINATORS = new Set(["。", "！", "？", "!", "?", "\n"]);
const CLOSING_PUNCTUATION = new Set([
  "”",
  "’",
  "」",
  "』",
  "》",
  "）",
  "】",
  '"',
  "'",
  ")",
  "]",
]);
const CLAUSE_BOUNDARIES = new Set(["，", "；", "：", "、", ",", ";", ":"]);
const ABBREVIATIONS =
  /(?:^|[^A-Za-z])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)$/i;

function isAsciiDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSentenceEndPeriod(buffer: string, index: number): boolean {
  const prev = index > 0 ? buffer[index - 1] : undefined;
  const next = index + 1 < buffer.length ? buffer[index + 1] : undefined;
  // 紧邻数字的小数点或版本号（如 3.14、v1.2）绝不切句。
  if (isAsciiDigit(prev) && isAsciiDigit(next)) return false;
  // 连续省略号（...）等到最后一个点或后续空白再判断。
  if (next === ".") return false;
  // 尚未收到后续字符时，先暂留等待下一个 token 确认不是小数或域名/缩写。
  if (next === undefined) return false;
  // 域名或方法调用如 api.openai.com / foo.bar 不切句。
  if (isAsciiLetter(prev) && isAsciiLetter(next)) return false;
  // 常见英文缩写如 Dr. / e.g. 不切句。
  const prefix = buffer.slice(Math.max(0, index - 8), index);
  if (ABBREVIATIONS.test(prefix)) return false;
  return (
    next === " " ||
    next === "\t" ||
    next === "\n" ||
    next === "\r" ||
    CLOSING_PUNCTUATION.has(next) ||
    next.charCodeAt(0) > 0x7f
  );
}

function adjustSurrogateBoundary(text: string, limit: number): number {
  if (limit <= 0 || limit >= text.length) return limit;
  const code = text.charCodeAt(limit - 1);
  if (code >= 0xd800 && code <= 0xdbff) return limit - 1;
  return limit;
}

/**
 * 流式增量分句器：边接收 LLM 增量文本边按中英文句末标点与长度上限切句，
 * 让 TTS 在第一句话刚结束时即可立即起播，消除等待整轮回复完成的高首字延迟。
 */
export class SentenceChunker {
  private readonly minChars: number;
  private readonly softMaxChars: number;
  private readonly hardMaxChars: number;
  private readonly minClauseChars: number;
  private buffer = "";

  constructor(options: SentenceChunkerOptions = {}) {
    this.minChars = Math.max(1, options.minChars ?? 2);
    this.softMaxChars = Math.max(16, options.softMaxChars ?? 80);
    this.hardMaxChars = Math.max(
      this.softMaxChars + 10,
      options.hardMaxChars ?? 160,
    );
    this.minClauseChars = Math.max(
      4,
      Math.min(this.softMaxChars - 4, options.minClauseChars ?? 16),
    );
  }

  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
  }

  /** 追加增量文本，返回本批已满足切分条件的完整句子数组。 */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta.replace(/\r\n?/g, "\n");
    const sentences: string[] = [];

    while (this.buffer.length > 0) {
      const splitAt = this.findSplitIndex();
      if (splitAt <= 0) break;
      const head = this.buffer.slice(0, splitAt).trim();
      this.buffer = this.buffer.slice(splitAt).trimStart();
      if (head.length > 0) {
        sentences.push(head);
      }
    }

    return sentences;
  }

  /** 在流结束时冲刷剩余缓冲文本。 */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }

  private findSplitIndex(): number {
    const buf = this.buffer;

    // 1. 优先扫描中英文硬句末边界（。！？!?\n 及已确认句尾的英文句点 .）。
    for (let i = 0; i < buf.length; i += 1) {
      const ch = buf[i];
      if (!ch) continue;
      const isHard =
        HARD_TERMINATORS.has(ch) || (ch === "." && isSentenceEndPeriod(buf, i));
      if (!isHard) continue;

      let end = i + 1;
      // 合并连续的标点与紧随的闭合引号/括号（如 「真的吗？！」）。
      while (end < buf.length) {
        const tail = buf[end];
        if (!tail) break;
        if (
          tail === "!" ||
          tail === "?" ||
          tail === "！" ||
          tail === "？" ||
          tail === "。" ||
          CLOSING_PUNCTUATION.has(tail)
        ) {
          end += 1;
          continue;
        }
        break;
      }

      const candidate = buf.slice(0, end).trim();
      if (candidate.length >= this.minChars || ch === "\n") {
        return end;
      }
    }

    // 2. 超过软上限时，向后查找子句停顿点（，；：、,;: 或空格），避免单句过长拉高 TTS 延迟。
    if (buf.length >= this.softMaxChars) {
      const limit = Math.min(buf.length, this.hardMaxChars);
      let clauseAt = -1;
      let spaceAt = -1;
      for (let i = this.minClauseChars; i < limit; i += 1) {
        const ch = buf[i];
        if (!ch) continue;
        if (CLAUSE_BOUNDARIES.has(ch)) {
          clauseAt = i + 1;
        } else if (ch === " " || ch === "\t") {
          spaceAt = i + 1;
        }
      }
      if (clauseAt > 0) return clauseAt;
      if (spaceAt > 0) return spaceAt;
    }

    // 3. 超过硬上限且无标点时按 UTF-16 安全边界保底切分。
    if (buf.length >= this.hardMaxChars) {
      return adjustSurrogateBoundary(buf, this.hardMaxChars);
    }

    return -1;
  }
}
