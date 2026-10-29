import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { listenPort } from "../shared/listen-port";
import { bundleReport } from "./scripts/bundle-report";
import { routePreload } from "./scripts/route-preload";
import { skyBootScript } from "./src/lib/sky";

/*
 * Announce the server's port to the two runtimes that serve the app through Vite, and to no other.
 *
 * The dev server and the desktop's `vite preview` serve the app on APP_PORT and proxy `/api` to the
 * server, but under bun that proxy cannot carry a WebSocket (oven-sh/bun#24127), so the app's
 * sockets address the server directly on this port. `socketUrl` reads it off `window`.
 *
 * It is deliberately kept OUT of the built HTML. In production the server serves that same HTML on
 * its own origin and answers the upgrade there, so the socket is same-origin; a baked port would
 * point it at a container port an ingress terminating TLS on 443 does not expose, which is how a
 * build-time constant broke the fleet. The dev injection is gated on `ctx.server` so it never runs
 * during `vite build`; `vite preview` serves the static build unchanged and so is handled by its
 * own middleware below.
 */
function announceServerPort(port: number): Plugin {
  const tag = `<script>window.__CHISABOT_WS_PORT__=${JSON.stringify(String(port))};</script>`;
  const inject = (html: string) =>
    html.includes("__CHISABOT_WS_PORT__")
      ? html
      : html.replace("</head>", `    ${tag}\n  </head>`);
  return {
    name: "chisabot-announce-server-port",
    transformIndexHtml(html, ctx) {
      return ctx.server ? inject(html) : html;
    },
    configurePreviewServer(server) {
      const indexPath = path.resolve(__dirname, "dist", "index.html");
      server.middlewares.use((request, response, next) => {
        const requestPath = (request.url ?? "/").split("?")[0];
        // Only the SPA entry, and this middleware runs before Vite's own — so everything Vite must
        // still handle has to fall through: a non-GET, an `/api` call the proxy carries to the
        // server (extension-less GETs like `/api/bots` included), and an asset with a file
        // extension. What is left is a navigation, which gets the app shell with the port announced.
        if (
          request.method !== "GET" ||
          requestPath.startsWith("/api") ||
          /\.[^/]+$/.test(requestPath)
        ) {
          return next();
        }
        let html: string;
        try {
          html = readFileSync(indexPath, "utf8");
        } catch {
          return next();
        }
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(inject(html));
      });
    },
  };
}

/*
 * The same address and the same proxy whether this is the dev server or the preview of a build.
 *
 * `preview` is a separate config key with its own defaults, so a deployment that serves the built
 * app rather than the dev server gets no `/api` proxy unless it is repeated here. A desktop install
 * serves the build, and without this every call it makes returns the app's own HTML.
 */
const appPort = listenPort(process.env.APP_PORT, 3010);
if (!appPort.ok) {
  throw new Error(appPort.reason.replace(/^PORT /, "APP_PORT "));
}
const apiPort = listenPort(process.env.SERVER_PORT, 3001);
if (!apiPort.ok) {
  throw new Error(apiPort.reason.replace(/^PORT /, "SERVER_PORT "));
}

const serving = {
  // Both loopbacks, which is what `::` gets you: Node opens a dual-stack socket, so 127.0.0.1 and
  // ::1 both answer. Left to itself Vite binds whichever one this runtime resolves `localhost`
  // to, which is ::1 under Node and 127.0.0.1 under bun, and the other address is then refused.
  // Whoever is told the URL has no way to know which they were given.
  // Empty APP_PORT=/SERVER_PORT= is unset (compose / leftover .env), not NaN — same trap as Bot PORT.
  host: "::",
  port: appPort.port,
  strictPort: true,
  proxy: {
    "/api": {
      target: `http://localhost:${apiPort.port}`,
    },
  },
};

/*
 * Inline the time-of-day sky (DESIGN.md §7) as the first thing in <body>, so the pre-JS skeleton
 * already paints the current hour's sky. The palette is `computeSky` itself, serialised, so the boot
 * paint and the app can never disagree.
 */
function skyBoot(): Plugin {
  const marker =
    /<!-- chisabot-sky-boot:[^>]*-->/;
  return {
    name: "chisabot-sky-boot",
    transformIndexHtml(html) {
      return html.replace(marker, () => `<script>${skyBootScript()}</script>`);
    },
  };
}

