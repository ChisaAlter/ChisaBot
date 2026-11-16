import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * 红线护栏：禁止 `server/src` 在统一出口之外直接调用裸 `fetch(` 或读取 `globalThis.fetch`。
 * - 外部 URL 一律走 `shared/net/guarded-fetch.ts`（SSRF 校验 + DNS 钉死 + 跳数控制）。
 * - 受信任内部/模型端点一律走 `server/src/net/trusted-endpoint-fetch.ts`。
 */

const SERVER_SRC = resolve(import.meta.dir, "../src");
const INFRA_ALLOWLIST = new Set(["net/trusted-endpoint-fetch.ts"]);
const ALLOWED: Record<string, string> = {};

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

export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function findRawFetchViolations(source: string): number[] {
  const cleaned = stripCommentsAndStrings(source);
  const lines = cleaned.split("\n");
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const withoutServeHandler = line.replace(
      /\b(?:async\s+)?fetch\s*\([^)]*\)\s*(?::[^{;]+)?\{/g,
      "",
    );
    if (
      /(?<![\w.$])fetch\s*\(/.test(withoutServeHandler) ||
      /\bglobalThis\s*\.\s*fetch\b/.test(withoutServeHandler)
    ) {
      hits.push(index + 1);
    }
  }
  return hits;
}

describe("no raw fetch in server/src", () => {
  test("zero business files invoke bare fetch() or globalThis.fetch", () => {
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
  });

  test("detector catches synthetic bare fetch() and ignores Bun server handler method", () => {
    expect(
      findRawFetchViolations(`const r = await fetch("https://evil.test");`),
    ).toEqual([1]);
    expect(findRawFetchViolations(`const r = globalThis.fetch(url);`)).toEqual([
      1,
    ]);
    expect(
      findRawFetchViolations(
        `export default { async fetch(request, server) { return new Response("ok"); } };`,
      ),
    ).toEqual([]);
  });
});
