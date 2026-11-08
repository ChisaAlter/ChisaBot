import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { DshRuntimeTarget } from "../agents/dsh-runtime";

const Targets = z.array(z.object({ id: z.string().min(1), ownerUserId: z.string().min(1), connectionFile: z.string().refine(isAbsolute) }));

export class DshAccountPreparingError extends Error {
  readonly status = 503;
  constructor() {
    super("这个账号的执行环境正在准备，请稍后重试。");
    this.name = "DshAccountPreparingError";
  }
}

function parseTargets(source: string) {
  const targets = Targets.parse(JSON.parse(source));
  if (new Set(targets.map(x => x.ownerUserId)).size !== targets.length || new Set(targets.map(x => x.id)).size !== targets.length) throw new Error("DSH target owners and runtime IDs must be unique.");
  return new Map(targets.map(target => [target.ownerUserId, Object.freeze(target)]));
}

/** The deployment chooses runtime owners. Incoming URLs and actor headers cannot change it. */
export async function loadDshTargets(file: string): Promise<(actorId: string) => Promise<DshRuntimeTarget>> {
  let source = await readFile(file, "utf8");
  let owners = parseTargets(source);
  return async actorId => {
    // The host reconciler publishes complete indexes by rename. Existing API processes pick up
    // new accounts and rotated connection files without a restart or an administrator fallback.
    const latest = await readFile(file, "utf8");
    if (latest !== source) {
      const next = parseTargets(latest);
      owners = next;
      source = latest;
    }
    const target = owners.get(actorId);
    if (!target) throw new DshAccountPreparingError();
    return target;
  };
}
