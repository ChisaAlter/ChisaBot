import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  Middleware,
  type RunAgentInput,
  type RunFinishedEvent,
  type Tool,
  type ToolCall,
} from "@ag-ui/client";
import { Observable, type Subscription } from "rxjs";
import { z } from "zod";
import {
  currentApprovalContext,
  withApprovalContext,
} from "../approvals/types";
import {
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import {
  type ActionActor,
  type ComputerGateway,
  HumanHasControlError,
} from "./gateway";
import { HUMAN_CONTROL_ZH, isUnattendedInitiator, noteHumanControlBlock, suspendsOnHumanControl } from "./control-blocks";
import type { ControlState } from "./schema";
import { withConfirmActor } from "../confirmations/context";
import {
  COMMAND_DEFAULT_TIMEOUT_SEC,
  COMMAND_MAX_TIMEOUT_SEC,
  COMMAND_TIMEOUT_GUIDE,
  normalizeCommandTimeout,
} from "../../../shared/command-timeout";

/** Client tools supplied by OpenBot when the caller has no browser. */
export type HeadlessTool = {
  definition: Tool;
  /**
   * Executed when called but never offered to the model. For a tool the Bot does not hold, so a
   * call it makes anyway gets a governed refusal rather than going unanswered.
   */
  hidden?: boolean;
  execute(
    args: unknown,
    context: { toolCallId: string; signal: AbortSignal },
  ): Promise<unknown>;
};

export type HeadlessWaiting = {
  kind: string;
  requestId?: string;
  [key: string]: unknown;
};

/** A durable request remains open; continuing the Bot would invent a human answer. */
export class HeadlessToolSuspension extends Error {
  constructor(
    message: string,
    readonly waiting: HeadlessWaiting,
  ) {
    super(message);
    this.name = "HeadlessToolSuspension";
  }
}

/** 定时 / IM 回合要人在场时的中文拒绝（FIX-02）：不挂起，让回合正常结束。 */
const UNATTENDED_NEED_HUMAN_ZH = (what: string) =>
  `没有执行：${what}。这一轮是定时任务 / 后台触发，用户不在场，没法请他接管浏览器或登录。告诉用户：在 ChisaBot 网页聊天里当面让你再做一次。`;


const MAX_TOOL_SEGMENTS = 30;

/**
 * Executes AG-UI client tools inside the Intelligence run. Backend results are
 * forwarded unchanged; only newly emitted unanswered calls can be executed.
 */
export class HeadlessToolsMiddleware extends Middleware {
  constructor(
    private readonly tools: HeadlessTool[],
    private readonly initiator?: AuditInitiator,
  ) {
    super();
    const names = tools.map((tool) => tool.definition.name);
    if (new Set(names).size !== names.length)
      throw new Error("Headless tool names must be unique.");
  }

  run(
    originalInput: RunAgentInput,
    next: AbstractAgent,
  ): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const controller = new AbortController();
      const tools = new Map(
        this.tools.map((tool) => [tool.definition.name, tool]),
      );
      const executed = new Set<string>();
      let subscription: Subscription | undefined;
      let started = false;
      const work = async () => {
        let request: RunAgentInput = {
          ...originalInput,
          tools: [
            ...originalInput.tools.filter((tool) => !tools.has(tool.name)),
            ...this.tools
              .filter((tool) => !tool.hidden)
              .map((tool) => tool.definition),
          ],
        };
        for (let segment = 0; segment <= MAX_TOOL_SEGMENTS; segment += 1) {
          if (subscriber.closed) return;
          const historical = new Set(
            request.messages.flatMap((message) =>
              message.role === "assistant"
                ? (message.toolCalls ?? []).map((call) => call.id)
                : [],
            ),
          );
          const emitted = new Set<string>();
          let messages = request.messages;
          let state = request.state;
          let terminal: RunFinishedEvent | undefined;
          let failed = false;
          await new Promise<void>((resolve, reject) => {
            subscription = this.runNextWithState(
              request,
              new InvocationTransport(next, request),
            ).subscribe({
              next: ({
                event,
                messages: updatedMessages,
                state: updatedState,
              }) => {
                messages = updatedMessages;
                state = updatedState;
                if (event.type === EventType.TOOL_CALL_START)
                  emitted.add(String(event.toolCallId));
                if (event.type === EventType.MESSAGES_SNAPSHOT) {
                  for (const message of messages) {
                    if (message.role !== "assistant") continue;
                    for (const call of message.toolCalls ?? []) {
                      if (!historical.has(call.id)) emitted.add(call.id);
                    }
                  }
                }
                if (event.type === EventType.RUN_FINISHED) {
                  terminal = event as RunFinishedEvent;
                  return;
                }
                if (event.type === EventType.RUN_STARTED) {
                  if (started) return;
                  started = true;
                }
                if (event.type === EventType.RUN_ERROR) failed = true;
                subscriber.next(event);
              },
              error: reject,
              complete: resolve,
            });
          });
          if (subscriber.closed || failed) return;
          if (!terminal)
            throw new Error(
              "The headless agent ended without a terminal event.",
            );
          const answered = new Set(
            messages.flatMap((message) =>
              message.role === "tool" ? [message.toolCallId] : [],
            ),
          );
          const pending: ToolCall[] = messages.flatMap((message) =>
            message.role === "assistant"
              ? (message.toolCalls ?? []).filter(
                  (call) =>
                    emitted.has(call.id) &&
                    !historical.has(call.id) &&
                    !answered.has(call.id) &&
                    !executed.has(call.id),
                )
              : [],
          );
          const owned = pending.filter(
            (call) =>
              tools.has(call.function.name) ||
              call.function.name.startsWith("computer_"),
          );
          if (owned.length === 0) {
            subscriber.next(terminal);
            return;
          }
          if (segment === MAX_TOOL_SEGMENTS)
            throw new Error(
              "The headless tool continuation limit was reached.",
            );
          const results = new Map<string, string>();
          for (const call of owned) {
            if (subscriber.closed) return;
            executed.add(call.id);
            let content: string;
            let error: string | undefined;
            try {
              const tool = tools.get(call.function.name);
              if (!tool)
                throw new Error(
                  `The tool ${call.function.name} is unavailable for this headless turn.`,
                );
              const args: unknown = JSON.parse(call.function.arguments || "{}");
              const continuation = {
                runId: request.runId,
                threadId: request.threadId,
                toolCallId: call.id,
                toolName: call.function.name,
                args,
                messages,
                state,
                context: request.context,
                forwardedProps: request.forwardedProps,
                initiator: this.initiator,
              };
              const result = await withApprovalContext(continuation, () =>
                tool.execute(args, {
                  toolCallId: call.id,
                  signal: controller.signal,
                }),
              );
              content =
                typeof result === "string" ? result : JSON.stringify(result);
              if (content === undefined)
                throw new Error(
                  `The tool ${call.function.name} returned no result.`,
                );
            } catch (failure) {
              if (failure instanceof HeadlessToolSuspension) {
                failure.waiting.continuation ??= {
                  runId: request.runId,
                  threadId: request.threadId,
                  toolCallId: call.id,
                  toolName: call.function.name,
                  args: JSON.parse(call.function.arguments || "{}"),
                  messages,
                  state,
                  context: request.context,
                  forwardedProps: request.forwardedProps,
                  initiator: this.initiator,
                };
                subscriber.next({
                  type: EventType.CUSTOM,
                  name: "openbot.headless.waiting",
                  value: {
                    ...failure.waiting,
                    message: failure.message,
                    toolCallId: call.id,
                  },
                });
                subscriber.next({
                  ...terminal,
                  outcome: {
                    type: "interrupt",
                    interrupts: [
                      {
                        id: call.id,
                        toolCallId: call.id,
                        reason: "human_input",
                        message: failure.message,
                        metadata: { openbotWaiting: failure.waiting },
                      },
                    ],
                  },
                });
                return;
              }
              error =
                failure instanceof Error ? failure.message : String(failure);
              content = JSON.stringify({ ok: false, error });
            }
            if (subscriber.closed) return;
            const message: Message = {
              id: crypto.randomUUID(),
              role: "tool",
              toolCallId: call.id,
              content,
              ...(error ? { error } : {}),
            };
            messages = [...messages, message];
            results.set(call.id, content);
            // AG-UI 1.0's TOOL_CALL_RESULT has no `error` field and validation strips one; the
            // refusal travels in `content`, and on the tool message, which keeps `error`.
            subscriber.next({
              type: EventType.TOOL_CALL_RESULT,
              messageId: message.id,
              toolCallId: call.id,
              role: "tool",
              content,
            });
          }
          const interrupts =
            terminal.outcome?.type === "interrupt"
              ? terminal.outcome.interrupts
              : [];
          const unresolved = interrupts.filter(
            (interrupt) => !results.has(interrupt.toolCallId ?? interrupt.id),
          );
          if (owned.length !== pending.length || unresolved.length > 0) {
            subscriber.next(
              unresolved.length > 0
                ? {
                    ...terminal,
                    outcome: { type: "interrupt", interrupts: unresolved },
                  }
                : terminal,
            );
            return;
          }
          request = {
            ...request,
            messages,
            state,
            resume:
              interrupts.length > 0
                ? interrupts.map((interrupt) => ({
                    interruptId: interrupt.id,
                    status: "resolved" as const,
                    payload: results.get(interrupt.toolCallId ?? interrupt.id),
                  }))
                : undefined,
          };
        }
      };
      // Observable teardown owns cancellation; both asynchronous exits are observed.
      work().then(
        () => subscriber.complete(),
        (error: unknown) => {
          if (subscriber.closed) return;
          subscriber.next({
            type: EventType.RUN_ERROR,
            code: "OPENBOT_HEADLESS_TOOL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          });
          subscriber.complete();
        },
      );
      return () => {
        controller.abort();
        subscription?.unsubscribe();
      };
    });
  }
}

