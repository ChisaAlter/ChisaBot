/**
 * 轻量零依赖 Mermaid → SVG 渲染引擎（离线可用，支持 flowchart/graph、sequenceDiagram、stateDiagram、pie）。
 *
 * 认不出的图类型（gantt、classDiagram、erDiagram、mindmap…）或语法解析不了（括号没闭合、流式写到一半）时
 * 返回空串，卡片据此回退成代码块 —— 宁可显示源码，也不画一张错的图。
 */

type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "diamond"
  | "circle"
  | "hexagon";

type GraphNode = {
  id: string;
  label: string;
  lines: string[];
  shape: NodeShape;
  group: number;
  rank: number;
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

type GraphEdge = {
  from: string;
  to: string;
  label?: string | undefined;
  dashed?: boolean | undefined;
  thick?: boolean | undefined;
  invisible?: boolean | undefined;
  arrowEnd: boolean;
  arrowStart: boolean;
};

type Subgraph = { title: string; parent: number };

type FlowDir = "TD" | "LR" | "BT" | "RL";

type Graph = {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** 下标 0 是「不在任何 subgraph 里」。 */
  groups: Subgraph[];
};

/** 解析失败：调用方据此返回 ""，卡片回退成代码块。 */
class MermaidSyntaxError extends Error {}

const FONT = "system-ui, -apple-system, sans-serif";
const LABEL_MAX = 200;
const EDGE_LABEL_MAX = 150;
const LINE_H = 17;

function escXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function charWidth(ch: string): number {
  return ch.charCodeAt(0) > 255 ? 14.5 : 8.2;
}

function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

function measureTextWidth(text: string): number {
  return Math.max(68, Math.min(240, Math.ceil(textWidth(text) + 32)));
}

/** 按宽度折行：先按 `<br>` / 换行分段，西文按词、中文按字断；单个超长词硬断。 */
export function wrapLabel(text: string, max = LABEL_MAX): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const tokens = para.match(
      /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|[^\s\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+|\s+/g,
    ) ?? [""];
    let line = "";
    for (const token of tokens) {
      if (textWidth(line + token) <= max || line.trim() === "") {
        if (textWidth(token) > max) {
          for (const ch of token) {
            if (textWidth(line + ch) > max && line) {
              out.push(line.trimEnd());
              line = "";
            }
            line += ch;
          }
        } else {
          line += token;
        }
      } else {
        // 在空格处断开时行尾留一个空格：画出来看不见，但 <text> 的文字内容（复制、读屏）和原文一致。
        const brokeAtSpace = /^\s+$/.test(token) || /\s$/.test(line);
        out.push(brokeAtSpace ? `${line.trimEnd()} ` : line.trimEnd());
        line = /^\s+$/.test(token) ? "" : token;
      }
    }
    out.push(line.trimEnd());
  }
  while (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

function cleanLabel(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;/g, '"')
    .replace(/#amp;/g, "&")
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">")
    .replace(/^`|`$/g, "")
    .trim();
}

/** 一行里的多条语句可以用 `;` 隔开（引号和括号里的 `;` 不算）。 */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  for (const rawLine of code.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) continue;
    let depth = 0;
    let quote = false;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') quote = !quote;
      else if (quote) continue;
      else if (ch === "[" || ch === "(" || ch === "{") depth++;
      else if (ch === "]" || ch === ")" || ch === "}")
        depth = Math.max(0, depth - 1);
      else if (ch === ";" && depth === 0) {
        const part = line.slice(start, i).trim();
        if (part) out.push(part);
        start = i + 1;
      }
    }
    const rest = line.slice(start).trim();
    if (rest) out.push(rest);
  }
  return out;
}

