import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const conflict = () =>
  new Error("Another Host still owns this account runtime home.");

/** Kernel ownership expires with the process, independently of copied PID files or PID reuse. */
export async function acquireHostLease(home, onLost) {
  const canonical = await realpath(home);
  if (process.platform === "win32") {
    // A fixed-length kernel object name for the canonical directory, not a content checksum.
    const identity = createHash("sha256")
      .update(canonical.toLowerCase())
      .digest("hex");
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", (error) =>
        reject(error.code === "EADDRINUSE" ? conflict() : error),
      );
      server.listen(`\\\\.\\pipe\\chisabot-dsh-home-${identity}`, resolve);
    });
    server.unref();
    return () => new Promise((resolve) => server.close(resolve));
  }
  // flock owns the file descriptor; the helper exits when the Host's pipe closes, including
  // SIGKILL/container exit. The lock file stays in place and never needs stale-file deletion.
  const child = spawn(
    "flock",
    [
      "--nonblock",
      "--conflict-exit-code",
      "73",
      "--no-fork",
      `${canonical}/host.lock`,
      process.execPath,
      fileURLToPath(new URL("./lease-holder.mjs", import.meta.url)),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let released = false;
  let ready = false;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!ready)
        reject(
          code === 73
            ? conflict()
            : new Error(
                `Runtime ownership helper exited before acquiring the lock (${code}).`,
              ),
        );
      else if (!released) onLost();
    });
    child.stdout.once("data", (value) => {
      if (value.toString().trim() !== "locked") {
        reject(new Error("Invalid runtime ownership handshake."));
        child.stdin.end();
        return;
      }
      ready = true;
      resolve();
    });
  });
  child.unref();
  child.stdin.unref();
  child.stdout.unref();
  child.stderr.unref();
  return async () => {
    released = true;
    child.stdin.end();
    await exited;
  };
}
