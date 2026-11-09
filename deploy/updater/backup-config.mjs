// Archive only explicitly configured paths; paths are argv data, never interpolated shell source.
import { execFile } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const [destination, compose, extraText = "[]", mode] = process.argv.slice(2);
const extra = JSON.parse(extraText);
if (
  !destination ||
  !compose ||
  !Array.isArray(extra) ||
  extra.some((path) => typeof path !== "string" || !isAbsolute(path))
)
  throw new Error("Backup config paths must be absolute");
const targets = [...new Set([compose, ...extra])];
const root = await realpath(destination);
const records = [];
const within = (child, parent) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
};
const paths = [];
for (const path of targets) {
  const absolute = await realpath(path);
  if (
    ["/", "/opt", "/var", "/var/lib", "/etc", "/home", "/root"].includes(
      absolute,
    ) ||
    within(root, absolute)
  )
    throw new Error("Use a specific config path outside the backup tree");
  const info = await stat(absolute);
  if (!info.isDirectory() && !info.isFile())
    throw new Error("Config target is not a file or directory");
  paths.push({ path, absolute, directory: info.isDirectory() });
}
const containers = JSON.parse(
  await readFile(join(root, "containers.json"), "utf8"),
);
let targetsDirectory;
try {
  targetsDirectory = JSON.parse(
    await readFile(join(root, "dsh-accounts.json"), "utf8"),
  ).apiTargetsDirectory;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const container of containers)
  for (const mount of container.Mounts ?? []) {
    if (
      mount.Type !== "bind" ||
      mount.Destination === "/auth-data" ||
      mount.Destination === targetsDirectory ||
      [
        "/var/lib/chisabot-updater/requests",
        "/var/lib/chisabot-updater/state",
      ].includes(mount.Destination)
    )
      continue;
    const source = await realpath(mount.Source);
    if (
      !paths.some(
        (p) =>
          source === p.absolute || (p.directory && within(source, p.absolute)),
      )
    ) {
      throw new Error(
        `Add the configuration mount ${mount.Destination} to CHISABOT_BACKUP_EXTRA_PATHS`,
      );
    }
  }
if (mode === "--check") process.exit(0);
for (const [index, target] of paths.entries()) {
  const { path, absolute } = target;
  const archive = `deployment-${index}.tgz`;
  await execute("tar", [
    "-czf",
    join(root, archive),
    "-C",
    dirname(absolute),
    "--",
    basename(absolute),
  ]);
  records.push({ originalPath: resolve(path), archive });
}
await writeFile(
  join(root, "paths.json"),
  `${JSON.stringify(records, null, 2)}\n`,
  { mode: 0o600 },
);
