import type { Attachment } from "@copilotkit/react-core/v2";
import {
  getChipsByTrigger,
  isSegmentsEmpty,
  mergeAdjacentTextSegments,
  type Segment,
  segmentsToPlainText,
  text,
} from "prompt-area/helpers";

/**
 * Pure boundary between prompt-area segments and ChisaBot's message draft model.
 */

export const AGENT_TRIGGER = "@";
export const COMMAND_TRIGGER = "/";

export type ComposerDraft = {
  /** Plain text, with chips flattened back to `@Agent` / `/command`. */
  text: string;
  /**
   * The single agent this message is addressed to, or `null` to let the channel pick its default.
   *
   * Exactly one responding agent per message, which is enforced on the
   * way in by `enforceSingleAgent` rather than validated here.
   */
  agentId: string | null;
  /** Commands that survive into the sent message, in the order they were typed. */
  commandIds: string[];
  isEmpty: boolean;
  attachments: Attachment[];
};

export function toDraft(
  segments: Segment[],
  attachments: Attachment[] = [],
): ComposerDraft {
  const agentChips = getChipsByTrigger(segments, AGENT_TRIGGER);
  const commandChips = getChipsByTrigger(segments, COMMAND_TRIGGER);

  return {
    text: segmentsToPlainText(segments).trim(),
    agentId: agentChips.at(-1)?.value ?? null,
    commandIds: commandChips.map((chip) => chip.value),
    isEmpty: isSegmentsEmpty(segments),
    attachments,
  };
}

/**
 * A pasted screenshot with no text is the whole feature: `isEmpty` only answers "is there text",
 * so an attachment alone must be enough to unlock Send rather than riding on top of it. An
 * upload still in flight holds the gate either way, since sending would race the file that has
 * not finished becoming a source yet.
 */
export function canSendDraft(draft: ComposerDraft): boolean {
  if (
    draft.attachments.some((attachment) => attachment.status === "uploading")
  ) {
    return false;
  }

  return draft.attachments.length > 0 || !draft.isEmpty;
}

/*
 * 把「发送失败塞回来、事后对账证明其实已发出」的那份草稿收走（channel-chat 的迟到对账 →
 * sendLanded）。失败恢复把原句放在输入框内容的最前面（框空时整框就是它；框里已有新字时是
 * `原句 + 空格分段 + 新字`）：
 *   - 整框正好就是那句（塞回来之后没再动过）→ 全收；
 *   - 开头是那句、后面是自己续打的 → 只收前一份，连同中间补的空白分段；
 *   - 对不上（原句被编辑过）→ 不动：他的字优先，null = 保持现状。
 */
export function retractRestoredDraft(
  segments: Segment[],
  landed: string,
): Segment[] | null {
  const target = landed.trim();
  if (!target || isSegmentsEmpty(segments)) return null;
  const whole = segmentsToPlainText(segments).trim();
  if (whole === target) return [];
  if (!whole.startsWith(target)) return null;
  /*
   * 原句占了开头：逐段把它的纯文本吃掉。恢复时相邻文本会被并成一个分段（`mergeAdjacentTextSegments`），
   * 所以边界多半落在某个 text 分段**内部**——text 能在段内截断，切完再吃掉还原时补的那个空格；
   * chip 超界说明原句被改过，他的字优先，不收。
   * （`whole` 是 trim 过的，开头的空白分段先摘掉，不然逐段计数会错位。）
   */
  let k = 0;
  while (k < segments.length) {
    const seg = segments[k];
    if (!seg || segmentsToPlainText([seg]).trim() !== "") break;
    k += 1;
  }
  let consumed = 0;
  let matched = false;
  let partialTail: Segment | null = null;
  while (k < segments.length) {
    const seg = segments[k];
    if (!seg) break;
    // `whole` 是 trim 过的：第一个非空分段自己的前导空格不计入对齐（consumed 还是 0 时就是它）。
    const plain =
      consumed === 0
        ? segmentsToPlainText([seg]).replace(/^ +/, "")
        : segmentsToPlainText([seg]);
    const next = consumed + plain.length;
    if (next <= target.length) {
      consumed = next;
      k += 1;
      continue;
    }
    const need = target.length - consumed;
    if (seg.type === "text" && plain.startsWith(target.slice(consumed))) {
      const tail = plain.slice(need).replace(/^ /, "");
      if (tail) partialTail = text(tail);
      matched = true;
      k += 1;
    }
    break;
  }
  if (consumed < target.length && !matched) return null;
  const rest = mergeAdjacentTextSegments([
    ...(partialTail ? [partialTail] : []),
    ...segments.slice(k),
  ]);
  return isSegmentsEmpty(rest) ? [] : rest;
}

/** Collapse multiple agent mentions to the most recent one while preserving identity on no-op. */
export function enforceSingleAgent(segments: Segment[]): Segment[] {
  const agentChipCount = getChipsByTrigger(segments, AGENT_TRIGGER).length;
  if (agentChipCount <= 1) {
    return segments;
  }

  let remaining = agentChipCount;
  const kept = segments.filter((segment) => {
    if (segment.type !== "chip" || segment.trigger !== AGENT_TRIGGER) {
      return true;
    }
    remaining -= 1;
    return remaining === 0;
  });

  return mergeAdjacentTextSegments(kept);
}

/**
 * What a `/command` does once it has been picked from the dropdown.
 *
 * - `chip` keeps the chip in the message, so the runtime receives it as structured data.
 * - `prompt` expands into editable text, for the channel's seeded suggested prompts.
 * - `action` runs client-side and never reaches the runtime.
 *
 * prompt-area always resolves a dropdown selection into a chip, so `prompt` and `action` are
 * applied here on the next change instead of being special-cased inside the editor.
 */
export type CommandKind = "chip" | "prompt" | "action";

export type CommandOption = {
  id: string;
  name: string;
  description?: string;
  /** Defaults to `chip`. */
  kind?: CommandKind;
  /** Text substituted for the command when `kind` is `prompt`. */
  prompt?: string;
  /** Side effect run when `kind` is `action`. */
  run?: () => void;
};

export type AppliedCommands = {
  segments: Segment[];
  /** Actions to run after the new segments are committed to state. */
  actions: (() => void)[];
};

/**
 * Rewrites `prompt` and `action` command chips, leaving `chip` commands (and everything else)
 * alone. Side effects are returned rather than run so the transform stays pure and testable.
 */
export function applyCommandChips(
  segments: Segment[],
  commands: readonly CommandOption[],
): AppliedCommands {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const actions: (() => void)[] = [];
  let changed = false;

  const rewritten = segments.flatMap<Segment>((segment) => {
    if (segment.type !== "chip" || segment.trigger !== COMMAND_TRIGGER) {
      return [segment];
    }

    const command = byId.get(segment.value);
    const kind = command?.kind ?? "chip";

    if (kind === "prompt") {
      changed = true;
      return command?.prompt ? [text(command.prompt)] : [];
    }

    if (kind === "action") {
      changed = true;
      if (command?.run) {
        actions.push(command.run);
      }
      return [];
    }

    return [segment];
  });

  return {
    segments: changed ? mergeAdjacentTextSegments(rewritten) : segments,
    actions,
  };
}
