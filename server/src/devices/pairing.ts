import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

/**
 * 手机扫码绑定（docs/pc-node.md §10，DESIGN.md §33）。
 *
 * 网页「设置 → 设备 → 绑定手机」向这里要一个**一次性、短时效**的绑定码，画成二维码；
 * 手机扫码后拿绑定码换设备令牌（/api/devices/agent/pair）。规则：
 *  - 绑定码形如 `cbp_<32 位 base64url>`（192 bit），只存 SHA-256；明文只在签发时返回一次；
 *  - 默认 5 分钟过期，用一次就作废（无论成功与否，换取成功后状态变为「已绑定」）；
 *  - 绑定码属于签发它的人：换出来的设备登记在这个人名下；
 *  - 每人同时最多 {@link MAX_PENDING_PER_OWNER} 个未用的码（网页自动刷新时旧码作废），全局上限防止被刷满内存。
 *
 * 只放在内存里：码本来就只活 5 分钟，服务重启后旧码失效，网页弹窗会自动换新码。
 */

export const PAIRING_CODE_PREFIX = "cbp_";
export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PENDING_PER_OWNER = 3;
const MAX_ENTRIES = 2000;
/** 已绑定 / 过期的记录再留一会儿，网页轮询能看到最终状态。 */
const KEEP_AFTER_MS = 10 * 60_000;

export type PairingState = "pending" | "bound" | "expired" | "cancelled";

export type PairingStatus = {
  id: string;
  state: PairingState;
  expiresAt: string;
  device: { id: string; name: string } | null;
};

type Entry = {
  id: string;
  ownerUserId: string;
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  endedAt: number | null;
  state: "pending" | "redeeming" | "bound" | "cancelled";
  device: { id: string; name: string } | null;
  /** phone = 手机扫码；node = 服务器节点（chisabot-node 安装命令里的一次性码，docs/pc-node.md §14）。 */
  kind: PairingKind;
};

export type PairingKind = "phone" | "node";
/** 服务器节点的安装码多给点时间（复制命令、登录服务器、粘贴）。 */
export const NODE_PAIRING_TTL_MS = 30 * 60_000;

