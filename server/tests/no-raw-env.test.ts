import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

function canPrecedeRegex(prevTokenEndChar: string, prevWord: string): boolean {
  if (!prevTokenEndChar) return true;
  if ("([{:;,=!?&|~+-*%^<>".includes(prevTokenEndChar)) return true;
  return /^(return|case|throw|typeof|void|delete|await|yield|else|do|in|of|instanceof)$/.test(
    prevWord,
  );
}

/**
 * 词法级剥离注释与字符串字面量，同时保留模板字符串 `${...}` 插值内部的代码。
 * 正因如此，注释里的文档说明不会误报，而藏在模板插值或括号里的真实读取一定会被抓出。
 */
export function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  type Mode =
    | "code"
    | "lineComment"
    | "blockComment"
    | "single"
    | "double"
    | "template";
  let mode: Mode = "code";
  const templateBraceStack: number[] = [];
  let inRegexClass = false;
  let inRegex = false;
  let prevSigChar = "";
  let currentWord = "";
  let prevWord = "";

  const flushWord = () => {
    if (currentWord) {
      prevWord = currentWord;
      currentWord = "";
    }
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inRegex) {
      out.push(" ");
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (ch === "[") inRegexClass = true;
      else if (ch === "]" && inRegexClass) inRegexClass = false;
      else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        prevSigChar = "/";
        prevWord = "";
      }
      continue;
    }

    if (mode === "lineComment") {
      if (ch === "\n") {
        mode = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      continue;
    }

    if (mode === "blockComment") {
      if (ch === "*" && next === "/") {
        out.push("  ");
        i++;
        mode = "code";
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      out.push(ch === "\n" ? "\n" : " ");
      if (ch === "\\") {
        if (i + 1 < source.length) {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (ch === quote) {
        mode = "code";
        prevSigChar = quote;
        prevWord = "";
      }
      continue;
    }

    if (mode === "template") {
      if (ch === "\\") {
        out.push(" ");
        if (i + 1 < source.length) {
          out.push(source[i + 1] === "\n" ? "\n" : " ");
          i++;
        }
        continue;
      }
      if (ch === "`") {
        out.push(" ");
        mode = "code";
        prevSigChar = "`";
        prevWord = "";
        continue;
      }
      if (ch === "$" && next === "{") {
        out.push("  ");
        i++;
        templateBraceStack.push(1);
        mode = "code";
        prevSigChar = "{";
        prevWord = "";
        continue;
      }
      out.push(ch === "\n" ? "\n" : " ");
      continue;
    }

    // mode === "code"
    if (ch === "/" && next === "/") {
      flushWord();
      out.push("  ");
      i++;
      mode = "lineComment";
      continue;
    }
    if (ch === "/" && next === "*") {
      flushWord();
      out.push("  ");
      i++;
      mode = "blockComment";
      continue;
    }
    if (ch === "/" && canPrecedeRegex(prevSigChar, prevWord)) {
      flushWord();
      out.push(" ");
      inRegex = true;
      inRegexClass = false;
      continue;
    }
    if (ch === "'") {
      flushWord();
      out.push(" ");
      mode = "single";
      continue;
    }
    if (ch === '"') {
      flushWord();
      out.push(" ");
      mode = "double";
      continue;
    }
    if (ch === "`") {
      flushWord();
      out.push(" ");
      mode = "template";
      continue;
    }

    if (ch === "{" && templateBraceStack.length > 0) {
      templateBraceStack[templateBraceStack.length - 1] =
        (templateBraceStack[templateBraceStack.length - 1] ?? 0) + 1;
    } else if (ch === "}" && templateBraceStack.length > 0) {
      const depth =
        (templateBraceStack[templateBraceStack.length - 1] ?? 1) - 1;
      if (depth === 0) {
        templateBraceStack.pop();
        flushWord();
        out.push(" ");
        mode = "template";
        continue;
      }
      templateBraceStack[templateBraceStack.length - 1] = depth;
    }

    out.push(ch);
    if (/[A-Za-z0-9_$]/.test(ch)) {
      currentWord += ch;
      prevSigChar = ch;
    } else if (!/\s/.test(ch)) {
      flushWord();
      prevSigChar = ch;
      prevWord = "";
    } else {
      flushWord();
    }
  }

  return out.join("");
}

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
