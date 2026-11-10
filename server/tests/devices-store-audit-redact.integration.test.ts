import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDatabase } from "../src/db/client";
import { createDeviceStore } from "../src/devices/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * QA514：device_audit_events 写库前打码；读取路径对存量明文再打一遍。
 * CI 的 Durable inbox 步骤会跑本文件。
 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;

describe.skipIf(!url)("device store: audit write/read redaction", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const owner = `ar-${randomUUID().slice(0, 8)}`;
  let deviceId = "";
  let store: ReturnType<typeof createDeviceStore>;

  beforeAll(async () => {
    const sql = readFileSync(
      new URL("../drizzle/0054_pc_devices.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim())
        await database.$client.unsafe(statement).catch(() => {});
    }
    store = createDeviceStore(database);
    await store.ensure();
    const enrolled = await store.enroll({
      ownerUserId: owner,
      name: "audit-redact",
      platform: "win32",
      clientVersion: "0.1.8",
    });
    deviceId = enrolled.device.id;
  });

  afterAll(async () => {
    if (!url) return;
    for (const d of await store.list(owner)) await store.remove(d.id);
  });

  test("write path redacts PowerShell $env with spaces, JSON, flags, headers, _KEY", async () => {
    const samples = [
      `$env:IMA_OPENAPI_CLIENTID = 'FAKEcidW001'; $env:IMA_OPENAPI_APIKEY = "FAKEkeyW002"`,
      `{"client_id":"FAKEcidW003","client_secret":"FAKEsecW004"}`,
      `tool --client-id FAKEcidW005 --api-key=FAKEkeyW006`,
      `curl -H "X-Api-Key: FAKEhdrW007" -H "X-Client-Id: FAKEhdrW008"`,
      `OPENAI_KEY=FAKEokW009 STRIPE_KEY=FAKEskW010`,
      `DB_PASSWORD=pa;ssW011`,
      `API_KEY=ab|cdW012`,
    ];
    const secrets = [
      "FAKEcidW001",
      "FAKEkeyW002",
      "FAKEcidW003",
      "FAKEsecW004",
      "FAKEcidW005",
      "FAKEkeyW006",
      "FAKEhdrW007",
      "FAKEhdrW008",
      "FAKEokW009",
      "FAKEskW010",
      "pa;ssW011",
      "ab|cdW012",
    ];
    for (const summary of samples) {
      await store.audit({
        deviceId,
        ownerUserId: owner,
        actorType: "bot",
        actorId: "bot",
        actorName: "bot",
        action: "shell",
        summary: `运行命令：${summary}`,
        outcome: "ok",
        detail: summary,
        durationMs: 1,
      });
    }
    // 直接查库：写入时已是打码后的
    const raw = await database.$client.unsafe(
      `select summary, detail from device_audit_events where device_id = $1 order by at desc limit 20`,
      [deviceId],
    );
    const blob = JSON.stringify(raw);
    for (const secret of secrets) {
      expect(blob).not.toContain(secret);
    }

    const log = await store.auditLog(deviceId, { limit: 20 });
    const apiBlob = JSON.stringify(log);
    for (const secret of secrets) {
      expect(apiBlob).not.toContain(secret);
    }
  });

  test("read path redacts legacy plaintext rows that bypassed write redaction", async () => {
    const id = randomUUID();
    const leak =
      "运行命令：$env:IMA_OPENAPI_APIKEY='FAKEoldREAD99'; OPENAI_KEY=FAKEoldKEY99";
    await database.$client.unsafe(
      `insert into device_audit_events
        (id, device_id, owner_user_id, actor_type, actor_id, actor_name, action, summary, outcome, detail, duration_ms, at)
       values ($1,$2,$3,'bot','bot','bot','shell',$4,'ok',$4,1,now())`,
      [id, deviceId, owner, leak],
    );
    const log = await store.auditLog(deviceId, { limit: 5 });
    const hit = log.find((row) => row.id === id);
    expect(hit).toBeTruthy();
    expect(hit!.summary).not.toContain("FAKEoldREAD99");
    expect(hit!.summary).not.toContain("FAKEoldKEY99");
    expect(hit!.detail ?? "").not.toContain("FAKEoldREAD99");
    // 库里仍是明文（存量清理另做）；API 已打码
    const raw = await database.$client.unsafe(
      `select summary from device_audit_events where id = $1`,
      [id],
    );
    expect(String(raw[0]?.summary ?? "")).toContain("FAKEoldREAD99");
  });

  test("false positives stay readable", async () => {
    const keep = [
      "CLIENT_IDLE_TIMEOUT=30",
      "MAX_TOKENS=4096",
      "TOKENIZER=bert",
      "KEYBOARD=us",
    ];
    for (const summary of keep) {
      await store.audit({
        deviceId,
        ownerUserId: owner,
        actorType: "bot",
        actorId: "bot",
        actorName: "bot",
        action: "shell",
        summary,
        outcome: "ok",
        detail: null,
        durationMs: 1,
      });
    }
    const log = await store.auditLog(deviceId, { limit: 10 });
    for (const summary of keep) {
      expect(log.some((row) => row.summary === summary)).toBe(true);
    }
  });
});
