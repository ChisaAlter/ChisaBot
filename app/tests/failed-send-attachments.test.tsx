import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message, RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { type InfiniteData, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelChat } from "@/components/channels/channel-chat";
import {
  attachmentUrl,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/channels/attachments";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  channelKeys,
} from "@/lib/channels/queries";
import {
  ConversationSessionProvider,
  conversationClient,
} from "@/lib/chat/session-client";
import { queryClient } from "@/query-client";
import {
  applyInboxState,
  queuedFor,
} from "../src/lib/conversations/thread-inbox";
import { installFetchBackedXhr } from "./fetch-backed-xhr";
import { settleReactWork } from "./settle-react-work";

/**
 * WHAT A FAILED SEND DOES TO THE FILES IT WAS CARRYING, DRIVEN THROUGH THE REAL CHANNEL.
 *
 * The composer suites reach this area through a fake `onSubmit` and `messages={[]}`, which is
 * exactly the state in which deleting a failed send's rows looks harmless: there is no transcript
 * to contradict, so a test can watch the DELETE go out and call it a release. The whole point of
 * this file is that the transcript IS there. `ChannelChat` is what turns a draft into a message —
 * it adds the user turn to `agent.messages` BEFORE the run, so by the time the run fails the
 * screen is already showing a message whose attachments point at those rows — and only a test
 * that goes through it can see the two halves at once.
 *
 * So everything below the HTTP boundary is real: the provider, the agent, `say`/`deliver`, the
 * conversation view's queue, and the composer. Only `fetch` is a fixture, and it is the fixture
 * that decides the two failures under test — a run that answers 500, and an upload that answers
 * with a stored row id.
 *
 * TEXT FILES RATHER THAN THE REVIEWER'S SCREENSHOT, and nothing in the path cares: a staged row is
 * a staged row, `attachmentUrl` addresses both the same way, and the release, the cap and the
 * queue all count them identically. An image tile would additionally ask happy-dom to load an
 * `<img>`, which is a second fixture for a detail this file is not about.
 *
 * THE HARNESS IS THIS REPOSITORY'S. `GlobalRegistrator` in `beforeAll`/`afterAll`, `cleanup` in
 * `afterEach`, and `settleReactWork()` before the document goes away — see that helper for what a
 * scheduler callback landing after `unregister()` does to an otherwise green run.
 */

const NativeResponse = globalThis.Response;

const channel: AgentChannel = {
  id: "failed-send-channel",
  name: "Failed send",
  agentIds: ["failed-send-bot"],
  threadId: "failed-send-thread",
  active: true,
  lastMessageAt: "2026-09-09T00:00:00.000Z",
};

const opening = {
  id: "opening",
  role: "assistant",
  content: "Stored opening",
} satisfies Message;

/** The run inputs that actually left the browser, in order. */
let runs: RunAgentInput[];
/** Every `DELETE /api/attachments/:id` the screen sent, by path. */
let deletes: string[];
/** Every upload that actually left the browser, by file name. */
let uploads: string[];
/**
 * What each run answers, by the order it was started. A test installs one entry per run it expects;
 * anything past the end finishes normally, so a stray run is visible as an extra entry in `runs`
 * rather than as a hang.
 */
let runAnswers: ((input: RunAgentInput) => Promise<Response>)[];
const admittedEvents = new Map<string, Response>();
/** The server inbox: rows queued while a turn runs, by id, in the order they arrived. */
const inbox = new Map<
  string,
  { id: string; status: string; kind: string; message: { content?: unknown } }
>();
let core: typeof conversationClient | undefined;
let originalFetch: typeof fetch;

function CoreProbe() {
  core = conversationClient;
  return null;
}

