import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// One current incident, not another notification queue. The product outbox owns delivery.
const file = process.argv[2];
if (!file) throw new Error("The monitor state path is required.");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const checks = input
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const owner = process.env.CHISABOT_MONITOR_NOTIFY_OWNER?.trim() || null;
const at = new Date().toISOString();
const monitored = new Set(["app", "dsh", "assistant", "disk", "certificate"]);
const failures = checks
  .filter((check) => monitored.has(check.check) && check.ok === false)
  .map((check) => check.check)
  .sort();
let previous;
try {
  previous = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
let incident = previous?.owner === owner ? (previous?.incident ?? null) : null;
if (failures.length) {
  if (!incident || incident.recoveredAt) {
    incident = {
      id: randomUUID(),
      startedAt: at,
      changedAt: at,
      revision: 1,
      failures,
      recoveredAt: null,
    };
  } else if (incident.failures.join(",") !== failures.join(",")) {
    incident = {
      ...incident,
      changedAt: at,
      revision: incident.revision + 1,
      failures,
    };
  }
} else if (incident && !incident.recoveredAt) {
  incident = { ...incident, recoveredAt: at };
}
await mkdir(dirname(file), { recursive: true });
const temp = `${file}.new.${process.pid}`;
await writeFile(
  temp,
  JSON.stringify({ checkedAt: at, owner, checks, incident }),
  { mode: 0o644 },
);
// The API uid reads the root-owned state even when the account service uses a private umask.
await chmod(temp, 0o644);
await rename(temp, file);
console.log(
  JSON.stringify({
    type: "host-monitor",
    check: "notification",
    ok: true,
    state: owner ? "recorded" : "not_configured",
  }),
);
