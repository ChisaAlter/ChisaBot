import { compareSemver } from "../../../shared/system-update";

/**
 * 桌面端内置本地前端（DESIGN.md §137）的版本偏移感知：
 *  - 当 vite 以 `VITE_CHISABOT_BUILD_ID="pc-<ver>"` 打包进桌面端 ASAR 时，解析出本地 UI 版本；
 *  - 随着 /api/version 返回或显式传入服务端版本，比较两端 semver，只在服务端严格低于桌面端时返回偏移详情。
 */

function parseBundledPcVersion(buildId: string | undefined): string | null {
  const trimmed = buildId?.trim() || "";
  if (!trimmed.startsWith("pc-")) return null;
  const ver = trimmed.slice(3).trim();
  return ver || null;
}

export const BUNDLED_LOCAL_PC_VERSION: string | null = parseBundledPcVersion(
  import.meta.env.VITE_CHISABOT_BUILD_ID,
);

let latestServedVersion: string | null = null;
let bundledPcVersionOverride: string | null | undefined;

export function recordServedVersion(version: string | undefined | null): void {
  const clean = typeof version === "string" ? version.trim() : "";
  if (clean) latestServedVersion = clean;
}

export function serverSkewBehindBundled(
  explicitServedVersion?: string | null,
): { uiVersion: string; serverVersion: string } | null {
  const uiVersion =
    bundledPcVersionOverride !== undefined
      ? bundledPcVersionOverride
      : BUNDLED_LOCAL_PC_VERSION;
  const srv = (explicitServedVersion ?? latestServedVersion)?.trim() || "";
  if (!uiVersion || !srv) return null;
  if (compareSemver(uiVersion, srv) > 0) {
    return { uiVersion, serverVersion: srv };
  }
  return null;
}

export function formatAccountVersionLabel(
  servedVersion?: string | null,
): string {
  const skew = serverSkewBehindBundled(servedVersion);
  if (skew) {
    return `v${skew.uiVersion} · 服务端 v${skew.serverVersion}`;
  }
  const clean = typeof servedVersion === "string" ? servedVersion.trim() : "";
  return clean ? `v${clean}` : "";
}

export function setBundledPcVersionForTest(
  version: string | null | undefined,
): void {
  bundledPcVersionOverride = version;
}

export function resetVersionSkewForTest(): void {
  latestServedVersion = null;
  bundledPcVersionOverride = undefined;
}