export type RedeemResult =
  | { ok: true; pairingId: string; ownerUserId: string; kind: PairingKind }
  | { ok: false; reason: "invalid" | "expired" | "used" };

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function sameHash(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isPairingCode(value: unknown): value is string {
  return typeof value === "string" && /^cbp_[A-Za-z0-9_-]{32}$/.test(value);
}

export function createPairingStore(
  options: { now?: () => number; ttlMs?: number; nodeTtlMs?: number } = {},
) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? PAIRING_TTL_MS;
  const entries = new Map<string, Entry>();
  const byHash = new Map<string, string>();

  function stateOf(entry: Entry): PairingState {
    if (entry.state === "bound") return "bound";
    if (entry.state === "cancelled") return "cancelled";
    if (entry.expiresAt <= now()) return "expired";
    return "pending";
  }

  function drop(entry: Entry) {
    entries.delete(entry.id);
    byHash.delete(entry.codeHash);
  }

  function sweep() {
    const time = now();
    for (const entry of entries.values()) {
      if (entry.state === "redeeming") continue;
      const end = entry.endedAt ?? entry.expiresAt;
      if (end + KEEP_AFTER_MS <= time) drop(entry);
    }
  }

  function view(entry: Entry): PairingStatus {
    return {
      id: entry.id,
      state: stateOf(entry),
      expiresAt: new Date(entry.expiresAt).toISOString(),
      device: entry.device,
    };
  }

  return {
    /** 签发一个新码。返回的 code 只在这里出现一次。 */
    issue(
      ownerUserId: string,
      kind: PairingKind = "phone",
    ): { id: string; code: string; expiresAt: string; ttlSeconds: number } {
      sweep();
      // 同一个人的旧的未用码：超过上限时从最旧的开始作废（网页每 5 分钟自动换码）。
      const pending = [...entries.values()]
        .filter(
          (entry) =>
            entry.ownerUserId === ownerUserId &&
            entry.kind === kind &&
            entry.state === "pending" &&
            entry.expiresAt > now(),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      while (pending.length >= MAX_PENDING_PER_OWNER) {
        const oldest = pending.shift();
        if (oldest) {
          oldest.state = "cancelled";
          oldest.endedAt = now();
        }
      }
      if (entries.size >= MAX_ENTRIES) {
        // 全局上限：先丢掉已结束的，再丢最旧的。
        const sorted = [...entries.values()].sort((a, b) => {
          const aDone = stateOf(a) !== "pending" ? 0 : 1;
          const bDone = stateOf(b) !== "pending" ? 0 : 1;
          if (aDone !== bDone) return aDone - bDone;
          return a.createdAt - b.createdAt;
        });
        for (const entry of sorted) {
          if (entries.size < MAX_ENTRIES) break;
          if (entry.state !== "redeeming") drop(entry);
        }
      }
      const code = PAIRING_CODE_PREFIX + randomBytes(24).toString("base64url");
      const id = `pair_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const life =
        kind === "node"
          ? Math.max(ttl, options.nodeTtlMs ?? NODE_PAIRING_TTL_MS)
          : ttl;
      const entry: Entry = {
        id,
        ownerUserId,
        codeHash: hash(code),
        createdAt: now(),
        expiresAt: now() + life,
        endedAt: null,
        state: "pending",
        device: null,
        kind,
      };
      entries.set(id, entry);
      byHash.set(entry.codeHash, id);
      return {
        id,
        code,
        expiresAt: new Date(entry.expiresAt).toISOString(),
        ttlSeconds: Math.round(life / 1000),
      };
    },

    /** 只有签发人能看自己码的状态。 */
    status(id: string, ownerUserId: string): PairingStatus | null {
      const entry = entries.get(id);
      if (!entry || entry.ownerUserId !== ownerUserId) return null;
      return view(entry);
    },

    cancel(id: string, ownerUserId: string): boolean {
      const entry = entries.get(id);
      if (
        !entry ||
        entry.ownerUserId !== ownerUserId ||
        entry.state !== "pending"
      )
        return false;
      entry.state = "cancelled";
      entry.endedAt = now();
      return true;
    },

    /**
     * 手机拿码来换：成功则码立刻被占用（state = redeeming），之后必须 {@link complete} 或 {@link fail}。
     * 同一个码第二次来 = used。
     */
    redeem(code: unknown): RedeemResult {
      if (!isPairingCode(code)) return { ok: false, reason: "invalid" };
      const codeHash = hash(code);
      const id = byHash.get(codeHash);
      const entry = id ? entries.get(id) : undefined;
      if (!entry || !sameHash(entry.codeHash, codeHash))
        return { ok: false, reason: "invalid" };
      if (entry.state === "bound" || entry.state === "redeeming")
        return { ok: false, reason: "used" };
      if (entry.state === "cancelled" || entry.expiresAt <= now())
        return { ok: false, reason: "expired" };
      entry.state = "redeeming";
      return {
        ok: true,
        pairingId: entry.id,
        ownerUserId: entry.ownerUserId,
        kind: entry.kind,
      };
    },

    complete(pairingId: string, device: { id: string; name: string }) {
      const entry = entries.get(pairingId);
      if (!entry) return;
      entry.state = "bound";
      entry.endedAt = now();
      entry.device = { id: device.id, name: device.name };
    },

    /** 登记设备失败（数据库出错等）：码作废，网页会自动换新码。 */
    fail(pairingId: string) {
      const entry = entries.get(pairingId);
      if (entry && entry.state === "redeeming") {
        entry.state = "cancelled";
        entry.endedAt = now();
      }
    },

    size: () => entries.size,
  };
}

export type PairingStore = ReturnType<typeof createPairingStore>;

export {
  isMobilePlatform,
  MOBILE_ONLINE_WINDOW_MS,
  pairingUri,
} from "../../../shared/devices";
