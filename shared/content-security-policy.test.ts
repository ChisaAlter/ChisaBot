import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appContentSecurityPolicy,
  CSP_REPORT_ONLY_HEADER,
  createAppCspReader,
  inlineScriptHashes,
} from "./content-security-policy";

const sha = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name = "", ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("主应用 CSP（审查 S1）", () => {
  test("先用 Report-Only 下发", () => {
    expect(CSP_REPORT_ONLY_HEADER).toBe("Content-Security-Policy-Report-Only");
  });

  test("内联脚本按 sha256 列出，带 src 的脚本不算", () => {
    const html = `<head><script>var a = 1;</script><script src="/auth/workspace.js"></script>
      <script type="module" src="/assets/index.js"></script><script id="boot">
      (function () {})();
    </script></head>`;
    expect(inlineScriptHashes(html)).toEqual([
      sha("var a = 1;"),
      sha("\n      (function () {})();\n    "),
    ]);
  });

  test("策略禁止插件、外部 base、被别站嵌入，脚本不放开 unsafe-inline", () => {
    const policy = directives(appContentSecurityPolicy([sha("x")]));
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    const scripts = policy.get("script-src") ?? [];
    expect(scripts).toContain("'self'");
    expect(scripts).toContain(sha("x"));
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(
      scripts.some((source) => source.startsWith("http") || source === "*"),
    ).toBe(false);
    expect(policy.get("connect-src")?.[0]).toBe("'self'");
  });

  test("读构建出来的 index.html，文件变了策略跟着变；读不到时退回无哈希策略", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chisabot-csp-"));
    try {
      const index = join(directory, "index.html");
      const read = createAppCspReader(index);
      expect(await read()).toBe(appContentSecurityPolicy());
      await writeFile(index, "<script>one()</script>");
      expect(await read()).toContain(sha("one()"));
      await writeFile(index, "<script>second()</script>");
      const updated = await read();
      expect(updated).toContain(sha("second()"));
      expect(updated).not.toContain(sha("one()"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
