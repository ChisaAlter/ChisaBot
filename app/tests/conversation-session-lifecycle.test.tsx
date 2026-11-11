import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { Observable } from "rxjs";
import { KeepAliveStage } from "@/components/layout/keep-alive";
import {
  ConversationSession,
  ConversationSessionProvider,
  conversationClient,
  isConversationProgressEvent,
  useConversationSession,
} from "@/lib/chat/session-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register());
afterEach(async () => {
  cleanup();
  await settleReactWork();
});
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});

let captured: ConversationSession[] = [];
function Consumer({ id }: { id: string }) {
  const { agent, connectionStatus } = useConversationSession({
    threadId: id,
    runtimeAgentId: "bot",
    agentId: `channel:${id}`,
  });
  captured.push(agent);
  return <span>{connectionStatus}</span>;
}

test("shared consumers and StrictMode retain one observer until final eviction, never Stop", async () => {
  captured = [];
  const detached = spyOn(
    ConversationSession.prototype,
    "detachActiveRun",
  ).mockResolvedValue(undefined);
  const stopped = spyOn(
    ConversationSession.prototype,
    "stop",
  ).mockResolvedValue({ stopped: true });
  const tree = (second: boolean) => (
    <StrictMode>
      <ConversationSessionProvider>
        <Consumer id="shared" />
        {second ? <Consumer id="shared" /> : null}
      </ConversationSessionProvider>
    </StrictMode>
  );
  try {
    const view = render(tree(true));
    await settleReactWork();
    expect(new Set(captured).size).toBe(1);
    const agent = captured[0]!;
    expect(conversationClient.getAgent("channel:shared")).toBe(agent);
    expect(detached).not.toHaveBeenCalled();
    view.rerender(tree(false));
    await settleReactWork();
    expect(conversationClient.getAgent("channel:shared")).toBe(agent);
    expect(detached).not.toHaveBeenCalled();
    view.unmount();
    await settleReactWork();
    expect(conversationClient.getAgent("channel:shared")).toBeUndefined();
    expect(detached).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
  } finally {
    detached.mockRestore();
    stopped.mockRestore();
  }
});

test("released conversations do not accumulate in the registry", async () => {
  const detached = spyOn(
    ConversationSession.prototype,
    "detachActiveRun",
  ).mockResolvedValue(undefined);
  try {
    for (const id of ["older", "middle", "latest"]) {
      const view = render(<Consumer id={id} />);
      await settleReactWork();
      expect(conversationClient.getAgent(`channel:${id}`)).toBeDefined();
      view.unmount();
      await settleReactWork();
      expect(conversationClient.getAgent(`channel:${id}`)).toBeUndefined();
    }
    expect(detached).toHaveBeenCalledTimes(3);
  } finally {
    detached.mockRestore();
  }
});

test("hiding a kept chat retains observation; actual LRU eviction releases it", async () => {
  const detached = spyOn(
    ConversationSession.prototype,
    "detachActiveRun",
  ).mockResolvedValue(undefined);
  const tree = (address: string | null) => (
    <KeepAliveStage
      address={address}
      same={(left, right) => left === right}
      keyOf={(value) => value}
      max={1}
      renderKept={(value) => <Consumer id={value} />}
    >
      <section>Settings</section>
    </KeepAliveStage>
  );
  try {
    const view = render(tree("kept-a"));
    await settleReactWork();
    const original = conversationClient.getAgent("channel:kept-a");
    view.rerender(tree(null));
    await settleReactWork();
    expect(conversationClient.getAgent("channel:kept-a")).toBe(original);
    expect(detached).not.toHaveBeenCalled();
    view.rerender(tree("kept-b"));
    await settleReactWork();
    expect(conversationClient.getAgent("channel:kept-a")).toBeUndefined();
    expect(conversationClient.getAgent("channel:kept-b")).toBeDefined();
    expect(detached).toHaveBeenCalledTimes(1);
    view.unmount();
    await settleReactWork();
  } finally {
    detached.mockRestore();
  }
});

test("connection events update the existing session observer and terminal events clear them", async () => {
  captured = [];
  const view = render(<Consumer id="connection" />);
  await settleReactWork();
  const agent = captured[0]!;
  let send!: (event: BaseEvent) => void;
  let finish!: () => void;
  const run = spyOn(agent, "run").mockImplementation(
    (_input: RunAgentInput) =>
      new Observable((observer) => {
        send = (event) => observer.next(event);
        finish = () => observer.complete();
      }),
  );
  try {
    let done!: Promise<unknown>;
    await act(async () => {
      done = agent.runAgent();
      await Promise.resolve();
    });
    await act(async () =>
      send({
        type: "RUN_STARTED",
        threadId: "connection",
        runId: "r",
      } as BaseEvent),
    );
    await act(async () =>
      send({
        type: "CUSTOM",
        name: "chisabot.connection",
        value: { status: "reconnecting" },
      } as BaseEvent),
    );
    expect(view.container.textContent).toBe("reconnecting");
    await act(async () =>
      send({
        type: "CUSTOM",
        name: "chisabot.connection",
        value: { status: "online" },
      } as BaseEvent),
    );
    expect(view.container.textContent).toBe("online");
    await act(async () =>
      send({
        type: "CUSTOM",
        name: "chisabot.connection",
        value: { status: "reconnecting" },
      } as BaseEvent),
    );
    await act(async () => {
      send({
        type: "RUN_FINISHED",
        threadId: "connection",
        runId: "r",
      } as BaseEvent);
      finish();
      await done;
    });
    expect(view.container.textContent).toBe("online");
  } finally {
    run.mockRestore();
  }
});

test("reconnection and raw transport frames cannot reset the output watchdog", () => {
  expect(
    isConversationProgressEvent({
      type: "CUSTOM",
      name: "chisabot.connection",
    }),
  ).toBe(false);
  expect(isConversationProgressEvent({ type: "RAW" })).toBe(false);
  expect(isConversationProgressEvent({ type: "TEXT_MESSAGE_CONTENT" })).toBe(
    true,
  );
  expect(isConversationProgressEvent({ type: "TOOL_CALL_RESULT" })).toBe(true);
  expect(isConversationProgressEvent({ type: "RUN_FINISHED" })).toBe(true);
});
