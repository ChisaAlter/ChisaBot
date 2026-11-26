import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type ChunkGraph,
  chunkProblems,
  findChunkCycles,
  firstScreenChunks,
  graphFromFiles,
  MAX_PRELOAD_CHUNKS,
  readDist,
} from "../scripts/chunk-graph";

function graph(
  edges: Record<string, string[]>,
  entry = "assets/index-AAAAAAAA.js",
): ChunkGraph {
  const g: ChunkGraph = new Map();
  for (const [file, imports] of Object.entries(edges)) {
    g.set(file, {
      name: file.replace(/^assets\//, "").replace(/-[\w-]{8}\.js$/, ""),
      imports,
      isEntry: file === entry,
    });
  }
  return g;
}

test("finds cycles between chunks, including longer ones", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-react-BBBBBBBB.js": [],
    "assets/vendor-conversation-CCCCCCCC.js": ["assets/vendor-mcp-DDDDDDDD.js"],
    "assets/vendor-mcp-DDDDDDDD.js": ["assets/vendor-conversation-CCCCCCCC.js"],
    "assets/a-EEEEEEEE.js": ["assets/b-FFFFFFFF.js"],
    "assets/b-FFFFFFFF.js": ["assets/c-GGGGGGGG.js"],
    "assets/c-GGGGGGGG.js": ["assets/a-EEEEEEEE.js"],
  });
  const cycles = findChunkCycles(g).map((c) =>
    c.map((f) => g.get(f)!.name).sort(),
  );
  expect(cycles).toContainEqual(["vendor-conversation", "vendor-mcp"]);
  expect(cycles).toContainEqual(["a", "b", "c"]);
  expect(cycles).toHaveLength(2);
});

test("first screen = entry closure + preload closure", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-react-BBBBBBBB.js": [],
    "assets/route-settings-CCCCCCCC.js": ["assets/shell-DDDDDDDD.js"],
    "assets/shell-DDDDDDDD.js": ["assets/vendor-react-BBBBBBBB.js"],
    "assets/vendor-conversation-EEEEEEEE.js": [],
  });
  const names = [...firstScreenChunks(g, ["assets/route-settings-CCCCCCCC.js"])]
    .map((f) => g.get(f)!.name)
    .sort();
  expect(names).toEqual(["index", "route-settings", "shell", "vendor-react"]);
});

test("flags conversation client / Markdown on the settings and admin first screens", () => {
  const g = graph({
    "assets/index-AAAAAAAA.js": [],
    "assets/route-admin-BBBBBBBB.js": [
      "assets/vendor-conversation-CCCCCCCC.js",
    ],
    "assets/vendor-conversation-CCCCCCCC.js": [
      "assets/vendor-markdown-DDDDDDDD.js",
    ],
    "assets/vendor-markdown-DDDDDDDD.js": [],
    "assets/route-settings-EEEEEEEE.js": [],
  });
  const problems = chunkProblems(g, {
    chat: ["assets/vendor-conversation-CCCCCCCC.js"],
    settings: ["assets/route-settings-EEEEEEEE.js"],
    admin: ["assets/route-admin-BBBBBBBB.js"],
  });
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toContain("admin");
  expect(problems.join("\n")).not.toContain("settings");
});

test("flags excessive modulepreload fragment counts", () => {
  const g = graph({ "assets/index-AAAAAAAA.js": [] });
  const tooMany = Array.from(
    { length: MAX_PRELOAD_CHUNKS + 1 },
    (_, i) => `assets/frag${i}-AAAAAAAA.js`,
  );
  const problems = chunkProblems(g, { chat: tooMany });
  expect(problems.some((p) => p.includes("modulepreload"))).toBe(true);
});

