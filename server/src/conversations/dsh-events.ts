import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import type { DshEvent } from "../../../runtime/dsh/src/client.mjs";
import { expandActiveAttempt } from "../../../runtime/dsh/src/client.mjs";

type Attempt = {
  id: string;
  turn: number;
  step: number;
  text: string;
  reasoning: string;
  reasoningStarted: boolean;
  nextIndex: number;
  started: boolean;
  ended: boolean;
  tools: Map<string, { name: string; args: string; ended: boolean }>;
};

/** The AG-UI compatibility edge; DSH remains the execution owner. */
export class DshEventProjection {
  private sourceSeq = -1;
  private readonly settlements = new Map<string, number[]>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly presentations = new Map<string, Attempt>();
  private readonly settled = new Set<string>();
  private readonly waitingCalls = new Set<string>();
  lastReason: Record<string, any> | undefined;
  model: { provider: string; model: string; candidate: number } | undefined;
  usage: Record<string, unknown> | undefined;
  private readonly messages: Map<string, Message>;
  private readonly calls = new Map<
    string,
    { function: { arguments: string } }
  >();

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: BaseEvent) => void,
    initialMessages: readonly Message[] = [],
  ) {
    this.messages = new Map(
      initialMessages.map((message) => [message.id, structuredClone(message)]),
    );
  }

  baseline(records: { event: DshEvent }[], cursor: number) {
    for (const { event } of records) {
      if (event.surfaceOp && typeof event.surfaceOp === "object") continue;
      if (
        event.type === "assistant/message" ||
        event.type === "assistant/attempt"
      ) {
        const key = `${event.data.turn}:${event.data.step}`;
        const settled = this.settlements.get(key) ?? [];
        settled.push(event.seq);
        this.settlements.set(key, settled);
        this.settled.add(
          `${this.sessionId}:assistant:${key}:${settled.length}`,
        );
      }
    }
    this.sourceSeq = cursor;
  }

  private send(value: Record<string, unknown>) {
    const id = String(value.messageId ?? value.parentMessageId ?? "");
    if (value.type === EventType.TEXT_MESSAGE_START && !this.messages.has(id))
      this.messages.set(id, { id, role: "assistant", content: "" });
    if (
      value.type === EventType.REASONING_MESSAGE_START &&
      !this.messages.has(id)
    )
      this.messages.set(id, { id, role: "reasoning", content: "" });
    if (
      value.type === EventType.TEXT_MESSAGE_CONTENT ||
      value.type === EventType.REASONING_MESSAGE_CONTENT
    ) {
      const message = this.messages.get(id);
      if (message?.role === "assistant" || message?.role === "reasoning")
        message.content = `${message.content ?? ""}${value.delta}`;
    }
    if (value.type === EventType.TOOL_CALL_START) {
      const message = this.messages.get(id);
      if (message?.role === "assistant") {
        const call = {
          id: String(value.toolCallId),
          type: "function" as const,
          function: { name: String(value.toolCallName), arguments: "" },
        };
        (message.toolCalls ??= []).push(call);
        this.calls.set(call.id, call);
      }
    }
    if (value.type === EventType.TOOL_CALL_ARGS) {
      const call = this.calls.get(String(value.toolCallId));
      if (call) call.function.arguments += String(value.delta);
    }
    if (value.type === EventType.TOOL_CALL_RESULT)
      this.messages.set(id, {
        id,
        role: "tool",
        toolCallId: String(value.toolCallId),
        content: String(value.content),
      });
    this.emit(value as unknown as BaseEvent);
  }
  private replace() {
    this.send({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: structuredClone([...this.messages.values()]),
    });
  }
  private toolId(attempt: Pick<Attempt, "turn" | "step">, id: string) {
    return `${this.sessionId}:${attempt.turn}:${attempt.step}:${id}`;
  }
  private create(turn: number, step: number, ordinal: number) {
    const key = `${turn}:${step}`;
    const id = `${this.sessionId}:assistant:${key}:${ordinal}`;
    const existing = this.presentations.get(id);
    if (existing) return existing;
    const attempt: Attempt = {
      id,
      turn,
      step,
      text: "",
      reasoning: "",
      reasoningStarted: false,
      nextIndex: 0,
      started: false,
      ended: false,
      tools: new Map(),
    };
    this.presentations.set(id, attempt);
    return attempt;
  }
  private liveAttempt(frame: {
    attemptId: string;
    turn: number;
    step: number;
    startedAfterSeq?: number;
  }) {
    const existing = this.attempts.get(frame.attemptId);
    if (existing) return existing;
    // DSH's wire start anchors a process-local attempt to the durable prefix that preceded it.
    // Reads may overtake that frame; count only earlier settlements to recover its same ordinal.
    // A real retry starts after its predecessor's settlement and therefore gets the next ordinal.
    if (
      !Number.isInteger(frame.startedAfterSeq) ||
      frame.startedAfterSeq! > this.sourceSeq
    )
      throw new Error("DSH stream opening has a source baseline gap.");
    const prior = this.settlements.get(`${frame.turn}:${frame.step}`) ?? [];
    const ordinal =
      prior.filter((seq) => seq <= frame.startedAfterSeq!).length + 1;
    const attempt = this.create(frame.turn, frame.step, ordinal);
    this.attempts.set(frame.attemptId, attempt);
    return attempt;
  }
  private start(attempt: Attempt) {
    if (attempt.started) return;
    attempt.started = true;
    this.send({
      type: EventType.TEXT_MESSAGE_START,
      messageId: attempt.id,
      role: "assistant",
    });
  }
  private startReasoning(attempt: Attempt) {
    if (attempt.reasoningStarted) return;
    attempt.reasoningStarted = true;
    const messageId = `${attempt.id}:reasoning`;
    this.send({ type: EventType.REASONING_START, messageId });
    this.send({
      type: EventType.REASONING_MESSAGE_START,
      messageId,
      role: "reasoning",
    });
  }
  private end(attempt: Attempt) {
    if (attempt.ended) return;
    for (const [id, tool] of attempt.tools) {
      if (!tool.ended) {
        this.send({
          type: EventType.TOOL_CALL_END,
          toolCallId: this.toolId(attempt, id),
        });
        tool.ended = true;
      }
    }
    if (attempt.started)
      this.send({ type: EventType.TEXT_MESSAGE_END, messageId: attempt.id });
    if (attempt.reasoningStarted) {
      this.send({
        type: EventType.REASONING_MESSAGE_END,
        messageId: `${attempt.id}:reasoning`,
      });
      this.send({
        type: EventType.REASONING_END,
        messageId: `${attempt.id}:reasoning`,
      });
    }
    attempt.ended = true;
  }

  live(frame: Record<string, any>) {
    if (frame.type === "start") {
      this.liveAttempt(
        frame as {
          attemptId: string;
          turn: number;
          step: number;
          startedAfterSeq: number;
        },
      );
      return;
    }
    const attempt = this.attempts.get(frame.attemptId);
    if (!attempt)
      throw new Error(
        "A DSH stream chunk arrived without its opening attempt.",
      );
    if (this.settled.has(attempt.id)) return;
    if (frame.type === "end") {
      if (frame.index !== attempt.nextIndex)
        throw new Error("DSH stream settlement has a missing chunk.");
      this.end(attempt);
      return;
    }
    if (frame.type === "chunk") {
      if (frame.index < attempt.nextIndex) return;
      if (frame.index !== attempt.nextIndex)
        throw new Error("DSH stream chunk gap.");
      attempt.nextIndex++;
      this.chunk(attempt, frame.chunk);
    }
  }

  restoreLive(baseline: unknown) {
    const active = expandActiveAttempt(baseline);
    if (!active) return;
    const attempt = this.liveAttempt(active);
    if (this.settled.has(attempt.id)) return;
    if (active.chunks.length !== active.nextIndex)
      throw new Error("DSH reconnect baseline has an incomplete stream.");
    for (let index = attempt.nextIndex; index < active.nextIndex; index++)
      this.chunk(attempt, active.chunks[index]!);
    attempt.nextIndex = active.nextIndex;
  }

  private chunk(attempt: Attempt, chunk: Record<string, any>) {
    if (chunk.type === "text-delta") {
      this.start(attempt);
      attempt.text += chunk.text;
      this.send({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: attempt.id,
        delta: chunk.text,
      });
    } else if (chunk.type === "reasoning-delta") {
      this.startReasoning(attempt);
      attempt.reasoning += chunk.text;
      this.send({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: `${attempt.id}:reasoning`,
        delta: chunk.text,
      });
    } else if (chunk.type === "tool-call-delta") {
      this.start(attempt);
      let tool = attempt.tools.get(chunk.id);
      if (!tool) {
        if (!chunk.name)
          throw new Error("DSH tool arguments arrived before the tool name.");
        tool = { name: chunk.name, args: "", ended: false };
        attempt.tools.set(chunk.id, tool);
        this.send({
          type: EventType.TOOL_CALL_START,
          toolCallId: this.toolId(attempt, chunk.id),
          toolCallName: chunk.name,
          parentMessageId: attempt.id,
        });
      }
      if (chunk.argumentsDelta) {
        tool.args += chunk.argumentsDelta;
        this.send({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: this.toolId(attempt, chunk.id),
          delta: chunk.argumentsDelta,
        });
      }
    } else if (
      chunk.type === "block-end" &&
      chunk.block?.type === "tool-call"
    ) {
      const block = chunk.block;
      if (!attempt.tools.has(block.id))
        this.chunk(attempt, {
          type: "tool-call-delta",
          id: block.id,
          name: block.name,
          argumentsDelta: block.arguments,
        });
      const tool = attempt.tools.get(block.id)!;
      if (tool.args !== block.arguments) {
        if (block.arguments.startsWith(tool.args))
          this.chunk(attempt, {
            type: "tool-call-delta",
            id: block.id,
            argumentsDelta: block.arguments.slice(tool.args.length),
          });
        else {
          tool.args = block.arguments;
          const message = this.messages.get(attempt.id);
          const call =
            message?.role === "assistant"
              ? message.toolCalls?.find(
                  (call) => call.id === this.toolId(attempt, block.id),
                )
              : undefined;
          if (call) {
            call.function.arguments = block.arguments;
            this.replace();
          }
        }
      }
      if (!tool.ended) {
        this.send({
          type: EventType.TOOL_CALL_END,
          toolCallId: this.toolId(attempt, block.id),
        });
        tool.ended = true;
      }
    }
  }

  durable(event: DshEvent) {
    if (event.seq <= this.sourceSeq) return;
    if (event.seq !== this.sourceSeq + 1)
      throw new Error(`DSH event gap after ${this.sourceSeq}.`);
    this.sourceSeq = event.seq;
    const data = event.data;
    // Compaction replaces the model's context surface; the person's transcript stays complete.
    if (event.surfaceOp && typeof event.surfaceOp === "object") return;
    if (event.type === "plugin:chisabot/waiting") {
      this.waitingCalls.add(
        this.toolId(data as Pick<Attempt, "turn" | "step">, data.callId),
      );
    } else if (event.type === "plugin:chisabot/model-route") {
      this.model = {
        provider: data.provider,
        model: data.model,
        candidate: data.candidate,
      };
    } else if (
      event.type === "assistant/message" ||
      event.type === "assistant/attempt"
    ) {
      const key = `${data.turn}:${data.step}`;
      const settlements = this.settlements.get(key) ?? [];
      const attempt = this.create(data.turn, data.step, settlements.length + 1);
      settlements.push(event.seq);
      this.settlements.set(key, settlements);
      if (event.type === "assistant/message") {
        const content = data.message.content as Record<string, any>[];
        let replaced = false;
        const kinds = new Set<string>();
        const reconcileText = (kind: "text" | "reasoning") => {
          const value = content
            .filter((block) => block.type === kind)
            .map((block) => block.text)
            .join("");
          const previous = attempt[kind];
          if (value === previous) return;
          if (!attempt.ended && value.startsWith(previous))
            this.chunk(attempt, {
              type: `${kind}-delta`,
              text: value.slice(previous.length),
            });
          else {
            // A durable settlement may correct a stream after its END. Replace that same
            // message instead of appending a CONTENT event to a closed protocol lifecycle.
            const id = kind === "text" ? attempt.id : `${attempt.id}:reasoning`;
            if (!attempt.ended)
              kind === "text"
                ? this.start(attempt)
                : this.startReasoning(attempt);
            const message = this.messages.get(id);
            if (message?.role === "assistant" || message?.role === "reasoning")
              message.content = value;
            else if (value)
              this.messages.set(id, {
                id,
                role: kind === "text" ? "assistant" : "reasoning",
                content: value,
              });
            attempt[kind] = value;
            replaced = true;
          }
        };
        // Preserve the source ordering during durable-only replay too, so reasoning does not
        // move below the answer after an API restart or a snapshot rebuild.
        for (const block of content) {
          if (
            (block.type === "text" || block.type === "reasoning") &&
            !kinds.has(block.type)
          ) {
            kinds.add(block.type);
            reconcileText(block.type);
          } else if (block.type === "tool-call") {
            if (!attempt.ended)
              this.chunk(attempt, { type: "block-end", block });
            else {
              const id = this.toolId(attempt, block.id);
              let message = this.messages.get(attempt.id);
              if (!message) {
                message = {
                  id: attempt.id,
                  role: "assistant",
                  content: attempt.text,
                };
                this.messages.set(attempt.id, message);
              }
              if (message.role !== "assistant")
                throw new Error(
                  "DSH assistant identity conflicts with a saved message.",
                );
              const call = message.toolCalls?.find((call) => call.id === id);
              if (call) {
                if (
                  call.function.arguments !== block.arguments ||
                  call.function.name !== block.name
                ) {
                  call.function = {
                    name: block.name,
                    arguments: block.arguments,
                  };
                  replaced = true;
                }
              } else {
                const next = {
                  id,
                  type: "function" as const,
                  function: { name: block.name, arguments: block.arguments },
                };
                (message.toolCalls ??= []).push(next);
                this.calls.set(id, next);
                replaced = true;
              }
              attempt.tools.set(block.id, {
                name: block.name,
                args: block.arguments,
                ended: true,
              });
            }
          }
        }
        if (!kinds.has("text") && attempt.text) reconcileText("text");
        if (!kinds.has("reasoning") && attempt.reasoning)
          reconcileText("reasoning");
        if (replaced) this.replace();
        this.usage = data.usage;
      } else
        for (const [id] of attempt.tools)
          this.send({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: this.toolId(attempt, id),
            messageId: `${attempt.id}:unexecuted:${id}`,
            role: "tool",
            content: "模型请求未完成，这次工具调用未执行。",
          });
      this.end(attempt);
      this.settled.add(attempt.id);
    } else if (event.type === "tool/result") {
      const message = data.message;
      if (
        this.waitingCalls.has(
          this.toolId(
            data as Pick<Attempt, "turn" | "step">,
            message.toolCallId,
          ),
        )
      )
        return;
      this.send({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: this.toolId(
          data as Pick<Attempt, "turn" | "step">,
          message.toolCallId,
        ),
        messageId: `${this.sessionId}:tool-result:${event.seq}`,
        role: "tool",
        content: message.content
          .filter((x: Record<string, any>) => x.type === "text")
          .map((x: Record<string, any>) => x.text)
          .join("\n"),
      });
    } else if (event.type === "turn/end") this.lastReason = data.reason;
  }

  get cursor() {
    return this.sourceSeq;
  }
  snapshot(): Message[] {
    return structuredClone([...this.messages.values()]);
  }
}
