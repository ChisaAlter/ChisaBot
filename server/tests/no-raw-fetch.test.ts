import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import type * as TsNamespace from "typescript";
import { stripCommentsAndStrings } from "../../shared/guard-lexer";

export { stripCommentsAndStrings };

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TsNamespace;

/**
 * 红线护栏：禁止 `server/src` 在统一出口之外直接调用裸 `fetch(`、经由全局对象变体
 * （`globalThis?.fetch`、`globalThis["fetch"]`、`Bun.fetch`、`self.fetch`、`const { fetch: f } = globalThis`、
 * `Reflect.get(globalThis, "fetch")` 等）绕过，或把全局 `fetch` 作为值引用（例如 `options.fetchImpl ?? fetch`）。
 * - 外部 URL 一律走 `shared/net/guarded-fetch.ts`（SSRF 校验 + DNS 钉死 + 跳数控制）。
 * - 受信任内部/模型端点一律走 `server/src/net/trusted-endpoint-fetch.ts`。
 */

const SERVER_SRC = resolve(import.meta.dir, "../src");
const INFRA_ALLOWLIST = new Set(["net/trusted-endpoint-fetch.ts"]);
const ALLOWED: Record<string, string> = {};

const GLOBAL_OBJECTS = new Set([
  "globalThis",
  "self",
  "window",
  "global",
  "Bun",
]);
const PREFILTER_RE = /\b(?:fetch|globalThis|self|window|global|Bun)\b/;

/**
 * 历史遗留的可注入 DI 默认值引用（`options.fetch ?? fetch` 等）：
 * 只减不增，逐文件封顶命中数；清完一处立即缩小或移出。
 */
const VALUE_REF_ALLOWLIST: Record<string, { maxHits: number; reason: string }> =
  {
    "channels/titler.ts": {
      maxHits: 1,
      reason: "DI default for configured model provider titling endpoint",
    },
    "chat-files/media-models.ts": {
      maxHits: 1,
      reason: "DI default for configured media model provider endpoint",
    },
    "chat-files/service.ts": {
      maxHits: 1,
      reason: "DI default for configured media/vision model endpoint",
    },
    "computer/client.ts": {
      maxHits: 1,
      reason: "DI default for internal agent-computer loopback service",
    },
    "computer/policy-network.ts": {
      maxHits: 3,
      reason: "DI default for internal agent-computer policy network calls",
    },
    "computer/sandbox.ts": {
      maxHits: 1,
      reason: "DI default for internal agent-computer sandbox service",
    },
    "dictation/provider.ts": {
      maxHits: 1,
      reason: "DI default for configured speech transcription provider",
    },
    "github/service.ts": {
      maxHits: 1,
      reason: "DI default for configured GitHub API base",
    },
    "im/qr-auth.ts": {
      maxHits: 2,
      reason:
        "DI default parameter for hardcoded IM vendor QR endpoints; callers pass guarded fetch",
    },
    "magpie.ts": {
      maxHits: 1,
      reason: "DI default for admin-configured Magpie gateway URL",
    },
    "model-catalog.ts": {
      maxHits: 1,
      reason: "DI default for configured model catalog endpoint",
    },
    "model-settings.ts": {
      maxHits: 1,
      reason: "DI default for admin-configured model settings probe",
    },
    "personal-sources/service.ts": {
      maxHits: 1,
      reason:
        "DI default passed into guardedFetch (which pins DNS when defaultFetch) and weather API",
    },
    "provider-oauth.ts": {
      maxHits: 1,
      reason: "DI default for hardcoded OAuth provider endpoints",
    },
    "skills-chisa/tools.ts": {
      maxHits: 1,
      reason:
        "DI default passed into guardedFetch (which detects defaultFetch and pins DNS)",
    },
    "vault/service.ts": {
      maxHits: 1,
      reason:
        "DI test fallback; default production branch calls guardedFetch directly",
    },
  };

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walkTs(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
      files.push(full);
  }
  return files;
}

function unwrapExpr(expr: TsNamespace.Expression): TsNamespace.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isStaticFetchString(node: TsNamespace.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text === "fetch";
  }
  return false;
}

