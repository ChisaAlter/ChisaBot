/**
 * 密钥保险箱（DESIGN.md §52，docs/vault.md）：API 密钥、令牌这类机器人要用但不能看的东西。
 *
 * 值只在服务器上解密，从不进模型上下文、聊天记录和日志：机器人用 `{{secret:名字}}` 占位，
 * `api_request` 在服务器上替换后发出去，回来的内容里再把值抹掉。每个密钥绑定能用它的域名，
 * 发往别的域名一律拒绝（防止被网页里的指令骗着把密钥发出去）。
 */
export const VAULT_NAME = /^[a-z0-9][a-z0-9_-]{0,38}[a-z0-9]$/;
export const VAULT_DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type VaultSecretView = {
  id: string;
  name: string;
  label: string;
  /** 能用这个密钥的域名（含子域名写 *.example.com）。 */
  domains: string[];
  /** 末四位，给人认。 */
  hint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** 由别处管理的密钥（如 `github` = 设置 → 账号连接 → GitHub），这里不能编辑、删除，`api_request` 也不能用。 */
  managedBy?: "github";
};

export type VaultRequestView = {
  id: string;
  name: string;
  label: string;
  purpose: string | null;
  domains: string[];
  status: "pending" | "filled" | "cancelled" | "expired";
  agentId: string;
  createdAt: string;
};

export function domainAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => {
    const d = domain.toLowerCase();
    return d.startsWith("*.") ? h === d.slice(2) || h.endsWith(d.slice(1)) : h === d;
  });
}

/** 保留的名字：由专门的连接管理（DESIGN.md §53 GitHub），保险箱页面和 `api_request` 都不能直接用。 */
const RESERVED = new Map<string, "github">([["github", "github"]]);
export function vaultReserved(name: string): "github" | undefined {
  return RESERVED.get(name);
}