type RouteSplitGroupings = Array<
  Array<
    "component" | "pendingComponent" | "errorComponent" | "notFoundComponent"
  >
>;

const componentRouteSplit: RouteSplitGroupings = [["component"]];

export function selectedRouteSplitBehavior({
  routeId,
}: {
  routeId: string;
}): RouteSplitGroupings | undefined {
  if (routeId === "/" || routeId.startsWith("/__root")) {
    return undefined;
  }
  return componentRouteSplit;
}

export const routeCodeSplittingOptions = {
  defaultBehavior: [],
  splitBehavior: selectedRouteSplitBehavior,
};

function normalizedModuleId(id: string): string {
  return id.replaceAll("\\", "/");
}

function routeComponentSplitPath(id: string): string | undefined {
  const normalized = normalizedModuleId(id);
  const [filePath, query = ""] = normalized.split("?");
  if (new URLSearchParams(query).get("tsr-split") !== "component") {
    return undefined;
  }
  const routesMarker = "/src/routes/";
  const routesIndex = filePath.lastIndexOf(routesMarker);
  if (routesIndex === -1) {
    return undefined;
  }
  return filePath.slice(routesIndex + routesMarker.length);
}

/*
 * 两组大依赖各自单独成块（DESIGN.md §41.5）。不分的话 Rollup 会把很多小模块（lib/approvals.ts、ui/skeleton.tsx、
 * lib/schedule-fired.ts……）和 CopilotKit、Markdown 渲染放进同一个共享块：设置页的左栏只为了一个 20 行的小文件，
 * 就把 ~270KB gzip 的 CopilotKit 和 ~160KB 的 Markdown 一起下载执行了。分出来以后这两块只在真用到时（聊天、
 * 带 Markdown 的页面）下载。`onlyExplicitManualChunks` 下只移动名单里的包本身，它们的依赖照常由 Rollup 分。
 */
