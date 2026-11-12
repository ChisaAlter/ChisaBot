import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { attachmentUrl } from "@/lib/channels/attachments";
import {
  type MessageActions,
  MessageActionsContext,
} from "@/lib/conversations/regenerate";
import { settleReactWork } from "./settle-react-work";

let realFetch: typeof fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(null, { status: 200 }),
    )) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

function renderWithActions(
  messages: readonly Message[],
  options: {
    stopped?: string;
    onRetry?: () => void;
    onWithdraw?: () => void;
    actions?: MessageActions;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const defaultActions: MessageActions = options.actions ?? {
    canAct: true,
    regenerate: async () => {},
    edit: async () => {},
    withdraw: async () => {},
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <MessageActionsContext.Provider value={defaultActions}>
        <ChatTranscript
          messages={messages}
          {...(options.stopped ? { stopped: options.stopped } : {})}
          {...(options.onRetry ? { onRetry: options.onRetry } : {})}
          {...(options.onWithdraw ? { onWithdraw: options.onWithdraw } : {})}
        />
      </MessageActionsContext.Provider>
    </QueryClientProvider>,
  );
}

test("privacy-gate 错误卡片隐藏无效的重试按钮，并提供一键「撤回这条消息」按钮", () => {
  let retried = 0;
  let withdrawn = 0;
  const messages: Message[] = [
    {
      id: "u-img-only",
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", value: attachmentUrl("att-1") },
          metadata: { attachmentId: "att-1", filename: "screen.png" },
        },
      ],
    } as unknown as Message,
  ];
  const view = renderWithActions(messages, {
    stopped:
      '这一轮出错了：privacy-gate: a content part of type "image_url" cannot be masked locally; extract it to text first (Settings -> Privacy masks text only). Nothing was sent.',
    onRetry: () => {
      retried += 1;
    },
    onWithdraw: () => {
      withdrawn += 1;
    },
  });

  const card = view.getByTestId("transcript-stopped");
  expect(card.textContent).toContain(
    "当前模型网关开启了本地隐私脱敏，不能直接发送图片",
  );
  expect(card.textContent).not.toContain("重试");

  const withdrawBtn = view.getByTestId("transcript-withdraw");
  expect(withdrawBtn.textContent).toContain("撤回这条消息");
  fireEvent.click(withdrawBtn);
  expect(withdrawn).toBe(1);
  expect(retried).toBe(0);
});

test("纯图片无配文的用户消息也渲染「编辑」与「撤回」操作按钮", async () => {
  const withdrawnIds: string[] = [];
  const messages: Message[] = [
    {
      id: "u-pure-image",
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", value: attachmentUrl("att-pure") },
          metadata: { attachmentId: "att-pure", filename: "pure.png" },
        },
      ],
    } as unknown as Message,
  ];
  const view = renderWithActions(messages, {
    actions: {
      canAct: true,
      regenerate: async () => {},
      edit: async () => {},
      withdraw: async (id) => {
        withdrawnIds.push(id);
      },
    },
  });

  expect(view.getByTestId("msg-edit")).toBeDefined();
  const withdrawPill = view.getByTestId("msg-withdraw");
  fireEvent.click(withdrawPill);
  await waitFor(() => {
    expect(withdrawnIds).toEqual(["u-pure-image"]);
  });
});

test("带图片和文字的用户消息在原地编辑时支持移除图片附件后直接重发纯文字", async () => {
  const edits: Array<{
    id: string;
    text: string;
    removed: number[];
  }> = [];
  const messages: Message[] = [
    {
      id: "u-captioned-image",
      role: "user",
      content: [
        { type: "text", text: "帮我看看这个问题" },
        {
          type: "image",
          source: { type: "url", value: attachmentUrl("att-cap") },
          metadata: { attachmentId: "att-cap", filename: "bug.png" },
        },
      ],
    } as unknown as Message,
  ];
  const view = renderWithActions(messages, {
    actions: {
      canAct: true,
      regenerate: async () => {},
      edit: async (id, text, removed) => {
        edits.push({
          id,
          text,
          removed: removed ? [...removed] : [],
        });
      },
      withdraw: async () => {},
    },
  });

  fireEvent.click(view.getByTestId("msg-edit"));
  const sendBtn = view.getByTestId("msg-editor-send") as HTMLButtonElement;
  expect(sendBtn.disabled).toBe(true);

  const removeChipBtn = view.getByTestId("msg-editor-remove-attachment");
  fireEvent.click(removeChipBtn);

  // 文字未改但移除了图片附件，发送按钮解锁可用
  expect(sendBtn.disabled).toBe(false);
  fireEvent.click(sendBtn);

  await waitFor(() => {
    expect(edits).toEqual([
      {
        id: "u-captioned-image",
        text: "帮我看看这个问题",
        removed: [1],
      },
    ]);
  });
});