function collectGlobalAliases(sf: TsNamespace.SourceFile): Set<string> {
  const globals = new Set(GLOBAL_OBJECTS);
  const declarations: TsNamespace.VariableDeclaration[] = [];
  const collectDecls = (node: TsNamespace.Node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, collectDecls);
  };
  collectDecls(sf);

  for (let pass = 0; pass < 5; pass += 1) {
    let added = false;
    for (const decl of declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const rhs = unwrapExpr(decl.initializer);
      if (ts.isIdentifier(rhs) && globals.has(rhs.text)) {
        if (!globals.has(decl.name.text)) {
          globals.add(decl.name.text);
          added = true;
        }
      }
    }
    if (!added) break;
  }
  return globals;
}

function isGlobalIdentifier(
  node: TsNamespace.Expression | undefined,
  globals: ReadonlySet<string>,
): boolean {
  if (!node) return false;
  const unwrapped = unwrapExpr(node);
  return ts.isIdentifier(unwrapped) && globals.has(unwrapped.text);
}

function bindingPatternCapturesFetch(
  pattern: TsNamespace.ObjectBindingPattern,
): boolean {
  for (const el of pattern.elements) {
    if (el.dotDotDotToken) return true;
    if (!el.propertyName) {
      if (ts.isIdentifier(el.name) && el.name.text === "fetch") return true;
      continue;
    }
    if (ts.isIdentifier(el.propertyName) && el.propertyName.text === "fetch") {
      return true;
    }
    if (isStaticFetchString(el.propertyName)) return true;
    if (ts.isComputedPropertyName(el.propertyName)) return true;
  }
  return false;
}

function objectLiteralDestructuresFetch(
  obj: TsNamespace.ObjectLiteralExpression,
): boolean {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) return true;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "fetch") {
      return true;
    }
    if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) && prop.name.text === "fetch") return true;
      if (isStaticFetchString(prop.name)) return true;
      if (ts.isComputedPropertyName(prop.name)) return true;
    }
  }
  return false;
}

function calleeName(expr: TsNamespace.Expression): string | null {
  const unwrapped = unwrapExpr(expr);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const base = unwrapExpr(unwrapped.expression);
    if (ts.isIdentifier(base)) return `${base.text}.${unwrapped.name.text}`;
  }
  return null;
}

function isInTypeContext(node: TsNamespace.Node): boolean {
  let cur: TsNamespace.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isTypeNode(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur) ||
      ts.isPropertySignature(cur) ||
      ts.isMethodSignature(cur) ||
      ts.isHeritageClause(cur) ||
      ts.isTypeParameterDeclaration(cur)
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function isDeclarationOrNonValueFetchIdentifier(
  id: TsNamespace.Identifier,
): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (isInTypeContext(id)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (
    (ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent)) &&
    parent.name === id
  ) {
    return true;
  }
  if (
    ts.isBindingElement(parent) &&
    (parent.propertyName === id || parent.name === id)
  ) {
    return true;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isLabeledStatement(parent) && parent.label === id)
  ) {
    return true;
  }
  return false;
}

const scanCache = new Map<
  string,
  { callAndGlobalHits: number[]; valueRefHits: number[] }
>();

