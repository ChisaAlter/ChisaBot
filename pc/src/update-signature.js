"use strict";
/**
 * PC 更新验签（docs/pc-update-signing.md）。
 *
 * latest.yml 只有 HTTPS 和同一个源里的 sha512：能拿到发布源写权限的人（GitHub 账号 / token、能推标签的人、
 * 发布 job 的供应链、自建更新目录）就能让所有客户端静默装任意 exe。这里给 latest.yml 加一层 Ed25519 签名：
 *
 *  - 签名覆盖「规范化消息」（canonicalMessage）：版本、安装包路径、安装包 sha512 和大小、外壳指纹、是否重新安装，
 *    每项一行、固定顺序。签名写在 latest.yml 的 chisabotSig: '<keyId>:<base64>'（electron-updater 把未知字段原样
 *    放进 UpdateInfo，客户端在 update-downloaded 里读到）。安装包本身不改：签了 sha512 就等于签了安装包。
 *  - 客户端用内置公钥表（update-keys.json）校验，再自己算一遍下载文件的 sha512，必须等于签名覆盖的值。
 *    缺签名、keyId 不认识、签名不符、哈希或大小不符，一律拒绝。
 *  - 公钥表为空（keys: []）= 这个构建没启用验签（自建版没配公钥），保持旧行为（只有 sha512），网页提示。
 *    公钥表损坏 / 格式不对 = 启用验签但没有可用公钥：所有更新都会被拒绝（宁可装不上，也不放过）。
 *
 * 签名方（scripts/sign-update.js）和校验方（这里）用同一份 canonicalMessage；两边的 latest.yml 都用 js-yaml 解析
 * （electron-updater 自己就是用 js-yaml 读 latest.yml 的），值的类型一致，拼出来的消息逐字节相同。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCHEME = "chisabot-pc-update/v1";
const SIG_FIELD = "chisabotSig";
const KEYS_FILE = path.join(__dirname, "update-keys.json");
/** Ed25519 SubjectPublicKeyInfo 的固定 DER 前缀，后面接 32 字节原始公钥。 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

class UpdateSignatureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateSignatureError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new UpdateSignatureError(code, message);
}

function text(value, name) {
  const out = value === undefined || value === null ? "" : String(value);
  if (/[\r\n]/.test(out)) fail("ERR_MANIFEST", `清单字段 ${name} 含换行`);
  return out;
}

/** 签名覆盖的字段（已经按客户端的理解规范化）。 */
function signedFields(info) {
  if (!info || typeof info !== "object") fail("ERR_MANIFEST", "更新清单为空");
  const version = text(info.version, "version");
  const file = text(info.path, "path");
  const sha512 = text(info.sha512, "sha512");
  if (!version || !file || !sha512) fail("ERR_MANIFEST", "更新清单缺少 version / path / sha512");
  const entry = Array.isArray(info.files) ? info.files.find((f) => f && typeof f === "object" && String(f.url) === file) : null;
  // files 里同一个安装包的 sha512 必须和顶层一致：electron-updater 下载、校验用的是 files 里的那一项。
  if (entry && entry.sha512 != null && String(entry.sha512) !== sha512) fail("ERR_MANIFEST", "更新清单里安装包的 sha512 前后不一致");
  return {
    version,
    path: file,
    sha512,
    size: entry && entry.size != null ? text(entry.size, "size") : "",
    chisabotShell: text(info.chisabotShell, "chisabotShell").trim(),
    // 和 updater.js 的 requiresFullInstall 同一个理解：只有 true / "true" 算强制重新安装。
    fullInstall: info.fullInstall === true || info.fullInstall === "true" ? "true" : "false",
  };
}

/** 被签名的消息：第一行是方案名，之后每项一行 key=value，固定顺序，结尾换行。 */
function canonicalMessage(info) {
  const f = signedFields(info);
  const lines = [SCHEME, ...["version", "path", "sha512", "size", "chisabotShell", "fullInstall"].map((k) => `${k}=${f[k]}`)];
  return `${lines.join("\n")}\n`;
}

/** 原始 32 字节公钥。key：Ed25519 公钥或私钥（KeyObject / PEM）。 */
function rawPublicKey(key) {
  const pub = key instanceof crypto.KeyObject && key.type === "public" ? key : crypto.createPublicKey(key);
  return pub.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.length);
}

/** keyId：原始公钥（32 字节）sha256 的前 8 个十六进制字符。 */
function keyIdOf(publicKeyBase64) {
  return crypto.createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 8);
}

