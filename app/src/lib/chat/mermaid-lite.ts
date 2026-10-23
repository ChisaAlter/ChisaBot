/**
 * 轻量零依赖 Mermaid → SVG 渲染引擎（离线可用，支持 flowchart/graph、sequenceDiagram、stateDiagram、pie）。
 */

type NodeShape = "rect" | "round" | "stadium" | "diamond" | "circle";

type GraphNode = {
  id: string;
  label: string;
  shape: NodeShape;
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
};

function escXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function measureTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += ch.charCodeAt(0) > 255 ? 14.5 : 8.2;
  }
  return Math.max(68, Math.min(240, Math.ceil(width + 32)));
}

function parseNodeToken(raw: string): { id: string; label?: string; shape?: NodeShape } {
  const s = raw.trim();
  // id(["label"]) or id([label])
  let m = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\(\[\s*"?([^"\]]*?)"?\s*\]\)$/.exec(s);
  if (m) return { id: m[1]!, label: m[2]!.trim(), shape: "stadium" };
  // id(("label"))
  m = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\(\(\s*"?([^")]*?)"?\s*\)\)$/.exec(s);
  if (m) return { id: m[1]!, label: m[2]!.trim(), shape: "circle" };
  // id{"label"} or id{label}
  m = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\{\s*"?([^"}]*?)"?\s*\}$/.exec(s);
  if (m) return { id: m[1]!, label: m[2]!.trim(), shape: "diamond" };
  // id("label") or id(label)
  m = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\(\s*"?([^")]*?)"?\s*\)$/.exec(s);
  if (m) return { id: m[1]!, label: m[2]!.trim(), shape: "round" };
  // id["label"] or id[label]
  m = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\[\s*"?([^"\]]*?)"?\s*\]$/.exec(s);
  if (m) return { id: m[1]!, label: m[2]!.trim(), shape: "rect" };
  // [*] for stateDiagram
  if (s === "[*]") return { id: "__star__", label: "●", shape: "circle" };
  return { id: s.replace(/^["']|["']$/g, "") };
}

function renderFlowchartSvg(lines: string[], dir: "TD" | "LR" | "BT" | "RL"): string {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const ensureNode = (token: string, isEndStar = false): string => {
    const parsed = parseNodeToken(token);
    const id = parsed.id === "__star__" && isEndStar ? "__star_end__" : parsed.id;
    const existing = nodes.get(id);
    const label = parsed.label ?? existing?.label ?? (id.startsWith("__star") ? "●" : id);
    const shape = parsed.shape ?? existing?.shape ?? "round";
    const w = shape === "circle" ? 44 : measureTextWidth(label);
    const h = shape === "diamond" ? 54 : 42;
    nodes.set(id, {
      id,
      label,
      shape,
      rank: existing?.rank ?? 0,
      order: existing?.order ?? nodes.size,
      x: 0,
      y: 0,
      w,
      h,
    });
    return id;
  };

  const edgeRegex =
    /^(.+?)\s*(?:(-->|==>|-\.->|--o|--x|-->\|[^|]*\||--\s*[^-]+\s*-->|-\.\s*[^.]+\s*\.->|==\s*[^=]+\s*==>))\s*(.+)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/;$/, "");
    if (!line || line.startsWith("%%")) continue;
    if (/^(flowchart|graph|stateDiagram(?:-v2)?|subgraph|end|direction|classDef|class|style|linkStyle)\b/i.test(line)) {
      continue;
    }
    // stateDiagram "StateA : Description"
    const stateDesc = /^([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*:\s*(.+)$/.exec(line);
    if (stateDesc && !line.includes("-->")) {
      ensureNode(`${stateDesc[1]}[${stateDesc[2]}]`);
      continue;
    }

    const m = edgeRegex.exec(line);
    if (m) {
      const leftRaw = m[1]!.trim();
      const op = m[2]!.trim();
      let rightRaw = m[3]!.trim();
      let label: string | undefined;

      // Check `-->|label| B` or `-- label --> B`
      const pipeMatch = /^(-->|==>|-\.->)\|([^|]*)\|$/.exec(op);
      if (pipeMatch) {
        label = pipeMatch[2]!.trim();
      } else if (op.startsWith("--") && op.endsWith("-->") && op.length > 5) {
        label = op.slice(2, -3).trim();
      } else if (op.startsWith("-.") && op.endsWith(".->") && op.length > 5) {
        label = op.slice(2, -3).trim();
      } else if (op.startsWith("==") && op.endsWith("==>") && op.length > 5) {
        label = op.slice(2, -3).trim();
      }

      // Also support `A --> B : label` (stateDiagram style)
      const colonLabel = /^(.+?)\s*:\s*(.+)$/.exec(rightRaw);
      if (colonLabel && !rightRaw.endsWith("]") && !rightRaw.endsWith(")") && !rightRaw.endsWith("}")) {
        rightRaw = colonLabel[1]!.trim();
        label = colonLabel[2]!.trim();
      }

      const fromId = ensureNode(leftRaw, false);
      const toId = ensureNode(rightRaw, true);
      edges.push({
        from: fromId,
        to: toId,
        label,
        dashed: op.includes("."),
        thick: op.includes("="),
      });
      continue;
    }

    // Standalone node declaration
    if (/^[A-Za-z0-9_.\-\u4e00-\u9fa5]+[\[(/{]/.test(line)) {
      ensureNode(line);
    }
  }

  if (nodes.size === 0) {
    return "";
  }

  // Assign ranks via longest-path BFS
  const inDegree = new Map<string, number>();
  for (const id of nodes.keys()) inDegree.set(id, 0);
  for (const e of edges) {
    if (e.from !== e.to) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  if (queue.length === 0) {
    const first = nodes.keys().next().value;
    if (first) queue.push(first);
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visited.add(cur);
    const curNode = nodes.get(cur)!;
    for (const e of edges) {
      if (e.from === cur && e.to !== cur) {
        const nextNode = nodes.get(e.to);
        if (nextNode) {
          if (nextNode.rank < curNode.rank + 1 && curNode.rank < 12) {
            nextNode.rank = curNode.rank + 1;
          }
          if (!visited.has(e.to) && !queue.includes(e.to)) {
            queue.push(e.to);
          }
        }
      }
    }
  }

  // Group nodes by rank
  const ranks = new Map<number, GraphNode[]>();
  for (const n of nodes.values()) {
    const list = ranks.get(n.rank) ?? [];
    list.push(n);
    ranks.set(n.rank, list);
  }

  const sortedRanks = Array.from(ranks.keys()).sort((a, b) => a - b);
  const isHorizontal = dir === "LR" || dir === "RL";

  const padX = 32;
  const padY = 28;
  const rankGap = isHorizontal ? 208 : 88;
  const nodeGap = isHorizontal ? 28 : 32;

  let maxSpan = 0;
  for (const r of sortedRanks) {
    const list = ranks.get(r)!;
    const span = list.reduce((acc, n) => acc + (isHorizontal ? n.h : n.w), 0) + Math.max(0, list.length - 1) * nodeGap;
    if (span > maxSpan) maxSpan = span;
  }

  for (let ri = 0; ri < sortedRanks.length; ri++) {
    const r = sortedRanks[ri]!;
    const rankIdx = dir === "BT" || dir === "RL" ? sortedRanks.length - 1 - ri : ri;
    const list = ranks.get(r)!;
    const span = list.reduce((acc, n) => acc + (isHorizontal ? n.h : n.w), 0) + Math.max(0, list.length - 1) * nodeGap;
    let cursor = padX + (maxSpan - span) / 2;

    for (const n of list) {
      if (isHorizontal) {
        n.x = padX + rankIdx * rankGap + n.w / 2;
        n.y = cursor + n.h / 2;
        cursor += n.h + nodeGap;
      } else {
        n.x = cursor + n.w / 2;
        n.y = padY + rankIdx * rankGap + n.h / 2;
        cursor += n.w + nodeGap;
      }
    }
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of nodes.values()) {
    maxX = Math.max(maxX, n.x + n.w / 2 + padX);
    maxY = Math.max(maxY, n.y + n.h / 2 + padY);
  }
  const width = Math.max(320, Math.ceil(maxX));
  const height = Math.max(140, Math.ceil(maxY));

  const edgeSvg: string[] = [];
  for (const e of edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;

    let x1 = a.x;
    let y1 = a.y;
    let x2 = b.x;
    let y2 = b.y;
    if (isHorizontal) {
      const sign = b.x >= a.x ? 1 : -1;
      x1 = a.x + (sign * a.w) / 2;
      x2 = b.x - (sign * (b.w + 10)) / 2;
    } else {
      const sign = b.y >= a.y ? 1 : -1;
      y1 = a.y + (sign * a.h) / 2;
      y2 = b.y - (sign * (b.h + 10)) / 2;
    }

    const cx1 = isHorizontal ? (x1 + x2) / 2 : x1;
    const cy1 = isHorizontal ? y1 : (y1 + y2) / 2;
    const cx2 = isHorizontal ? (x1 + x2) / 2 : x2;
    const cy2 = isHorizontal ? y2 : (y1 + y2) / 2;

    const dashAttr = e.dashed ? ` stroke-dasharray="5 4"` : "";
    const strokeW = e.thick ? "2.4" : "1.75";
    edgeSvg.push(
      `<path d="M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}" fill="none" stroke="var(--cb-mermaid-edge, #8b95a7)" stroke-width="${strokeW}"${dashAttr} marker-end="url(#cb-arrow)" />`,
    );

    if (e.label) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const lw = Math.max(36, measureTextWidth(e.label) - 14);
      edgeSvg.push(
        `<rect x="${mx - lw / 2}" y="${my - 11}" width="${lw}" height="22" rx="6" fill="var(--cb-mermaid-pill-bg, rgba(24,26,32,0.92))" stroke="var(--cb-mermaid-border, rgba(255,255,255,0.14))" stroke-width="1" />`,
        `<text x="${mx}" y="${my + 4}" text-anchor="middle" fill="var(--cb-mermaid-muted, #cbd5e1)" font-size="11.5" font-family="system-ui, -apple-system, sans-serif">${escXml(e.label)}</text>`,
      );
    }
  }

  const nodeSvg: string[] = [];
  for (const n of nodes.values()) {
    const x = n.x - n.w / 2;
    const y = n.y - n.h / 2;
    let shapeEl = "";
    if (n.shape === "diamond") {
      const pts = `${n.x},${y - 4} ${x + n.w + 6},${n.y} ${n.x},${y + n.h + 4} ${x - 6},${n.y}`;
      shapeEl = `<polygon points="${pts}" fill="var(--cb-mermaid-node-bg, rgba(38,43,56,0.95))" stroke="var(--cb-mermaid-node-border, rgba(129,140,248,0.55))" stroke-width="1.6" />`;
    } else if (n.shape === "circle") {
      const r = Math.max(n.w, n.h) / 2;
      shapeEl = `<circle cx="${n.x}" cy="${n.y}" r="${r}" fill="var(--cb-mermaid-node-bg, rgba(38,43,56,0.95))" stroke="var(--cb-mermaid-node-border, rgba(129,140,248,0.55))" stroke-width="1.6" />`;
    } else {
      const rx = n.shape === "stadium" ? n.h / 2 : n.shape === "round" ? 11 : 6;
      shapeEl = `<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${rx}" fill="var(--cb-mermaid-node-bg, rgba(38,43,56,0.95))" stroke="var(--cb-mermaid-node-border, rgba(129,140,248,0.55))" stroke-width="1.6" />`;
    }
    nodeSvg.push(
      `<g class="cb-mermaid-node">${shapeEl}<text x="${n.x}" y="${n.y + 4.5}" text-anchor="middle" fill="var(--cb-mermaid-text, #f1f5f9)" font-size="13" font-weight="500" font-family="system-ui, -apple-system, sans-serif">${escXml(n.label)}</text></g>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px;height:auto;display:block;margin:0 auto;">
    <defs>
      <marker id="cb-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--cb-mermaid-edge, #8b95a7)" />
      </marker>
    </defs>
    ${edgeSvg.join("\n")}
    ${nodeSvg.join("\n")}
  </svg>`;
}

function renderSequenceSvg(lines: string[]): string {
  const participants: { id: string; label: string }[] = [];
  const pMap = new Map<string, number>();
  const messages: { from: number; to: number; text: string; dashed: boolean }[] = [];

  const ensureActor = (idRaw: string, labelRaw?: string): number => {
    const id = idRaw.trim();
    if (pMap.has(id)) return pMap.get(id)!;
    const idx = participants.length;
    participants.push({ id, label: (labelRaw ?? id).trim().replace(/^["']|["']$/g, "") });
    pMap.set(id, idx);
    return idx;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%") || /^sequenceDiagram\b/i.test(line)) continue;
    const pm = /^(?:participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (pm) {
      ensureActor(pm[1]!, pm[2]);
      continue;
    }
    const mm = /^([^\s\-:]+)\s*(-->>|->>|-->|->|--x|-x)\s*([^\s:]+)\s*:\s*(.*)$/.exec(line);
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
  const width = Math.max(340, padX * 2 + Math.max(0, participants.length - 1) * colGap + 90);
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
      if (Number.isFinite(val) && val > 0) slices.push({ label: m[1]!, value: val });
    }
  }
  if (slices.length === 0) return "";
  const total = slices.reduce((acc, s) => acc + s.value, 0);
  const palette = ["#818cf8", "#38bdf8", "#34d399", "#fbbf24", "#f472b6", "#a78bfa"];
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

export function renderMermaidToSvg(code: string): string {
  const lines = code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const first = lines[0] ?? "";
  if (/^sequenceDiagram\b/i.test(first)) {
    return renderSequenceSvg(lines);
  }
  if (/^pie\b/i.test(first)) {
    return renderPieSvg(lines);
  }
  const dirMatch = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.exec(first);
  const dir = (dirMatch?.[1]?.toUpperCase() === "TB" ? "TD" : (dirMatch?.[1]?.toUpperCase() as "TD" | "LR" | "BT" | "RL")) ?? "TD";
  return renderFlowchartSvg(lines, dir);
}
