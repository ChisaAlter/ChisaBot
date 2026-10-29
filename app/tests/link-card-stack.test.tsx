import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  defaultLinkStackPrimary,
  LINK_CARD_FALLBACK_RATIO,
  LINK_CARD_GITHUB_RATIO,
  LINK_STACK_MOVE_MS,
  LinkCard,
  LinkCardStack,
  type LinkStackItem,
  linkMediaRatio,
  linkStackSlots,
} from "@/components/rich-previews/link-card";
import {
  isSiteOnlyTitle,
  mergeLinkFields,
  needsLinkPreview,
  shortLinkLabel,
} from "@/lib/rich-previews/link-fields";
import { settleReactWork } from "./settle-react-work";

/** 链接卡叠放（2026-10-29，照 Hark）：槽位分配、触屏两次点击、图片宽高比回退、标题只是站点名时换 og:title。 */

describe("linkStackSlots：主位居中，其余按顺序放左右槽", () => {
  test("1 张：只有主位，不倾斜", () => {
    expect(linkStackSlots(1, 0)).toEqual(["main"]);
    expect(linkStackSlots(1, 5)).toEqual(["main"]);
  });
  test("2 张：主位 + 右槽", () => {
    expect(linkStackSlots(2, 0)).toEqual(["main", "right"]);
    expect(linkStackSlots(2, 1)).toEqual(["right", "main"]);
  });
  test("3 张：剩下两张按原顺序放左槽、右槽", () => {
    expect(linkStackSlots(3, 1)).toEqual(["left", "main", "right"]);
    expect(linkStackSlots(3, 0)).toEqual(["main", "left", "right"]);
    expect(linkStackSlots(3, 2)).toEqual(["left", "right", "main"]);
  });
  test("越界的主位夹到范围内；最多 3 张", () => {
    expect(linkStackSlots(3, -1)).toEqual(["main", "left", "right"]);
    expect(linkStackSlots(3, 9)).toEqual(["left", "right", "main"]);
    expect(linkStackSlots(5, 1)).toHaveLength(3);
    expect(linkStackSlots(0, 0)).toEqual([]);
  });
  test("默认主位：三张时中间那张，其余第一张", () => {
    expect(defaultLinkStackPrimary(3)).toBe(1);
    expect(defaultLinkStackPrimary(2)).toBe(0);
    expect(defaultLinkStackPrimary(1)).toBe(0);
  });
});

describe("linkMediaRatio：图片区跟着图片比例，没有宽高时占位", () => {
  const gh = "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.13";
  test("有宽高：按原图比例（宽图完整显示）", () => {
    expect(linkMediaRatio(1200, 600, gh)).toEqual({
      ratio: 2,
      source: "image",
      square: false,
    });
    expect(linkMediaRatio(1200, 630, "https://a.example.com").ratio).toBe(
      1.905,
    );
    expect(linkMediaRatio(1600, 1000, "https://a.example.com").ratio).toBe(1.6);
  });
  test("太宽 / 太高的夹到 2.4:1 – 4:3；接近方形的当 logo 整张放", () => {
    expect(linkMediaRatio(3000, 500, "https://a.example.com").ratio).toBe(2.4);
    expect(linkMediaRatio(1300, 1000, "https://a.example.com").ratio).toBe(
      1.333,
    );
    expect(linkMediaRatio(512, 512, "https://a.example.com")).toMatchObject({
      square: true,
    });
  });
  test("没有宽高：GitHub 2:1，其它 1.91:1", () => {
    expect(linkMediaRatio(null, null, gh)).toEqual({
      ratio: LINK_CARD_GITHUB_RATIO,
      source: "github",
      square: false,
    });
    expect(linkMediaRatio(undefined, 0, "https://cafe.example.com/x")).toEqual({
      ratio: LINK_CARD_FALLBACK_RATIO,
      source: "fallback",
      square: false,
    });
    expect(LINK_CARD_GITHUB_RATIO).toBe(2);
    expect(LINK_CARD_FALLBACK_RATIO).toBe(1.91);
  });
});

