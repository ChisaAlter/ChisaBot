import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripCommentsAndStrings } from "../../shared/guard-lexer";

const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bmock\.module\s*\(/, what: "mock.module(" },
  { pattern: /\bvi\.mock\s*\(/, what: "vi.mock(" },
  { pattern: /\bjest\.mock\s*\(/, what: "jest.mock(" },
];

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return collectTsFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

export function findForbiddenModuleMocks(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  return FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(
    ({ what }) => what,
  );
}

describe("全局禁止 mock.module() 进程级模块污染（零白名单）", () => {
  test("app/tests、server/tests、shared 不得调用 mock.module / vi.mock / jest.mock", () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const roots = [
      path.join(repoRoot, "app/tests"),
      path.join(repoRoot, "server/tests"),
      path.join(repoRoot, "shared"),
    ];
    const selfPath = path.resolve(import.meta.path);
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of collectTsFiles(root)) {
        if (path.resolve(file) === selfPath) continue;
        const found = findForbiddenModuleMocks(readFileSync(file, "utf8"));
        if (found.length > 0) {
          const rel = path.relative(repoRoot, file).replaceAll("\\", "/");
          offenders.push(`${rel}（${found.join("、")}）`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("门禁自身单测：必须抓出真实 mock.module 调用，同时放过注释与字符串说明", () => {
    expect(findForbiddenModuleMocks("// mock.module('x', () => ({}))")).toEqual(
      [],
    );
    expect(findForbiddenModuleMocks('const doc = "vi.mock(a)";')).toEqual([]);
    expect(
      findForbiddenModuleMocks(
        'mock.module("@tanstack/react-router", () => ({}));',
      ),
    ).toEqual(["mock.module("]);
    expect(findForbiddenModuleMocks('vi.mock("fs", () => ({}));')).toEqual([
      "vi.mock(",
    ]);
    expect(findForbiddenModuleMocks('jest.mock("./x");')).toEqual([
      "jest.mock(",
    ]);
  });
});
