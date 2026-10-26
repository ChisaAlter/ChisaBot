import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { listenPort } from "../shared/listen-port";
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

export function selectChisaBotManualChunk(id: string): string | undefined {
  const routePath = routeComponentSplitPath(id);
  if (!routePath) {
    return undefined;
  }
  if (routePath === "sign.tsx") {
    return "route-sign";
  }
  if (
    routePath === "_authed.tsx" ||
    routePath === "_authed/_app.tsx" ||
    routePath.startsWith("_authed/_app/channel/")
  ) {
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
        this.warn(`chisabot-node bundle skipped: ${error instanceof Error ? error.message : String(error)}`);
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
