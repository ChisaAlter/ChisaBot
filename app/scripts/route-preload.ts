/**
 * 按入口路径预载首屏的懒加载块（DESIGN.md §41.5）。
 *
 * 首屏外壳（左栏、聊天页、设置侧栏……）都是懒加载的，入口块只带路由和骨架。不预载的话，
 * 浏览器要等入口执行完、路由匹配完、React 渲染到那个懒组件，才发现还要下这些块——一串瀑布。
 * 这里在构建时找出每类页面首屏一定会用到的块（含它们的静态依赖），往 index.html 里放一段很小的
 * 内联脚本：按 location.pathname 选一组，插 <link rel="modulepreload">，和入口块并行下载。
 * 内联脚本的 CSP 哈希由 csp 插件按最终 HTML 统一算，这里不用管。
 */
import type { Plugin, Rollup } from "vite";

type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

/**
 * 每组：首屏一定会渲染的模块（路径后缀），或者 `chunk:名字`（vite.config.ts 里手动分的路由块）。
 * 找出对应的块，再带上这些块的静态依赖。
 */
export const ROUTE_PRELOAD_GROUPS: Record<string, string[]> = {
  chat: [
    "chunk:route-shell",
    "src/routes/_authed/_app/channel/$channelId.tsx",
    "src/components/channels/channel-page.tsx",
    "src/lib/copilot/provider.tsx",
    "src/components/layout/left-rail.tsx",
    "src/components/panels/panel-rail.tsx",
  ],
  settings: [
    "chunk:route-shell",
    "chunk:route-settings",
    "src/components/settings/settings-sidebar.tsx",
    "src/components/panels/panel-rail.tsx",
  ],
  admin: [
    "chunk:route-shell",
    "chunk:route-admin",
    "src/components/admin/admin-sidebar.tsx",
    "src/components/panels/panel-rail.tsx",
  ],
};

/** 路径 → 组。只认这几个首屏；其余路径（登录页、分享页……）不预载任何东西。 */
export function routePreloadGroup(pathname: string): string | null {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  if (pathname === "/" || pathname === "/channel" || pathname.startsWith("/channel/")) return "chat";
  return null;
}

/** 生成内联脚本。map：组 → 要预载的文件（相对站点根，例如 "assets/x.js"）。 */
export function routePreloadScript(map: Record<string, string[]>): string {
  // 和 routePreloadGroup 同一套规则（测试里逐条对照）；手写成 ES5 是为了不依赖构建工具怎么序列化函数。
  return `(function(){var m=${JSON.stringify(map)};var p=location.pathname;function u(b){return p===b||p.indexOf(b+"/")===0}var k=u("/settings")?"settings":u("/admin")?"admin":p==="/"||u("/channel")?"chat":"";var g=m[k];if(!g)return;for(var i=0;i<g.length;i++){var l=document.createElement("link");l.rel="modulepreload";l.href="/"+g[i];document.head.appendChild(l)}})();`;
}

function normalize(id: string): string {
  return id.replaceAll("\\", "/");
}

/** 构建产物里：每组要预载的块（去掉入口已经静态带上的）。 */
export function routePreloadMap(bundle: OutputBundle): Record<string, string[]> {
  const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk");
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const initial = new Set<string>();
  const addStatic = (file: string, into: Set<string>) => {
    if (into.has(file)) return;
    into.add(file);
    for (const dep of byFile.get(file)?.imports ?? []) addStatic(dep, into);
  };
  for (const c of chunks) if (c.isEntry) addStatic(c.fileName, initial);

  const map: Record<string, string[]> = {};
  for (const [group, suffixes] of Object.entries(ROUTE_PRELOAD_GROUPS)) {
    const files = new Set<string>();
    for (const suffix of suffixes) {
      const owner = suffix.startsWith("chunk:")
        ? chunks.find((c) => c.name === suffix.slice("chunk:".length))
        : chunks.find((c) => c.moduleIds.some((id) => normalize(id).endsWith(`/app/${suffix}`)));
      if (owner) addStatic(owner.fileName, files);
    }
    map[group] = [...files].filter((f) => !initial.has(f)).sort();
  }
  return map;
}

export function routePreload(): Plugin {
  return {
    name: "chisabot-route-preload",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html;
        const script = `<script>${routePreloadScript(routePreloadMap(ctx.bundle))}</script>`;
        const at = html.indexOf('<script type="module"');
        return at < 0 ? html.replace("</head>", `${script}</head>`) : html.slice(0, at) + script + html.slice(at);
      },
    },
  };
}