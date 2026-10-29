"use strict";
// PC 更新验签（docs/pc-update-signing.md）：签名 / 验签 / 篡改 / 换钥 / 无公钥，以及 sign-update.js / gen-update-key.js。
// 所有密钥都是测试里现生成的临时钥，只在内存和系统临时目录里，用完删掉。
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const sig = require("../src/update-signature");
const signer = require("../scripts/sign-update");
const genKey = require("../scripts/gen-update-key");

const PC = path.join(__dirname, "..");

function tempKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pub = sig.rawPublicKey(publicKey).toString("base64");
  return { privateKey, pem: privateKey.export({ format: "pem", type: "pkcs8" }), pub, keyId: sig.keyIdOf(pub) };
}

function table(...keys) {
  return { keys: keys.map((k, i) => ({ keyId: k.keyId, publicKey: k.pub, label: `test ${i}` })) };
}

const PRIMARY = tempKey();
const BACKUP = tempKey();
const STRANGER = tempKey();
const KEYS = sig.parseKeys(table(PRIMARY, BACKUP));

function tmpdir(prefix = "chisabot-update-sig-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 造一个安装包和对应的 latest.yml（和 electron-builder + shell-fingerprint --stamp 产出的格式一样）。 */
function release(dir, { version = "0.1.200", content = crypto.randomBytes(4096), shell = "0123456789abcdef", full = false } = {}) {
  const name = `ChisaBot-PC-${version}-x64-setup.exe`;
  fs.writeFileSync(path.join(dir, name), content);
  const sha512 = crypto.createHash("sha512").update(content).digest("base64");
  let text = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${content.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-10-29T00:00:00.000Z'\nchisabotShell: ${shell}\n`;
  if (full) text += "fullInstall: true\n";
  const yml = path.join(dir, "latest.yml");
  fs.writeFileSync(yml, text);
  return { yml, installer: path.join(dir, name), info: yaml.load(text), text };
}

function signed(info, key = PRIMARY) {
  return { ...info, chisabotSig: sig.signManifest(info, key.pem) };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof sig.UpdateSignatureError, String(error));
    assert.strictEqual(error.code, code);
    return true;
  });
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof sig.UpdateSignatureError && error.code === code);
}

// ---------- 规范化消息 ----------

test("canonical message: fixed order, one field per line, normalized values", () => {
  const info = { version: "0.1.200", path: "a.exe", sha512: "abc==", files: [{ url: "a.exe", sha512: "abc==", size: 12 }], chisabotShell: " ffff ", fullInstall: "true" };
  assert.strictEqual(sig.canonicalMessage(info), "chisabot-pc-update/v1\nversion=0.1.200\npath=a.exe\nsha512=abc==\nsize=12\nchisabotShell=ffff\nfullInstall=true\n");
  assert.match(sig.canonicalMessage({ version: "1", path: "b.exe", sha512: "x" }), /\nsize=\nchisabotShell=\nfullInstall=false\n$/);
  throwsCode(() => sig.canonicalMessage({ version: "1\nfullInstall=true", path: "a", sha512: "x" }), "ERR_MANIFEST");
  throwsCode(() => sig.canonicalMessage({ version: "1", path: "", sha512: "x" }), "ERR_MANIFEST");
  throwsCode(() => sig.canonicalMessage({ ...info, files: [{ url: "a.exe", sha512: "other==" }] }), "ERR_MANIFEST");
});

// ---------- 签名 / 验签 / 篡改 ----------

