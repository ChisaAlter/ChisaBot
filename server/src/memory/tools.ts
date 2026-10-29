import {
  type AbstractAgent,
  type BaseEvent,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { defer, from, type Observable, switchMap } from "rxjs";
import { z } from "zod";
import { markRequest } from "../agents/run-timing";
import type { GrantedTool } from "../plugins/tools";
import {
  formedMemorySchema,
  MemoryNotFoundError,
  MemoryRefusedError,
  memoryInputSchema,
} from "./types";

/*
 * What the model is offered for an observed memory. The store's schema coerces `observedAt` to a
 * Date, which JSON Schema cannot describe, and a remote Bot's tool list is sent as JSON Schema: that
 * conversion threw and failed every remote run holding this tool. The model sends an ISO string.
 */
const observedMemoryToolSchema = formedMemorySchema.extend({
  observedAt: z.string().datetime({ offset: true }).optional(),
});

/** `question`：这一轮用户最后说的那句话（纯文字），按需预置内容用（如研究类问题的技能）；可以不看。 */
export type LoadPersonalMemory = (
  botId: string,
  question?: string,
) => Promise<string>;
/** 这一轮用户最后说的话里的文字部分。 */
export function lastUserText(input: RunAgentInput): string {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    const content = message.content as unknown;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text ?? "")
            : "",
        )
        .join(" ");
    return "";
  }
  return "";
}
export class PersonalMemoryMiddleware extends Middleware {
  constructor(
    private readonly botId: string,
    private readonly load: LoadPersonalMemory,
  ) {
    super();
  }
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return defer(() => {
      markRequest("memory-start");
      return from(
        this.load(this.botId, lastUserText(input)).finally(() =>
          markRequest("memory-end"),
        ),
      );
    }).pipe(
      switchMap((content) =>
        this.runNext(
          {
            ...input,
            messages: [
              ...(content
                ? [
                    {
                      id: "chisabot:personal-memory",
                      role: "system" as const,
                      content,
                    },
                  ]
                : []),
              ...input.messages.filter(
                (message) => message.id !== "chisabot:personal-memory",
              ),
            ],
            context: [
              ...input.context.filter(
                (entry) => entry.description !== "ChisaBot personal memory",
              ),
              ...(content
                ? [{ description: "ChisaBot personal memory", value: content }]
                : []),
            ],
          },
          next,
        ),
      ),
    );
  }
}
