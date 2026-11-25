import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GroupChatView } from "@/components/channels/group-chat-view";
import {
  applyMentionCompletion,
  detectGoalDeliverableIds,
  detectTrailingMention,
  formatGroupTranscriptMarkdown,
  type GroupBotMember,
  type GroupTranscriptMessage,
  maskNonProseMentions,
  splitGroupMentionSegments,
} from "@/lib/channels/group-api";
import { KeptVisibleContext } from "@/lib/kept-visible";
import { settleReactWork } from "./settle-react-work";

const BOTS: GroupBotMember[] = [
  { id: "ada", name: "Ada" },
  { id: "ops", name: "Ops" },
  { id: "lead", name: "Ops Lead" },
  { id: "cafe", name: "Cafe\u0301" },
];

function makeMsg(
  overrides: Partial<GroupTranscriptMessage> & {
    id: string;
    text: string;
  },
): GroupTranscriptMessage {
  return {
    channelId: "ch-group-1",
    ownerUserId: "u-1",
    agentId: null,
    threadId: null,
    status: "completed",
    createdAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("group-api pure helpers", () => {
  test("maskNonProseMentions 与服务端保持一致：等长空格遮蔽代码块、行内反引号、引用、链接目标、URL 与路径", () => {
    const sample = [
      "prose @Ops",
      "> quote @Ada",
      "inline `@Ops` and ``@Ada``",
      "[label](https://example.com/@Ada(1))",
      "visit https://x.com/@Ops/status",
      "pkg @ops/core and /var/@Ada/log and C:\\work\\@Ops\\a.txt",
      "```ts",
      "const x = '@Ada';",
      "```",
      "~~~md",
      "```",
      "@Ops",
      "~~~",
      "tail @Ops Lead",
    ].join("\n");

    const masked = maskNonProseMentions(sample);
    expect(masked.length).toBe(sample.length);
    expect(masked).toContain("prose @Ops");
    expect(masked).toContain("tail @Ops Lead");
    expect(masked).not.toContain("@Ada");
    expect(masked).not.toContain("`@Ops`");
    expect(masked).not.toContain("@ops/core");
    expect(masked).not.toContain("https://");

    const unclosed = "before @Ops\n```js\n@Ada\n@Ops";
    const maskedUnclosed = maskNonProseMentions(unclosed);
    expect(maskedUnclosed.length).toBe(unclosed.length);
    expect(maskedUnclosed.startsWith("before @Ops\n")).toBe(true);
    expect(maskedUnclosed).not.toContain("@Ada");
    expect(maskedUnclosed).not.toContain("js\n@Ops");
  });

  test("splitGroupMentionSegments 支持 NFC、全角 ＠、长名优先遮蔽短名且过滤非正文与邮箱", () => {
    const text = [
      "请 ＠Ops Lead 先看，再转 @Ops 与 @Caf\u00e9，",
      "> @Ops",
      "忽略 jo@ops.com、@Opsgenie、`@Ada`",
      "以及 https://example.com/@Ada。",
    ].join("\n");

    const segments = splitGroupMentionSegments(text, BOTS);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      text.normalize("NFC"),
    );

    const mentions = segments
      .filter((segment) => segment.kind === "mention")
      .map((segment) => ({ id: segment.bot.id, text: segment.text }));
    expect(mentions).toEqual([
      { id: "lead", text: "＠Ops Lead" },
      { id: "ops", text: "@Ops" },
      { id: "cafe", text: "@Café" },
    ]);

    const keys = segments.map((segment) => segment.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("detectTrailingMention 与 applyMentionCompletion 正确处理触发词、排除邮箱路径并返回新光标", () => {
    expect(detectTrailingMention("hello @op", 9)).toEqual({
      start: 6,
      end: 9,
      query: "op",
      trigger: "@",
    });
    expect(detectTrailingMention("（＠ad", 4)).toEqual({
      start: 1,
      end: 4,
      query: "ad",
      trigger: "＠",
    });

    // 排除邮箱、路径、URL 与链接目标
    expect(detectTrailingMention("jo@sam", 6)).toBeNull();
    expect(detectTrailingMention("user.name@ops", 13)).toBeNull();
    expect(detectTrailingMention("/var/@ops", 9)).toBeNull();
    expect(detectTrailingMention("C:\\work\\@ops", 12)).toBeNull();
    expect(detectTrailingMention("@ops/core", 9)).toBeNull();
    expect(detectTrailingMention("https://x.com/@ops", 18)).toBeNull();
    expect(detectTrailingMention("[doc](@ops", 10)).toBeNull();
    expect(detectTrailingMention("@Ops ", 5)).toBeNull();

    expect(applyMentionCompletion("hi @op", 6, "Ops Lead")).toEqual({
      text: "hi @Ops Lead ",
      cursor: 13,
    });
    expect(applyMentionCompletion("@op world", 3, "Ops")).toEqual({
      text: "@Ops world",
      cursor: 5,
    });
  });

  test("detectGoalDeliverableIds 仅在 /goal 轮次完全收敛后标记最后一条有效 completed 回复", () => {
    const activeRound = [
      makeMsg({ id: "u1", agentId: null, text: "/goal 输出最终方案" }),
      makeMsg({
        id: "u1:ada",
        agentId: "ada",
        text: "先查一下 @Ops",
        status: "completed",
      }),
      makeMsg({
        id: "u1:ops",
        agentId: "ops",
        text: "",
        status: "running",
      }),
    ];
    expect([...detectGoalDeliverableIds(activeRound)]).toEqual([]);

    const waitingRound = [
      makeMsg({ id: "u1", agentId: null, text: "/goal: 审批后给出结论" }),
      makeMsg({
        id: "u1:ada",
        agentId: "ada",
        text: "阶段建议",
        status: "completed",
      }),
      makeMsg({
        id: "u1:ops",
        agentId: "ops",
        text: "",
        status: "waiting",
        reason: "等待授权",
      }),
    ];
    expect([...detectGoalDeliverableIds(waitingRound)]).toEqual([]);

    const mixedRounds = [
      makeMsg({ id: "u1", agentId: null, text: "/goal： 第一轮目标" }),
      makeMsg({
        id: "u1:ada",
        agentId: "ada",
        text: "初步分析 @Ops",
        status: "completed",
      }),
      makeMsg({
        id: "u1:ops",
        agentId: "ops",
        text: "第一轮定稿结论",
        status: "completed",
      }),
      makeMsg({ id: "u2", agentId: null, text: "普通闲聊，不是目标" }),
      makeMsg({
        id: "u2:ada",
        agentId: "ada",
        text: "普通回复",
        status: "completed",
      }),
      makeMsg({ id: "u3", agentId: null, text: "/goalcheck 误触发前缀" }),
      makeMsg({
        id: "u3:ada",
        agentId: "ada",
        text: "普通回复2",
        status: "completed",
      }),
      makeMsg({ id: "u4", agentId: null, text: "/goal 第二轮目标" }),
      makeMsg({
        id: "u4:ada",
        agentId: "ada",
        text: "第二轮结论",
        status: "completed",
      }),
      makeMsg({
        id: "u4:ops",
        agentId: "ops",
        text: "超时失败",
        status: "failed",
      }),
    ];
    expect([...detectGoalDeliverableIds(mixedRounds)]).toEqual([
      "u1:ops",
      "u4:ada",
    ]);
  });

  test("formatGroupTranscriptMarkdown 输出标题、成员名与 [目标结论] 标记", () => {
    const botMap = new Map([
      ["ada", "Ada"],
      ["ops", "Ops"],
    ]);
    const messages = [
      makeMsg({
        id: "u1",
        agentId: null,
        text: "/goal 确认发版时间",
        createdAt: "2026-11-25T01:00:00.000Z",
      }),
      makeMsg({
        id: "u1:ops",
        agentId: "ops",
        answeredBy: "ada",
        text: "建议周四 14:00 发布。",
        createdAt: "2026-11-25T01:01:00.000Z",
      }),
    ];

    const md = formatGroupTranscriptMarkdown("发版评审群", messages, botMap);
    expect(md).toContain("# 发版评审群");
    expect(md).toContain("## 你 · 2026-11-25T01:00:00.000Z");
    expect(md).toContain(
      "## Ops（代答 · Ada） · 2026-11-25T01:01:00.000Z · [目标结论]",
    );
    expect(md).toContain("建议周四 14:00 发布。");
  });
});

describe("GroupChatView 交互与对账兜底", () => {
  const originalFetch = globalThis.fetch;
  const originalClipboard = navigator.clipboard;

  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost/" });
  });

  afterAll(async () => {
    await settleReactWork();
    GlobalRegistrator.unregister();
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    await settleReactWork();
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  function createQueryClient() {
    return new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0 },
        mutations: { retry: false },
      },
    });
  }

  function renderView(queryClient: QueryClient) {
    return render(
      <QueryClientProvider client={queryClient}>
        <KeptVisibleContext.Provider value={true}>
          <GroupChatView
            channel={{
              id: "ch-group-1",
              name: "发版讨论群",
              agentIds: ["ada", "ops", "lead"],
              active: true,
            }}
          />
        </KeptVisibleContext.Provider>
      </QueryClientProvider>,
    );
  }

  test("渲染消息内 @mention 彩色胶囊、/goal 结论定稿卡、复制结论与导出 Markdown", async () => {
    const copiedTexts: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          copiedTexts.push(value);
        },
      },
    });

    const detail = {
      bots: [
        { id: "ada", name: "Ada" },
        { id: "ops", name: "Ops" },
        { id: "lead", name: "Ops Lead" },
      ],
      people: [
        { userId: "u-1", email: "me@example.com", name: "我", creator: true },
      ],
      messages: [
        makeMsg({
          id: "u1",
          agentId: null,
          text: "/goal 请 @Ops Lead 统筹结论，忽略 `@Ops` 和 jo@ops.com",
        }),
        makeMsg({
          id: "u1:lead",
          agentId: "lead",
          text: "已和 @Ops 对齐，最终结论：今晚 20:00 合并发布。",
        }),
      ],
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/groups/ch-group-1")) {
        return Response.json(detail);
      }
      if (url.includes("/api/agents")) {
        return Response.json({ agents: [] });
      }
      if (url.includes("/avatars")) {
        return Response.json({ avatars: {} });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const view = renderView(createQueryClient());
    await waitFor(() =>
      expect(view.getByText(/今晚 20:00 合并发布/)).toBeTruthy(),
    );

    // 只有正文有效 @mention 渲染成高亮胶囊，code/email 不高亮
    const mentionPills = view.container.querySelectorAll("[data-mention-bot]");
    expect(
      Array.from(mentionPills).map((el) => ({
        bot: el.getAttribute("data-mention-bot"),
        text: el.textContent,
      })),
    ).toEqual([
      { bot: "lead", text: "@Ops Lead" },
      { bot: "ops", text: "@Ops" },
    ]);

    // /goal 收敛定稿卡徽章与边框属性
    const deliverableBadge = view.container.querySelector(
      '[data-goal-deliverable="true"]',
    );
    expect(deliverableBadge?.textContent).toContain("目标结论");
    expect(
      view.container.querySelector('[data-goal-deliverable-card="true"]'),
    ).not.toBeNull();

    // 点击复制结论
    const copyConclusionBtn = view.getByRole("button", { name: "复制结论" });
    await act(async () => {
      fireEvent.click(copyConclusionBtn);
    });
    await waitFor(() => expect(copiedTexts).toHaveLength(1));
    expect(copiedTexts[0]).toBe(
      "已和 @Ops 对齐，最终结论：今晚 20:00 合并发布。",
    );

    // 点击导出 Markdown
    const exportBtn = view.getByRole("button", { name: "导出 Markdown" });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    await waitFor(() => expect(copiedTexts).toHaveLength(2));
    expect(copiedTexts[1]).toContain("# 发版讨论群");
    expect(copiedTexts[1]).toContain("[目标结论]");
  });

  test("输入 @ 弹出键盘补全浮层，支持 ArrowDown / Enter / Tab / Escape 且不拦截 IME 合成", async () => {
    const sentPayloads: Array<{ id: string; text: string }> = [];
    const detail = {
      bots: [
        { id: "ada", name: "Ada" },
        { id: "ops", name: "Ops" },
        { id: "lead", name: "Ops Lead" },
      ],
      people: [
        { userId: "u-1", email: "me@example.com", name: "我", creator: true },
      ],
      messages: [],
    };

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/groups/ch-group-1") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          id: string;
          text: string;
        };
        sentPayloads.push(body);
        return Response.json({ id: body.id, queued: true }, { status: 202 });
      }
      if (url.includes("/api/groups/ch-group-1")) {
        return Response.json(detail);
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const view = renderView(createQueryClient());
    const textarea = (await view.findByLabelText(
      "群聊消息输入框",
    )) as HTMLTextAreaElement;

    // 1. 输入 "请 @op" 触发补全浮层（data-surface="control"）
    act(() => {
      textarea.focus();
      fireEvent.change(textarea, {
        target: { value: "请 @op" },
      });
      textarea.setSelectionRange(5, 5);
      fireEvent.select(textarea);
    });

    const popover = view.container.querySelector(
      '[data-mention-popover="true"]',
    );
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute("data-surface")).toBe("control");

    const options = view.container.querySelectorAll("[data-mention-option]");
    expect(
      Array.from(options).map((el) => el.getAttribute("data-mention-option")),
    ).toEqual(["ops", "lead"]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    // 2. IME 合成中按键严禁被补全或提交拦截
    act(() => {
      fireEvent.compositionStart(textarea);
      fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    });
    expect(sentPayloads).toHaveLength(0);
    expect(textarea.value).toBe("请 @op");
    act(() => {
      fireEvent.compositionEnd(textarea, {
        target: { value: "请 @op", selectionStart: 6 },
      });
    });

    // 3. ArrowDown 切换到 Ops Lead，然后 Enter 确认补全而不提交表单
    act(() => {
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
    });
    const updatedOptions = view.container.querySelectorAll(
      "[data-mention-option]",
    );
    expect(updatedOptions[1]?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    expect(textarea.value).toBe("请 @Ops Lead ");
    expect(sentPayloads).toHaveLength(0);
    expect(
      view.container.querySelector('[data-mention-popover="true"]'),
    ).toBeNull();

    // 4. 再输入 @a，Escape 关闭浮层；继续输入后空格+新 @ 支持 Tab 补全
    act(() => {
      fireEvent.change(textarea, {
        target: { value: "请 @Ops Lead @a" },
      });
      textarea.setSelectionRange(14, 14);
      fireEvent.select(textarea);
    });
    expect(
      view.container.querySelector('[data-mention-popover="true"]'),
    ).not.toBeNull();

    act(() => {
      fireEvent.keyDown(textarea, { key: "Escape" });
    });
    expect(
      view.container.querySelector('[data-mention-popover="true"]'),
    ).toBeNull();

    // 输入新 @ 触发并按 Tab 补全
    act(() => {
      fireEvent.change(textarea, {
        target: { value: "请 @Ops Lead @a @ad" },
      });
      textarea.setSelectionRange(18, 18);
      fireEvent.select(textarea);
    });
    act(() => {
      fireEvent.keyDown(textarea, { key: "Tab" });
    });
    expect(textarea.value).toBe("请 @Ops Lead @a @Ada ");
    expect(sentPayloads).toHaveLength(0);
  });

  test("断线对账：响应断开但服务端已入库时清空草稿并温和提示；未入库时保留同一 ID 安全重试", async () => {
    const serverMessages: GroupTranscriptMessage[] = [];
    const sentIds: string[] = [];
    let postBehavior: "drop-after-save" | "fail-before-save" | "succeed" =
      "drop-after-save";

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/groups/ch-group-1") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          id: string;
          text: string;
        };
        sentIds.push(body.id);
        if (postBehavior === "drop-after-save") {
          // 模拟服务端已入库，但响应在半路断开
          serverMessages.push(
            makeMsg({ id: body.id, agentId: null, text: body.text }),
          );
          return Response.json({ error: "gateway timeout" }, { status: 504 });
        }
        if (postBehavior === "fail-before-save") {
          return Response.json({ error: "网络连接中断" }, { status: 503 });
        }
        serverMessages.push(
          makeMsg({ id: body.id, agentId: null, text: body.text }),
        );
        return Response.json({ id: body.id, queued: true }, { status: 202 });
      }
      if (url.includes("/api/groups/ch-group-1")) {
        return Response.json({
          bots: [
            { id: "ada", name: "Ada" },
            { id: "ops", name: "Ops" },
          ],
          people: [
            {
              userId: "u-1",
              email: "me@example.com",
              name: "我",
              creator: true,
            },
          ],
          messages: [...serverMessages],
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    const user = userEvent.setup({ document: window.document });
    const view = renderView(createQueryClient());
    await view.findByText(/2 Bot · 1 成员/);
    const textarea = (await view.findByLabelText(
      "群聊消息输入框",
    )) as HTMLTextAreaElement;
    const form = view.container.querySelector("form") as HTMLFormElement;

    // 场景 A：发送报错但对账拉取发现该 ID 已入库
    await act(async () => {
      await user.type(textarea, "第一条会断线但已落库的消息");
    });
    expect(textarea.value).toBe("第一条会断线但已落库的消息");
    expect(
      (view.getByRole("button", { name: "发送" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => expect(sentIds).toHaveLength(1));
    await waitFor(() =>
      expect(
        view.getByText("刚才的发送已确认入库，无需重复发送。"),
      ).toBeTruthy(),
    );
    expect(textarea.value).toBe("");

    // 场景 B：发送报错且对账拉取仍无该 ID -> 保留草稿与同一 ID，提供安全重试
    postBehavior = "fail-before-save";
    await act(async () => {
      await user.type(textarea, "第二条未送达消息");
    });
    await act(async () => {
      fireEvent.submit(form);
    });

    const retryBtn = await view.findByRole("button", {
      name: "可能未送达 · 点此安全重试",
    });
    expect(textarea.value).toBe("第二条未送达消息");
    expect(sentIds).toHaveLength(2);
    const failedMessageId = sentIds[1];
    expect(failedMessageId).not.toBe(sentIds[0]);

    // 点击安全重试并恢复网络 -> 必须沿用完全相同的 id
    postBehavior = "succeed";
    act(() => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => expect(textarea.value).toBe(""));
    expect(sentIds).toHaveLength(3);
    expect(sentIds[2]).toBe(failedMessageId);
  });
});
