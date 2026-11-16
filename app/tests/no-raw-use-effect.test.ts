import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripCommentsAndStrings } from "../../shared/guard-lexer";

const FORBIDDEN_WRAPPER_NAMES = [
  "useMount",
  "useUnmount",
  "useOnce",
  "useEffectOnce",
  "useUpdateEffect",
  "useCustomEffect",
  "useAsyncEffect",
  "useIsomorphicLayoutEffect",
];

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return collectTsFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

export function findRawUseEffectViolations(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const hits: string[] = [];
  for (const match of code.matchAll(/\buseEffect\b/g)) {
    hits.push(match[0]);
  }
  return hits;
}

function extractParenGroup(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1);
}

export function findHookWrapperViolations(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const violations: string[] = [];
  for (const name of FORBIDDEN_WRAPPER_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(code)) {
      violations.push(`forbidden-wrapper:${name}`);
    }
  }
  if (/\bDependencyList\b/.test(code)) {
    violations.push("forbidden-deps-type:DependencyList");
  }
  if (/[,(]\s*(?:deps|dependencies)\s*[?:]/.test(code)) {
    violations.push("forbidden-deps-param-token");
  }
  for (const match of code.matchAll(
    /export\s+(?:async\s+)?function\s+(use[A-Z]\w*)\b/g,
  )) {
    const fnName = match[1] ?? "";
    const afterName = (match.index ?? 0) + match[0].length;
    const openParen = code.indexOf("(", afterName);
    const params = openParen >= 0 ? extractParenGroup(code, openParen) : "";
    if (/use.*Effect/i.test(fnName)) {
      violations.push(`forbidden-effect-hook-name:${fnName}`);
    }
    if (/\b(?:deps|dependencies)\s*[?:]/.test(params)) {
      violations.push(`forbidden-deps-param:${fnName}`);
    }
  }
  return violations;
}

describe("no-raw-use-effect architecture guard", () => {
  test("app/src 除 app/src/hooks 外严禁出现任何 useEffect 引用（零白名单）", () => {
    const root = path.join(import.meta.dir, "../src");
    const offenders = collectTsFiles(root)
      .map((file) => ({
        rel: path.relative(root, file).replaceAll("\\", "/"),
        source: readFileSync(file, "utf8"),
      }))
      .filter(({ rel }) => !rel.startsWith("hooks/"))
      .map(({ rel, source }) => ({
        rel,
        hits: findRawUseEffectViolations(source),
      }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ rel, hits }) => `${rel}（${hits.length} 处）`);

    expect(offenders).toEqual([]);
  });

  test("app/src/hooks 内禁止生命周期透传包装器或 DependencyList 逃生参数", () => {
    const hooksRoot = path.join(import.meta.dir, "../src/hooks");
    const offenders = collectTsFiles(hooksRoot)
      .map((file) => ({
        rel: path.relative(hooksRoot, file).replaceAll("\\", "/"),
        violations: findHookWrapperViolations(readFileSync(file, "utf8")),
      }))
      .filter(({ violations }) => violations.length > 0)
      .map(({ rel, violations }) => `${rel}（${violations.join("、")}）`);

    expect(offenders).toEqual([]);
  });

  test("负向校验：能捕获所有变体的裸 useEffect 与假封装", () => {
    expect(findRawUseEffectViolations("import { useEffect } from 'react';")).toEqual([
      "useEffect",
    ]);
    expect(findRawUseEffectViolations("React.useEffect(() => {}, []);")).toEqual([
      "useEffect",
    ]);
    expect(findRawUseEffectViolations("const fn = useEffect;")).toEqual([
      "useEffect",
    ]);
    expect(
      findHookWrapperViolations(
        "export function useMount(fn: () => void) { return fn; }",
      ),
    ).toEqual(["forbidden-wrapper:useMount"]);
    expect(
      findHookWrapperViolations(
        "export function useWatch(cb: () => void, deps: DependencyList) {}",
      ),
    ).toEqual([
      "forbidden-deps-type:DependencyList",
      "forbidden-deps-param-token",
      "forbidden-deps-param:useWatch",
    ]);
    expect(
      findHookWrapperViolations(
        "export function useCallbackDeps<T>(cb: (x: T) => void, deps?: unknown[]) {}",
      ),
    ).toEqual([
      "forbidden-deps-param-token",
      "forbidden-deps-param:useCallbackDeps",
    ]);
    expect(
      findHookWrapperViolations(
        "export function useSafeEffect(cb: () => void) {}",
      ),
    ).toEqual(["forbidden-effect-hook-name:useSafeEffect"]);
  });

  test("正向校验：忽略注释与字符串中的字面量", () => {
    expect(
      findRawUseEffectViolations(`
        // 历史上这里用过 useEffect
        /* useEffect(() => {}, []) */
        const doc = "useEffect and React.useEffect";
        useExternalConnection("chat", () => {});
      `),
    ).toEqual([]);
  });
});
