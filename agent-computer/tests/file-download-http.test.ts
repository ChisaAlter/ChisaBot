import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_LIMITS } from "../src/workspace";

const asked = process.env.CHISABOT_FILE_DOWNLOAD_HTTP === "1";
const TOKEN = "file-download-http-test-token";
const BOT = "file-download-http";

let root = "";
let base = "";
let child: ReturnType<typeof Bun.spawn> | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("The port probe did not return a TCP address."));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function api(path: string, authenticated = true) {
  return fetch(`${base}${path}`, {
    headers: authenticated
      ? {
          "x-chisabot-bot-id": BOT,
          "x-chisabot-computer-token": TOKEN,
        }
      : {},
  });
}

beforeAll(async () => {
  if (!asked) return;
  root = await mkdtemp(join(tmpdir(), "file-download-http-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "folder"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      COMPUTER_TOKEN: TOKEN,
      COMPUTER_BROWSER_BACKEND: "managed",
      COMPUTER_BROWSER_MODE: "headless",
      PORT: String(port),
      PROFILES_DIR: join(root, "profiles"),
      WORKSPACE_DIR: workspace,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const end = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`Computer fixture exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (Date.now() > end)
      throw new Error("Timed out waiting for the computer fixture.");
    await Bun.sleep(10);
  }
});

afterAll(async () => {
  if (!asked) return;
  child?.kill();
  if (child) await child.exited;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!asked)("the computer file download endpoint", () => {
  test("public health never reads or rewrites a bot's control state", async () => {
    const directory = join(root, "profiles", ".control");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "probe-bot.json");
    await writeFile(file, "invalid control state");
    const response = await fetch(`${base}/health`, {
      headers: { "x-chisabot-bot-id": "probe-bot" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("profile");
    expect(body).not.toHaveProperty("identity");
    expect(await readFile(file, "utf8")).toBe("invalid control state");

    const trusted = await api("/health");
    expect(trusted.status).toBe(200);
    expect(await trusted.json()).toMatchObject({
      profile: { botId: BOT },
      identity: null,
    });
  });

  test("binary writes obey human control and resume after handback", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "x-chisabot-computer-token": TOKEN,
          "x-chisabot-bot-id": BOT,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const waiting = await (
      await post("/control/request", { reason: "Human upload review" })
    ).json();
    const requestId = waiting.request.id;
    expect((await post("/control/take", { requestId })).status).toBe(200);
    const upload = {
      path: "human-guard.txt",
      base64: Buffer.from("uploaded").toString("base64"),
    };
    expect((await post("/files/write-bytes", upload)).status).toBe(409);
    expect(await Bun.file(join(root, "workspace", upload.path)).exists()).toBe(
      false,
    );
    expect((await post("/control/release", { requestId })).status).toBe(200);
    expect((await post("/files/write-bytes", upload)).status).toBe(200);
    expect(await readFile(join(root, "workspace", upload.path), "utf8")).toBe(
      "uploaded",
    );
  });

  test("streams binary bytes and safe attachment headers", async () => {
    const payload = Buffer.alloc(70_000);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }
    await mkdir(join(root, "workspace", "reports"), { recursive: true });
    await writeFile(join(root, "workspace", "reports", "data.bin"), payload);

    const response = await api(
      `/files/download?path=${encodeURIComponent("reports/data.bin")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe(String(payload.length));
    expect(response.headers.get("content-disposition")).toContain(
      'filename="data.bin"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(payload)).toBeTrue();
  });

  test("refuses unauthenticated downloads", async () => {
    const response = await api("/files/download?path=anything.bin", false);
    expect(response.status).toBe(401);
  });

  test.each([
    ["a missing file", "missing.bin", 404],
    ["a directory", "folder", 400],
    ["parent traversal", "../outside.txt", 403],
    ["an absolute path", "/etc/passwd", 403],
  ])("refuses %s with %i", async (_name, path, expected) => {
    const response = await api(
      `/files/download?path=${encodeURIComponent(path)}`,
    );
    expect(response.status).toBe(expected);
  });

  test("refuses a symlink escape with 403", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "private");
    await symlink(outside, join(root, "workspace", "leak.bin"));

    const response = await api("/files/download?path=leak.bin");
    expect(response.status).toBe(403);
  });

  test("refuses a file above the cap with 413", async () => {
    const oversized = join(root, "workspace", "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, DEFAULT_WORKSPACE_LIMITS.downloadBytes + 1);

    const response = await api("/files/download?path=oversized.bin");
    expect(response.status).toBe(413);
  });

  test("neutralises CRLF in the filename header", async () => {
    await writeFile(
      join(root, "workspace", "evil\r\nX-Injected: yes.txt"),
      "safe",
    );
    const response = await api(
      `/files/download?path=${encodeURIComponent("evil\r\nX-Injected: yes.txt")}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(response.headers.get("x-injected")).toBeNull();
  });
});
