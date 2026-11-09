import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * deploy/updater/chisabot-updater.py runs on the host under python3 (3.6+) or python2.7 (docs/online-update.md).
 * Run its self-test with every interpreter this machine has; skip when there is none.
 */
const script = path.resolve(
  import.meta.dir,
  "../../deploy/updater/test_updater.py",
);

for (const python of ["python3", "python2"]) {
  const probe = spawnSync(python, ["--version"], { encoding: "utf8" });
  test.skipIf(probe.error !== undefined || probe.status !== 0)(
    `host updater self-test under ${python}`,
    () => {
      const run = spawnSync(python, [script], {
        encoding: "utf8",
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
      });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("self-test OK");
    },
  );
}
