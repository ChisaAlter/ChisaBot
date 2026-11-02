import { BlockList, isIP } from "node:net";

/**
 * 服务器替用户去取一个网址时（链接预览卡、预览截图），哪些地址绝不能碰（防 SSRF）。
 *
 * 只做「这个主机名 / 这个 IP 能不能连」的判断，不发请求、不查 DNS，所以能单测。真正发请求的是
 * `guarded-fetch.ts`：它先解析 DNS，把这里判过的地址钉死再连，每一跳重定向重新判一遍。
 *
 * 拦的范围：本机、内网、运营商 NAT、链路本地（云厂商元数据 169.254.169.254 / fd00:ec2::254）、
 * 文档 / 测试 / 保留段、组播、广播；IPv6 里藏着 IPv4 的写法（::ffff:a.b.c.d、::a.b.c.d、NAT64
 * 64:ff9b::/96）先取出里面的 IPv4 再判；6to4 2002::/16、Teredo 2001::/32 整段拦。
 */

const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8], // 本网络 / 「任意地址」
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // 运营商 NAT（阿里云元数据 100.100.100.200 也在里面）
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // 链路本地，云元数据
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // 组播
  ["240.0.0.0", 4], // 保留 + 255.255.255.255
];

const V6_BLOCKED: readonly [string, number][] = [
  ["::", 96], // 未指定、::1、已废弃的 IPv4 兼容写法
  ["64:ff9b:1::", 48], // 本地用 NAT64
  ["100::", 64], // 丢弃
  ["2001::", 32], // Teredo（隧道，里面的 IPv4 不可信）
  ["2001:db8::", 32], // 文档
  ["2002::", 16], // 6to4（隧道，同上）
  ["fc00::", 7], // 唯一本地（含 fd00:ec2::254）
  ["fe80::", 10], // 链路本地
  ["fec0::", 10], // 旧站点本地
  ["ff00::", 8], // 组播
];

/**
 * 自托管 IM 协议端的「放行内网」名单（RV-01 放宽项）：管理员给某个连接显式开了「允许内网地址」后，
 * 那个连接自己配置的协议端可以指向本机 / RFC1918。除此之外一切照拦——尤其是云元数据
 * （169.254.0.0/16 整段、阿里 100.64.0.0/10、AWS IPv6 元数据 fd00:ec2::254、GCP fd20:ce::254），
 * 就算开关开着也绝不放行。ULA fc00::/7 也整段拦：云厂商的 IPv6 元数据地址就住在里面，
 * 放行它等于把开关变成元数据后门；IPv6 内网协议端请走反向 WebSocket。
 */
const V4_BLOCKED_ALLOW_PRIVATE: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["100.64.0.0", 10],
  ["169.254.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const V6_BLOCKED_ALLOW_PRIVATE: readonly [string, number][] = [
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7], // 唯一本地整段：云厂商 IPv6 元数据住在里面（fd00:ec2::254、fd20:ce::254），不能放
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

const v4List = new BlockList();
for (const [address, prefix] of V4_BLOCKED)
  v4List.addSubnet(address, prefix, "ipv4");
const v6List = new BlockList();
for (const [address, prefix] of V6_BLOCKED)
  v6List.addSubnet(address, prefix, "ipv6");

const v4PrivateList = new BlockList();
for (const [address, prefix] of V4_BLOCKED_ALLOW_PRIVATE)
  v4PrivateList.addSubnet(address, prefix, "ipv4");
const v6PrivateList = new BlockList();
for (const [address, prefix] of V6_BLOCKED_ALLOW_PRIVATE)
  v6PrivateList.addSubnet(address, prefix, "ipv6");
// ::/96 整段放行了（::1 是回环）：单拦未指定地址（云元数据特例已由 fc00::/7 兜住）。
v6PrivateList.addAddress("::", "ipv6");

