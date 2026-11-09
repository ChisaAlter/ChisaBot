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

const QA_LEAKS = [
  "sshpass -p PW_A1 ssh root@h",
  "sshpass -pPW_A2 ssh root@h",
  "mysql -u root -pPW_B1 db",
  "mysql -u root -p PW_B2 db",
  "redis-cli -a PW_C1 ping",
  "redis-cli -h x -a 'PW_C2 x' ping",
  "curl -u user:PW_D1 https://x.com",
  "curl --user user:PW_D2 https://x.com",
  'curl -u "user:PW_D3" https://x.com',
  "sshpass -p 'PW_G1' scp a b:/c",
];
/** QA 318-r2 文本变体：命令出现在一行中间。 */
/** QA 318-r3：命令紧跟在引号、$( 或反引号后面（嵌套写法）。左边是原文，右边是打码后的样子。 */
const QA_NESTED: [string, string][] = [
  ['"curl -u u:PW_N1 x"', '"curl -u u:•••• x"'],
  ["'sshpass -p PW_N2 ssh h'", "'sshpass -p •••• ssh h'"],
  ['bash -c "curl -u u:PW_N3 x"', 'bash -c "curl -u u:•••• x"'],
  ["sh -c 'sshpass -p PW_N4 ssh h'", "sh -c 'sshpass -p •••• ssh h'"],
  ['ssh host "mysql -u r -pPW_N5 db"', 'ssh host "mysql -u r -p•••• db"'],
  ["echo $(redis-cli -a PW_N6 ping)", "echo $(redis-cli -a •••• ping)"],
  ["x=`curl -u u:PW_N7 x`", "x=`curl -u u:•••• x`"],
  ['bash -c "curl -u \\"u:PW_N8\\" x"', 'bash -c "curl -u \\"u:••••\\" x"'],
  [
    "ssh h 'bash -c \"sshpass -p PW_N9 ssh -p 22 g\"'",
    "ssh h 'bash -c \"sshpass -p •••• ssh -p 22 g\"'",
  ],
  ['echo "$(mysql -p PW_N10 db)"', 'echo "$(mysql -p •••• db)"'],
  [
    'bash -c "cd /x; redis-cli -a PW_N11 ping"',
    'bash -c "cd /x; redis-cli -a •••• ping"',
  ],
];
const QA_MIDLINE = [
  "+ mysql -u root -pPW2 db",
  "root  1234  0.0  0.1 sshpass -p PW3 ssh h",
  "history: 12  curl -u u:PW6 https://a.com",
  "echo sshpass -p PW_A1 ssh root@h",
  "/usr/bin/sshpass -p PW_P1 ssh -p 22 h",
  "x=`mysql -pPW_Q1`",
];
const KEEP = [
  "mkdir -p KEEP_dir/a",
  "ssh -p 22 KEEP_host",
  "scp -P 2222 KEEP_f h:/x",
  "curl -k https://keep.com/",
  "tail -n 5 KEEP.log",
  "grep -r KEEP_pat .",
];

