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
import { ChatTranscript } from "@/components/channels/chat-transcript";
import { createChannelMutationOptions } from "@/lib/channels/mutations";
import { settleReactWork } from "./settle-react-work";

/**
 * 新话题首字延迟（PR perf/first-text）：发送后立刻有「思考中」，`/run` 前面不再串着等列表刷新、接入回放、
 * 读历史和面板会话。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const seed: Message = { id: "seed-user", role: "user", content: "你好" };

function transcript(client: QueryClient, busy: boolean) {
  return (
    <QueryClientProvider client={client}>
      <ChatTranscript messages={[seed]} busy={busy} scrollKey="first-text" />
    </QueryClientProvider>
  );
}

describe("发送后立刻可见的状态", () => {
  test("第一帧就忙：带着第一句话挂载时「思考中」马上出来", async () => {
    const client = new QueryClient();
    const view = render(transcript(client, true));
    expect(
      view.container.querySelector('[data-testid="transcript-thinking"]'),
    ).not.toBeNull();
  });

  test("第一帧不忙、之后才忙且列表没变：不画（所以新话题必须从第一帧起就算忙）", async () => {
    const client = new QueryClient();
    const view = render(transcript(client, false));
    await act(async () => view.rerender(transcript(client, true)));
    expect(
      view.container.querySelector('[data-testid="transcript-thinking"]'),
    ).toBeNull();
  });
});

describe("新建对话不等频道列表刷新", () => {
  test("onSuccess 不把 invalidate 的 promise 交回去（mutateAsync 不等它）", () => {
    let invalidated = 0;
    const client = {
      invalidateQueries: () => {
        invalidated += 1;
        return new Promise<void>(() => {});
      },
    } as unknown as QueryClient;
    const options = createChannelMutationOptions(client);
    const result = (options.onSuccess as unknown as () => unknown)();
    expect(result).toBeUndefined();
    expect(invalidated).toBe(1);
  });
});

describe("第一条消息前面不再串行等待", () => {
  const source = readFileSync(
    new URL("../src/components/channels/channel-chat.tsx", import.meta.url),
    "utf8",
  );

  test("面板会话和接入等待同时开始，而不是排在它们后面", () => {
    const deliver = source.slice(source.indexOf("const deliver = async ("));
    const started = deliver.indexOf("panelAuthoringForwardedProps(");
    const joinWait = deliver.indexOf("await joinGatePromise");
    expect(started).toBeGreaterThan(0);
    expect(joinWait).toBeGreaterThan(started);
    expect(deliver.indexOf("await panelAuthoringRead")).toBeGreaterThan(
      joinWait,
    );
  });

  test("刚建好的线程（带 seed 挂载）第一次跳过接入回放和读历史", () => {
    const join = source.slice(
      source.indexOf("const freshThread = useRef(seed !== null);"),
    );
    const skip = join.indexOf("if (freshThread.current) {");
    const connect = join.indexOf("copilotkit.connectAgent(");
    expect(skip).toBeGreaterThan(0);
    expect(connect).toBeGreaterThan(skip);
    expect(join.slice(skip, connect)).toContain("openJoinGate.current();");
  });

  test("seed 还在发送时就算忙", () => {
    expect(source).toContain("useState(seed !== null);");
    expect(source).toMatch(/const chatBusy =\s+seedSending \|\|/);
  });
});
