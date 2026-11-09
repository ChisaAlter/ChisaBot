import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDshTargets } from "../src/conversations/runtime-targets";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("new account mappings publish into an existing API owner resolver without administrator fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-targets-"));
  roots.push(root);
  const index = join(root, "targets.json");
  const admin = {
    id: "runtime-admin",
    ownerUserId: "admin",
    connectionFile: join(root, "admin.json"),
  };
  await writeFile(index, JSON.stringify([admin]));
  const resolve = await loadDshTargets(index);
  expect(await resolve("admin")).toEqual(admin);
  await expect(resolve("new-account")).rejects.toMatchObject({
    name: "DshAccountPreparingError",
    status: 503,
  });
  const newcomer = {
    id: "runtime-new",
    ownerUserId: "new-account",
    connectionFile: join(root, "new.json"),
  };
  await writeFile(`${index}.tmp`, JSON.stringify([admin, newcomer]));
  await rename(`${index}.tmp`, index);
  expect(await resolve("new-account")).toEqual(newcomer);
  await writeFile(`${index}.tmp`, JSON.stringify([newcomer]));
  await rename(`${index}.tmp`, index);
  await expect(resolve("admin")).rejects.toMatchObject({ status: 503 });
});

test("a conflicting updated index is refused instead of using an old authorized mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-targets-"));
  roots.push(root);
  const index = join(root, "targets.json"),
    connectionFile = join(root, "one.json");
  await writeFile(
    index,
    JSON.stringify([{ id: "one", ownerUserId: "one", connectionFile }]),
  );
  const resolve = await loadDshTargets(index);
  await writeFile(
    index,
    JSON.stringify([
      { id: "one", ownerUserId: "one", connectionFile },
      { id: "two", ownerUserId: "one", connectionFile },
    ]),
  );
  await expect(resolve("one")).rejects.toThrow("must be unique");
});
