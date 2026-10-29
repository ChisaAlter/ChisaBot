import { expect, test } from "bun:test";
import path from "node:path";
import {
  type ChunkGraph,
  chunkProblems,
  findChunkCycles,
  firstScreenChunks,
  graphFromFiles,
  readDist,
} from "../scripts/chunk-graph";

function graph(edges: Record<string, string[]>, entry = "assets/index-AAAAAAAA.js"): ChunkGraph {
  const g: ChunkGraph = new Map();
  for (const [file, imports] of Object.entries(edges)) {
    g.set(file, { name: file.replace(/^assets\//, "").replace(/-[\w-]{8}\.js$/, ""), imports, isEntry: file === entry });
  }
  return g;
}

test("finds cycles between chunks, including longer ones", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-react-BBBBBBBB.js": [],
    "assets/vendor-copilot-CCCCCCCC.js": ["assets/vendor-mcp-DDDDDDDD.js"],
    "assets/vendor-mcp-DDDDDDDD.js": ["assets/vendor-copilot-CCCCCCCC.js"],
    "assets/a-EEEEEEEE.js": ["assets/b-FFFFFFFF.js"],
    "assets/b-FFFFFFFF.js": ["assets/c-GGGGGGGG.js"],
    "assets/c-GGGGGGGG.js": ["assets/a-EEEEEEEE.js"],
  });
  const cycles = findChunkCycles(g).map((c) => c.map((f) => g.get(f)!.name).sort());
  expect(cycles).toContainEqual(["vendor-copilot", "vendor-mcp"]);
  expect(cycles).toContainEqual(["a", "b", "c"]);
  expect(cycles).toHaveLength(2);
});

test("first screen = entry closure + preload closure", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-react-BBBBBBBB.js": [],
    "assets/route-settings-CCCCCCCC.js": ["assets/shell-DDDDDDDD.js"],
    "assets/shell-DDDDDDDD.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-copilot-EEEEEEEE.js": [],
  });
  const names = [...firstScreenChunks(g, ["assets/route-settings-CCCCCCCC.js"])].map((f) => g.get(f)!.name).sort();
  expect(names).toEqual(["index", "route-settings", "shell", "vendor-react"]);
});

test("flags CopilotKit / Markdown on the settings and admin first screens", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": [],
    "assets/route-admin-BBBBBBBB.js": ["assets/vendor-copilot-CCCCCCCC.js"],
    "assets/vendor-copilot-CCCCCCCC.js": ["assets/vendor-markdown-DDDDDDDD.js"],
    "assets/vendor-markdown-DDDDDDDD.js": [],
    "assets/route-settings-EEEEEEEE.js": [],
  });
  const problems = chunkProblems(g, {
    chat: ["assets/vendor-copilot-CCCCCCCC.js"],
    settings: ["assets/route-settings-EEEEEEEE.js"],
    admin: ["assets/route-admin-BBBBBBBB.js"],
  });
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toContain("admin");
  expect(problems.join("\n")).not.toContain("settings");
});

test("rebuilds the chunk graph from minified output (static imports only)", () => {
  const g = graphFromFiles({
    "assets/index-AAAAAAAA.js": 'import{a as b}from"./vendor-react-BBBBBBBB.js";import"./shell-CCCCCCCC.js";const x=()=>import("./route-admin-DDDDDDDD.js");',
    "assets/vendor-react-BBBBBBBB.js": "export const a=1;",
    "assets/shell-CCCCCCCC.js": 'import {a} from "./vendor-react-BBBBBBBB.js";',
    "assets/route-admin-DDDDDDDD.js": "",
  });
  expect(g.get("assets/index-AAAAAAAA.js")!.imports.sort()).toEqual([
    "assets/shell-CCCCCCCC.js",
    "assets/vendor-react-BBBBBBBB.js",
  ]);
  expect(g.get("assets/shell-CCCCCCCC.js")!.name).toBe("shell");
  expect(g.get("assets/route-admin-DDDDDDDD.js")!.imports).toEqual([]);
});

/*
 * 真实产物：有 app/dist（先跑过 bun run build）就查一遍——块之间无环，设置页 / 管理页首屏不带 vendor-copilot、
 * vendor-markdown。构建时 chunkGuard 已经查过一次，这里防的是有人把 guard 关了（CHISABOT_CHUNK_GUARD=warn）或绕过它。
 */
const dist = readDist(path.join(import.meta.dir, "..", "dist"));

test.skipIf(!dist)("built dist/: no chunk cycles, settings/admin first screens stay light", () => {
  const { graph: g, preloadMap } = dist!;
  expect(Object.keys(preloadMap).sort()).toEqual(["admin", "chat", "settings"]);
  expect(chunkProblems(g, preloadMap)).toEqual([]);
  const names = (group: string) => new Set([...firstScreenChunks(g, preloadMap[group] ?? [])].map((f) => g.get(f)!.name));
  expect(names("chat").has("vendor-copilot")).toBe(true);
  expect(names("settings").has("vendor-copilot")).toBe(false);
  expect(names("admin").has("vendor-markdown")).toBe(false);
});