function sse(events: unknown[]) {
  return new NativeResponse(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function finished(input: RunAgentInput) {
  return sse([
    { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
    { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId },
  ]);
}

/** A response this test hands over when it decides to, not when the fixture is called. */
function deferred() {
  let settle: (response: Response) => void = () => {
    throw new Error("Deferred response not initialized");
  };
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  installFetchBackedXhr();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        "http://localhost",
      );
      if (url.pathname.endsWith("/inbox")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as {
            id: string;
            text?: string;
            message?: { content?: unknown };
          };
          if (!inbox.has(body.id))
            inbox.set(body.id, {
              id: body.id,
              status: "queued",
              kind: "message",
              message: body.message ?? { content: body.text ?? "" },
            });
          return NativeResponse.json({
            queued: true,
            status: inbox.get(body.id)!.status,
          });
        }
        if (init?.method === "DELETE") {
          const id = url.searchParams.get("id") ?? "";
          return NativeResponse.json({ withdrawn: inbox.delete(id) });
        }
        return NativeResponse.json({
          running: false,
          paused: false,
          items: [...inbox.values()],
        });
      }
      if (init?.method === "DELETE") {
        deletes.push(url.pathname);
        return new NativeResponse(null, { status: 204 });
      }
      if (url.pathname === "/api/agents")
        return NativeResponse.json({ agents: [] });
      if (url.pathname === "/api/plugins/for/failed-send-bot")
        return NativeResponse.json({ skills: [], tools: [] });
      if (url.pathname.endsWith("/info"))
        return NativeResponse.json({
          version: "fixture",
          agents: {
            "failed-send-bot": { description: "Fixture", capabilities: {} },
          },
          mode: "sse",
          telemetryDisabled: true,
        });
      if (url.pathname.endsWith("/connect"))
        return sse([
          { type: "RUN_STARTED", threadId: channel.threadId, runId: "join" },
          { type: "MESSAGES_SNAPSHOT", messages: [opening] },
          { type: "RUN_FINISHED", threadId: channel.threadId, runId: "join" },
        ]);
      if (url.pathname.endsWith("/commands")) {
        const request =
          input instanceof Request ? input : new Request(url, init);
        const body = RunAgentInputSchema.parse(
          ((await request.json()) as { input: unknown }).input,
        );
        const answer = runAnswers[runs.length];
        runs.push(body);
        const response = answer ? await answer(body) : finished(body);
        if (!response.ok) return response;
        // An admitted command answers the inbox rows it carries, as the server does.
        for (const message of body.messages) {
          const row = inbox.get(message.id);
          if (row) row.status = "answered";
        }
        const commandId = body.messages.findLast(
          (message) => message.role === "user",
        )!.id;
        admittedEvents.set(commandId, response);
        return NativeResponse.json(
          { accepted: true, commandId, runId: body.runId },
          { status: 202 },
        );
      }
      if (url.pathname.endsWith("/events")) {
        const { commandId } = JSON.parse(String(init?.body));
        return admittedEvents.get(commandId)!;
      }
      if (/\/api\/channels\/[^/]+\/attachments$/.test(url.pathname)) {
        const body = init?.body as FormData;
        const file = body.get("file") as File;
        uploads.push(file.name);
        return NativeResponse.json(
          {
            // One stored id per file, derived from its name, so a DELETE can be attributed to the
            // file it was for rather than to "the attachment".
            id: `stored-${file.name}`,
            name: file.name,
            mimeType: "text/plain",
          },
          { status: 201 },
        );
      }
      // Channel chats have no bot-thread sync surface; 404 → readSync "unsupported" →
      // settleDroppedTurn("lost") immediately. Without this, a 5xx /run is treated as a
      // connection drop and the harness polls for ~10s (null sync), so restore assertions
      // time out while the product path on channels would already have failed honestly.
      if (url.pathname.startsWith("/api/bot-threads/"))
        return new NativeResponse(null, { status: 404 });
      if (/\/api\/channels\/[^/]+\/(activity|busy)$/.test(url.pathname))
        return new NativeResponse(null, { status: 204 });
      if (/\/threads\/[^/]+\/messages$/.test(url.pathname))
        return NativeResponse.json({ messages: [opening] });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    },
    {
      preconnect() {
        throw new Error("Unexpected fixture preconnect");
      },
    },
  );
});

beforeEach(() => {
  runs = [];
  deletes = [];
  uploads = [];
  runAnswers = [];
  admittedEvents.clear();
  inbox.clear();
});

