#!/usr/bin/env node
"use strict";
/**
 * 给 latest.yml 签名 / 验签（docs/pc-update-signing.md）。签名是发布的最后一步：shell-fingerprint.js --stamp 之后。
 *
 * 用法（在 pc/ 下）：
 *   node scripts/sign-update.js dist/latest.yml [--key-file <私钥.pem>] [--keys <公钥表>]
 *        签名，写入（或替换）chisabotSig。私钥默认从环境变量 PC_UPDATE_SIGNING_KEY（PKCS8 PEM 文本）读，
 *        也可以 --key-file 指向离线保存的私钥文件（以后改成离线手签时用）。私钥不落盘、不打印。
 *        签完马上用公钥表（默认 src/update-keys.json）验一遍：签名用的钥匙不在公钥表里就失败——
 *        客户端只认公钥表里的钥匙，这样的签名发出去所有客户端都会拒装。
 *   node scripts/sign-update.js --verify dist/latest.yml [--installer <安装包>] [--keys <公钥表>] [--tamper-check]
 *        验签：清单签名 + 安装包（默认是 latest.yml 同目录下 path 指的文件）的大小和 sha512。
 *        --tamper-check：验过之后再把每个签名字段、安装包的第一个字节各改一次，确认每一次都会被拒绝（CI 自检）。
 *   node scripts/sign-update.js --require-keys [--keys <公钥表>]
 *        公钥表为空就失败（通用版必须内置公钥）。
 *   node scripts/sign-update.js --keys-from-env [--keys <输出文件>]
 *        自建版：按环境变量 CHISABOT_UPDATE_PUBKEYS（逗号或空白分隔的 base64 公钥）写公钥表；变量为空就写空表
 *        （= 这个构建不验签，保持旧行为）。
 * 退出码：0 成功；1 校验 / 签名失败；2 用法错误。
 */
const fs = require("node:fs");
const path = require("node:path");
const sig = require("../src/update-signature");

const PC = path.join(__dirname, "..");

/** 和 electron-updater 一样用 js-yaml 解析 latest.yml（它是 electron-updater 的依赖）。 */
function loadYaml() {
  try {
    return require("js-yaml");
  } catch {
    return require(require.resolve("js-yaml", { paths: [path.dirname(require.resolve("electron-updater"))] }));
  }
}

function readManifest(file) {
  const textValue = fs.readFileSync(file, "utf8");
  const info = loadYaml().load(textValue);
  if (!info || typeof info !== "object") throw new sig.UpdateSignatureError("ERR_MANIFEST", `${file} 不是有效的 latest.yml`);
  return { text: textValue, info };
}

/** 写（或替换）chisabotSig 一行。单引号包起来：base64 里没有单引号，js-yaml 读回来一定是原样字符串。 */
function writeSignature(textValue, value) {
  const kept = textValue
    .split(/\r?\n/)
    .filter((line) => !/^chisabotSig:/.test(line))
    .join("\n")
    .replace(/\n+$/, "");
  return `${kept}\n${sig.SIG_FIELD}: '${value}'\n`;
}

function readKeysFile(file) {
  return sig.parseKeys(JSON.parse(fs.readFileSync(file, "utf8")));
}