const ID_RE = /[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/uy;
const SHAPES: Array<[string, string, NodeShape]> = [
  ["([", "])", "stadium"],
  ["((", "))", "circle"],
  ["[[", "]]", "rect"],
  ["[(", ")]", "round"],
  ["{{", "}}", "hexagon"],
  ["[/", "/]", "rect"],
  ["[/", "\\]", "rect"],
  ["[\\", "\\]", "rect"],
  ["[\\", "/]", "rect"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
  ["{", "}", "diamond"],
  [">", "]", "rect"],
];
/** 连线：`-->` `---` `-.->` `==>` `--o` `--x` `<-->` `~~~` 及加长写法。 */
const LINK_RE =
  /(?:<|[ox](?=[-=]))?(?:-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|-\.+-(?![ox]\b)|~{3,}|(?:--|==|-\.+-)[ox]\b)/uy;
/** 带文字的连线：`-- 文字 -->`、`-. 文字 .->`、`== 文字 ==>`。 */
const TEXT_LINK_RE =
  /(<)?(--|==|-\.)\s*([^\s\-=.>|][\s\S]*?)\s*(-{2,}>|-{3,}|={2,}>|={3,}|\.-+>|\.-+-|-{2,}[ox]|={2,}[ox])/y;

type NodeRef = { id: string; label?: string; shape?: NodeShape };
type Link = { op: string; label?: string };

class Scanner {
  pos = 0;
  constructor(readonly src: string) {}
  ws() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? ""))
      this.pos++;
  }
  done() {
    this.ws();
    return this.pos >= this.src.length;
  }
  sticky(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (m) this.pos = re.lastIndex;
    return m;
  }
  startsWith(s: string) {
    return this.src.startsWith(s, this.pos);
  }

  node(): NodeRef {
    this.ws();
    const m = this.sticky(ID_RE);
    if (!m) throw new MermaidSyntaxError(`expected node at ${this.pos}`);
    const ref: NodeRef = { id: m[0] };
    for (const [open, close, shape] of SHAPES) {
      if (!this.startsWith(open)) continue;
      // `A-->B` 里 B 后面紧跟的 `>` 不会出现；`A>文字]` 才是旗形节点。
      this.pos += open.length;
      let label: string;
      const quoteEnd =
        this.src[this.pos] === '"' ? this.src.indexOf('"', this.pos + 1) : -1;
      if (quoteEnd > 0 && this.src.startsWith(close, quoteEnd + 1)) {
        label = this.src.slice(this.pos + 1, quoteEnd);
        this.pos = quoteEnd + 1;
      } else {
        // 没配对的引号按普通文字处理，到闭合括号为止。
        const end = this.src.indexOf(close, this.pos);
        if (end < 0) throw new MermaidSyntaxError("unclosed shape");
        label = this.src.slice(this.pos, end);
        this.pos = end;
      }
      this.pos += close.length;
      ref.label = cleanLabel(label);
      ref.shape = shape;
      break;
    }
    this.sticky(/:::[\w-]+/y);
    return ref;
  }

  group(): NodeRef[] {
    const out = [this.node()];
    for (;;) {
      this.ws();
      if (!this.startsWith("&")) return out;
      this.pos++;
      out.push(this.node());
    }
  }

  link(): Link | null {
    this.ws();
    const plain = this.sticky(LINK_RE);
    if (plain) {
      const op = plain[0];
      this.ws();
      const pipe = this.sticky(/\|([^|]*)\|/y);
      return pipe ? { op, label: cleanLabel(pipe[1] ?? "") } : { op };
    }
    const text = this.sticky(TEXT_LINK_RE);
    if (text)
      return {
        op: `${text[1] ?? ""}${text[2]}${text[4]}`,
        label: cleanLabel(text[3] ?? ""),
      };
    return null;
  }
}

function edgeStyle(op: string): Omit<GraphEdge, "from" | "to" | "label"> {
  const invisible = op.includes("~");
  const end = op[op.length - 1];
  return {
    dashed: op.includes("."),
    thick: op.includes("="),
    invisible,
    arrowEnd: !invisible && (end === ">" || end === "o" || end === "x"),
    arrowStart: /^[<ox]/.test(op) && op.length > 3,
  };
}

class GraphBuilder {
  graph: Graph = {
    nodes: new Map(),
    edges: [],
    groups: [{ title: "", parent: -1 }],
  };
  stack: number[] = [0];

  get current() {
    return this.stack[this.stack.length - 1] ?? 0;
  }