test("sign + verify a release, including the downloaded installer's sha512 and size", async () => {
  const dir = tmpdir();
  try {
    const r = release(dir);
    const info = signed(r.info);
    assert.match(info.chisabotSig, new RegExp(`^${PRIMARY.keyId}:[A-Za-z0-9+/]{86}==$`));
    const result = await sig.verifyDownloadedUpdate({ info, file: r.installer, keys: KEYS });
    assert.strictEqual(result.keyId, PRIMARY.keyId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tampering any signed field breaks the signature", () => {
  const dir = tmpdir();
  try {
    const r = release(dir, { full: false });
    const info = signed(r.info);
    sig.verifyManifest(info, KEYS);
    for (const [name, tamper] of Object.entries(signer.TAMPERS)) throwsCode(() => sig.verifyManifest(tamper(info), KEYS), "ERR_SIGNATURE_MISMATCH", name);
    // 去掉 chisabotShell（假装是旧更新源）同样不行。
    const { chisabotShell, ...noShell } = info;
    assert.ok(chisabotShell);
    throwsCode(() => sig.verifyManifest(noShell, KEYS), "ERR_SIGNATURE_MISMATCH");
    // 不在签名里的字段（releaseDate）随便改：不影响安装内容。
    sig.verifyManifest({ ...info, releaseDate: "2030-01-01T00:00:00.000Z" }, KEYS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a downloaded file that differs from the signed sha512 / size is rejected", async () => {
  const dir = tmpdir();
  try {
    const r = release(dir);
    const info = signed(r.info);
    const bytes = fs.readFileSync(r.installer);
    bytes[100] ^= 1;
    fs.writeFileSync(r.installer, bytes);
    await rejects(sig.verifyDownloadedUpdate({ info, file: r.installer, keys: KEYS }), "ERR_HASH_MISMATCH");
    fs.appendFileSync(r.installer, "x");
    await rejects(sig.verifyDownloadedUpdate({ info, file: r.installer, keys: KEYS }), "ERR_SIZE_MISMATCH");
    await rejects(sig.verifyDownloadedUpdate({ info, file: path.join(dir, "missing.exe"), keys: KEYS }), "ERR_NO_FILE");
    await rejects(sig.verifyDownloadedUpdate({ info, file: undefined, keys: KEYS }), "ERR_NO_FILE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("attacker re-hashes a malicious installer: sha512 changes, signature no longer matches", () => {
  const dir = tmpdir();
  try {
    const r = release(dir);
    const info = signed(r.info);
    const evil = crypto.createHash("sha512").update("evil").digest("base64");
    const forged = { ...info, sha512: evil, files: [{ ...info.files[0], sha512: evil }] };
    throwsCode(() => sig.verifyManifest(forged, KEYS), "ERR_SIGNATURE_MISMATCH");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing / malformed signature, unknown key, wrong key are all rejected", () => {
  const info = { version: "0.1.200", path: "a.exe", sha512: "abc==" };
  throwsCode(() => sig.verifyManifest(info, KEYS), "ERR_NO_SIGNATURE");
  throwsCode(() => sig.verifyManifest({ ...info, chisabotSig: "" }, KEYS), "ERR_NO_SIGNATURE");
  throwsCode(() => sig.verifyManifest({ ...info, chisabotSig: "nonsense" }, KEYS), "ERR_SIGNATURE_FORMAT");
  throwsCode(() => sig.verifyManifest({ ...info, chisabotSig: `${PRIMARY.keyId}:AAAA` }, KEYS), "ERR_SIGNATURE_FORMAT");
  // 用不在公钥表里的钥签：keyId 不认识。
  throwsCode(() => sig.verifyManifest(signed(info, STRANGER), KEYS), "ERR_UNKNOWN_KEY");
  // 冒用主钥的 keyId，签名其实是别的钥签的。
  const fake = signed(info, STRANGER).chisabotSig.replace(/^[0-9a-f]{8}/, PRIMARY.keyId);
  throwsCode(() => sig.verifyManifest({ ...info, chisabotSig: fake }, KEYS), "ERR_SIGNATURE_MISMATCH");
  // 没有公钥：一律拒绝。
  throwsCode(() => sig.verifyManifest(signed(info), new Map()), "ERR_NO_KEYS");
});

test("key rotation: client with primary + backup accepts both; old client without the new key rejects it", () => {
  const info = { version: "0.1.200", path: "a.exe", sha512: "abc==" };
  assert.strictEqual(sig.verifyManifest(signed(info, PRIMARY), KEYS).keyId, PRIMARY.keyId);
  assert.strictEqual(sig.verifyManifest(signed(info, BACKUP), KEYS).keyId, BACKUP.keyId);
  const NEXT = tempKey();
  const rotated = sig.parseKeys(table(BACKUP, NEXT)); // 主钥泄露：备用钥上位、加一把新备用、去掉旧主钥
  assert.strictEqual(sig.verifyManifest(signed(info, NEXT), rotated).keyId, NEXT.keyId);
  throwsCode(() => sig.verifyManifest(signed(info, PRIMARY), rotated), "ERR_UNKNOWN_KEY");
  throwsCode(() => sig.verifyManifest(signed(info, NEXT), KEYS), "ERR_UNKNOWN_KEY");
});

// ---------- 公钥表 ----------

test("loadKeys: empty table = signing off; valid table = enforce; broken table = enforce with no keys", () => {
  const dir = tmpdir();
  try {
    const file = path.join(dir, "keys.json");
    fs.writeFileSync(file, '{"keys": []}');
    assert.deepStrictEqual({ ...sig.loadKeys(file), keys: sig.loadKeys(file).keys.size }, { enforce: false, keys: 0, problem: "" });
    fs.writeFileSync(file, JSON.stringify(table(PRIMARY, BACKUP)));
    const ok = sig.loadKeys(file);
    assert.strictEqual(ok.enforce, true);
    assert.deepStrictEqual([...ok.keys.keys()], [PRIMARY.keyId, BACKUP.keyId]);
    for (const broken of ["not json", "{}", JSON.stringify({ keys: [{ publicKey: "short" }] }), JSON.stringify({ keys: [{ keyId: "00000000", publicKey: PRIMARY.pub }] })]) {
      fs.writeFileSync(file, broken);
      const r = sig.loadKeys(file);
      assert.strictEqual(r.enforce, true, broken);
      assert.strictEqual(r.keys.size, 0);
      assert.ok(r.problem);
    }
    const missing = sig.loadKeys(path.join(dir, "nope.json"));
    assert.strictEqual(missing.enforce, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed key table parses (empty until Jun adds the real public keys) and holds no private material", () => {
  const raw = fs.readFileSync(sig.KEYS_FILE, "utf8");
  assert.doesNotMatch(raw, /PRIVATE KEY/);
  const data = JSON.parse(raw);
  sig.parseKeys(data);
  const pkg = require("../package.json");
  assert.ok(pkg.build.files.includes("src/**/*"), "update-keys.json 要打进 asar");
});

// ---------- sign-update.js ----------

function run(argv, env = {}) {
  const out = [];
  const err = [];
  return signer.main(argv, { env, log: (l) => out.push(l), error: (l) => err.push(l) }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
}

test("sign-update.js: signs from env, verifies, passes the tamper check, never prints the key", async () => {
  const dir = tmpdir();
  try {
    const r = release(dir, { full: true });
    const keysFile = path.join(dir, "keys.json");
    fs.writeFileSync(keysFile, JSON.stringify(table(PRIMARY, BACKUP)));
    const signedRun = await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: PRIMARY.pem });
    assert.strictEqual(signedRun.code, 0, signedRun.err);
    const text = fs.readFileSync(r.yml, "utf8");
    assert.ok(text.startsWith(r.text.trimEnd()), "只在末尾加一行");
    assert.match(text, new RegExp(`\\nchisabotSig: '${PRIMARY.keyId}:[A-Za-z0-9+/]{86}=='\\n$`));
    assert.strictEqual(yaml.load(text).fullInstall, true);
    // 重签（换备用钥）只留一行签名。
    assert.strictEqual((await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: BACKUP.pem })).code, 0);
    assert.strictEqual((fs.readFileSync(r.yml, "utf8").match(/chisabotSig:/g) || []).length, 1);
    const verified = await run(["--verify", r.yml, "--keys", keysFile, "--tamper-check"]);
    assert.strictEqual(verified.code, 0, verified.err);
    assert.match(verified.out, /tamper check ok/);
    for (const line of [signedRun.out, signedRun.err, verified.out, verified.err]) {
      assert.doesNotMatch(line, /PRIVATE KEY/);
      assert.ok(!line.includes(PRIMARY.pem.split("\n")[1]));
    }
    // 安装包被换：--verify 失败。
    fs.appendFileSync(r.installer, "x");
    const bad = await run(["--verify", r.yml, "--keys", keysFile]);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.err, /ERR_SIZE_MISMATCH/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sign-update.js refuses: no key, a key not in the table, an empty table, a bad PEM", async () => {
  const dir = tmpdir();
  try {
    const r = release(dir);
    const keysFile = path.join(dir, "keys.json");
    fs.writeFileSync(keysFile, JSON.stringify(table(PRIMARY)));
    assert.match((await run([r.yml, "--keys", keysFile], {})).err, /ERR_NO_PRIVATE_KEY/);
    assert.match((await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: STRANGER.pem })).err, /ERR_UNKNOWN_KEY/);
    const bad = await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" });
    assert.match(bad.err, /ERR_PRIVATE_KEY/);
    assert.doesNotMatch(bad.err, /AAAA/);
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" });
    assert.match((await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: rsa })).err, /ERR_KEYS/);
    fs.writeFileSync(keysFile, '{"keys": []}');
    assert.match((await run([r.yml, "--keys", keysFile], { PC_UPDATE_SIGNING_KEY: PRIMARY.pem })).err, /ERR_NO_KEYS/);
    assert.strictEqual(fs.readFileSync(r.yml, "utf8"), r.text, "失败时不改 latest.yml");
    // --key-file：离线手签的路子。
    fs.writeFileSync(keysFile, JSON.stringify(table(PRIMARY)));
    const pemFile = path.join(dir, "offline.pem");
    fs.writeFileSync(pemFile, PRIMARY.pem);
    assert.strictEqual((await run([r.yml, "--keys", keysFile, "--key-file", pemFile], {})).code, 0);
    assert.strictEqual((await run(["--verify", r.yml, "--keys", keysFile])).code, 0);
    assert.strictEqual((await run([], {})).code, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stamping after signing drops the stale signature (signing must be last)", () => {
  const fp = require("../scripts/shell-fingerprint");
  const stamped = fp.stampYaml(`version: 1\nchisabotShell: aaaa\nchisabotSig: '${PRIMARY.keyId}:x'\n`, { hash: "bbbb" });
  assert.doesNotMatch(stamped, /chisabotSig/);
});

test("--require-keys and --keys-from-env (self-built: CHISABOT_UPDATE_PUBKEYS)", async () => {
  const dir = tmpdir();
  try {
    const keysFile = path.join(dir, "keys.json");
    fs.writeFileSync(keysFile, '{"keys": []}');
    assert.strictEqual((await run(["--require-keys", "--keys", keysFile])).code, 1);
    const wrote = await run(["--keys-from-env", "--keys", keysFile], { CHISABOT_UPDATE_PUBKEYS: `${PRIMARY.pub}, ${BACKUP.pub}` });
    assert.strictEqual(wrote.code, 0, wrote.err);
    assert.deepStrictEqual([...sig.loadKeys(keysFile).keys.keys()], [PRIMARY.keyId, BACKUP.keyId]);
    assert.strictEqual((await run(["--require-keys", "--keys", keysFile])).code, 0);
    assert.strictEqual((await run(["--keys-from-env", "--keys", keysFile], {})).code, 0);
    assert.strictEqual(sig.loadKeys(keysFile).enforce, false, "没给公钥 = 不验签");
    assert.strictEqual((await run(["--keys-from-env", "--keys", keysFile], { CHISABOT_UPDATE_PUBKEYS: "not-a-key" })).code, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("js-yaml round trip: what electron-updater parses is what was signed", () => {
  const info = { version: "0.1.200", path: "ChisaBot PC 0.1.200.exe", sha512: "abc+/==", files: [{ url: "ChisaBot PC 0.1.200.exe", sha512: "abc+/==", size: 7 }], chisabotShell: "0123456789abcdef" };
  const value = sig.signManifest(info, PRIMARY.pem);
  const text = signer.writeSignature(yaml.dump(info), value);
  const back = yaml.load(text);
  assert.strictEqual(back.chisabotSig, value);
  sig.verifyManifest(back, KEYS);
});

// ---------- gen-update-key.js ----------

test("gen-update-key.js writes the private key only to a file outside the repo and prints only public data", () => {
  const dir = tmpdir();
  try {
    const out = [];
    const file = path.join(dir, "k", "primary.pem");
    assert.strictEqual(genKey.main(["--out", file, "--label", "primary"], { log: (l) => out.push(l), error: (l) => out.push(l) }), 0);
    const pem = fs.readFileSync(file, "utf8");
    assert.match(pem, /BEGIN PRIVATE KEY/);
    assert.doesNotMatch(out.join("\n"), /PRIVATE KEY-----/);
    assert.ok(!out.join("\n").includes(pem.split("\n")[1]));
    const entry = JSON.parse(out[out.length - 1]);
    assert.strictEqual(entry.label, "primary");
    assert.strictEqual(sig.signManifest({ version: "1", path: "a", sha512: "x" }, pem).slice(0, 8), entry.keyId);
    sig.parseKeys({ keys: [entry] });
    if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const errors = [];
    assert.strictEqual(genKey.main(["--out", file], { log() {}, error: (l) => errors.push(l) }), 2, "不覆盖");
    assert.strictEqual(genKey.main(["--out", path.join(PC, "src", "oops.pem")], { log() {}, error: (l) => errors.push(l) }), 2, "不写进仓库");
    assert.ok(!fs.existsSync(path.join(PC, "src", "oops.pem")));
    assert.strictEqual(genKey.main([], { log() {}, error() {} }), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
