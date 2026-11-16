import { describe, expect, test } from "bun:test";
import { pruneEmptySections } from "./empty-sections";
import {
  ICON_NAMES,
  inspectRenderUiSpec,
  jsonRenderCatalog,
  normaliseTone,
  parseRenderUiSpec,
  RENDER_UI_TOOL,
  renderUiPrompt,
  validateRenderUiSpec,
} from "./catalog";

const line = (value: unknown) => JSON.stringify(value);

const GOOD = [
  line({ op: "add", path: "/root", value: "card" }),
  line({
    op: "add",
    path: "/elements/card",
    value: { type: "Card", props: { title: "本周概览" }, children: ["grid", "name", "send"] },
  }),
  line({ op: "add", path: "/elements/grid", value: { type: "Grid", props: { columns: 2 }, children: ["m1"] } }),
  line({
    op: "add",
    path: "/elements/m1",
    value: { type: "Metric", props: { label: "收入", value: "¥12,000", trend: "up" }, children: [] },
  }),
  line({
    op: "add",
    path: "/elements/name",
    value: { type: "Input", props: { label: "名字", value: { $bindState: "/form/name" } }, children: [] },
  }),
  line({ op: "add", path: "/state/form", value: { name: "" } }),
  line({
    op: "add",
    path: "/elements/send",
    value: {
      type: "Button",
      props: { label: "提交" },
      on: { press: { action: "send_message", params: { text: "提交表单", includeState: "/form" } } },
      children: [],
    },
  }),
].join("\n");

