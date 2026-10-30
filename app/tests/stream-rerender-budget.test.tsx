import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { type FunctionComponent, useState } from "react";
import { BotModelSelector } from "@/components/agents/bot-model-selector";
import { ContextMeter } from "@/components/agents/context-meter";
import { Composer } from "@/components/channels/composer/composer";
import { PermissionChip } from "@/components/chat/permission-chip";
import { ActivityJumpButton } from "@/components/computer/activity-jump-button";
import { settleReactWork } from "./settle-react-work";

/**
 * 流式时的无效重渲（jank FIX-PLAN §5 / P2-1）：ChannelChat 每个 token 都重渲，以前输入框整排
 * （Composer、ContextMeter、BotModelSelector、PermissionChip）跟着重渲，每个 token 一遍。
 * 这里锁住两件事：这几个组件是 memo 的；props 不变时 100 个 token 只让 Composer 渲染 1 次（挂载）。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
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

test("100 streamed tokens do not re-render a composer whose props did not change", async () => {
  // 数 Composer 本体真的执行了几次：memo 包着的那个函数换成会计数的同款。
  const memoised = Composer as unknown as { type: FunctionComponent<unknown> };
  const inner = memoised.type;
  let renders = 0;
  memoised.type = (props) => {
    renders++;
    return inner(props);
  };
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
  const afterMount = renders;
  for (let i = 0; i < 100; i++) {
    act(() => push());
  }
  expect(view.getByTestId("tokens").textContent).toBe("100");
  memoised.type = inner;
  expect(afterMount).toBeGreaterThan(0);
  expect(renders - afterMount).toBeLessThanOrEqual(2);
});
