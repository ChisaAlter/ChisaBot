import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { acquireHostLease } from "./host-lease.mjs";
import { hostProfile } from "./profile.mjs";

const require = createRequire(import.meta.url);
const source = dirname(fileURLToPath(import.meta.url));
const homeValue = process.env.CHISABOT_DSH_HOME;
if (!homeValue)
  throw new Error(
    "CHISABOT_DSH_HOME must name a dedicated account runtime directory.",
  );
const home = resolve(homeValue);
await mkdir(home, { recursive: true, mode: 0o700 });
await acquireHostLease(home, () => {
  console.error(
    "DSH runtime lost its home lease; stopping to preserve single ownership.",
  );
  process.exit(1);
});
// A Host started by the previous PID-only launcher has no kernel lease. Its authenticated
// connection proves ownership during an in-place upgrade; a copied PID cannot do that.
let priorConnection;
try {
  priorConnection = JSON.parse(
    await readFile(join(home, "connection.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (priorConnection) {
  const { DshHostClient } = await import("./client.mjs");
  let previous;
  try {
    previous = await DshHostClient.connect(priorConnection.endpoint, {
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    /* An unreachable prior generation owns no live Host. */
  }
  if (previous) {
    await previous.close();
    throw new Error("Another Host still owns this account runtime home.");
  }
}
const lockPath = join(home, "host.pid");
await writeFile(lockPath, String(process.pid), { mode: 0o600 });
process.on("exit", () => {
  try {
    if (readFileSync(lockPath, "utf8") === String(process.pid))
      unlinkSync(lockPath);
  } catch {
    /* Diagnostic only; kernel lease owns exclusion. */
  }
});
const options = JSON.parse(
  await readFile(
    process.env.CHISABOT_DSH_CONFIG ?? join(home, "chisabot.json"),
    "utf8",
  ),
);
if (
  typeof options.ownerUserId !== "string" ||
  !options.ownerUserId ||
  !options.providers ||
  typeof options.providers !== "object"
) {
  throw new Error("Runtime configuration requires ownerUserId and providers.");
}
const profile = join(home, "profiles", "chisabot");
await mkdir(profile, { recursive: true, mode: 0o700 });
await mkdir(join(home, "workspace"), { recursive: true, mode: 0o700 });
const manifestPath = join(profile, "package.json");
let old;
try {
  old = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (old && old.name !== "@chisabot/runtime-profile")
  throw new Error("The chisabot profile is owned by another application.");
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      name: "@chisabot/runtime-profile",
      private: true,
      dsh: { profile: { bundles: [] } },
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await writeFile(
  join(profile, "cordis.patch.yml"),
  stringify(
    hostProfile(
      home,
      options,
      join(source, "plugin.mjs").replaceAll("\\", "/"),
    ),
  ),
  { mode: 0o600 },
);

const bin = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "lib",
  "bin.js",
);
process.env.DSH_HOME = home;
process.env.DO_NOT_TRACK = "1";
process.chdir(join(home, "workspace"));
process.argv = [
  process.execPath,
  bin,
  "--profile",
  "chisabot",
  ...process.argv.slice(2),
];
// Stay in the same process so service stop and Windows process teardown own the actual Host.
const { runCli } = await import(pathToFileURL(bin).href);
await runCli();
