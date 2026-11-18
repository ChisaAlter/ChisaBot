"use strict";
/* 桌面端内置本地前端与「版本高者优先」同源拦截单元测试（DESIGN.md §137）。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  stageWebBundle,
  verifyAsarWebBundle,
} = require("../scripts/stage-web-bundle");
const {
  createLocalWebController,
  resolveBundleFile,
} = require("../src/local-web");
const fp = require("../scripts/shell-fingerprint");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeFakeAsar(filePath, tree) {
  const jsonBuf = Buffer.from(JSON.stringify(tree), "utf8");
  const alignedLen = Math.ceil(jsonBuf.length / 4) * 4;
  const headerSize = 8 + alignedLen;
  const headerBuf = Buffer.alloc(16 + alignedLen);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerSize, 4);
  headerBuf.writeUInt32LE(headerSize - 4, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);
  fs.writeFileSync(filePath, headerBuf);
}

test("stageWebBundle copies index & assets, excludes node-agent/maps, and writes meta", () => {
  withTempDir("chisabot-stage-", (root) => {
    const fromDir = path.join(root, "dist");
    const targetDir = path.join(root, "web-bundle");
    fs.mkdirSync(path.join(fromDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(fromDir, "node-agent"), { recursive: true });
    fs.writeFileSync(path.join(fromDir, "index.html"), "<html>ok</html>");
    fs.writeFileSync(path.join(fromDir, "assets", "app.js"), "console.log(1);");
    fs.writeFileSync(path.join(fromDir, "assets", "app.js.map"), "{}");
    fs.writeFileSync(
      path.join(fromDir, "node-agent", "chisabot-node.cjs"),
      "// skip",
    );

    const res = stageWebBundle({ fromDir, targetDir, version: "0.1.154" });
    assert.deepEqual(res.meta, {
      version: "0.1.154",
      buildId: "pc-0.1.154",
    });
    assert.ok(fs.existsSync(path.join(targetDir, "index.html")));
    assert.ok(fs.existsSync(path.join(targetDir, "assets", "app.js")));
    assert.ok(fs.existsSync(path.join(targetDir, "chisabot-web-meta.json")));
    assert.ok(!fs.existsSync(path.join(targetDir, "assets", "app.js.map")));
    assert.ok(
      !fs.existsSync(path.join(targetDir, "node-agent", "chisabot-node.cjs")),
    );
  });
});

test("verifyAsarWebBundle validates ASAR header tree cleanly", () => {
  withTempDir("chisabot-asar-", (root) => {
    const good = path.join(root, "good.asar");
    makeFakeAsar(good, {
      files: {
        src: {
          files: {
            "web-bundle": {
              files: {
                "index.html": { size: 10, offset: "0" },
                "chisabot-web-meta.json": { size: 20, offset: "10" },
                assets: {
                  files: {
                    "app-123.js": { size: 30, offset: "30" },
                  },
                },
              },
            },
          },
        },
      },
    });
    const verified = verifyAsarWebBundle(good);
    assert.equal(verified.assetCount, 1);

    const noIndex = path.join(root, "no-index.asar");
    makeFakeAsar(noIndex, {
      files: {
        src: {
          files: {
            "web-bundle": {
              files: {
                "chisabot-web-meta.json": { size: 20, offset: "0" },
                assets: { files: { "a.js": { size: 1, offset: "0" } } },
              },
            },
          },
        },
      },
    });
    assert.throws(() => verifyAsarWebBundle(noIndex), /index\.html/);

    const emptyAssets = path.join(root, "empty-assets.asar");
    makeFakeAsar(emptyAssets, {
      files: {
        src: {
          files: {
            "web-bundle": {
              files: {
                "index.html": { size: 10, offset: "0" },
                "chisabot-web-meta.json": { size: 20, offset: "10" },
                assets: { files: {} },
              },
            },
          },
        },
      },
    });
    assert.throws(() => verifyAsarWebBundle(emptyAssets), /assets/);
  });
});

test("resolveBundleFile blocks path traversal and NUL bytes", () => {
  withTempDir("chisabot-bundle-sec-", (root) => {
    const bundleDir = path.join(root, "web-bundle");
    fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.html"), "<html/>");
    fs.writeFileSync(path.join(bundleDir, "assets", "main.js"), "1");
    fs.writeFileSync(path.join(root, "secret.txt"), "top-secret");

    assert.equal(
      resolveBundleFile(bundleDir, "/assets/main.js"),
      path.join(bundleDir, "assets", "main.js"),
    );
    assert.equal(resolveBundleFile(bundleDir, "/../secret.txt"), null);
    assert.equal(
      resolveBundleFile(bundleDir, "/assets/../../secret.txt"),
      null,
    );
    assert.equal(resolveBundleFile(bundleDir, "/%2e%2e/secret.txt"), null);
    assert.equal(resolveBundleFile(bundleDir, "/assets/main.js%00.png"), null);
  });
});

test("classifyRequest routes server prefixes, writes, local HTML/assets, and multi-origin priority", () => {
  withTempDir("chisabot-classify-", (root) => {
    const bundleDir = path.join(root, "web-bundle");
    fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.html"), "<html/>");
    fs.writeFileSync(
      path.join(bundleDir, "chisabot-web-meta.json"),
      JSON.stringify({ version: "0.1.154", buildId: "pc-0.1.154" }),
    );
    fs.writeFileSync(path.join(bundleDir, "assets", "index-aaa.js"), "ok");

    let currentOrigin = "https://srv-a.example.com";
    const modeEvents = [];
    const ctrl = createLocalWebController({
      bundleDir,
      localVersion: "0.1.154",
      getServerOrigin: () => currentOrigin,
      onModeChange: (e) => modeEvents.push(e),
    });

    assert.equal(ctrl.activeMode(currentOrigin), "local");

    for (const urlPath of [
      "/api/version",
      "/api/bots",
      "/auth/callback",
      "/login",
      "/sign",
      "/p/share-1",
      "/downloads/file.txt",
    ]) {
      assert.equal(
        ctrl.classifyRequest({
          url: `${currentOrigin}${urlPath}`,
          method: "GET",
          headers: { accept: "text/html" },
        }).action,
        "passthrough",
        `${urlPath} must pass through`,
      );
    }

    assert.equal(
      ctrl.classifyRequest({
        url: `${currentOrigin}/settings/appearance`,
        method: "POST",
        headers: { accept: "text/html" },
      }).action,
      "passthrough",
    );
    assert.equal(
      ctrl.classifyRequest({
        url: "https://other.example.com/settings/appearance",
        method: "GET",
        headers: { accept: "text/html" },
      }).action,
      "passthrough",
    );

    const rootNav = ctrl.classifyRequest({
      url: `${currentOrigin}/`,
      method: "GET",
      headers: {},
    });
    assert.equal(rootNav.action, "local-file");
    assert.equal(rootNav.filePath, path.join(bundleDir, "index.html"));

    const deepNav = ctrl.classifyRequest({
      url: `${currentOrigin}/settings/appearance`,
      method: "GET",
      headers: { "upgrade-insecure-requests": "1" },
    });
    assert.equal(deepNav.action, "local-file");
    assert.equal(deepNav.filePath, path.join(bundleDir, "index.html"));

    const htmlAcceptNav = ctrl.classifyRequest({
      url: `${currentOrigin}/channel/main`,
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(htmlAcceptNav.action, "local-file");

    const assetHit = ctrl.classifyRequest({
      url: `${currentOrigin}/assets/index-aaa.js`,
      method: "GET",
      headers: {},
    });
    assert.equal(assetHit.action, "local-file");
    assert.equal(assetHit.cacheControl, "public, max-age=31536000, immutable");

    // Missing /assets/* must fall back to network, never index.html!
    const missingAsset = ctrl.classifyRequest({
      url: `${currentOrigin}/assets/missing.js`,
      method: "GET",
      headers: { accept: "text/html" },
    });
    assert.equal(missingAsset.action, "passthrough");

    // Version precedence: 0.1.149 -> local, 0.1.154 -> local, 0.1.155 -> remote
    ctrl.recordServerVersion(currentOrigin, "0.1.149");
    assert.equal(ctrl.activeMode(currentOrigin), "local");
    ctrl.recordServerVersion(currentOrigin, "0.1.154");
    assert.equal(ctrl.activeMode(currentOrigin), "local");
    ctrl.recordServerVersion(currentOrigin, "0.1.155");
    assert.equal(ctrl.activeMode(currentOrigin), "remote");
    assert.equal(
      ctrl.classifyRequest({
        url: `${currentOrigin}/`,
        method: "GET",
        headers: { accept: "text/html" },
      }).action,
      "passthrough",
    );
    assert.ok(modeEvents.some((e) => e.mode === "remote"));
    assert.ok(
      modeEvents.some((e) => e.mode === "remote" && e.prevMode === "local"),
      "local→remote 翻转要带 prevMode，主进程据此重载已加载的旧前端",
    );

    // Origin B remains isolated in local mode
    currentOrigin = "https://srv-b.example.com";
    assert.equal(ctrl.activeMode(currentOrigin), "local");
    assert.equal(
      ctrl.classifyRequest({
        url: `${currentOrigin}/`,
        method: "GET",
        headers: {},
      }).action,
      "local-file",
    );
  });
});

test("forwardWithNetRequest preserves 302 Location, strips decoded gzip headers, and sniffs /api/version", async () => {
  await withTempDirAsync("chisabot-net-", async (root) => {
    const bundleDir = path.join(root, "web-bundle");
    fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, "index.html"), "<html/>");
    fs.writeFileSync(
      path.join(bundleDir, "chisabot-web-meta.json"),
      JSON.stringify({ version: "0.1.154", buildId: "pc-0.1.154" }),
    );

    const origin = "https://app.example.com";
    let handler = null;
    const handlers = {};
    const fakeSes = {
      protocol: {
        handle(scheme, fn) {
          handlers[scheme] = fn;
        },
      },
    };

    const fakeNet = {
      request(opts) {
        const reqEmitter = new EventEmitter();
        reqEmitter.write = () => {};
        reqEmitter.abort = () => {};
        reqEmitter.end = () => {
          queueMicrotask(() => {
            const urlPath = new URL(opts.url).pathname;
            if (urlPath === "/login-check") {
              reqEmitter.emit("redirect", 302, "GET", `${origin}/login`, {
                "set-cookie": "sid=new; Path=/; HttpOnly",
              });
              return;
            }
            if (urlPath === "/api/gzip-data") {
              const res = new EventEmitter();
              res.statusCode = 200;
              res.headers = {
                "content-type": "application/json",
                "content-encoding": "gzip",
                "content-length": "12",
              };
              reqEmitter.emit("response", res);
              res.emit(
                "data",
                Buffer.from(JSON.stringify({ ok: true, decoded: true })),
              );
              res.emit("end");
              return;
            }
            if (urlPath === "/api/version") {
              const res = new EventEmitter();
              res.statusCode = 200;
              res.headers = { "content-type": "application/json" };
              reqEmitter.emit("response", res);
              res.emit(
                "data",
                Buffer.from(
                  JSON.stringify({ version: "0.1.155", buildId: "srv-155" }),
                ),
              );
              res.emit("end");
            }
          });
        };
        return reqEmitter;
      },
    };

    const ctrl = createLocalWebController({
      bundleDir,
      localVersion: "0.1.154",
      getServerOrigin: () => origin,
      netImpl: fakeNet,
    });
    assert.equal(ctrl.installSessionProtocol(fakeSes), true);
    handler = handlers.https;
    assert.ok(handler);

    // 1. 302 redirect keeps Location header & 302 status
    const redirectRes = await handler(
      new Request(`${origin}/login-check`, { method: "GET" }),
    );
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), `${origin}/login`);
    assert.ok(
      String(redirectRes.headers.get("set-cookie")).includes("sid=new"),
    );

    // 2. gzip decoded response strips content-encoding & stale content-length
    const gzipRes = await handler(
      new Request(`${origin}/api/gzip-data`, { method: "GET" }),
    );
    assert.equal(gzipRes.status, 200);
    assert.equal(gzipRes.headers.get("content-encoding"), null);
    assert.equal(gzipRes.headers.get("content-length"), null);
    assert.deepEqual(await gzipRes.json(), { ok: true, decoded: true });

    // 3. passive /api/version stream sniffing upgrades mode to remote
    assert.equal(ctrl.activeMode(origin), "local");
    const verRes = await handler(
      new Request(`${origin}/api/version`, { method: "GET" }),
    );
    assert.deepEqual(await verRes.json(), {
      version: "0.1.155",
      buildId: "srv-155",
    });
    assert.equal(ctrl.activeMode(origin), "remote");
  });
});

test("shell-fingerprint ignores src/web-bundle and routeTree.gen.ts, keeps Windows shell hash stable", () => {
  withTempDir("chisabot-fp-bundle-", (root) => {
    const pcRoot = path.join(root, "pc");
    const appSrc = path.join(root, "app", "src");
    const sharedDir = path.join(root, "shared");
    fs.mkdirSync(path.join(pcRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(pcRoot, "build"), { recursive: true });
    fs.mkdirSync(path.join(pcRoot, "assets"), { recursive: true });
    fs.mkdirSync(path.join(appSrc, "routes"), { recursive: true });
    fs.mkdirSync(path.join(appSrc, "lib", "generated"), { recursive: true });
    fs.mkdirSync(path.join(root, "app", "public"), { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });

    for (const rel of [
      "package.json",
      "build/icon.ico",
      "build/installer.nsh",
      "assets/icon.png",
    ]) {
      fs.copyFileSync(path.join(__dirname, "..", rel), path.join(pcRoot, rel));
    }
    fs.writeFileSync(path.join(pcRoot, "src", "main.js"), "// main\n");
    fs.writeFileSync(path.join(root, "app", "index.html"), "<html></html>\n");
    fs.writeFileSync(
      path.join(appSrc, "routes", "index.tsx"),
      "export const r = 1;\n",
    );
    fs.writeFileSync(
      path.join(appSrc, "routeTree.gen.ts"),
      "export const gen = 1;\n",
    );
    fs.writeFileSync(path.join(sharedDir, "ver.ts"), "export const v = 1;\n");

    const base = fp.compute(pcRoot);

    // Adding staged web-bundle + modifying routeTree.gen.ts must NOT change clientHash or hash
    fs.mkdirSync(path.join(pcRoot, "src", "web-bundle", "assets"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(pcRoot, "src", "web-bundle", "index.html"),
      "<html>staged</html>\n",
    );
    fs.writeFileSync(
      path.join(appSrc, "routeTree.gen.ts"),
      "export const gen = 999;\n",
    );
    const withBundle = fp.compute(pcRoot);
    assert.equal(withBundle.hash, base.hash);
    assert.equal(withBundle.clientHash, base.clientHash);

    // Changing actual app source MUST change clientHash while keeping shell hash identical
    fs.writeFileSync(
      path.join(appSrc, "routes", "index.tsx"),
      "export const r = 2;\n",
    );
    const afterAppEdit = fp.compute(pcRoot);
    assert.equal(afterAppEdit.hash, base.hash);
    assert.notEqual(afterAppEdit.clientHash, base.clientHash);
  });
});