test("rebuilds the chunk graph from minified output (static imports only)", () => {
  const g = graphFromFiles({
    "assets/index-AAAAAAAA.js":
      'import{a as b}from"./vendor-react-BBBBBBBB.js";import"./shell-CCCCCCCC.js";const x=()=>import("./route-admin-DDDDDDDD.js");',
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
 * 真实产物：有 app/dist（先跑过 bun run build）就查一遍——块之间无环，设置页 / 管理页首屏不带 vendor-conversation、
 * vendor-markdown。构建时 chunkGuard 已经查过一次，这里防的是有人把 guard 关了（CHISABOT_CHUNK_GUARD=warn）或绕过它。
 */
const dist = readDist(path.join(import.meta.dir, "..", "dist"));

test.skipIf(!dist)(
  "built dist/: no chunk cycles, settings/admin first screens stay light",
  () => {
    const { graph: g, preloadMap } = dist!;
    expect(Object.keys(preloadMap).sort()).toEqual([
      "admin",
      "chat",
      "settings",
    ]);
    expect(chunkProblems(g, preloadMap)).toEqual([]);
    const names = (group: string) =>
      new Set(
        [...firstScreenChunks(g, preloadMap[group] ?? [])].map(
          (f) => g.get(f)!.name,
        ),
      );
    expect(names("chat").has("vendor-conversation")).toBe(true);
    expect(names("settings").has("vendor-conversation")).toBe(false);
    expect(names("admin").has("vendor-markdown")).toBe(false);
  },
);

test("first-screen bundle boundaries stay free of Zod, liquid-glass, motion barrel, and cross-area route imports", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");

  // 1. 路由查询参数与 json-render 纯工具不静态拉入 Zod / catalog.ts
  for (const file of [
    "app/src/routes/_authed/_app/skills.tsx",
    "app/src/routes/_authed/_app/agents/index.tsx",
    "app/src/components/channels/chat-search.ts",
    "shared/json-render/utils.ts",
  ]) {
    expect(read(file)).not.toMatch(/from\s+["']zod(?:\/[^"']+)?["']/);
  }
  expect(read("app/src/lib/conversations/json-render/rich-utils.ts")).not.toContain(
    "shared/json-render/catalog",
  );

  // 2. 右栏轻量摘要 hook 不拉入 Zod 或重型 TasksRailCard，且 panel-rail 按需懒加载 TasksRailCard
  const summarySrc = read("app/src/components/panels/rail-tasks-summary.ts");
  expect(summarySrc).not.toMatch(
    /^\s*import\s+(?!type\b)[^;]*?shared\/(?:task-center|workflows)/m,
  );
  expect(summarySrc).not.toContain("tasks-rail-card");
  const railSrc = read("app/src/components/panels/panel-rail.tsx");
  expect(railSrc).not.toMatch(/from\s+["']\.\/tasks-rail-card["']/);
  expect(railSrc).toContain('import("./tasks-rail-card")');

  // 3. 液态玻璃重型模块已彻底下线，sky-background 零引用 liquid-glass
  const skySrc = read("app/src/components/sky-background.tsx");
  expect(skySrc).not.toContain("liquid-glass");
  expect(
    fs.existsSync(path.join(import.meta.dir, "../src/lib/liquid-glass.ts")),
  ).toBe(false);
  expect(
    fs.existsSync(path.join(import.meta.dir, "../src/lib/sky-snapshot.ts")),
  ).toBe(false);

  // 4. hooks 桶不 re-export useVoiceCall，切断 motion-dom 链；__root 不重复导入 Inter 且低频提示走 AfterIdle
  expect(read("app/src/hooks/index.ts")).not.toContain("use-voice-call");
  const rootSrc = read("app/src/routes/__root.tsx");
  expect(rootSrc).not.toContain("@fontsource-variable/inter");
  expect(rootSrc).toContain("<AfterIdle>");

  // 5. settings/updates 不再跨区静态导入 admin/system-update
  const updatesRouteSrc = read("app/src/routes/_authed/settings/updates.tsx");
  expect(updatesRouteSrc).not.toContain("admin/system-update");
  expect(updatesRouteSrc).toContain("@/components/system-update/updates-screen");
});