/** AG-UI accumulation reads transport history, so seed each continuation explicitly. */
class InvocationTransport extends AbstractAgent {
  constructor(
    private readonly transport: AbstractAgent,
    input: RunAgentInput,
  ) {
    super({ initialMessages: input.messages, initialState: input.state });
  }
  run(input: RunAgentInput) {
    return this.transport.run(input);
  }
}

/** What the headless sign-in tool needs from the passwords module. See passwords/service.ts. */
export type HeadlessSignInRequester = {
  request(input: {
    ownerUserId: string;
    botId: string;
    site: string;
    reason?: string;
    actor: ActionActor;
    threadId?: string;
    toolCallId?: string;
    continuation?: Record<string, unknown>;
    notify?: boolean;
  }): Promise<{ id: string; origin: string }>;
};

/** Shared by the headless tool and the browser's registration, so both promise the same thing. */
export const SIGN_IN_TOOL_DESCRIPTION =
  "Ask the person you work for to sign you in to a website. They get a private sign-in form outside this conversation (or take over the browser), and their login is typed straight into your browser by the computer. You never see the username, password or code, and must never ask for them any other way. Open the site's sign-in page first, then call this with the site's address. This turn pauses until they answer; you are then told only whether it worked.";

/** Shipped browser/file/command tools, with identity bound before the model supplies arguments. */
export function createHeadlessComputerTools(options: {
  gateway: ComputerGateway;
  botId: string;
  actor: ActionActor;
  auditStore?: AuditStore;
  /** The private sign-in request. Absent leaves the Bot with help and secret requests only. */
  signIn?: HeadlessSignInRequester;
}): HeadlessTool[] {
  const { gateway, botId, actor, auditStore, signIn } = options;
  const snapshotId = z.number().int().positive();
  const ref = z.string().min(1);
  const text = z.string().min(1);
  const noArgs = z.strictObject({});
  function tool<T extends z.ZodType>(
    name: string,
    description: string,
    schema: T,
    execute: (
      input: z.output<T>,
      context: { toolCallId: string; signal: AbortSignal },
    ) => Promise<unknown>,
  ): HeadlessTool {
    return {
      definition: { name, description, parameters: z.toJSONSchema(schema) },
      execute: async (args, context) => {
        const input = schema.parse(args);
        if (context.signal.aborted)
          throw new Error("The computer action was stopped.");
        try {
          // 确认卡片（server/src/confirmations）要知道这次是谁发起的（网页聊天才能出卡片）。
          return await withConfirmActor(actor.initiator, () => execute(input, context));
        } catch (error) {
          if (error instanceof HumanHasControlError && !suspendsOnHumanControl(actor.initiator)) {
            // 聊天 / 面板刷新：不挂起（挂起后没有东西会把这一轮接上，用户只看到一句话就没下文了）。
            // 交回一个普通的中文结果，机器人照常把话说完（control-blocks.ts）。
            noteHumanControlBlock(actor.initiator && "id" in actor.initiator ? actor.initiator.id : undefined);
            return { ok: false, humanHasControl: true, reason: HUMAN_CONTROL_ZH, error: HUMAN_CONTROL_ZH };
          }
          if (error instanceof HumanHasControlError) {
            throw new HeadlessToolSuspension(error.message, {
              kind: "computer_handoff",
              botId,
              ...(error.requestId ? { requestId: error.requestId } : {}),
              ...(error.handoff ? { handoff: error.handoff } : {}),
            });
          }
          throw error;
        }
      },
    };
  }
  function waiting(
    state: ControlState,
    reason: string,
    kind = "computer_handoff",
  ): never {
    throw new HeadlessToolSuspension(reason, {
      kind,
      botId,
      ...(state.request
        ? { requestId: state.request.id, handoff: state.request }
        : {}),
    });
  }
  const tools = [
    tool(
      "computer_navigate",
      "Open a web page and return its title and readable text. Use the returned content to answer. " +
        "To open a page you wrote yourself, save it with computer_write_file (e.g. page.html) and open https://workspace.local/page.html (file:// does not work). " +
        "If the result has siteBlock, the site refused this browser outright: do not retry that site; tell the user in Chinese what siteBlock.notice says.",
      z.strictObject({ url: text }),
      async ({ url }, { toolCallId }) => {
        const result = await gateway.navigate(botId, actor, url, toolCallId);
        if (result.challenge) {
          if (isUnattendedInitiator(actor.initiator)) {
            const reason = UNATTENDED_NEED_HUMAN_ZH(result.challenge.reason);
            return { ok: false, error: reason, reason, siteBlock: { notice: reason } };
          }
          throw new HeadlessToolSuspension(result.challenge.reason, {
            kind: "computer_handoff",
            botId,
            requestId: result.challenge.requestId,
            source: result.challenge.kind,
          });
        }
        return { ok: true, ...result };
      },
    ),
    tool(
      "computer_read",
      "Read the currently open browser page without navigating.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.read(botId)) }),
    ),
    tool(
      "computer_snapshot",
      "List fields, buttons and links with refs. Call before clicking or typing and pass the returned snapshotId with every ref. If refs are stale take a fresh snapshot. A dropdown (<select>) is a combobox with an options list: choose with computer_type.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.snapshot(botId)) }),
    ),
    tool(
      "computer_screenshot",
      "Return an image of the browser currently open on your computer.",
      noArgs,
      async () => ({ ok: true, ...(await gateway.screenshot(botId)) }),
    ),
    tool(
      "computer_click",
      "Click an element using its ref and snapshotId from the latest snapshot.",
      z.strictObject({ ref, snapshotId }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.click(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_type",
      "Replace a field's contents using its ref and snapshotId. Set submit to press Enter afterwards. For a dropdown (combobox with options) give one option's text or value (e.g. Jul or 7 for a month, 2000 for a year) to select it; never click it open.",
      z.strictObject({
        ref,
        snapshotId,
        text: z.string(),
        submit: z.boolean().optional(),
      }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.type(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_key",
      "Press Enter, Tab, Escape or another key on the page. When a ref is given pass its snapshotId.",
      z
        .strictObject({
          key: text,
          ref: ref.optional(),
          snapshotId: snapshotId.optional(),
        })
        .refine((input) => !input.ref || input.snapshotId !== undefined, {
          message: "A snapshotId is required when a ref is given.",
        }),
      async (input, { signal }) => ({
        ok: true,
        ...(await gateway.key(botId, actor, input, signal)),
      }),
    ),
    tool(
      "computer_scroll",
      "Scroll down by pixels, or up with a negative deltaY. Defaults to 600.",
      z.strictObject({ deltaY: z.number().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.scroll(botId, actor, input)),
      }),
    ),
    tool(
      "computer_list_files",
      "List files and folders in your workspace. Call first before reading an uncertain filename.",
      z.strictObject({ path: z.string().optional() }),
      async (input) => ({
        ok: true,
        ...(await gateway.listFiles(botId, actor, input)),
      }),
    ),
    tool(
      "computer_read_file",
      "Read a saved file relative to your persistent workspace, such as notes.md.",
      z.strictObject({ path: text }),
      async (input) => ({
        ok: true,
        ...(await gateway.readFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_write_file",
      "Save text in your workspace. Set append to add to the end of an existing file.",
      z.strictObject({
        path: text,
        contents: z.string(),
        append: z.boolean().optional(),
      }),
      async (input) => ({
        ok: true,
        ...(await gateway.writeFile(botId, actor, input)),
      }),
    ),
    tool(
      "computer_run_command",
      "Run a bash shell command in your workspace on your own computer. Pipes and && work; long output is truncated. " +
        COMMAND_TIMEOUT_GUIDE +
        " For package installation use sudo apt-get; if refused say so rather than retrying.",
      z.strictObject({
        command: text,
        // §102：秒（推荐）或毫秒都收；超出 1–600 秒收到边界上，不拒绝。
        timeoutSec: z.coerce
          .number()
          .optional()
          .describe(
            `Seconds before the command is stopped. Default ${COMMAND_DEFAULT_TIMEOUT_SEC}, max ${COMMAND_MAX_TIMEOUT_SEC}. Set it for long commands.`,
          ),
        timeoutMs: z.coerce
          .number()
          .optional()
          .describe("Same limit in milliseconds; prefer timeoutSec."),
      }),
      async ({ command, timeoutSec, timeoutMs }, { signal }) => {
        const timeout = normalizeCommandTimeout({ timeoutSec, timeoutMs });
        return {
          ok: true,
          ...(await gateway.runCommand(
            botId,
            actor,
            {
              command,
              ...(timeout.timeoutMs !== undefined
                ? { timeoutMs: timeout.timeoutMs }
                : {}),
            },
            signal,
          )),
          ...(timeout.clamped
            ? {
                timeoutAdjusted: `The requested timeout was outside 1–${COMMAND_MAX_TIMEOUT_SEC} seconds, so ${timeout.effectiveSec} seconds was used.`,
              }
            : {}),
        };
      },
    ),
    tool(
      "computer_request_help",
      "Create a durable request for the person to take the browser and sign in or clear a challenge. This unattended turn pauses until a person helps; never ask them to send you a password.",
      z.strictObject({ reason: text }),
      async ({ reason }, { toolCallId }) => {
        if (isUnattendedInitiator(actor.initiator)) {
          const msg = UNATTENDED_NEED_HUMAN_ZH(reason);
          return { ok: false, error: msg, reason: msg };
        }
        return waiting(
          await gateway.requestHelp(botId, actor, reason, toolCallId),
          reason,
        );
      },
    ),
    tool(
      "computer_request_secret",
      "Ask the person to enter one secret directly into the focused field. Click the field first. You must never receive the secret; this unattended turn pauses for the person.",
      z.strictObject({ label: text, ref, snapshotId }),
      async (input) => {
        if (isUnattendedInitiator(actor.initiator)) {
          const msg = UNATTENDED_NEED_HUMAN_ZH(`请用户亲自输入「${input.label}」`);
          return { ok: false, error: msg, reason: msg };
        }
        return waiting(
          await gateway.requestSecret(botId, actor, input),
          `The person must enter ${input.label} directly into the page.`,
          "computer_secret",
        );
      },
    ),
  ];
  if (signIn)
    tools.push(
      tool(
        "computer_request_sign_in",
        SIGN_IN_TOOL_DESCRIPTION,
        z.strictObject({ site: text, reason: z.string().optional() }),
        async ({ site, reason }, { toolCallId }) => {
          const continuation = currentApprovalContext();
          if (isUnattendedInitiator(actor.initiator)) {
            const msg = UNATTENDED_NEED_HUMAN_ZH(`登录 ${site}`);
            return { ok: false, error: msg, reason: msg };
          }
          const request = await signIn.request({
            ownerUserId: actor.userId ?? actor.id,
            botId,
            site,
            ...(reason ? { reason } : {}),
            actor,
            ...(continuation?.threadId
              ? { threadId: continuation.threadId }
              : {}),
            toolCallId,
            ...(continuation
              ? {
                  continuation: continuation as unknown as Record<
                    string,
                    unknown
                  >,
                }
              : {}),
            notify: true,
          });
          throw new HeadlessToolSuspension(
            `Waiting for the person to sign in to ${request.origin} in a private form.`,
            {
              kind: "computer_sign_in",
              botId,
              requestId: request.id,
              signInRequestId: request.id,
              site: request.origin,
            },
          );
        },
      ),
    );
  if (auditStore)
    tools.push(
      tool(
        "report_refusal",
        "Record a request you chose to decline, and why. This records evidence and does not enforce a policy.",
        z.strictObject({ reason: text, request: z.string().optional() }),
        async ({ reason, request }) => {
          await recordAuditEvent(auditStore, {
            eventType: "bot.declined",
            targetType: "agent",
            targetId: botId,
            ...(actor.userId ? { actorUserId: actor.userId } : {}),
            initiator: actor.initiator,
            payload: {
              bot: botId,
              actor: actor.id,
              reason: reason.slice(0, 500),
              ...(request ? { request: request.slice(0, 500) } : {}),
              reportedBy: "the Bot itself",
            },
          });
          return { ok: true, recorded: true };
        },
      ),
    );
  return tools;
}
