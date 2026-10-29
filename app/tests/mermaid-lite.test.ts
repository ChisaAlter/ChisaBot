import { describe, expect, test } from "bun:test";
import { renderMermaidToSvg, wrapLabel } from "../src/lib/chat/mermaid-lite";

type Box = { x: number; y: number; w: number; h: number; lines: string[] };

/** 从输出里读出每个节点：形状的外框 + 里面的文字行。 */
function nodes(svg: string): Box[] {
  const out: Box[] = [];
  for (const g of svg.matchAll(/<g class="cb-mermaid-node">([\s\S]*?)<\/g>/g)) {
    const body = g[1] ?? "";
    const lines = [...body.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map(
      (m) => m[1] ?? "",
    );
    const rect =
      /<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
        body,
      );
    const circle = /<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)"/.exec(
      body,
    );
    const poly = /<polygon points="([^"]+)"/.exec(body);
    if (rect)
      out.push({
        x: +rect[1]!,
        y: +rect[2]!,
        w: +rect[3]!,
        h: +rect[4]!,
        lines,
      });
    else if (circle)
      out.push({
        x: +circle[1]! - +circle[3]!,
        y: +circle[2]! - +circle[3]!,
        w: +circle[3]! * 2,
        h: +circle[3]! * 2,
        lines,
      });
    else if (poly) {
      const pts = poly[1]!.split(" ").map((p) => p.split(",").map(Number));
      const xs = pts.map((p) => p[0]!);
      const ys = pts.map((p) => p[1]!);
      out.push({
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
        lines,
      });
    }
  }
  return out;
}

