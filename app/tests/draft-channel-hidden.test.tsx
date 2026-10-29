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
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { KEPT_TTL_MS, KeepAliveStage } from "@/components/layout/keep-alive";
import {
  draftKeptTtl,
  holdDraftChannel,
  isDraftChannel,
  markDraftChannel,
  releasedDraftAgent,
  resetDraftChannelsForTest,
} from "@/lib/channels/draft-channel";
import { resetUiMemory } from "@/lib/chat/ui-memory";
import { settleReactWork } from "./settle-react-work";

/**
 * 草稿对话页什么时候回收（A1 返修 + 二轮复审）：留着的聊天平时藏 10 分钟才卸载。草稿对话只有去新话题页
 * （`/channel/new`）时藏起来那一刻卸载，卸载走 `holdDraftChannel` 的收尾，随即带条件删除；去设置等别的页面
 * 照常留着，回来图还在。普通对话照旧留着。
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

/** 对话页：「加一张图」之后输入框上有一张图（组件自己的 state，卸载就没了）。 */
function Page({ id }: { id: string }) {
  const [picked, setPicked] = useState(false);
  useEffect(
    () => holdDraftChannel(id, async (channelId) => removed.push(channelId)),
    [id],
  );
  return (
    <div data-testid="page">
      {id}
      <button onClick={() => setPicked(true)} type="button">
        加一张图
      </button>
      {picked ? <img alt="shot.png" src="blob:shot" /> : null}
    </div>
  );
}

/** 和外壳一样：按当前地址给留着的聊天定时长。 */
function stage(address: Addr | null, pathname = "/settings") {
  return (
    <KeepAliveStage
      address={address}
      renderKept={(kept) => <Page id={kept.id} />}
      same={(a, b) => a.id === b.id}
      ttlMs={(kept) => draftKeptTtl(kept.id, pathname, KEPT_TTL_MS)}
    >
      {address ? null : <section>{pathname}</section>}
    </KeepAliveStage>
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("草稿对话去新话题页：马上卸载并回收，不占着 10 分钟", async () => {
  removed.length = 0;
  markDraftChannel("ch_draft", "new:bot");
  const view = render(stage({ id: "ch_draft" }));
  expect(view.queryByTestId("page")).not.toBeNull();

  view.rerender(stage(null, "/channel/new"));
  await act(async () => wait(20));
  // 卸载的收尾推迟一拍才判断（StrictMode 那次卸载不算离开），再等一拍。
  await act(async () => wait(20));

  expect(view.queryByTestId("page")).toBeNull();
  expect(removed).toEqual(["ch_draft"]);
  expect(isDraftChannel("ch_draft")).toBe(false);
  // 记下它属于哪个机器人：本标签页再打开它拿到 404 时跳回这个机器人的新话题页。
  expect(releasedDraftAgent("ch_draft")).toBe("bot");
});

test("草稿页去设置再回来：图还在，没有回收", async () => {
  removed.length = 0;
  markDraftChannel("ch_draft", "new:bot");
  const view = render(stage({ id: "ch_draft" }));
  await act(async () => {
    fireEvent.click(view.getByText("加一张图"));
  });
  expect(view.queryByAltText("shot.png")).not.toBeNull();

  view.rerender(stage(null, "/settings"));
  await act(async () => wait(20));
  await act(async () => wait(20));
  // 藏着，但没卸载、没删。
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe(
    "false",
  );
  expect(removed).toEqual([]);
  expect(isDraftChannel("ch_draft")).toBe(true);

  view.rerender(stage({ id: "ch_draft" }));
  await act(async () => wait(20));
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe(
    "true",
  );
  expect(view.queryByAltText("shot.png")).not.toBeNull();
  expect(removed).toEqual([]);
  expect(isDraftChannel("ch_draft")).toBe(true);
});

test("草稿页先去设置、再从设置去新话题页：那时才回收", async () => {
  removed.length = 0;
  markDraftChannel("ch_draft", "new:bot");
  const view = render(stage({ id: "ch_draft" }));
  view.rerender(stage(null, "/settings"));
  await act(async () => wait(20));
  expect(removed).toEqual([]);

  view.rerender(stage(null, "/channel/new"));
  await act(async () => wait(20));
  await act(async () => wait(20));
  expect(view.queryByTestId("page")).toBeNull();
  expect(removed).toEqual(["ch_draft"]);
});

test("定时长：只有草稿对话去新话题页是 0，其他都是 10 分钟", () => {
  markDraftChannel("ch_draft", "new:bot");
  expect(draftKeptTtl("ch_draft", "/settings", KEPT_TTL_MS)).toBe(KEPT_TTL_MS);
  expect(draftKeptTtl("ch_draft", "/channel/new", KEPT_TTL_MS)).toBe(0);
  expect(draftKeptTtl("ch_plain", "/channel/new", KEPT_TTL_MS)).toBe(
    KEPT_TTL_MS,
  );
});

test("普通对话藏起来：照旧留着，不删", async () => {
  removed.length = 0;
  const view = render(stage({ id: "ch_plain" }));
  view.rerender(stage(null, "/channel/new"));
  await act(async () => wait(20));

  expect(view.queryByTestId("page")).not.toBeNull();
  expect(view.getByTestId("kept-page").getAttribute("data-visible")).toBe(
    "false",
  );
  expect(removed).toEqual([]);
});

test("接线：外壳按「是不是草稿 + 去哪」给留着的聊天定时长", () => {
  const shell = readFileSync(
    join(import.meta.dir, "../src/components/layout/authed-shell.tsx"),
    "utf8",
  );
  expect(shell).toContain("ttlMs={keptTtl}");
  expect(shell).toContain(
    "draftKeptTtl(kept.channelId, pathname, KEPT_TTL_MS)",
  );
});
