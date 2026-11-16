import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripCommentsAndStrings } from "../../shared/guard-lexer";

/**
 * 唯一允许直接接触 `process.env` 的基础设施模块是 `server/src/config.ts`。
 * 所有业务模块必须消费 `DeploymentConfig` 或 `config.ts` 导出的类型化读取器，
 * 零白名单豁免。
 */
const INFRA_ALLOWLIST = new Set(["config.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.ts$/.test(name) && !name.endsWith(".test.ts") ? [full] : [];
  });
}

export { stripCommentsAndStrings };

export function findRawEnvViolations(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const violations: string[] = [];
  for (const match of code.matchAll(
    /\bprocess\s*\.\s*env\b(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)?/g,
  )) {
    violations.push(match[0].replace(/\s+/g, ""));
  }
  for (const match of code.matchAll(
    /\bdefaultRuntimeEnvironment\s*\(\s*\)\s*(?:\?\.|\.|\[)(?:[A-Za-z_$][A-Za-z0-9_$]*|[^\]]*\])?/g,
  )) {
    violations.push(match[0].replace(/\s+/g, ""));
  }
  return violations;
}

describe("no-raw-env boundary guard", () => {
  test("server/src 除 config.ts 外不允许任何 process.env 访问（零白名单）", () => {
    const root = path.join(import.meta.dir, "../src");
    const offenders = files(root)
      .map((file) => {
        const rel = path.relative(root, file).replaceAll("\\", "/");
        return {
          rel,
          violations: INFRA_ALLOWLIST.has(rel)
            ? []
            : findRawEnvViolations(readFileSync(file, "utf8")),
        };
      })
      .filter(({ violations }) => violations.length > 0)
      .map(
        ({ rel, violations }) =>
          `${rel}（${[...new Set(violations)].join("、")}）`,
      );
    expect(offenders).toEqual([]);
  });

  test("负向校验：能捕获所有变体的裸 env 读取", () => {
    expect(findRawEnvViolations("const a = process.env.FOO;")).toEqual([
      "process.env.FOO",
    ]);
    expect(findRawEnvViolations('const b = process.env["BAR"];')).toEqual([
      "process.env",
    ]);
    expect(findRawEnvViolations("const c = { ...process.env };")).toEqual([
      "process.env",
    ]);
    expect(
      findRawEnvViolations("function f(e = process.env) { return e; }"),
    ).toEqual(["process.env"]);
    expect(
      findRawEnvViolations("const d = `url=$" + "{process.env.HOST}/x`;"),
    ).toEqual(["process.env.HOST"]);
    expect(
      findRawEnvViolations("const e = defaultRuntimeEnvironment().SECRET;"),
    ).toEqual(["defaultRuntimeEnvironment().SECRET"]);
  });

  test("正向校验：忽略注释与纯字符串字面量，也不误伤函数默认值透传", () => {
    expect(
      findRawEnvViolations(`
        // documentation mentions process.env.FOO
        /* block mentions process.env["BAR"] */
        const doc = "process.env.BAZ and 'process.env.QUX'";
        const re = /process\\.env/.test("x");
        export function f(env = defaultRuntimeEnvironment()) { return env; }
      `),
    ).toEqual([]);
  });
});
