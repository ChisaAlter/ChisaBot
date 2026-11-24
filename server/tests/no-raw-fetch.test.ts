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
 * 红线护栏：禁止 `server/src` 在统一出口之外通过任何词法/语法途径触达全局 `fetch`：
 * - 包括直接调用 `fetch(...)`、`fetch.call/bind/apply`、`(0, fetch)(...)`、`this.fetch`；
 * - 包括一切全局命名空间引用（`globalThis`、`self`、`window`、`global`，以及 `Bun.<nonProp>` / `Bun.fetch` / `Bun["fetch"]`）；
 * - 包括从 `"bun"` 导入/导出 `fetch`（含重命名/命名空间/默认导入）、动态 `import(x)` / `import("bun")`、
 *   非受控 `require` / `import.meta.require` / `.getBuiltinModule`；
 * - 包括动态代码执行（`eval`、`Function`、`.constructor`、`with`、`setTimeout/setInterval` 字符串参数）；
 * - 以及把全局 `fetch` 作为值引用（例如 `options.fetchImpl ?? fetch`，按逐次 AST 出现计数，严禁同文件同行夹带）。
 * 唯一统一出口：
 * - 外部 URL 一律走 `shared/net/guarded-fetch.ts`（SSRF 校验 + DNS 钉死 + 跳数控制）。
 * - 受信任内部/模型端点一律走 `server/src/net/trusted-endpoint-fetch.ts`。
 */

const SERVER_SRC = resolve(import.meta.dir, "../src");
const INFRA_ALLOWLIST = new Set(["net/trusted-endpoint-fetch.ts"]);
const ALLOWED: Record<string, string> = {};