describe("json-render catalog (render_ui)", () => {
  test("a well-formed SpecStream compiles and validates", () => {
    const spec = parseRenderUiSpec(GOOD);
    const result = validateRenderUiSpec(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.elementCount).toBe(5);
      // `on` and `state` survive: the catalog validator strips them, the spec we keep must not.
      expect(result.spec.state).toEqual({ form: { name: "" } });
      expect((result.spec.elements.send as { on?: unknown }).on).toBeDefined();
    }
  });

  test("a whole JSON spec object is accepted as well as JSONL", () => {
    const spec = parseRenderUiSpec(
      JSON.stringify({ root: "t", elements: { t: { type: "Text", props: { text: "你好" }, children: [] } } }),
    );
    expect(validateRenderUiSpec(spec).ok).toBe(true);
  });

  test("code fences around the JSONL are tolerated", () => {
    expect(validateRenderUiSpec(parseRenderUiSpec(`\`\`\`jsonl\n${GOOD}\n\`\`\``)).ok).toBe(true);
  });

  test("streaming parse ignores the unfinished last line", () => {
    const cut = GOOD.slice(0, GOOD.indexOf("/elements/grid") + 20);
    const spec = parseRenderUiSpec(cut, true);
    expect(spec?.root).toBe("card");
    expect(Object.keys(spec?.elements ?? {})).toEqual(["card"]);
  });

  test("unknown components, missing children and bad props are reported", () => {
    const result = validateRenderUiSpec(
      parseRenderUiSpec(
        JSON.stringify({
          root: "a",
          elements: {
            a: { type: "Metric", props: { label: 3, value: "1" }, children: ["ghost"] },
            b: { type: "Marquee", props: {}, children: [] },
            c: { type: "Image", props: { src: "http://x.test/a.png", alt: "x" }, children: [] },
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const all = result.issues.join("\n");
      expect(all).toContain("Marquee");
      expect(all).toContain("ghost");
      expect(all).toContain("props.label");
      expect(all).toContain("https://");
    }
  });

  test("Image allows same-origin /api/chat-files and attachment paths while rejecting insecure or traversal URLs", () => {
    const valid = inspectRenderUiSpec(
      JSON.stringify({
        root: "s",
        elements: {
          s: { type: "Stack", props: {}, children: ["i1", "i2"] },
          i1: {
            type: "Image",
            props: { src: "/api/chat-files/cf_123", alt: "图一" },
            children: [],
          },
          i2: {
            type: "Image",
            props: {
              src: "/api/channels/ch_1/attachments/att_1?w=240",
              alt: "图二",
            },
            children: [],
          },
        },
      }),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(Object.keys(valid.spec.elements)).toEqual(["s", "i1", "i2"]);
    }

    for (const badSrc of [
      "http://x.test/a.png",
      "//evil.test/a.png",
      "/api/chat-files/../secret",
    ]) {
      const rejected = validateRenderUiSpec(
        parseRenderUiSpec(
          JSON.stringify({
            root: "img",
            elements: {
              img: {
                type: "Image",
                props: { src: badSrc, alt: "bad" },
                children: [],
              },
            },
          }),
        ),
      );
      expect(rejected.ok).toBe(false);
    }
  });

  test("action bindings are checked: unknown actions and missing params", () => {
    const button = (on: unknown) => ({
      root: "b",
      elements: { b: { type: "Button", props: { label: "确定" }, on, children: [] } },
    });
    const wrongParam = validateRenderUiSpec(
      button({ press: { action: "send_message", params: { message: "好的" } } }),
    );
    expect(wrongParam.ok).toBe(false);
    if (!wrongParam.ok) expect(wrongParam.issues.join("\n")).toContain("params.text");
    const unknown = validateRenderUiSpec(button({ press: { action: "delete_everything" } }));
    expect(unknown.ok).toBe(false);
    expect(validateRenderUiSpec(button({ press: { action: "setState", params: { statePath: "/x", value: 1 } } })).ok).toBe(true);
    expect(validateRenderUiSpec(button({ press: { action: "send_message", params: { text: "好的" } } })).ok).toBe(true);
  });

  test("dynamic expressions are not checked as static values", () => {
    const result = validateRenderUiSpec({
      root: "t",
      elements: { t: { type: "Text", props: { text: { $state: "/greeting" } }, children: [] } },
      state: { greeting: "你好" },
    });
    expect(result.ok).toBe(true);
  });

  test("a broken JSONL line is named instead of surfacing as a missing child", () => {
    const broken = GOOD.replace('"children":["m1"]}}', '"children":["m1"]}]}');
    const result = inspectRenderUiSpec(broken);
    // 写坏的那一行只跳过它定义的元素，其余照常显示；坏行作为警告报给模型。
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings?.[0]).toContain("第 3 行");
    expect(inspectRenderUiSpec(GOOD).ok).toBe(true);
  });

  test("empty or unparsable input is refused with a reason", () => {
    expect(validateRenderUiSpec(parseRenderUiSpec("")).ok).toBe(false);
    expect(validateRenderUiSpec(parseRenderUiSpec("not json")).ok).toBe(false);
  });

  test("the prompt names the tool, every component, and drops the invent-sample-data rules", () => {
    const prompt = renderUiPrompt();
    expect(prompt).toContain(RENDER_UI_TOOL);
    for (const name of jsonRenderCatalog.componentNames) expect(prompt).toContain(`- ${name}:`);
    expect(prompt).toContain("send_message");
    expect(prompt).not.toMatch(/sample data/i);
  });

  test("tolerant: message/content alias, unknown component and dangling child are skipped, not refused", () => {
    const spec = [
      JSON.stringify({ op: "add", path: "/root", value: "card" }),
      JSON.stringify({ op: "add", path: "/elements/card", value: { type: "Card", props: { title: "状态" }, children: ["m", "rec", "tbl", "btn"] } }),
      JSON.stringify({ op: "add", path: "/elements/m", value: { type: "Metric", props: { label: "CPU", value: "23%" }, children: [] } }),
      JSON.stringify({ op: "add", path: "/elements/rec", value: { type: "Record", props: {}, children: [] } }),
      JSON.stringify({ op: "add", path: "/elements/btn", value: { type: "Button", props: { label: "刷新" }, on: { press: { action: "send_message", params: { message: "刷新" } } }, children: [] } }),
    ].join("\n");
    const result = inspectRenderUiSpec(spec);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.spec.elements).sort()).toEqual(["btn", "card", "m"]);
      expect(result.spec.elements.card?.children).toEqual(["m", "btn"]);
      const on = (result.spec.elements.btn as { on?: { press?: { params?: { text?: string } } } }).on;
      expect(on?.press?.params?.text).toBe("刷新");
      expect(result.warnings?.join("\n")).toContain("Record");
    }
  });

  test("a spec whose root itself is unusable is still refused", () => {
    expect(inspectRenderUiSpec(JSON.stringify({ root: "x", elements: { x: { type: "Record", props: {}, children: [] } } })).ok).toBe(false);
  });

  test("rich components (2026-10-13) validate with real-looking props", () => {
    const spec = JSON.stringify({
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["hero", "chart", "ring", "gauge", "heat", "tabs", "tl", "kv", "acc", "cd", "clk", "rt", "car", "st", "dl", "av", "ln", "ic", "sp", "sep"] },
        hero: { type: "Hero", props: { title: "多云", value: "26℃", tone: "info", icon: "cloud", href: "https://example.org" }, children: [] },
        chart: { type: "Chart", props: { kind: "area", labels: ["a", "b", "c"], data: [1, "2,000", null], unit: "$" }, children: [] },
        ring: { type: "Ring", props: { segments: [{ label: "A", value: 3, tone: "good" }, { label: "B", value: 1 }] }, children: [] },
        gauge: { type: "Gauge", props: { value: 72, warnAt: 60, dangerAt: 90, unit: "%" }, children: [] },
        heat: { type: "HeatStrip", props: { values: [0, 1, 2, 3], rows: 7 }, children: [] },
        tabs: { type: "Tabs", props: { tabs: ["今天", "本周"] }, children: ["t1", "t2"] },
        t1: { type: "Text", props: { text: "一" }, children: [] },
        t2: { type: "Text", props: { text: "二" }, children: [] },
        tl: { type: "Timeline", props: { items: [{ title: "发货", time: "2026-10-13T08:00:00+08:00", tone: "success" }] }, children: [] },
        kv: { type: "KeyValue", props: { items: [{ label: "IP", value: "10.0.0.1", mono: true, copy: "10.0.0.1" }] }, children: [] },
        acc: { type: "Accordion", props: { title: "详情" }, children: ["t3"] },
        t3: { type: "Text", props: { text: "三" }, children: [] },
        cd: { type: "Countdown", props: { target: "2026-12-31T23:59:59+08:00" }, children: [] },
        clk: { type: "Clock", props: { timezone: "America/New_York", label: "纽约" }, children: [] },
        rt: { type: "RelativeTime", props: { time: "2026-10-13T08:00:00Z", prefix: "更新于" }, children: [] },
        car: { type: "Carousel", props: { itemWidth: "sm" }, children: ["m1"] },
        m1: { type: "Metric", props: { label: "Star", value: "128k", variant: "tinted", icon: "star", spark: [1, 2, 3], tone: "brand" }, children: [] },
        st: { type: "Status", props: { label: "官网", tone: "success", pulse: true, detail: "200" }, children: [] },
        dl: { type: "Delta", props: { value: "+3.2%" }, children: [] },
        av: { type: "Avatar", props: { name: "vercel", shape: "square" }, children: [] },
        ln: { type: "Link", props: { url: "https://github.com/vercel/next.js", title: "next.js" }, children: [] },
        ic: { type: "Icon", props: { name: "rocket", tone: "accent" }, children: [] },
        sp: { type: "Sparkline", props: { data: [3, 2, 5], label: "7 天" }, children: [] },
        sep: { type: "Separator", props: { label: "更早" }, children: [] },
      },
    });
    const result = inspectRenderUiSpec(spec);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings ?? []).toEqual([]);
  });

  test("new actions copy_text / refresh_panel are accepted; item-level href/ask/copy are plain props", () => {
    const spec = JSON.stringify({
      root: "r",
      elements: {
        r: { type: "Stack", props: {}, children: ["a", "b", "l"] },
        a: { type: "Button", props: { label: "复制" }, on: { press: { action: "copy_text", params: { text: "ssh root@x" } } }, children: [] },
        b: { type: "Button", props: { label: "刷新" }, on: { press: { action: "refresh_panel", params: {} } }, children: [] },
        l: { type: "List", props: { items: [{ title: "新闻", href: "https://news.example.org/1", ask: "展开讲讲", time: "2026-10-13T08:00:00Z" }] }, children: [] },
      },
    });
    expect(validateRenderUiSpec(parseRenderUiSpec(spec)).ok).toBe(true);
  });

  test("tones are tolerant: aliases map to the six semantic tones and unknown words fall back to default", () => {
    expect(normaliseTone("good")).toBe("success");
    expect(normaliseTone("Bad")).toBe("danger");
    expect(normaliseTone("brand")).toBe("accent");
    expect(normaliseTone("info")).toBe("info");
    expect(normaliseTone("chartreuse")).toBe("default");
    expect(normaliseTone(undefined)).toBe("default");
    // a Badge with tone "info" used to be refused by the old enum
    expect(inspectRenderUiSpec(JSON.stringify({ root: "b", elements: { b: { type: "Badge", props: { text: "x", tone: "info" }, children: [] } } })).ok).toBe(true);
  });

  test("non-https images on rich components are stripped, not the whole element", () => {
    const result = inspectRenderUiSpec(
      JSON.stringify({
        root: "r",
        elements: {
          r: { type: "Stack", props: {}, children: ["h", "l"] },
          h: { type: "Hero", props: { title: "封面", image: "http://insecure.test/a.jpg" }, children: [] },
          l: { type: "List", props: { items: [{ title: "a", image: "data:image/png;base64,xx" }] }, children: [] },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.spec.elements.h as { props: { image?: unknown } }).props.image).toBeNull();
      expect((result.spec.elements.l as { props: { items: { image?: unknown }[] } }).props.items[0]?.image).toBeNull();
    }
  });

  test("Products: a product grid validates, its non-https images are stripped, and the prompt says when to use it", () => {
    const result = inspectRenderUiSpec(
      JSON.stringify({
        root: "p",
        elements: {
          p: {
            type: "Products",
            props: {
              items: [
                { name: "索尼 WH-1000XM6", price: "¥2,999", note: "降噪最强", badge: "首选", url: "https://www.sony.com.cn/", image: "http://insecure.test/a.jpg", source: "官网" },
                { name: "Bose QC Ultra", price: "¥2,499", url: "https://www.bose.cn/" },
              ],
            },
            children: [],
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const items = (result.spec.elements.p as { props: { items: { image?: unknown; name: string }[] } }).props.items;
      expect(items).toHaveLength(2);
      expect(items[0]?.image).toBeNull();
      expect(items[1]?.name).toBe("Bose QC Ultra");
    }
    const prompt = renderUiPrompt();
    expect(prompt).toContain("- Products:");
    expect(prompt).toContain("推荐 / 比较商品");
  });

  test("the prompt lists the icon names and the component-choice rule", () => {
    const prompt = renderUiPrompt();
    expect(prompt).toContain("Chart");
    expect(prompt).toContain("能点就让它能点");
    expect(prompt).toContain(ICON_NAMES[0]);
  });

  test("empty charts / timelines / key-value lists are pruned like empty lists", () => {
    const spec = parseRenderUiSpec(
      JSON.stringify({
        root: "r",
        elements: {
          r: { type: "Stack", props: {}, children: ["h", "c", "h2", "t"] },
          h: { type: "Heading", props: { text: "走势" }, children: [] },
          c: { type: "Chart", props: { series: [{ name: "a", data: [] }] }, children: [] },
          h2: { type: "Heading", props: { text: "说明" }, children: [] },
          t: { type: "Text", props: { text: "留着" }, children: [] },
        },
      }),
    );
    const pruned = pruneEmptySections(spec);
    expect(Object.keys(pruned?.elements ?? {}).sort()).toEqual(["h2", "r", "t"]);
  });
});
