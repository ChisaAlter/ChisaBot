import { readFileSync } from "node:fs";
import type { BuildVersion } from "../../shared/system-update";
import { safeText } from "../../shared/system-update";

/**
 * 正在运行的这一版（docs/online-update.md）。
 *
 * 镜像构建时写 /app/build-info.json（`deploy/updater/build-image.sh`）：版本、提交、构建号（镜像标签）、
 * 构建时间。开发环境没有这个文件，返回 buildId "dev"，网页据此永不提示刷新。读一次、缓存在进程里：
 * 换版本一定是换容器。
 */
export type RunningBuild = BuildVersion & { image?: string };

const SHA = /^[0-9a-f]{40}$/u;
const BUILD_ID = /^[A-Za-z0-9._-]{1,80}$/u;

export function parseBuildInfo(raw: unknown, fallbackVersion: string): RunningBuild {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const buildId = typeof value.buildId === "string" && BUILD_ID.test(value.buildId) ? value.buildId : "dev";
  const parsedVersion = safeText(value.version, 40);
  const out: RunningBuild = {
    version: parsedVersion && parsedVersion !== "0.0.0" ? parsedVersion : fallbackVersion,
    buildId,
  };
  if (typeof value.commit === "string" && SHA.test(value.commit)) out.commit = value.commit;
  const builtAt = safeText(value.builtAt, 40);
  if (builtAt && !Number.isNaN(Date.parse(builtAt))) out.builtAt = builtAt;
  const image = safeText(value.image, 160);
  if (image && /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/u.test(image)) out.image = image;
  return out;
}

function packageVersion() {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(candidate, import.meta.url), "utf8"));
      if (pkg?.name === "chisabot" && typeof pkg.version === "string") return pkg.version as string;
    } catch {
      /* 试下一个 */
    }
  }
  return "0.0.0";
}

let cached: RunningBuild | null = null;

export function readRunningBuild(environment: NodeJS.ProcessEnv = process.env): RunningBuild {
  if (cached) return cached;
  const file = environment.CHISABOT_BUILD_INFO_FILE?.trim() || "/app/build-info.json";
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  cached = parseBuildInfo(raw, packageVersion());
  return cached;
}

/** /api/version 的应答体：只有这几个字段。 */
export function versionPayload(build: RunningBuild): BuildVersion {
  return {
    version: build.version,
    buildId: build.buildId,
    ...(build.commit ? { commit: build.commit } : {}),
    ...(build.builtAt ? { builtAt: build.builtAt } : {}),
  };
}
