import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { KEPT_TTL_MS, KeepAliveStage } from "@/components/layout/keep-alive";
import {
  holdDraftChannel,
  isDraftChannel,
  markDraftChannel,
  resetDraftChannelsForTest,
} from "@/lib/channels/draft-channel";
import { resetUiMemory } from "@/lib/chat/ui-memory";
import { settleReactWork } from "./settle-react-work";

/**
 * 草稿对话页藏起来就回收（A1 返修）：留着的聊天平时藏 10 分钟才卸载，草稿对话不等——藏起来那一刻卸载，
 * 卸载走 `holdDraftChannel` 的收尾，随即带条件删除。普通对话照旧留着。
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  resetDraftChannelsForTest();
  resetUiMemory();
});
afterEach(async () => {
  cleanup();
  await settleReactWork();
  resetDraftChannelsForTest();
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

type Addr = { id: string };
const removed: string[] = [];

function Page({ id }: { id: string }) {
  useEffect(
    () => holdDraftChannel(id, async (channelId) => removed.push(channelId)),
    [id],
  );
  return <div data-testid="page">{id}</div>;
}

function stage(address: Addr | null) {
  return (
    <KeepAliveStage
      address={address}
      renderKept={(kept) => <Page id={kept.id} />}
      same={(a, b) => a.id === b.id}
      ttlMs={(kept) => (isDraftChannel(kept.id) ? 0 : KEPT_TTL_MS)}
    >
      {address ? null : <section>设置</section>}
    </KeepAliveStage>
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("草稿对话藏起来：马上卸载并回收，不占着 10 分钟", async () => {
  removed.length = 0;
  markDraftChannel("ch_draft", "new:bot");
  const view = render(stage({ id: "ch_draft" }));
  expect(view.queryByTestId("page")).not.toBeNull();

  view.rerender(stage(null));
  await act(async () => wait(20));
  // 卸载的收尾推迟一拍才判断（StrictMode 那次卸载不算离开），再等一拍。
  await act(async () => wait(20));

  expect(view.queryByTestId("page")).toBeNull();
  expect(removed).toEqual(["ch_draft"]);
  expect(isDraftChannel("ch_draft")).toBe(false);
});

test("普通对话藏起来：照旧留着，不删", async () => {
  removed.length = 0;
  const view = render(stage({ id: "ch_plain" }));
  view.rerender(stage(null));
  await act(async () => wait(20));

  expect(view.queryByTestId("page")).not.toBeNull();
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe(
    "false",
  );
  expect(removed).toEqual([]);
});

test("接线：外壳按「是不是草稿」给留着的聊天定时长", () => {
  const shell = readFileSync(
    join(import.meta.dir, "../src/components/layout/authed-shell.tsx"),
    "utf8",
  );
  expect(shell).toContain("ttlMs={draftKeptTtl}");
  expect(shell).toContain("isDraftChannel(kept.channelId) ? 0 : KEPT_TTL_MS");
});
