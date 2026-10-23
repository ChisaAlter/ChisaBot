"use strict";
/**
 * 电脑同步用的 SSH 密钥（P4b，docs/cloud-claude-code.md §4.4）：这台电脑一把 ed25519，只放在本机（userData/sync/keys）。
 * 用 Node 自带的 crypto 生成，写成 OpenSSH 自己的私钥格式（openssh-key-v1，不加密），系统的 ssh（Windows 自带 OpenSSH）直接认。
 * 公钥通过设备令牌的 /api/devices/agent/sync/bind 登记，服务器让云端节点写进同步边车的 authorized_keys。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function tightenWindowsKeyAcl(keyFile) {
  if (process.platform !== "win32") return;
  try {
    const user = process.env.USERNAME || os.userInfo().username;
    if (!user) return;
    execFileSync("icacls", [keyFile, "/inheritance:r", "/grant:r", `${user}:(F)`, "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch {}
}

function sshString(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** 生成一把 ed25519：返回 { privateKey（OpenSSH PEM 文本）, publicKey（"ssh-ed25519 AAAA… 注释"） }。 */
function generateKeyPair(comment = "chisabot-sync") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  if (pub.length !== 32 || seed.length !== 32) throw new Error("生成密钥失败");
  const type = Buffer.from("ssh-ed25519");
  const pubBlob = Buffer.concat([sshString(type), sshString(pub)]);
  const check = crypto.randomBytes(4).readUInt32BE(0);
  let priv = Buffer.concat([u32(check), u32(check), sshString(type), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.from(comment))]);
  const pad = [];
  for (let i = 1; priv.length % 8 !== 0; i++) {
    pad.push(i);
    priv = Buffer.concat([priv, Buffer.from([i])]);
  }
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(pubBlob),
    sshString(priv),
  ]);
  const b64 = body.toString("base64").replace(/.{1,70}/g, "$&\n");
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${pubBlob.toString("base64")} ${comment}`,
  };
}

/** 读不到就生成：dir/id_ed25519（私钥，600）+ id_ed25519.pub。返回 { keyFile, publicKey }。 */
function ensureKey(dir, comment) {
  const keyFile = path.join(dir, "id_ed25519");
  const pubFile = `${keyFile}.pub`;
  try {
    const pub = fs.readFileSync(pubFile, "utf8").trim();
    if (/^ssh-ed25519 [A-Za-z0-9+/=]{60,120}( |$)/.test(pub) && fs.statSync(keyFile).size > 100) {
      tightenWindowsKeyAcl(keyFile);
      return { keyFile, publicKey: pub };
    }
  } catch {}
  fs.mkdirSync(dir, { recursive: true });
  const pair = generateKeyPair(comment);
  fs.writeFileSync(keyFile, pair.privateKey, { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {}
  tightenWindowsKeyAcl(keyFile);
  fs.writeFileSync(pubFile, `${pair.publicKey}\n`, { mode: 0o644 });
  return { keyFile, publicKey: pair.publicKey };
}

module.exports = { generateKeyPair, ensureKey };
