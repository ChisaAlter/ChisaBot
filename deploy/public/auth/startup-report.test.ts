import { beforeAll, expect, test } from "bun:test";
import { createAuthApp } from "./server";

const origin = "https://chisabot.example.com:8443";
const password = "diagnostic-unit-test-only";
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 4096, timeCost: 1 });
});
function setup(now?: () => number) {
  return createAuthApp({ databasePath: ":memory:", username: "admin", passwordHash, publicOrigin: origin, now });
}
function request(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Request(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(service: ReturnType<typeof setup>) {
  const response = await service.fetch(request("/auth/login", { username: "admin", password }));
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}
const report = { id: "boot_0123456789", event: "error", stage: "shell", resource: "index-app.js", category: "syntax", name: "SyntaxError", line: 1, column: 24000 };

test("startup reporting requires the existing session and same-origin request", async () => {
  const service = setup();
  try {
    const anonymous = await service.fetch(request("/auth/startup-report", report));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).chisabotAuthRequired).toBeUndefined();
    const cookie = await login(service);
    expect((await service.fetch(request("/auth/startup-report", report, cookie, { Origin: "https://foreign.invalid" }))).status).toBe(403);
    expect((await service.fetch(request("/auth/startup-report", report, cookie, { Origin: "" }))).status).toBe(403);
    expect((await service.fetch(request("/auth/startup-report", report, cookie))).status).toBe(202);
    expect((await service.fetch(request("/auth/startup-report"))).status).toBe(405);
  } finally { service.close(); }
});

test("diagnostics accept only safe state metadata and never record arbitrary details", async () => {
  const service = setup();
  try {
    const cookie = await login(service);
    for (const body of [
      { ...report, message: "private-detail" }, { ...report, resource: "/assets/index.js?secret=private-detail" },
      { ...report, category: "private-detail" }, { ...report, event: "private-detail" },
      { ...report, id: "<private-detail>" },
      { ...report, name: "private-detail" }, { ...report, line: -1 }, { ...report, column: 10_000_001 },
    ]) expect((await service.fetch(request("/auth/startup-report", body, cookie))).status).toBe(400);
    const response = await service.fetch(request("/auth/startup-report", report, cookie, {
      "User-Agent": "Mozilla/5.0 Chrome/154.0.8037.98 Safari/537.36 sensitive-extra",
    }));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const data = await (await service.fetch(request("/_internal/startup-reports"))).json();
    expect(data.reports).toHaveLength(1);
    expect(data.reports[0]).toMatchObject({ ...report, browser: "Chrome 154" });
    expect(JSON.stringify(data)).not.toContain("private-detail");
    expect(JSON.stringify(data)).not.toContain("sensitive-extra");
    expect(JSON.stringify(data)).not.toContain(cookie);
  } finally { service.close(); }
});

test("report history and per-page ingestion are bounded and expire", async () => {
  let time = 1000;
  const service = setup(() => time);
  try {
    const cookie = await login(service);
    for (let i = 0; i < 8; i++) expect((await service.fetch(request("/auth/startup-report", report, cookie))).status).toBe(202);
    expect((await service.fetch(request("/auth/startup-report", report, cookie))).status).toBe(429);
    for (let i = 0; i < 105; i++) await service.fetch(request("/auth/startup-report", { ...report, id: `boot_test_${i}` }, cookie));
    const data = await (await service.fetch(request("/_internal/startup-reports"))).json();
    expect(data.reports.length).toBeLessThanOrEqual(100);
    time += 20 * 60_000 + 1;
    expect((await (await service.fetch(request("/_internal/startup-reports"))).json()).reports).toHaveLength(0);
  } finally { service.close(); }
});
