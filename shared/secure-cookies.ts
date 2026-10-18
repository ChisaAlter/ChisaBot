/**
 * Whether Better Auth (and any app-issued) session cookies must carry the Secure flag.
 *
 * Production maturity Track D / PRD-P2-04：公网 https 部署强制 Secure；本机 http 开发不加。
 * 判定顺序（先到先得）：
 * 1. `CHISABOT_SECURE_COOKIES=1|true` → 强制开；`0|false` → 强制关（仅排障）
 * 2. `BETTER_AUTH_URL` / `OPENBOT_PUBLIC_URL` / `OPENBOT_APP_URL` 任一为 https → 开
 * 3. 否则关（loopback http 开发）
 */
export function useSecureCookies(input: {
  authBaseUrl?: string | null;
  publicUrl?: string | null;
  appUrl?: string | null;
  /** Raw CHISABOT_SECURE_COOKIES env value. */
  force?: string | null;
}): boolean {
  const force = input.force?.trim().toLowerCase();
  if (force === "1" || force === "true") return true;
  if (force === "0" || force === "false") return false;
  for (const raw of [input.authBaseUrl, input.publicUrl, input.appUrl]) {
    if (typeof raw === "string" && raw.trim().toLowerCase().startsWith("https://")) {
      return true;
    }
  }
  return false;
}
