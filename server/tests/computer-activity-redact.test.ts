import { describe, expect, test } from "bun:test";
import {
  clip,
  isSensitiveField,
  looksLikeSecret,
  MASK,
  redactDetail,
  redactText,
  redactUrl,
} from "../src/computer/activity-redact";

describe("activity redaction", () => {
  test("masks token-like query parameters and keeps the rest", () => {
    const out = redactUrl(
      "https://example.com/cb?code=abc123&state=ok&access_token=zzz&api_key=k",
    );
    expect(out).toContain("state=ok");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("zzz");
    expect(out).not.toContain("=k");
    expect(out).toContain(encodeURIComponent(MASK).length ? "code=" : "");
  });
  test("masks userinfo", () => {
    expect(redactUrl("https://bob:hunter2@example.com/")).not.toContain(
      "hunter2",
    );
  });
  test("masks secrets inside command text", () => {
    const text = redactText(
      "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x.dev/?token=t1 && API_KEY=sekrit run --password p4ss",
    );
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("t1");
    expect(text).not.toContain("sekrit");
    expect(text).not.toContain("p4ss");
  });
  test("detects sensitive fields and secret-shaped text", () => {
    expect(isSensitiveField({ role: "textbox", name: "Password" })).toBe(true);
    expect(isSensitiveField({ role: "textbox", name: "搜索" })).toBe(false);
    expect(looksLikeSecret(`ghp_${"a".repeat(36)}`)).toBe(true);
    expect(looksLikeSecret("hello world")).toBe(false);
  });
  test("clips long output", () => {
    const { text, truncated } = clip("x".repeat(100), 10);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(12);
  });
});

/**
 * CB-101 QA：短参数后隔一个空格跟口令（`sshpass -p hunter2`）以前原样落库。短参数只按命令打码，
 * 下面同时锁住「必须打」和「不能误伤」两边。
 */
describe("short-flag passwords, by command", () => {
  const masked: [string, string][] = [
    ["sshpass -p hunter2 ssh root@h", "sshpass -p •••• ssh root@h"],
    ["sshpass -phunter2 ssh root@h", "sshpass -p•••• ssh root@h"],
    ['sshpass -p "hunter 2" ssh -p 22 root@h', "sshpass -p •••• ssh -p 22 root@h"],
    ["/usr/bin/sshpass -p 'hunter 2' ssh h", "/usr/bin/sshpass -p •••• ssh h"],
    ["cd /tmp && sudo -u ops sshpass -p hunter2 ssh h", "cd /tmp && sudo -u ops sshpass -p •••• ssh h"],
    ["sshpass -p x mysql -phunter2", "sshpass -p •••• mysql -p••••"],
    ["mysql -u root -phunter2 db", "mysql -u root -p•••• db"],
    ["mysql -u root -p hunter2 db", "mysql -u root -p •••• db"],
    ['mysqldump -p"hunter 2" db', "mysqldump -p•••• db"],
    ["mysql --password hunter2", "mysql --password ••••"],
    ["mysql --password=hunter2", "mysql --password=••••"],
    ['mysql --password="hunter 2" db', "mysql --password=•••• db"],
    ["tool --db-password=hunter2", "tool --db-password=••••"],
    ["tool --access-token hunter2", "tool --access-token ••••"],
    ["redis-cli -a hunter2 ping", "redis-cli -a •••• ping"],
    ["zip -P hunter2 a.zip f", "zip -P •••• a.zip f"],
    ["unzip -P hunter2 a.zip", "unzip -P •••• a.zip"],
    ["7z x -phunter2 a.7z", "7z x -p•••• a.7z"],
    ["openssl enc -k hunter2 -in f", "openssl enc -k •••• -in f"],
    ["openssl rsa -passin pass:hunter2", "openssl rsa -passin ••••"],
    ["vault login -token hunter2", "vault login -token ••••"],
    ["curl -u bob:hunter2 -k https://x.test/", "curl -u bob:•••• -k https://x.test/"],
    ["MYSQL_PWD=hunter2 mysql", "MYSQL_PWD=•••• mysql"],
    ["SSHPASS=hunter2 sshpass -e ssh h", "SSHPASS=•••• sshpass -e ssh h"],
  ];
  for (const [input, expected] of masked) {
    test(`masks: ${input}`, () => {
      expect(redactText(input)).toBe(expected);
      // 幂等：写入路径上可能打两遍。
      expect(redactText(redactText(input))).toBe(expected);
    });
  }

  const untouched = [
    "mkdir -p dir/sub",
    "ssh -p 22 root@h",
    "scp -P 2222 a h:/tmp",
    "curl -k https://x.test/",
    "mysql -h db -P 3306 -u root -p",
    "git push -p origin",
    "PWD=/home ls",
    "ls --no-password x",
    "cp -p a b",
  ];
  for (const input of untouched) {
    test(`keeps: ${input}`, () => {
      expect(redactText(input)).toBe(input);
    });
  }

  test("redactDetail masks nested strings and keeps other values", () => {
    expect(
      redactDetail({ n: 1, ok: true, a: ["sshpass -p x ssh"], o: { c: "mysql -px" } }),
    ).toEqual({ n: 1, ok: true, a: ["sshpass -p •••• ssh"], o: { c: "mysql -p••••" } });
  });
});
