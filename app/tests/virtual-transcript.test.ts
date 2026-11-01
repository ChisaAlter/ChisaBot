import { expect, test } from "bun:test";
import {
  findTranscriptMatches,
  isPrepend,
  splitVirtualTail,
  stepMatch,
  TranscriptSizeCache,
  VIRTUAL_TAIL_ROWS,
} from "@/lib/chat/virtual-transcript";
import { resolveVirtualTranscript } from "@/lib/chat/virtual-transcript-flag";

test("前插历史才开 shift：追加、换对话都不算", () => {
  expect(isPrepend(["a", "b"], ["x", "y", "a", "b"])).toBe(true);
  expect(isPrepend(["a", "b"], ["a", "b", "c"])).toBe(false);
  expect(isPrepend(["a", "b"], ["p", "q", "r"])).toBe(false);
  expect(isPrepend([], ["a"])).toBe(false);
  // 旧第一行还在但后面顺序乱了：不当前插
  expect(isPrepend(["a", "b"], ["x", "a", "c", "b"])).toBe(false);
});

test("末尾常驻：最后几行不进虚拟列表", () => {
  expect(splitVirtualTail(100)).toEqual({
    head: 100 - VIRTUAL_TAIL_ROWS,
    tail: VIRTUAL_TAIL_ROWS,
  });
  expect(splitVirtualTail(2)).toEqual({ head: 0, tail: 2 });
  expect(splitVirtualTail(0)).toEqual({ head: 0, tail: 0 });
});

test("行高缓存：按会话 key + id 前缀复用，对不上就丢", () => {
  const cache = new TranscriptSizeCache<string>(2);
  cache.save("A", ["a1", "a2"], "snapA", (i) => [40, 120][i] ?? 0);
  expect(cache.restore("A", ["a1", "a2"])).toBe("snapA");
  // 后面追加了：仍是前缀，复用
  expect(cache.restore("A", ["a1", "a2", "a3"])).toBe("snapA");
  // 中间插了 / 换了：不复用
  expect(cache.restore("A", ["a0", "a1", "a2"])).toBeUndefined();
  expect(cache.restore("A", ["a1"])).toBeUndefined();
  expect(cache.heightOf("A", "a2")).toBe(120);
  // 不会把 A 的高度给 B
  expect(cache.restore("B", ["a1", "a2"])).toBeUndefined();
});

test("行高缓存：只留最近几个会话，release 立即释放", () => {
  const cache = new TranscriptSizeCache<number>(2);
  cache.save("A", ["a"], 1);
  cache.save("B", ["b"], 2);
  cache.restore("A", ["a"]); // A 续命
  cache.save("C", ["c"], 3); // 淘汰 B
  expect(cache.restore("B", ["b"])).toBeUndefined();
  expect(cache.restore("A", ["a"])).toBe(1);
  cache.release("A");
  expect(cache.restore("A", ["a"])).toBeUndefined();
  expect(cache.size).toBe(1);
});

test("应用内搜索在数据里找（不依赖 DOM），上一个 / 下一个循环", () => {
  const rows = [
    { id: "1", t: "Hello 世界" },
    { id: "2", t: null },
    { id: "3", t: "say HELLO" },
  ];
  expect(findTranscriptMatches(rows, "hello", (r) => r.t)).toEqual(["1", "3"]);
  expect(findTranscriptMatches(rows, "  ", (r) => r.t)).toEqual([]);
  expect(stepMatch(-1, 2, 1)).toBe(0);
  expect(stepMatch(-1, 2, -1)).toBe(1);
  expect(stepMatch(1, 2, 1)).toBe(0);
  expect(stepMatch(0, 2, -1)).toBe(1);
  expect(stepMatch(0, 0, 1)).toBe(-1);
});

test("flag：URL > localStorage > 构建默认，默认关", () => {
  expect(resolveVirtualTranscript({})).toBe(false);
  expect(resolveVirtualTranscript({ buildDefault: "1" })).toBe(true);
  expect(resolveVirtualTranscript({ stored: "off", buildDefault: "1" })).toBe(
    false,
  );
  expect(resolveVirtualTranscript({ url: "1", stored: "off" })).toBe(true);
  expect(resolveVirtualTranscript({ url: "0", stored: "on" })).toBe(false);
  expect(resolveVirtualTranscript({ url: "garbage" })).toBe(false);
});
