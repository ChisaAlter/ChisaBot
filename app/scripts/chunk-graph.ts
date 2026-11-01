/**
 * 构建产物的块依赖检查（DESIGN.md §41.5）。手工分块（vite.config.ts 的 VENDOR_CHUNKS / shell / route-*）
 * 一不小心就会让块之间互相静态 import 成环：环里谁先执行，谁就可能读到还没初始化的导出（forwardRef of undefined）。
 * 另外设置页 / 管理页的首屏不该带上聊天才用的 CopilotKit 和 Markdown。
 *
 * 这里只看「块 → 块」的静态 import（动态 import 不算）；构建时由 chunkGuard 插件检查，出问题直接让构建失败，
 * tests/chunk-graph.test.ts 再对 dist/ 里的真实产物查一遍。
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin, Rollup } from "vite";
import { routePreloadMap } from "./route-preload";

export type ChunkNode = { name: string; imports: string[]; isEntry: boolean };
export type ChunkGraph = Map<string, ChunkNode>;

/** 首屏不许出现的块（按块名）。chat 组本来就要用，所以只限制这几组。 */
export const FIRST_SCREEN_FORBIDDEN: Record<string, string[]> = {
  settings: ["vendor-copilot", "vendor-markdown"],
  admin: ["vendor-copilot", "vendor-markdown"],
};

export function graphFromBundle(bundle: Rollup.OutputBundle): ChunkGraph {
  const graph: ChunkGraph = new Map();
  for (const c of Object.values(bundle)) {
    if (c.type !== "chunk") continue;
    graph.set(c.fileName, { name: c.name, imports: [...c.imports], isEntry: c.isEntry });
  }
  return graph;
}

/** 强连通分量里多于一个块的（或自己 import 自己的）就是环。返回每个环的块文件名。 */
export function findChunkCycles(graph: ChunkGraph): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v)?.imports ?? []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || graph.get(v)?.imports.includes(v)) cycles.push(scc.sort());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return cycles;
}

/** 某组首屏会下载执行的块：入口的静态闭包 + 这组预载的块（及其静态闭包）。 */
export function firstScreenChunks(graph: ChunkGraph, preload: string[]): Set<string> {
  const out = new Set<string>();
  const add = (file: string) => {
    if (out.has(file) || !graph.has(file)) return;
    out.add(file);
    for (const dep of graph.get(file)?.imports ?? []) add(dep);
  };
  for (const [file, node] of graph) if (node.isEntry) add(file);
  for (const file of preload) add(file);
  return out;
}

export function chunkProblems(graph: ChunkGraph, preloadMap: Record<string, string[]>): string[] {
  const problems: string[] = [];
  const label = (file: string) => graph.get(file)?.name ?? file;
  for (const cycle of findChunkCycles(graph)) {
    problems.push(`块之间有循环 import：${cycle.map(label).join(" ↔ ")}`);
  }
  for (const [group, forbidden] of Object.entries(FIRST_SCREEN_FORBIDDEN)) {
    const names = new Set([...firstScreenChunks(graph, preloadMap[group] ?? [])].map(label));
    for (const bad of forbidden) {
      if (names.has(bad)) problems.push(`${group} 首屏带上了 ${bad}`);
    }
  }
  return problems;
}

/** 构建时检查；有问题让构建失败（CHISABOT_CHUNK_GUARD=warn 时只告警）。 */
export function chunkGuard(): Plugin {
  return {
    name: "chisabot-chunk-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const problems = chunkProblems(graphFromBundle(bundle), routePreloadMap(bundle));
      if (problems.length === 0) return;
      const message = `分块检查失败（DESIGN.md §41.5）：\n- ${problems.join("\n- ")}`;
      if (process.env.CHISABOT_CHUNK_GUARD === "warn") this.warn(message);
      else this.error(message);
    },
  };
}

/** 读 dist/：从产物文本里还原块图（测试用；构建时直接用 bundle）。 */
export function graphFromFiles(files: Record<string, string>): ChunkGraph {
  const graph: ChunkGraph = new Map();
  for (const [file, code] of Object.entries(files)) {
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    const imports = new Set<string>();
    for (const [, spec] of code.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      if (spec) imports.add(new URL(spec, `http://x/${dir}`).pathname.slice(1));
    }
    const base = file.slice(file.lastIndexOf("/") + 1).replace(/\.js$/, "");
    graph.set(file, { name: base.replace(/-[\w-]{8}$/, ""), imports: [...imports], isEntry: false });
  }
  return graph;
}

/** 读一份构建好的 dist/：块图（标好入口）+ index.html 里内联的首屏预载表。没有 dist/ 时返回 null。 */
export function readDist(dir: string): { graph: ChunkGraph; preloadMap: Record<string, string[]> } | null {
  const htmlPath = path.join(dir, "index.html");
  const assets = path.join(dir, "assets");
  if (!fs.existsSync(htmlPath) || !fs.existsSync(assets)) return null;
  const files: Record<string, string> = {};
  for (const f of fs.readdirSync(assets)) {
    if (f.endsWith(".js")) files[`assets/${f}`] = fs.readFileSync(path.join(assets, f), "utf8");
  }
  const graph = graphFromFiles(files);
  const html = fs.readFileSync(htmlPath, "utf8");
  const entry = html.match(/<script type="module"[^>]*src="\/(assets\/[^"]+\.js)"/)?.[1];
  const entryNode = entry ? graph.get(entry) : undefined;
  if (!entryNode) throw new Error(`${htmlPath} 里找不到入口脚本`);
  entryNode.isEntry = true;
  const inline = html.match(/var m=(\{.*?\});var p=/)?.[1];
  const raw: Record<string, string[]> = inline ? JSON.parse(inline) : {};
  const preloadMap = Object.fromEntries(
    Object.entries(raw).map(([group, list]) => [group, list.map((f) => f.replace(/^\//, ""))]),
  );
  return { graph, preloadMap };
}
