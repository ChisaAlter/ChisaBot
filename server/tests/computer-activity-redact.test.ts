import { describe, expect, test } from "bun:test";
import {
  clip,
  isSensitiveConfigName,
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
    // 设备审计摘要曾原样写入 shell 命令：ima 的 CLIENTID / APIKEY 都要打掉（2026-11-09 线上 28 条泄漏）。
    [
      "$env:IMA_OPENAPI_CLIENTID='cid1234567890'; $env:IMA_OPENAPI_APIKEY='sekritvalue123456'; node wrap.mjs",
      "$env:IMA_OPENAPI_CLIENTID=••••; $env:IMA_OPENAPI_APIKEY=••••; node wrap.mjs",
    ],
    [
      "set IMA_OPENAPI_CLIENTID=cid1234567890&& set IMA_OPENAPI_APIKEY=sekritvalue123456&& node wrap.mjs",
      "set IMA_OPENAPI_CLIENTID=••••&& set IMA_OPENAPI_APIKEY=••••&& node wrap.mjs",
    ],
    ["OAUTH_CLIENT_ID=abc123def456", "OAUTH_CLIENT_ID=••••"],
    ["OAUTH_CLIENT_SECRET=sekritvalue123456", "OAUTH_CLIENT_SECRET=••••"],
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

describe("QA514 samples", () => {
  // QA514 全量样本（来自 cb-qa/514-qa/qa/cases514.json）
  const qa514: Array<{
    id: string;
    kind: "secret" | "keep";
    text: string;
    secrets?: string[];
    keep?: string[];
  }> = [
    {
      id: "ima-inline",
      kind: "secret",
      text: "IMA_OPENAPI_CLIENTID=FAKEcid0001 IMA_OPENAPI_APIKEY=FAKEkey0002 node wrap.mjs",
      secrets: ["FAKEcid0001", "FAKEkey0002"],
      keep: ["IMA_OPENAPI_CLIENTID", "IMA_OPENAPI_APIKEY", "node wrap.mjs"],
    },
    {
      id: "ima-export-dq",
      kind: "secret",
      text: 'export IMA_OPENAPI_APIKEY="FAKEkey0003 with space" && node wrap.mjs',
      secrets: ["FAKEkey0003"],
      keep: ["IMA_OPENAPI_APIKEY"],
    },
    {
      id: "ima-ps-env-noSpace",
      kind: "secret",
      text: "$env:IMA_OPENAPI_CLIENTID='FAKEcid0004'; $env:IMA_OPENAPI_APIKEY='FAKEkey0005'; node wrap.mjs",
      secrets: ["FAKEcid0004", "FAKEkey0005"],
    },
    {
      id: "ima-ps-env-spaces",
      kind: "secret",
      text: "$env:IMA_OPENAPI_CLIENTID = 'FAKEcid0006'; $env:IMA_OPENAPI_APIKEY = \"FAKEkey0007\"; node wrap.mjs",
      secrets: ["FAKEcid0006", "FAKEkey0007"],
      keep: ["IMA_OPENAPI_CLIENTID"],
    },
    {
      id: "ima-cmd-set-quoted",
      kind: "secret",
      text: 'set "IMA_OPENAPI_APIKEY=FAKEkey0008" && node wrap.mjs',
      secrets: ["FAKEkey0008"],
    },
    {
      id: "ima-cmd-set-amp",
      kind: "secret",
      text: "set IMA_OPENAPI_CLIENTID=FAKEcid0009&& set IMA_OPENAPI_APIKEY=FAKEkey0010&& node wrap.mjs",
      secrets: ["FAKEcid0009", "FAKEkey0010"],
    },
    {
      id: "ima-json",
      kind: "secret",
      text: 'echo \'{"IMA_OPENAPI_APIKEY":"FAKEkey0011","IMA_OPENAPI_CLIENTID":"FAKEcid0012"}\' > cfg.json',
      secrets: ["FAKEkey0011", "FAKEcid0012"],
      keep: ["cfg.json"],
    },
    {
      id: "json-client-spaces",
      kind: "secret",
      text: 'node -e \'f({"client_id": "FAKEcid0013", "client_secret": "FAKEsec0014"})\' ',
      secrets: ["FAKEcid0013", "FAKEsec0014"],
    },
    {
      id: "lower-client_id",
      kind: "secret",
      text: "client_id=FAKEcid0015 ./run.sh",
      secrets: ["FAKEcid0015"],
      keep: ["./run.sh"],
    },
    {
      id: "camel-clientId",
      kind: "secret",
      text: "clientId=FAKEcid0016 node a.js",
      secrets: ["FAKEcid0016"],
    },
    {
      id: "CLIENT_ID",
      kind: "secret",
      text: "GOOGLE_CLIENT_ID=FAKEcid0017 GOOGLE_CLIENT_SECRET=FAKEsec0018 npm start",
      secrets: ["FAKEcid0017", "FAKEsec0018"],
      keep: ["npm start"],
    },
    {
      id: "flag-client-id",
      kind: "secret",
      text: "ima-cli --client-id FAKEcid0019 --client-secret FAKEsec0020 --api-key FAKEkey0021",
      secrets: ["FAKEcid0019", "FAKEsec0020", "FAKEkey0021"],
    },
    {
      id: "flag-client-id-eq",
      kind: "secret",
      text: "ima-cli --client-id=FAKEcid0022 --apikey=FAKEkey0023",
      secrets: ["FAKEcid0022", "FAKEkey0023"],
    },
    {
      id: "url-query",
      kind: "secret",
      text: 'curl "https://ima.qq.com/openapi/x?client_id=FAKEcid0024&api_key=FAKEkey0025&clientid=FAKEcid0026&page=2"',
      secrets: ["FAKEcid0024", "FAKEkey0025", "FAKEcid0026"],
      keep: ["page=2"],
    },
    {
      id: "url-userinfo",
      kind: "secret",
      text: "git clone https://u:FAKEpw0027@github.com/a/b.git",
      secrets: ["FAKEpw0027"],
    },
    {
      id: "headers",
      kind: "secret",
      text: 'curl -H "X-Api-Key: FAKEkey0028" -H "Authorization: Bearer FAKEtok0029abcdefgh" -H "X-Client-Id: FAKEcid0030" https://e.x/',
      secrets: ["FAKEkey0028", "FAKEtok0029abcdefgh", "FAKEcid0030"],
    },
    {
      id: "yaml",
      kind: "secret",
      text: "printf 'IMA_OPENAPI_APIKEY: FAKEkey0031\\nIMA_OPENAPI_CLIENTID: FAKEcid0032\\n' > .env.yml",
      secrets: ["FAKEkey0031", "FAKEcid0032"],
    },
    {
      id: "docker-e",
      kind: "secret",
      text: "docker run -e IMA_OPENAPI_APIKEY=FAKEkey0033 --env IMA_OPENAPI_CLIENTID=FAKEcid0034 img",
      secrets: ["FAKEkey0033", "FAKEcid0034"],
      keep: ["docker run", "img"],
    },
    {
      id: "multiline-cmd",
      kind: "secret",
      text: "cat > .env <<EOF\nIMA_OPENAPI_APIKEY=FAKEkey0035\nIMA_OPENAPI_CLIENTID=FAKEcid0036\nPATH=/usr/bin\nEOF",
      secrets: ["FAKEkey0035", "FAKEcid0036"],
      keep: ["PATH=/usr/bin"],
    },
    {
      id: "generic-keys",
      kind: "secret",
      text: "DB_PASSWORD=FAKEpw0037 GITHUB_TOKEN=FAKEtok0038 AWS_SECRET_ACCESS_KEY=FAKEsec0039 MY_API_KEY=FAKEkey0040 PASSWORD=FAKEpw0041 password=FAKEpw0042 x",
      secrets: [
        "FAKEpw0037",
        "FAKEtok0038",
        "FAKEsec0039",
        "FAKEkey0040",
        "FAKEpw0041",
        "FAKEpw0042",
      ],
    },
    {
      id: "plain-_KEY",
      kind: "secret",
      text: "OPENAI_KEY=FAKEkey0043 STRIPE_KEY=FAKEkey0044 IMA_OPENAPI_KEY=FAKEkey0045 SECRET_KEY_BASE=FAKEsec0046 x",
      secrets: ["FAKEkey0043", "FAKEkey0044", "FAKEkey0045", "FAKEsec0046"],
    },
    {
      id: "ima-token-secret",
      kind: "secret",
      text: "IMA_OPENAPI_TOKEN=FAKEtok0047 IMA_OPENAPI_SECRET=FAKEsec0048 x",
      secrets: ["FAKEtok0047", "FAKEsec0048"],
    },
    {
      id: "long-value",
      kind: "secret",
      text: "IMA_OPENAPI_APIKEY=FAKElongQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ node x",
      secrets: ["FAKElong", "QQQQQQQQ"],
    },
    {
      id: "straddle-300",
      kind: "secret",
      text: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa IMA_OPENAPI_APIKEY=FAKEstraddle0049zzzzzzzzzzzzzzzzzzzz",
      secrets: ["FAKEstr", "FAKEstraddle0049"],
    },
    {
      id: "straddle-sk",
      kind: "secret",
      text: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa sk-FAKEskvalue0050abcdefghijklmnop",
      secrets: ["FAKEskv", "FAKEskvalue0050"],
    },
    {
      id: "err-detail",
      kind: "secret",
      text: "spawn failed: IMA_OPENAPI_APIKEY=FAKEkey0051 IMA_OPENAPI_CLIENTID=FAKEcid0052",
      secrets: ["FAKEkey0051", "FAKEcid0052"],
    },
    {
      id: "env-dump-detail",
      kind: "secret",
      text: "exit 1\nIMA_OPENAPI_APIKEY=FAKEkey0053\nIMA_OPENAPI_CLIENTID=FAKEcid0054\nHOME=/root",
      secrets: ["FAKEkey0053", "FAKEcid0054"],
      keep: ["HOME=/root"],
    },
    {
      id: "diff-detail",
      kind: "secret",
      text: "true",
      secrets: ["FAKEkey0055", "FAKEcid0056"],
    },
    {
      id: "local-audit",
      kind: "secret",
      text: "本机执行：$env:IMA_OPENAPI_APIKEY='FAKEkey0057'; IMA_OPENAPI_CLIENTID=FAKEcid0058 node x",
      secrets: ["FAKEkey0057", "FAKEcid0058"],
    },
    {
      id: "plain-cmd",
      kind: "keep",
      text: "ls -la /home/qa/project && cat README.md | grep -n client",
    },
    {
      id: "normal-env",
      kind: "keep",
      text: "PATH=/usr/local/bin:$PATH HOME=/root NODE_ENV=production PORT=3000 LANG=C.UTF-8 node server.js",
    },
    {
      id: "client-idle",
      kind: "keep",
      text: "CLIENT_IDLE_TIMEOUT=30 CLIENT_IDENTIFIER_HEADER=x-req node s.js",
    },
    {
      id: "max-tokens",
      kind: "keep",
      text: "MAX_TOKENS=4096 KEYBOARD=us TOKENIZER=bert node s.js",
    },
    {
      id: "names-only",
      kind: "keep",
      text: "echo $IMA_OPENAPI_APIKEY $IMA_OPENAPI_CLIENTID; unset IMA_OPENAPI_APIKEY",
    },
    {
      id: "empty-value",
      kind: "keep",
      text: 'IMA_OPENAPI_APIKEY= node x.js; IMA_OPENAPI_CLIENTID="" node y.js',
    },
    {
      id: "files",
      kind: "keep",
      text: "cat client_id.txt api_key_rotation.md secret-santa.txt ./config/clientid.example",
    },
    {
      id: "email-time-ver",
      kind: "keep",
      text: "git commit -m 'release v1.2.3 by qa@example.com at 2026-11-09 21:00:00 error:500'",
    },
    {
      id: "urls",
      kind: "keep",
      text: "curl https://example.com/docs/api?page=2&lang=zh https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz",
    },
    {
      id: "ports-paths",
      kind: "keep",
      text: "ssh -p 22 user@host 'cd /srv/app && mkdir -p logs' && docker run -p 8080:80 img",
    },
    { id: "pwd", kind: "keep", text: "PWD=/tmp/work cd $PWD" },
    {
      id: "git-msg",
      kind: "keep",
      text: 'git commit -m "fix client id handling for ima openapi"',
    },
    // SUMMARY 补充样本
    {
      id: "ps-space",
      kind: "secret",
      text: "$env:IMA_OPENAPI_CLIENTID = 'FAKEcid0006'; $env:IMA_OPENAPI_APIKEY = \"FAKEkey0007\"",
      secrets: ["FAKEcid0006", "FAKEkey0007"],
    },
    {
      id: "json-ima",
      kind: "secret",
      text: '{"IMA_OPENAPI_APIKEY":"FAKEjk1","IMA_OPENAPI_CLIENTID":"FAKEjc1"}',
      secrets: ["FAKEjk1", "FAKEjc1"],
    },
    {
      id: "json-oauth",
      kind: "secret",
      text: '{"client_id": "FAKEcid", "client_secret": "FAKEsec"}',
      secrets: ["FAKEcid", "FAKEsec"],
    },
    {
      id: "yaml-plain",
      kind: "secret",
      text: "IMA_OPENAPI_APIKEY: FAKEyaml1",
      secrets: ["FAKEyaml1"],
    },
    {
      id: "flag-client-id",
      kind: "secret",
      text: "tool --client-id FAKEcidFLAG --api-key=FAKEapikey",
      secrets: ["FAKEcidFLAG", "FAKEapikey"],
    },
    {
      id: "hdr-x-api",
      kind: "secret",
      text: 'curl -H "X-Api-Key: FAKEhdr1" -H "X-Client-Id: FAKEhdr2"',
      secrets: ["FAKEhdr1", "FAKEhdr2"],
    },
    {
      id: "key-suffix",
      kind: "secret",
      text: "OPENAI_KEY=FAKEok1 STRIPE_KEY=FAKEsk1",
      secrets: ["FAKEok1", "FAKEsk1"],
    },
    {
      id: "semi-pass",
      kind: "secret",
      text: "DB_PASSWORD=pa;ss1234",
      secrets: ["pa;ss1234"],
    },
    {
      id: "pipe-pass",
      kind: "secret",
      text: "API_KEY=ab|cd1234",
      secrets: ["ab|cd1234"],
    },
    // QA514 r2
    {
      id: "ps-SetEnvironmentVariable",
      kind: "secret",
      text: '[Environment]::SetEnvironmentVariable("IMA_OPENAPI_APIKEY","FAKEkey0062","Process"); node wrap.mjs',
      secrets: ["FAKEkey0062"],
      keep: ["node wrap.mjs", "Process"],
    },
    {
      id: "ps-SetEnvironmentVariable-sq-user",
      kind: "secret",
      text: "[Environment]::SetEnvironmentVariable('DB_PASSWORD','FAKEpwSetEnv','User')",
      secrets: ["FAKEpwSetEnv"],
      keep: ["User"],
    },
    {
      id: "ps-SetEnvironmentVariable-system",
      kind: "secret",
      text: '[System.Environment]::SetEnvironmentVariable("IMA_OPENAPI_CLIENTID","FAKEcidSys","Machine")',
      secrets: ["FAKEcidSys"],
      keep: ["Machine"],
    },
    {
      id: "setx-plain",
      kind: "secret",
      text: "setx IMA_OPENAPI_APIKEY FAKEkeySetx1",
      secrets: ["FAKEkeySetx1"],
    },
    {
      id: "setx-quoted",
      kind: "secret",
      text: 'setx DB_PASSWORD "pa ss setx"',
      secrets: ["pa ss setx"],
    },
    {
      id: "set-item-env",
      kind: "secret",
      text: "Set-Item env:IMA_OPENAPI_APIKEY FAKEkeySetItem1",
      secrets: ["FAKEkeySetItem1"],
    },
    {
      id: "set-item-path-value",
      kind: "secret",
      text: 'Set-Item -Path Env:IMA_OPENAPI_APIKEY -Value "FAKEkeySetItem2"',
      secrets: ["FAKEkeySetItem2"],
    },
    {
      id: "set-item-quoted-path",
      kind: "secret",
      text: "Set-Item -Path 'Env:DB_PASSWORD' -Value 'FAKEpwSetItem3'",
      secrets: ["FAKEpwSetItem3"],
    },
    {
      id: "amp-in-value",
      kind: "secret",
      text: "DB_PASSWORD=pa&ss1234 ./run",
      secrets: ["pa&ss1234", "ss1234"],
      keep: ["./run"],
    },
    {
      id: "amp-in-value-quoted",
      kind: "secret",
      text: "DB_PASSWORD='pa&ss1234' ./run",
      secrets: ["pa&ss1234"],
      keep: ["./run"],
    },
    {
      id: "semi-in-value",
      kind: "secret",
      text: "DB_PASSWORD=pa;ss1234 ./run",
      secrets: ["pa;ss1234", "ss1234"],
      keep: ["./run"],
    },
    {
      id: "pipe-in-value",
      kind: "secret",
      text: "API_KEY=ab|cd1234 ./run",
      secrets: ["ab|cd1234", "cd1234"],
      keep: ["./run"],
    },
    {
      id: "pipe-then-cmd",
      kind: "secret",
      text: "API_KEY=ab|cd1234 | grep x",
      secrets: ["ab|cd1234", "cd1234"],
      keep: ["grep x"],
    },
    {
      id: "semi-then-cmd",
      kind: "secret",
      text: "DB_PASSWORD=pa;ss1234; echo done",
      secrets: ["pa;ss1234", "ss1234"],
      keep: ["echo done"],
    },
    {
      id: "ps-dq-spaces",
      kind: "secret",
      text: '$env:IMA_OPENAPI_APIKEY = "FAKEkey0060"; node wrap.mjs',
      secrets: ["FAKEkey0060"],
      keep: ["node wrap.mjs"],
    },
    {
      id: "ps-unquoted",
      kind: "secret",
      text: "$env:IMA_OPENAPI_APIKEY = FAKEkey0061; node wrap.mjs",
      secrets: ["FAKEkey0061"],
      keep: ["node wrap.mjs"],
    },
    {
      id: "mixed-case-key",
      kind: "secret",
      text: "Ima_OpenApi_ApiKey=FAKEkey0063 OpenAI_Key=FAKEkey0064 x",
      secrets: ["FAKEkey0063", "FAKEkey0064"],
    },
    {
      id: "header-mixed",
      kind: "secret",
      text: 'curl -H "x-api-key: FAKEkey0066" -H "X-CLIENT-ID: FAKEcid0067" https://e.x/',
      secrets: ["FAKEkey0066", "FAKEcid0067"],
    },
    {
      id: "yaml-quoted",
      kind: "secret",
      text: "printf 'client_secret: \"FAKEsec0068\"\\n' > a.yml",
      secrets: ["FAKEsec0068"],
    },
    {
      id: "json-single-quote",
      kind: "secret",
      text: 'echo \'{"client_id":"FAKEcid0065"}\' ',
      secrets: ["FAKEcid0065"],
    },
    // QA514 r3
    {
      id: "setitem-backslash-doc",
      kind: "secret",
      text: "Set-Item -Path Env:\\IMA_OPENAPI_APIKEY -Value 'FAKEr3k16'",
      secrets: ["FAKEr3k16"],
      keep: ["Env:\\IMA_OPENAPI_APIKEY"],
    },
    {
      id: "newitem-backslash-doc",
      kind: "secret",
      text: "New-Item -Path Env:\\IMA_OPENAPI_APIKEY -Value 'FAKEr3k20'",
      secrets: ["FAKEr3k20"],
      keep: ["New-Item"],
    },
    {
      id: "setitem-backslash-positional",
      kind: "secret",
      text: "Set-Item Env:\\IMA_OPENAPI_APIKEY FAKEr3k17",
      secrets: ["FAKEr3k17"],
    },
    {
      id: "setitem-value-first",
      kind: "secret",
      text: "Set-Item -Value 'FAKEr3k18' -Path Env:IMA_OPENAPI_APIKEY",
      secrets: ["FAKEr3k18"],
      keep: ["-Path Env:IMA_OPENAPI_APIKEY"],
    },
    {
      id: "setitem-literalpath",
      kind: "secret",
      text: "Set-Item -LiteralPath Env:\\DB_PASSWORD -Value FAKEr3k19",
      secrets: ["FAKEr3k19"],
    },
    {
      id: "setitem-lowercase",
      kind: "secret",
      text: "set-item -path env:\\api_key -value 'FAKEr3k19b'",
      secrets: ["FAKEr3k19b"],
    },
    {
      id: "setitem-value-colon",
      kind: "secret",
      text: "Set-Item -Path Env:API_KEY -Value:'FAKEr3k19c' -Force",
      secrets: ["FAKEr3k19c"],
      keep: ["-Force"],
    },
    {
      id: "setcontent-env",
      kind: "secret",
      text: "Set-Content env:IMA_OPENAPI_APIKEY 'FAKEr3k21'",
      secrets: ["FAKEr3k21"],
    },
    {
      id: "si-alias",
      kind: "secret",
      text: "si env:IMA_OPENAPI_APIKEY 'FAKEr3k22'; node wrap.mjs",
      secrets: ["FAKEr3k22"],
      keep: ["node wrap.mjs"],
    },
    {
      id: "newitem-name-param",
      kind: "secret",
      text: "New-Item -Path Env:\\ -Name IMA_OPENAPI_APIKEY -Value 'FAKEr3k22b'",
      secrets: ["FAKEr3k22b"],
      keep: ["-Name IMA_OPENAPI_APIKEY"],
    },
    {
      id: "setitem-quoted-semicolon",
      kind: "secret",
      text: "Set-Item -Path Env:\\DB_PASSWORD -Value 'pa;ssFAKEr3k22c'; echo ok",
      secrets: ["ssFAKEr3k22c"],
      keep: ["echo ok"],
    },
    {
      id: "key-mid-qualifier",
      kind: "secret",
      text: "OPENAI_KEY_PROD=FAKEr3n33 DEEPSEEK_KEY_2=FAKEr3n34 STRIPE_KEY_LIVE=FAKEr3n36 node x",
      secrets: ["FAKEr3n33", "FAKEr3n34", "FAKEr3n36"],
      keep: ["node x"],
    },
    {
      id: "ssh-key-passphrase",
      kind: "secret",
      text: "SSH_KEY_PASSPHRASE=FAKEr3n35 GPG_PASSPHRASE=FAKEr3n35b ssh-add k",
      secrets: ["FAKEr3n35", "FAKEr3n35b"],
      keep: ["ssh-add k"],
    },
    {
      id: "json-key-mid-qualifier",
      kind: "secret",
      text: '{"OPENAI_KEY_PROD":"FAKEr3n37","CACHE_KEY_PREFIX":"app"}',
      secrets: ["FAKEr3n37"],
      keep: ['"CACHE_KEY_PREFIX":"app"'],
    },
    {
      id: "flag-passphrase",
      kind: "secret",
      text: "tool --passphrase FAKEr3n37b",
      secrets: ["FAKEr3n37b"],
    },
    {
      id: "setx-M-before",
      kind: "secret",
      text: "setx /M IMA_OPENAPI_APIKEY FAKEr3k11",
      secrets: ["FAKEr3k11"],
      keep: ["setx /M IMA_OPENAPI_APIKEY"],
    },
    {
      id: "setx-dash-m-before",
      kind: "secret",
      text: 'setx -m DB_PASSWORD "pa ss FAKEr3k12"',
      secrets: ["FAKEr3k12"],
    },
    {
      id: "setx-remote-password",
      kind: "secret",
      text: "setx /S host1 /U admin /P FAKEr3k12b API_KEY FAKEr3k12c",
      secrets: ["FAKEr3k12b", "FAKEr3k12c"],
      keep: ["/S host1 /U admin"],
    },
    {
      id: "amp-eq-in-value",
      kind: "secret",
      text: "DB_PASSWORD=pa&ss=FAKEr3a24 node x",
      secrets: ["ss=FAKEr3a24", "FAKEr3a24"],
      keep: ["node x"],
    },
    {
      id: "amp-eq-after-plain",
      kind: "secret",
      text: "X=1&API_KEY=FAKEr3a24b&page=2",
      secrets: ["FAKEr3a24b"],
      keep: ["X=1&API_KEY=", "&page=2"],
    },
    {
      id: "sev-escaped-sq",
      kind: "secret",
      text: `[Environment]::SetEnvironmentVariable("DB_PASSWORD",'pa''ssFAKE06',"User")`,
      secrets: ["ssFAKE06"],
      keep: ['"User"'],
    },
    {
      id: "sev-escaped-dq",
      kind: "secret",
      text: '[Environment]::SetEnvironmentVariable("DB_PASSWORD","pa`"ssFAKE07","User")',
      secrets: ["ssFAKE07"],
      keep: ['"User"'],
    },
    {
      id: "ps-env-escaped-sq",
      kind: "secret",
      text: "$env:DB_PASSWORD = 'pa''ssFAKE08'; node x",
      secrets: ["ssFAKE08"],
      keep: ["node x"],
    },
    {
      id: "ima-nonsecret",
      kind: "keep",
      text: "IMA_OPENAPI_REGION=gz IMA_OPENAPI_ENDPOINT=ima-api node wrap.mjs",
    },
    {
      id: "key-metadata-suffix",
      kind: "keep",
      text: "CACHE_KEY_PREFIX=app MY_KEY_ID=abc REDIS_KEY_TTL=60 SSH_KEY_PATH=/k node x",
    },
    {
      id: "setitem-path-env",
      kind: "keep",
      text: "Set-Item -Path Env:\\PATH -Value 'C:\\bin'",
    },
    {
      id: "setitem-variable",
      kind: "keep",
      text: "Set-Item -Path Env:\\API_KEY -Value $key",
    },
    {
      id: "setx-path",
      kind: "keep",
      text: 'setx /M PATH "C:\\bin;%PATH%"',
    },
    {
      id: "sev-null",
      kind: "keep",
      text: '[Environment]::SetEnvironmentVariable("API_KEY",$null,"User")',
    },
    {
      id: "url-query-plain",
      kind: "keep",
      text: "page=2&lang=zh&sort=asc",
    },
    // QA514 r4
    {
      id: "dq-double-sev",
      kind: "secret",
      text: '[Environment]::SetEnvironmentVariable("DB_PASSWORD","pa""ssFAKEr4e04","User")',
      secrets: ["ssFAKEr4e04"],
      keep: ['"User"'],
    },
    {
      id: "dq-double-env",
      kind: "secret",
      text: '$env:DB_PASSWORD = "pa""ssFAKEr4e05"; node x',
      secrets: ["ssFAKEr4e05"],
      keep: ["node x"],
    },
    {
      id: "dq-double-shell",
      kind: "secret",
      text: 'DB_PASSWORD="pa""ssFAKEr4e06" node x',
      secrets: ["ssFAKEr4e06"],
      keep: ["node x"],
    },
    {
      id: "pipe-setcontent",
      kind: "secret",
      text: "'FAKEr4b01' | Set-Content Env:API_KEY",
      secrets: ["FAKEr4b01"],
      keep: ["| Set-Content Env:API_KEY"],
    },
    {
      id: "pipe-setitem-dq",
      kind: "secret",
      text: 'echo ok; "FAKEr4b01b" | Set-Item -Path Env:\\X_TOKEN',
      secrets: ["FAKEr4b01b"],
      keep: ["echo ok"],
    },
    {
      id: "addcontent",
      kind: "secret",
      text: "Add-Content Env:API_KEY 'FAKEr4b02'",
      secrets: ["FAKEr4b02"],
      keep: ["Add-Content Env:API_KEY"],
    },
    {
      id: "ac-alias",
      kind: "secret",
      text: "ac env:DB_PASSWORD FAKEr4b02b",
      secrets: ["FAKEr4b02b"],
    },
    {
      id: "value-paren",
      kind: "secret",
      text: 'Set-Item -Path Env:API_KEY -Value ("FAKEr4b03")',
      secrets: ["FAKEr4b03"],
      keep: ["-Value"],
    },
    {
      id: "value-paren-concat",
      kind: "secret",
      text: 'Set-Item -Path Env:API_KEY -Value ("a" + "FAKEr4b03b")',
      secrets: ["FAKEr4b03b"],
    },
    {
      id: "setx-exe",
      kind: "secret",
      text: "setx.exe API_KEY FAKEr4c09",
      secrets: ["FAKEr4c09"],
      keep: ["setx.exe API_KEY"],
    },
    {
      id: "setx-exe-path",
      kind: "secret",
      text: "C:\\Windows\\System32\\setx.exe /M API_KEY FAKEr4c10",
      secrets: ["FAKEr4c10"],
    },
    {
      id: "key-file-content",
      kind: "secret",
      text: "KEY_FILE_CONTENT=FAKEr4f13 SSH_KEY_PATH_DATA=FAKEr4f13b node x",
      secrets: ["FAKEr4f13", "FAKEr4f13b"],
      keep: ["node x"],
    },
    {
      id: "api-keys-plural",
      kind: "secret",
      text: "API_KEYS=FAKEr4f11,FAKEr4f12 OPENAI_KEYS=FAKEr4f12b node x",
      secrets: ["FAKEr4f11", "FAKEr4f12", "FAKEr4f12b"],
      keep: ["node x"],
    },
    {
      id: "env-braced",
      kind: "secret",
      text: "\u0024{env:API_KEY} = 'FAKEr4g01'; node x",
      secrets: ["FAKEr4g01"],
      keep: ["\u0024{env:API_KEY}", "node x"],
    },
    {
      id: "set-variable",
      kind: "secret",
      text: "Set-Variable -Name API_KEY -Value 'FAKEr4g02'",
      secrets: ["FAKEr4g02"],
      keep: ["-Name API_KEY"],
    },
    {
      id: "set-variable-positional",
      kind: "secret",
      text: 'sv DB_PASSWORD "FAKEr4g03"',
      secrets: ["FAKEr4g03"],
    },
    {
      id: "pipe-from-file",
      kind: "keep",
      text: "Get-Content k.txt | Set-Content Env:API_KEY",
    },
    {
      id: "pipe-variable",
      kind: "keep",
      text: "$v | Set-Content Env:API_KEY",
    },
    {
      id: "value-paren-variable",
      kind: "keep",
      text: "Set-Item -Path Env:API_KEY -Value ($key)",
    },
    {
      id: "set-variable-nonsensitive",
      kind: "keep",
      text: "Set-Variable -Name Path -Value x",
    },
    {
      id: "names-not-keys",
      kind: "keep",
      text: "MONKEY=m KEYBOARD=us KMS_KEY_ID=k MY_KEY_ID=abc TURKEY=t node x",
    },
    // 权衡：| 两侧无空格时，下一命令名会被吞进值一并打码（偏安全）。有空格的 "| grep" 仍保留。
    {
      id: "nospace-pipe-cmd",
      kind: "secret",
      text: "API_KEY=secret|grep leak",
      secrets: ["secret"],
      keep: ["leak"],
    },
    {
      id: "var-named-keyish",
      kind: "keep",
      text: "MY_KEYBOARD_LAYOUT=us CACHE_KEY_PREFIX=app node s.js",
    },
    {
      id: "path-with-key",
      kind: "keep",
      text: "cat /home/qa/api_key_backup/notes.txt ./token-list.md",
    },
    {
      id: "json-config-nonsensitive",
      kind: "keep",
      text: 'echo \'{"timeout":30,"client_name":"qa","port":8080}\' > cfg.json',
    },
    {
      id: "pipe-normal",
      kind: "keep",
      text: "cat a.txt | grep client_id | wc -l",
    },
    { id: "false-client-idle", kind: "keep", text: "CLIENT_IDLE_TIMEOUT=30" },
    {
      id: "false-client-ident",
      kind: "keep",
      text: "CLIENT_IDENTIFIER_HEADER=x-req",
    },
    { id: "false-max-tokens", kind: "keep", text: "MAX_TOKENS=4096" },
    { id: "false-tokenizer", kind: "keep", text: "TOKENIZER=bert" },
  ];

  for (const sample of qa514) {
    if (sample.kind === "keep") {
      test(`keeps ${sample.id}: ${sample.text.slice(0, 60)}`, () => {
        expect(redactText(sample.text)).toBe(sample.text);
      });
      continue;
    }
    test(`masks ${sample.id}: ${sample.text.slice(0, 60)}`, () => {
      const out = redactText(sample.text);
      for (const secret of sample.secrets ?? []) {
        expect(out).not.toContain(secret);
      }
      for (const keep of sample.keep ?? []) {
        expect(out).toContain(keep);
      }
      expect(redactText(out)).toBe(out);
    });
  }

  test("redacts before clip so sk- prefixes are not half-leaked", () => {
    const sk = `sk-${"A".repeat(40)}`;
    const masked = redactText(sk);
    expect(masked).toBe("••••");
    expect(clip(masked, 20).text).toBe("••••");
    // 错误顺序：先截到不足 sk- 规则所需长度，前缀会漏出
    const clippedFirst = sk.slice(0, 10);
    expect(clippedFirst.startsWith("sk-")).toBe(true);
    expect(clippedFirst).toContain("sk-");
    expect(redactText(clippedFirst)).toBe(clippedFirst);
  });
});

describe("QA514 r3 sensitive config names", () => {
  test.each([
    "OPENAI_KEY_PROD",
    "DEEPSEEK_KEY_2",
    "STRIPE_KEY_LIVE",
    "SSH_KEY_PASSPHRASE",
    "GPG_PASSPHRASE",
    "OPENAI_KEY",
    "API_KEY",
    "KEY",
    "IMA_OPENAPI_CLIENTID",
    "IMA_OPENAPI_SIGN",
  ])("masks %s", (name) => {
    expect(isSensitiveConfigName(name)).toBe(true);
  });
  test.each([
    "CACHE_KEY_PREFIX",
    "MY_KEY_ID",
    "REDIS_KEY_TTL",
    "SSH_KEY_PATH",
    "KEYBOARD",
    "MY_KEYBOARD_LAYOUT",
    "IMA_OPENAPI_BASE_URL",
    "IMA_OPENAPI_REGION",
  ])("keeps %s", (name) => {
    expect(isSensitiveConfigName(name)).toBe(false);
  });

  test("env: provider keeps the command shape and masks only the value", () => {
    expect(
      redactText("Set-Item -Path Env:\\IMA_OPENAPI_APIKEY -Value 'FAKEdoc1'"),
    ).toBe("Set-Item -Path Env:\\IMA_OPENAPI_APIKEY -Value ••••");
    expect(redactText("setx /M IMA_OPENAPI_APIKEY FAKEsetx1")).toBe(
      "setx /M IMA_OPENAPI_APIKEY ••••",
    );
    expect(redactText("DB_PASSWORD=pa&ss=FAKEamp1 node x")).toBe(
      "DB_PASSWORD=•••• node x",
    );
    expect(
      redactText(
        "[Environment]::SetEnvironmentVariable(\"DB_PASSWORD\",'pa''ssFAKE','User')",
      ),
    ).toBe(
      "[Environment]::SetEnvironmentVariable(\"DB_PASSWORD\",'••••','User')",
    );
    expect(
      redactText(
        "IMA_OPENAPI_BASE_URL=https://ima.qq.com/ IMA_OPENAPI_REGION=gz",
      ),
    ).toBe("IMA_OPENAPI_BASE_URL=https://ima.qq.com/ IMA_OPENAPI_REGION=gz");
  });
});

describe("QA514 r3 pathological input stays fast", () => {
  test("long unterminated quotes and repeated commands finish quickly", () => {
    const inputs = [
      `$env:API_KEY="${"\\".repeat(5000)}`,
      `[Environment]::SetEnvironmentVariable("API_KEY","${"\\".repeat(5000)}`,
      `$env:API_KEY='${"''".repeat(3000)}`,
      "a=".repeat(5000),
      "si ".repeat(5000),
      "setx API_KEY ".repeat(3000),
      "Set-Item env:API_KEY ".repeat(3000),
    ];
    const started = performance.now();
    for (const input of inputs) redactText(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("QA514 r4 linear time on 100KB input", () => {
  const size = 100_000;
  const inputs: Record<string, string> = {
    'escaped quotes \\"': `echo "${'\\"'.repeat(size / 2)}`,
    "escaped quotes after a name": `API_KEY="${'\\"'.repeat(size / 2)}`,
    "bare escaped quotes": '\\"'.repeat(size / 2),
    "doubled quotes": `DB_PASSWORD="${'""'.repeat(size / 2)}`,
    "non-sensitive assignments": "a=".repeat(size / 2),
    "yaml-like colons": "a:".repeat(size / 2),
    "repeated Set-Item": "Set-Item Env:API_KEY ".repeat(size / 21),
    "repeated pipes": '"x" | '.repeat(size / 6),
    "repeated setx.exe": "setx.exe ".repeat(size / 9),
    "long sensitive value": `API_KEY=${"x".repeat(size)}`,
  };
  for (const [name, input] of Object.entries(inputs)) {
    test(`${name} stays under 1s`, () => {
      const started = performance.now();
      const out = redactText(input);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(typeof out).toBe("string");
    });
  }
  test("a long value is still masked, not skipped", () => {
    const out = redactText(`API_KEY=${"FAKElong".repeat(size / 8)} node x`);
    expect(out).toBe("API_KEY=•••• node x");
  });
});
