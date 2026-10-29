import { expect, test } from "bun:test";
import { router } from "../src/router";
import {
  routeBuildRollupOutputOptions,
  routeCodeSplittingOptions,
  selectChisaBotManualChunk,
  selectedRouteSplitBehavior,
} from "../vite.config";

test("provides the generated index route", () => {
  expect(router.routesByPath["/"]?.fullPath).toBe("/");
});

test("provides the generated sign-in and chat routes", () => {
  expect(router.routesByPath["/sign"]?.fullPath).toBe("/sign");
  expect(router.routesByPath["/channel/$channelId"]?.fullPath).toBe(
    "/channel/$channelId",
  );
});

test("provides the protected credential administration route", () => {
  expect(router.routesByPath["/admin/credentials"]?.fullPath).toBe(
    "/admin/credentials",
  );
});

test("splits route components without splitting loaders or providers", () => {
  expect(routeCodeSplittingOptions.defaultBehavior).toEqual([]);
  expect(selectedRouteSplitBehavior({ routeId: "/sign" })).toEqual([
    ["component"],
  ]);
  expect(
    selectedRouteSplitBehavior({ routeId: "/_authed/_app/channel/$channelId" }),
  ).toEqual([["component"]]);
  expect(selectedRouteSplitBehavior({ routeId: "/admin/credentials" })).toEqual(
    [["component"]],
  );
  expect(
    selectedRouteSplitBehavior({ routeId: "/settings/connected-accounts/" }),
  ).toEqual([["component"]]);
  expect(selectedRouteSplitBehavior({ routeId: "/" })).toBeUndefined();
});

test("uses explicit manual chunks for route components", () => {
  expect(routeBuildRollupOutputOptions.onlyExplicitManualChunks).toBe(true);
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/routes/sign.tsx?tsr-split=component",
    ),
  ).toBe("route-sign");
  expect(
    selectChisaBotManualChunk(
      "C:\\repo\\app\\src\\routes\\_authed\\_app\\channel\\$channelId.tsx?tsr-split=component",
    ),
  ).toBe("route-chat-core");
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/routes/_authed/admin/credentials.tsx?tsr-split=component",
    ),
  ).toBe("route-admin");
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/routes/_authed/settings/connected-accounts/index.tsx?tsr-split=component",
    ),
  ).toBe("route-settings");
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/routes/_authed/_app/agents/index.tsx?tsr-split=component",
    ),
  ).toBe("route-app-secondary");
});

test("does not manually chunk lazy content or dependencies", () => {
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/routes/_authed/_app/channel/$channelId.tsx?tsr-split=loader",
    ),
  ).toBeUndefined();
  expect(
    selectChisaBotManualChunk(
      "/repo/app/src/components/markdown/lazy-mermaid.tsx",
    ),
  ).toBeUndefined();
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/mermaid@11.12.1/node_modules/mermaid/dist/mermaid.core.mjs",
    ),
  ).toBeUndefined();
  // KaTeX 和 micromark 的数学扩展故意不进任何 vendor 块：一进就会被静态拉上首屏（DESIGN.md §41.5）。
  expect(
    selectChisaBotManualChunk("/repo/node_modules/.bun/katex@0.16.22/node_modules/katex/dist/katex.mjs"),
  ).toBeUndefined();
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/micromark-extension-math@3.1.0/node_modules/micromark-extension-math/lib/html.js",
    ),
  ).toBeUndefined();
  // CopilotKit 自己按需 import 的调试面板不跟着 vendor-copilot 上首屏。
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/@copilotkit+web-inspector@1.70.1/node_modules/@copilotkit/web-inspector/dist/index.js",
    ),
  ).toBeUndefined();
  // 样式不进 JS 块（不然入口为了一份 CSS 把整个块拉上来）。
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/@copilotkit+react-core@1.70.1/node_modules/@copilotkit/react-core/dist/styles.css",
    ),
  ).toBeUndefined();
  // streamdown 的代码块 / mermaid 文件静态带着 shiki，留给 Rollup 按需拆。
  expect(
    selectChisaBotManualChunk("/repo/node_modules/.bun/streamdown@2.6.0/node_modules/streamdown/dist/code-block-abc.js"),
  ).toBeUndefined();
});

test("groups heavy vendors into stable chunks (DESIGN.md §41.5)", () => {
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/react-dom@19.2.0/node_modules/react-dom/client.js",
    ),
  ).toBe("vendor-react");
  expect(selectChisaBotManualChunk("\0commonjsHelpers.js")).toBe("vendor-react");
  expect(
    selectChisaBotManualChunk(
      "/repo/node_modules/.bun/@copilotkit+react-core@1.70.1/node_modules/@copilotkit/react-core/dist/index.js",
    ),
  ).toBe("vendor-copilot");
  expect(
    selectChisaBotManualChunk("/repo/node_modules/.bun/streamdown@2.6.0/node_modules/streamdown/dist/index.js"),
  ).toBe("vendor-markdown");
  expect(
    selectChisaBotManualChunk("/repo/node_modules/.bun/lucide-react@0.5.0/node_modules/lucide-react/dist/esm/icons/x.js"),
  ).toBe("vendor-lucide");
});

test("keeps the authed layout out of the chat chunk", () => {
  expect(selectChisaBotManualChunk("/repo/app/src/routes/_authed.tsx?tsr-split=component")).toBe("route-shell");
  expect(selectChisaBotManualChunk("/repo/app/src/routes/_authed/_app.tsx?tsr-split=component")).toBe("route-shell");
});
