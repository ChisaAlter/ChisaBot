import { expect, test } from "bun:test";
import {
  MIN_PRELOAD_DEP_BYTES,
  routePreloadGroup,
  routePreloadMap,
  routePreloadScript,
} from "../scripts/route-preload";

function chunk(fileName: string, moduleIds: string[], imports: string[] = [], extra: Record<string, unknown> = {}) {
  return { type: "chunk", fileName, name: fileName.replace(/-.*$/, ""), moduleIds, imports, isEntry: false, ...extra };
}

test("maps paths to preload groups", () => {
  expect(routePreloadGroup("/")).toBe("chat");
  expect(routePreloadGroup("/channel/abc")).toBe("chat");
  expect(routePreloadGroup("/settings")).toBe("settings");
  expect(routePreloadGroup("/settings/models")).toBe("settings");
  expect(routePreloadGroup("/admin/users")).toBe("admin");
  expect(routePreloadGroup("/sign-in")).toBeNull();
  expect(routePreloadGroup("/settingsx")).toBeNull();
});

test("inline script follows the same path rules", () => {
  const map = { chat: ["assets/c.js"], settings: ["assets/s.js"], admin: ["assets/a.js"] };
  const run = (pathname: string) => {
    const links: string[] = [];
    const doc = {
      createElement: () => ({}) as { rel?: string; href?: string },
      head: { appendChild: (l: { rel?: string; href?: string }) => links.push(`${l.rel} ${l.href}`) },
    };
    new Function("location", "document", routePreloadScript(map))({ pathname }, doc);
    return links;
  };
  for (const p of ["/", "/channel/x", "/settings", "/settings/a", "/admin", "/admin/b", "/sign-in", "/settingsx"]) {
    const group = routePreloadGroup(p);
    expect(run(p)).toEqual(group ? [`modulepreload /${map[group as keyof typeof map][0]}`] : []);
  }
});

test("collects group chunks with static deps, minus the entry closure", () => {
  const bundle = {
    entry: chunk("assets/index.js", ["/r/app/src/main.tsx"], ["assets/vendor-react.js"], { isEntry: true }),
    react: chunk("assets/vendor-react.js", ["/r/node_modules/react/index.js"]),
    sidebar: chunk("assets/shell-x.js", ["/r/app/src/components/settings/settings-sidebar.tsx"], ["assets/dep.js", "assets/vendor-react.js"]),
    dep: chunk("assets/dep.js", ["/r/app/src/lib/x.ts"]),
    route: chunk("assets/route-settings-y.js", ["/r/app/src/routes/_authed/settings.tsx"], [], { name: "route-settings" }),
  };
  const map = routePreloadMap(bundle as never);
  expect(map.settings).toEqual(["assets/dep.js", "assets/route-settings-y.js", "assets/shell-x.js"]);
});

test("skips tiny transitive fragment deps while keeping direct roots and large deps", () => {
  const largeCode = "x".repeat(MIN_PRELOAD_DEP_BYTES + 128);
  const tinyCode = "x".repeat(512);
  const bundle = {
    entry: chunk("assets/index.js", ["/r/app/src/main.tsx"], [], { isEntry: true, code: largeCode }),
    root: chunk("assets/route-settings-y.js", ["/r/app/src/routes/_authed/settings.tsx"], ["assets/large.js", "assets/tiny.js"], { name: "route-settings", code: tinyCode }),
    large: chunk("assets/large.js", ["/r/app/src/lib/large.ts"], [], { code: largeCode }),
    tiny: chunk("assets/tiny.js", ["/r/app/src/lib/tiny.ts"], [], { code: tinyCode }),
  };
  const map = routePreloadMap(bundle as never);
  expect(map.settings).toEqual(["assets/large.js", "assets/route-settings-y.js"]);
});