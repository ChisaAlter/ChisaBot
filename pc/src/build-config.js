"use strict";
/**
 * 构建期默认值（src/build-config.json，CI 打包前写入；仓库里是空的 = 通用版）。
 *  - serverUrl：设置向导里预填的服务器地址。通用版留空，首次运行由用户填写自己的服务器。
 *  - updateFeed：在线更新源（electron-updater generic 目录，里面有 latest.yml）。自建发布可以填自己的
 *    静态 HTTPS 目录。
 *  - githubRepo：owner/repo。updateFeed 为空时退回 GitHub Releases：
 *    https://github.com/<owner>/<repo>/releases/latest/download/（仓库须公开）。
 * 本机 config.json 里的 updateFeed（可选）优先于这里，方便自建更新源的人不重新打包就改。
 */
const fs = require("node:fs");
const path = require("node:path");

function load(file = path.join(__dirname, "build-config.json")) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { serverUrl: String(data.serverUrl || ""), updateFeed: String(data.updateFeed || ""), githubRepo: String(data.githubRepo || "") };
  } catch {
    return { serverUrl: "", updateFeed: "", githubRepo: "" };
  }
}

function withSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

/** 更新源 + 来源级别：本机覆盖 → 构建期 updateFeed → GitHub Releases → 空（不检查更新）。 */
function resolveFeedDetail(build, local = {}) {
  if (local.updateFeed && /^https:\/\//i.test(local.updateFeed)) return { url: withSlash(local.updateFeed), source: "local" };
  if (build.updateFeed) return { url: withSlash(build.updateFeed), source: "build" };
  if (/^[\w.-]+\/[\w.-]+$/.test(build.githubRepo)) return { url: `https://github.com/${build.githubRepo}/releases/latest/download/`, source: "github" };
  return { url: "", source: "" };
}

function resolveFeed(build, local = {}) {
  return resolveFeedDetail(build, local).url;
}

/**
 * 把更新源地址转成浏览器可打开的「下载最新版本」页面 URL（仅接受 https://）：
 * GitHub Releases generic 源 `.../releases/latest/download/` 直接打开会 404，需去掉尾段 `/download/`。
 */
function feedToDownloadPage(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!/^https:\/\//i.test(raw)) return "";
  const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/?$/i.exec(raw);
  if (gh) return `https://github.com/${gh[1]}/releases/latest`;
  return raw;
}

/** 按「当前生效更新源 → resolveFeed → 打包 publish.url」顺序解析手动下载页 URL。 */
function resolveManualDownloadUrl(build = {}, local = {}, { feedUrl = "", publishUrl = "" } = {}) {
  const candidates = [feedUrl, resolveFeed(build, local), publishUrl];
  for (const candidate of candidates) {
    const page = feedToDownloadPage(candidate);
    if (page) return page;
  }
  return "";
}

module.exports = { load, resolveFeed, resolveFeedDetail, feedToDownloadPage, resolveManualDownloadUrl };