function publicKeyObject(publicKeyBase64) {
  if (typeof publicKeyBase64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(publicKeyBase64)) fail("ERR_KEYS", "公钥不是 32 字节的 base64");
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (raw.length !== 32) fail("ERR_KEYS", "公钥不是 32 字节");
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/**
 * 解析公钥表。格式：{ "keys": [{ "keyId": "ab12cd34", "publicKey": "<base64>", "label": "primary" }] }。
 * 声明的 keyId 必须和公钥算出来的一致（防抄错）。
 */
function parseKeys(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.keys)) fail("ERR_KEYS", "公钥表格式不对：缺 keys 数组");
  const keys = new Map();
  for (const entry of data.keys) {
    if (!entry || typeof entry !== "object") fail("ERR_KEYS", "公钥表里有无效项");
    const key = publicKeyObject(entry.publicKey);
    const keyId = keyIdOf(entry.publicKey);
    if (entry.keyId !== undefined && entry.keyId !== keyId) fail("ERR_KEYS", `公钥表的 keyId ${entry.keyId} 和公钥算出来的 ${keyId} 不一致`);
    keys.set(keyId, { keyId, key, publicKey: entry.publicKey, label: String(entry.label || "") });
  }
  return keys;
}

/**
 * 读客户端内置的公钥表。
 *  - enforce=false：公钥表是空的（自建版没配公钥），不验签，保持旧行为；
 *  - enforce=true：有公钥，或者公钥表读不出来 / 格式不对（problem 里写原因）—— 后者 keys 为空，所有更新都会被拒绝。
 */
function loadKeys(file = KEYS_FILE) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { enforce: true, keys: new Map(), problem: `读不出更新公钥表：${error.message}` };
  }
  try {
    const keys = parseKeys(data);
    return { enforce: keys.size > 0, keys, problem: "" };
  } catch (error) {
    return { enforce: true, keys: new Map(), problem: error.message };
  }
}

/** chisabotSig: '<keyId>:<base64 签名>'。 */
function parseSignature(value) {
  if (value === undefined || value === null || value === "") fail("ERR_NO_SIGNATURE", "更新清单没有签名");
  const match = /^([0-9a-f]{8}):([A-Za-z0-9+/]{86}==)$/.exec(String(value).trim());
  if (!match) fail("ERR_SIGNATURE_FORMAT", "更新清单的签名格式不对");
  return { keyId: match[1], signature: Buffer.from(match[2], "base64") };
}

/** 只校验清单（不碰安装包）。返回 { keyId, fields }。 */
function verifyManifest(info, keys) {
  if (!keys || keys.size === 0) fail("ERR_NO_KEYS", "这个版本没有可用的更新公钥");
  const { keyId, signature } = parseSignature(info && info[SIG_FIELD]);
  const entry = keys.get(keyId);
  if (!entry) fail("ERR_UNKNOWN_KEY", `签名用的密钥 ${keyId} 不在本机公钥表里`);
  const message = Buffer.from(canonicalMessage(info), "utf8");
  if (!crypto.verify(null, message, entry.key, signature)) fail("ERR_SIGNATURE_MISMATCH", "更新清单的签名不符");
  return { keyId, fields: signedFields(info) };
}

/** 文件的 sha512（base64，和 latest.yml 一样）。flipFirstByte 只给 --tamper-check 用：模拟改了一个字节。 */
function sha512File(file, { flipFirstByte = false } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    let first = flipFirstByte;
    fs.createReadStream(file)
      .on("data", (chunk) => {
        if (first && chunk.length > 0) {
          const copy = Buffer.from(chunk);
          copy[0] ^= 0xff;
          hash.update(copy);
          first = false;
        } else hash.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

/** 清单签名 + 下载文件的大小和 sha512。全部通过才返回；任何一项不对都抛 UpdateSignatureError。 */
async function verifyDownloadedUpdate({ info, file, keys, hashFile = sha512File }) {
  const result = verifyManifest(info, keys);
  if (!file) fail("ERR_NO_FILE", "找不到下载好的安装包");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fail("ERR_NO_FILE", "找不到下载好的安装包");
  }
  if (result.fields.size && String(stat.size) !== result.fields.size) fail("ERR_SIZE_MISMATCH", "下载的安装包大小和签名不符");
  const actual = await hashFile(file);
  if (actual !== result.fields.sha512) fail("ERR_HASH_MISMATCH", "下载的安装包和签名不符");
  return result;
}

/** 签名（scripts/sign-update.js 用）。privateKey：PKCS8 PEM 文本或 KeyObject。返回 chisabotSig 的值。 */
function signManifest(info, privateKey) {
  const key = typeof privateKey === "string" ? crypto.createPrivateKey(privateKey) : privateKey;
  if (key.asymmetricKeyType !== "ed25519") fail("ERR_KEYS", "签名私钥不是 Ed25519");
  const keyId = keyIdOf(rawPublicKey(key).toString("base64"));
  const signature = crypto.sign(null, Buffer.from(canonicalMessage(info), "utf8"), key);
  return `${keyId}:${signature.toString("base64")}`;
}

module.exports = {
  SCHEME,
  SIG_FIELD,
  KEYS_FILE,
  UpdateSignatureError,
  signedFields,
  canonicalMessage,
  keyIdOf,
  rawPublicKey,
  parseKeys,
  loadKeys,
  parseSignature,
  verifyManifest,
  verifyDownloadedUpdate,
  sha512File,
  signManifest,
};
