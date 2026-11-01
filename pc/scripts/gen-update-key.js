#!/usr/bin/env node
"use strict";
/**
 * 生成一把 PC 更新签名密钥（Ed25519）。docs/pc-update-signing.md「Jun 要做的」。
 *
 *   node scripts/gen-update-key.js --out <仓库外的路径.pem> [--label primary]
 *
 * 私钥写进 --out（PKCS8 PEM，权限 0600），不打印、不允许写进仓库目录、不覆盖已有文件。
 * 终端只输出 keyId、公钥和要放进 src/update-keys.json 的那一项。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sig = require("../src/update-signature");

const REPO = path.resolve(__dirname, "..", "..");

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function main(argv, { log = (line) => console.log(line), error = (line) => console.error(line), repo = REPO } = {}) {
  const at = argv.indexOf("--out");
  const out = at >= 0 ? argv[at + 1] : "";
  const labelAt = argv.indexOf("--label");
  const label = labelAt >= 0 ? String(argv[labelAt + 1] || "") : "";
  if (!out || out.startsWith("--")) {
    error("用法：gen-update-key.js --out <仓库外的路径.pem> [--label primary]");
    return 2;
  }
  const file = path.resolve(out);
  if (inside(file, path.resolve(repo))) {
    error(`拒绝把私钥写进仓库目录：${file}`);
    return 2;
  }
  if (fs.existsSync(file)) {
    error(`已存在，不覆盖：${file}`);
    return 2;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const pub = sig.rawPublicKey(publicKey).toString("base64");
  const entry = { keyId: sig.keyIdOf(pub), publicKey: pub, label };
  log(`private key written to ${file} (not printed; keep it offline / put it into the GitHub secret)`);
  log(`keyId:      ${entry.keyId}`);
  log(`public key: ${pub}`);
  log("update-keys.json entry:");
  log(JSON.stringify(entry));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
