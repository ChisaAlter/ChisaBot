import { existsSync } from "node:fs";
import { Glob } from "bun";
import { SERVER_TEST_QUARANTINE } from "./test-quarantine";

// Quarantine entries that point at a file that no longer exists are stale: fail loudly so the
// list shrinks when the defect is fixed rather than silently covering nothing.
const quarantined = Object.keys(SERVER_TEST_QUARANTINE);
const stale = quarantined.filter((path) => !existsSync(path));
if (stale.length) {
  throw new Error(
    `Quarantined test files no longer exist — remove them from scripts/test-quarantine.ts:\n${stale.join("\n")}`,
  );
}

const quarantine = new Set(quarantined);
const files = [
  ...new Glob("server/tests/**/*.test.ts").scanSync("."),
  ...new Glob("shared/**/*.test.ts").scanSync("."),
]
  // Glob yields backslashes on Windows; quarantine keys and the dsh- prefix are forward-slash.
  .map((path) => path.replaceAll("\\", "/"))
  .filter(
    // The dsh-* suites run in their own job via `bun run test:dsh` (dedicated pgvector database).
    (path) =>
      !path.startsWith("server/tests/dsh-") && !quarantine.has(path),
  )
  .sort();

console.log(`Running ${files.length} server/shared test files.`);
console.log(
  `Quarantined defects (${quarantined.length}, see scripts/test-quarantine.ts):`,
);
for (const [path, reason] of Object.entries(SERVER_TEST_QUARANTINE)) {
  console.log(`  ${path}\n    ${reason}`);
}
if (!files.length) throw new Error("No server/shared test files were found.");

// One bun test invocation from the repo root so bunfig.toml preload applies.
const child = Bun.spawn([process.execPath, "test", ...files], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, NODE_ENV: "test" },
});
process.exit(await child.exited);