const VENDOR_CHUNKS: Array<[RegExp, string]> = [
  // React 放一个不依赖任何别的块的叶子块：下面的 vendor 块都要 import React，React 若落进某个共享块，
  // 块之间就可能成环，按需块先执行时会读到还没初始化的 React（forwardRef of undefined）。
  [/\/node_modules\/(react|react-dom|scheduler)\//, "vendor-react"],
  // web-inspector 是 CopilotKit 自己按需 import 的开发者面板（~870KB 未压缩），不能被拉进来。
  [/\/node_modules\/(@copilotkit\/(?!web-inspector)|@ag-ui\/|rxjs\/|phoenix\/|zod-to-json-schema\/)/, "vendor-copilot"],
  [
    /\/node_modules\/(streamdown|marked|parse5|entities|unified|bail|trough|is-plain-obj|vfile|vfile-message|devlop|zwitch|ccount|longest-streak|markdown-table|trim-lines|property-information|space-separated-tokens|comma-separated-tokens|hastscript|html-void-elements|html-url-attributes|decode-named-character-reference|character-entities|character-entities-legacy|character-entities-html4|character-reference-invalid|is-alphabetical|is-alphanumerical|is-decimal|is-hexadecimal|stringify-entities|web-namespaces|style-to-js|style-to-object|inline-style-parser|@ungap\/structured-clone|get-east-asian-width|escape-string-regexp|remend|micromark(?!-extension-math)[^/]*|mdast-util-[^/]+|hast-util-[^/]+|unist-util-[^/]+|remark-[^/]+|rehype-(?!katex)[^/]+|estree-util-[^/]+)\//,
    "vendor-markdown",
  ],
  // 下面几个同理：本身只在少数地方按需用，但体积大，一旦和小模块同块就被拖上首屏。KaTeX 和 micromark-extension-math
  // 反而不能点名：点名进手工块后 mathHtml 会留下来，把 KaTeX（~78KB gzip）静态带上；main 上它只被 Mermaid 按需引用。

  [/\/node_modules\/(shiki|@shikijs\/(core|engine-javascript|types|vscode-textmate)|oniguruma-to-es|oniguruma-parser|regex|regex-recursion|regex-utilities)\//, "vendor-shiki"],
  // 代码高亮的 Oniguruma 引擎（内联 wasm，~240KB gzip）单独一块：否则 Rollup 会把 Markdown 用到的几个小包和它同块。
  [/\/node_modules\/@shikijs\/engine-oniguruma\//, "vendor-shiki-wasm"],
  [/\/node_modules\/lucide-react\//, "vendor-lucide"],
  [/\/node_modules\/(@modelcontextprotocol)\//, "vendor-mcp"],
];

/*
 * 外壳块 shell（DESIGN.md §41.5）：AuthedShell 按需加载的左栏 / 设置栏 / 管理栏 / 右侧面板栏，连同它们静态 import
 * 的全部模块（入口已经有的除外、上面的大依赖除外）放进同一块。不这么做，Rollup 按「被哪些入口用到」切块，这些栏用到的
 * 小模块会和聊天页的代码混在 skill-commands、avatar、pages 等共享块里，而那些块又静态依赖 CopilotKit / Markdown，
 * 结果打开设置页也得下载执行它们。
 */
const SHELL_ROOTS = [
  "/src/components/layout/left-rail.tsx",
  "/src/components/settings/settings-sidebar.tsx",
  "/src/components/admin/admin-sidebar.tsx",
  "/src/components/panels/panel-rail.tsx",
];

type ModuleInfoLookup = (id: string) => { importedIds: readonly string[]; isEntry: boolean } | null;
type ManualChunkMeta = { getModuleIds: () => IterableIterator<string>; getModuleInfo: ModuleInfoLookup };

function isVendorChunked(id: string): boolean {
  const normalizedId = normalizedModuleId(id);
  // streamdown 自己按需 import 的代码块 / Mermaid 部分不归进来，否则 Markdown 一加载就静态依赖 shiki。
  if (/\.css($|\?)/.test(normalizedId) || /\/streamdown\/dist\/(code-block|mermaid)-/.test(normalizedId)) return false;
  return VENDOR_CHUNKS.some(([pattern]) => pattern.test(normalizedId));
}

const shellSets = new WeakMap<ModuleInfoLookup, Set<string>>();

export function shellModuleIds(meta: ManualChunkMeta): Set<string> {
  const cached = shellSets.get(meta.getModuleInfo);
  if (cached) return cached;
  const ids = [...meta.getModuleIds()];
  const closure = (roots: string[], stop: (id: string) => boolean) => {
    const seen = new Set<string>();
    const queue = roots.filter((id) => !stop(id));
    for (const id of queue) seen.add(id);
    while (queue.length > 0) {
      const id = queue.pop() as string;
      for (const next of meta.getModuleInfo(id)?.importedIds ?? []) {
        if (seen.has(next) || stop(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };
  const entry = closure(
    ids.filter((id) => meta.getModuleInfo(id)?.isEntry),
    () => false,
  );
  const roots = ids.filter((id) => SHELL_ROOTS.some((root) => normalizedModuleId(id).endsWith(root)));
  const shell = closure(roots, (id) => entry.has(id) || isVendorChunked(id) || /\.css($|\?)/.test(id));
  shellSets.set(meta.getModuleInfo, shell);
  return shell;
}

export function selectChisaBotManualChunk(id: string, meta?: ManualChunkMeta): string | undefined {
  const normalizedId = normalizedModuleId(id);
  // 样式表不跟着走：main.tsx 静态引入了 CopilotKit 的 CSS，把它分进 vendor-copilot 会让入口反过来静态依赖整块 JS。
  if (isVendorChunked(id)) return VENDOR_CHUNKS.find(([pattern]) => pattern.test(normalizedId))?.[1];
  // CommonJS 互操作的公共小工具（React 是 CJS，要用它）跟 React 同块，否则 vendor-react 又得依赖别的共享块。
  if (id.startsWith("\0commonjsHelpers")) return "vendor-react";
  if (meta && !routeComponentSplitPath(id) && shellModuleIds(meta).has(id)) return "shell";
  const routePath = routeComponentSplitPath(id);
  if (!routePath) {
    return undefined;
  }
  if (routePath === "sign.tsx") {
    return "route-sign";
  }
  // 外壳路由（_authed / _app 的组件）单独一块：和聊天路由同块的话，进设置页也要先把聊天页的静态依赖
  // （CopilotKit、Markdown）一起下完才画得出外壳（DESIGN.md §41.5）。
  if (routePath === "_authed.tsx" || routePath === "_authed/_app.tsx") {
    return "route-shell";
  }
  if (routePath.startsWith("_authed/_app/channel/")) {
    return "route-chat-core";
  }
  if (routePath.startsWith("_authed/admin/")) {
    return "route-admin";
  }
  if (routePath.startsWith("_authed/settings/")) {
    return "route-settings";
  }
  if (
    routePath.startsWith("_authed/_app/") ||
    routePath === "_authed/onboarding.tsx"
  ) {
    return "route-app-secondary";
  }
  return undefined;
}

export const routeBuildRollupOutputOptions = {
  onlyExplicitManualChunks: true,
  manualChunks: selectChisaBotManualChunk,
};

export const BUNDLE_STUBS = [
  { find: /^@copilotkit\/a2ui-renderer$/, replacement: path.resolve(__dirname, "./src/lib/bundle-stubs/a2ui-renderer.ts") },
  { find: /^@ag-ui\/proto$/, replacement: path.resolve(__dirname, "./src/lib/bundle-stubs/ag-ui-proto.ts") },
  { find: /^rehype-katex$/, replacement: path.resolve(__dirname, "./src/lib/bundle-stubs/rehype-katex.ts") },
];

/**
 * 服务器节点 chisabot-node（docs/pc-node.md §14）：构建网页时顺便用 esbuild 把 pc/src/headless.js
 * （和 PC 客户端同一套 agent 代码 + ws）打成单个 dist/node-agent/chisabot-node.cjs，服务器在
 * /api/devices/agent/node/chisabot-node.cjs 原样提供给安装脚本下载。pc/ 不在服务器镜像里，所以在这里打包。
 * 打包失败只告警、不让网页构建失败（节点下载会 404，网页照常）。
 *
 * CI 例外（环境变量 CI 非空）：直接让构建失败。以前默认 isolated linker 下 `ws` 解析不到，打包会静默跳过，
 * 没人发现；CI 和镜像一样用 hoisted 安装，这里失败就说明线上镜像也会缺这个文件。本机和 Docker 构建不设 CI，
 * 行为不变。pc/ 自己的依赖另有 CI 的 pc-build job 单独打包校验。
 */
function chisabotNodeBundle(): Plugin {
  return {
    name: "chisabot-node-bundle",
    apply: "build",
    async generateBundle() {
      try {
        const { build } = await import("esbuild");
        const root = path.resolve(__dirname, "..");
        const pcPackage = JSON.parse(readFileSync(path.join(root, "pc/package.json"), "utf8")) as { version: string };
        const result = await build({
          entryPoints: [path.join(root, "pc/src/headless.js")],
          bundle: true,
          platform: "node",
          target: "node18",
          format: "cjs",
          write: false,
          minify: false,
          legalComments: "inline",
          external: ["bufferutil", "utf-8-validate", "electron"],
          define: { __CHISABOT_NODE_VERSION__: JSON.stringify(pcPackage.version) },
          banner: { js: `// chisabot-node ${pcPackage.version} — https://github.com/ChisaAlter/ChisaBot (docs/pc-node.md §14)` },
          logLevel: "silent",
        });
        const code = result.outputFiles[0]?.text ?? "";
        this.emitFile({ type: "asset", fileName: "node-agent/chisabot-node.cjs", source: code });
      } catch (error) {
        const message = `chisabot-node bundle skipped: ${error instanceof Error ? error.message : String(error)}`;
        if (process.env.CI) this.error(message);
        this.warn(message);
      }
    },
  };
}

export default defineConfig({
  envDir: path.resolve(__dirname, ".."),
  plugins: [
    announceServerPort(apiPort.port),
    skyBoot(),
    tanstackRouter({
      autoCodeSplitting: true,
      codeSplittingOptions: routeCodeSplittingOptions,
    }),
    react(),
    tailwindcss(),
    chisabotNodeBundle(),
    routePreload(),
    ...(process.env.CHISABOT_BUNDLE_REPORT ? [bundleReport()] : []),
  ],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      // 首屏包瘦身（DESIGN.md §41.4）：只被引用、在浏览器里从不执行的依赖换成小桩，说明见各文件。
      ...BUNDLE_STUBS,
    ],
  },
  server: serving,
  preview: serving,
  build: {
    rollupOptions: {
      output: routeBuildRollupOutputOptions,
    },
  },
});
