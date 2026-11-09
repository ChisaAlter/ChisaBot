/** Local provider wire fixtures used by the real AI SDK callers. No credentials leave loopback. */
export type ModelReply = {
  type?: "text";
  content?: string;
  toolCalls?: { id: string; name: string; arguments: unknown }[];
};
type Message = {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  [key: string]: unknown;
};
type Body = Record<string, any>;
type Rule = {
  match: string | RegExp | { toolResult: string | true };
  reply: ModelReply | (() => ModelReply);
};
const sse = (events: unknown[], named = false) =>
  new Response(
    events
      .map(
        (event: any) =>
          `${named ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

/** Explicit inspection view; `requests[].body` remains the original provider payload. */
export function modelMessages(body: Body): Message[] {
  if (Array.isArray(body.input))
    return [
      ...(body.instructions
        ? [{ role: "system", content: body.instructions }]
        : []),
      ...body.input.map((entry: any) =>
        entry.type === "function_call_output"
          ? { role: "tool", tool_call_id: entry.call_id, content: entry.output }
          : {
              ...entry,
              content: Array.isArray(entry.content)
                ? entry.content.map((part: any) => part.text ?? "").join("")
                : entry.content,
            },
      ),
    ];
  return (body.messages ?? []).flatMap((entry: any) =>
    Array.isArray(entry.content)
      ? entry.content
          .filter((part: any) => part.type === "tool_result")
          .map((part: any) => ({
            role: "tool",
            tool_call_id: part.tool_use_id,
            content: part.content,
          }))
          .concat([
            {
              ...entry,
              content: entry.content
                .filter((part: any) => part.type !== "tool_result")
                .map((part: any) => part.text ?? "")
                .join(""),
            },
          ])
      : [entry],
  );
}

function wireResponse(path: string, body: Body, reply: ModelReply) {
  const text = reply.content ?? "";
  const calls = reply.toolCalls ?? [];
  const args = (value: unknown) =>
    typeof value === "string" ? value : JSON.stringify(value);
  if (path.endsWith("/messages")) {
    const content = [
      ...(text ? [{ type: "text", text }] : []),
      ...calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: JSON.parse(args(call.arguments)),
      })),
    ];
    const message = {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: calls.length ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (!body.stream) return Response.json(message);
    return sse(
      [
        {
          type: "message_start",
          message: {
            ...message,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        ...content.flatMap<unknown>((block, index) =>
          block.type === "text"
            ? [
                {
                  type: "content_block_start",
                  index,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text },
                },
                { type: "content_block_stop", index },
              ]
            : [
                {
                  type: "content_block_start",
                  index,
                  content_block: { ...block, input: {} },
                },
                {
                  type: "content_block_delta",
                  index,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify((block as any).input),
                  },
                },
                { type: "content_block_stop", index },
              ],
        ),
        {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason, stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ],
      true,
    );
  }
  if (path.endsWith("/responses")) {
    const output = [
      ...(text
        ? [
            {
              type: "message",
              id: "fixture-text",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ]
        : []),
      ...calls.map((call) => ({
        type: "function_call",
        id: `item-${call.id}`,
        call_id: call.id,
        name: call.name,
        arguments: args(call.arguments),
        status: "completed",
      })),
    ];
    const response = {
      id: "fixture-response",
      object: "response",
      created_at: 1,
      model: body.model,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    if (!body.stream) return Response.json(response);
    return sse([
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      ...output.flatMap((item: any, output_index) =>
        item.type === "message"
          ? [
              {
                type: "response.output_item.added",
                output_index,
                item: { ...item, status: "in_progress", content: [] },
              },
              {
                type: "response.output_text.delta",
                output_index,
                item_id: item.id,
                content_index: 0,
                delta: text,
              },
              { type: "response.output_item.done", output_index, item },
            ]
          : [
              {
                type: "response.output_item.added",
                output_index,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index,
                item_id: item.id,
                delta: item.arguments,
              },
              { type: "response.output_item.done", output_index, item },
            ],
      ),
      { type: "response.completed", response },
    ]);
  }
  if (path.endsWith("/chat/completions")) {
    const tool_calls = calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: args(call.arguments) },
    }));
    const base = { id: "fixture-chat", created: 1, model: body.model };
    if (!body.stream)
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text,
              ...(calls.length ? { tool_calls } : {}),
            },
            finish_reason: calls.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    return sse([
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: text,
              ...(calls.length
                ? {
                    tool_calls: tool_calls.map((call, index) => ({
                      ...call,
                      index,
                    })),
                  }
                : {}),
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: calls.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]);
  }
  return Response.json(
    { error: `Unexpected provider path: ${path}` },
    { status: 404 },
  );
}

export function createModelFixture() {
  const rules: Rule[] = [];
  const requests: { path: string; body: Body }[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  return {
    rules,
    requests,
    get url() {
      return server?.url.origin ?? "";
    },
    async start() {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          const body = (await request.json()) as Body;
          requests.push({ path, body });
          const messages = modelMessages(body);
          const rule = rules.find(({ match }) =>
            typeof match === "object" && !(match instanceof RegExp)
              ? messages.some(
                  (message) =>
                    message.role === "tool" &&
                    (match.toolResult === true ||
                      message.tool_call_id === match.toolResult),
                )
              : messages.some(
                  (message) =>
                    message.role !== "tool" &&
                    (typeof match === "string"
                      ? String(message.content).includes(match)
                      : ((match.lastIndex = 0),
                        match.test(String(message.content)))),
                ),
          );
          if (!rule)
            return Response.json(
              { error: "No matching fixture response" },
              { status: 500 },
            );
          return wireResponse(
            path,
            body,
            typeof rule.reply === "function" ? rule.reply() : rule.reply,
          );
        },
      });
      return server.url.origin;
    },
    async stop() {
      await server?.stop(true);
      server = undefined;
    },
  };
}