describe("标题只是站点名：改用 og:title", () => {
  const url = "https://github.com/ChisaAlter/ChisaBot";
  const og = {
    title: "GitHub - ChisaAlter/ChisaBot",
    siteName: "GitHub",
    domain: "github.com",
  };
  test("isSiteOnlyTitle 认站点名、域名、域名主体，忽略大小写和空格", () => {
    expect(isSiteOnlyTitle("GitHub", null, url)).toBe(true);
    expect(isSiteOnlyTitle("github.com", null, url)).toBe(true);
    expect(isSiteOnlyTitle("www.github.com", null, url)).toBe(true);
    expect(
      isSiteOnlyTitle(
        "World Coffee Map",
        "World Coffee Map",
        "https://x.example.com",
      ),
    ).toBe(true);
    expect(isSiteOnlyTitle("ChisaBot v0.1.13", "GitHub", url)).toBe(false);
    expect(isSiteOnlyTitle("", "GitHub", url)).toBe(false);
  });
  test("给的标题是「GitHub」：用 og:title；og:title 也只是站点名时留着给的", () => {
    expect(mergeLinkFields(url, { title: "GitHub" }, og).title).toBe(og.title);
    expect(
      mergeLinkFields(url, { title: "GitHub" }, { ...og, title: "GitHub" })
        .title,
    ).toBe("GitHub");
    expect(mergeLinkFields(url, { title: "我的仓库" }, og).title).toBe(
      "我的仓库",
    );
  });
  test("标题只是站点名时即使字段齐了也去问预览", () => {
    const full = {
      title: "GitHub",
      image: "https://a.example.com/x.png",
      siteName: "GitHub",
    };
    expect(needsLinkPreview(full)).toBe(false);
    expect(needsLinkPreview(full, url)).toBe(true);
    expect(needsLinkPreview({ ...full, title: "ChisaBot" }, url)).toBe(false);
  });
});

describe("灰字短标签：「站点名 · 短标签」", () => {
  test("GitHub 发版 → 版本号，PR / issue → #号，仓库首页 → owner/repo，别的站不猜", () => {
    const gh = "https://github.com/ChisaAlter/ChisaBot";
    expect(shortLinkLabel(`${gh}/releases/tag/v0.1.13`)).toBe("v0.1.13");
    expect(shortLinkLabel(`${gh}/pull/380`)).toBe("#380");
    expect(shortLinkLabel(`${gh}/issues/12`)).toBe("#12");
    expect(shortLinkLabel(gh)).toBe("ChisaAlter/ChisaBot");
    expect(shortLinkLabel(`${gh}/tree/main/app`)).toBeNull();
    expect(shortLinkLabel("https://example.com/a/b")).toBeNull();
    expect(shortLinkLabel("不是网址")).toBeNull();
  });
  test("没给 meta 时用短标签；给了 meta 用给的", () => {
    const url = "https://github.com/ChisaAlter/ChisaBot/releases/tag/v0.1.13";
    const og = {
      title: "Release ChisaBot v0.1.13 · ChisaAlter/ChisaBot",
      siteName: "GitHub",
    };
    const merged = mergeLinkFields(url, {}, og);
    expect(`${merged.site} · ${merged.extra}`).toBe("GitHub · v0.1.13");
    expect(mergeLinkFields(url, { meta: "安卓版" }, og).extra).toBe("安卓版");
  });
});

const realFetch = globalThis.fetch;
/**
 * 点一下，返回链接会不会打开（React 有没有拦下默认动作）。监听挂在 React 的根容器上、排在 React 后面
 * （React 的 stopPropagation 拦不住同一个节点上的监听），看完再统一 preventDefault，免得 happy-dom 真去打开网址。
 */
