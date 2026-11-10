import { Glob } from "bun";

// These suites start real local Hosts and use a dedicated PostgreSQL database.
// Missing infrastructure must not turn required recovery coverage into a green skip.
if (!process.env.CHISABOT_DSH_TEST_DATABASE_URL?.trim()) {
  throw new Error(
    "CHISABOT_DSH_TEST_DATABASE_URL is required for DSH integration tests.",
  );
}
const migration = Bun.spawn([process.execPath, "server/scripts/migrate.ts"], {
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    DATABASE_URL: process.env.CHISABOT_DSH_TEST_DATABASE_URL,
  },
});
if ((await migration.exited) !== 0)
  throw new Error("DSH test database migration failed.");
const files = [...new Glob("server/tests/dsh-*.test.ts").scanSync(".")].sort();
if (!files.length) throw new Error("No DSH integration test files were found.");

for (const file of files) {
  // Runtime selection and process-recovery fixtures own module state; isolate each suite.
  const child = Bun.spawn([process.execPath, "test", file], {
    stdout: "inherit",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });
  let output = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    process.stderr.write(text);
  }
  output += decoder.decode();
  const status = await child.exited;
  const passed = Number(output.match(/\b(\d+) pass\b/)?.[1] ?? 0);
  const skipped = Number(output.match(/\b(\d+) skip\b/)?.[1] ?? 0);
  if (status !== 0 || passed === 0 || skipped > 0) {
    throw new Error(`${file}: required DSH coverage failed or was skipped.`);
  }
}
