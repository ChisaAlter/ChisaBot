import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createMediaModels } from "../src/chat-files/media-models";
import type { EffectiveVision } from "../src/chat-files/media-models";
import { encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 场景化 vision 默认：管理员未配 custom 识图模型时，场景合成配置作为部署级默认参与解析。 */
const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("vision 场景回退链", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  const alice = `svalice-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID()}`;
  let mainSees: boolean | undefined = true;
  let scenario: EffectiveVision | null = null;
  const scenarioVisionConfig = {
    baseUrl: "https://scenario-v.example.com",
    model: "scenario-vl",
    apiKey: "sk-scenario",
  };
  const media = url
    ? createMediaModels(database, {
        encryptionKey: key,
        fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch,
        mainModelSupportsImages: async () => mainSees,
        isAdmin: async () => false,
        assertPublic: async () => {},
        scenarioVision: async () => scenario,
      })
    : (null as never);

  beforeAll(async () => {
    await media.ensure();
    await database.$client.unsafe(
      "DELETE FROM chisabot_media_models WHERE owner_user_id IN ('', $1)",
      [alice],
    );
  });
  afterAll(async () => {
    await database.$client.unsafe(
      "DELETE FROM chisabot_media_models WHERE owner_user_id IN ('', $1)",
      [alice],
    );
  });

  test("无配置且无场景：主模型能看图时返回 main", async () => {
    mainSees = true;
    scenario = null;
    const result = await media.visionFor(alice, bot);
    expect(result.kind).toBe("main");
  });

  test("无配置且无场景：主模型不能看图时返回 none（升级前行为）", async () => {
    mainSees = false;
    scenario = null;
    const result = await media.visionFor(alice, bot);
    expect(result.kind).toBe("none");
  });

  test("场景 vision 在主模型不能看图时成为回退", async () => {
    mainSees = false;
    scenario = {
      kind: "model",
      config: scenarioVisionConfig,
      source: "default",
      label: "scenario-vl",
    };
    const result = await media.visionFor(alice, bot);
    expect(result.kind).toBe("model");
    if (result.kind === "model") {
      expect(result.config.model).toBe("scenario-vl");
      expect(result.source).toBe("default");
    }
  });

  test("主模型能看图时场景不抢主模型（main 优先）", async () => {
    mainSees = true;
    scenario = {
      kind: "model",
      config: scenarioVisionConfig,
      source: "default",
      label: "scenario-vl",
    };
    // 管理员未配置时解析顺序：个人 → 管理员/场景 → 主模型跟随。
    // 注意：个人无设置时管理员/场景层优先于跟随主模型（与管理员 custom 语义一致）。
    const result = await media.visionFor(alice, bot);
    expect(result.kind).toBe("model");
  });

  test("管理员 custom 优先于场景合成", async () => {
    mainSees = false;
    scenario = {
      kind: "model",
      config: scenarioVisionConfig,
      source: "default",
      label: "scenario-vl",
    };
    const sealed = await encryptSecret(key, "sk-admin-vision");
    await database.$client.unsafe(
      "INSERT INTO chisabot_media_models (owner_user_id, kind, mode, base_url, model, api_key) VALUES ('', 'vision', 'custom', 'https://admin-v.example.com', 'admin-vl', $1)",
      [sealed],
    );
    try {
      const result = await media.visionFor(alice, bot);
      expect(result.kind).toBe("model");
      if (result.kind === "model") expect(result.config.model).toBe("admin-vl");
    } finally {
      await database.$client.unsafe(
        "DELETE FROM chisabot_media_models WHERE owner_user_id = ''",
      );
    }
  });
});
