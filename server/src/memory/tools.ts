import {
  type AbstractAgent,
  type BaseEvent,
  Middleware,
  type RunAgentInput,
} from "@ag-ui/client";
import { defer, from, type Observable, switchMap } from "rxjs";
import { markRequest } from "../agents/run-timing";
import type { MemoryNotes } from "../memory-notes/service";

export type LoadPersonalMemoryOptions = {
  isGroupChat?: boolean;
  threadId?: string;
};

/** `question`：这一轮用户最后说的那句话（纯文字）；`options` 传递群聊等隔离上下文。 */
export type LoadPersonalMemory = (
  botId: string,
  question?: string,
  options?: LoadPersonalMemoryOptions,
) => Promise<string>;

export type PersonalMemoryMiddlewareOptions = {
  isGroupChat?:
    | boolean
    | ((input: RunAgentInput) => boolean | Promise<boolean>);
};

/** 从 AG-UI 运行入参识别是否处于群聊上下文，防止私人/机器人专属记忆渗入群聊。 */
export function isGroupChatInput(input: RunAgentInput): boolean {
  const props = input.forwardedProps;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const record = props as Record<string, unknown>;
    if (record.isGroupChat === true || record.groupChat === true) return true;
    if (record.chatType === "group" || record.channelKind === "group") {
      return true;
    }
    if (
      record.chisabotGroup !== undefined &&
      record.chisabotGroup !== null &&
      record.chisabotGroup !== false
    ) {
      return true;
    }
  }
  return input.context.some(
    (entry) =>
      entry.description === "ChisaBot group chat" &&
      entry.value !== "" &&
      entry.value !== "false",
  );
}

/** 构造统一接入四级隔离（owner / botId / isGroupChat / question）的记忆加载器。 */
export function createPersonalMemoryLoader(
  memoryNotes: Pick<MemoryNotes, "context">,
  ownerUserId: string,
  defaults: {
    isGroupChat?: boolean;
    deletedBotIds?: ReadonlySet<string>;
  } = {},
): LoadPersonalMemory {
  return (botId, question, options) =>
    memoryNotes.context(ownerUserId, botId, {
      ...(question !== undefined ? { question } : {}),
      isGroupChat: options?.isGroupChat ?? defaults.isGroupChat ?? false,
      ...(defaults.deletedBotIds
        ? { deletedBotIds: defaults.deletedBotIds }
        : {}),
    });
}
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
    private readonly options?: PersonalMemoryMiddlewareOptions,
  ) {
    super();
  }
  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    return defer(() => {
      markRequest("memory-start");
      const resolveGroup = async () => {
        if (typeof this.options?.isGroupChat === "function") {
          return Boolean(await this.options.isGroupChat(input));
        }
        return this.options?.isGroupChat ?? isGroupChatInput(input);
      };
      return from(
        resolveGroup()
          .then((isGroupChat) =>
            this.load(this.botId, lastUserText(input), {
              isGroupChat,
              threadId: input.threadId,
            }),
          )
          .finally(() => markRequest("memory-end")),
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
