import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { type FunctionComponent, useState } from "react";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { ContextMeter } from "@/components/agents/context-meter";
import { Composer } from "@/components/channels/composer/composer";
import type { CommandOption } from "@/components/channels/composer/draft";
import { ConversationView } from "@/components/channels/conversation-view";
import { PermissionChip } from "@/components/chat/permission-chip";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import { settleReactWork } from "./settle-react-work";

/**
 * 流式时的无效重渲（jank FIX-PLAN §5 / P2-1）：ChannelChat 每个 token 都重渲，以前输入框整排
 * （Composer、ContextMeter、BotModelSelector、PermissionChip）跟着重渲，每个 token 一遍。
 * 这里锁住两件事：这几个组件是 memo 的；props 不变时 100 个 token 只让 Composer 渲染 1 次（挂载）。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
// 这里只数渲染：查询一律给 404，别真去连 localhost。
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const MEMO = Symbol.for("react.memo");

test("the composer row components are memoised", () => {
  for (const component of [
    Composer,
    ContextMeter,
    BotModelSelector,
    PermissionChip,
    ActivityJumpButton,
  ]) {
    expect((component as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO);
  }
});

/** 把 memo 包着的函数换成会计数的同款，跑完 `body` 一定换回去（断言失败也不会污染后面的文件）。 */
async function countRenders(body: (renders: () => number) => Promise<void>) {
  const memoised = Composer as unknown as { type: FunctionComponent<unknown> };
  const inner = memoised.type;
  let renders = 0;
  memoised.type = (props) => {
    renders++;
    return inner(props);
  };
  try {
    await body(() => renders);
  } finally {
    memoised.type = inner;
  }
}

test("100 streamed tokens do not re-render a composer whose props did not change", async () => {
  await countRenders(async (renders) => {
    let push: () => void = () => {};
    const onSubmit = () => {};
    function Stream() {
      const [tokens, setTokens] = useState(0);
      push = () => setTokens((n) => n + 1);
      return (
        <div>
          <p data-testid="tokens">{tokens}</p>
          <Composer compact onSubmit={onSubmit} />
        </div>
      );
    }
    const view = render(<Stream />);
    await act(async () => {
      await settleReactWork();
    });
    const afterMount = renders();
    for (let i = 0; i < 100; i++) {
      act(() => push());
    }
    expect(view.getByTestId("tokens").textContent).toBe("100");
    expect(afterMount).toBeGreaterThan(0);
    expect(renders() - afterMount).toBeLessThanOrEqual(2);
  });
});

const COMMANDS: readonly CommandOption[] = [
  {
    id: "skill",
    name: "skill",
    description: "a skill",
    kind: "prompt",
    prompt: "do it",
  },
];

/*
 * 走真实路径：路由每个 token 都给 ConversationView 新的消息数组和新的 onSubmit / onStop 闭包。
 * ConversationView 自己往 Composer 传的东西（回调、默认数组、附件、命令）有任何一个变成每次新建，
 * 这里就会数到上百次。
 */
test("100 streamed tokens through ConversationView leave its composer alone", async () => {
  await countRenders(async (renders) => {
    let push: () => void = () => {};
    function Route() {
      const [tokens, setTokens] = useState(0);
      push = () => setTokens((n) => n + 1);
      const messages = [
        { id: "u1", role: "user", content: "hi" },
        { id: "a1", role: "assistant", content: "x".repeat(tokens) },
      ] as Message[];
      return (
        <ConversationView
          busy
          channelId="channel-1"
          commands={COMMANDS}
          messages={messages}
          onStop={() => {}}
          onSubmit={() => {}}
          pending
          queueWhileBusy
        />
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Route />
      </QueryClientProvider>,
    );
    await act(async () => {
      await settleReactWork();
    });
    const afterMount = renders();
    for (let i = 0; i < 100; i++) {
      act(() => push());
    }
    await act(async () => {
      await settleReactWork();
    });
    expect(afterMount).toBeGreaterThan(0);
    expect(renders() - afterMount).toBeLessThanOrEqual(2);
  });
});
