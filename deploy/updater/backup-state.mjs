import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "backup-manifest.json";
const OWNER = "chisabot-updater";
const SCHEMA = 1;

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function manifest(path) {
  try {
    if (
      !(await lstat(path)).isDirectory() ||
      (await lstat(path)).isSymbolicLink()
    )
      return null;
    const file = join(path, MARKER);
    if ((await lstat(file)).isSymbolicLink()) return null;
    const data = JSON.parse(await readFile(file, "utf8"));
    if (
      data.owner !== OWNER ||
      data.schema !== SCHEMA ||
      !["update", "full"].includes(data.kind) ||
      !Number.isFinite(Date.parse(data.createdAt))
    )
      return null;
    return data;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(error.code) ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}

export async function beginBackup(path, kind) {
  if (!["update", "full"].includes(kind))
    throw new Error("Unknown backup kind");
  if (
    !(await lstat(path)).isDirectory() ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new Error("Backup must be a directory");
  const data = {
    owner: OWNER,
    schema: SCHEMA,
    kind,
    state: "pending",
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(path, MARKER), `${JSON.stringify(data, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return data;
}

export async function completeBackup(path, metadata = {}) {
  const current = await manifest(path);
  if (current?.state !== "pending")
    throw new Error("Only this updater pending backup can complete");
  const artifacts = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === MARKER || entry.name.startsWith(`${MARKER}.tmp`))
        continue;
      const name = prefix + entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Backup artifacts cannot be symlinks");
      if (entry.isDirectory())
        await walk(join(directory, entry.name), `${name}/`);
      else if (entry.isFile()) {
        const file = await stat(join(directory, entry.name));
        if (file.size === 0) throw new Error(`Empty backup artifact: ${name}`);
        artifacts.push({ name, bytes: file.size });
      }
    }
  }
  await walk(path);
  if (!artifacts.length) throw new Error("Backup contains no artifacts");
  const data = {
    ...current,
    ...metadata,
    owner: OWNER,
    schema: SCHEMA,
    kind: current.kind,
    state: "complete",
    createdAt: current.createdAt,
    completedAt: new Date().toISOString(),
    artifacts,
  };
  await atomicJson(join(path, MARKER), data);
  return data;
}

async function completed(root, kind) {
  const base = await realpath(root);
  const entries = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(base, entry.name);
    const data = await manifest(path);
    if (data?.kind !== kind || data.state !== "complete") continue;
    entries.push({ path, data });
  }
  return entries.sort(
    (a, b) => Date.parse(b.data.createdAt) - Date.parse(a.data.createdAt),
  );
}

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function weekKey(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Only marked, complete batches are eligible. Unknown/manual/partial/symlink entries always survive. */
export async function pruneBackups(root, kind, keep, weekly = 4) {
  count(keep, "Retention");
  if (kind === "full") count(weekly, "Weekly retention");
  const entries = await completed(root, kind);
  const retained = new Set(
    kind === "full" ? [] : entries.slice(0, keep).map((e) => e.path),
  );
  if (kind === "full") {
    const days = new Set(),
      weeks = new Set();
    for (const entry of entries) {
      const day = entry.data.createdAt.slice(0, 10);
      if (days.size < keep && !days.has(day)) {
        retained.add(entry.path);
        days.add(day);
      }
      const week = weekKey(entry.data.createdAt);
      if (weeks.size < weekly && !weeks.has(week)) {
        retained.add(entry.path);
        weeks.add(week);
      }
    }
  }
  const base = await realpath(root),
    removed = [];
  for (const entry of entries) {
    if (retained.has(entry.path)) continue;
    try {
      await lstat(join(entry.path, ".keep"));
      continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Re-read ownership and resolved boundary immediately before recursive removal.
    const current = await manifest(entry.path);
    if (!current || current.kind !== kind || current.state !== "complete")
      continue;
    if (dirname(await realpath(entry.path)) !== base)
      throw new Error("Backup deletion escaped its root");
    await rm(entry.path, { recursive: true });
    removed.push(entry.path);
  }
  return { removed: removed.length, retained: entries.length - removed.length };
}

export async function backupStatus(
  root,
  maxAgeHours = 30,
  requireOffsite = false,
  now = Date.now(),
) {
  count(maxAgeHours, "Maximum age");
  let entries;
  try {
    entries = await completed(root, "full");
  } catch (error) {
    if (error.code === "ENOENT")
      return { ok: false, local: "missing", offsite: "missing" };
    throw error;
  }
  const latest = entries[0];
  if (!latest) return { ok: false, local: "missing", offsite: "missing" };
  const artifacts = Array.isArray(latest.data.artifacts)
    ? latest.data.artifacts
    : [];
  let filesValid = artifacts.length > 0;
  for (const item of artifacts) {
    const target = resolve(latest.path, item.name);
    if (
      !target.startsWith(`${latest.path}/`) &&
      !target.startsWith(`${latest.path}\\`)
    ) {
      filesValid = false;
      break;
    }
    try {
      const file = await lstat(target);
      if (!file.isFile() || file.isSymbolicLink() || file.size !== item.bytes)
        filesValid = false;
    } catch {
      filesValid = false;
    }
  }
  const ageHours = Math.max(
    0,
    (now - Date.parse(latest.data.completedAt)) / 3_600_000,
  );
  const local = !filesValid
    ? "incomplete"
    : !Number.isFinite(ageHours) || ageHours > maxAgeHours
      ? "stale"
      : "ready";
  let offsite = "missing";
  try {
    const receipt = JSON.parse(
      await readFile(join(latest.path, "offsite-receipt.json"), "utf8"),
    );
    if (
      receipt.transport === "restic" &&
      /^[a-f0-9]{8,64}$/.test(receipt.snapshotId)
    )
      offsite = local === "ready" ? "ready" : "stale";
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return {
    ok: local === "ready" && (!requireOffsite || offsite === "ready"),
    local,
    offsite,
    createdAt: latest.data.createdAt,
    completedAt: latest.data.completedAt,
    ageHours: Number(ageHours.toFixed(2)),
    artifacts: artifacts.length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, root, ...args] = process.argv.slice(2);
  if (!root) throw new Error("A backup directory is required");
  if (command === "begin") await beginBackup(root, args[0]);
  else if (command === "complete") {
    const metadata = args[0] ? JSON.parse(await readFile(args[0], "utf8")) : {};
    const result = await completeBackup(root, metadata);
    console.log(
      JSON.stringify({
        status: result.state,
        kind: result.kind,
        artifacts: result.artifacts.length,
      }),
    );
  } else if (command === "prune")
    console.log(
      JSON.stringify(
        await pruneBackups(
          root,
          args[0],
          Number(args[1]),
          Number(args[2] ?? 4),
        ),
      ),
    );
  else if (command === "status") {
    const result = await backupStatus(
      root,
      Number(args[0] ?? 30),
      args.includes("--require-offsite"),
    );
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "offsite-receipt") {
    const lines = (await readFile(args[0], "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = lines.findLast(
      (line) => line.message_type === "summary" && line.snapshot_id,
    );
    if (!summary || !/^[a-f0-9]{8,64}$/.test(summary.snapshot_id))
      throw new Error("Restic returned no snapshot receipt");
    await atomicJson(join(root, "offsite-receipt.json"), {
      transport: "restic",
      snapshotId: summary.snapshot_id,
      completedAt: new Date().toISOString(),
    });
  } else
    throw new Error("Expected begin|complete|prune|status|offsite-receipt");
}
