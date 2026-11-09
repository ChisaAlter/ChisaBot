import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
async function fixture(t, mode = "ok") {
  const directory = await mkdtemp(join(tmpdir(), "dsh-account-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await copyFile(
    new URL("./accounts-release.mjs", import.meta.url),
    join(directory, "accounts-release.mjs"),
  );
  const path = join(directory, "config.json");
  const config = {
    apiContainer: "api",
    apiTargetsDirectory: "/targets",
    image: "fixture:old",
    runtimeMemory: "512m",
    resourcePrefix: "fixture",
  };
  await writeFile(path, JSON.stringify(config));
  await writeFile(
    join(directory, "accounts.mjs"),
    `
    import {readFile,writeFile} from 'node:fs/promises';
    const [command,path,flag]=process.argv.slice(2);
    if(command!=='reconcile'||flag!=='--replace')process.exit(2);
    const config=JSON.parse(await readFile(path,'utf8'));
    await writeFile(new URL('./called.json',import.meta.url),JSON.stringify(config));
    if(${JSON.stringify(mode)}==='failure')process.exit(3);
    if(${JSON.stringify(mode)}==='concurrent')await writeFile(${JSON.stringify(path)},JSON.stringify({...config,image:'operator:choice',runtimeMemory:'1g'}));
    console.log(JSON.stringify({ready:2,preparing:0,updateRequired:0}));
  `,
  );
  return {
    directory,
    path,
    config,
    run: (command = "replace", container = "api", target = "fixture:new") =>
      execute(process.execPath, [
        join(directory, "accounts-release.mjs"),
        command,
        path,
        container,
        "/targets",
        target,
      ]),
  };
}

test("successful replacement persists only the requested image after reconciler succeeds", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), {
    ...f.config,
    image: "fixture:new",
  });
  assert.equal(
    JSON.parse(await readFile(join(f.directory, "called.json"), "utf8")).image,
    "fixture:new",
  );
});
test("failed partial replacement keeps original configured image for recovery", async (t) => {
  const f = await fixture(t, "failure");
  await assert.rejects(f.run());
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), f.config);
});
test("unrelated API configuration is rejected before invoking reconciliation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("replace", "other-api"));
  await assert.rejects(readFile(join(f.directory, "called.json")));
});
test("concurrent operator edit is retained and release fails for reconciliation", async (t) => {
  const f = await fixture(t, "concurrent");
  await assert.rejects(f.run());
  assert.equal(
    JSON.parse(await readFile(f.path, "utf8")).image,
    "operator:choice",
  );
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).runtimeMemory, "1g");
});
test("rollback replacement uses the requested prior image through the same contract", async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.run("replace", "api", "fixture:old");
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), f.config);
});