afterEach(() => {
  // The queue store outlives a render: answer this thread's rows so the next test starts empty.
  applyInboxState("failed-send-thread", {
    running: false,
    items: queuedFor("failed-send-thread").map((item) => ({
      id: item.id,
      status: "answered",
      kind: "message",
      message: {},
    })),
  });
  cleanup();
  queryClient.clear();
  core = undefined;
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function cacheChannel() {
  const summary: ChannelSummary = {
    ...channel,
    summary: null,
    lastMessage: null,
    lastMessageAgentId: "failed-send-bot",
    lastMessageAt: channel.lastMessageAt,
    createdAt: "2026-09-09T00:00:00.000Z",
    pinned: false,
    lastReadAt: null,
  };
  queryClient.setQueryData<InfiniteData<ChannelPage>>(channelKeys.list(), {
    pages: [{ channels: [summary], nextCursor: null }],
    pageParams: [""],
  });
}

async function mounted() {
  cacheChannel();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConversationSessionProvider>
        <CoreProbe />
        <ChannelChat channel={channel} runtimeAgentId="failed-send-bot" />
      </ConversationSessionProvider>
    </QueryClientProvider>,
  );
  await view.findByText(opening.content);
  return view;
}

function currentAgent() {
  const agent = core?.getAgent(`channel:${channel.id}`);
  if (!agent) throw new Error("Mounted channel agent is not registered");
  return agent;
}

function form({ container }: RenderResult) {
  return container.querySelector("form") as HTMLFormElement;
}

/** A drop, as the browser delivers one: files hanging off `dataTransfer`. */
function drop(target: Element, files: File[]) {
  fireEvent.drop(target, {
    dataTransfer: { files, items: [], types: ["Files"] },
  });
}

function named(name: string) {
  return new File([name], name, { type: "text/plain" });
}

/**
 * A dropped file, all the way up. See `composer-attachments-ui.test.tsx` for the full note: the
 * chip appears when the upload STARTS, so only the send button coming back on says it has landed.
 */
async function uploaded(view: RenderResult, names: readonly string[]) {
  await waitFor(() => {
    for (const name of names) {
      expect(view.queryByLabelText(`移除 ${name}`)).not.toBeNull();
    }
    const button = (view.queryByLabelText("发送消息") ??
      view.queryByLabelText("排队发送")) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
  });
}

/** Every attachment chip on the composer's strip, by the name on its Remove button. */
function chips({ container }: RenderResult) {
  return Array.from(container.querySelectorAll("[aria-label^='移除 ']"))
    .map((element) => element.getAttribute("aria-label") ?? "")
    .filter((label) => !label.startsWith("移除队列消息"))
    .map((label) => label.slice("移除 ".length));
}

/** The queued stack under the transcript: the server inbox rows this tab shows. */
function queueStack({ container }: RenderResult) {
  return (
    container.querySelector("[data-testid='queued-messages']")?.textContent ??
    ""
  );
}

/**
 * FINDING 1. A drained turn whose send fails must not drop the queued message or its files.
 *
 * A correction typed at a working Bot goes to the server inbox with its attachment. When the turn
 * ends the queue drains as the next turn; if that send fails before the server admits it, nothing
 * was sent: the row comes back as a failed, retryable entry carrying its file, it is not drawn in
 * the transcript as if it had been sent, it is not re-sent on its own, and no row is released.
 */
test("a drained turn whose send fails keeps the message and its file as a retryable row", async () => {
  const firstRun = deferred();
  runAnswers = [
    // The turn the file is queued behind: held open until this test ends it.
    () => firstRun.promise,
    // The drained turn: a transient upstream failure before anything is admitted.
    async () => new NativeResponse("upstream unavailable", { status: 500 }),
  ];

  const view = await mounted();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  await user.type(view.getByRole("textbox", { name: "消息" }), "Get started");
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  drop(form(view), [named("plan.txt")]);
  await uploaded(view, ["plan.txt"]);
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Use the attached plan",
  );
  await user.click(view.getByRole("button", { name: "排队发送" }));
  await waitFor(() =>
    expect(queueStack(view)).toContain("Use the attached plan"),
  );
  expect([...inbox.keys()]).toHaveLength(1);
  expect(deletes).toEqual([]);

  // The turn ends, the queue drains, and the drained send fails.
  firstRun.settle(finished(runs[0] as RunAgentInput));
  await waitFor(() => expect(runs).toHaveLength(2));
  expect(JSON.stringify(runs[1]?.messages.at(-1)?.content)).toContain(
    attachmentUrl("stored-plan.txt"),
  );

  // THE FINDING. The words and the file are back as a failed row someone can retry.
  await waitFor(() => {
    const stack = queueStack(view);
    expect(stack).toContain("Use the attached plan");
    expect(stack).toContain("plan.txt");
    expect(stack).toContain("没发出去");
  });
  // Not shown as a sent message, not re-sent on its own, and no row released.
  expect(
    currentAgent().messages.some(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("Use the attached plan"),
    ),
  ).toBe(false);
  await settleReactWork();
  expect(runs).toHaveLength(2);
  expect(deletes).toEqual([]);
});

/**
 * FINDING 2. Restoring a failed send beside newly staged files must not produce a sendable draft
 * over the per-message cap.
 *
 * `sending` hides the outgoing files from `staged`, so the cap screening counts zero while a send
 * is out and a second full batch is accepted behind it. When the response then fails, clearing
 * `sending` puts both batches on one strip — and `canSendDraft` asks about upload status and
 * emptiness, not about the cap, so that doubled draft stayed sendable and the retry shipped twice
 * the server's per-message budget.
 */
