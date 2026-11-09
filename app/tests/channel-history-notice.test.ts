import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { channelHistoryNotice } from "../src/components/channels/channel-chat";
import {
  readThreadMessages,
  type StoredThread,
} from "../src/lib/conversations/thread-messages";

function HistoryNoticeProbe({
  lastMessageAt,
}: {
  lastMessageAt: string | null;
}) {
  const [thread, setThread] = useState<StoredThread | null>(null);

  useEffect(() => {
    void readThreadMessages("thread-1", "agent-1").then(setThread);
  }, []);

  if (!thread) return null;
  const notice = channelHistoryNotice({
    restoring: false,
    messageCount: thread.messages.length,
    lastMessageAt,
    historyAvailability: thread.availability,
    historyReadFailed: thread.availability === "unavailable",
    unreadable: thread.unreadable,
  });
  return createElement(
    "div",
    { "data-testid": "history-read" },
    notice ? createElement("p", { role: "status" }, notice) : null,
  );
}

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

async function withFetch(handler: FetchHandler, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, {
    preconnect: original.preconnect,
  });
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

describe("channel history notice", () => {
  test("failed history retrieval does not claim the deployment changed", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      unreadable: 0,
    });

    expect(notice).toContain("暂时无法加载");
    expect(notice).not.toContain("different");
    expect(notice).not.toContain("fresh history");
  });

  test("unreadable empty history reports holes without project-change wording", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "ready",
      unreadable: 1,
    });

    expect(notice).toContain("有一条较早的消息无法读取");
    expect(notice).not.toContain("different");
  });

  test("a malformed successful history response renders the unavailable notice", async () => {
    await withFetch(
      async () => Response.json({ messages: "not an array" }),
      async () => {
        const view = render(
          createElement(HistoryNoticeProbe, {
            lastMessageAt: "2026-09-08T12:00:00.000Z",
          }),
        );

        expect((await view.findByRole("status")).textContent).toContain(
          "较早的消息暂时无法加载",
        );
        expect(view.queryByText(/different/)).toBeNull();
      },
    );
  });

  test("an explicit empty history response renders no notice", async () => {
    await withFetch(
      async () => Response.json({ messages: [] }),
      async () => {
        const view = render(
          createElement(HistoryNoticeProbe, {
            lastMessageAt: "2026-09-08T12:00:00.000Z",
          }),
        );

        await view.findByTestId("history-read");
        expect(view.queryByRole("status")).toBeNull();
      },
    );
  });

  test("a malformed successful history response keeps the unavailable notice visible", () => {
    const notice = channelHistoryNotice({
      restoring: false,
      messageCount: 0,
      lastMessageAt: "2026-09-08T12:00:00.000Z",
      historyAvailability: "unavailable",
      historyReadFailed: true,
      unreadable: 0,
    });

    expect(notice).toContain("暂时无法加载");
    expect(notice).not.toContain("different");
  });

  test("valid empty history in a used channel has no project-change notice", () => {
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 0,
        lastMessageAt: "2026-09-08T12:00:00.000Z",
        historyAvailability: "ready",
        unreadable: 0,
      }),
    ).toBeNull();
  });
  test("a failed history read over a transcript that already shows messages says nothing", () => {
    // 只有什么都没恢复出来时才提示；已经有消息时后台继续重试，不打扰。
    expect(
      channelHistoryNotice({
        restoring: false,
        messageCount: 3,
        lastMessageAt: null,
        historyAvailability: "unavailable",
        unreadable: 0,
        historyReadFailed: true,
      }),
    ).toBeNull();
  });

  test("no notice while the background retry is still running", () => {
    expect(
      channelHistoryNotice({
        restoring: true,
        messageCount: 0,
        lastMessageAt: "Tue 2026-09-08 8:00 PM CST (UTC+08:00)",
        historyAvailability: "unavailable",
        unreadable: 0,
        historyReadFailed: true,
      }),
    ).toBeNull();
  });
});
