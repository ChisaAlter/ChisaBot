import { gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/*
 * 打包分析（DESIGN.md §41.5）：`CHISABOT_BUNDLE_REPORT=1 bun run build` 时在 dist/ 写一份 bundle-report.json，
 * 平时不启用、不进产物。不引第三方可视化插件：要的只是「首屏要下哪些块、每块多大、大头是哪些模块」。
 *
 * - initial：入口块 + 它静态 import 的块（浏览器在首屏一定要下载执行的 JS），原始 / gzip 合计。
 * - chunks：每个块的大小、是否首屏、静态 / 动态依赖、体积最大的 15 个模块（按源码包名合并）。
 * - packages：首屏块里按 npm 包（或 src/ 目录）合计的渲染后体积，从大到小。
 * - why：首屏最大的几个包，各自从入口一路静态 import 进来的最短链（回答「它为什么在首屏」）。
 */
type ChunkReport = {
  file: string;
  bytes: number;
  gzip: number;
  initial: boolean;
  isEntry: boolean;
  isDynamicEntry: boolean;
  imports: string[];
  dynamicImports: string[];
  topModules: Array<{ id: string; bytes: number }>;
};

export function moduleGroup(id: string): string {
  const normalized = id.replaceAll("\\", "/").split("?")[0] ?? id;
  const nm = normalized.lastIndexOf("/node_modules/");
  if (nm !== -1) {
    const rest = normalized.slice(nm + "/node_modules/".length).split("/");
    return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : (rest[0] ?? normalized);
  }
  const src = normalized.lastIndexOf("/src/");
  if (src !== -1) {
    const rest = normalized.slice(src + 1).split("/");
    return rest.slice(0, Math.min(3, rest.length - 1)).join("/") || normalized;
  }
  return normalized;
}

export function bundleReport(): Plugin {
  return {
    name: "chisabot-bundle-report",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const initial = new Set<string>();
      const visit = (file: string) => {
        if (initial.has(file)) return;
        initial.add(file);
        for (const next of byFile.get(file)?.imports ?? []) visit(next);
      };
      for (const chunk of chunks) if (chunk.isEntry) visit(chunk.fileName);

      const packages = new Map<string, number>();
      const report: ChunkReport[] = chunks.map((chunk) => {
        const groups = new Map<string, number>();
        for (const [id, info] of Object.entries(chunk.modules)) {
          const group = moduleGroup(id);
          groups.set(group, (groups.get(group) ?? 0) + info.renderedLength);
          if (initial.has(chunk.fileName)) packages.set(group, (packages.get(group) ?? 0) + info.renderedLength);
        }
        return {
          file: chunk.fileName,
          bytes: Buffer.byteLength(chunk.code),
          gzip: gzipSync(chunk.code).length,
          initial: initial.has(chunk.fileName),
          isEntry: chunk.isEntry,
          isDynamicEntry: chunk.isDynamicEntry,
          imports: chunk.imports,
          dynamicImports: chunk.dynamicImports,
          topModules: [...groups.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([id, bytes]) => ({ id, bytes })),
        };
      });
      report.sort((a, b) => b.bytes - a.bytes);

      // 从入口模块沿静态 import 做 BFS，记下每个模块是被谁第一次带进来的。
      const parent = new Map<string, string | null>();
      const queue: string[] = [];
      for (const chunk of chunks) {
        if (chunk.isEntry && chunk.facadeModuleId) {
          parent.set(chunk.facadeModuleId, null);
          queue.push(chunk.facadeModuleId);
        }
      }
      while (queue.length > 0) {
        const id = queue.shift() as string;
        for (const next of this.getModuleInfo(id)?.importedIds ?? []) {
          if (!parent.has(next)) {
            parent.set(next, id);
            queue.push(next);
          }
        }
      }
      const chainOf = (id: string) => {
        const chain: string[] = [];
        for (let at: string | null | undefined = id; at; at = parent.get(at)) {
          const short = at.replaceAll("\\", "/").replace(/^.*?\/(app\/src|shared|node_modules)\//, "$1/");
          chain.unshift(short.split("?")[0] ?? short);
        }
        return chain;
      };
      const why: Record<string, string[]> = {};
      for (const [group] of [...packages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
        const first = [...parent.keys()].find((id) => moduleGroup(id) === group);
        if (first) why[group] = chainOf(first);
      }
      /*
       * `CHISABOT_BUNDLE_TRACE=settings-sidebar,left-rail`（逗号分隔，各算各的）：从 id 含这个字的模块出发沿静态 import 走一遍，按落在哪个块分组，
       * 每块列几个被带到的模块和最短链——回答「这个按需块为什么一加载就把那个大块也拖下来」。
       */
      const traceKeys = (process.env.CHISABOT_BUNDLE_TRACE ?? "").split(",").filter(Boolean);
      const trace: Record<string, Record<string, Array<{ module: string; chain: string[] }>>> = {};
      for (const traceKey of traceKeys) {
        const perKey: Record<string, Array<{ module: string; chain: string[] }>> = {};
        trace[traceKey] = perKey;
        // 只走真正进了产物的模块（renderedLength > 0）：桶文件（@tabler/icons-react 那种 re-export 全部图标）摇树后是空的，不算。
        const chunkOf = new Map<string, string>();
        for (const chunk of chunks) {
          for (const [id, info] of Object.entries(chunk.modules)) if (info.renderedLength > 0) chunkOf.set(id, chunk.fileName);
        }
        const short = (id: string) => (id.replaceAll("\\", "/").replace(/^.*?\/(app\/src|shared|node_modules)\//, "$1/").split("?")[0] ?? id);
        const from = new Map<string, string | null>();
        const todo: string[] = [];
        for (const id of this.getModuleIds()) {
          if (id.replaceAll("\\", "/").includes(traceKey) && chunkOf.has(id)) {
            from.set(id, null);
            todo.push(id);
          }
        }
        while (todo.length > 0) {
          const id = todo.shift() as string;
          for (const next of this.getModuleInfo(id)?.importedIds ?? []) {
            if (!from.has(next) && chunkOf.has(next)) {
              from.set(next, id);
              todo.push(next);
            }
          }
        }
        for (const id of from.keys()) {
          const file = chunkOf.get(id);
          if (!file) continue;
          const list = (perKey[file] ??= []);
          if (list.length >= 6) continue;
          const chain: string[] = [];
          for (let at: string | null | undefined = id; at; at = from.get(at)) chain.unshift(short(at));
          list.push({ module: short(id), chain });
        }
      }
      /*
       * `CHISABOT_BUNDLE_EDGES=shell`：名字含这个字的块里，哪些模块静态 import 了别的块里的模块——回答「这块为什么
       * 依赖那块」。只列跨块的边，按目标块分组。
       */
      const edgeKeys = (process.env.CHISABOT_BUNDLE_EDGES ?? "").split(",").filter(Boolean);
      const edges: Record<string, Record<string, string[]>> = {};
      if (edgeKeys.length > 0) {
        const chunkOf = new Map<string, string>();
        for (const chunk of chunks) for (const id of Object.keys(chunk.modules)) chunkOf.set(id, chunk.fileName);
        const short = (id: string) => (id.replaceAll("\\", "/").replace(/^.*?\/(app\/src|shared|node_modules)\//, "$1/").split("?")[0] ?? id);
        for (const chunk of chunks) {
          if (!edgeKeys.some((key) => chunk.fileName.includes(key))) continue;
          const out: Record<string, string[]> = {};
          for (const id of Object.keys(chunk.modules)) {
            for (const next of this.getModuleInfo(id)?.importedIds ?? []) {
              const target = chunkOf.get(next);
              if (!target || target === chunk.fileName) continue;
              (out[target] ??= []).push(`${short(id)} -> ${short(next)}`);
            }
          }
          edges[chunk.fileName] = out;
        }
      }
      const first = report.filter((chunk) => chunk.initial);
      const summary = {
        initial: {
          files: first.map((chunk) => chunk.file),
          bytes: first.reduce((sum, chunk) => sum + chunk.bytes, 0),
          gzip: first.reduce((sum, chunk) => sum + chunk.gzip, 0),
        },
        packages: [...packages.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 80)
          .map(([id, bytes]) => ({ id, bytes })),
        why,
        ...(traceKeys.length > 0 ? { trace } : {}),
        ...(edgeKeys.length > 0 ? { edges } : {}),
        chunks: report,
      };
      this.emitFile({ type: "asset", fileName: "bundle-report.json", source: `${JSON.stringify(summary, null, 1)}\n` });
    },
  };
}