/** 把任意写法的 IPv6 展开成 8 组 16 位数字；不是 IPv6 返回 null。 */
export function expandIpv6(input: string): number[] | null {
  let address = input
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (isIP(address) !== 6) return null;
  // 末尾是点分 IPv4（::ffff:1.2.3.4）先换成两组十六进制。
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const parts = dotted[1]!.split(".").map(Number);
    const hex = `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
    address = address.slice(0, dotted.index) + hex;
  }
  const [head = "", tail] = address.split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const all =
    tail === undefined
      ? groups(head)
      : [
          ...groups(head),
          ...Array(8 - groups(head).length - groups(tail).length).fill("0"),
          ...groups(tail),
        ];
  if (all.length !== 8) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

function v4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** IPv6 里装着的那个 IPv4（映射、翻译、NAT64、已废弃的兼容写法；6to4 / Teredo 整段直接拦），没有就 null。 */
export function embeddedIpv4(address: string): string | null {
  const g = expandIpv6(address);
  if (!g) return null;
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every((n) => n === 0);
  // ::ffff:a.b.c.d（映射）与 ::ffff:0:a.b.c.d（翻译）
  if (zeros(0, 5) && g[5] === 0xffff) return v4FromGroups(g[6]!, g[7]!);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0)
    return v4FromGroups(g[6]!, g[7]!);
  // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))
    return v4FromGroups(g[6]!, g[7]!);
  // ::a.b.c.d（IPv4 兼容，已废弃；内网放行模式里 ::/96 不再整段拦，要把里面的 IPv4 取出来判）。
  // :: 和 ::1 不是兼容写法（未指定 / 回环），别错认成 IPv4。
  if (zeros(0, 6) && (g[6] !== 0 || (g[7] ?? 0) > 1))
    return v4FromGroups(g[6] ?? 0, g[7] ?? 0);
  return null;
}

/** 这个 IP 是不是不能连（内网、本机、元数据、保留……）。不是合法 IP 的一律当作不能连。 */
export function isBlockedAddress(input: string): boolean {
  const address = input.trim().replace(/^\[|\]$/g, "");
  const version = isIP(address.split("%")[0] ?? "");
  if (version === 4) return v4List.check(address, "ipv4");
  if (version !== 6) return true;
  const clean = address.split("%")[0]!;
  const v4 = embeddedIpv4(clean);
  if (v4 !== null && v4List.check(v4, "ipv4")) return true;
  return v6List.check(clean, "ipv6");
}

/**
 * 「允许内网地址」开关下的 IP 判定：本机 / RFC1918 / IPv6 回环可以连（自托管协议端在同机、局域网、
 * Docker 兄弟容器），云元数据（含 ULA 里的 IPv6 元数据）、链路本地、组播、保留段照样拦——开关开着也够不到它们。
 */
export function isBlockedAddressAllowPrivate(input: string): boolean {
  const address = input.trim().replace(/^\[|\]$/g, "");
  const version = isIP(address.split("%")[0] ?? "");
  if (version === 4) return v4PrivateList.check(address, "ipv4");
  if (version !== 6) return true;
  const clean = address.split("%")[0] ?? "";
  const v4 = embeddedIpv4(clean);
  if (v4 !== null && v4PrivateList.check(v4, "ipv4")) return true;
  return v6PrivateList.check(clean, "ipv6");
}

/** 一看名字就知道是内网的主机名（不查 DNS 也能拒）。 */
export function isBlockedHostname(input: string): boolean {
  const host = input.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (isIP(host.replace(/^\[|\]$/g, ""))) return isBlockedAddress(host);
  if (!host.includes(".")) return true; // 单段名字（localhost、intranet、容器名）只会是内网
  return (
    host === "localhost" ||
    /\.(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(
      host,
    ) ||
    host === "metadata.google.internal"
  );
}

/**
 * 「允许内网地址」开关下的主机名判定：单段容器名、localhost、.internal 这类名字放行——它们指向哪由
 * DNS 说了算，解析结果仍过 {@link isBlockedAddressAllowPrivate}；云元数据主机名照样拦。
 */
export function isBlockedHostnameAllowPrivate(input: string): boolean {
  const host = input.trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return true;
  if (isIP(host.replace(/^\[|\]$/g, "")))
    return isBlockedAddressAllowPrivate(host);
  return host === "metadata.google.internal";
}

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** 只放行 http / https、没有账号密码、主机名不是内网的网址。DNS 之后的检查由 guarded-fetch 做。 */
export function checkPublicUrl(
  raw: string,
  opts?: { allowPrivate?: boolean },
): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "不是有效的网址" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "只支持 http / https 网址" };
  if (url.username || url.password)
    return { ok: false, reason: "网址里不能带账号密码" };
  const blockedHost = opts?.allowPrivate
    ? isBlockedHostnameAllowPrivate(url.hostname)
    : isBlockedHostname(url.hostname);
  if (blockedHost) return { ok: false, reason: "不能访问内网地址" };
  return { ok: true, url };
}