const labels = (svg: string) => nodes(svg).map((n) => n.lines.join(""));
const edgeCount = (svg: string) =>
  (svg.match(/<path d="M [-\d.]+ [-\d.]+ C/g) ?? []).length;
const edgeLabels = (svg: string) =>
  [
    ...svg.matchAll(
      /<rect [^>]*rx="6" fill="var\(--cb-mermaid-pill-bg[^>]*\/>\s*<text[^>]*>([\s\S]*?)<\/text>/g,
    ),
  ].map((m) =>
    [...(m[1] ?? "").matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)]
      .map((t) => t[1])
      .join(""),
  );

describe("mermaid-lite 流程图（审计 05 必修 2）", () => {
  test("链式边 + 边标签：节点和连线都对", () => {
    const svg = renderMermaidToSvg(
      "graph TD\nA[开始] --> B[读取输入] --> C[校验数据]\nD{有效?} -->|是| E[执行计算]\nD -->|否| F[报错]",
    );
    expect(labels(svg).sort()).toEqual(
      ["开始", "读取输入", "校验数据", "有效?", "执行计算", "报错"].sort(),
    );
    expect(edgeCount(svg)).toBe(4);
    expect(edgeLabels(svg).sort()).toEqual(["否", "是"]);
    expect(svg).not.toContain("--&gt;");
    expect(svg).not.toContain("|");
  });

  test("一行多条语句用分号隔开", () => {
    const svg = renderMermaidToSvg("graph TD; A[开始] --> B[读取]; B --> C");
    expect(labels(svg)).toEqual(["开始", "读取", "C"]);
    expect(edgeCount(svg)).toBe(2);
  });

  test("A & B --> C & D 展开成四条边、四个节点", () => {
    const svg = renderMermaidToSvg("flowchart LR\nA & B --> C & D");
    expect(labels(svg)).toEqual(["A", "B", "C", "D"]);
    expect(edgeCount(svg)).toBe(4);
  });

  test("各种连线写法", () => {
    const svg = renderMermaidToSvg(
      "graph LR\nA -- 是 --> B\nA -. 可选 .-> C\nA == 强 ==> D\nA --- E\nA <--> F\nA ~~~ G\nA --o H\nA --x I",
    );
    expect(labels(svg)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    expect(edgeLabels(svg).sort()).toEqual(["可选", "强", "是"].sort());
    // ~~~ 是不可见连线：参与布局，不画出来。
    expect(edgeCount(svg)).toBe(7);
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain('stroke-width="2.4"');
    expect(svg).toContain('marker-start="url(#cb-arrow)"');
  });

  test("subgraph 画成带标题的框，节点在框里", () => {
    const svg = renderMermaidToSvg(
      "flowchart TB\nsubgraph one [前端]\na1-->a2\nend\nsubgraph two\nb1-->b2\nend\na2-->b1\nc1-->a1",
    );
    expect(labels(svg)).toEqual(["a1", "a2", "b1", "b2", "c1"]);
    expect(edgeCount(svg)).toBe(4);
    const boxes = [
      ...svg.matchAll(
        /<g class="cb-mermaid-subgraph"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>(?:<text[^>]*>([^<]*)<\/text>)?/g,
      ),
    ];
    expect(boxes.map((b) => b[5]).sort()).toEqual(["two", "前端"]);
    const byLabel = new Map(nodes(svg).map((n) => [n.lines.join(""), n]));
    for (const [title, members] of [
      ["前端", ["a1", "a2"]],
      ["two", ["b1", "b2"]],
    ] as const) {
      const box = boxes.find((b) => b[5] === title)!;
      const [x, y, w, h] = [+box[1]!, +box[2]!, +box[3]!, +box[4]!];
      for (const id of members) {
        const n = byLabel.get(id)!;
        expect(n.x).toBeGreaterThanOrEqual(x);
        expect(n.y).toBeGreaterThanOrEqual(y);
        expect(n.x + n.w).toBeLessThanOrEqual(x + w);
        expect(n.y + n.h).toBeLessThanOrEqual(y + h);
      }
      // 框外的节点不落进框里。
      const c1 = byLabel.get("c1")!;
      expect(
        c1.x + c1.w <= x || c1.x >= x + w || c1.y + c1.h <= y || c1.y >= y + h,
      ).toBe(true);
    }
  });

  test("节点形状", () => {
    const svg = renderMermaidToSvg(
      "graph TD\nA([s])-->B((c))-->C[[sub]]-->D[(db)]-->E{{hex}}-->F>flag]-->G[/para/]-->H{判断}",
    );
    expect(labels(svg)).toEqual([
      "s",
      "c",
      "sub",
      "db",
      "hex",
      "flag",
      "para",
      "判断",
    ]);
    expect(svg).toContain("<circle");
    expect((svg.match(/<polygon/g) ?? []).length).toBe(2);
  });

  test("带连字符 / 点的 id 不和连线混淆", () => {
    const svg = renderMermaidToSvg("graph TD\nmy-node-->other_node\nx.y --> z");
    expect(labels(svg)).toEqual(["my-node", "other_node", "x.y", "z"]);
    expect(edgeCount(svg)).toBe(2);
  });

  test("长标签折行，文字不超出节点框", () => {
    const svg = renderMermaidToSvg(
      'graph TD\nA[这是一个非常非常长的节点标签，用来测试折行是否正常工作，不应该溢出节点框之外的边界] --> B[Short]\nB --> C["a very long english label that should wrap onto multiple lines nicely"]\nB --> D{一个很长很长很长很长的判断条件是否成立呢}',
    );
    const list = nodes(svg);
    const long = list.filter((n) => n.lines.length > 1);
    expect(long.length).toBe(3);
    for (const n of list) {
      const widest = Math.max(
        ...n.lines.map((l) =>
          [...l.trimEnd()].reduce(
            (w, ch) => w + (ch.charCodeAt(0) > 255 ? 14.5 : 8.2),
            0,
          ),
        ),
      );
      expect(widest).toBeLessThanOrEqual(n.w);
      expect(n.lines.length * 17).toBeLessThanOrEqual(n.h);
    }
    expect(long[0]!.lines.join("")).toBe(
      "这是一个非常非常长的节点标签，用来测试折行是否正常工作，不应该溢出节点框之外的边界",
    );
  });

  test("<br> 换行", () => {
    const svg = renderMermaidToSvg("graph TD\nA[第一行<br/>第二行] --> B");
    expect(nodes(svg)[0]!.lines).toEqual(["第一行", "第二行"]);
  });

  test("有环、自环也能画，不会无限加深", () => {
    expect(edgeCount(renderMermaidToSvg("graph TD\nA-->B-->C-->A"))).toBe(3);
    expect(labels(renderMermaidToSvg("graph TD\nA-->B-->C-->A"))).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(renderMermaidToSvg("graph TD\nA-->A")).toContain("<path");
  });

  test("1000 个节点也很快", () => {
    const lines = ["graph TD"];
    for (let i = 0; i < 999; i++) lines.push(`n${i} --> n${i + 1}`);
    const t0 = performance.now();
    const svg = renderMermaidToSvg(lines.join("\n"));
    expect(nodes(svg).length).toBe(1000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("认不出 / 没写完时回退成代码（返回空串）", () => {
  test.each([
    ["gantt", "gantt\ntitle A\nsection S\nTask :a1, 2024-01-01, 30d"],
    ["classDiagram", "classDiagram\nA <|-- B"],
    ["erDiagram", "erDiagram\nA ||--o{ B : has"],
    ["mindmap", "mindmap\nroot\n  a"],
    ["journey", "journey\ntitle x"],
    ["没有图头", "A --> B"],
    ["只有图头", "graph TD"],
    ["方括号没闭合", "graph TD\nA[开始] --> B[读取"],
    ["连线后面没写节点", "graph TD\nA --> B\nC -->"],
    ["subgraph 没 end", "graph TD\nsubgraph x\nA-->B"],
    ["多余的 end", "graph TD\nA-->B\nend"],
    ["看不懂的语句", "graph TD\nA --> B\n这不是 mermaid !!"],
  ])("%s", (_name, code) => {
    expect(renderMermaidToSvg(code)).toBe("");
  });
});

describe("其它图类型", () => {
  test("状态图：起止点、带标签的转移", () => {
    const svg = renderMermaidToSvg(
      "stateDiagram-v2\n[*] --> Still\nStill --> Moving : push\nMoving --> Still\nMoving --> Crash\nCrash --> [*]",
    );
    expect(labels(svg).filter(Boolean)).toEqual(["Still", "Moving", "Crash"]);
    expect(edgeCount(svg)).toBe(5);
    expect(edgeLabels(svg)).toEqual(["push"]);
  });

  test("状态图的复合状态画成框", () => {
    const svg = renderMermaidToSvg(
      "stateDiagram-v2\nstate 处理中 {\n[*] --> 校验\n校验 --> 计算\n}\n[*] --> 校验",
    );
    expect(svg).toContain('class="cb-mermaid-subgraph"');
    expect(svg).toContain(">处理中</text>");
  });

  test("时序图、饼图照旧", () => {
    expect(
      renderMermaidToSvg("sequenceDiagram\nA->>B: hi\nB-->>A: yo"),
    ).toContain(">hi</text>");
    expect(renderMermaidToSvg('pie\n"a": 1\n"b": 2')).toContain("a (33%)");
  });
});

test("wrapLabel：按宽度折行，单个超长词硬断", () => {
  expect(wrapLabel("short")).toEqual(["short"]);
  expect(wrapLabel("a\nb")).toEqual(["a", "b"]);
  const lines = wrapLabel("x".repeat(80), 100);
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines) expect(l.length * 8.2).toBeLessThanOrEqual(100);
  // 在空格处断行时文字不丢：拼回去和原文一样。
  const words = "the quick brown fox jumps over the lazy dog again and again";
  const wrapped = wrapLabel(words, 90);
  expect(wrapped.length).toBeGreaterThan(1);
  expect(wrapped.join("")).toBe(words);
});

describe("流式中的 Mermaid 卡片", () => {
  test("结尾 ``` 没到时标记为未闭合（卡片先显示代码，不画半张图）", async () => {
    const { parseArtifactFence } = await import(
      "../src/components/chat/bot-bubbles"
    );
    const partial = parseArtifactFence("```mermaid\ngraph TD\nA --> B\nB -->");
    expect(partial?.lang).toBe("mermaid");
    expect(partial?.closed).toBe(false);
    const done = parseArtifactFence("```mermaid\ngraph TD\nA --> B\n```\n");
    expect(done?.closed).toBe(true);
    expect(done?.code).toBe("graph TD\nA --> B");
  });
});
