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
import { cleanup, render } from "@testing-library/react";
import { LinkCardStack } from "@/components/rich-previews/link-card";
import { MessageRichPreviews } from "@/components/rich-previews/rich-previews";
import {
  confidentLinkStart,
  extractUserLinks,
  splitLinkLines,
} from "@/lib/rich-previews/extract";
import { settleReactWork } from "./settle-react-work";

/** 链接卡组小修（fix/linkstack-streaming）：流式时的骨架、用户消息里的链接卡。 */

describe("流式：最后一行的骨架只在确定是网址时放", () => {
  test("主机名写完（后面有 /）才算确定，返回这截网址", () => {
    expect(confidentLinkStart("https://github.com/Chi")).toBe(
      "https://github.com/Chi",
    );
    expect(confidentLinkStart("**https://github.com/a")).toBe(
      "https://github.com/a",
    );
    expect(confidentLinkStart("<https://vite.dev/blog")).toBe(
      "https://vite.dev/blog",
    );
    expect(confidentLinkStart("[下载 0.1.7](https://github.com/a/b")).toBe(
      "https://github.com/a/b",
    );
    for (const weak of [
      "h",
      "ht",
      "https",
      "https://",
      "https://gi",
      "https://github.co",
      "[下载](",
      "hello",
    ])
      expect(confidentLinkStart(weak)).toBeNull();
  });

  test("还看不出来的半截先藏起来、不放骨架（写成普通文字时不闪一下）", () => {
    for (const weak of ["h", "htt", "https://", "https://github.co"]) {
      const out = splitLinkLines(`看这个：\n${weak}`, { final: false });
      expect(out.display).toBe("看这个：");
      expect(out.pending).toBe(false);
      expect(out.pendingUrl).toBeUndefined();
    }
    const sure = splitLinkLines("看这个：\nhttps://github.com/ChisaAlter", {
      final: false,
    });
    expect(sure).toEqual({
      links: [],
      display: "看这个：",
      pending: true,
      pendingUrl: "https://github.com/ChisaAlter",
    });
  });
});

describe("用户消息里的链接", () => {
  test("句子中间的也算：裸网址、Markdown、Slack 的 <网址|文字>；按顺序去重，最多 3 个", () => {
    const text =
      "帮我看看 https://github.com/ChisaAlter/ChisaBot/pull/397这个，还有 [文档](https://docs.x.com/a) 和 <https://slack.com/x|Slack 页>。" +
      " 再一次 https://github.com/ChisaAlter/ChisaBot/pull/397#top https://d.example.com/";
    expect(extractUserLinks(text)).toEqual([
      { url: "https://github.com/ChisaAlter/ChisaBot/pull/397" },
      { url: "https://docs.x.com/a", label: "文档" },
      { url: "https://slack.com/x", label: "Slack 页" },
    ]);
  });

  test("代码里的、图片、不合法的不算", () => {
    expect(
      extractUserLinks(
        "`https://code.example.com/x`\n```\nhttps://block.example.com/\n```\n![图](https://img.example.com/a.png) http://localhost/x ftp://a.com/b",
      ),
    ).toEqual([]);
  });
});

const realFetch = globalThis.fetch;

describe("渲染", () => {
  beforeAll(() => {
    if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "x" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  });
  afterEach(() => cleanup());
  afterAll(async () => {
    await settleReactWork();
    globalThis.fetch = realFetch;
    GlobalRegistrator.unregister();
  });

  test("用户消息：句中的 GitHub 链接也出卡，卡组靠右", async () => {
    const view = render(
      <MessageRichPreviews
        align="end"
        text={
          "帮我看看 https://github.com/ChisaAlter/ChisaBot/pull/397 这个 PR"
        }
      />,
    );
    const card = await view.findByTestId("link-card");
    expect(card.getAttribute("href")).toBe(
      "https://github.com/ChisaAlter/ChisaBot/pull/397",
    );
    expect(
      view.container.querySelector(".rp-stack")?.getAttribute("data-align"),
    ).toBe("end");
  });

  test("机器人消息：句中的链接照旧不出卡", async () => {
    const view = render(
      <MessageRichPreviews
        text={"详见 https://github.com/ChisaAlter/ChisaBot/pull/397 这个 PR"}
      />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(view.queryByTestId("link-cards")).toBeNull();
  });

  test("流式骨架按写出来的网址定比例：GitHub 2:1；静态底色，不用扫光类", () => {
    const view = render(
      <LinkCardStack
        items={[]}
        pending
        pendingUrl="https://github.com/ChisaAlter"
      />,
    );
    const skeleton = view.getByTestId("link-card-skeleton");
    const media = skeleton.querySelector<HTMLElement>(".lc-media")!;
    expect(media.getAttribute("data-ratio")).toBe("github");
    expect(media.style.aspectRatio).toMatch(/^2( \/ 1)?$/);
    expect(skeleton.innerHTML).not.toContain("sky-skel");
  });

  test("卡组的槽位写在 data-stack-slot，不用 data-slot（styles.css 有 :has([data-slot=…]) 规则，改 data-slot 会整页重算样式）", async () => {
    const view = render(
      <LinkCardStack
        items={[
          { url: "https://a.example.com/" },
          { url: "https://b.example.com/" },
        ]}
        pending
        pendingUrl="https://github.com/ChisaAlter"
      />,
    );
    await view.findAllByTestId("link-card");
    const stack = view.getByTestId("link-cards");
    const slotted = [...stack.querySelectorAll("[data-stack-slot]")].map((el) =>
      el.getAttribute("data-stack-slot"),
    );
    expect(slotted.sort()).toEqual(["left", "main", "right"]);
    expect(stack.querySelectorAll("[data-slot]")).toHaveLength(0);
  });
});

describe("源码约束", () => {
  const css = readFileSync(
    new URL("../src/components/rich-previews/link-card.css", import.meta.url),
    "utf8",
  );
  const transcript = readFileSync(
    new URL("../src/components/channels/chat-transcript.tsx", import.meta.url),
    "utf8",
  );
  test("骨架只动透明度，只在没有要求减少动态效果时动", () => {
    const keyframes = css.match(
      /@keyframes lc-skel-breathe \{[\s\S]*?\n\}/,
    )![0];
    expect(keyframes.replace(/\s+/g, " ")).not.toMatch(
      /background|filter|width|height|transform/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\) \{\s*\.lc-skel \.lc-skel-block,\s*\.lc-skel \.lc-skel-bar \{\s*animation: lc-skel-breathe/,
    );
    expect(css).not.toMatch(/linear-gradient\([^)]*90deg/);
  });
  test("卡组样式不认 data-slot", () => {
    expect(css).not.toContain("data-slot");
  });
  test("开场一句（流式中的第一段）也画链接卡", () => {
    expect(transcript).not.toMatch(
      /tone === "lead" \? null : \(\s*<MessageRichPreviews/,
    );
    expect(transcript).toContain(
      "<MessageRichPreviews align={align} text={isUser ? said : text} />",
    );
  });
});
