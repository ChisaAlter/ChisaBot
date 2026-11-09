import { spawn } from "node:child_process";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DshHostClient } from "../../../runtime/dsh/src/client.mjs";
import type { DshRuntimeTarget } from "../agents/dsh-runtime";

/** One persistent Host home per account. Model credentials arrive only with an authenticated run. */
export function createManagedDshRuntimes(options: {
  root: string;
  gatewayUrl: string;
  node?: string;
}) {
  const pending = new Map<string, Promise<DshRuntimeTarget>>();
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../runtime/dsh/src/start.mjs",
  );
  async function check(connectionFile: string, ownerUserId: string) {
    let client: DshHostClient | undefined;
    try {
      const connection = JSON.parse(await readFile(connectionFile, "utf8"));
      client = await DshHostClient.connect(connection.endpoint, {
        signal: AbortSignal.timeout(2000),
      });
      const health = await client.health(AbortSignal.timeout(2000));
      if (health.ownerUserId !== ownerUserId || health.protocol !== 1)
        throw new Error("Managed DSH runtime identity mismatch.");
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Managed DSH runtime identity mismatch."
      )
        throw error;
      return false;
    } finally {
      await client?.close();
    }
  }
  async function start(ownerUserId: string): Promise<DshRuntimeTarget> {
    const folder = Buffer.from(ownerUserId, "utf8").toString("base64url");
    const home = resolve(options.root, folder);
    const connectionFile = join(home, "connection.json");
    const target = { id: `managed:${folder}`, ownerUserId, connectionFile };
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (await check(connectionFile, ownerUserId)) return target;
    await writeFile(
      join(home, "chisabot.json"),
      JSON.stringify({
        ownerUserId,
        port: 0,
        providers: {},
        gatewayUrl: options.gatewayUrl,
      }),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = { CHISABOT_DSH_HOME: home };
    for (const key of [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "HOME",
      "USERPROFILE",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
    ]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    // Runtime lifetime outlives a web-server observer. The private home/token is the reconnect path.
    const log = await open(join(home, "host.log"), "a", 0o600);
    const child = spawn(options.node ?? "node", [source], {
      cwd: home,
      env: environment,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    await log.close();
    let error: Error | undefined;
    child.once("error", (value) => {
      error = value;
    });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (error) throw error;
      if (child.exitCode !== null)
        throw new Error(`DSH Host exited during startup (${child.exitCode}).`);
      if (await check(connectionFile, ownerUserId)) return target;
      await delay(250);
    }
    child.kill();
    throw new Error("DSH Host did not become ready within 30 seconds.");
  }
  return {
    targetFor(ownerUserId: string) {
      if (!ownerUserId || ownerUserId.length > 256)
        return Promise.reject(new Error("Invalid runtime owner."));
      let task = pending.get(ownerUserId);
      if (!task) {
        task = start(ownerUserId).finally(() => pending.delete(ownerUserId));
        pending.set(ownerUserId, task);
      }
      return task;
    },
  };
}