function clickOpens(root: HTMLElement, el: HTMLElement): boolean {
  let opened = true;
  const spy = (event: Event) => {
    opened = !event.defaultPrevented;
    event.preventDefault();
  };
  root.addEventListener("click", spy);
  fireEvent.click(el, { detail: 1 });
  root.removeEventListener("click", spy);
  return opened;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LinkCardStack 交互", () => {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = decodeURIComponent(String(input).split("url=")[1] ?? "");
      return new Response(
        JSON.stringify({
          preview: {
            url,
            finalUrl: url,
            title: `Title ${url}`,
            siteName: "World Coffee Map",
            domain: new URL(url).hostname,
            description: "",
            image: null,
            imageKind: "none",
            imagePending: false,
            favicon: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
  });
  afterEach(() => cleanup());
  afterAll(async () => {
    await settleReactWork();
    globalThis.fetch = realFetch;
    GlobalRegistrator.unregister();
  });

  let seq = 0;
  const three = () => {
    seq++;
    return [1, 2, 3].map((n) => ({ url: `https://s${seq}-${n}.example.com/` }));
  };
  /** 等到出了 n 张真卡（新进来的那张先是骨架，预览取到才换成卡）。 */
  const cardsN = async (view: ReturnType<typeof render>, n: number) => {
    await waitFor(() =>
      expect(view.queryAllByTestId("link-card")).toHaveLength(n),
    );
    return view.getAllByTestId("link-card");
  };
  // 槽位、主位、层级在卡外层的 .lc-item 上（「追问」按钮和 <a> 是兄弟，见 link-card.tsx）。
  const item = (c: HTMLElement) => c.closest<HTMLElement>(".lc-item")!;
  const slots = (cards: HTMLElement[]) =>
    cards.map((c) => item(c).getAttribute("data-stack-slot"));

  test("三张：默认中间那张在主位；一张时不进叠放", async () => {
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    expect(slots(cards)).toEqual(["left", "main", "right"]);
    expect(item(cards[1]!).hasAttribute("data-primary")).toBe(true);
    // 主位那张层级最高。
    const z = cards.map((c) => Number(item(c).style.zIndex));
    expect(z[1]).toBeGreaterThan(Math.max(z[0]!, z[2]!));
    cleanup();
    const one = render(
      <LinkCardStack items={[{ url: `https://one${seq}.example.com/` }]} />,
    );
    const card = await one.findByTestId("link-card");
    expect(item(card).hasAttribute("data-stack-slot")).toBe(false);
    expect(one.getByTestId("link-cards").hasAttribute("data-deck")).toBe(false);
  });

  test("触屏：第一次点不打开、挪到主位；再点主位那张才打开", async () => {
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    fireEvent.pointerDown(cards[0]!, { pointerType: "touch" });
    expect(clickOpens(view.container, cards[0]!)).toBe(false);
    expect(slots(cards)).toEqual(["main", "left", "right"]);
    fireEvent.pointerDown(cards[0]!, { pointerType: "touch" });
    expect(clickOpens(view.container, cards[0]!)).toBe(true);
  });

  test("鼠标点击不在主位的卡：直接打开", async () => {
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    fireEvent.pointerDown(cards[2]!, { pointerType: "mouse" });
    expect(clickOpens(view.container, cards[2]!)).toBe(true);
  });

  test("鼠标移上去换主位；挪动期间和挪完后指针下换成的那张不来回跳；移开保持", async () => {
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    fireEvent.pointerMove(cards[0]!, { pointerType: "mouse" });
    expect(slots(cards)).toEqual(["main", "left", "right"]);
    // 挪动中：不换。
    fireEvent.pointerMove(cards[1]!, { pointerType: "mouse" });
    expect(slots(cards)).toEqual(["main", "left", "right"]);
    await sleep(LINK_STACK_MOVE_MS + 30);
    // 挪完后指针下是原来的主位卡（现在在左槽）：先不换回去。
    fireEvent.pointerMove(cards[1]!, { pointerType: "mouse" });
    fireEvent.pointerMove(cards[1]!, { pointerType: "mouse" });
    expect(slots(cards)).toEqual(["main", "left", "right"]);
    // 移到另一张卡上才换。
    fireEvent.pointerMove(cards[2]!, { pointerType: "mouse" });
    expect(slots(cards)).toEqual(["left", "right", "main"]);
    // 移开：保持最后一张在主位。
    fireEvent.pointerLeave(view.getByTestId("link-cards"), {
      pointerType: "mouse",
    });
    expect(item(cards[2]!).hasAttribute("data-primary")).toBe(true);
  });

  test("流式进卡：用户没选过时按张数重算默认主位；选过之后再进卡不动", async () => {
    const [a, b, c] = three();
    const view = render(<LinkCardStack items={[a!]} />);
    await view.findByTestId("link-card");
    view.rerender(<LinkCardStack items={[a!, b!, c!]} />);
    let cards = await cardsN(view, 3);
    expect(slots(cards)).toEqual(["left", "main", "right"]);
    cleanup();
    const [d, e, f] = three();
    const chosen = render(<LinkCardStack items={[d!, e!]} />);
    cards = await chosen.findAllByTestId("link-card");
    expect(slots(cards)).toEqual(["main", "right"]);
    // 鼠标移到（本来就在主位的）第一张上：算用户选过了。
    fireEvent.pointerMove(cards[0]!, { pointerType: "mouse" });
    chosen.rerender(<LinkCardStack items={[d!, e!, f!]} />);
    cards = await cardsN(chosen, 3);
    expect(cards).toHaveLength(3);
    expect(slots(cards)).toEqual(["main", "left", "right"]);
  });

  test("流式中第 3 张也照样进来；不满 3 张时才多一个骨架", async () => {
    const [a, b, c] = three();
    const two = render(<LinkCardStack items={[a!, b!]} pending />);
    await cardsN(two, 2);
    expect(two.queryAllByTestId("link-card-skeleton")).toHaveLength(1);
    two.rerender(<LinkCardStack items={[a!, b!, c!]} pending />);
    await cardsN(two, 3);
    expect(two.queryAllByTestId("link-card-skeleton")).toHaveLength(0);
    expect(two.getByTestId("link-cards").getAttribute("data-count")).toBe("3");
  });

  test("同一个网址出现两次：两张都出，key 不撞", async () => {
    seq++;
    const url = `https://dup${seq}.example.com/`;
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const view = render(
        <LinkCardStack
          items={[
            { url, title: "甲" },
            { url, title: "乙" },
          ]}
        />,
      );
      const cards = await view.findAllByTestId("link-card");
      expect(
        cards.map((c) => c.querySelector(".lc-title")!.textContent),
      ).toEqual(["甲", "乙"]);
    } finally {
      console.error = realError;
    }
    expect(errors.some((args) => String(args[0]).includes("same key"))).toBe(
      false,
    );
  });

  test("「追问」：自己 Tab 聚焦时显示；叠放时不在主位的卡上藏起来、点不到", async () => {
    const css = readFileSync(
      new URL("../src/components/rich-previews/link-card.css", import.meta.url),
      "utf8",
    );
    const showRule = css.match(
      /([^{}]+)\{\s*opacity: 1;\s*transform: none;\s*pointer-events: auto;\s*\}/,
    )!;
    expect(showRule[1]!.split(",").map((s) => s.trim())).toContain(
      ".lc-followup:focus-visible",
    );
    const hideRule = css.match(
      /([^{}/]+)\{\s*visibility: hidden;\s*pointer-events: none;\s*\}/,
    )!;
    const hide = hideRule[1]!.trim();
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    const buttons = cards.map(
      (c) => item(c).querySelector<HTMLElement>(".lc-followup")!,
    );
    expect(buttons.map((b) => b.matches(hide))).toEqual([true, false, true]);
    // 换到主位后它的按钮就不再被藏。
    fireEvent.pointerDown(cards[0]!, { pointerType: "touch" });
    clickOpens(view.container, cards[0]!);
    expect(buttons.map((b) => b.matches(hide))).toEqual([false, true, true]);
    cleanup();
    const one = render(
      <LinkCardStack items={[{ url: `https://f${seq}.example.com/` }]} />,
    );
    const btn = item(
      await one.findByTestId("link-card"),
    ).querySelector<HTMLElement>(".lc-followup")!;
    expect(btn.matches(hide)).toBe(false);
  });

  test("触屏的移动不换主位", async () => {
    const view = render(<LinkCardStack items={three()} />);
    const cards = await view.findAllByTestId("link-card");
    fireEvent.pointerMove(cards[0]!, { pointerType: "touch" });
    expect(slots(cards)).toEqual(["left", "main", "right"]);
  });

  test("标题一律当纯文本：HTML / markdown 原样显示，不变成标签", async () => {
    seq++;
    const title = "<b>粗</b> **星号** <img src=x onerror=alert(1)>";
    const view = render(
      <LinkCardStack
        items={[
          { url: `https://t${seq}-1.example.com/`, title, site: "Example" },
          {
            url: `https://t${seq}-2.example.com/`,
            title: "[链接](https://evil.example/)",
          },
        ]}
      />,
    );
    const cards = await view.findAllByTestId("link-card");
    const titles = cards.map((c) => c.querySelector(".lc-title")!);
    expect(titles[0]!.textContent).toBe(title);
    expect(titles[0]!.querySelector("b, img, strong")).toBeNull();
    expect(titles[1]!.textContent).toBe("[链接](https://evil.example/)");
    expect(titles[1]!.querySelector("a")).toBeNull();
  });

  test("直接吃 #391 的来源格式 { url, title, site, toolCallId }", async () => {
    seq++;
    // 和 shared/reply-sources.ts 的 ReplySources.sources[i] 同形（那个 PR 还没合，这里照字段写一份）。
    type ReplySource = {
      url: string;
      title: string;
      site: string;
      toolCallId: string;
    };
    const sources: ReplySource[] = [
      {
        url: `https://r${seq}-1.example.com/a`,
        title: "第一篇",
        site: "站点甲",
        toolCallId: "call_1",
      },
      {
        url: `https://r${seq}-2.example.com/b`,
        title: "第二篇",
        site: "站点乙",
        toolCallId: "call_2",
      },
    ];
    const items: readonly LinkStackItem[] = sources;
    const view = render(<LinkCardStack items={items} />);
    const cards = await view.findAllByTestId("link-card");
    expect(cards.map((c) => c.getAttribute("data-tool-call"))).toEqual([
      "call_1",
      "call_2",
    ]);
    expect(cards.map((c) => c.querySelector(".lc-title")!.textContent)).toEqual(
      ["第一篇", "第二篇"],
    );
    expect(cards[0]!.querySelector(".lc-meta")!.textContent).toContain(
      "站点甲",
    );
    cleanup();
    const single = render(<LinkCard {...sources[1]!} />);
    const card = await single.findByTestId("link-card");
    expect(card.getAttribute("data-tool-call")).toBe("call_2");
    expect(card.querySelector(".lc-meta")!.textContent).toContain("站点乙");
  });
});

