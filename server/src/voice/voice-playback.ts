import { VOICE_SAMPLE_RATE } from "../../../shared/voice-call";

const PCM16_MONO_BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000; // 48 bytes/ms
const DEFAULT_TAIL_GUARD_MS = 500;
const DEFAULT_MISSING_RECEIPT_TIMEOUT_MS = 2_000;

export type VoicePlaybackOptions = {
  now?: () => number;
  /** 播报结束后额外保留的尾音保护窗口（ms，默认 500）。 */
  tailGuardMs?: number;
  /** 客户端回执丢失时的兜底超时（ms，默认 2000）。 */
  missingReceiptTimeoutMs?: number;
};

/**
 * 扬声器播放排空追踪器：
 * - 按已下发 PCM16 字节估算播报结束时间；
 * - 等待客户端 `playback.done` 真实排空回执后追加 500ms 尾音保护；
 * - 回执丢失时超过估算结束时间 + 2000ms 自动释放，防止拾音永久卡死；
 * - 无客户端 AEC 时在播报期提供半双工门控，有 AEC 时保持全双工持续拾音。
 */
export class VoicePlaybackTracker {
  private readonly now: () => number;
  private readonly tailGuardMs: number;
  private readonly missingReceiptTimeoutMs: number;
  private readonly activeItems = new Map<string, number>();
  private tailUntilMs = 0;

  constructor(options: VoicePlaybackOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tailGuardMs = Math.max(
      0,
      options.tailGuardMs ?? DEFAULT_TAIL_GUARD_MS,
    );
    this.missingReceiptTimeoutMs = Math.max(
      200,
      options.missingReceiptTimeoutMs ?? DEFAULT_MISSING_RECEIPT_TIMEOUT_MS,
    );
  }

  /** 记录服务端向客户端下发的 PCM16 音频块字节数。 */
  append(itemId: string, pcmBytes: number): void {
    if (pcmBytes <= 0) return;
    const current = this.now();
    const durationMs = pcmBytes / PCM16_MONO_BYTES_PER_MS;
    const previousEnd = this.activeItems.get(itemId) ?? current;
    this.activeItems.set(itemId, Math.max(previousEnd, current) + durationMs);
  }

  /** 客户端确认某句音频在扬声器播放排空完成。 */
  finish(itemId: string): boolean {
    if (!this.activeItems.delete(itemId)) {
      return false;
    }
    this.tailUntilMs = Math.max(
      this.tailUntilMs,
      this.now() + this.tailGuardMs,
    );
    return true;
  }

  /** 打断或取消当前播报，清空活跃项并设置尾音保护。 */
  cancel(): void {
    if (this.activeItems.size > 0) {
      this.tailUntilMs = Math.max(
        this.tailUntilMs,
        this.now() + this.tailGuardMs,
      );
    }
    this.activeItems.clear();
  }

  /** 当前扬声器是否仍处于播报期或尾音保护期。 */
  isPlaying(): boolean {
    const current = this.now();
    for (const [id, estimatedEnd] of this.activeItems) {
      if (current > estimatedEnd + this.missingReceiptTimeoutMs) {
        this.activeItems.delete(id);
      }
    }
    return this.activeItems.size > 0 || current < this.tailUntilMs;
  }

  /** 无客户端 AEC 时播报期自动启用半双工门控；有 AEC 时持续拾音。 */
  shouldGateCapture(clientAec: boolean): boolean {
    return !clientAec && this.isPlaying();
  }

  pendingCount(): number {
    this.isPlaying();
    return this.activeItems.size;
  }

  /** 估算指定句集合（或当前全部未排空句）距离预计播完的剩余毫秒数。 */
  estimatedRemainingMs(itemIds?: readonly string[]): number {
    const current = this.now();
    let maxEnd = current;
    if (itemIds) {
      for (const id of itemIds) {
        const end = this.activeItems.get(id);
        if (end !== undefined && end > maxEnd) {
          maxEnd = end;
        }
      }
    } else {
      for (const end of this.activeItems.values()) {
        if (end > maxEnd) {
          maxEnd = end;
        }
      }
    }
    return Math.max(0, Math.ceil(maxEnd - current));
  }

  clear(): void {
    this.activeItems.clear();
    this.tailUntilMs = 0;
  }
}