  node(
    ref: NodeRef,
    fallbackLabel?: string,
    fallbackShape: NodeShape = "rect",
  ): string {
    const existing = this.graph.nodes.get(ref.id);
    const label = ref.label ?? existing?.label ?? fallbackLabel ?? ref.id;
    const shape = ref.shape ?? existing?.shape ?? fallbackShape;
    // 写在 subgraph 里的节点归这个 subgraph（之前在外面出现过也一样，和 Mermaid 一致）。
    const group = this.current !== 0 ? this.current : (existing?.group ?? 0);
    this.graph.nodes.set(ref.id, {
      id: ref.id,
      label,
      lines: [],
      shape,
      group,
      rank: 0,
      order: existing?.order ?? this.graph.nodes.size,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
    return ref.id;
  }

  open(title: string, id?: string) {
    this.graph.groups.push({ title, parent: this.current });
    const idx = this.graph.groups.length - 1;
    this.stack.push(idx);
    if (id) this.groupIds.set(id, idx);
  }
  groupIds = new Map<string, number>();

  close() {
    if (this.stack.length <= 1) throw new MermaidSyntaxError("unexpected end");
    this.stack.pop();
  }
}

function parseFlowchart(statements: string[]): Graph {
  const b = new GraphBuilder();
  for (const stmt of statements.slice(1)) {
    if (
      /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/.test(
        stmt,
      )
    )
      continue;
    const sub = /^subgraph\b\s*(.*)$/.exec(stmt);
    if (sub) {
      const rest = (sub[1] ?? "").trim();
      const titled = /^([\p{L}\p{N}_.-]+)\s*\[\s*"?(.*?)"?\s*\]$/u.exec(rest);
      if (titled) b.open(cleanLabel(titled[2] ?? ""), titled[1]);
      else b.open(cleanLabel(rest.replace(/^"(.*)"$/, "$1")), rest);
      continue;
    }
    if (stmt === "end") {
      b.close();
      continue;
    }
    const sc = new Scanner(stmt);
    let left = sc.group();
    for (const ref of left) b.node(ref);
    while (!sc.done()) {
      const link = sc.link();
      if (!link)
        throw new MermaidSyntaxError(`unexpected text: ${stmt.slice(sc.pos)}`);
      const right = sc.group();
      for (const ref of right) b.node(ref);
      const style = edgeStyle(link.op);
      for (const a of left) {
        for (const c of right)
          b.graph.edges.push({
            from: a.id,
            to: c.id,
            label: link.label || undefined,
            ...style,
          });
      }
      left = right;
    }
  }
  if (b.stack.length > 1) throw new MermaidSyntaxError("unclosed subgraph");
  return b.graph;
}

const STATE_ID = /^(\[\*\]|[\p{L}\p{N}_.-]+)$/u;

function parseStateDiagram(statements: string[]): Graph {
  const b = new GraphBuilder();
  let inNote = false;
  const stateNode = (raw: string, asTarget: boolean): string => {
    const token = raw.trim();
    if (!STATE_ID.test(token))
      throw new MermaidSyntaxError(`bad state ${token}`);
    if (token === "[*]") {
      const id = `__${asTarget ? "end" : "start"}_${b.current}__`;
      return b.node({ id, label: "", shape: "circle" });
    }
    return b.node({ id: token }, token, "round");
  };
  for (const stmt of statements.slice(1)) {
    if (inNote) {
      if (/^end\s+note$/i.test(stmt)) inNote = false;
      continue;
    }
    if (/^note\b/i.test(stmt)) {
      if (!stmt.includes(":")) inNote = true;
      continue;
    }
    if (/^(direction|classDef|class|style)\b/.test(stmt) || stmt === "--")
      continue;
    let m = /^state\s+"([^"]*)"\s+as\s+([\p{L}\p{N}_.-]+)\s*(\{)?$/u.exec(stmt);
    if (m) {
      b.node({ id: m[2] ?? "", label: cleanLabel(m[1] ?? ""), shape: "round" });
      if (m[3]) b.open(cleanLabel(m[1] ?? ""), m[2]);
      continue;
    }
    m = /^state\s+([\p{L}\p{N}_.-]+)\s*(<<\w+>>)?\s*(\{)?$/u.exec(stmt);
    if (m) {
      const shape: NodeShape =
        m[2] && /choice/.test(m[2]) ? "diamond" : "round";
      if (m[3]) b.open(m[1] ?? "", m[1]);
      else b.node({ id: m[1] ?? "", shape }, m[1], shape);
      continue;
    }
    if (stmt === "}") {
      b.close();
      continue;
    }
    m = /^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.*))?$/.exec(stmt);
    if (m) {
      const from = stateNode(m[1] ?? "", false);
      const to = stateNode(m[2] ?? "", true);
      b.graph.edges.push({
        from,
        to,
        label: m[3] ? cleanLabel(m[3]) : undefined,
        arrowEnd: true,
        arrowStart: false,
      });
      continue;
    }
    m = /^([\p{L}\p{N}_.-]+)\s*:\s*(.+)$/u.exec(stmt);
    if (m) {
      b.node({ id: m[1] ?? "", label: cleanLabel(m[2] ?? ""), shape: "round" });
      continue;
    }
    if (STATE_ID.test(stmt)) {
      stateNode(stmt, false);
      continue;
    }
    throw new MermaidSyntaxError(`unknown state statement: ${stmt}`);
  }
  if (b.stack.length > 1) throw new MermaidSyntaxError("unclosed state block");
  // 复合状态本身也作为分组出现；去掉和分组同名、又没有连线的占位节点。
  for (const [id, gi] of b.groupIds) {
    const n = b.graph.nodes.get(id);
    if (n && !b.graph.edges.some((e) => e.from === id || e.to === id)) {
      b.graph.nodes.delete(id);
    } else if (n && n.group === gi) {
      n.group = b.graph.groups[gi]?.parent ?? 0;
    }
  }
  return b.graph;
}

/** 最长路径分层；回边（成环的那条）不参与，避免无限加深。 */
function assignRanks(graph: Graph) {
  const out = new Map<string, string[]>();
  for (const id of graph.nodes.keys()) out.set(id, []);
  for (const e of graph.edges) if (e.from !== e.to) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const order: string[] = [];
  const back = new Set<string>();
  const visit = (root: string) => {
    const stack: Array<[string, number]> = [[root, 0]];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const [v, i] = top;
      const next = out.get(v) ?? [];
      if (i < next.length) {
        top[1] = i + 1;
        const w = next[i] ?? "";
        const s = state.get(w);
        if (s === undefined) {
          state.set(w, 1);
          stack.push([w, 0]);
        } else if (s === 1) {
          back.add(`${v}\u0000${w}`);
        }
      } else {
        state.set(v, 2);
        order.push(v);
        stack.pop();
      }
    }
  };
  const ids = [...graph.nodes.keys()];
  const hasIncoming = new Set(
    graph.edges.filter((e) => e.from !== e.to).map((e) => e.to),
  );
  for (const id of ids) if (!hasIncoming.has(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);
  order.reverse();
  for (const v of order) {
    const node = graph.nodes.get(v);
    if (!node) continue;
    for (const w of out.get(v) ?? []) {
      if (back.has(`${v}\u0000${w}`)) continue;
      const target = graph.nodes.get(w);
      if (target && target.rank < node.rank + 1) target.rank = node.rank + 1;
    }
  }
}

