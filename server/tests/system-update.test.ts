import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { parseBuildInfo, versionPayload } from "../src/build-info";
import { createSystemUpdateRoutes, createSystemUpdateService } from "../src/system-update";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-12T02:00:00Z");
const running = { version: "0.1.0", buildId: "glass-20261012a", commit: "a".repeat(40) };

function spool(state?: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "sysupd-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "requests"));
  mkdirSync(path.join(dir, "state"));
  if (state !== undefined) writeFileSync(path.join(dir, "state", "state.json"), JSON.stringify(state));
  return dir;
}

const fresh = {
  updatedAt: "2026-10-12T01:59:50Z",
  current: { image: "local/chisabot:glass-20261012a", commit: "a".repeat(40) },
  previous: { image: "local/chisabot:glass-20261011d" },
  latest: { sha: "b".repeat(40), subject: "next" },
  behind: 1,
  commits: [{ sha: "b".repeat(40), subject: "next" }],
};

test("build info: parsed strictly, dev fallback, version payload has no image", () => {
  const info = parseBuildInfo(
    { version: "0.1.0", commit: "a".repeat(40), buildId: "glass-20261012a", builtAt: "2026-10-12T01:00:00Z", image: "local/chisabot:glass-20261012a" },
    "0.0.0",
  );
  expect(info.image).toBe("local/chisabot:glass-20261012a");
  expect(versionPayload(info)).toEqual({ version: "0.1.0", buildId: "glass-20261012a", commit: "a".repeat(40), builtAt: "2026-10-12T01:00:00Z" });
  expect(parseBuildInfo(null, "9.9.9")).toEqual({ version: "9.9.9", buildId: "dev" });
  expect(parseBuildInfo({ version: "0.0.0", buildId: "glass-1" }, "0.1.92")).toEqual({ version: "0.1.92", buildId: "glass-1" });
  expect(parseBuildInfo({ buildId: "../../etc", commit: "zz" }, "1").buildId).toBe("dev");
});

test("not configured without the shared directories", () => {
  const service = createSystemUpdateService({ dir: "/nonexistent-sysupd", running, now: () => NOW });
  expect(service.configured).toBe(false);
  expect(service.overview().configured).toBe(false);
  expect(service.request("update", { id: "u1" })).toEqual({ error: "这个部署没有安装宿主机更新程序。", status: 503 });
});

test("requests are written atomically as whitelisted JSON and guarded by state", () => {
  const dir = spool(fresh);
  const service = createSystemUpdateService({ dir, running, now: () => NOW });
  const result = service.request("update", { id: "user-1", name: "Admin" }, "b".repeat(40));
  expect("id" in result).toBe(true);
  const files = readdirSync(path.join(dir, "requests"));
  expect(files).toHaveLength(1);
  const body = JSON.parse(readFileSync(path.join(dir, "requests", files[0] as string), "utf8"));
  expect(body).toMatchObject({ action: "update", actor: "Admin", actorId: "user-1", expectCommit: "b".repeat(40) });
  // A second update while one is queued is refused; a check is still fine.
  expect(service.request("update", { id: "user-1" })).toEqual({ error: "已经有一个更新或回滚在进行中。", status: 409 });
  expect(service.request("rollback", { id: "user-1" })).toMatchObject({ status: 409 });
  expect("id" in service.request("check", { id: "user-1" })).toBe(true);
  expect(service.overview().pending.sort()).toEqual(["check", "update"]);
});

test("refusals: offline updater, no previous, external run, running job", () => {
  const offline = createSystemUpdateService({ dir: spool({ ...fresh, updatedAt: "2026-10-12T01:00:00Z" }), running, now: () => NOW });
  expect(offline.request("update", { id: "u" })).toMatchObject({ status: 503 });
  const noPrev = createSystemUpdateService({ dir: spool({ ...fresh, previous: null }), running, now: () => NOW });
  expect(noPrev.request("rollback", { id: "u" })).toEqual({ error: "没有可以回滚到的上一版。", status: 409 });
  const external = createSystemUpdateService({ dir: spool({ ...fresh, externalBusy: true }), running, now: () => NOW });
  expect(external.request("update", { id: "u" })).toMatchObject({ status: 409 });
  expect("id" in external.request("check", { id: "u" })).toBe(true);
  const busy = createSystemUpdateService({
    dir: spool({ ...fresh, job: { id: "update-xyz123", action: "update", status: "running", log: [] } }),
    running,
    now: () => NOW,
  });
  expect(busy.request("rollback", { id: "u" })).toMatchObject({ status: 409 });
});

