/**
 * Route authorization registry gate.
 *
 * Every HTTP route the server can register must be classified in
 * server/tests/route-access-registry.ts as public / user / admin / machine / middleware. The
 * inventory (server/tests/support/route-inventory.ts) builds the production-shaped Hono app
 * with inert stores, so `app.routes` enumerates the real route table — every mount in
 * server/src/app.ts and every `extraRoutes` surface from server/src/index.ts — without a
 * database.
 *
 * Three checks, plus behavior verification where a stub build can produce one:
 *
 * 1. Coverage both ways. A mounted route missing from the registry fails and prints the
 *    "METHOD path" to register; a registry entry for a route that no longer mounts fails as
 *    stale.
 * 2. Mount drift. Every mount literal in index.ts's extraRoutes block and every app.route
 *    prefix in app.ts must have at least one enumerated route under it, so a new mount cannot
 *    slip past the inventory.
 * 3. Behavior. admin → a signed-in non-admin gets 403. user → anonymous gets 401 and a member
 *    is not refused authentication. machine → anonymous is not let through (2xx would be a
 *    failure). public → anonymous is not refused with 401. middleware → registration only.
 *
 * KNOWN_GAPS carries classified routes whose current behavior does not match their
 * registration (documented multi-account review findings). They warn but never fail: "still
 * open" while the gap reproduces, "resolved" when the fix lands — at which point the entry
 * must be removed.
 */
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { KNOWN_GAPS, ROUTE_ACCESS } from "./route-access-registry";
import { buildInventoryApp } from "./support/route-inventory";

/*
 * AGENTS.md's Bun timer quirk: an AbortSignal.timeout does not fire when it is the only pending
 * timer in the process. A real keep-alive interval is held for the whole file so both real
 * timeouts and per-request race timeouts can fire; it is released at the end.
 */
const keepAlive = setInterval(() => {}, 60_000);
afterAll(() => clearInterval(keepAlive));

const memberApp = await buildInventoryApp({
  kind: "member",
  userId: "inventory-member",
});
const anonymousApp = await buildInventoryApp({ kind: "anonymous" });

const enumerated = new Set<string>();
for (const route of memberApp.routes) {
  enumerated.add(`${route.method} ${route.path}`);
}

/** A probe that never produced a response — a stub service hung inside the handler. */
const HUNG = -1;

function probePath(path: string): string {
  return path.replace(/:[^/]+/g, "probe").replaceAll("*", "probe");
}

async function probe(app: typeof memberApp, key: string): Promise<number> {
  const method = key.slice(0, key.indexOf(" "));
  const path = key.slice(key.indexOf(" ") + 1);
  const request = app
    .request(`http://inventory.test${probePath(path)}`, {
      method: method === "ALL" ? "GET" : method,
      headers: { "content-type": "application/json" },
      body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined,
    })
    .then(async (response) => {
      await response.text().catch(() => "");
      return response.status;
    })
    .catch(() => HUNG);
  const timeout = new Promise<number>((resolve) =>
    setTimeout(() => resolve(HUNG), 10_000),
  );
  return Promise.race([request, timeout]);
}

/**
 * Runs one assertion probe per registry key in parallel batches; returns the routes whose
 * observed status broke their classification. KNOWN_GAPS entries warn instead of failing.
 */
async function collectViolations(
  check: (key: string, member: number, anonymous: number) => string | null,
): Promise<void> {
  const failures: string[] = [];
  const entries = Object.entries(ROUTE_ACCESS).filter(
    ([, entry]) =>
      entry.verify !== false &&
      ["admin", "user", "public", "machine"].includes(entry.access),
  );
  const statuses = new Map<string, { member: number; anonymous: number }>();
  const BATCH = 24;
  for (let index = 0; index < entries.length; index += BATCH) {
    const batch = entries.slice(index, index + BATCH);
    await Promise.all(
      batch.map(async ([key]) => {
        statuses.set(key, {
          member: await probe(memberApp, key),
          anonymous: await probe(anonymousApp, key),
        });
      }),
    );
  }
  for (const [key] of entries) {
    const observed = statuses.get(key);
    if (!observed) continue;
    const violation = check(key, observed.member, observed.anonymous);
    if (!violation) continue;
    const gap = KNOWN_GAPS[key];
    if (gap) {
      console.warn(`KNOWN_GAP still open — ${violation}. ${gap.issue}`);
      continue;
    }
    failures.push(violation);
  }
  for (const [key, gap] of Object.entries(KNOWN_GAPS)) {
    if (!gap.statusCheck) continue;
    const entry = ROUTE_ACCESS[key];
    if (!entry || entry.verify === false) continue;
    const observed = statuses.get(key);
    if (!observed) continue;
    if (!check(key, observed.member, observed.anonymous)) {
      console.warn(
        `KNOWN_GAP resolved — ${key} now matches its registration. ${gap.issue} Remove it from KNOWN_GAPS.`,
      );
    }
  }
  expect(failures).toEqual([]);
}

