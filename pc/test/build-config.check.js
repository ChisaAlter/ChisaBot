"use strict";
/* 构建期默认值（src/build-config.js）：通用版不写死任何服务器；更新源的选择顺序。 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { load, resolveFeed, resolveFeedDetail, feedToDownloadPage, resolveManualDownloadUrl } = require("../src/build-config");

test("committed build-config.json is the generic build (no server, no feed)", () => {
  const c = load(path.join(__dirname, "..", "src", "build-config.json"));
  assert.strictEqual(c.serverUrl, "");
  assert.strictEqual(c.updateFeed, "");
});

test("feed order: local override → build feed → GitHub Releases → none", () => {
  const build = { serverUrl: "", updateFeed: "https://example.com/pc", githubRepo: "me/chisabot" };
  assert.strictEqual(resolveFeed(build, { updateFeed: "https://mine.example/feed/" }), "https://mine.example/feed/");
  assert.strictEqual(resolveFeed(build, { updateFeed: "http://insecure/" }), "https://example.com/pc/");
  assert.strictEqual(resolveFeed({ ...build, updateFeed: "" }), "https://github.com/me/chisabot/releases/latest/download/");
  assert.strictEqual(resolveFeed({ serverUrl: "", updateFeed: "", githubRepo: "" }), "");
});

test("resolveFeedDetail reports which tier the feed came from (local override can fall back)", () => {
  const build = { serverUrl: "", updateFeed: "https://example.com/pc", githubRepo: "me/chisabot" };
  assert.deepStrictEqual(resolveFeedDetail(build, { updateFeed: "https://mine.example/feed" }), { url: "https://mine.example/feed/", source: "local" });
  assert.deepStrictEqual(resolveFeedDetail(build, { updateFeed: "http://insecure/" }), { url: "https://example.com/pc/", source: "build" });
  assert.deepStrictEqual(resolveFeedDetail({ ...build, updateFeed: "" }, {}), { url: "https://github.com/me/chisabot/releases/latest/download/", source: "github" });
  assert.deepStrictEqual(resolveFeedDetail({ serverUrl: "", updateFeed: "", githubRepo: "" }, {}), { url: "", source: "" });
});

test("missing file falls back to empty defaults", () => {
  assert.deepStrictEqual(load("/nonexistent/build-config.json"), { serverUrl: "", updateFeed: "", githubRepo: "" });
});

test("feedToDownloadPage and resolveManualDownloadUrl resolve https manual download links", () => {
  assert.strictEqual(feedToDownloadPage("https://github.com/ChisaAlter/ChisaBot/releases/latest/download/"), "https://github.com/ChisaAlter/ChisaBot/releases/latest");
  assert.strictEqual(feedToDownloadPage("https://github.com/ChisaAlter/ChisaBot/releases/latest/download"), "https://github.com/ChisaAlter/ChisaBot/releases/latest");
  assert.strictEqual(feedToDownloadPage("https://dl.example.com/pc/"), "https://dl.example.com/pc/");
  assert.strictEqual(feedToDownloadPage("http://insecure.example.com/pc/"), "");
  assert.strictEqual(feedToDownloadPage("javascript:alert(1)"), "");

  assert.strictEqual(
    resolveManualDownloadUrl({ githubRepo: "ChisaAlter/ChisaBot" }, {}, { feedUrl: "https://mirror.example.com/pc/" }),
    "https://mirror.example.com/pc/",
  );
  assert.strictEqual(
    resolveManualDownloadUrl({ githubRepo: "ChisaAlter/ChisaBot" }, {}, { publishUrl: "https://github.com/ChisaAlter/ChisaBot/releases/latest/download/" }),
    "https://github.com/ChisaAlter/ChisaBot/releases/latest",
  );
  assert.strictEqual(
    resolveManualDownloadUrl({}, {}, { feedUrl: "http://bad.example.com", publishUrl: "https://github.com/ChisaAlter/ChisaBot/releases/latest/download/" }),
    "https://github.com/ChisaAlter/ChisaBot/releases/latest",
  );
  assert.strictEqual(resolveManualDownloadUrl({}, {}, {}), "");
});
