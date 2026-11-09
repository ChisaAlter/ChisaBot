import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { conversationTables } from "./dsh/legacy-schema.mjs";

const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const slash = (path) => path.replaceAll("\\", "/");
const testRoot = resolve(tmpdir());
function removeTestDirectory(path) {
  assert.equal(dirname(resolve(path)), testRoot);
  rmSync(path, { recursive: true });
}
const resourceScript = String.raw`
source "$1"
docker() {
  case "$*" in
    'inspect chisabot-zh') [ "$SCENARIO" = live ] ;;
    inspect\ -f*)
      case "$*" in
        */var/lib/postgresql*) echo tenant_database ;;
        */workspace*) echo tenant_workspace ;;
        */profiles*) echo tenant_profiles ;;
        */var/lib/chisabot-dsh*) echo tenant_dsh ;;
        *NetworkSettings*) echo tenant_default ;;
        *) return 1 ;;
      esac ;;
    'volume inspect openbot-zh_database') [ "$SCENARIO" = legacy ] || [ "$SCENARIO" = ambiguous ] ;;
    'volume inspect chisabot-zh_database') [ "$SCENARIO" = ambiguous ] ;;
    'network inspect openbot-zh_default'|'network inspect openbot_magpie') [ "$SCENARIO" = legacy ] ;;
    'network inspect tenant_default'|'network inspect my_net') return 0 ;;
    'network inspect new_net') return 1 ;;
    network\ inspect\ -f*)
      case "$*" in *Subnet*) echo 172.19.0.0/16 ;; *Gateway*) echo 172.19.0.1 ;; *) return 1 ;; esac ;;
    *) echo "Unexpected Docker mutation or command: $*" >&2; return 79 ;;
  esac
}
pin_existing_resources "$2" chisabot-zh
`;

function resources(scenario, initial = "") {
  const dir = mkdtempSync(join(tmpdir(), "chisabot-resource-"));
  const env = join(dir, ".env");
  writeFileSync(env, initial);
  try {
    const result = spawnSync(
      bash,
      [
        "-c",
        resourceScript,
        "test",
        slash(resolve("deploy/legacy-resources.sh")),
        slash(env),
      ],
      { encoding: "utf8", env: { ...process.env, SCENARIO: scenario } },
    );
    return { ...result, config: readFileSync(env, "utf8") };
  } finally {
    removeTestDirectory(dir);
  }
}

test("fresh installs keep canonical defaults; running deployments pin actual volume and network identities", () => {
  const fresh = resources("fresh");
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.config, "");
  const live = resources("live", "KEY_ENCRYPTION_KEY=kept\n");
  assert.equal(live.status, 0, live.stderr);
  for (const pair of [
    "DATABASE=tenant_database",
    "WORKSPACE=tenant_workspace",
    "PROFILES=tenant_profiles",
    "DSH=tenant_dsh",
  ]) {
    const [key, value] = pair.split("=");
    assert.match(live.config, new RegExp(`CHISABOT_${key}_VOLUME=${value}`));
  }
  assert.match(live.config, /CHISABOT_NETWORK_NAME=tenant_default/);
  assert.match(live.config, /CHISABOT_NETWORK_SUBNET=172\.19\.0\.0\/16/);
  assert.match(live.config, /KEY_ENCRYPTION_KEY=kept/);
});
test("legacy resources are explicitly pinned and ambiguous database volumes cannot select empty data", () => {
  const old = resources("legacy", "OPENBOT_RUNTIME_MODE=local\n");
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.config, /CHISABOT_DATABASE_VOLUME=openbot-zh_database/);
  assert.match(old.config, /CHISABOT_SERVICE_ALIAS=openbot-zh/);
  assert.match(old.config, /MAGPIE_NETWORK=openbot_magpie/);
  assert.match(old.config, /CHISABOT_RUNTIME_MODE=local/);
  const both = resources("ambiguous");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Both legacy and canonical database volumes/);
});
test("explicit resource choices win over discovered legacy defaults", () => {
  const custom = resources(
    "legacy",
    "CHISABOT_DATABASE_VOLUME=my_database\nCHISABOT_NETWORK_NAME=my_net\nCHISABOT_NETWORK_SUBNET=10.42.0.0/16\nCHISABOT_NETWORK_GATEWAY=10.42.0.1\nMAGPIE_NETWORK=my_magpie\n",
  );
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.config, /CHISABOT_DATABASE_VOLUME=my_database/);
  assert.doesNotMatch(custom.config, /openbot/);
  assert.equal(
    (custom.config.match(/CHISABOT_NETWORK_SUBNET=/g) || []).length,
    1,
  );
  const freshCustom = resources("fresh", "CHISABOT_NETWORK_NAME=new_net\n");
  assert.equal(freshCustom.status, 0, freshCustom.stderr);
  assert.equal(freshCustom.config, "CHISABOT_NETWORK_NAME=new_net\n");
});
test("embedded database identity persists a fresh name and preserves an existing cluster without renaming roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "chisabot-db-identity-"));
  mkdirSync(join(dir, "data"));
  const run = () =>
    spawnSync(
      bash,
      [
        "-c",
        'source "$1"; DATA="$2/data"; select_database_identity "$2/identity"; printf "%s:%s" "$PG_ROLE" "$PG_DATABASE"',
        "test",
        slash(resolve("docker/s6/scripts/legacy-database-identity.sh")),
        slash(dir),
      ],
      { encoding: "utf8" },
    );
  try {
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "chisabot:chisabot");
    writeFileSync(join(dir, "data", "PG_VERSION"), "16");
    r = run();
    assert.equal(r.stdout, "chisabot:chisabot");
    rmSync(join(dir, "identity"));
    r = run();
    assert.equal(r.stdout, "openbot:openbot");
    r = run();
    assert.equal(r.stdout, "openbot:openbot");
  } finally {
    removeTestDirectory(dir);
  }
});
test("host maintenance selects either supported schema and refuses ambiguous or absent storage", async () => {
  const query = (row) => ({ unsafe: async () => [row] });
  assert.equal(
    (await conversationTables(query({ current: "chisabot_local_threads" })))
      .threads,
    "chisabot_local_threads",
  );
  assert.equal(
    (await conversationTables(query({ legacy: "openbot_local_threads" })))
      .events,
    "openbot_local_events",
  );
  await assert.rejects(
    conversationTables(
      query({
        current: "chisabot_local_threads",
        legacy: "openbot_local_threads",
      }),
    ),
    /Ambiguous/,
  );
  await assert.rejects(conversationTables(query({})), /unavailable/);
});
