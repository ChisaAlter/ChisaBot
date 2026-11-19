import type { z } from "zod";
import type { ConfirmDetail } from "../../../shared/confirmations";
import type { AuditInitiator } from "../audit";

/**
 * What a refused call answers with.
 *
 * The transcript draws a refusal differently from a result, and it has only the tool's answer to go
 * on. Guessing from the wording would break the first time an administrator rephrased a policy
 * message, so the answer says which it is. The model reads this too, and "Refused." in front of a
 * reason is what it should be told anyway.
 */
export const REFUSAL_MARKER = "Refused.";

export type ToolExecuteContext = { signal?: AbortSignal };

export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  /** Declared by the tool implementation/catalogue, never inferred from its name. */
  effect?: "read" | "write";
  /** `ctx.signal` 在用户按停止时 abort（FIX-04）；旧工具可忽略第二参。 */
  execute: (args: unknown, ctx?: ToolExecuteContext) => Promise<string>;
  initiator?: AuditInitiator;
  /**
   * `<serverId>/<toolName>`, carried alongside the name the model is offered.
   *
   * The two spellings exist because a model tool name may not contain a slash, and selection has to
   * compare a tool against what a skill declared, which is written in the ref spelling because that
   * is how a grant is written. Carried rather than derived at the comparison, so there is one place
   * the two forms are converted (`toolNameFor`) and no second parser to drift from it.
   */
  ref: string;
  /**
   * Prompt text this tool brings with it, added to a built-in Bot's prompt only when the tool is
   * actually offered (so a narrowed run is never told about something it was not handed).
   *
   * Used by the device tools to tell the Bot that the person's own computer is linked and whether it
   * is online right now: without it the long computer prose ("you have your own browser") wins and
   * the Bot tells the person it cannot see their PC while holding the tools for it.
   */
  guidance?: string;
  /**
   * 有后果的工具出确认卡片之前，先算好「这一次到底要做什么」（例：整理记忆先算出要合并哪几组）。
   *
   * - `skip`：不用问也不用做（没有可整理的、建议已过期……），直接把 text 交给机器人。
   * - 否则卡片用这里的 title / details，摘要按 `args` 算，确认后执行的也是 `args`（整理记忆把预览 token 放进去，
   *   确认后用户看过的那一份才会被执行；库里变了摘要就对不上，旧的确认不会被拿来放行新的内容）。
   *
   * 只有 confirmations.wrap 读它；没有这个字段的工具照旧按参数出卡片。
   */
  prepareConfirm?: (
    args: unknown,
  ) => Promise<
    | { skip: string }
    | { args: unknown; title: string; details: ConfirmDetail[] }
  >;
};