function option(argv, name) {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${name} 需要一个参数`);
  return value;
}

class UsageError extends Error {}

function positional(argv) {
  const withValue = new Set(["--key-file", "--keys", "--installer", "--verify"]);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (withValue.has(argv[i])) {
      i++;
      continue;
    }
    if (!argv[i].startsWith("--")) out.push(argv[i]);
  }
  return out;
}

/** 把一个签名字段改掉（--tamper-check 用）。 */
const TAMPERS = {
  version: (info) => ({ ...info, version: `${info.version}.1` }),
  path: (info) => ({ ...info, path: `x${info.path}`, files: (info.files || []).map((f) => (f.url === info.path ? { ...f, url: `x${f.url}` } : f)) }),
  sha512: (info) => {
    const other = `${info.sha512.slice(0, -4)}${info.sha512.slice(-4, -3) === "A" ? "B" : "A"}${info.sha512.slice(-3)}`;
    return { ...info, sha512: other, files: (info.files || []).map((f) => (f.url === info.path ? { ...f, sha512: other } : f)) };
  },
  size: (info) => ({ ...info, files: (info.files || []).map((f) => (f.url === info.path ? { ...f, size: Number(f.size) + 1 } : f)) }),
  chisabotShell: (info) => ({ ...info, chisabotShell: `${info.chisabotShell || ""}0` }),
  fullInstall: (info) => ({ ...info, fullInstall: !(info.fullInstall === true || info.fullInstall === "true") }),
};

async function verify(file, { keysFile, installer, tamperCheck, log }) {
  const keys = readKeysFile(keysFile);
  const { info } = readManifest(file);
  const target = installer || path.join(path.dirname(file), String(info.path || ""));
  const result = await sig.verifyDownloadedUpdate({ info, file: target, keys });
  log(`verified ${file}: ${info.version} signed by ${result.keyId}, ${path.basename(target)} sha512 ok`);
  if (!tamperCheck) return;
  for (const [name, tamper] of Object.entries(TAMPERS)) {
    if (name === "size" && !result.fields.size) continue;
    let rejected = false;
    try {
      sig.verifyManifest(tamper(info), keys);
    } catch (error) {
      rejected = error instanceof sig.UpdateSignatureError;
    }
    if (!rejected) throw new sig.UpdateSignatureError("ERR_TAMPER_CHECK", `改了 ${name} 以后签名仍然通过`);
  }
  const flipped = await sig.verifyDownloadedUpdate({ info, file: target, keys, hashFile: (f) => sig.sha512File(f, { flipFirstByte: true }) }).then(
    () => false,
    (error) => error.code === "ERR_HASH_MISMATCH",
  );
  if (!flipped) throw new sig.UpdateSignatureError("ERR_TAMPER_CHECK", "安装包改一个字节以后仍然通过");
  log(`tamper check ok: ${Object.keys(TAMPERS).join(" / ")} / installer byte all rejected`);
}

function sign(file, { keysFile, keyFile, env, log }) {
  let pem;
  if (keyFile) pem = fs.readFileSync(keyFile, "utf8");
  else pem = env.PC_UPDATE_SIGNING_KEY;
  if (!pem || !pem.trim()) throw new sig.UpdateSignatureError("ERR_NO_PRIVATE_KEY", "没有签名私钥：设置 PC_UPDATE_SIGNING_KEY 或用 --key-file");
  const keys = readKeysFile(keysFile);
  if (keys.size === 0) throw new sig.UpdateSignatureError("ERR_NO_KEYS", `${keysFile} 是空的：没有公钥的构建不能签名`);
  const { text: textValue, info } = readManifest(file);
  let value;
  try {
    value = sig.signManifest(info, pem);
  } catch (error) {
    // 不把私钥解析错误的原文打出来（里面可能带 PEM 片段）。
    if (error instanceof sig.UpdateSignatureError) throw error;
    throw new sig.UpdateSignatureError("ERR_PRIVATE_KEY", "签名私钥读不出来（需要 Ed25519 的 PKCS8 PEM）");
  }
  const keyId = value.slice(0, 8);
  if (!keys.has(keyId)) throw new sig.UpdateSignatureError("ERR_UNKNOWN_KEY", `签名私钥 ${keyId} 不在 ${keysFile} 里，客户端会拒装`);
  const signed = writeSignature(textValue, value);
  // 先在内存里验一遍再写盘。
  sig.verifyManifest(loadYaml().load(signed), keys);
  fs.writeFileSync(file, signed);
  log(`signed ${file}: ${info.version} with ${keyId}`);
}

/** CHISABOT_UPDATE_PUBKEYS → 公钥表。 */
function keysFromEnv(value) {
  const list = String(value || "")
    .split(/[\s,]+/)
    .filter(Boolean);
  const keys = list.map((publicKey, i) => ({ keyId: sig.keyIdOf(publicKey), publicKey, label: `CHISABOT_UPDATE_PUBKEYS #${i + 1}` }));
  sig.parseKeys({ keys }); // 格式不对直接失败
  return { keys };
}

async function main(argv, { env = process.env, log = (line) => console.log(line), error = (line) => console.error(line) } = {}) {
  try {
    const keysFile = path.resolve(option(argv, "--keys") || path.join(PC, "src", "update-keys.json"));
    if (argv.includes("--require-keys")) {
      const keys = readKeysFile(keysFile);
      if (keys.size === 0) {
        error(`${keysFile} 里没有公钥：通用版必须内置更新公钥（docs/pc-update-signing.md「Jun 要做的」）`);
        return 1;
      }
      log(`update keys: ${[...keys.keys()].join(", ")}`);
      return 0;
    }
    if (argv.includes("--keys-from-env")) {
      const table = keysFromEnv(env.CHISABOT_UPDATE_PUBKEYS);
      fs.writeFileSync(keysFile, `${JSON.stringify(table, null, 2)}\n`);
      log(table.keys.length ? `wrote ${keysFile}: ${table.keys.map((k) => k.keyId).join(", ")}` : `wrote ${keysFile}: no keys (update signing disabled for this build)`);
      return 0;
    }
    const verifyFile = option(argv, "--verify");
    if (verifyFile) {
      await verify(verifyFile, { keysFile, installer: option(argv, "--installer"), tamperCheck: argv.includes("--tamper-check"), log });
      return 0;
    }
    const [file, extra] = positional(argv);
    if (!file || extra) throw new UsageError("用法：sign-update.js <latest.yml> | --verify <latest.yml> | --require-keys | --keys-from-env");
    sign(file, { keysFile, keyFile: option(argv, "--key-file"), env, log });
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      error(e.message);
      return 2;
    }
    if (e instanceof sig.UpdateSignatureError) {
      error(`sign-update: ${e.message}（${e.code}）`);
      return 1;
    }
    error(`sign-update: ${e && e.code ? e.code : "失败"} ${e && e.message ? e.message.split("\n")[0].slice(0, 200) : ""}`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => (process.exitCode = code));

module.exports = { main, writeSignature, readManifest, keysFromEnv, TAMPERS };