describe("样式约束", () => {
  const css = readFileSync(
    new URL("../src/components/rich-previews/link-card.css", import.meta.url),
    "utf8",
  );
  test("不用模糊、不用 :has、不用 !important", () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/backdrop-filter\s*:/);
    expect(code).not.toMatch(/(^|[\s;{])filter\s*:/);
    expect(code).not.toMatch(/blur\(/);
    expect(code).not.toContain(":has(");
    expect(code).not.toContain("!important");
  });
  test("卡片只过渡 transform（--dur-2 + --ease-out，不长于换位锁定时间），减少动态效果时没有过渡", () => {
    const transitions = [
      // 位置（悬停抬起、叠放槽位）在外层 .lc-item 上，过渡也在它身上。
      ...css.matchAll(/\.lc-item \{[^}]*transition:\s*([^;]+);/g),
    ].map((m) => m[1]);
    expect(transitions[0]).toBe(
      "transform var(--dur-2, 220ms) var(--ease-out)",
    );
    expect(LINK_STACK_MOVE_MS).toBeGreaterThanOrEqual(220);
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.lc-item,[^}]*transition: none;/,
    );
  });
  test("材质、圆角、间距用设计系统令牌（不是 Hark 的固定深色）", () => {
    const card = css.match(/\n\.lc-card \{[^}]*\}/)![0];
    expect(card).toContain("--lc-radius: var(--r-lg, 20px)");
    expect(card).toContain("--lc-inset: var(--sp-2, 8px)");
    expect(card).toContain("background: var(--glass-bg-solid)");
    expect(card).toContain("color: var(--text)");
    expect(css).toContain(
      "border-radius: calc(var(--lc-radius) - var(--lc-inset))",
    );
    expect(css).toMatch(/\.lc-meta \{[^}]*color: var\(--text-secondary\)/);
    expect(css).not.toMatch(/\.dark \.lc-/);
  });
  test("叠放的卡全靠 transform 定位（同一个网格格子），槽位用变量", () => {
    expect(css).toMatch(
      /\.lc-stack\[data-deck\] \.lc-item \{[^}]*grid-area: 1 \/ 1;[^}]*transform: translate\(/,
    );
    expect(css).toContain(
      "--lc-w: min(208px, calc((100cqw - 16px) / (1 + 0.72 * var(--lc-sides))))",
    );
  });
});
