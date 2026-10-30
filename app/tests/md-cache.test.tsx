import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import {
  CachedBlock,
  SmoothStreamdown,
} from "@/components/chat/smooth-markdown";
import {
  LruCache,
  MdTailContext,
  mdCache,
  withMdCache,
} from "@/lib/chat/md-cache";
import { STREAMDOWN_ZH } from "@/lib/chat/streamdown-zh";
import { markdownComponents } from "@/lib/markdown";
import { settleReactWork } from "./settle-react-work";

if (typeof document === "undefined") GlobalRegistrator.register();

beforeEach(() => mdCache.clear());
afterEach(() => cleanup());
afterAll(async () => {
  await settleReactWork();
  if (GlobalRegistrator.isRegistered) GlobalRegistrator.unregister();
});

const DOC = [
  "## 小结",
  "这是一段**加粗**、`行内代码`和一个[链接](https://example.com)，还有 <b>原始 HTML</b>。",
  "- 要点一\n- 要点二\n  - 嵌套",
  "| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |",
  "```ts\nconst x = 1;\nconsole.log(x);\n```",
  "> 引用一段话\n\n1. 第一\n2. 第二",
  "[危险链接](javascript:alert(1))",
].join("\n\n");

const plain = (md: string) =>
  renderToStaticMarkup(
    <Streamdown translations={STREAMDOWN_ZH} components={markdownComponents}>
      {md}
    </Streamdown>,
  );
const cached = (md: string) =>
  renderToStaticMarkup(
    <Streamdown
      translations={STREAMDOWN_ZH}
      components={markdownComponents}
      BlockComponent={CachedBlock}
    >
      {md}
    </Streamdown>,
  );

test("缓存版输出和原版逐字节相同（未命中、命中两次都一样）", () => {
  const want = plain(DOC);
  const miss = cached(DOC);
  expect(mdCache.size).toBeGreaterThan(3);
  const hitsBefore = mdCache.hits;
  const hit = cached(DOC);
  expect(mdCache.hits).toBeGreaterThan(hitsBefore);
  expect(miss).toBe(want);
  expect(hit).toBe(want);
  // XSS 回归：rehype-harden 仍在管线里，命中缓存后 javascript: 也不会变回链接。
  expect(hit).not.toContain("javascript:");
});

test("重新挂载命中缓存：第二次挂载不再解析任何块", () => {
  const a = render(
    <SmoothStreamdown components={markdownComponents}>{DOC}</SmoothStreamdown>,
  );
  const html1 = a.container.innerHTML;
  a.unmount();
  const misses = mdCache.misses;
  const hits = mdCache.hits;
  const b = render(
    <SmoothStreamdown components={markdownComponents}>{DOC}</SmoothStreamdown>,
  );
  expect(b.container.innerHTML).toBe(html1);
  expect(mdCache.misses).toBe(misses);
  expect(mdCache.hits).toBeGreaterThan(hits);
});

test("流式：变长的末块不入缓存，定型的前面块入缓存", async () => {
  const view = render(
    <SmoothStreamdown components={markdownComponents}>{""}</SmoothStreamdown>,
  );
  const head = "第一段已经写完了。\n\n第二段也写完了。\n\n";
  let text = "";
  for (const piece of [head, "第三段正在", "写", "，还在写"]) {
    text += piece;
    await act(async () => {
      view.rerender(
        <SmoothStreamdown components={markdownComponents}>
          {text}
        </SmoothStreamdown>,
      );
      await new Promise((r) => setTimeout(r, 900));
    });
  }
  const keys = [
    ...(mdCache as unknown as { map: Map<string, unknown> }).map.keys(),
  ].map((k) => k.split("\u0000")[1]);
  expect(keys.some((k) => k.startsWith("第一段"))).toBe(true);
  expect(keys.some((k) => k.startsWith("第二段"))).toBe(true);
  expect(keys.some((k) => k.startsWith("第三段"))).toBe(false);
  // useSmoothText 在 happy-dom 里最后一小段会晚一拍放出（与缓存无关，改前同样如此），这里只看末块确实在变长地显示。
  expect(view.container.textContent).toContain("第三段正在写");
});

test("末块（只查不存）能读到定型时存下的同一段，且自己不写入", () => {
  const md = "同一段文字";
  cached(md);
  const size = mdCache.size;
  const hits = mdCache.hits;
  const asTail = (text: string) =>
    renderToStaticMarkup(
      <MdTailContext.Provider value={{ live: true, count: 1 }}>
        <Streamdown
          translations={STREAMDOWN_ZH}
          components={markdownComponents}
          BlockComponent={CachedBlock}
        >
          {text}
        </Streamdown>
      </MdTailContext.Provider>,
    );
  expect(asTail(md)).toBe(plain(md));
  expect(mdCache.hits).toBe(hits + 1);
  expect(asTail("另一段还在写的")).toBe(plain("另一段还在写的"));
  expect(mdCache.size).toBe(size);
});

test("LRU：超过条目上限淘汰最久没用的，get 会刷新顺序", () => {
  const lru = new LruCache(3, 1000);
  const t = (n: number) => ({ type: "root", children: [n] });
  lru.set("a", t(1), 1);
  lru.set("b", t(2), 1);
  lru.set("c", t(3), 1);
  expect(lru.get("a")).toBeTruthy(); // a 变成最新
  lru.set("d", t(4), 1);
  expect(lru.has("b")).toBe(false);
  expect(lru.has("a")).toBe(true);
  expect(lru.size).toBe(3);
});

test("LRU：超过字数上限也淘汰，单条超限直接不存", () => {
  const lru = new LruCache(100, 10);
  const t = { type: "root", children: [] };
  lru.set("a", t, 6);
  lru.set("b", t, 6);
  expect(lru.has("a")).toBe(false);
  expect(lru.totalChars).toBe(6);
  lru.set("huge", t, 11);
  expect(lru.has("huge")).toBe(false);
});

test("同一插件数组拿到稳定的变体（Block 的 memo 靠引用相等）", () => {
  const base: unknown[] = [];
  expect(withMdCache(base, true)).toBe(withMdCache(base, true));
  expect(withMdCache(base, false)).toBe(withMdCache(base, false));
  expect(withMdCache(base, true)).not.toBe(withMdCache(base, false));
});

test("命中返回的是拷贝：改动渲染出的树不会污染缓存", () => {
  const md = "一段[链接](https://example.com)";
  const first = cached(md);
  const [entry] = [
    ...(
      mdCache as unknown as {
        map: Map<string, { hast: { children: unknown[] } }>;
      }
    ).map.values(),
  ];
  const before = JSON.stringify(entry?.hast);
  cached(md);
  cached(md);
  expect(JSON.stringify(entry?.hast)).toBe(before);
  expect(cached(md)).toBe(first);
});