describe("activity redaction", () => {
  test("QA 318-r3: commands right after a quote, $( or backtick are masked in subject and output", () => {
    for (const [raw, masked] of QA_NESTED) {
      // subject：命令本身
      expect(redactText(raw)).toBe(masked);
      // output：回显、多行输出里的同一段
      expect(redactText(`echo ${raw}`)).toBe(`echo ${masked}`);
      expect(redactText(`ok\n+ ${raw}\ndone`)).toBe(`ok\n+ ${masked}\ndone`);
    }
    // 引号里不是表里的命令、或者没有口令的，原样不动。
    for (const keep of [
      'echo "ssh -p 22 KEEP_h"',
      'git commit -m "fix -p KEEP flag"',
      "sh -c 'mkdir -p KEEP_d'",
    ])
      expect(redactText(keep)).toBe(keep);
  });
  test("QA 318-r2: whitelisted commands are found anywhere in a line, not just at its start", () => {
    for (const command of QA_LEAKS) {
      const echoed = redactText(`echo ${command}\n`);
      expect(echoed).not.toContain("PW_");
      expect(echoed.startsWith("echo ")).toBe(true);
    }
    expect(redactText(QA_MIDLINE[0] as string)).toBe(
      "+ mysql -u root -p•••• db",
    );
    expect(redactText(QA_MIDLINE[1] as string)).toBe(
      "root  1234  0.0  0.1 sshpass -p •••• ssh h",
    );
    expect(redactText(QA_MIDLINE[2] as string)).toBe(
      "history: 12  curl -u u:•••• https://a.com/",
    );
    expect(redactText(QA_MIDLINE[3] as string)).toBe(
      "echo sshpass -p •••• ssh root@h",
    );
    expect(redactText(QA_MIDLINE[4] as string)).toBe(
      "/usr/bin/sshpass -p •••• ssh -p 22 h",
    );
    expect(redactText(QA_MIDLINE[5] as string)).toBe("x=`mysql -p••••`");
    for (const keep of KEEP) {
      expect(redactText(keep)).toBe(
        redactText(keep).includes("https://") ? redactText(keep) : keep,
      );
      expect(redactText(`echo ${keep}`)).toContain(
        keep.replace(" https://keep.com/", ""),
      );
    }
  });

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
  test("QA509: masks userinfo under any URL scheme in text", () => {
    const text = redactText(
      "psql postgres://app:pgpw123@db:5432/x; redis-cli -u redis://:rdpw456@cache:6379; mongosh mongodb+srv://u:mgpw789@c.example.net; ws wss://u:wspw000@h/s",
    );
    for (const secret of ["pgpw123", "rdpw456", "mgpw789", "wspw000"])
      expect(text).not.toContain(secret);
    expect(text).toContain("postgres://");
    expect(redactText("see https://example.com/a@b")).toBe(
      "see https://example.com/a@b",
    );
  });
  test("QA510 P3: userinfo policy — password masks both, a plain username stays, a token username is masked", () => {
    expect(redactText("git clone ssh://git@github.com/o/r")).toBe(
      "git clone ssh://git@github.com/o/r",
    );
    expect(redactUrl("https://deploy@example.com/x")).toBe(
      "https://deploy@example.com/x",
    );
    expect(redactText("psql postgres://app:pw@db/x")).toBe(
      `psql postgres://${MASK}:${MASK}@db/x`,
    );
    expect(redactUrl("https://bob:hunter2@example.com/")).toBe(
      `https://${MASK}:${MASK}@example.com/`,
    );
    for (const token of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "0123456789abcdef0123456789abcdef",
      "Ab3$xY9!kL",
    ]) {
      expect(redactUrl(`https://${token}@github.com/o/r`)).not.toContain(token);
      expect(redactText(`clone git+ssh://${token}@host/r`)).not.toContain(
        token,
      );
    }
  });
  test("QA510 P3: unencoded / # ? @ in a password are masked whole", () => {
    for (const url of [
      "postgres://app:sl/ash22@db/x",
      "ftp://u:ha#sh23@files/x",
      "amqp://u:qu?es24@mq/x",
      "https://u:a@b/c@host/x",
    ]) {
      const out = redactText(`connect ${url}`);
      expect(out).toContain(`${MASK}:${MASK}@`);
      for (const piece of ["ash22", "sh23", "es24", "c@host"])
        expect(out).not.toContain(piece);
    }
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
    [
      'sshpass -p "hunter 2" ssh -p 22 root@h',
      "sshpass -p •••• ssh -p 22 root@h",
    ],
    ["/usr/bin/sshpass -p 'hunter 2' ssh h", "/usr/bin/sshpass -p •••• ssh h"],
    [
      "cd /tmp && sudo -u ops sshpass -p hunter2 ssh h",
      "cd /tmp && sudo -u ops sshpass -p •••• ssh h",
    ],
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
    [
      "curl -u bob:hunter2 -k https://x.test/",
      "curl -u bob:•••• -k https://x.test/",
    ],
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
      redactDetail({
        n: 1,
        ok: true,
        a: ["sshpass -p x ssh"],
        o: { c: "mysql -px" },
      }),
    ).toEqual({
      n: 1,
      ok: true,
      a: ["sshpass -p •••• ssh"],
      o: { c: "mysql -p••••" },
    });
  });
});

/**
 * 长得像 URL 但 `new URL` 解析不了的串（`http://[`、`http://%`、半截的 `http://[::1`）：redactUrl 的
 * 兜底以前回调 redactText，而 redactText 又把它当 URL 送回 redactUrl——两个函数互递归直到爆栈
 * （活动记录 begin 实测 RangeError，整行记录丢掉；在 planFor 里抛还会把命令本身也挡掉）。
 */
describe("malformed URLs", () => {
  const broken = [
    "http://[",
    "http://%",
    "http://:",
    "https://#",
    "http://[::1",
  ];
  for (const bad of broken) {
    test(`redactText keeps "${bad}" without overflowing`, () => {
      expect(redactText(`see ${bad} now`)).toBe(`see ${bad} now`);
    });
  }
  test("redactUrl on a non-URL returns text-redacted input instead of recursing", () => {
    expect(redactUrl("http://[")).toBe("http://[");
    expect(redactUrl("http://[")).toBe("http://[");
  });
  test("a broken URL does not stop a parseable one beside it from being masked", () => {
    const out = redactText(`a http://[ b https://good.example/?ok=1&token=t9`);
    expect(out).toContain("http://[");
    expect(out).not.toContain("t9");
    expect(out).toContain("ok=1");
  });
  test("a broken URL inside a command still gets secret redaction", () => {
    const out = redactText("open http://[ && mysql -p hunter2 db");
    expect(out).toContain("http://[");
    expect(out).toContain("-p ••••");
  });
});

/** detail 之后要 JSON.stringify 进库：环和超深嵌套不拦会先炸递归、再把整行记录赔掉。 */
describe("redactDetail safety", () => {
  test("a circular detail degrades to null instead of overflowing", () => {
    const cyclic: Record<string, unknown> = { keep: "sshpass -p x ssh" };
    cyclic.self = cyclic;
    const out = redactDetail(cyclic) as Record<string, unknown>;
    expect(out.keep).toBe("sshpass -p •••• ssh");
    expect(out.self).toBeNull();
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("a deeply nested detail degrades to null instead of overflowing", () => {
    let deep: Record<string, unknown> = { leaf: "ok" };
    for (let i = 0; i < 200; i++) deep = { next: deep };
    const out = redactDetail(deep);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("an array detail is walked the same way", () => {
    const cyclic: unknown[] = ["mysql -px"];
    cyclic.push(cyclic);
    const out = redactDetail(cyclic) as unknown[];
    expect(out[0]).toBe("mysql -p••••");
    expect(out[1]).toBeNull();
  });
});