test("deps changed: the update is accepted as a full build", () => {
  const dir = spool({ ...fresh, depsChanged: true, fullReason: "这些提交改动了依赖" });
  const service = createSystemUpdateService({ dir, running, now: () => NOW });
  expect(service.overview()).toMatchObject({ depsChanged: true, fullReason: "这些提交改动了依赖" });
  const result = service.request("update", { id: "u" }, "b".repeat(40));
  expect("id" in result).toBe(true);
  const files = readdirSync(path.join(dir, "requests")).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  const body = JSON.parse(readFileSync(path.join(dir, "requests", files[0] as string), "utf8"));
  expect(body).toMatchObject({ action: "update", mode: "full", expectCommit: "b".repeat(40) });
});

test("a full rebuild can be forced; a code update carries no mode", () => {
  const dir = spool(fresh);
  const service = createSystemUpdateService({ dir, running, now: () => NOW });
  service.request("update", { id: "u" }, undefined, { full: true });
  const files = readdirSync(path.join(dir, "requests")).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  expect(JSON.parse(readFileSync(path.join(dir, "requests", files[0] as string), "utf8")).mode).toBe("full");
  const plain = spool(fresh);
  createSystemUpdateService({ dir: plain, running, now: () => NOW }).request("update", { id: "u" });
  const names = readdirSync(path.join(plain, "requests")).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  expect(JSON.parse(readFileSync(path.join(plain, "requests", names[0] as string), "utf8")).mode).toBeUndefined();
});

test("finished jobs are audited exactly once", async () => {
  const dir = spool({ ...fresh, job: { id: "update-done01", action: "update", status: "succeeded", toImage: "local/chisabot:auto-1", log: [] } });
  const service = createSystemUpdateService({ dir, running, now: () => NOW });
  const seen: string[] = [];
  await service.pollFinishedJobs(async (job) => void seen.push(job.id));
  await service.pollFinishedJobs(async (job) => void seen.push(job.id));
  expect(seen).toEqual(["update-done01"]);
});

function app(role: "admin" | "user", dir: string, audits: unknown[]) {
  const service = createSystemUpdateService({ dir, running, now: () => NOW });
  const requireUser = (async (context: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    context.set("actor", { id: `${role}-1`, email: `${role}@x`, name: role, role });
    await next();
  }) as never;
  const root = new Hono<{ Variables: AppVariables }>();
  root.route(
    "/api/admin/system-update",
    createSystemUpdateRoutes({ service, requireUser, auditStore: { insert: async (event) => void audits.push(event) } }),
  );
  return root;
}

test("routes: admins only, no-store, audit rows for update requests", async () => {
  const dir = spool(fresh);
  const audits: unknown[] = [];
  const denied = await app("user", dir, audits).request("/api/admin/system-update");
  expect(denied.status).toBe(403);
  const admin = app("admin", dir, audits);
  const get = await admin.request("/api/admin/system-update");
  expect(get.status).toBe(200);
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect((await get.json()).latest.sha).toBe("b".repeat(40));
  const post = await admin.request("/api/admin/system-update/update", {
    method: "POST",
    body: JSON.stringify({ expectCommit: "b".repeat(40) }),
    headers: { "content-type": "application/json" },
  });
  expect(post.status).toBe(202);
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ eventType: "configuration.changed", targetType: "system_update", actorUserId: "admin-1" });
  const again = await admin.request("/api/admin/system-update/rollback", { method: "POST" });
  expect(again.status).toBe(409);
  expect(audits).toHaveLength(2);
});

test("updater not installed yet / old / misconfigured: overview says so, request write failure is a 503", () => {
  // Docker created the mounted directories itself (no host updater): no state, requests dir not writable.
  const empty = spool();
  const none = createSystemUpdateService({ dir: empty, sourceDir: "/srv/chisabot", running, now: () => NOW });
  const view = none.overview();
  expect(view).toMatchObject({ configured: true, updaterOnline: false, updaterOutdated: false, sourceDir: "/srv/chisabot" });
  expect(view.updatedAt).toBeUndefined();
  rmSync(path.join(empty, "requests"), { recursive: true });
  writeFileSync(path.join(empty, "requests"), "not a directory");
  expect(none.request("check", { id: "u" })).toEqual({ error: "无法写入更新请求：宿主机更新服务没有安装好。", status: 503 });

  const old = createSystemUpdateService({ dir: spool({ ...fresh, updaterVersion: "2" }), running, now: () => NOW });
  expect(old.overview()).toMatchObject({ updaterVersion: 2, updaterOutdated: true, warnings: [] });
  const current = createSystemUpdateService({
    dir: spool({ ...fresh, updaterVersion: "4", warnings: ["health_url_example", "rm -rf /", "buildx_missing"] }),
    sourceDir: "../../etc; rm",
    running,
    now: () => NOW,
  });
  const ok = current.overview();
  expect(ok).toMatchObject({ updaterVersion: 4, updaterOutdated: false, warnings: ["health_url_example", "buildx_missing"] });
  expect(ok.sourceDir).toBeUndefined();
});
