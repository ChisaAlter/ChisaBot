import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * CB-100b: compose_network_drift must not depend on python3. Run it with a fake `docker` and a PATH
 * that contains exactly one JSON parser (or none) to prove every fallback path.
 */
const lib = path.resolve(import.meta.dir, "../../deploy/updater/compose-image.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const config = JSON.stringify({
  networks: { default: { name: "openbot-zh_default", ipam: { config: [{ subnet: "172.19.0.0/16" }] } } },
});

function which(bin: string): string | undefined {
  const r = spawnSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function run(parser: string | undefined, containerNetwork: string, subnet = "172.19.0.0/16") {
  const bin = mkdtempSync(path.join(tmpdir(), "cb100b-drift-"));
  dirs.push(bin);
  writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
case "$*" in
  *"config --format json"*) printf '%s' '${config}' ;;
  "inspect "*) echo "${containerNetwork} " ;;
  "network inspect "*) echo "${subnet} " ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(path.join(bin, "docker"), 0o755);
  if (parser) {
    // bun may be a wrapper script on dev boxes; link the real binary.
    const real = parser === "bun" ? process.execPath : which(parser);
    if (!real) return undefined;
    symlinkSync(real, path.join(bin, parser));
  }
  return spawnSync(
    which("bash")!,
    ["-c", `source "${lib}"; PROJECT=p COMPOSE_FILE=c.yaml CONTAINER=openbot-zh; compose_network_drift; echo "rc=$?"`],
    { encoding: "utf8", env: { PATH: bin, CHISABOT_PYTHON: "", LANG: "C.UTF-8" } },
  );
}

describe("compose_network_drift without python3 (CB-100b)", () => {
  for (const parser of ["python3", "jq", "bun", "node"]) {
    test.skipIf(!which(parser))(`${parser}: same network → no drift`, () => {
      const r = run(parser, "openbot-zh_default")!;
      expect(r.stdout.trim()).toBe("rc=1");
    });
    test.skipIf(!which(parser))(`${parser}: other network → drift`, () => {
      const r = run(parser, "old_net")!;
      expect(r.stdout).toContain("compose 要求 openbot-zh_default");
      expect(r.stdout).toContain("rc=0");
    });
    test.skipIf(!which(parser))(`${parser}: other subnet → drift`, () => {
      const r = run(parser, "openbot-zh_default", "10.0.0.0/24")!;
      expect(r.stdout).toContain("compose 要求 172.19.0.0/16");
      expect(r.stdout).toContain("rc=0");
    });
  }
  test("no parser at all → loud error, treated as drift", () => {
    const r = run(undefined, "openbot-zh_default")!;
    expect(r.stderr).toContain("python3、jq、bun 或 node");
    expect(r.stdout).toContain("--force-recreate");
    expect(r.stdout).toContain("rc=0");
  });
});
