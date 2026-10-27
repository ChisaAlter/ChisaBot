import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { settleReactWork } from "./settle-react-work";

/**
 * CB-098 QA 第三轮：窄屏在右栏抽屉里切到「计算机」（地址带上 watch=true）后连续返回，
 * 以前抽屉关了又被拉开、地址在有无 watch 间来回、标记每轮加一，永远离不开页面。
 *
 * 用真实的 history + popstate，加上真实的 useBotComputerTab / useBackDismiss / closeRailSheet，
 * 只把路由（地址 → watch）和右栏「计算机一开就拉出抽屉」这两件事用最小的等价实现代替。
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const outside = () =>
  (window.history.state as { outside?: boolean } | null)?.outside === true;
const markers = () =>
  (window.history.state as { __cbOverlay?: number } | null)?.__cbOverlay ??
  null;

async function harness(agentId: string) {
  const { useBotComputerTab } = await import("@/lib/chat/use-bot-computer");
  const {
    lastHistoryEventWasPop,
    noteUserIntent,
    restampOverlayMarker,
    useBackDismiss,
  } = await import("@/lib/overlay-back");
  const { closeRailSheet } = await import("@/lib/panels/rail-sheet-close");
  const readWatch = () =>
    new URL(window.location.href).searchParams.get("watch") === "true"
      ? true
      : undefined;
  const writeUrl = (open: boolean, replace: boolean) => {
    const url = open ? "/channel/new?watch=true" : "/channel/new";
    if (replace) {
      window.history.replaceState({ page: true }, "", url);
      restampOverlayMarker();
    } else window.history.pushState({ page: true }, "", url);
    window.dispatchEvent(new Event("cb-test-url"));
  };
  let sheetOpens = 0;
  const hook = renderHook(() => {
    const [watch, setWatch] = useState(readWatch());
    useEffect(() => {
      const sync = () => setWatch(readWatch());
      window.addEventListener("popstate", sync);
      window.addEventListener("cb-test-url", sync);
      return () => {
        window.removeEventListener("popstate", sync);
        window.removeEventListener("cb-test-url", sync);
      };
    }, []);
    const [computerOpen, setComputer] = useBotComputerTab(
      agentId,
      watch,
      writeUrl,
    );
    const [sheet, setSheet] = useState(false);
    const latest = useRef({ computerOpen, setComputer });
    latest.current = { computerOpen, setComputer };
    const closeComputer = () => {
      if (latest.current.computerOpen) latest.current.setComputer(false);
    };
    // panel-rail：计算机一开就拉出抽屉，但返回带出来的不算。
    useEffect(() => {
      if (!computerOpen || lastHistoryEventWasPop()) return;
      setSheet((was) => {
        if (!was) sheetOpens += 1;
        return true;
      });
    }, [computerOpen]);
    useBackDismiss(sheet, (reason) =>
      closeRailSheet(reason, {
        agentId,
        closeComputer,
        closeSheet: () => setSheet(false),
      }),
    );
    return { sheet, computerOpen, setSheet, setComputer };
  });
  const userOpenSheet = async () => {
    noteUserIntent();
    act(() => hook.result.current.setSheet(true));
    sheetOpens += 1;
    await tick();
  };
  const userTab = async (computer: boolean) => {
    noteUserIntent();
    act(() => hook.result.current.setComputer(computer));
    await tick();
  };
  const back = async () => {
    await act(async () => {
      window.history.back();
      await tick(60);
    });
  };
  return { hook, userOpenSheet, userTab, back, opens: () => sheetOpens };
}

describe("右栏抽屉停在「计算机」时返回（CB-098 QA 第三轮）", () => {
  test("停在计算机标签直接返回：一次关抽屉，地址不再写回 watch，history 不增长，下一次返回离开页面", async () => {
    document.documentElement.setAttribute("data-phone", "");
    try {
      window.history.replaceState({ outside: true }, "", "/before");
      window.history.pushState({ page: true }, "", "/channel/new");
      const h = await harness("agent-ro");
      await h.userOpenSheet();
      await h.userTab(true);
      expect(window.location.search).toBe("?watch=true");
      const len = window.history.length;
      await h.back();
      await tick(60);
      expect(h.hook.result.current.sheet).toBe(false);
      expect(outside()).toBe(false);
      expect(window.location.search).toBe("");
      expect(window.history.length).toBe(len);
      await h.back();
      expect(outside()).toBe(true);
    } finally {
      document.documentElement.removeAttribute("data-phone");
    }
  });

  test("连续返回不再重新打开抽屉、不再压标记：最多 2 次离开页面", async () => {
    document.documentElement.setAttribute("data-phone", "");
    try {
      window.history.replaceState({ outside: true }, "", "/before");
      window.history.pushState({ page: true }, "", "/channel/new");
      const h = await harness("agent-loop");
      await h.userOpenSheet();
      await h.userTab(true);
      const opensBefore = h.opens();
      let backs = 0;
      const seenMarkers = new Set<number>();
      while (backs < 8 && !outside()) {
        await h.back();
        backs += 1;
        await tick(60);
        const m = markers();
        if (m !== null) seenMarkers.add(m);
        if (!outside()) expect(h.hook.result.current.sheet).toBe(false);
      }
      expect(outside()).toBe(true);
      expect(backs).toBeLessThanOrEqual(2);
      expect(h.opens()).toBe(opensBefore);
      expect(seenMarkers.size).toBe(0);
    } finally {
      document.documentElement.removeAttribute("data-phone");
    }
  });

  test("停在计算机返回后再重开：重开压一条记录，history 不增长，返回先关抽屉", async () => {
    document.documentElement.setAttribute("data-phone", "");
    try {
      window.history.replaceState({ outside: true }, "", "/before");
      window.history.pushState({ page: true }, "", "/channel/new");
      const h = await harness("agent-reopen");
      await h.userOpenSheet();
      await h.userTab(true);
      const len = window.history.length;
      await h.back();
      await tick(150);
      await h.userOpenSheet();
      expect(window.history.length).toBe(len);
      await h.back();
      expect(h.hook.result.current.sheet).toBe(false);
      expect(outside()).toBe(false);
      await h.back();
      expect(outside()).toBe(true);
    } finally {
      document.documentElement.removeAttribute("data-phone");
    }
  });
});
