/**
 * 远程执行节点纯网络与地址校验原语（无凭据、无连接器依赖）。
 * 供 `computer/provider.ts` 与 `admin/execution-node-store.ts` 共用，保持 `server/src/computer/` 边界纯净。
 */

import {
  BlockedUrlError,
  resolvePublic,
} from "../../../shared/net/guarded-fetch";
import {
  checkPublicUrl,
  isBlockedAddress,
  isBlockedAddressAllowPrivate,
} from "../../../shared/net/ssrf";

export class ExecutionNodeError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "ExecutionNodeError";
    this.status = status;
  }
}

export type ActiveExecutionNode = {
  id: string;
  name: string;
  baseUrl: string;
  token?: string;
  allowPrivateNetwork: boolean;
};

export function validateExecutionNodeUrl(
  rawUrl: unknown,
  allowPrivateNetwork: boolean,
): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new ExecutionNodeError("执行节点地址不能为空。", 400);
  }
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ExecutionNodeError("执行节点地址不是有效的 URL。", 400);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /%2f|%5c|%2e/i.test(parsed.pathname)
  ) {
    throw new ExecutionNodeError(
      "执行节点地址必须是干净的 http(s) 地址（不能含账密、查询串或编码穿越）。",
      400,
    );
  }
  if (parsed.protocol !== "https:" && !allowPrivateNetwork) {
    throw new ExecutionNodeError(
      "非私网节点必须使用 HTTPS，或显式勾选「允许内网 / 专网节点」。",
      400,
    );
  }
  // 即使勾选允许私网，也始终拒绝云元数据地址（169.254.169.254 等）
  const verdict = checkPublicUrl(parsed.href, {
    allowPrivate: allowPrivateNetwork,
  });
  if (!verdict.ok) {
    throw new ExecutionNodeError(
      `执行节点地址未通过安全校验：${verdict.reason}`,
      400,
    );
  }
  return parsed.href.replace(/\/+$/, "");
}

export type ExecutionNodeDnsResolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

/**
 * 探活与连接前执行真实 DNS 校验（防域名解析到云元数据 169.254.169.254 / fd00:ec2::254
 * 或在 allowPrivateNetwork=false 时解析到私网地址绕过字面量检查）。
 */
export async function assertExecutionNodeDnsSafe(
  rawUrl: string,
  allowPrivateNetwork: boolean,
  resolveDns?: ExecutionNodeDnsResolver,
): Promise<{ url: string; address: string; family: number }> {
  const normalized = validateExecutionNodeUrl(rawUrl, allowPrivateNetwork);
  const parsed = new URL(normalized);
  try {
    const resolved = await resolvePublic(parsed.hostname, {
      isBlocked: allowPrivateNetwork
        ? isBlockedAddressAllowPrivate
        : isBlockedAddress,
      ...(resolveDns ? { resolve: resolveDns } : {}),
    });
    return {
      url: normalized,
      address: resolved.address,
      family: resolved.family,
    };
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      throw new ExecutionNodeError(
        `执行节点地址 DNS 解析命中禁止网段（云元数据/链路本地或未授权私网）：${error.message}`,
        400,
      );
    }
    throw new ExecutionNodeError(
      `执行节点域名解析失败：${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
}
