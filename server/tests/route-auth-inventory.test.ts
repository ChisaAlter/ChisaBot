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

import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as TsNamespace from "typescript";
import { KNOWN_GAPS, ROUTE_ACCESS } from "./route-access-registry";
import {
  buildInventoryApp,
  buildInventoryUpgradeHandler,
  UPGRADE_ROUTES,
} from "./support/route-inventory";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TsNamespace;

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
const memberUpgrade = buildInventoryUpgradeHandler({
  kind: "member",
  userId: "inventory-member",
});
const anonymousUpgrade = buildInventoryUpgradeHandler({ kind: "anonymous" });

const enumerated = new Set<string>();
for (const route of memberApp.routes) {
  enumerated.add(`${route.method} ${route.path}`);
}
const upgradePaths = new Set<string>();
for (const route of UPGRADE_ROUTES) {
  const key = `${route.method} ${route.path}`;
  enumerated.add(key);
  upgradePaths.add(key);
}

/** A probe that never produced a response — a stub service hung inside the handler. */
const HUNG = -1;

function probePath(path: string): string {
  return path.replace(/:[^/]+/g, "probe").replaceAll("*", "probe");
}

async function probe(
  app: typeof memberApp,
  upgrade: typeof memberUpgrade,
  key: string,
): Promise<number> {
  const method = key.slice(0, key.indexOf(" "));
  const path = key.slice(key.indexOf(" ") + 1);
  if (upgradePaths.has(key)) {
    const url = new URL(`http://inventory.test${probePath(path)}`);
    const request = new Request(url.toString(), {
      method: method === "ALL" ? "GET" : method,
      headers: { upgrade: "websocket" },
    });
    const res = await upgrade(request, url, { upgrade: () => true });
    if (res === undefined) return 101;
    if (res === null) return 404;
    await res.text().catch(() => "");
    return res.status;
  }
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
          member: await probe(memberApp, memberUpgrade, key),
          anonymous: await probe(anonymousApp, anonymousUpgrade, key),
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

    const upgradeSource = await Bun.file(
      join(srcDir, "upgrade-routes.ts"),
    ).text();
    const indexAst = ts.createSourceFile(
      "index.ts",
      indexSource,
      ts.ScriptTarget.Latest,
      true,
    );
    const upgradeAst = ts.createSourceFile(
      "upgrade-routes.ts",
      upgradeSource,
      ts.ScriptTarget.Latest,
      true,
    );

    const unwrapAstExpr = (
      expr: TsNamespace.Expression,
    ): TsNamespace.Expression => {
      let cur = expr;
      for (;;) {
        if (
          ts.isParenthesizedExpression(cur) ||
          ts.isAsExpression(cur) ||
          ts.isTypeAssertionExpression(cur) ||
          ts.isNonNullExpression(cur) ||
          ts.isSatisfiesExpression(cur)
        ) {
          cur = cur.expression;
          continue;
        }
        return cur;
      }
    };

    const isUpgradeMemberAccess = (node: TsNamespace.Node): boolean => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === "upgrade") {
        return true;
      }
      if (ts.isElementAccessExpression(node)) {
        const arg = unwrapAstExpr(node.argumentExpression);
        if (
          (ts.isStringLiteral(arg) ||
            ts.isNoSubstitutionTemplateLiteral(arg)) &&
          arg.text === "upgrade"
        ) {
          return true;
        }
      }
      return false;
    };

    // AST check 1: server.upgrade / server?.upgrade / server["upgrade"] must not exist in index.ts
    const indexUpgradeRefs: string[] = [];
    const visitIndexUpgrades = (node: TsNamespace.Node) => {
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        isUpgradeMemberAccess(node)
      ) {
        const target = unwrapAstExpr(node.expression);
        if (ts.isIdentifier(target) && target.text === "server") {
          const line =
            indexAst.getLineAndCharacterOfPosition(node.getStart(indexAst))
              .line + 1;
          indexUpgradeRefs.push(`line ${line}: ${node.getText(indexAst)}`);
        }
      }
      ts.forEachChild(node, visitIndexUpgrades);
    };
    visitIndexUpgrades(indexAst);
    expect(
      indexUpgradeRefs,
      "server/src/index.ts must delegate all WebSocket upgrades to server/src/upgrade-routes.ts",
    ).toEqual([]);

    // AST check 2: every server.upgrade / server?.upgrade / server["upgrade"] call in upgrade-routes.ts matches UPGRADE_ROUTES
    const upgradeCallsInDispatcher: string[] = [];
    const visitDispatcher = (node: TsNamespace.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapAstExpr(node.expression);
        if (isUpgradeMemberAccess(callee)) {
          const line =
            upgradeAst.getLineAndCharacterOfPosition(node.getStart(upgradeAst))
              .line + 1;
          upgradeCallsInDispatcher.push(`line ${line}`);
        }
      }
      ts.forEachChild(node, visitDispatcher);
    };
    visitDispatcher(upgradeAst);
    expect(
      upgradeCallsInDispatcher,
      "Every server.upgrade() branch in server/src/upgrade-routes.ts must be declared in UPGRADE_ROUTES",
    ).toHaveLength(UPGRADE_ROUTES.length);

    // AST check 3: createUpgradeDispatcher wiring & resolveRequestActor guards in index.ts
    const dispatcherCalls: TsNamespace.CallExpression[] = [];
    let resolveActorDecl: TsNamespace.FunctionDeclaration | undefined;
    let serveCall: TsNamespace.CallExpression | undefined;
    const findIndexNodes = (node: TsNamespace.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(unwrapAstExpr(node.expression))
      ) {
        const name = (unwrapAstExpr(node.expression) as TsNamespace.Identifier)
          .text;
        if (name === "createUpgradeDispatcher") dispatcherCalls.push(node);
        if (name === "serve") serveCall = node;
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === "resolveRequestActor"
      ) {
        resolveActorDecl = node;
      }
      ts.forEachChild(node, findIndexNodes);
    };
    findIndexNodes(indexAst);

    expect(dispatcherCalls).toHaveLength(1);
    const dispatcherObj = dispatcherCalls[0]?.arguments[0];
    expect(dispatcherObj && ts.isObjectLiteralExpression(dispatcherObj)).toBe(
      true,
    );
    const wiringProps = new Map<string, TsNamespace.Expression>();
    if (dispatcherObj && ts.isObjectLiteralExpression(dispatcherObj)) {
      for (const prop of dispatcherObj.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          wiringProps.set(prop.name.text, prop.name);
        } else if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name)
        ) {
          wiringProps.set(prop.name.text, unwrapAstExpr(prop.initializer));
        }
      }
    }
    const expectIdentifierProp = (key: string, expectedName: string) => {
      const expr = wiringProps.get(key);
      expect(
        expr && ts.isIdentifier(expr) ? expr.text : expr?.getText(indexAst),
        `index.ts createUpgradeDispatcher(${key}) must wire directly to ${expectedName}`,
      ).toBe(expectedName);
    };
    expectIdentifierProp("voiceCallService", "voiceCallService");
    expectIdentifierProp("resolveRequestActor", "resolveRequestActor");
    expectIdentifierProp("agentProfiles", "agentProfileStore");
    expectIdentifierProp("isComputerConfigured", "hasConfiguredComputer");

    expect(resolveActorDecl?.body).toBeDefined();
    let sawGatewayResolve = false;
    let sawGetSession = false;
    let hasHardcodedAdminRoleReturn = false;
    const inspectResolveActor = (node: TsNamespace.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapAstExpr(node.expression);
        if (
          ts.isIdentifier(callee) &&
          callee.text === "resolveGatewayRequest"
        ) {
          sawGatewayResolve = true;
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "getSession"
        ) {
          sawGetSession = true;
        }
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const ret = unwrapAstExpr(node.expression);
        if (ts.isObjectLiteralExpression(ret)) {
          for (const prop of ret.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "role" &&
              ts.isStringLiteral(unwrapAstExpr(prop.initializer)) &&
              (unwrapAstExpr(prop.initializer) as TsNamespace.StringLiteral)
                .text === "admin"
            ) {
              hasHardcodedAdminRoleReturn = true;
            }
          }
        }
      }
      ts.forEachChild(node, inspectResolveActor);
    };
    if (resolveActorDecl?.body) inspectResolveActor(resolveActorDecl.body);
    expect(sawGatewayResolve).toBe(true);
    expect(sawGetSession).toBe(true);
    expect(hasHardcodedAdminRoleReturn).toBe(false);

    // AST check 4: every direct `return` in `serve({ fetch })` before `app.fetch` must be one of the sanctioned guards
    expect(serveCall).toBeDefined();
    const serveObj = serveCall?.arguments[0];
    expect(serveObj && ts.isObjectLiteralExpression(serveObj)).toBe(true);
    let fetchBody: TsNamespace.Block | undefined;
    if (serveObj && ts.isObjectLiteralExpression(serveObj)) {
      for (const prop of serveObj.properties) {
        if (
          ts.isMethodDeclaration(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "fetch"
        ) {
          fetchBody = prop.body;
        } else if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "fetch"
        ) {
          const init = unwrapAstExpr(prop.initializer);
          if (
            (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            ts.isBlock(init.body)
          ) {
            fetchBody = init.body;
          }
        }
      }
    }
    expect(fetchBody).toBeDefined();
    const directReturns: TsNamespace.ReturnStatement[] = [];
    let sawHandleUpgradeCall = false;
    const collectFetchReturns = (node: TsNamespace.Node) => {
      if (node !== fetchBody && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) directReturns.push(node);
      if (ts.isCallExpression(node)) {
        const callee = unwrapAstExpr(node.expression);
        if (ts.isIdentifier(callee) && callee.text === "handleUpgrade") {
          sawHandleUpgradeCall = true;
        }
      }
      ts.forEachChild(node, collectFetchReturns);
    };
    if (fetchBody) collectFetchReturns(fetchBody);
    expect(sawHandleUpgradeCall).toBe(true);
    expect(directReturns).toHaveLength(3);

    const containsCallNamed = (
      root: TsNamespace.Node,
      name: string,
    ): boolean => {
      let found = false;
      const walk = (n: TsNamespace.Node) => {
        if (found) return;
        if (ts.isCallExpression(n)) {
          const callee = unwrapAstExpr(n.expression);
          if (ts.isIdentifier(callee) && callee.text === name) found = true;
        }
        ts.forEachChild(n, walk);
      };
      walk(root);
      return found;
    };

    const enclosingIfCondition = (
      node: TsNamespace.Node,
    ): TsNamespace.Expression | null => {
      let cur = node.parent;
      while (cur && cur !== fetchBody) {
        if (ts.isIfStatement(cur)) return cur.expression;
        cur = cur.parent;
      }
      return null;
    };

    for (const ret of directReturns) {
      const expr = ret.expression ? unwrapAstExpr(ret.expression) : undefined;
      if (
        expr &&
        ts.isCallExpression(expr) &&
        ts.isPropertyAccessExpression(unwrapAstExpr(expr.expression))
      ) {
        const pa = unwrapAstExpr(
          expr.expression,
        ) as TsNamespace.PropertyAccessExpression;
        if (
          ts.isIdentifier(unwrapAstExpr(pa.expression)) &&
          (unwrapAstExpr(pa.expression) as TsNamespace.Identifier).text ===
            "app" &&
          pa.name.text === "fetch"
        ) {
          continue;
        }
      }
      if (expr && ts.isIdentifier(expr) && expr.text === "upgradeResponse") {
        const cond = enclosingIfCondition(ret);
        if (cond?.getText(indexAst).includes("upgradeResponse")) {
          continue;
        }
      }
      const cond = enclosingIfCondition(ret);
      if (cond && containsCallNamed(cond, "isReplayedGatewayIdentity")) {
        continue;
      }
      throw new Error(
        `Unexpected pre-Hono return path in serve.fetch: ${ret.getText(indexAst)}`,
      );
    }
  });

  test("Bun.serve pre-Hono WebSocket upgrade routes enforce their session and access guards", async () => {
    const streamUrl = new URL(
      "http://inventory.test/api/computers/bot-1/stream",
    );
    const streamReq = () =>
      new Request(streamUrl.toString(), {
        method: "GET",
        headers: { upgrade: "websocket" },
      });

    const anonStream = await anonymousUpgrade(streamReq(), streamUrl, {
      upgrade: () => true,
    });
    expect(anonStream?.status).toBe(401);

    const deniedMemberStream = await memberUpgrade(streamReq(), streamUrl, {
      upgrade: () => true,
    });
    expect(deniedMemberStream?.status).toBe(404);

    // Team Bot seen via assignment (not owned, not public): must be refused (404)
    const deniedTeamMemberUpgrade = buildInventoryUpgradeHandler(
      { kind: "member", userId: "inventory-member" },
      {
        botProfile: {
          visibility: "private",
          ownerUserId: "other-user",
          assignedToMe: true,
        },
      },
    );
    expect(
      (
        await deniedTeamMemberUpgrade(streamReq(), streamUrl, {
          upgrade: () => true,
        })
      )?.status,
    ).toBe(404);

    // Owner member: allowed (upgraded -> undefined)
    const ownerUpgrade = buildInventoryUpgradeHandler(
      { kind: "member", userId: "inventory-member" },
      {
        botProfile: { visibility: "private", ownerUserId: "inventory-member" },
      },
    );
    expect(
      await ownerUpgrade(streamReq(), streamUrl, { upgrade: () => true }),
    ).toBeUndefined();

    // Public Bot: member allowed (upgraded -> undefined)
    const publicUpgrade = buildInventoryUpgradeHandler(
      { kind: "member", userId: "inventory-member" },
      { botProfile: { visibility: "public", ownerUserId: "other-user" } },
    );
    expect(
      await publicUpgrade(streamReq(), streamUrl, { upgrade: () => true }),
    ).toBeUndefined();

    // Admin on another user's private Bot: allowed (upgraded -> undefined)
    const adminUpgrade = buildInventoryUpgradeHandler(
      { kind: "admin", userId: "inventory-admin" },
      { botProfile: { visibility: "private", ownerUserId: "other-user" } },
    );
    expect(
      await adminUpgrade(streamReq(), streamUrl, { upgrade: () => true }),
    ).toBeUndefined();

    // Missing / deleted Bot: refused (404)
    const missingBotUpgrade = buildInventoryUpgradeHandler(
      { kind: "member", userId: "inventory-member" },
      { botProfile: null },
    );
    expect(
      (
        await missingBotUpgrade(streamReq(), streamUrl, {
          upgrade: () => true,
        })
      )?.status,
    ).toBe(404);

    const voiceUrl = new URL("http://inventory.test/api/voice/ws");
    const anonVoice = await anonymousUpgrade(
      new Request(voiceUrl.toString(), {
        method: "GET",
        headers: { upgrade: "websocket" },
      }),
      voiceUrl,
      { upgrade: () => true },
    );
    expect(anonVoice?.status).toBe(401);
  });

  test("routes refuse callers their classification forbids", async () => {
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
      if (entry.access === "machine" && anonymous >= 200 && anonymous < 300)
        return `${key}: anonymous got ${anonymous} — machine routes must reject callers without the machine credential`;
      return null;
    });
  }, 120_000); // ~1 300 in-process probes across both app builds.

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
