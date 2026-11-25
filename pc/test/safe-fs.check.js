"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  isTransientRenameError,
  renameWithRetry,
  renameWithRetrySync,
  createPathLockQueue,
  readFileNoFollow,
  writeFileAtomicSafe,
  hardenFilePermissions,
  hardenFilePermissionsSync,
} = require("../src/safe-fs");
const { createConfig } = require("../src/config");
const { atomicChunkedDownload } = require("../src/atomic-download");
const {
  createSubagentBridge,
} = require("../src/agent-runtime/subagent-bridge");

async function withTempDirAsync(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeErr(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

test("isTransientRenameError identifies Windows transient lock codes", () => {
  assert.equal(isTransientRenameError(makeErr("EPERM")), true);
  assert.equal(isTransientRenameError(makeErr("EBUSY")), true);
  assert.equal(isTransientRenameError(makeErr("EACCES")), true);
  assert.equal(isTransientRenameError(makeErr("ENOENT")), false);
  assert.equal(isTransientRenameError(null), false);
});

test("renameWithRetry retries transient lock errors with backoff and stops on non-transient errors", async () => {
  let attempts = 0;
  const delays = [];
  await renameWithRetry("a.tmp", "a.txt", {
    retries: 4,
    baseDelayMs: 5,
    maxDelayMs: 15,
    factor: 2,
    sleepFn: async (ms) => {
      delays.push(ms);
    },
    renameFn: async () => {
      attempts += 1;
      if (attempts === 1) throw makeErr("EBUSY");
      if (attempts === 2) throw makeErr("EPERM");
      if (attempts === 3) throw makeErr("EACCES");
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [5, 10, 15]);

  let nonTransientAttempts = 0;
  await assert.rejects(
    renameWithRetry("a.tmp", "a.txt", {
      retries: 3,
      renameFn: async () => {
        nonTransientAttempts += 1;
        throw makeErr("ENOENT");
      },
    }),
    (err) => err.code === "ENOENT",
  );
  assert.equal(nonTransientAttempts, 1);

  await assert.rejects(
    renameWithRetry("a.tmp", "a.txt", {
      retries: 2,
      baseDelayMs: 1,
      sleepFn: async () => {},
      renameFn: async () => {
        throw makeErr("EBUSY");
      },
    }),
    (err) => err.code === "EBUSY",
  );
});

test("renameWithRetrySync retries transient lock errors synchronously", () => {
  let attempts = 0;
  const delays = [];
  renameWithRetrySync("a.tmp", "a.txt", {
    retries: 3,
    baseDelayMs: 2,
    maxDelayMs: 10,
    sleepSyncFn: (ms) => delays.push(ms),
    renameSyncFn: () => {
      attempts += 1;
      if (attempts < 3) throw makeErr("EPERM");
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2, 4]);
});

test("createPathLockQueue serializes same path with platform case rules and avoids multi-file deadlocks", async () => {
  const winQueue = createPathLockQueue("win32");
  const events = [];
  await Promise.all([
    winQueue.run("C:\\Work\\Sub\\File.txt", async () => {
      events.push("1:start");
      await new Promise((r) => setTimeout(r, 25));
      events.push("1:end");
    }),
    winQueue.run("c:\\work\\sub\\file.txt", async () => {
      events.push("2:start");
      events.push("2:end");
    }),
  ]);
  assert.deepEqual(events, ["1:start", "1:end", "2:start", "2:end"]);
  assert.equal(winQueue.size(), 0);

  // Earlier failure must release the lock for the next task.
  await assert.rejects(
    winQueue.run("C:\\Work\\err.txt", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const after = await winQueue.run("c:\\work\\ERR.txt", async () => "ok");
  assert.equal(after, "ok");
  assert.equal(winQueue.size(), 0);

  // runMany orders lock keys deterministically so [A, B] and [B, A] never deadlock.
  const order = [];
  await Promise.all([
    winQueue.runMany(["C:\\Work\\a.txt", "C:\\Work\\b.txt"], async () => {
      order.push("first:start");
      await new Promise((r) => setTimeout(r, 15));
      order.push("first:end");
    }),
    winQueue.runMany(["c:\\work\\B.TXT", "c:\\work\\A.TXT"], async () => {
      order.push("second:start");
      order.push("second:end");
    }),
  ]);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
  assert.equal(winQueue.size(), 0);
});

test("readFileNoFollow reads regular files, enforces maxBytes, and rejects symlinks and outside roots", async () => {
  await withTempDirAsync("cb-saferead-", async (dir) => {
    const allowed = path.join(dir, "allowed");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    const normal = path.join(allowed, "hello.txt");
    fs.writeFileSync(normal, "abcdef0123456789");

    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "top-secret");

    const full = await readFileNoFollow(normal, { allowedRoots: [allowed] });
    assert.equal(full.buffer.toString("utf8"), "abcdef0123456789");
    assert.equal(full.truncated, false);
    assert.equal(full.size, 16);

    const capped = await readFileNoFollow(normal, {
      maxBytes: 6,
      allowedRoots: [allowed],
    });
    assert.equal(capped.buffer.toString("utf8"), "abcdef");
    assert.equal(capped.truncated, true);
    assert.equal(capped.size, 16);

    await assert.rejects(
      readFileNoFollow(secret, { allowedRoots: [allowed] }),
      (err) => err.code === "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );

    const linkPath = path.join(allowed, "link-file");
    let linkCreated = false;
    try {
      fs.symlinkSync(normal, linkPath, "file");
      linkCreated = true;
    } catch {
      // Windows without Developer Mode may forbid file symlinks; test directory junction below as well.
    }
    if (linkCreated) {
      await assert.rejects(
        readFileNoFollow(linkPath, { allowedRoots: [allowed] }),
        (err) => err.code === "ELOOP",
      );
    }

    const dirLink = path.join(allowed, "dir-escape");
    fs.symlinkSync(
      outside,
      dirLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      readFileNoFollow(path.join(dirLink, "secret.txt"), {
        allowedRoots: [allowed],
      }),
      (err) => err.code === "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );
  });
});

test("writeFileAtomicSafe validates allowedRoots, expectedStat, symlinks, concurrency, and cleans temp files", async () => {
  await withTempDirAsync("cb-safewrite-", async (dir) => {
    const allowed = path.join(dir, "allowed");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    const target = path.join(allowed, "data.txt");
    const initial = await writeFileAtomicSafe(target, "v1", {
      allowedRoots: [allowed],
      mustNotExist: true,
    });
    assert.equal(fs.readFileSync(target, "utf8"), "v1");

    // mustNotExist rejects existing file.
    await assert.rejects(
      writeFileAtomicSafe(target, "v2", {
        allowedRoots: [allowed],
        mustNotExist: true,
      }),
      (err) => err.code === "EEXIST",
    );

    // expectedStat catches external modification before overwrite.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(target, "external-edit");
    await assert.rejects(
      writeFileAtomicSafe(target, "stale-overwrite", {
        allowedRoots: [allowed],
        expectedStat: initial.stat,
      }),
      (err) => err.code === "ERR_SAFE_FS_TOCTOU",
    );
    assert.equal(fs.readFileSync(target, "utf8"), "external-edit");

    // Parent symlink escaping allowedRoots is rejected.
    const escapeDir = path.join(allowed, "escape");
    fs.symlinkSync(
      outside,
      escapeDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      writeFileAtomicSafe(path.join(escapeDir, "pwn.txt"), "bad", {
        allowedRoots: [allowed],
      }),
      (err) => err.code === "ERR_SAFE_FS_OUTSIDE_ROOTS",
    );
    assert.equal(fs.existsSync(path.join(outside, "pwn.txt")), false);

    // Failed rename cleans up temporary .tmp files in finally.
    await assert.rejects(
      writeFileAtomicSafe(target, "fail-rename", {
        allowedRoots: [allowed],
        renameOpts: {
          retries: 0,
          renameFn: async () => {
            throw makeErr("EIO");
          },
        },
      }),
      (err) => err.code === "EIO",
    );
    const leftovers = fs
      .readdirSync(allowed)
      .filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);

    // Concurrent writes on same path serialize cleanly with no tmp residue.
    await Promise.all(
      Array.from({ length: 8 }, (_, idx) =>
        writeFileAtomicSafe(target, `payload-${idx}`, {
          allowedRoots: [allowed],
        }),
      ),
    );
    const finalText = fs.readFileSync(target, "utf8");
    assert.match(finalText, /^payload-\d$/);
    assert.deepEqual(
      fs.readdirSync(allowed).filter((name) => name.includes(".tmp")),
      [],
    );
  });
});

test("hardenFilePermissions handles win32 skip, missing files, and POSIX 0600 hardening", async () => {
  await withTempDirAsync("cb-harden-", async (dir) => {
    const file = path.join(dir, "secret.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });

    const winRes = await hardenFilePermissions(file, 0o600, {
      platform: "win32",
    });
    assert.equal(winRes.skipped, "win32");

    const missingSync = hardenFilePermissionsSync(
      path.join(dir, "missing.json"),
      0o600,
      { platform: "linux" },
    );
    assert.equal(missingSync.skipped, "missing");

    if (process.platform !== "win32") {
      const res = await hardenFilePermissions(file, 0o600);
      assert.equal(res.hardened, true);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);

      const link = path.join(dir, "link.json");
      fs.symlinkSync(file, link);
      const linkRes = hardenFilePermissionsSync(link, 0o644);
      assert.equal(linkRes.skipped, "symlink");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  });
});

test("config.js excludes Linux basic_text for new tokens while preserving legacy decryption and plain fallback", async () => {
  await withTempDirAsync("cb-config-sec-", async (dir) => {
    // 1. Seed a legacy encrypted token first (simulating prior basic_text storage).
    const legacyStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`legacy:${s}`, "utf8"),
      decryptString: (b) => b.toString("utf8").replace(/^legacy:/, ""),
    };
    const seedCfg = createConfig({ dir, safeStorage: legacyStorage });
    seedCfg.setToken("tok_legacy");
    assert.equal(seedCfg.tokenProtected(), true);

    // 2. Reload under basic_text backend: encryptionAvailable() is false, encryptionBackend() is "basic_text".
    const basicTextStorage = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: (s) => Buffer.from(`legacy:${s}`, "utf8"),
      decryptString: (b) => b.toString("utf8").replace(/^legacy:/, ""),
    };
    const cfg = createConfig({ dir, safeStorage: basicTextStorage });
    assert.equal(cfg.encryptionAvailable(), false);
    assert.equal(cfg.encryptionBackend(), "basic_text");
    assert.equal(cfg.getToken(), "tok_legacy");

    // 3. New setToken under basic_text refuses weak encryption and falls back to tokenPlain.
    cfg.setToken("tok_new_plain");
    assert.equal(cfg.tokenProtected(), false);
    assert.equal(cfg.get().tokenEnc, "");
    assert.equal(cfg.get().tokenPlain, "tok_new_plain");
    assert.equal(cfg.getToken(), "tok_new_plain");

    // 4. Audit append + flush works and leaves no temp residue.
    cfg.appendAudit({ ts: 1, op: "test_op" });
    await cfg.flushAudit();
    assert.equal(cfg.readAudit(5).length, 1);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    );
  });
});

test("config.js securityAudit and hardenPermissions inspect and converge dir/config/audit permissions", async () => {
  await withTempDirAsync("cb-config-audit-", async (dir) => {
    const dpapiLikeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
      decryptString: (b) => b.toString("utf8").replace(/^enc:/, ""),
    };
    const cfg = createConfig({ dir, safeStorage: dpapiLikeStorage });

    // Before writing config/audit, missing files report exists=false, secure=true.
    const initialAudit = await cfg.securityAudit();
    assert.equal(initialAudit.platform, process.platform);
    assert.equal(initialAudit.tokenProtected, false);
    assert.equal(
      initialAudit.encryptionBackend,
      process.platform === "win32"
        ? "dpapi"
        : process.platform === "darwin"
          ? "keychain"
          : "keyring",
    );
    assert.deepEqual(
      initialAudit.files.map((f) => ({
        name: f.name,
        exists: f.exists,
        secure: f.secure,
        isSymlink: f.isSymlink,
      })),
      [
        { name: "config.json", exists: false, secure: true, isSymlink: false },
        { name: "audit.jsonl", exists: false, secure: true, isSymlink: false },
      ],
    );

    // Write token + audit entry so both files exist.
    cfg.setToken("tok_audit_test");
    cfg.appendAudit({ ts: 2, op: "audit_check" });
    await cfg.flushAudit();

    const winAudit = await cfg.securityAudit({ platform: "win32" });
    assert.equal(winAudit.platform, "win32");
    assert.equal(winAudit.tokenProtected, true);
    assert.equal(winAudit.files.length, 2);
    for (const fileInfo of winAudit.files) {
      assert.equal(fileInfo.exists, true);
      assert.equal(fileInfo.isSymlink, false);
      assert.equal(fileInfo.secure, true);
      assert.equal(typeof fileInfo.mode, "number");
    }

    const hardenedWin = await cfg.hardenPermissions({ platform: "win32" });
    assert.equal(hardenedWin.tokenProtected, true);
    assert.equal(
      hardenedWin.files.every((f) => f.secure),
      true,
    );

    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(path.join(dir, "config.json"), 0o644);
      fs.chmodSync(path.join(dir, "audit.jsonl"), 0o644);

      const weakAudit = await cfg.securityAudit({ platform: "linux" });
      assert.equal(weakAudit.files[0].mode, 0o644);
      assert.equal(weakAudit.files[0].secure, false);
      assert.equal(weakAudit.files[1].mode, 0o644);
      assert.equal(weakAudit.files[1].secure, false);

      const fixedAudit = await cfg.hardenPermissions({ platform: "linux" });
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fixedAudit.files[0].mode, 0o600);
      assert.equal(fixedAudit.files[0].secure, true);
      assert.equal(fixedAudit.files[1].mode, 0o600);
      assert.equal(fixedAudit.files[1].secure, true);
    }
  });
});

test("atomicChunkedDownload retries transient rename errors and cleans temp files on failure", async () => {
  await withTempDirAsync("cb-dl-retry-", async (dir) => {
    const dest = path.join(dir, "bundle.bin");
    const payload = Buffer.from("atomic-download-payload");
    const expectedSha256 = crypto
      .createHash("sha256")
      .update(payload)
      .digest("hex");

    let renameAttempts = 0;
    const ok = await atomicChunkedDownload({
      destPath: dest,
      totalSize: payload.length,
      allowedRoots: [dir],
      expectedSha256,
      readChunk: async ({ offset, length }) =>
        payload.subarray(offset, offset + length),
      renameOpts: {
        retries: 3,
        baseDelayMs: 1,
        sleepFn: async () => {},
        renameFn: async (from, to) => {
          renameAttempts += 1;
          if (renameAttempts < 3) throw makeErr("EBUSY");
          await fs.promises.rename(from, to);
        },
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(renameAttempts, 3);
    assert.equal(fs.readFileSync(dest, "utf8"), payload.toString("utf8"));

    // Unrecoverable rename failure still removes .tmp file in finally.
    await assert.rejects(
      atomicChunkedDownload({
        destPath: path.join(dir, "fail.bin"),
        totalSize: payload.length,
        allowedRoots: [dir],
        readChunk: async ({ offset, length }) =>
          payload.subarray(offset, offset + length),
        renameOpts: {
          retries: 1,
          baseDelayMs: 1,
          sleepFn: async () => {},
          renameFn: async () => {
            throw makeErr("EPERM");
          },
        },
      }),
      (err) => err.code === "EPERM",
    );
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    );
  });
});

test("subagent-bridge rejects any request carrying Origin header with 403 JSON", async () => {
  let subcalls = 0;
  const bridge = await createSubagentBridge({
    taskId: "t-origin",
    depth: 0,
    maxDepth: 2,
    onSubcall: async (action) => {
      subcalls += 1;
      return { action };
    },
  });
  assert.ok(bridge);

  const postJson = (headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        bridge.url,
        { method: "POST", headers },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  try {
    const evil = await postJson(
      {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
        origin: "https://evil.example.com",
      },
      { action: "list", params: {} },
    );
    assert.equal(evil.status, 403);
    assert.equal(evil.json.ok, false);
    assert.match(evil.json.error, /Origin/i);
    assert.equal(subcalls, 0);

    const nullOrigin = await postJson(
      {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
        origin: "null",
      },
      { action: "list", params: {} },
    );
    assert.equal(nullOrigin.status, 403);
    assert.equal(nullOrigin.json.ok, false);
    assert.equal(subcalls, 0);

    const valid = await postJson(
      {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.token}`,
      },
      { action: "list", params: {} },
    );
    assert.equal(valid.status, 200);
    assert.equal(valid.json.ok, true);
    assert.deepEqual(valid.json.data, { action: "list" });
    assert.equal(subcalls, 1);
  } finally {
    await bridge.close();
  }
});
