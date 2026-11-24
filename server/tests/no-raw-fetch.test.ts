import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stripCommentsAndStrings } from "../../shared/guard-lexer";

export { stripCommentsAndStrings };

/**
 * 红线护栏：禁止 `server/src` 在统一出口之外直接调用裸 `fetch(`、读取 `globalThis.fetch`，
 * 或把全局 `fetch` 作为值引用（例如 `options.fetchImpl ?? fetch`、`= fetch`）。
 * - 外部 URL 一律走 `shared/net/guarded-fetch.ts`（SSRF 校验 + DNS 钉死 + 跳数控制）。
 * - 受信任内部/模型端点一律走 `server/src/net/trusted-endpoint-fetch.ts`。
 */

const SERVER_SRC = resolve(import.meta.dir, "../src");
const INFRA_ALLOWLIST = new Set(["net/trusted-endpoint-fetch.ts"]);
const ALLOWED: Record<string, string> = {};

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

export function findRawFetchValueRefViolations(source: string): number[] {
  const cleaned = stripCommentsAndStrings(source);
  const lines = cleaned.split("\n");
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/\bglobalThis\s*\.\s*fetch\b/.test(line)) {
      hits.push(index + 1);
      continue;
    }
    const sanitized = line
      .replace(/\b(?:async\s+)?fetch\s*\([^)]*\)\s*(?::[^{;]+)?\{/g, "")
      .replace(/\btypeof\s+fetch\b/g, "")
      .replace(/\.\s*fetch\b/g, "")
      .replace(/\bfetch\s*\??\s*:/g, "");
    if (/(?<![\w$.])fetch(?!\s*\()(?![\w$])/.test(sanitized)) {
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

  test("value-ref detector catches ?? fetch, default params, and regex-preceded references", () => {
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
