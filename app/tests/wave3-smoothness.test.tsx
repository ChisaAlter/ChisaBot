import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Observable } from "rxjs";
import { nextIdleInboxCheck } from "@/components/channels/channel-chat";
import { BotBubbles } from "@/components/chat/bot-bubbles";
import { useMotionRest } from "@/hooks";
import {
  ConversationSession,
  ConversationSessionProvider,
  useConversationSession,
  useLiveMessageText,
} from "@/lib/chat/session-client";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motionRest;
});

afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("Wave 3 frontend smoothness", () => {
  test("leaf streaming isolates parent re-renders on tokens #2..#20 while leaf stays live", async () => {
    let parentRenders = 0;
    let leafRenders = 0;
    const observedLengths: number[] = [];

    function StreamingLeaf({
      threadId,
      messageId,
      fallbackText,
    }: {
      threadId: string;
      messageId: string;
      fallbackText: string;
    }) {
      leafRenders += 1;
      const live = useLiveMessageText(threadId, messageId, fallbackText);
      observedLengths.push(live.text.length);
      return (
        <div data-testid="leaf" data-streaming={String(live.streaming)}>
          {live.text}
        </div>
      );
    }

    function Harness({
      onSession,
    }: {
      onSession: (session: ConversationSession) => void;
    }) {
      parentRenders += 1;
      const { agent } = useConversationSession({
        agentId: "channel:leaf-c",
        runtimeAgentId: "bot-leaf",
        threadId: "t-leaf",
      });
      onSession(agent);
      const last = agent.messages.at(-1);
      const text = last && typeof last.content === "string" ? last.content : "";
      return (
        <StreamingLeaf
          fallbackText={text}
          messageId={last?.id ?? "m-0"}
          threadId="t-leaf"
        />
      );
    }

    let session!: ConversationSession;
    const origRun = ConversationSession.prototype.run;
    ConversationSession.prototype.run = () =>
      new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: "RUN_STARTED",
          threadId: "t-leaf",
          runId: "r-leaf",
        } as BaseEvent);
        subscriber.next({
          type: "TEXT_MESSAGE_START",
          messageId: "m-leaf",
          role: "assistant",
        } as BaseEvent);
        let idx = 0;
        const timer = setInterval(() => {
          idx += 1;
          if (idx <= 20) {
            subscriber.next({
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "m-leaf",
              delta: `tok${idx} `,
            } as BaseEvent);
            return;
          }
          clearInterval(timer);
          subscriber.next({
            type: "TEXT_MESSAGE_END",
            messageId: "m-leaf",
          } as BaseEvent);
          subscriber.next({
            type: "RUN_FINISHED",
            threadId: "t-leaf",
            runId: "r-leaf",
          } as BaseEvent);
          subscriber.complete();
        }, 12);
        return () => clearInterval(timer);
      });

    try {
      const view = render(
        <ConversationSessionProvider>
          <Harness
            onSession={(s) => {
              session = s;
            }}
          />
        </ConversationSessionProvider>,
      );

      await act(async () => {
        await settleReactWork();
      });
      const parentBeforeStream = parentRenders;

      await act(async () => {
        await session.runAgent({
          runId: "r-leaf",
        });
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
        await settleReactWork();
      });

      const parentDeltaDuringStream = parentRenders - parentBeforeStream;
      // Structural updates only: start, first non-empty token, end/finalize (<= 6, nowhere near 20 tokens)
      expect(parentDeltaDuringStream).toBeLessThanOrEqual(6);
      expect(leafRenders).toBeGreaterThanOrEqual(2);
      expect(view.getByTestId("leaf").textContent).toContain("tok20");
      // Leaf text length must be monotonically non-decreasing across TEXT_MESSAGE_END / RUN_FINISHED
      // (never regress back to the stale first-token fallbackText prop for even a single render).
      for (let i = 1; i < observedLengths.length; i++) {
        expect(observedLengths[i] ?? 0).toBeGreaterThanOrEqual(
          observedLengths[i - 1] ?? 0,
        );
      }
    } finally {
      ConversationSession.prototype.run = origRun;
    }
  });

  test("BotBubbles folds settled messages >20k chars and expands cleanly on click", async () => {
    const head = `${"概览段落。".repeat(200)}\n\n`;
    const body = `${"超长正文细节。".repeat(3200)}\n\n末尾独特段落-END-MARKER。`;
    const fullText = `${head}${body}`;
    expect(fullText.length).toBeGreaterThan(20_000);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrap = (children: ReactNode) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const view = render(wrap(<BotBubbles streaming={false} text={fullText} />));
    const btn = view.getByTestId("expand-long-message");
    expect(btn.textContent).toContain("展开完整内容");
    expect(view.container.textContent).not.toContain("END-MARKER");

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(view.queryByTestId("expand-long-message")).toBeNull();
    expect(view.container.textContent).toContain("END-MARKER");
  });

  test("useMotionRest sets data-motion-rest='1' when idle and clears immediately on pointerdown", async () => {
    function Probe() {
      useMotionRest(25);
      return <div data-testid="motion-probe" />;
    }
    render(<Probe />);
    expect(document.documentElement.dataset.motionRest).toBeUndefined();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 55));
    });
    expect(document.documentElement.dataset.motionRest).toBe("1");

    await act(async () => {
      fireEvent.pointerDown(window);
    });
    expect(document.documentElement.dataset.motionRest).toBeUndefined();
  });

  test("nextIdleInboxCheck fetches inbox only on initial sync and running->false edge", () => {
    const firstIdle = nextIdleInboxCheck(undefined, false);
    expect(firstIdle).toEqual({ nextRunning: false, shouldFetchInbox: true });

    const secondIdle = nextIdleInboxCheck(firstIdle.nextRunning, false);
    expect(secondIdle).toEqual({ nextRunning: false, shouldFetchInbox: false });

    const thirdIdle = nextIdleInboxCheck(secondIdle.nextRunning, false);
    expect(thirdIdle).toEqual({ nextRunning: false, shouldFetchInbox: false });

    const active = nextIdleInboxCheck(thirdIdle.nextRunning, true);
    expect(active).toEqual({ nextRunning: true, shouldFetchInbox: false });

    const stoppedEdge = nextIdleInboxCheck(active.nextRunning, false);
    expect(stoppedEdge).toEqual({ nextRunning: false, shouldFetchInbox: true });
  });
});