function sizeNode(n: GraphNode) {
  n.lines =
    n.shape === "circle" && n.label === ""
      ? []
      : wrapLabel(n.label, n.shape === "diamond" ? LABEL_MAX - 40 : LABEL_MAX);
  const textW = Math.max(0, ...n.lines.map((l) => textWidth(l.trimEnd())));
  const textH = Math.max(1, n.lines.length) * LINE_H;
  if (n.shape === "circle") {
    const d =
      n.lines.length === 0
        ? 22
        : Math.max(44, Math.ceil(Math.hypot(textW + 16, textH + 12)));
    n.w = d;
    n.h = d;
  } else if (n.shape === "diamond") {
    n.w = Math.max(80, Math.ceil(textW * 1.4 + 36));
    n.h = Math.max(54, Math.ceil(textH * 1.7 + 24));
  } else {
    n.w = Math.max(68, Math.ceil(textW + 32));
    n.h = Math.max(42, textH + 25);
  }
}

/** 顶层分组（嵌套的 subgraph 归到最外层那一条带里，各自仍画框）。 */
function laneOf(graph: Graph, group: number): number {
  let g = group;
  for (;;) {
    const parent = graph.groups[g]?.parent ?? 0;
    if (parent <= 0) return g;
    g = parent;
  }
}

function svgText(x: number, y: number, lines: string[], attrs: string): string {
  if (lines.length === 0) return "";
  const top = y - ((lines.length - 1) * LINE_H) / 2 + 4.5;
  const spans = lines
    .map(
      (line, i) =>
        `<tspan x="${x}" y="${top + i * LINE_H}">${escXml(line)}</tspan>`,
    )
    .join("");
  return `<text text-anchor="middle" ${attrs} font-family="${FONT}">${spans}</text>`;
}

