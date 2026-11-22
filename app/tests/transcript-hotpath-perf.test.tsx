import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { memo, Profiler } from "react";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import {
  createIncrementalMarkdownPreprocess,
  preprocessMarkdownText,
} from "@/components/chat/smooth-markdown";
import { previewClient } from "@/components/rich-previews/link-preview-query";
import {
  MessageRichPreviews,
  useSettledText,
} from "@/components/rich-previews/rich-previews";
import { ConversationScopeProvider } from "@/lib/chat/conversation-scope";
import { useSmoothText } from "@/lib/chat/use-smooth-text";
import {
  createKeptVisibility,
  KeptVisibilityContext,
  KeptVisibleContext,
} from "@/lib/kept-visible";
import { settleReactWork } from "./settle-react-work";

const realFetch = globalThis.fetch;

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost/" });
  }
});

afterEach(async () => {
  cleanup();
  previewClient.clear();
  globalThis.fetch = realFetch;
  await settleReactWork();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("流式与历史消息热路径零开销回归", () => {
  test("useSmoothText 历史/非流式消息不注册 document visibilitychange 监听，仅积压流式期挂载并在追平后解绑", async () => {
    let visibilityAdds = 0;
    let visibilityRemoves = 0;
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "visibilitychange") visibilityAdds += 1;
      return origAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === "visibilitychange") visibilityRemoves += 1;
      return origRemove(type, listener, options);
    }) as typeof document.removeEventListener;

    function Probe({ text, enabled }: { text: string; enabled: boolean }) {
      return <p data-testid="smooth-out">{useSmoothText(text, enabled)}</p>;
    }

    try {
      // 1. 挂载 30 条历史消息（enabled=false）：零 visibilitychange 监听
      const historyView = render(
        <div>
          {Array.from({ length: 30 }, (_, i) => (
            <Probe
              enabled={false}
              key={String(i)}
              text={`历史消息内容 ${i}`}
            />
          ))}
        </div>,
      );
      await settleReactWork();
      expect(visibilityAdds).toBe(0);
      historyView.unmount();

      // 2. 启用流式并涌入积压文本：挂 1 个监听，追平后自动解绑
      const streamView = render(<Probe enabled text="" />);
      await settleReactWork();
      expect(visibilityAdds).toBe(0);

      const full = "流式输出的一段长回复内容，用于验证追赶与自动解绑。".repeat(
        4,
      );
      await act(async () => {
        streamView.rerender(<Probe enabled text={full} />);
      });
      expect(visibilityAdds).toBe(1);
      expect(visibilityRemoves).toBe(0);

      await act(async () => {
        await new Promise((r) => setTimeout(r, 750));
      });
      expect(streamView.getByTestId("smooth-out").textContent).toBe(full);
      expect(visibilityRemoves).toBe(1);
      streamView.unmount();
    } finally {
      document.addEventListener = origAdd;
      document.removeEventListener = origRemove;
    }
  });

  test("MessageRichPreviews 无链接/无图片历史消息直接短路，不挂载 QueriesObserver", async () => {
    const beforeSubs = previewClient
      .getQueryCache()
      .getAll()
      .reduce((sum, q) => sum + q.getObserversCount(), 0);

    const view = render(
      <div>
        {Array.from({ length: 40 }, (_, i) => (
          <MessageRichPreviews
            align={i % 2 === 0 ? "start" : "end"}
            key={String(i)}
            text={`普通历史对话第 ${i} 条，没有任何网址或图片。`}
          />
        ))}
      </div>,
    );
    await settleReactWork();

    expect(view.container.querySelector(".rp-stack")).toBeNull();
    const afterSubs = previewClient
      .getQueryCache()
      .getAll()
      .reduce((sum, q) => sum + q.getObserversCount(), 0);
    expect(afterSubs).toBe(beforeSubs);
  });

  test("MessageRichPreviews 从纯文本流式长出半截网址时保持未落定骨架，不抢先发请求", async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify({ error: "x" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const view = render(<MessageRichPreviews text="先看这段说明：" />);
    expect(view.container.querySelector(".rp-stack")).toBeNull();

    // 流式半途长出半截 GitHub 网址：应展示骨架而非立即请求半截网址
    await act(async () => {
      view.rerender(
        <MessageRichPreviews
          text={"先看这段说明：\nhttps://github.com/ChisaAlter"}
        />,
      );
    });
    expect(view.queryByTestId("link-card-skeleton")).not.toBeNull();
    expect(fetched).toEqual([]);
  });

  test("useSettledText 流式高频更新复用单一定时器，非流式直接返回零定时器", async () => {
    let timersCreated = 0;
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay !== undefined && delay >= 50) timersCreated += 1;
      return origSetTimeout(fn, delay, ...args);
    }) as typeof globalThis.setTimeout;

    function SettledProbe({
      text,
      streaming,
    }: {
      text: string;
      streaming?: boolean;
    }) {
      return (
        <span data-testid="settled">{useSettledText(text, 120, streaming)}</span>
      );
    }

    try {
      // 历史模式（streaming=false）内容变化也不建定时器
      const hist = render(<SettledProbe streaming={false} text="a" />);
      hist.rerender(<SettledProbe streaming={false} text="ab" />);
      expect(hist.getByTestId("settled").textContent).toBe("ab");
      expect(timersCreated).toBe(0);
      hist.unmount();

      // 流式模式连续 20 帧更新只创建 1 个防抖定时器（而非每帧拆装 20 次）
      const live = render(<SettledProbe streaming text="" />);
      for (let i = 1; i <= 20; i += 1) {
        live.rerender(<SettledProbe streaming text={"字".repeat(i)} />);
      }
      expect(timersCreated).toBe(1);
      await act(async () => {
        await new Promise((r) => origSetTimeout(r, 180));
      });
      expect(live.getByTestId("settled").textContent).toBe("字".repeat(20));
      live.unmount();
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  test("createIncrementalMarkdownPreprocess 流式逐块增长与整段 preprocessMarkdownText 严格等价", () => {
    const sample = [
      "**标题：**先看 `Vec<String>` 和正文里的 Vec<Option<T>> 泛型，别被当 HTML 吃掉。",
      "",
      "第二段有**“引用加粗”**和工作区文件 [primes.py](primes.py)，以及裸链接 https://workspace.local/report.csv。",
      "",
      "```ts",
      "const x: Vec<String> = '**不该改：**';",
      "const u = 'https://workspace.local/in-code.txt';",
      "```",
      "",
      "- 列表一里的 Result<u32> 与 **重点：**继续说明",
      "- 列表二里的 [notes.md](/workspace/notes.md)",
      "",
      "普通段落紧跟列表之后，这里重复填充一点长度确保触发多次安全封口：".concat(
        "补充说明文字内容，".repeat(30),
      ),
      "",
      "再加一段带 `H<sub>2</sub>O` 和 `List<Object>` 的收尾：**结论。**完成了！",
    ].join("\n");

    const inc = createIncrementalMarkdownPreprocess();
    const bot = "bot-1";
    const origin = "https://chisa.example";

    // 按步长模拟流式增长，每一步都与全量重跑结果逐字符一致
    for (let end = 1; end <= sample.length; end += 7) {
      const slice = sample.slice(0, end);
      expect(inc(slice, bot, origin, true)).toBe(
        preprocessMarkdownText(slice, bot, origin),
      );
    }
    expect(inc(sample, bot, origin, true)).toBe(
      preprocessMarkdownText(sample, bot, origin),
    );
    expect(inc(sample, bot, origin, false)).toBe(
      preprocessMarkdownText(sample, bot, origin),
    );
  });

  test("ChatTranscript 切换 KeepAlive 可见性自身零重渲、不重拉确认接口，且隐藏态停掉 10s 审批轮询", async () => {
    const src = readFileSync(
      new URL("../src/components/channels/chat-transcript.tsx", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("useKeptVisible(");

    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(
        JSON.stringify({ requests: [], rules: [], teamRules: [], questions: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const activeApprovalIntervals = new Set<unknown>();
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = origSetInterval(fn, delay, ...args);
      if (delay === 10_000) activeApprovalIntervals.add(id);
      return id;
    }) as typeof globalThis.setInterval;
    globalThis.clearInterval = ((id?: unknown) => {
      if (id !== undefined) activeApprovalIntervals.delete(id);
      return origClearInterval(id as Parameters<typeof origClearInterval>[0]);
    }) as typeof globalThis.clearInterval;

    const messages: Message[] = [
      { id: "u1", role: "user", content: "跑个工具" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "search_web", arguments: '{"q":"test"}' },
          },
        ],
      },
    ];
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 30_000 },
      },
    });
    const visibility = createKeptVisibility(true);
    let transcriptCommits = 0;

    // 把 Profiler 放在 memo 边界内：Host 仅切换 KeptVisibleContext 时，只有当 ChatTranscript
    // 或其子树消费了 KeptVisibleContext 触发真实提交，onRender 才会被调用。
    const IsolatedTranscript = memo(function IsolatedTranscript() {
      return (
        <Profiler
          id="chat-transcript"
          onRender={() => {
            transcriptCommits += 1;
          }}
        >
          <ChatTranscript
            messages={messages}
            scrollKey="keepalive-zero-rerender"
          />
        </Profiler>
      );
    });

    function Host({ visible }: { visible: boolean }) {
      return (
        <QueryClientProvider client={client}>
          <KeptVisibleContext.Provider value={visible}>
            <KeptVisibilityContext.Provider value={visibility}>
              <ConversationScopeProvider
                agentId="bot-1"
                botId="bot-1"
                threadId="thread-visible-switch"
              >
                <IsolatedTranscript />
              </ConversationScopeProvider>
            </KeptVisibilityContext.Provider>
          </KeptVisibleContext.Provider>
        </QueryClientProvider>
      );
    }

    try {
      const view = render(<Host visible />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
      // 首次可见挂载：已启动 1 个 10s 审批可见性轮询器
      expect(activeApprovalIntervals.size).toBe(1);

      const commitsBeforeSwitch = transcriptCommits;
      const requestsBeforeSwitch = requested.length;

      // 切换到其它频道（隐藏）：ChatTranscript 自身零重渲，停掉 10s 轮询，零新请求
      await act(async () => {
        visibility.set(false);
        view.rerender(<Host visible={false} />);
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(transcriptCommits).toBe(commitsBeforeSwitch);
      expect(activeApprovalIntervals.size).toBe(0);
      expect(requested.length).toBe(requestsBeforeSwitch);

      // 切回当前频道（可见）：ChatTranscript 仍零重渲，不重拉 /api/confirmations/requests，仅恢复 10s 轮询器
      await act(async () => {
        visibility.set(true);
        view.rerender(<Host visible />);
        await new Promise((r) => setTimeout(r, 40));
      });
      expect(transcriptCommits).toBe(commitsBeforeSwitch);
      expect(activeApprovalIntervals.size).toBe(1);
      expect(requested.length).toBe(requestsBeforeSwitch);

      view.unmount();
      expect(activeApprovalIntervals.size).toBe(0);
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
      client.clear();
    }
  });
});
