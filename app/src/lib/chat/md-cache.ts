/**
 * Streamdown 块级解析缓存（卡顿修复 P1-4）。
 *
 * 问题：切会话时 transcript 重新挂载，Streamdown 内部的 `Block` 对每一块都重跑
 * `unified().parse + runSync`（remark → rehype → harden），4x 降速下约 1.7s，占切换时 React 时间的 44%。
 * Streamdown 自己的 `memo` 只在**同一次挂载内**跳过没变的块，挂载一换就全部重来。
 *
 * 做法：Streamdown 允许传 `rehypePlugins`，unified 在 freeze 时以**处理器本身**作 `this` 调用插件。
 * 我们在插件列表最后挂一个不做变换的插件，借机把这个处理器的 `parse` / `runSync` 包一层：
 * 同一套插件、同一段块文本，第二次起直接拿缓存的 hast（结构化拷贝，避免下游改到缓存）。
 * 解析之后的 hast → JSX 仍由 Streamdown 自己完成，所以输出和不缓存时逐字节相同。
 *
 * 键 = 插件集签名 + 块文本全文（Map 的字符串键，不会有哈希碰撞）。消息 id 不进键：
 * 同一段文字在哪条消息里解析结果都一样，进了反而降低命中。
 *
 * 流式：正在变长的末块不入缓存（否则每个 token 一条，几秒就把 LRU 冲掉），只查不存；
 * 前面已经定型的块照常入缓存。
 *
 * 代码高亮：本应用没有给 Streamdown 配 `plugins.code`，代码块不经过 shiki，没有高亮结果可缓存；
 * 代码块本身的 hast 随块一起缓存。
 */
import { createContext } from "react";

/** 缓存格式版本：hast 形状或插件行为有变时加一，旧条目自动失效。 */
const VERSION = "1";

/** 容量上限：条目数和块文本总字数，任一超出就从最久没用的开始淘汰。 */
export const MD_CACHE_MAX_ENTRIES = 2000;
export const MD_CACHE_MAX_CHARS = 600_000;

/** 缓存的是 hast 根节点；这里不依赖 @types/hast，只当不透明对象存取。 */
type Root = { type: string; children: unknown[] };

type Entry = { hast: Root; chars: number };

export class LruCache {
  private map = new Map<string, Entry>();
  private chars = 0;
  hits = 0;
  misses = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxChars: number,
  ) {}
  get size() {
    return this.map.size;
  }
  get totalChars() {
    return this.chars;
  }
  get(key: string): Root | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    // 刷新为最近使用。
    this.map.delete(key);
    this.map.set(key, e);
    return e.hast;
  }
  has(key: string) {
    return this.map.has(key);
  }
  set(key: string, hast: Root, chars: number) {
    if (chars > this.maxChars) return;
    const old = this.map.get(key);
    if (old) {
      this.chars -= old.chars;
      this.map.delete(key);
    }
    this.map.set(key, { hast, chars });
    this.chars += chars;
    while (this.map.size > this.maxEntries || this.chars > this.maxChars) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const e = this.map.get(oldest);
      this.map.delete(oldest);
      if (e) this.chars -= e.chars;
    }
  }
  clear() {
    this.map.clear();
    this.chars = 0;
    this.hits = 0;
    this.misses = 0;
  }
}

/** 模块级：跨挂载、跨会话共享。 */
export const mdCache = new LruCache(MD_CACHE_MAX_ENTRIES, MD_CACHE_MAX_CHARS);

const HIT = "__chisabotMdCacheHit";

type Attacher = [unknown, ...unknown[]];
type Proc = {
  attachers?: Attacher[];
  parse: (doc: unknown) => unknown;
  runSync: (tree: unknown, file?: unknown) => unknown;
};

const patched = new WeakSet<object>();

// 插件按函数实例编号，而不是按 name（生产构建会把函数名压成一两个字母，可能撞名）。
const fnIds = new WeakMap<object, number>();
let nextFnId = 0;
function pluginName(p: unknown) {
  if (typeof p !== "function") return String(p);
  let id = fnIds.get(p);
  if (id === undefined) {
    id = ++nextFnId;
    fnIds.set(p, id);
  }
  return `f${id}`;
}

/** 处理器上挂了哪些插件、什么参数：同签名的处理器产出同样的 hast。 */
function signatureOf(proc: Proc) {
  // 自己（store / probe 两种参数）不进签名：两种变体要读同一份缓存。
  const own = (proc.attachers ?? []).filter(([fn]) => fn !== streamdownMdCache);
  const parts = own.map(([fn, ...opts]) => {
    let o = "";
    try {
      o = JSON.stringify(opts);
    } catch {
      o = "?";
    }
    return `${pluginName(fn)}:${o}`;
  });
  return `${VERSION}|${parts.join(",")}`;
}

function clone<T>(v: T): T | undefined {
  try {
    return structuredClone(v);
  } catch {
    return undefined;
  }
}

export type MdCacheOptions = { store: boolean };

/**
 * 不做变换的 rehype「插件」：只给它所在的处理器包上缓存。
 * `store: false` 用于正在流式变长的末块：查缓存，但不写。
 */
export function streamdownMdCache(this: unknown, options?: MdCacheOptions) {
  const proc = this as Proc;
  if (!proc || typeof proc.parse !== "function" || patched.has(proc)) return;
  patched.add(proc);
  const store = options?.store !== false;
  const sig = signatureOf(proc);
  const parse = proc.parse.bind(proc);
  const runSync = proc.runSync.bind(proc);
  proc.parse = (doc: unknown) => {
    if (typeof doc === "string") {
      const cached = mdCache.get(`${sig}\u0000${doc}`);
      if (cached) {
        const copy = clone(cached);
        if (copy) return { type: "root", children: [], data: { [HIT]: copy } };
      }
    }
    return parse(doc);
  };
  proc.runSync = (tree: unknown, file?: unknown) => {
    const hit = (tree as { data?: Record<string, unknown> } | null)?.data?.[
      HIT
    ];
    if (hit) return hit;
    const out = runSync(tree, file);
    if (store && typeof file === "string") {
      const copy = clone(out as Root);
      if (copy) mdCache.set(`${sig}\u0000${file}`, copy, file.length);
    }
    return out;
  };
}

type PluginList = unknown[];
const variants = new WeakMap<
  PluginList,
  { store: PluginList; probe: PluginList }
>();
const EMPTY: PluginList = [];

/** 给同一个插件数组返回稳定的两种变体（Block 的 memo 按引用比较 rehypePlugins）。 */
export function withMdCache<T>(plugins: T[] | undefined, store: boolean): T[] {
  const base = (plugins ?? EMPTY) as PluginList;
  let v = variants.get(base);
  if (!v) {
    v = {
      store: [...base, [streamdownMdCache, { store: true }]],
      probe: [...base, [streamdownMdCache, { store: false }]],
    };
    variants.set(base, v);
  }
  return (store ? v.store : v.probe) as T[];
}

/**
 * 由 SmoothStreamdown 提供：这次挂载里内容是否还在变长（live），以及当前一共几块。
 * 只有 live 时的最后一块不入缓存。
 */
export type MdTail = { live: boolean; count: number };
export const MdTailContext = createContext<MdTail | null>(null);