function renderGraphSvg(graph: Graph, dir: FlowDir): string {
  const nodes = [...graph.nodes.values()];
  if (nodes.length === 0) return "";
  for (const n of nodes) sizeNode(n);
  assignRanks(graph);

  const horizontal = dir === "LR" || dir === "RL";
  const main = (n: GraphNode) => (horizontal ? n.w : n.h);
  const cross = (n: GraphNode) => (horizontal ? n.h : n.w);
  const pad = 28;
  const nodeGap = horizontal ? 26 : 30;
  const hasEdgeLabels = graph.edges.some((e) => e.label);
  const rankGap = horizontal
    ? hasEdgeLabels
      ? 96
      : 64
    : hasEdgeLabels
      ? 70
      : 56;
  const boxPad = 14;
  const titleBand = 24;
  const laneGap = 28;

  const maxRank = Math.max(0, ...nodes.map((n) => n.rank));
  // 每一层沿主轴的厚度取这一层最大的节点。
  const rankSize: number[] = Array.from({ length: maxRank + 1 }, () => 0);
  for (const n of nodes)
    rankSize[n.rank] = Math.max(rankSize[n.rank] ?? 0, main(n));
  const anyGroups = graph.groups.length > 1;
  // 相邻两层之间有带标签的连线时，层间距至少要放得下标签（两边各留一点线），免得标签压到节点上。
  const gapAfter: number[] = Array.from({ length: maxRank + 1 }, () => rankGap);
  for (const e of graph.edges) {
    if (!e.label || e.invisible) continue;
    const a = graph.nodes.get(e.from);
    const b = graph.nodes.get(e.to);
    if (!a || !b || Math.abs(a.rank - b.rank) !== 1) continue;
    const lines = wrapLabel(e.label, EDGE_LABEL_MAX);
    const pill = horizontal
      ? Math.max(
          28,
          Math.max(...lines.map((l) => textWidth(l.trimEnd()))) * 0.9 + 14,
        )
      : lines.length * LINE_H + 6;
    const r = Math.min(a.rank, b.rank);
    gapAfter[r] = Math.max(gapAfter[r] ?? rankGap, Math.ceil(pill + 36));
  }
  const rankStart: number[] = [];
  let cursor = pad + (anyGroups && !horizontal ? titleBand + boxPad : 0);
  for (let r = 0; r <= maxRank; r++) {
    rankStart[r] = cursor;
    cursor += (rankSize[r] ?? 0) + (r < maxRank ? (gapAfter[r] ?? rankGap) : 0);
  }
  const mainTotal = cursor + pad + (anyGroups ? boxPad : 0);

  // 分带：每个顶层 subgraph 一条带，不在 subgraph 里的节点一条带，按首次出现的顺序排。
  const laneIds: number[] = [];
  for (const n of [...nodes].sort((a, b) => a.order - b.order)) {
    const lane = laneOf(graph, n.group);
    if (!laneIds.includes(lane)) laneIds.push(lane);
  }

  // 层内排序：按首次出现，再按上一层父节点的平均位置调一遍，减少交叉。
  const cells = new Map<string, GraphNode[]>();
  const key = (lane: number, rank: number) => `${lane}:${rank}`;
  for (const n of [...nodes].sort((a, b) => a.order - b.order)) {
    const k = key(laneOf(graph, n.group), n.rank);
    const list = cells.get(k) ?? [];
    list.push(n);
    cells.set(k, list);
  }
  const position = new Map<string, number>();
  for (let r = 0; r <= maxRank; r++) {
    for (const lane of laneIds) {
      const list = cells.get(key(lane, r));
      if (!list) continue;
      if (r > 0) {
        const score = (n: GraphNode) => {
          const parents = graph.edges
            .filter((e) => e.to === n.id && position.has(e.from))
            .map((e) => position.get(e.from) ?? 0);
          return parents.length > 0
            ? parents.reduce((a, b) => a + b, 0) / parents.length
            : Number.POSITIVE_INFINITY;
        };
        const scored = list.map((n, i) => ({ n, s: score(n), i }));
        scored.sort((a, b) => (a.s === b.s ? a.i - b.i : a.s - b.s));
        list.splice(0, list.length, ...scored.map((x) => x.n));
      }
      list.forEach((n, i) => {
        position.set(n.id, i);
      });
    }
  }

  let crossCursor = pad;
  const laneBox = new Map<number, { start: number; size: number }>();
  for (const lane of laneIds) {
    const boxed = lane !== 0;
    let span = 0;
    for (let r = 0; r <= maxRank; r++) {
      const list = cells.get(key(lane, r)) ?? [];
      const s =
        list.reduce((acc, n) => acc + cross(n), 0) +
        Math.max(0, list.length - 1) * nodeGap;
      span = Math.max(span, s);
    }
    const title = graph.groups[lane]?.title ?? "";
    if (boxed) span = Math.max(span, textWidth(title) + 12);
    const lead = boxed ? boxPad + (horizontal ? titleBand : 0) : 0;
    const trail = boxed ? boxPad : 0;
    const start = crossCursor + lead;
    for (let r = 0; r <= maxRank; r++) {
      const list = cells.get(key(lane, r)) ?? [];
      const s =
        list.reduce((acc, n) => acc + cross(n), 0) +
        Math.max(0, list.length - 1) * nodeGap;
      let c = start + (span - s) / 2;
      for (const n of list) {
        const mainPos = (rankStart[r] ?? 0) + (rankSize[r] ?? 0) / 2;
        const crossPos = c + cross(n) / 2;
        if (horizontal) {
          n.x = mainPos;
          n.y = crossPos;
        } else {
          n.x = crossPos;
          n.y = mainPos;
        }
        c += cross(n) + nodeGap;
      }
    }
    laneBox.set(lane, { start: crossCursor, size: lead + span + trail });
    crossCursor += lead + span + trail + laneGap;
  }
  const crossTotal = crossCursor - laneGap + pad;

  if (dir === "BT" || dir === "RL") {
    for (const n of nodes) {
      if (horizontal) n.x = mainTotal - n.x;
      else n.y = mainTotal - n.y;
    }
  }

  const width = Math.max(320, Math.ceil(horizontal ? mainTotal : crossTotal));
  const height = Math.max(140, Math.ceil(horizontal ? crossTotal : mainTotal));

  // subgraph 框：框住组内（含嵌套）所有节点；顶层的框在主轴方向上取带宽。
  const boxSvg: string[] = [];
  for (let gi = graph.groups.length - 1; gi >= 1; gi--) {
    const members = nodes.filter((n) => {
      let g = n.group;
      while (g > 0) {
        if (g === gi) return true;
        g = graph.groups[g]?.parent ?? 0;
      }
      return false;
    });
    const title = graph.groups[gi]?.title ?? "";
    if (members.length === 0) continue;
    let x1 = Math.min(...members.map((n) => n.x - n.w / 2)) - boxPad;
    let y1 =
      Math.min(...members.map((n) => n.y - n.h / 2)) - boxPad - titleBand;
    let x2 = Math.max(...members.map((n) => n.x + n.w / 2)) + boxPad;
    let y2 = Math.max(...members.map((n) => n.y + n.h / 2)) + boxPad;
    const lane = laneBox.get(gi);
    if (lane && graph.groups[gi]?.parent === 0) {
      if (horizontal) {
        y1 = lane.start;
        y2 = lane.start + lane.size;
      } else {
        x1 = lane.start;
        x2 = lane.start + lane.size;
      }
    }
    x2 = Math.max(x2, x1 + textWidth(title) + 20);
    boxSvg.push(
      `<g class="cb-mermaid-subgraph"><rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" rx="10" fill="var(--cb-mermaid-group-bg, rgba(129,140,248,0.06))" stroke="var(--cb-mermaid-border, rgba(255,255,255,0.14))" stroke-width="1" stroke-dasharray="4 3" />` +
        (title
          ? `<text x="${x1 + 10}" y="${y1 + 17}" fill="var(--cb-mermaid-group-title, #8b95a7)" font-size="12" font-weight="600" font-family="${FONT}">${escXml(title)}</text>`
          : "") +
        "</g>",
    );
  }

  const edgeSvg: string[] = [];
  for (const e of graph.edges) {
    const a = graph.nodes.get(e.from);
    const b = graph.nodes.get(e.to);
    if (!a || !b || e.invisible) continue;
    let x1 = a.x;
    let y1 = a.y;
    let x2 = b.x;
    let y2 = b.y;
    const along = horizontal
      ? Math.abs(b.x - a.x) > 1
      : Math.abs(b.y - a.y) > 1;
    const endGap = e.arrowEnd ? 5 : 0;
    const startGap = e.arrowStart ? 5 : 0;
    let curveMain: boolean;
    if (a === b) {
      // 自环：从节点一侧绕出去再回来。
      const r = 18;
      const sx = a.x + a.w / 2;
      edgeSvg.push(
        `<path d="M ${sx} ${a.y - 8} C ${sx + r * 2} ${a.y - 26}, ${sx + r * 2} ${a.y + 26}, ${sx + endGap} ${a.y + 8}" fill="none" stroke="var(--cb-mermaid-edge, #8b95a7)" stroke-width="${e.thick ? "2.4" : "1.75"}"${e.dashed ? ` stroke-dasharray="5 4"` : ""}${e.arrowEnd ? ` marker-end="url(#cb-arrow)"` : ""} />`,
      );
      continue;
    }
    if (along) {
      curveMain = true;
      if (horizontal) {
        const sign = b.x >= a.x ? 1 : -1;
        x1 = a.x + sign * (a.w / 2 + startGap);
        x2 = b.x - sign * (b.w / 2 + endGap);
      } else {
        const sign = b.y >= a.y ? 1 : -1;
        y1 = a.y + sign * (a.h / 2 + startGap);
        y2 = b.y - sign * (b.h / 2 + endGap);
      }
    } else {
      // 同一层：沿交叉轴连到侧边。
      curveMain = false;
      if (horizontal) {
        const sign = b.y >= a.y ? 1 : -1;
        y1 = a.y + sign * (a.h / 2 + startGap);
        y2 = b.y - sign * (b.h / 2 + endGap);
      } else {
        const sign = b.x >= a.x ? 1 : -1;
        x1 = a.x + sign * (a.w / 2 + startGap);
        x2 = b.x - sign * (b.w / 2 + endGap);
      }
    }
    const alongX = horizontal === curveMain;
    const cx1 = alongX ? (x1 + x2) / 2 : x1;
    const cy1 = alongX ? y1 : (y1 + y2) / 2;
    const cx2 = alongX ? (x1 + x2) / 2 : x2;
    const cy2 = alongX ? y2 : (y1 + y2) / 2;
    const dashAttr = e.dashed ? ` stroke-dasharray="5 4"` : "";
    const strokeW = e.thick ? "2.4" : "1.75";
    const markers = `${e.arrowEnd ? ` marker-end="url(#cb-arrow)"` : ""}${e.arrowStart ? ` marker-start="url(#cb-arrow)"` : ""}`;
    edgeSvg.push(
      `<path d="M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" fill="none" stroke="var(--cb-mermaid-edge, #8b95a7)" stroke-width="${strokeW}"${dashAttr}${markers} />`,
    );
    if (e.label) {
      const lines = wrapLabel(e.label, EDGE_LABEL_MAX);
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const lw = Math.max(
        28,
        Math.max(...lines.map((l) => textWidth(l.trimEnd()))) * 0.9 + 14,
      );
      const lh = lines.length * LINE_H + 6;
      edgeSvg.push(
        `<rect x="${mx - lw / 2}" y="${my - lh / 2}" width="${lw}" height="${lh}" rx="6" fill="var(--cb-mermaid-pill-bg, rgba(24,26,32,0.92))" stroke="var(--cb-mermaid-border, rgba(255,255,255,0.14))" stroke-width="1" />`,
        svgText(
          mx,
          my - 1,
          lines,
          `fill="var(--cb-mermaid-muted, #cbd5e1)" font-size="11.5"`,
        ),
      );
    }
  }

  const fill = `fill="var(--cb-mermaid-node-bg, rgba(38,43,56,0.95))" stroke="var(--cb-mermaid-node-border, rgba(129,140,248,0.55))" stroke-width="1.6"`;
  const nodeSvg: string[] = [];
  for (const n of nodes) {
    const x = n.x - n.w / 2;
    const y = n.y - n.h / 2;
    let shapeEl: string;
    if (n.shape === "diamond") {
      shapeEl = `<polygon points="${n.x},${y} ${x + n.w},${n.y} ${n.x},${y + n.h} ${x},${n.y}" ${fill} />`;
    } else if (n.shape === "hexagon") {
      const k = Math.min(16, n.h / 2);
      shapeEl = `<polygon points="${x + k},${y} ${x + n.w - k},${y} ${x + n.w},${n.y} ${x + n.w - k},${y + n.h} ${x + k},${y + n.h} ${x},${n.y}" ${fill} />`;
    } else if (n.shape === "circle") {
      // 状态图的起止点（[*]）是实心小圆点。
      shapeEl =
        n.lines.length === 0
          ? `<circle cx="${n.x}" cy="${n.y}" r="${n.w / 2}" fill="var(--cb-mermaid-edge, #8b95a7)" />`
          : `<circle cx="${n.x}" cy="${n.y}" r="${n.w / 2}" ${fill} />`;
    } else {
      const rx = n.shape === "stadium" ? n.h / 2 : n.shape === "round" ? 11 : 6;
      shapeEl = `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${rx}" ${fill} />`;
    }
    nodeSvg.push(
      `<g class="cb-mermaid-node">${shapeEl}${svgText(n.x, n.y, n.lines, `fill="var(--cb-mermaid-text, #f1f5f9)" font-size="13" font-weight="500"`)}</g>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto;display:block;margin:0 auto;">
    <defs>
      <marker id="cb-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--cb-mermaid-edge, #8b95a7)" />
      </marker>
    </defs>
    ${boxSvg.join("\n")}
    ${edgeSvg.join("\n")}
    ${nodeSvg.join("\n")}
  </svg>`;
}

function renderSequenceSvg(lines: string[]): string {
  const participants: { id: string; label: string }[] = [];
  const pMap = new Map<string, number>();
  const messages: {
    from: number;
    to: number;
    text: string;
    dashed: boolean;
  }[] = [];

  const ensureActor = (idRaw: string, labelRaw?: string): number => {
    const id = idRaw.trim();
    if (pMap.has(id)) return pMap.get(id)!;
    const idx = participants.length;
    participants.push({
      id,
      label: (labelRaw ?? id).trim().replace(/^["']|["']$/g, ""),
    });
    pMap.set(id, idx);
    return idx;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%") || /^sequenceDiagram\b/i.test(line))
      continue;
    const pm = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(
      line,
    );
    if (pm) {
      ensureActor(pm[1]!, pm[2]);
      continue;
    }
    const mm =
      /^([^\s\-:]+)\s*(-->>|->>|-->|->|--x|-x)\s*([^\s:]+)\s*:\s*(.*)$/.exec(
        line,
      );
    if (mm) {
      const from = ensureActor(mm[1]!);
      const to = ensureActor(mm[3]!);
      messages.push({
        from,
        to,
        text: mm[4]!.trim(),
        dashed: mm[2]!.startsWith("--"),
      });
    }
  }

  if (participants.length === 0) return "";

  const colGap = 165;
  const padX = 76;
  const topY = 26;
  const boxH = 38;
  const rowGap = 52;
  const width = Math.max(
    340,
    padX * 2 + Math.max(0, participants.length - 1) * colGap + 90,
  );
  const height = topY + boxH + messages.length * rowGap + 56;

  const actorX = (i: number) => padX + 45 + i * colGap;

  const lifelines = participants.map((p, i) => {
    const cx = actorX(i);
    const w = Math.max(88, Math.min(144, measureTextWidth(p.label)));
    return `
      <line x1="${cx}" y1="${topY + boxH}" x2="${cx}" y2="${height - 24}" stroke="var(--cb-mermaid-border, rgba(255,255,255,0.16))" stroke-width="1.5" stroke-dasharray="4 4" />
      <rect x="${cx - w / 2}" y="${topY}" width="${w}" height="${boxH}" rx="9" fill="var(--cb-mermaid-node-bg, rgba(38,43,56,0.95))" stroke="var(--cb-mermaid-node-border, rgba(129,140,248,0.55))" stroke-width="1.6" />
      <text x="${cx}" y="${topY + 24}" text-anchor="middle" fill="var(--cb-mermaid-text, #f1f5f9)" font-size="13" font-weight="600" font-family="system-ui, -apple-system, sans-serif">${escXml(p.label)}</text>
    `;
  });

  const msgEls = messages.map((m, idx) => {
    const y = topY + boxH + 36 + idx * rowGap;
    const x1 = actorX(m.from);
    const x2 = actorX(m.to);
    const dash = m.dashed ? ` stroke-dasharray="5 4"` : "";
    if (m.from === m.to) {
      return `
        <path d="M ${x1} ${y - 8} H ${x1 + 36} V ${y + 12} H ${x1 + 6}" fill="none" stroke="var(--cb-mermaid-edge, #8b95a7)" stroke-width="1.6"${dash} marker-end="url(#cb-seq-arrow)" />
        <text x="${x1 + 42}" y="${y + 4}" fill="var(--cb-mermaid-muted, #cbd5e1)" font-size="12" font-family="system-ui, -apple-system, sans-serif">${escXml(m.text)}</text>
      `;
    }
    const dir = x2 > x1 ? 1 : -1;
    return `
      <line x1="${x1}" y1="${y}" x2="${x2 - dir * 6}" y2="${y}" stroke="var(--cb-mermaid-edge, #8b95a7)" stroke-width="1.7"${dash} marker-end="url(#cb-seq-arrow)" />
      <text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle" fill="var(--cb-mermaid-muted, #cbd5e1)" font-size="12" font-family="system-ui, -apple-system, sans-serif">${escXml(m.text)}</text>
    `;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto;display:block;margin:0 auto;">
    <defs>
      <marker id="cb-seq-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--cb-mermaid-edge, #8b95a7)" />
      </marker>
    </defs>
    ${lifelines.join("\n")}
    ${msgEls.join("\n")}
  </svg>`;
}

function renderPieSvg(lines: string[]): string {
  const slices: { label: string; value: number }[] = [];
  for (const rawLine of lines) {
    const m = /^"([^"]+)"\s*:\s*([0-9.]+)$/.exec(rawLine.trim());
    if (m) {
      const val = Number.parseFloat(m[2]!);
      if (Number.isFinite(val) && val > 0)
        slices.push({ label: m[1]!, value: val });
    }
  }
  if (slices.length === 0) return "";
  const total = slices.reduce((acc, s) => acc + s.value, 0);
  const palette = [
    "#818cf8",
    "#38bdf8",
    "#34d399",
    "#fbbf24",
    "#f472b6",
    "#a78bfa",
  ];
  const cx = 100;
  const cy = 96;
  const r = 68;
  let angle = -Math.PI / 2;

  const paths = slices.map((s, i) => {
    const frac = s.value / total;
    const nextAngle = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(nextAngle);
    const y2 = cy + r * Math.sin(nextAngle);
    const largeArc = frac > 0.5 ? 1 : 0;
    angle = nextAngle;
    const color = palette[i % palette.length];
    return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${color}" stroke="rgba(15,23,42,0.8)" stroke-width="2" />`;
  });

  const legends = slices.map((s, i) => {
    const ly = 36 + i * 24;
    const pct = Math.round((s.value / total) * 100);
    const color = palette[i % palette.length];
    return `
      <rect x="200" y="${ly - 10}" width="12" height="12" rx="3" fill="${color}" />
      <text x="220" y="${ly}" fill="var(--cb-mermaid-text, #f1f5f9)" font-size="12.5" font-family="system-ui, -apple-system, sans-serif">${escXml(s.label)} (${pct}%)</text>
    `;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 192" width="100%" style="max-width:380px;height:auto;display:block;margin:0 auto;">
    ${paths.join("\n")}
    <circle cx="${cx}" cy="${cy}" r="30" fill="var(--cb-mermaid-node-bg, #181a20)" />
    ${legends.join("\n")}
  </svg>`;
}

/** 图头之后、正文之前的 `direction LR` 之类（状态图用）。 */
function bodyDirection(statements: string[]): FlowDir | null {
  for (const stmt of statements.slice(1)) {
    const m = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(stmt);
    if (m) return normalizeDir(m[1]);
    if (/^(state\b|subgraph\b)/.test(stmt)) return null;
  }
  return null;
}

function normalizeDir(raw: string | undefined): FlowDir {
  const d = (raw ?? "TD").toUpperCase();
  return d === "TB" ? "TD" : (d as FlowDir);
}

/**
 * 渲染成内联 SVG 字符串；认不出图类型、语法解析不了或什么都没画出来时返回 ""（调用方回退成代码块）。
 */
export function renderMermaidToSvg(code: string): string {
  const statements = splitStatements(code);
  const first = statements[0] ?? "";
  if (!first) return "";
  try {
    if (/^sequenceDiagram\b/i.test(first)) {
      const lines = code
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return renderSequenceSvg(lines);
    }
    if (/^pie\b/i.test(first)) {
      const lines = code
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      return renderPieSvg(lines);
    }
    const flow = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?$/i.exec(first);
    if (flow)
      return renderGraphSvg(parseFlowchart(statements), normalizeDir(flow[1]));
    if (/^stateDiagram(?:-v2)?$/i.test(first)) {
      return renderGraphSvg(
        parseStateDiagram(statements),
        bodyDirection(statements) ?? "TD",
      );
    }
    // gantt、classDiagram、erDiagram、mindmap、journey… 不认识的一律不画。
    return "";
  } catch (error) {
    if (error instanceof MermaidSyntaxError) return "";
    throw error;
  }
}