const BANNED_FREE_GLOBALS = new Set(["globalThis", "self", "window", "global"]);
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const IGNORED_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/**
 * 历史遗留的可注入 DI 默认值引用（`options.fetch ?? fetch` 等）：
 * 只减不增，逐文件封顶命中数（按逐次 AST 出现计数，不做同行去重）；清完一处立即缩小或移出。
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

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walkSourceFiles(full));
    } else if (SOURCE_FILE_RE.test(name) && !IGNORED_FILE_RE.test(name)) {
      files.push(full);
    }
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
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      current = current.right;
      continue;
    }
    return current;
  }
}

function isStaticString(
  node: TsNamespace.Node | undefined,
  expected?: string,
): boolean {
  if (!node) return false;
  const target = ts.isExpression(node) ? unwrapExpr(node) : node;
  if (
    ts.isStringLiteral(target) ||
    ts.isNoSubstitutionTemplateLiteral(target)
  ) {
    return expected === undefined ? true : target.text === expected;
  }
  return false;
}

function isInTypeContext(node: TsNamespace.Node): boolean {
  let cur: TsNamespace.Node | undefined = node.parent;
  let prev: TsNamespace.Node = node;
  while (cur) {
    if (ts.isExpressionWithTypeArguments(cur)) {
      const heritage = cur.parent;
      if (
        heritage &&
        ts.isHeritageClause(heritage) &&
        heritage.token === ts.SyntaxKind.ExtendsKeyword &&
        heritage.parent &&
        ts.isClassLike(heritage.parent) &&
        prev === cur.expression
      ) {
        prev = cur;
        cur = cur.parent;
        continue;
      }
      return true;
    }
    if (ts.isHeritageClause(cur)) {
      if (
        cur.token === ts.SyntaxKind.ExtendsKeyword &&
        cur.parent &&
        ts.isClassLike(cur.parent)
      ) {
        prev = cur;
        cur = cur.parent;
        continue;
      }
      return true;
    }
    if (
      ts.isTypeNode(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur) ||
      ts.isPropertySignature(cur) ||
      ts.isMethodSignature(cur) ||
      ts.isTypeParameterDeclaration(cur)
    ) {
      return true;
    }
    prev = cur;
    cur = cur.parent;
  }
  return false;
}

function collectPatternNames(
  name: TsNamespace.BindingName,
  out: Set<string>,
): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) {
      collectPatternNames(el.name, out);
    }
  }
}

function collectStatementBindings(
  st: TsNamespace.Statement,
  names: Set<string>,
): void {
  if (ts.isVariableStatement(st)) {
    for (const decl of st.declarationList.declarations) {
      collectPatternNames(decl.name, names);
    }
  } else if (ts.isFunctionDeclaration(st) && st.name) {
    names.add(st.name.text);
  } else if (ts.isClassDeclaration(st) && st.name) {
    names.add(st.name.text);
  } else if (ts.isEnumDeclaration(st)) {
    names.add(st.name.text);
  } else if (ts.isImportDeclaration(st) && st.importClause) {
    if (st.importClause.name) {
      names.add(st.importClause.name.text);
    }
    const namedBindings = st.importClause.namedBindings;
    if (namedBindings) {
      if (ts.isNamespaceImport(namedBindings)) {
        names.add(namedBindings.name.text);
      } else {
        for (const spec of namedBindings.elements) {
          names.add(spec.name.text);
        }
      }
    }
  }
}

function collectScopeBindings(scopeNode: TsNamespace.Node): Set<string> {
  const names = new Set<string>();
  if (
    ts.isSourceFile(scopeNode) ||
    ts.isBlock(scopeNode) ||
    ts.isModuleBlock(scopeNode)
  ) {
    for (const st of scopeNode.statements) {
      collectStatementBindings(st, names);
    }
  } else if (ts.isCaseBlock(scopeNode)) {
    for (const clause of scopeNode.clauses) {
      for (const st of clause.statements) {
        collectStatementBindings(st, names);
      }
    }
  } else if (
    (ts.isForStatement(scopeNode) ||
      ts.isForInStatement(scopeNode) ||
      ts.isForOfStatement(scopeNode)) &&
    scopeNode.initializer &&
    ts.isVariableDeclarationList(scopeNode.initializer)
  ) {
    for (const decl of scopeNode.initializer.declarations) {
      collectPatternNames(decl.name, names);
    }
  } else if (ts.isCatchClause(scopeNode) && scopeNode.variableDeclaration) {
    collectPatternNames(scopeNode.variableDeclaration.name, names);
  }
  return names;
}

function isNonValueIdentifier(id: TsNamespace.Identifier): boolean {
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
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumDeclaration(parent) ||
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
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isNamespaceExport(parent) ||
    (ts.isLabeledStatement(parent) && parent.label === id)
  ) {
    return true;
  }
  return false;
}

function isDirectBareFetchCall(id: TsNamespace.Identifier): boolean {
  let cur: TsNamespace.Node = id;
  while (cur.parent) {
    const p = cur.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      cur = p;
      continue;
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      p.right === cur
    ) {
      cur = p;
      continue;
    }
    break;
  }
  return Boolean(
    cur.parent &&
      ts.isCallExpression(cur.parent) &&
      cur.parent.expression === cur,
  );
}

function staticMemberAccessName(
  expr: TsNamespace.Expression,
): { target: TsNamespace.Expression; property: string } | null {
  const unwrapped = unwrapExpr(expr);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return { target: unwrapped.expression, property: unwrapped.name.text };
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    (ts.isStringLiteral(unwrapped.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped.argumentExpression))
  ) {
    return {
      target: unwrapped.expression,
      property: unwrapped.argumentExpression.text,
    };
  }
  return null;
}

function isCreateRequireCall(expr: TsNamespace.Expression): boolean {
  const unwrapped = unwrapExpr(expr);
  if (!ts.isCallExpression(unwrapped)) return false;
  const callee = unwrapExpr(unwrapped.expression);
  if (ts.isIdentifier(callee) && callee.text === "createRequire") return true;
  const member = staticMemberAccessName(callee);
  return member?.property === "createRequire";
}

function isImportMetaRequireExpr(expr: TsNamespace.Expression): boolean {
  const member = staticMemberAccessName(expr);
  if (member?.property !== "require") return false;
  const target = unwrapExpr(member.target);
  return (
    ts.isMetaProperty(target) &&
    target.keywordToken === ts.SyntaxKind.ImportKeyword &&
    target.name.text === "meta"
  );
}

const scanCache = new Map<
  string,
  { callAndGlobalHits: number[]; valueRefHits: number[] }
>();

function scanFetchAst(
  source: string,
  fileName = "source.ts",
): {
  callAndGlobalHits: number[];
  valueRefHits: number[];
} {
  const cacheKey = `${fileName}:${source.length}:${Bun.hash(source).toString(36)}`;
  const cached = scanCache.get(cacheKey);
  if (cached) return cached;

  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const callAndGlobal = new Set<number>();
  const valueRefs: number[] = [];
  const scopes: Set<string>[] = [];

  // Track `const requireCjs = createRequire(...)` in the file.
  const requireAliases = new Set<string>();
  const requireAliasDeclIds = new Set<TsNamespace.Identifier>();
  const collectAliases = (node: TsNamespace.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequireCall(node.initializer)
    ) {
      const list = node.parent;
      if (
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0
      ) {
        requireAliases.add(node.name.text);
        requireAliasDeclIds.add(node.name);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sf);

  const isShadowed = (name: string): boolean =>
    scopes.some((scope) => scope.has(name));

  const lineOf = (node: TsNamespace.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const flagGlobal = (node: TsNamespace.Node): void => {
    const line = lineOf(node);
    callAndGlobal.add(line);
    valueRefs.push(line);
  };

  const checkNodeRules = (node: TsNamespace.Node): void => {
    if (isInTypeContext(node)) return;

    // Rule C1: Static `import ... from "bun"`
    if (
      ts.isImportDeclaration(node) &&
      isStaticString(node.moduleSpecifier, "bun") &&
      node.importClause
    ) {
      const clause = node.importClause;
      let bad = Boolean(clause.name);
      if (!bad && clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          bad = true;
        } else {
          for (const spec of clause.namedBindings.elements) {
            const imported = (spec.propertyName ?? spec.name).text;
            if (imported === "fetch" || imported === "getBuiltinModule") {
              bad = true;
            }
          }
        }
      }
      if (bad) flagGlobal(node);
    }

    // Rule C2: Static `export ... from "bun"`
    if (
      ts.isExportDeclaration(node) &&
      isStaticString(node.moduleSpecifier, "bun")
    ) {
      let bad = !node.exportClause;
      if (!bad && node.exportClause) {
        if (ts.isNamespaceExport(node.exportClause)) {
          bad = true;
        } else {
          for (const spec of node.exportClause.elements) {
            if ((spec.propertyName ?? spec.name).text === "fetch") {
              bad = true;
            }
          }
        }
      }
      if (bad) flagGlobal(node);
    }

    // Rule D: `with (...)`
    if (ts.isWithStatement(node)) {
      flagGlobal(node);
    }

    // `this.fetch` / `this["fetch"]`
    const member =
      ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
        ? staticMemberAccessName(node)
        : null;
    if (
      member &&
      member.property === "fetch" &&
      unwrapExpr(member.target).kind === ts.SyntaxKind.ThisKeyword
    ) {
      flagGlobal(node);
    }

    // `.constructor` / `["constructor"]` / `.getBuiltinModule` / `["getBuiltinModule"]`
    if (
      member &&
      (member.property === "constructor" ||
        member.property === "getBuiltinModule")
    ) {
      flagGlobal(node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      !member &&
      ts.isMetaProperty(unwrapExpr(node.expression))
    ) {
      flagGlobal(node);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "require" &&
      isImportMetaRequireExpr(node)
    ) {
      flagGlobal(node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      member?.property === "require" &&
      isImportMetaRequireExpr(node)
    ) {
      flagGlobal(node);
    }

    // Rule E2: `fetch.<member>` / `fetch[expr]` (e.g. fetch.call, fetch.apply, fetch.bind)
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const base = unwrapExpr(node.expression);
      if (
        ts.isIdentifier(base) &&
        base.text === "fetch" &&
        !isShadowed("fetch")
      ) {
        callAndGlobal.add(lineOf(node));
      }
    }

    if (ts.isNewExpression(node)) {
      const ctor = unwrapExpr(node.expression);
      if (
        ts.isIdentifier(ctor) &&
        ctor.text === "Proxy" &&
        !isShadowed("Proxy")
      ) {
        const arg0 = node.arguments?.[0];
        if (arg0) {
          const target = unwrapExpr(arg0);
          if (
            ts.isIdentifier(target) &&
            target.text === "fetch" &&
            !isShadowed("fetch")
          ) {
            callAndGlobal.add(lineOf(node));
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpr(node.expression);

      // Rule E1: Bare `fetch(...)`, `(fetch)(...)`, `(0, fetch)(...)`, `fetch?.(...)`
      if (
        ts.isIdentifier(callee) &&
        callee.text === "fetch" &&
        !isShadowed("fetch")
      ) {
        callAndGlobal.add(lineOf(node));
      }

      // Rule C3: Dynamic `import(arg)` — only allow static non-"bun" strings
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const arg0 = node.arguments[0];
        if (!arg0 || !isStaticString(arg0) || isStaticString(arg0, "bun")) {
          flagGlobal(node);
        }
      }

      // Rule C4: `require(...)`, `requireCjs(...)`, `createRequire(...)("bun")`
      if (
        (ts.isIdentifier(callee) &&
          ((callee.text === "require" && !isShadowed("require")) ||
            (requireAliases.has(callee.text) && !isShadowed(callee.text)))) ||
        isCreateRequireCall(callee)
      ) {
        const arg0 = node.arguments[0];
        if (!arg0 || !isStaticString(arg0) || isStaticString(arg0, "bun")) {
          flagGlobal(node);
        }
      }

      // Rule D4: `setTimeout("...", ...)` / `setInterval("...", ...)` / template / binary string
      if (
        ts.isIdentifier(callee) &&
        (callee.text === "setTimeout" || callee.text === "setInterval") &&
        !isShadowed(callee.text)
      ) {
        const arg0 = node.arguments[0];
        if (arg0) {
          const expr0 = unwrapExpr(arg0);
          if (
            ts.isStringLiteral(expr0) ||
            ts.isNoSubstitutionTemplateLiteral(expr0) ||
            ts.isTemplateExpression(expr0) ||
            ts.isBinaryExpression(expr0)
          ) {
            flagGlobal(node);
          }
        }
      }

      // Rule C5 / E3 / E4: `.getBuiltinModule`, `Reflect.apply`, `Reflect.get`, `getOwnPropertyDescriptor`
      const calleeMember = staticMemberAccessName(callee);
      if (calleeMember) {
        const obj = unwrapExpr(calleeMember.target);
        const objName = ts.isIdentifier(obj) ? obj.text : null;

        if (calleeMember.property === "getBuiltinModule") {
          flagGlobal(node);
        } else if (
          objName === "Reflect" &&
          !isShadowed("Reflect") &&
          calleeMember.property === "apply"
        ) {
          const arg0 = node.arguments[0];
          if (arg0) {
            const target = unwrapExpr(arg0);
            if (
              ts.isIdentifier(target) &&
              target.text === "fetch" &&
              !isShadowed("fetch")
            ) {
              callAndGlobal.add(lineOf(node));
            }
          }
        } else if (
          ((objName === "Reflect" &&
            !isShadowed("Reflect") &&
            (calleeMember.property === "get" ||
              calleeMember.property === "getOwnPropertyDescriptor")) ||
            (objName === "Object" &&
              !isShadowed("Object") &&
              calleeMember.property === "getOwnPropertyDescriptor")) &&
          isStaticString(node.arguments[1], "fetch")
        ) {
          const line = lineOf(node);
          callAndGlobal.add(line);
          const targetArg = node.arguments[0]
            ? unwrapExpr(node.arguments[0])
            : undefined;
          const targetIsTrackedFreeGlobal = Boolean(
            targetArg &&
              ts.isIdentifier(targetArg) &&
              (BANNED_FREE_GLOBALS.has(targetArg.text) ||
                targetArg.text === "Bun") &&
              !isShadowed(targetArg.text),
          );
          if (!targetIsTrackedFreeGlobal) {
            valueRefs.push(line);
          }
        }
      }
    }

    // Identifier checks (Rules A, B, C4/C5, D, and per-occurrence `fetch` valueRefs)
    if (ts.isIdentifier(node) && !isNonValueIdentifier(node)) {
      const name = node.text;
      if (!isShadowed(name)) {
        if (BANNED_FREE_GLOBALS.has(name)) {
          flagGlobal(node);
        } else if (name === "Bun") {
          const parent = node.parent;
          const safeStaticProp =
            parent &&
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            parent.name.text !== "fetch" &&
            parent.name.text !== "constructor";
          if (!safeStaticProp) {
            flagGlobal(node);
          }
        } else if (
          name === "eval" ||
          name === "Function" ||
          name === "getBuiltinModule"
        ) {
          flagGlobal(node);
        } else if (name === "fetch" && !isDirectBareFetchCall(node)) {
          valueRefs.push(lineOf(node));
        }
      }

      // Guard `requireAliases` (only allowed as direct call target inside its file)
      if (requireAliases.has(name) && !requireAliasDeclIds.has(node)) {
        const p = node.parent;
        const directCallTarget =
          p && ts.isCallExpression(p) && p.expression === node;
        if (!directCallTarget) {
          flagGlobal(node);
        }
      }
    }
  };

  const visit = (node: TsNamespace.Node): void => {
    checkNodeRules(node);

    // FunctionLike has dedicated lexical scope rules:
    // fnNameScope -> paramScope (each parameter's initializer only sees earlier parameters) -> body
    if (ts.isFunctionLike(node)) {
      const fnNameScope = new Set<string>();
      if (
        "name" in node &&
        node.name &&
        ts.isIdentifier(node.name) &&
        !ts.isFunctionDeclaration(node)
      ) {
        fnNameScope.add(node.name.text);
      }
      scopes.push(fnNameScope);

      const paramScope = new Set<string>();
      scopes.push(paramScope);

      for (const dec of ts.getDecorators(node as TsNamespace.HasDecorators) ??
        []) {
        visit(dec);
      }
      for (const tp of node.typeParameters ?? []) {
        visit(tp);
      }
      for (const param of node.parameters) {
        // Visit decorators, computed binding property keys, type, and initializers
        // BEFORE adding `param.name`'s own bindings to `paramScope`.
        ts.forEachChild(param, visit);
        collectPatternNames(param.name, paramScope);
      }
      if (node.type) {
        visit(node.type);
      }
      if ("body" in node && node.body) {
        visit(node.body);
      }

      scopes.pop();
      scopes.pop();
      return;
    }

    const createsScope =
      ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isCatchClause(node);

    if (createsScope) {
      scopes.push(collectScopeBindings(node));
    }

    ts.forEachChild(node, visit);

    if (createsScope) {
      scopes.pop();
    }
  };

  visit(sf);

  const result = {
    callAndGlobalHits: [...callAndGlobal].sort((a, b) => a - b),
    valueRefHits: valueRefs.sort((a, b) => a - b),
  };
  scanCache.set(cacheKey, result);
  return result;
}

export function findRawFetchViolations(
  source: string,
  fileName = "source.ts",
): number[] {
  return scanFetchAst(source, fileName).callAndGlobalHits;
}

export function findRawFetchValueRefViolations(
  source: string,
  fileName = "source.ts",
): number[] {
  return scanFetchAst(source, fileName).valueRefHits;
}

describe("no raw fetch in server/src", () => {
  test("zero business files invoke bare fetch(), evade via globals/bun/dynamic code, or leave ts/js unscanned", () => {
    expect(Object.keys(ALLOWED)).toEqual([]);

    const violations: string[] = [];
    const present = new Set<string>();
    for (const file of walkSourceFiles(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replaceAll("\\", "/");
      present.add(rel);
      if (INFRA_ALLOWLIST.has(rel) || rel in ALLOWED) continue;
      const lines = findRawFetchViolations(readFileSync(file, "utf8"), file);
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

  test("no new files reference global fetch as a value outside allowlisted DI defaults, with exact per-occurrence caps", () => {
    const violations: string[] = [];
    const hitCounts = new Map<string, number>();

    for (const file of walkSourceFiles(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replaceAll("\\", "/");
      if (INFRA_ALLOWLIST.has(rel)) continue;
      const lines = findRawFetchValueRefViolations(
        readFileSync(file, "utf8"),
        file,
      );
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

  test("detector catches R2/R3 evasions (heritage, nested globals, bun imports, dynamic code, .js) without false positives", () => {
    const shouldCatch = [
      `const r = await fetch("https://evil.test");`,
      `class H extends keep(fetch(u)) {}`,
      `(0, globalThis).fetch(u);`,
      `globalThis.globalThis.fetch(u);`,
      `globalThis.Bun.fetch(u);`,
      `const g = () => globalThis; g().fetch(u);`,
      `((g: typeof globalThis) => g.fetch(u))(globalThis);`,
      `let g: typeof globalThis; g = globalThis; g.fetch(u);`,
      `const o = { g: globalThis }; o.g.fetch(u);`,
      `class G { static g = globalThis; } G.g.fetch(u);`,
      `Reflect.getOwnPropertyDescriptor(globalThis, "fetch")?.value(u);`,
      `function h({ fetch: f }: typeof globalThis = globalThis) { return f(u); }`,
      `const [{ fetch: f }] = [globalThis]; f(u);`,
      `const { globalThis: { fetch: f } } = globalThis; f(u);`,
      `import { fetch as send } from "bun"; send(u);`,
      `import { "fetch" as send } from "bun"; send(u);`,
      `import * as B from "bun"; B.fetch(u);`,
      `import B from "bun"; B.fetch(u);`,
      `await import("bun");`,
      `await import(modName);`,
      `new Function("u", "return fetch(u)")(u);`,
      `eval("fetch(u)");`,
      `(() => {}).constructor("return fetch")()(u);`,
      `setTimeout("fetch(u)", 0);`,
      `process.getBuiltinModule("bun");`,
      `import.meta.require("bun");`,
      `fetch.call(undefined, u);`,
      `fetch.bind(null)(u);`,
      `(0, fetch)(u);`,
      `this.fetch(u);`,
      `f\\u0065tch(u);`,
      `global\\u0054his.fetch(u);`,
      `function f(x = globalThis) { const globalThis = 1; return x; }`,
      `function selfInit(globalThis = globalThis) { return globalThis; }`,
    ];
    for (const snippet of shouldCatch) {
      expect(
        findRawFetchViolations(snippet),
        `Expected call/global detector to flag: ${snippet}`,
      ).not.toEqual([]);
    }

    // `.js` files parse properly via fileName
    expect(
      findRawFetchViolations(`export const go = (u) => fetch(u);`, "probe.js"),
    ).toEqual([1]);

    // Same-line multiple value-refs are NOT collapsed by line number
    expect(
      findRawFetchValueRefViolations(
        `const a = opts.fetch ?? fetch; const b = fetch;`,
      ),
    ).toEqual([1, 1]);
    expect(
      findRawFetchViolations(
        `const call = options.fetchImpl ?? fetch.bind(void fetch.call(undefined, U));`,
      ),
    ).toEqual([1]);
    expect(
      findRawFetchValueRefViolations(
        `const call = options.fetchImpl ?? fetch.bind(void fetch.call(undefined, U));`,
      ),
    ).toEqual([1, 1]);

    // Legitimate non-fetch patterns must remain 0 hits
    expect(
      findRawFetchViolations(
        [
          `import { SQL } from "bun";`,
          `import { serve } from "bun";`,
          `const f = Bun.file("/tmp/a");`,
          `Bun.spawn(["echo"]);`,
          `const window = 100; const doubled = window * 2;`,
          `const self = "bot"; self.trim();`,
          `type F = typeof fetch;`,
          `interface Opts { fetch?: typeof fetch; }`,
          `const r = await options.fetch(url);`,
          `const req = createRequire(import.meta.url); req("./local.js");`,
          `export default { async fetch(request: Request) { return new Response("ok"); } };`,
        ].join("\n"),
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
