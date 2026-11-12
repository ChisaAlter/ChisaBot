import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { inspectDshRuntime } from "../../runtime/dsh/src/readiness.mjs";
import { readAssistantSignals } from "../../server/src/assistant-signals";
import { createManagedDshRuntimes } from "../../server/src/conversations/managed-runtime";
import { loadDshTargets } from "../../server/src/conversations/runtime-targets";
import { selectedAgentKernel } from "../../shared/agent-kernel";

// Run with the API's environment and uid. Never print endpoints, owner IDs or connection tokens.
const command = process.argv[2] ?? "health";
const kernel = selectedAgentKernel(process.env);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set.");
const db = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
try {
  const [table] =
    await db`select to_regclass('chisabot_runtime_bindings') as name`;
  const bindings = table?.name
    ? await db`select owner_user_id, session_id from chisabot_runtime_bindings where kernel='dsh'`
    : [];
  if (command === "signals") {
    const owners = [
      ...new Set(bindings.map((row) => row.owner_user_id as string)),
    ];
    if (!owners.length) throw new Error("No bound DSH owner to inspect.");
    const reports = [];
    for (const owner of owners)
      reports.push(
        await readAssistantSignals(
          (statement, parameters) => db.unsafe(statement, parameters),
          owner,
        ),
      );
    const ok = reports.every((report) => report.ok);
    console.log(
      JSON.stringify({
        ok,
        state: ok ? "clear_in_sample" : "needs_attention",
        owners: reports.length,
        taskFailureStreak: Math.max(
          ...reports.map((report) => report.taskFailureStreak),
        ),
        scheduleFailureStreak: Math.max(
          ...reports.map((report) => report.scheduleFailureStreak),
        ),
        failureThreshold: 3,
        failureWindowHours: 24,
        unknown: {
          personalDeliveriesAtLeast: reports.reduce(
            (sum, report) => sum + report.unknown.personalDeliveriesAtLeast,
            0,
          ),
          toolOperationsAtLeast: reports.reduce(
            (sum, report) => sum + report.unknown.toolOperationsAtLeast,
            0,
          ),
        },
        coverage: reports.map((report) => report.coverage),
      }),
    );
    if (!ok) process.exitCode = 1;
  } else if (command === "bindings") {
    console.log(bindings.length);
  } else if (command === "enabled") {
    console.log(kernel === "dsh" || bindings.length > 0 ? "1" : "0");
  } else if (kernel !== "dsh" && bindings.length === 0) {
    console.log(
      JSON.stringify({
        status: "skipped",
        reason: "No DSH bindings or selected DSH kernel",
      }),
    );
  } else if (command === "compatibility") {
    console.log(
      await readFile(new URL("./runtime-compat.json", import.meta.url), "utf8"),
    );
  } else if (command === "busy") {
    const [row] = await db`select
      (select count(*) from chisabot_dsh_runs where status in ('admitting','observing','projecting')) +
      (select count(*) from chisabot_local_threads where lock_expires_at > now()) as count`;
    console.log(row.count);
  } else if (command === "health" || command === "snapshot") {
    const root = resolve(process.env.CHISABOT_DSH_ROOT ?? ".data/dsh");
    const external = process.env.CHISABOT_DSH_TARGETS_FILE;
    if (command === "snapshot" && external)
      throw new Error(
        "External DSH targets require a coordinated snapshot of their own Session storage.",
      );
    if (!external)
      await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const targetFor = external
      ? await loadDshTargets(external)
      : createManagedDshRuntimes({
          root,
          gatewayUrl: `http://127.0.0.1:${process.env.SERVER_PORT ?? process.env.PORT ?? "3001"}/api/internal/dsh-tools`,
        }).targetFor;
    const owners = [
      ...new Set(bindings.map((row) => row.owner_user_id as string)),
    ];
    // A new install has no conversation yet. Its private probe opens a Host without running a model.
    if (!owners.length && !external) owners.push("__deployment_readiness__");
    if (!owners.length && external) {
      const targets = JSON.parse(await readFile(external, "utf8"));
      for (const target of targets) owners.push(target.ownerUserId);
      if (!owners.length) throw new Error("The DSH targets list is empty.");
    }
    const expected = JSON.parse(
      await readFile(new URL("./runtime-compat.json", import.meta.url), "utf8"),
    );
    const watermarks: { sessionId: string; cursor: number }[] = [];
    let running = 0;
    for (const owner of owners) {
      const target = await targetFor(owner);
      const sessionIds = bindings
        .filter((row) => row.owner_user_id === owner)
        .map((row) => row.session_id as string);
      const health = await inspectDshRuntime({
        target,
        ownerUserId: owner,
        sessionIds,
        expected,
        signal: AbortSignal.timeout(10000 + sessionIds.length * 10000),
      });
      running += health.running;
      watermarks.push(...health.watermarks);
    }
    if (command === "snapshot" && running)
      throw new Error("A DSH Session is still running; snapshot not ready.");
    const [projection] =
      await db`select coalesce(max(sequence),0)::text as cursor from chisabot_local_events`;
    console.log(
      JSON.stringify({
        status: "ok",
        ...expected,
        runtimes: owners.length,
        sessions: watermarks.length,
        running,
        ...(command === "snapshot"
          ? {
              capturedAt: new Date().toISOString(),
              projectionCursor: projection.cursor,
              watermarks,
            }
          : {}),
      }),
    );
  } else throw new Error("Unknown DSH maintenance command.");
} catch {
  // Exceptions may include private endpoints. The caller gets a failure without exporting them.
  console.error(
    `DSH ${command} failed; inspect the private runtime and database diagnostics.`,
  );
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