function scanFetchAst(source: string): {
  callAndGlobalHits: number[];
  valueRefHits: number[];
} {
  if (!PREFILTER_RE.test(source)) {
    return { callAndGlobalHits: [], valueRefHits: [] };
  }
  const cacheKey = `${source.length}:${Bun.hash(source).toString(36)}`;
  const cached = scanCache.get(cacheKey);
  if (cached) return cached;
  const sf = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const globals = collectGlobalAliases(sf);
  const callAndGlobal = new Set<number>();
  const valueRefs = new Set<number>();

  const lineOf = (node: TsNamespace.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: TsNamespace.Node) => {
    if (!isInTypeContext(node)) {
      // (a) Direct bare fetch(...) or (fetch)(...) or fetch?.(...)
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpr(node.expression);
        if (ts.isIdentifier(callee) && callee.text === "fetch") {
          callAndGlobal.add(lineOf(node));
        }
        const namedCall = calleeName(node.expression);
        if (
          namedCall === "Reflect.get" ||
          namedCall === "Object.getOwnPropertyDescriptor" ||
          namedCall === "Object.getOwnPropertyDescriptors"
        ) {
          const targetArg = node.arguments[0];
          const keyArg = node.arguments[1];
          if (
            isGlobalIdentifier(targetArg, globals) ||
            ((namedCall === "Reflect.get" ||
              namedCall === "Object.getOwnPropertyDescriptor") &&
              isStaticFetchString(keyArg))
          ) {
            const line = lineOf(node);
            callAndGlobal.add(line);
            valueRefs.add(line);
          }
        } else if (
          (namedCall === "Object.assign" ||
            namedCall === "Object.entries" ||
            namedCall === "Object.values" ||
            namedCall === "Object.getOwnPropertyNames") &&
          node.arguments.some((arg) => isGlobalIdentifier(arg, globals))
        ) {
          const line = lineOf(node);
          callAndGlobal.add(line);
          valueRefs.add(line);
        }
      }

      // (b) globalThis.fetch / globalThis?.fetch / Bun.fetch / self.fetch / window.fetch / global.fetch / alias.fetch
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "fetch" &&
        isGlobalIdentifier(node.expression, globals)
      ) {
        const line = lineOf(node);
        callAndGlobal.add(line);
        valueRefs.add(line);
      }

      // (c) globalThis["fetch"] / globalThis?.["fetch"] / globalThis[k] / Bun[k] / self[k]
      if (
        ts.isElementAccessExpression(node) &&
        isGlobalIdentifier(node.expression, globals)
      ) {
        const line = lineOf(node);
        callAndGlobal.add(line);
        valueRefs.add(line);
      }

      // (d) const { fetch: send } = globalThis / const { fetch } = globalThis / const { ...g } = globalThis
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        isGlobalIdentifier(node.initializer, globals) &&
        bindingPatternCapturesFetch(node.name)
      ) {
        const line = lineOf(node);
        callAndGlobal.add(line);
        valueRefs.add(line);
      }

      // (d2) ({ fetch: send } = globalThis) assignment destructuring
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isObjectLiteralExpression(node.left) &&
        isGlobalIdentifier(node.right, globals) &&
        objectLiteralDestructuresFetch(node.left)
      ) {
        const line = lineOf(node);
        callAndGlobal.add(line);
        valueRefs.add(line);
      }

      // (e) { ...globalThis }
      if (
        ts.isSpreadAssignment(node) &&
        isGlobalIdentifier(node.expression, globals)
      ) {
        const line = lineOf(node);
        callAndGlobal.add(line);
        valueRefs.add(line);
      }

      // Value reference of bare identifier `fetch` (excluding direct `fetch(...)` call expressions and declarations/property keys)
      if (
        ts.isIdentifier(node) &&
        node.text === "fetch" &&
        !isDeclarationOrNonValueFetchIdentifier(node)
      ) {
        const directBareCall =
          ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (!directBareCall) {
          valueRefs.add(lineOf(node));
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  const result = {
    callAndGlobalHits: [...callAndGlobal].sort((a, b) => a - b),
    valueRefHits: [...valueRefs].sort((a, b) => a - b),
  };
  scanCache.set(cacheKey, result);
  return result;
}

export function findRawFetchViolations(source: string): number[] {
  return scanFetchAst(source).callAndGlobalHits;
}

export function findRawFetchValueRefViolations(source: string): number[] {
  return scanFetchAst(source).valueRefHits;
}

describe("no raw fetch in server/src", () => {
  test("zero business files invoke bare fetch() or evade via global object spellings", () => {
    expect(Object.keys(ALLOWED)).toEqual([]);

    const violations: string[] = [];
    const present = new Set<string>();
    for (const file of walkTs(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replaceAll("\\", "/");
      present.add(rel);
      if (INFRA_ALLOWLIST.has(rel) || rel in ALLOWED) continue;
      const lines = findRawFetchViolations(readFileSync(file, "utf8"));
      if (lines.length > 0) {
        violations.push(`${rel}: lines ${lines.join(", ")}`);
      }
    }

    for (const rel of Object.keys(ALLOWED)) {
      expect(existsSync(join(SERVER_SRC, rel))).toBe(true);
      expect(present.has(rel)).toBe(true);
    }

    expect(violations).toEqual([]);
  }, 30_000);

  test("no new files reference global fetch as a value outside allowlisted DI defaults", () => {
    const violations: string[] = [];
    const hitCounts = new Map<string, number>();

    for (const file of walkTs(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replaceAll("\\", "/");
      if (INFRA_ALLOWLIST.has(rel)) continue;
      const lines = findRawFetchValueRefViolations(readFileSync(file, "utf8"));
      hitCounts.set(rel, lines.length);
      const allow = VALUE_REF_ALLOWLIST[rel];
      if (!allow) {
        if (lines.length > 0) {
          violations.push(`${rel}: lines ${lines.join(", ")}`);
        }
        continue;
      }
      if (lines.length > allow.maxHits) {
        violations.push(
          `${rel}: ${lines.length} hits exceeds maxHits=${allow.maxHits} (lines ${lines.join(", ")})`,
        );
      }
    }

    for (const [rel, allow] of Object.entries(VALUE_REF_ALLOWLIST)) {
      expect(existsSync(join(SERVER_SRC, rel))).toBe(true);
      const count = hitCounts.get(rel) ?? 0;
      expect(
        count,
        `${rel} has 0 bare fetch value references — remove stale entry from VALUE_REF_ALLOWLIST (${allow.reason})`,
      ).toBeGreaterThanOrEqual(1);
    }

    expect(violations).toEqual([]);
  }, 30_000);

  test("detector catches bare fetch(), global object evasions, and ignores Bun server handler method", () => {
    expect(
      findRawFetchViolations(`const r = await fetch("https://evil.test");`),
    ).toEqual([1]);
    expect(findRawFetchViolations(`const r = globalThis.fetch(url);`)).toEqual([
      1,
    ]);
    expect(findRawFetchViolations(`const r = globalThis?.fetch(url);`)).toEqual(
      [1],
    );
    expect(
      findRawFetchViolations(`const r = globalThis["fetch"](url);`),
    ).toEqual([1]);
    expect(
      findRawFetchViolations("const r = globalThis[`fetch`](url);"),
    ).toEqual([1]);
    expect(
      findRawFetchViolations(
        `const k = "fetch"; const r = globalThis[k](url);`,
      ),
    ).toEqual([1]);
    expect(
      findRawFetchViolations(`const { fetch: send } = globalThis;`),
    ).toEqual([1]);
    expect(findRawFetchViolations(`const { fetch } = globalThis;`)).toEqual([
      1,
    ]);
    expect(findRawFetchViolations(`await Bun.fetch(url);`)).toEqual([1]);
    expect(findRawFetchViolations(`await self.fetch(url);`)).toEqual([1]);
    expect(findRawFetchViolations(`await window.fetch(url);`)).toEqual([1]);
    expect(findRawFetchViolations(`await global.fetch(url);`)).toEqual([1]);
    expect(
      findRawFetchViolations(`const f = Reflect.get(globalThis, "fetch");`),
    ).toEqual([1]);
    expect(
      findRawFetchViolations(
        `const d = Object.getOwnPropertyDescriptor(globalThis, "fetch");`,
      ),
    ).toEqual([1]);
    expect(findRawFetchViolations(`const copy = { ...globalThis };`)).toEqual([
      1,
    ]);
    expect(
      findRawFetchViolations(`const g = globalThis;\nawait g.fetch(url);`),
    ).toEqual([2]);
    expect(
      findRawFetchViolations(
        `export default { async fetch(request, server) { return new Response("ok"); } };`,
      ),
    ).toEqual([]);
  });

  test("value-ref detector catches ?? fetch, default params, evasions, and ignores type/member usages", () => {
    expect(
      findRawFetchValueRefViolations(
        `const doFetch = options.fetchImpl ?? fetch;`,
      ),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(
        `function f(impl = fetch) { return impl; }`,
      ),
    ).toEqual([1]);
    expect(findRawFetchValueRefViolations(`const fn = fetch;`)).toEqual([1]);
    expect(findRawFetchValueRefViolations(`const o = { fetch };`)).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(`await (opts.fetch ?? fetch)(url);`),
    ).toEqual([1]);
    expect(findRawFetchValueRefViolations(`return fetch;`)).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(
        `const re = /(["'\`])\\/api\\//gu;\nconst f = opts.fetch ?? fetch;`,
      ),
    ).toEqual([2]);
    expect(
      findRawFetchValueRefViolations(
        "const s = `$" + "{opts.fetch ?? fetch}`;",
      ),
    ).toEqual([1]);
    expect(findRawFetchValueRefViolations(`await Bun.fetch(url);`)).toEqual([
      1,
    ]);
    expect(findRawFetchValueRefViolations(`await self.fetch(url);`)).toEqual([
      1,
    ]);
    expect(
      findRawFetchValueRefViolations(`await globalThis?.fetch(url);`),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(`await globalThis["fetch"](url);`),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(`const { fetch: send } = globalThis;`),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(
        `const f = Reflect.get(globalThis, "fetch");`,
      ),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(
        [
          `type F = typeof fetch;`,
          `const r = await options.fetch(url);`,
          `const obj = { fetch: impl };`,
          `interface Opts { fetch?: typeof fetch; }`,
          `export default { async fetch(req: Request) { return new Response("ok"); } };`,
          `const s = "fetch"; // fetch`,
          `const rx = /fetch failed/i;`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
