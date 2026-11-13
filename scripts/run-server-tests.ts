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
    (path) => !path.startsWith("server/tests/dsh-") && !quarantine.has(path),
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

/*
 * Chunked, one `bun test` process per chunk — never one process for the whole suite.
 *
 * Test files open connection pools and never end them (see TEST_POOL in
 * server/tests/support/database.ts). In a single process every finished file keeps its
 * connections for the whole run: ~120 database files × max 2 sockets overshoots PostgreSQL's
 * default max_connections of 100, and later files fail with `sorry, too many clients already`.
 * A chunk's pools die with its process, so 30 files bound a chunk to ~60 sockets even if every
 * file talks to the database (bot-factory's wider 8-conn pool still fits).
 *
 * Files run in sorted order one chunk after another, sharing the same test database exactly as
 * the single-process run did — chunk boundaries change nothing about what data a file can see.
 */
const CHUNK_SIZE = 30;
const chunks: string[][] = [];
for (let index = 0; index < files.length; index += CHUNK_SIZE) {
  chunks.push(files.slice(index, index + CHUNK_SIZE));
}

let failed = 0;
for (const [index, chunk] of chunks.entries()) {
  console.log(`\n=== Chunk ${index + 1}/${chunks.length} (${chunk.length} files) ===`);
  const child = Bun.spawn([process.execPath, "test", ...chunk], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  if ((await child.exited) !== 0) failed++;
}
console.log(
  `\n${chunks.length - failed}/${chunks.length} chunks green${failed ? `, ${failed} failed` : ""}.`,
);
process.exit(failed ? 1 : 0);
