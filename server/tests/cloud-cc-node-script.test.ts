import { describe, expect, test } from "bun:test";
import { createNodeScriptHash, normalizeScript, scriptIsStale, sha256Hex } from "../src/cloud-cc/node-script";

/**
 * 「节点程序」指纹（DESIGN.md §73.1）：云端节点只在容器启动时下载 chisabot-node.cjs，应用发版改了
 * pc/src/cloud-cc 之后还在跑的进程一直是旧代码。服务器把现在发出去的程序指纹随 cc_probe 发给节点，
 * 节点在 cc_info 里报自己在跑的那份，两边不一样就是旧程序。
 */
describe("节点程序指纹", () => {
  test("sha256 就是文件内容的 sha256", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("缓存：同一个版本只读一次，过了 TTL 才认新版本", async () => {
    let reads = 0;
    let body: Buffer | null = Buffer.from("v1");
    const current = createNodeScriptHash(async () => {
      reads++;
      return body;
    }, 30);
    expect(await current()).toBe(sha256Hex(Buffer.from("v1")));
    expect(await current()).toBe(sha256Hex(Buffer.from("v1")));
    expect(reads).toBe(1);
    body = Buffer.from("v2");
    await Bun.sleep(40);
    expect(await current()).toBe(sha256Hex(Buffer.from("v2")));
    expect(reads).toBe(2);
  });

  test("读不到节点程序（这个部署没打包）就不判断", async () => {
    const current = createNodeScriptHash(async () => null, 0);
    expect(await current()).toBe(null);
    expect(scriptIsStale(null, null)).toBe(false);
    expect(scriptIsStale(undefined, null)).toBe(false);
  });

  test("报上来的指纹：只认 sha256，大小写不敏感", () => {
    const hash = "a".repeat(64);
    expect(normalizeScript(hash.toUpperCase())).toBe(hash);
    expect(normalizeScript(` ${hash} `)).toBe(hash);
    expect(normalizeScript("nope")).toBe(null);
    expect(normalizeScript(undefined)).toBe(null);
    expect(normalizeScript(42)).toBe(null);
  });

  test("旧程序 / 新程序 / 说不好", () => {
    const now = "a".repeat(64);
    expect(scriptIsStale("a".repeat(64), now)).toBe(false);
    expect(scriptIsStale("b".repeat(64), now)).toBe(true);
    // 报不出来 = 比这个功能还旧的节点（只能人工重启容器）
    expect(scriptIsStale(null, now)).toBe(true);
    // 刚连上还没报 = 说不好，先别吓人
    expect(scriptIsStale(undefined, now)).toBe(false);
  });
});
