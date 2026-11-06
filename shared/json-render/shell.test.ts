import { describe, expect, test } from "bun:test";
import { needsShell } from "./shell";

/** 只写类型和孩子：needsShell 不看别的属性（Separator / Image / Icon / Tabs 除外）。 */
const el = (
  type: string,
  children: string[] = [],
  props: Record<string, unknown> = {},
) => ({ type, props, children });
const spec = (elements: Record<string, unknown>, root = "root") => ({
  root,
  elements,
});

describe("needsShell", () => {
  test("cards side by side with a muted note under them: the note sits on the sky, so the surface gets a shell", () => {
    // 2026-11-06 截图：两张对比卡片在 Grid 里，下面一行小字直接落在天空上。
    expect(
      needsShell(
        spec({
          root: el("Stack", ["grid", "note"]),
          grid: el("Grid", ["a", "b"]),
          a: el("Card", ["at"], { title: "方案 A" }),
          at: el("Text"),
          b: el("Card", ["bt"], { title: "方案 B" }),
          bt: el("Text"),
          note: el("Text", [], { tone: "muted", size: "sm" }),
        }),
      ),
    ).toBe(true);
  });

  test("a root Card is the shell already; text inside cards does not count", () => {
    expect(needsShell(spec({ root: el("Card", ["t"]), t: el("Text") }))).toBe(
      false,
    );
    expect(
      needsShell(
        spec({
          root: el("Stack", ["a", "b"]),
          a: el("Card", ["h", "kv"]),
          h: el("Heading"),
          kv: el("KeyValue"),
          b: el("Card"),
        }),
      ),
    ).toBe(false);
  });

  test("things with their own background can stand on the sky without a shell", () => {
    expect(
      needsShell(
        spec({
          root: el("Grid", ["m1", "m2"]),
          m1: el("Metric"),
          m2: el("Metric"),
        }),
      ),
    ).toBe(false);
    expect(
      needsShell(
        spec({
          root: el("Stack", ["b1", "b2"], { direction: "horizontal" }),
          b1: el("Button"),
          b2: el("Button"),
        }),
      ),
    ).toBe(false);
    expect(
      needsShell(
        spec({
          root: el("Stack", ["p", "l"]),
          p: el("Products"),
          l: el("List"),
        }),
      ),
    ).toBe(false);
    expect(
      needsShell(
        spec({
          root: el("Carousel", ["l1", "l2"]),
          l1: el("Link"),
          l2: el("Link"),
        }),
      ),
    ).toBe(false);
  });

  test("anything drawn straight on the background asks for a shell", () => {
    expect(needsShell(spec({ root: el("Text") }))).toBe(true);
    expect(
      needsShell(
        spec({
          root: el("Stack", ["h", "p"]),
          h: el("Heading"),
          p: el("Products"),
        }),
      ),
    ).toBe(true);
    expect(
      needsShell(spec({ root: el("Stack", ["kv"]), kv: el("KeyValue") })),
    ).toBe(true);
    expect(needsShell(spec({ root: el("Grid", ["c"]), c: el("Chart") }))).toBe(
      true,
    );
    // 轮播里一项是没有卡片的 Stack：里面的字一样落在背景上。
    expect(
      needsShell(
        spec({
          root: el("Carousel", ["s"]),
          s: el("Stack", ["t"]),
          t: el("Text"),
        }),
      ),
    ).toBe(true);
  });

  test("a bare line or picture is fine; its label or caption is text on the sky", () => {
    const between = (sep: unknown) =>
      spec({
        root: el("Stack", ["a", "sep", "b"]),
        a: el("Card"),
        sep,
        b: el("Card"),
      });
    expect(needsShell(between(el("Separator")))).toBe(false);
    expect(needsShell(between(el("Separator", [], { label: "  " })))).toBe(
      false,
    );
    expect(needsShell(between(el("Separator", [], { label: "更早" })))).toBe(
      true,
    );
    expect(
      needsShell(
        between(el("Image", [], { src: "https://a.test/x.png", alt: "" })),
      ),
    ).toBe(false);
    expect(
      needsShell(
        between(
          el("Image", [], {
            src: "https://a.test/x.png",
            alt: "",
            caption: "图注",
          }),
        ),
      ),
    ).toBe(true);
  });

  test("segmented Tabs have their own background; underline tabs and loose text in a pane do not", () => {
    const tabs = (props: Record<string, unknown>, pane = "c1") =>
      spec({
        root: el("Tabs", [pane, "c2"], { tabs: ["今天", "本周"], ...props }),
        c1: el("Card"),
        c2: el("Card"),
        t: el("Text"),
      });
    expect(needsShell(tabs({}))).toBe(false);
    expect(needsShell(tabs({ variant: "segmented" }))).toBe(false);
    expect(needsShell(tabs({ variant: "tabs" }))).toBe(true);
    expect(needsShell(tabs({}, "t"))).toBe(true);
  });

  test("while streaming, children that have not arrived yet are skipped until they do", () => {
    expect(needsShell(spec({}))).toBe(false);
    const early = {
      root: el("Stack", ["grid", "note"]),
      grid: el("Grid", ["a"]),
      a: el("Card"),
    };
    expect(needsShell(spec(early))).toBe(false);
    expect(needsShell(spec({ ...early, note: el("Text") }))).toBe(true);
  });

  test("malformed input never throws or loops", () => {
    expect(needsShell(null)).toBe(false);
    expect(needsShell(undefined)).toBe(false);
    expect(needsShell({ root: 1, elements: {} })).toBe(false);
    expect(needsShell({ root: "root" })).toBe(false);
    expect(needsShell(spec({ root: { props: {} } }))).toBe(false);
    expect(
      needsShell(
        spec({ root: el("Stack", [7 as unknown as string, "missing"]) }),
      ),
    ).toBe(false);
    // 互相引用：每个元素只看一次。
    expect(
      needsShell(spec({ root: el("Stack", ["a"]), a: el("Stack", ["root"]) })),
    ).toBe(false);
  });
});
