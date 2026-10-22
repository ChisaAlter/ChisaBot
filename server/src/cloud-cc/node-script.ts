/**
 * 「节点程序」的指纹（docs/cloud-claude-code.md §3.1）：云端节点容器里的 `chisabot-node.cjs` 只在启动时从服务器
 * 下载一次（deploy/cloud-node/entrypoint.sh），所以应用发版改了 `pc/src/cloud-cc` 之后，还在跑的节点进程一直是旧代码。
 * 2026-10-22 的「退出 Claude 无效」就是这么来的：服务器和网页都是新版，节点回的还是旧逻辑的答案。
 *
 * 服务器把「现在发出去的程序」的 sha256 随 `cc_probe` 发给节点；节点在 `cc_info` 里报自己在跑的那份的 sha256。
 * 两个不一样就是旧程序：页面提示、节点空闲时自己重启换程序（见 pc/src/cloud-cc 的 maybeSelfUpdate）。
 */
import { createHash } from "node:crypto";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const SHA256 = /^[a-f0-9]{64}$/i;

/**
 * 现在的节点程序指纹。每次网页刷新都读一遍 450 KB 没必要，缓存一分钟就够（发版后最迟一分钟认出新版本）。
 * 读不到（这个部署没打包节点程序）回 null：那就什么都不判断。
 */
export function createNodeScriptHash(source: () => Promise<Buffer | null>, ttlMs = 60_000) {
  let cached: { at: number; hash: string | null } | null = null;
  let inflight: Promise<string | null> | null = null;
  async function read(): Promise<string | null> {
    try {
      const bundle = await source();
      return bundle ? sha256Hex(bundle) : null;
    } catch {
      return null;
    }
  }
  return async function current(): Promise<string | null> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.hash;
    if (!inflight) {
      inflight = read()
        .then((hash) => {
          cached = { at: Date.now(), hash };
          return hash;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}

/** 节点报上来的指纹规整成小写 sha256；没有（旧版节点根本不报）回 null。 */
export function normalizeScript(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/**
 * 节点是不是在跑旧程序。
 * - 没有服务器指纹（这个部署没打包节点程序）→ 说不准，不提示；
 * - 节点还没报过（刚连上）→ 不提示；
 * - 节点报不出来（比这个功能还旧的程序）→ 旧，只能人工重启；
 * - 报的和现在的不一样 → 旧，可以点「重启节点」让它自己换。
 */
export function scriptIsStale(reported: string | null | undefined, current: string | null): boolean {
  if (!current) return false;
  if (reported === undefined) return false;
  return reported === null || reported !== current;
}
