import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAutoMagpieService,
  MANAGED_MAGPIE_ADMIN_URL,
} from "../src/magpie";

/**
 * 一键安装（deploy/updater/magpie.sh do_install）之后，服务器不重启就接上 Magpie。
 * 宿主机写 state/magpie.json（managed + installed）和 state/magpie-web.key；这里验证：
 * 部署自己配了 MAGPIE_ADMIN_URL 时完全不看这些文件，没配时文件一出现就接上、坏文件不接。
 */

const KEY = "managed-web-key-0123456789abcdef";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function updaterDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "magpie-auto-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "state"));
  mkdirSync(path.join(dir, "requests"));
  return dir;
}

function writeState(dir: string, state: unknown, key?: string) {
  writeFileSync(path.join(dir, "state", "magpie.json"), JSON.stringify(state));
  if (key !== undefined) {
    const file = path.join(dir, "state", "magpie-web.key");
    rmSync(file, { force: true }); // 宿主机也是写临时文件再换名，不在 0400 的文件上原地改
    writeFileSync(file, `${key}\n`);
    chmodSync(file, 0o400);
  }
}

function fakeMagpie(seen: string[]) {
  return (async (url: URL, init: RequestInit) => {
    seen.push(`${url} ${new Headers(init.headers).get("cookie")}`);
    if (String(url).endsWith("/api/settings"))
      return new Response(
        JSON.stringify({ version: "v0.1.2000", gatewayOn: true }),
      );
    return new Response(JSON.stringify({ providers: [] }));
  }) as unknown as typeof fetch;
}

test("没装、也没配：未配置，代理 503", async () => {
  const dir = updaterDir();
  const magpie = createAutoMagpieService({ environment: {}, updaterDir: dir });
  expect(magpie.configured).toBe(false);
  expect(magpie.managementAvailable).toBe(false);
  expect(
    (await magpie.proxy(new Request("http://chisa/magpie-admin/"), "/")).status,
  ).toBe(503);
});

test("宿主机装好、交了密钥：不重启就接上，用固定的内部地址", async () => {
  const dir = updaterDir();
  let clock = 0;
  const seen: string[] = [];
  const magpie = createAutoMagpieService({
    environment: {},
    updaterDir: dir,
    fetch: fakeMagpie(seen),
    now: () => clock,
  });
  expect(magpie.managementAvailable).toBe(false);

  // 安装进行中：magpie.json 还说没装，密钥文件已经在了 → 仍不接（等健康检查过了才算）。
  writeState(dir, { installed: false, managed: true }, KEY);
  clock += 5_000;
  expect(magpie.managementAvailable).toBe(false);

  let changed = 0;
  magpie.onChange(() => {
    changed += 1;
  });
  writeState(dir, { installed: true, managed: true, installable: true }, KEY);
  clock += 5_000;
  expect(magpie.configured).toBe(true);
  expect(magpie.managementAvailable).toBe(true);
  expect(changed).toBe(1); // 模型目录据此重新同步提供方名称

  const status = await magpie.status({ refresh: true });
  expect(status.reachable).toBe(true);
  expect(status.version).toBe("v0.1.2000");
  expect(
    seen.every((line) => line.startsWith(`${MANAGED_MAGPIE_ADMIN_URL}/`)),
  ).toBe(true);
  expect(seen[0]).toContain(`magpie_web_3430=${KEY}`);
});

test("几秒内只读一次文件；密钥轮换后换成新的", async () => {
  const dir = updaterDir();
  let clock = 0;
  const seen: string[] = [];
  writeState(dir, { installed: true, managed: true }, KEY);
  const magpie = createAutoMagpieService({
    environment: {},
    updaterDir: dir,
    fetch: fakeMagpie(seen),
    now: () => clock,
  });
  expect(magpie.managementAvailable).toBe(true);
  const rotated = "rotated-web-key-0123456789abcdef";
  writeState(dir, { installed: true, managed: true }, rotated);
  clock += 1_000; // 还在节流窗口内：仍是旧的
  await magpie.status({ refresh: true });
  expect(seen.at(-1)).toContain(KEY);
  clock += 5_000;
  await magpie.status({ refresh: true });
  expect(seen.at(-1)).toContain(rotated);
});

test("不是 ChisaBot 装的、密钥不合规、文件是坏的：一律不接", () => {
  for (const [state, key] of [
    [{ installed: true }, KEY], // 别人自己装的 Magpie：没有 managed
    [{ installed: true, managed: true }, "short"], // 密钥太短
    [{ installed: true, managed: true }, "has spaces in the key 0123456789"],
    [{ installed: true, managed: "true" }, KEY],
    ["not json", KEY],
  ] as const) {
    const dir = updaterDir();
    if (typeof state === "string") {
      writeFileSync(path.join(dir, "state", "magpie.json"), state);
      writeFileSync(path.join(dir, "state", "magpie-web.key"), key);
    } else writeState(dir, state, key);
    expect(
      createAutoMagpieService({ environment: {}, updaterDir: dir })
        .managementAvailable,
    ).toBe(false);
  }
  // 有标记但还没有密钥文件
  const dir = updaterDir();
  writeState(dir, { installed: true, managed: true });
  expect(
    createAutoMagpieService({ environment: {}, updaterDir: dir })
      .managementAvailable,
  ).toBe(false);
});

test("部署自己配了 MAGPIE_ADMIN_URL：完全按配置，宿主机的文件不起作用", async () => {
  const dir = updaterDir();
  writeState(dir, { installed: true, managed: true }, KEY);
  const seen: string[] = [];
  const own = "own-configured-key-0123456789abc";
  const magpie = createAutoMagpieService({
    environment: {
      MAGPIE_ADMIN_URL: "http://gateway.internal:4430",
      MAGPIE_WEB_KEY: own,
    },
    updaterDir: dir,
    fetch: fakeMagpie(seen),
  });
  expect(magpie.managementAvailable).toBe(true);
  await magpie.status();
  expect(seen[0]).toStartWith("http://gateway.internal:4430/");
  expect(seen[0]).toContain(own);

  // 配了地址却没配密钥：照旧只显示连接信息，不拿宿主机交的密钥去凑。
  const partial = createAutoMagpieService({
    environment: { MAGPIE_ADMIN_URL: "http://magpie:3430" },
    updaterDir: dir,
  });
  expect(partial.configured).toBe(true);
  expect(partial.managementAvailable).toBe(false);
});

test("没有更新程序目录：只是未配置，不抛错", () => {
  expect(createAutoMagpieService({ environment: {} }).configured).toBe(false);
  expect(
    createAutoMagpieService({
      environment: { MAGPIE_ADMIN_URL: " " },
      updaterDir: "/nonexistent",
    }).configured,
  ).toBe(false);
});