test("a failed send restored beside a second batch cannot be retried over the per-message cap", async () => {
  const firstRun = deferred();
  runAnswers = [() => firstRun.promise];

  const view = await mounted();
  const first = Array.from(
    { length: MAX_ATTACHMENTS_PER_MESSAGE },
    (_, index) => named(`first-${index}.txt`),
  );
  const second = Array.from(
    { length: MAX_ATTACHMENTS_PER_MESSAGE },
    (_, index) => named(`second-${index}.txt`),
  );

  drop(form(view), first);
  await uploaded(
    view,
    first.map((file) => file.name),
  );
  fireEvent.submit(form(view));
  await waitFor(() => expect(runs).toHaveLength(1));
  // The send took them off the strip, which is what frees the client-side count for the batch
  // below — the server has stamped them by now, so it will not refuse these either.
  expect(chips(view)).toEqual([]);

  drop(form(view), second);
  await uploaded(
    view,
    second.map((file) => file.name),
  );
  expect(uploads).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE * 2);

  // The response fails, so the first batch comes back beside the second.
  firstRun.settle(new NativeResponse("upstream unavailable", { status: 500 }));
  await waitFor(() =>
    expect(chips(view)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE * 2),
  );

  // THE FINDING. Sixteen attachments is not a message this deployment accepts, and the button that
  // sends it must say so rather than letting the retry discover it as a rejected request.
  const send = view.getByLabelText("发送消息") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  expect(
    view.getByText(new RegExp(`最多 ${MAX_ATTACHMENTS_PER_MESSAGE}`)),
  ).toBeTruthy();

  // Nothing was dropped to get there: every file is still on the strip and still deletable by the
  // person who picked it, and no row was released behind their back.
  expect(deletes).toEqual([]);
  expect(runs).toHaveLength(1);

  // AND IT IS A GATE, NOT A DEAD END. Taking the second batch off by hand — the gesture that HAS
  // always justified releasing a row — puts the draft back inside the cap and Send comes back on.
  for (const file of second) {
    fireEvent.click(view.getByLabelText(`移除 ${file.name}`));
  }
  await waitFor(() => {
    expect(chips(view)).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(
      (view.getByLabelText("发送消息") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  await waitFor(() =>
    expect(deletes).toEqual(
      second.map((file) => attachmentUrl(`stored-${file.name}`)),
    ),
  );
});

/**
 * THE OTHER HALF OF "RETRYABLE", THROUGH THE SAME REAL PATH. A restored row that nothing ever
 * carries is just an undeleted file with a button on it. The retry is one the person asks for, and
 * it carries the same message with its file.
 */
test("retrying the restored row sends the same message with its file", async () => {
  const firstRun = deferred();
  runAnswers = [
    () => firstRun.promise,
    async () => new NativeResponse("upstream unavailable", { status: 500 }),
  ];

  const view = await mounted();
  const user = userEvent.setup({ document: view.container.ownerDocument });

  await user.type(view.getByRole("textbox", { name: "消息" }), "Get started");
  await user.click(view.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(runs).toHaveLength(1));

  drop(form(view), [named("plan.txt")]);
  await uploaded(view, ["plan.txt"]);
  await user.type(
    view.getByRole("textbox", { name: "消息" }),
    "Use the attached plan",
  );
  await user.click(view.getByRole("button", { name: "排队发送" }));
  await waitFor(() =>
    expect(queueStack(view)).toContain("Use the attached plan"),
  );

  firstRun.settle(finished(runs[0] as RunAgentInput));
  await waitFor(() => expect(runs).toHaveLength(2));
  await waitFor(() => expect(queueStack(view)).toContain("没发出去"));
  await settleReactWork();
  expect(runs).toHaveLength(2);

  // The person retries it.
  const stack = view.container.querySelector(
    "[data-testid='queued-messages']",
  ) as HTMLElement;
  await user.click(within(stack).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(runs).toHaveLength(3));

  const sent = runs[2]?.messages.at(-1);
  expect(sent?.id).toBe(runs[1]?.messages.at(-1)?.id);
  expect(JSON.stringify(sent?.content)).toContain(
    attachmentUrl("stored-plan.txt"),
  );
  expect(JSON.stringify(sent?.content)).toContain("Use the attached plan");

  // Carried, not copied: nothing is left waiting to run again, and no row was released.
  await waitFor(() =>
    expect(queueStack(view)).not.toContain("Use the attached plan"),
  );
  expect(deletes).toEqual([]);
});