describe("route authorization registry", () => {
  test("every mounted route is classified in the registry", () => {
    const missing = [...enumerated].filter((key) => !(key in ROUTE_ACCESS));
    expect(
      missing,
      `Unregistered routes — add each to server/tests/route-access-registry.ts:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  test("the registry has no stale entries", () => {
    const stale = Object.keys(ROUTE_ACCESS).filter(
      (key) => !enumerated.has(key),
    );
    expect(
      stale,
      `Registry entries for routes that no longer mount — remove or fix:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  test("every mount literal in index.ts and app.ts is covered by the inventory", async () => {
    const srcDir = join(import.meta.dir, "..", "src");
    const indexSource = await Bun.file(join(srcDir, "index.ts")).text();
    const appSource = await Bun.file(join(srcDir, "app.ts")).text();

    // Mount literals: `["/api/x", builder]` entries in the extraRoutes array, and
    // `app.route("/prefix", sub)` calls in app.ts.
    const extraBlock = indexSource.slice(indexSource.indexOf("extraRoutes:"));
    const literals = new Set<string>();
    for (const match of extraBlock.matchAll(/\[\s*"(\/[^"]*)"/g))
      literals.add(match[1]);
    for (const match of appSource.matchAll(/app\.route\(\s*"(\/[^"]*)"/g))
      literals.add(match[1]);

    const uncovered = [...literals].filter((prefix) => {
      if (prefix === "/") {
        // The conversation runtime mounts at root with its own basePath.
        return ![...enumerated].some(
          (key) =>
            key.endsWith(" /api/conversations/info") ||
            key.includes(" /api/conversations/"),
        );
      }
      return ![...enumerated].some((key) =>
        key.slice(key.indexOf(" ") + 1).startsWith(prefix),
      );
    });
    expect(
      uncovered,
      `Mounts in index.ts/app.ts not represented in the inventory — add the builder to server/tests/support/route-inventory.ts:\n${uncovered.join("\n")}`,
    ).toEqual([]);
  });

  test(
    "routes refuse callers their classification forbids",
    async () => {
      await collectViolations((key, member, anonymous) => {
      const entry = ROUTE_ACCESS[key];
      if (entry.access === "admin" && member !== 403)
        return `${key}: member got ${member === HUNG ? "a hung handler" : member}, expected 403 for an admin route`;
      if (entry.access === "user" && anonymous !== 401)
        return `${key}: anonymous got ${anonymous}, expected 401 for a session route`;
      if (entry.access === "user" && member === 401)
        return `${key}: member got 401 — a signed-in user should reach the handler (reclassify as machine if a device/token credential gates it)`;
      if (entry.access === "public" && anonymous === 401)
        return `${key}: anonymous got 401 — public routes must not require a session`;
      if (
        entry.access === "machine" &&
        anonymous >= 200 &&
        anonymous < 300
      )
        return `${key}: anonymous got ${anonymous} — machine routes must reject callers without the machine credential`;
        return null;
      });
    },
    // ~1 300 in-process probes across both app builds.
    120_000,
  );

  test("known gaps that cannot be status-checked are still reported", () => {
    for (const [key, gap] of Object.entries(KNOWN_GAPS)) {
      if (!gap.statusCheck) {
        console.warn(`KNOWN_GAP (status-unverifiable) — ${key}. ${gap.issue}`);
      }
      expect(
        key in ROUTE_ACCESS,
        `KNOWN_GAPS entry ${key} is not in the registry`,
      ).toBe(true);
    }
  });
});
