import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * scripts/check-release-assets.mjs + release.yml 的回归测试（RV-03 / RV-26）。
 *
 * 前半部分用临时目录模拟 download-artifact 的 merge-multiple：generic 和 custom 产物同名，
 * 谁后写谁覆盖——证明把关脚本在干净 generic、整包被 custom 覆盖、latest.yml 与安装包分属两个
 * flavor 这三种情况下给出正确判定。后半部分直接解析 .github/workflows/release.yml，固定住
 * 工作流上的几个不变量（通用版必须完成签名、只下载通用签名产物、
 * 上传前一定先跑把关脚本）。
 */

const SCRIPT = join(import.meta.dir, "check-release-assets.mjs");
const WORKFLOW = join(
  import.meta.dir,
  "..",
  ".github",
  "workflows",
  "release.yml",
);

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "release-assets-"));
  cleanups.push(dir);
  return dir;
}

function sha512(file: string) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

function run(dir: string, ...args: string[]) {
  const p = Bun.spawnSync({
    cmd: ["node", SCRIPT, dir, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const EXE = "ChisaBot-1.0.0-x64-setup.exe";
const ZIP = "ChisaBot-1.0.0-x64-portable.zip";
const APK = "ChisaBot-Android-1.0.0.apk";

/** 写一份 pc job 上传的 <flavor> 产物（文件名与 flavor 无关，和线上一样）。 */
function makePcArtifact(flavor: "generic" | "custom", { signed = false } = {}) {
  const dir = join(tmp(), `artifact-${flavor}${signed ? "-signed" : ""}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, EXE), `${flavor} installer bytes`);
  writeFileSync(join(dir, `${EXE}.blockmap`), `${flavor} blockmap`);
  writeFileSync(join(dir, ZIP), `${flavor} portable`);
  writeFileSync(join(dir, "update-keys.json"), '{"keys": []}\n');
  writeFileSync(join(dir, "flavor.txt"), `${flavor}\n`);
  const yml = [
    "version: 1.0.0",
    "files:",
    `  - url: ${EXE}`,
    `    sha512: ${sha512(join(dir, EXE))}`,
    `    size: ${Buffer.byteLength(`${flavor} installer bytes`)}`,
    `path: ${EXE}`,
    `sha512: ${sha512(join(dir, EXE))}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    "chisabotShell: deadbeef",
    signed
      ? "chisabotSig: 'abcd1234:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='"
      : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(join(dir, "latest.yml"), yml);
  return dir;
}

function makeAndroidArtifact() {
  const dir = join(tmp(), "artifact-android");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, APK), "apk bytes");
  writeFileSync(join(dir, "chisabot-android.json"), '{"version":"1.0.0"}\n');
  return dir;
}

/** 模拟 merge-multiple: 把若干产物目录的文件平铺进同一个资产目录，同名后者覆盖。 */
function merge(...artifactDirs: string[]) {
  const assets = join(tmp(), "release-assets");
  mkdirSync(assets, { recursive: true });
  for (const dir of artifactDirs)
    for (const name of readdirSync(dir))
      copyFileSync(join(dir, name), join(assets, name));
  return assets;
}

describe("check-release-assets.mjs", () => {
  test("generic 产物合并（未签名路径）：通过，flavor.txt / update-keys.json 被剔出上传清单", () => {
    const assets = merge(makePcArtifact("generic"), makeAndroidArtifact());
    const r = run(assets, "--expect-unsigned", "--version", "1.0.0");
    expect(r.code).toBe(0);
    expect(existsSync(join(assets, "flavor.txt"))).toBe(false);
    expect(existsSync(join(assets, "update-keys.json"))).toBe(false);
    expect(existsSync(join(assets, EXE))).toBe(true);
  });

  test("generic 产物合并（签名路径）：通过", () => {
    const assets = merge(
      makePcArtifact("generic", { signed: true }),
      makeAndroidArtifact(),
    );
    expect(run(assets, "--expect-signed", "--version", "1.0.0").code).toBe(0);
  });

  test("merge-multiple 把 custom 产物也合进来（RV-03 事故形态）：flavor 标记拦下", () => {
    const assets = merge(
      makePcArtifact("generic"),
      makePcArtifact("custom"),
      makeAndroidArtifact(),
    );
    const r = run(assets, "--expect-unsigned", "--version", "1.0.0");
    expect(r.code).toBe(1);
    expect(r.out).toContain("generic");
  });

  test("latest.yml 是 generic 的、安装包是 custom 的（同名覆盖后的 split-brain）：sha512 拦下", () => {
    const generic = makePcArtifact("generic");
    const custom = makePcArtifact("custom");
    const assets = join(tmp(), "release-assets");
    mkdirSync(assets, { recursive: true });
    for (const name of readdirSync(generic))
      copyFileSync(join(generic, name), join(assets, name));
    // 只有安装包被 custom 的同名文件覆盖，latest.yml 还是 generic 的。
    copyFileSync(join(custom, EXE), join(assets, EXE));
    const r = run(assets, "--expect-unsigned", "--version", "1.0.0");
    expect(r.code).toBe(1);
    expect(r.out).toContain("sha512");
  });

  test("flavor 标记缺失 / 被写成 custom：都拒绝", () => {
    const missing = merge(makeAndroidArtifact());
    expect(run(missing, "--expect-unsigned").code).toBe(1);
    const custom = merge(makePcArtifact("custom"), makeAndroidArtifact());
    expect(run(custom, "--expect-unsigned").code).toBe(1);
  });

  test("白名单外的文件 / 子目录：拒绝", () => {
    const a1 = merge(makePcArtifact("generic"), makeAndroidArtifact());
    writeFileSync(join(a1, "evil.dll"), "x");
    expect(run(a1, "--expect-unsigned").code).toBe(1);
    const a2 = merge(makePcArtifact("generic"), makeAndroidArtifact());
    mkdirSync(join(a2, "nested"));
    expect(run(a2, "--expect-unsigned").code).toBe(1);
  });

  test("签名在场性必须和发布开关一致", () => {
    const unsigned = merge(makePcArtifact("generic"), makeAndroidArtifact());
    expect(run(unsigned, "--expect-signed").code).toBe(1);
    const signed = merge(
      makePcArtifact("generic", { signed: true }),
      makeAndroidArtifact(),
    );
    expect(run(signed, "--expect-unsigned").code).toBe(1);
  });

  test("version 对不上 config 输出的版本：拒绝", () => {
    const assets = merge(makePcArtifact("generic"), makeAndroidArtifact());
    expect(run(assets, "--expect-unsigned", "--version", "9.9.9").code).toBe(1);
  });
});

// ---------- release.yml 的不变量（改动工作流前这些断言会失败） ----------

type Job = {
  needs?: string | string[];
  if?: string;
  environment?: string;
  outputs?: Record<string, string>;
  steps?: Array<Record<string, unknown>>;
};

const workflow = parse(readFileSync(WORKFLOW, "utf8")) as {
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;

function needsOf(job: Job) {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

describe("release.yml invariants", () => {
  test("generic release requires signing success and never downloads unsigned artifacts", () => {
    expect(needsOf(jobs.release)).toContain("pc-sign");
    expect(String(jobs.release.if)).toContain(
      "needs.pc-sign.result == 'success'",
    );
    expect(String(jobs.release.if)).not.toContain("skipped");
    const downloads = (jobs.release.steps ?? []).filter((s) =>
      String(s.uses ?? "").includes("download-artifact"),
    );
    expect(downloads).toHaveLength(1);
    expect((downloads[0]?.with as Record<string, unknown>)?.pattern).toBe(
      "*-generic",
    );
  });
  test("上传前一定先跑 check-release-assets.mjs", () => {
    const steps = jobs.release.steps ?? [];
    const checkAt = steps.findIndex((s) =>
      String(s.run ?? "").includes("check-release-assets.mjs"),
    );
    const uploadAt = steps.findIndex((s) =>
      String(s.run ?? "").includes("gh release upload"),
    );
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(uploadAt).toBeGreaterThanOrEqual(0);
    expect(checkAt).toBeLessThan(uploadAt);
  });

  test("generic signing cannot be disabled by a repository variable", () => {
    expect(JSON.stringify(jobs)).not.toContain("CHISABOT_PC_UPDATE_UNSIGNED");
    expect(jobs["pc-sign"].environment).toBe("pc-release");
    expect(String(jobs["pc-sign"].if)).toBe("needs.config.outputs.tag != ''");
    const verification = (jobs["pc-sign"].steps ?? []).find((step) =>
      String(step.run ?? "").includes("--verify"),
    );
    expect(String(verification?.run)).toContain("--tamper-check");
    const check = (jobs.release.steps ?? []).find((step) =>
      String(step.run ?? "").includes("check-release-assets.mjs"),
    );
    expect(String(check?.run)).toContain("--expect-signed");
    expect(String(check?.run)).not.toContain("--expect-unsigned");
  });

  test("generic public keys are retained while custom builds keep their existing key source", () => {
    const step = (jobs.pc.steps ?? []).find(
      (step) => step.name === "Update keys",
    );
    const run = String(step?.run ?? "");
    expect(run).toContain('if [ "$FLAVOR" = custom ]');
    expect(run).toContain("--keys-from-env");
    expect(run).toContain("--require-keys");
    expect(run).not.toContain('CHISABOT_UPDATE_PUBKEYS=""');
  });
  test("flavor 标记随产物走，update-keys.json 不进签名产物", () => {
    const pcJob = JSON.stringify(jobs.pc);
    expect(pcJob).toContain("flavor.txt");
    const signUpload = (jobs["pc-sign"].steps ?? []).find(
      (s) =>
        typeof s.uses === "string" &&
        (s.uses as string).includes("upload-artifact"),
    );
    const signPath = String(
      (signUpload?.with as Record<string, unknown>)?.path ?? "",
    );
    expect(signPath).toContain("flavor.txt");
    expect(signPath).not.toContain("update-keys.json");
  });
});
