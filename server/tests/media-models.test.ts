import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { filesFromToolResult } from "../../shared/chat-files";
import { modelKeyOf } from "../src/chat-files/media-models";
import { createChatFiles, sniffImage } from "../src/chat-files/service";
import { askVisionModel, probeVisionModel, solidPng } from "../src/chat-files/vision-provider";
import { createDatabase } from "../src/db/client";
import { imageInputOf } from "../src/model-catalog";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 生图模型 / 识图模型（DESIGN.md §59）。 */
const PNG = solidPng(10, 120, 200, 4);

describe("vision provider + catalog", () => {
  test("solid png is a real png", () => {
    expect(sniffImage(solidPng(1, 2, 3))).toBe("image/png");
  });
  test("catalog image input detection", () => {
    expect(imageInputOf({ modalities: { input: ["text", "image"] } })).toBe(true);
    expect(imageInputOf({ modalities: { input: ["text"] } })).toBe(false);
    expect(imageInputOf({ input_modalities: ["text"] })).toBe(false);
    expect(imageInputOf({ capabilities: { vision: true } })).toBe(true);
    expect(imageInputOf({ id: "x" })).toBeUndefined();
  });
  test("chat/completions shape, think stripped, errors readable", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: "<think>hmm</think>一只蓝色方块" } }] });
    }) as unknown as typeof fetch;
    const text = await askVisionModel({ baseUrl: "https://v.example.com", model: "vl-1", apiKey: "sk-v" }, { bytes: PNG, mimeType: "image/png" }, "看看", { fetch: ok });
    expect(text).toBe("一只蓝色方块");
    expect(seen[0]!.url).toBe("https://v.example.com/v1/chat/completions");
    expect(seen[0]!.auth).toBe("Bearer sk-v");
    const content = (seen[0]!.body.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
    expect(content[1]!.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    const denied = (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
    expect((await probeVisionModel({ baseUrl: "https://v", model: "m", apiKey: "k" }, denied)).message).toContain("401");
    const empty = (async () => Response.json({ choices: [{ message: { content: "" } }] })) as unknown as typeof fetch;
    expect((await probeVisionModel({ baseUrl: "https://v", model: "m", apiKey: "k" }, empty)).ok).toBe(false);
    expect((await probeVisionModel({ baseUrl: "https://v", model: "m", apiKey: "k" }, ok)).ok).toBe(true);
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("media models: defaults, personal overrides, vision descriptions", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const admin = `mmadmin-${randomUUID().slice(0, 8)}`;
  const alice = `mmalice-${randomUUID().slice(0, 8)}`;
  const bob = `mmbob-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID()}`;
  const bobBot = `agent_${randomUUID()}`;
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  let mainSees: boolean | undefined;
  const fakeFetch = (async (u: string, init?: RequestInit) => {
    const target = String(u);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url: target, body, auth: new Headers(init?.headers).get("authorization") });
    if (target.endsWith("/chat/completions")) {
      const model = String(body.model);
      return Response.json({ choices: [{ message: { content: `【${model}】图里写着：暗号是 蓝鲸42` } }] });
    }
    if (target.includes("image_generation")) return Response.json({ data: { image_base64: [PNG.toString("base64")] }, base_resp: { status_code: 0 } });
    if (target.endsWith("/images/generations")) return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const files = url
    ? createChatFiles(database, {
        encryptionKey: key,
        fetch: fakeFetch,
        env: { MINIMAX_API_KEY: "sk-env-minimax-9999" },
        ownsBot: async (o, b) => (o === alice && b === bot) || (o === bob && b === bobBot),
        mainModelSupportsImages: async () => mainSees,
        isAdmin: async (id) => id === admin,
        assertPublic: async (u) => {
          if (/internal|127\.0\.0\.1|localhost/.test(u)) throw new Error("不是公网地址");
        },
      })
    : (null as never);
  const media = url ? files.media : (null as never);
  const names = async (owner: string, b: string) => (await files.tools(owner, b)).map((t) => t.name).sort();

  beforeAll(async () => {
    await files.ensure();
    await database.$client.unsafe("DELETE FROM chisabot_image_settings WHERE id = 'default'");
    await database.$client.unsafe("DELETE FROM chisabot_media_models WHERE owner_user_id = ''");
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_chat_files WHERE owner_user_id IN ($1, $2)", [alice, bob]);
    await database.$client.unsafe("DELETE FROM chisabot_media_models WHERE owner_user_id IN ('', $1, $2, $3)", [admin, alice, bob]);
    await database.$client.unsafe("DELETE FROM chisabot_image_settings WHERE id = 'default'");
  });

  test("existing §56 image row is the admin default (no migration needed); personal custom beats it", async () => {
    // 模拟生产：§56 的那一行（打开、MiniMax、密钥来自环境变量）。
    await database.$client.unsafe(
      "INSERT INTO chisabot_image_settings (id, enabled, provider, base_url, model) VALUES ('default', true, 'minimax', 'https://api.minimax.cn', 'image-01')",
    );
    const view = await media.adminView();
    expect(view.image).toMatchObject({ enabled: true, provider: "minimax", model: "image-01", keySource: "environment", keyHint: "9999", ready: true });
    expect(view.vision).toMatchObject({ mode: "follow", ready: false });
    expect(await names(alice, bot)).toContain("image_generate");
    calls.length = 0;
    await (await files.tools(alice, bot)).find((t) => t.name === "image_generate")!.execute({ prompt: "boat" });
    expect(calls[0]!.url).toContain("api.minimax.cn/v1/image_generation");
    expect(calls[0]!.auth).toBe("Bearer sk-env-minimax-9999");

    // 个人 custom 要齐全（没有密钥不让存）
    await expect(media.savePersonalImage(alice, { mode: "custom", provider: "openai", baseUrl: "https://img.example.com/v1", model: "gpt-image-1" })).rejects.toThrow("密钥");
    // 普通用户不能填内网
    await expect(media.savePersonalImage(alice, { mode: "custom", provider: "openai", baseUrl: "http://internal:3000/v1", model: "m", apiKey: "sk-alice-img-0001" })).rejects.toThrow("公网");
    const me = await media.savePersonalImage(alice, { mode: "custom", provider: "openai", baseUrl: "https://img.example.com/v1", model: "gpt-image-1", apiKey: "sk-alice-img-0001" });
    expect(me.image).toMatchObject({ mode: "custom", keySource: "saved", keyHint: "0001", ready: true });
    expect(JSON.stringify(me)).not.toContain("sk-alice");
    const [row] = await database.$client.unsafe<{ api_key: string }[]>("SELECT api_key FROM chisabot_media_models WHERE owner_user_id = $1 AND kind = 'image'", [alice]);
    expect(row!.api_key).not.toContain("sk-alice");
    calls.length = 0;
    const out = String(await (await files.tools(alice, bot)).find((t) => t.name === "image_generate")!.execute({ prompt: "boat" }));
    expect(filesFromToolResult(out)[0]?.kind).toBe("generated");
    expect(calls[0]!.url).toBe("https://img.example.com/v1/images/generations");
    expect(calls[0]!.auth).toBe("Bearer sk-alice-img-0001");
    // bob 没设：仍用默认
    calls.length = 0;
    await (await files.tools(bob, bobBot)).find((t) => t.name === "image_generate")!.execute({ prompt: "boat" });
    expect(calls[0]!.url).toContain("minimax");
    // 管理员关掉默认：alice 自己的照样能画，bob 不能
    await media.saveImageDefault(admin, { enabled: false, provider: "minimax", baseUrl: "https://api.minimax.cn", model: "image-01" });
    expect(await names(alice, bot)).toContain("image_generate");
    expect(await names(bob, bobBot)).not.toContain("image_generate");
    // 改回「用默认」不丢密钥（之后再切回 custom 不用重填）
    const back = await media.savePersonalImage(alice, { mode: "default" });
    expect(back.image).toMatchObject({ mode: "default", keySource: "saved" });
    await media.saveImageDefault(admin, { enabled: true, provider: "minimax", baseUrl: "https://api.minimax.cn", model: "image-01" });
  });

  test("vision: follow sends the image; admin model describes once (cached); personal beats admin", async () => {
    mainSees = undefined;
    const up = await files.upload(alice, bot, { name: "暗号.png", bytes: PNG });
    expect((await files.loadForTurn(alice, up.id))?.mimeType).toBe("image/png");
    expect(await names(alice, bot)).not.toContain("image_inspect");

    await expect(media.saveVisionDefault(admin, { mode: "custom", baseUrl: "https://vl.example.com/v1", model: "vl-admin" })).rejects.toThrow("密钥");
    const saved = await media.saveVisionDefault(admin, { mode: "custom", baseUrl: "https://vl.example.com/v1", model: "vl-admin", apiKey: "sk-admin-vision-7777" });
    expect(saved).toMatchObject({ mode: "custom", ready: true, keyHint: "7777" });
    // 审查 M9-1：主模型能看图时，配了识图模型也给原图，提示词说图片直接随消息给它（不要先找文件）。
    calls.length = 0;
    expect((await files.loadForTurn(alice, up.id))?.mimeType).toBe("image/png");
    expect(calls.length).toBe(0);
    const seeing = await files.guidance(alice, bot);
    expect(seeing).toContain("直接随这条消息给你");
    expect(seeing).toContain("不要先调 chat_files_recent");
    expect(seeing).not.toContain("转成文字描述");
    const inspectWhenSeeing = (await files.tools(alice, bot)).find((t) => t.name === "image_inspect");
    expect(inspectWhenSeeing?.description).toContain("不需要这个工具");
    expect(inspectWhenSeeing?.description).not.toContain("只拿到了文字描述");

    // 主模型看不了图：才换成识图模型的描述（缓存一次）。
    mainSees = false;
    calls.length = 0;
    const first = await files.loadForTurn(alice, up.id);
    expect(first?.mimeType).toBe("text/plain");
    expect(first?.bytes.toString()).toContain("蓝鲸42");
    expect(first?.bytes.toString()).toContain("vl-admin");
    expect(first?.bytes.toString()).not.toContain("sk-admin");
    const again = await files.loadForTurn(alice, up.id);
    expect(again?.bytes.toString()).toContain("蓝鲸42");
    expect(calls.filter((c) => c.url.endsWith("/chat/completions")).length).toBe(1);
    expect(await names(alice, bot)).toContain("image_inspect");
    expect(await files.guidance(alice, bot)).toContain("转成文字描述");
    expect((await files.tools(alice, bot)).find((t) => t.name === "image_inspect")?.description).toContain("只拿到了文字描述");

    // image_inspect 问具体问题（不缓存）
    calls.length = 0;
    const inspect = String(await (await files.tools(alice, bot)).find((t) => t.name === "image_inspect")!.execute({ question: "暗号是什么？", source: up.id }));
    expect(inspect).toContain("蓝鲸42");
    expect(String((calls[0]!.body.messages as { content: { text?: string }[] }[])[0]!.content[0]!.text)).toContain("暗号是什么");

    // alice 个人「跟随主模型」：原图
    mainSees = undefined;
    await media.savePersonalVision(alice, { mode: "follow" });
    expect((await files.loadForTurn(alice, up.id))?.mimeType).toBe("image/png");
    mainSees = false;
    // alice 个人 custom：她的模型（缓存按模型分开）
    await expect(media.savePersonalVision(alice, { mode: "custom", baseUrl: "http://127.0.0.1:9/v1", model: "x", apiKey: "sk-alice-vis-0002" })).rejects.toThrow("公网");
    const mine = await media.savePersonalVision(alice, { mode: "custom", baseUrl: "https://alice-vl.example.com/v1", model: "vl-alice", apiKey: "sk-alice-vis-0002" });
    expect(mine.vision).toMatchObject({ mode: "custom", keyHint: "0002", ready: true });
    expect(mine.defaults.vision).toMatchObject({ mode: "custom", model: "vl-admin" });
    calls.length = 0;
    const personal = await files.loadForTurn(alice, up.id);
    expect(personal?.bytes.toString()).toContain("vl-alice");
    expect(calls[0]!.url).toBe("https://alice-vl.example.com/v1/chat/completions");
    expect(calls[0]!.auth).toBe("Bearer sk-alice-vis-0002");
    // alice 自己的识图模型也只在主模型看不了图时写描述；能看图就是原图。
    mainSees = undefined;
    expect((await files.loadForTurn(alice, up.id))?.mimeType).toBe("image/png");
    mainSees = false;
    const keys = await database.$client.unsafe<{ model_key: string }[]>("SELECT model_key FROM chisabot_image_descriptions WHERE file_id = $1 ORDER BY model", [up.id]);
    expect(keys.map((k) => k.model_key).sort()).toEqual(
      [modelKeyOf({ baseUrl: "https://vl.example.com/v1", model: "vl-admin" }), modelKeyOf({ baseUrl: "https://alice-vl.example.com/v1", model: "vl-alice" })].sort(),
    );
    // 删文件连描述一起删
    await files.remove(alice, up.id);
    expect((await database.$client.unsafe("SELECT 1 FROM chisabot_image_descriptions WHERE file_id = $1", [up.id])).length).toBe(0);
    mainSees = undefined;
  });

  test("channel attachments (/api/attachments/<id>): original image when the main model sees, description only when it can't", async () => {
    // 网页 / 频道聊天的附件走这条路（审查 M9-1）：原来不管主模型能不能看图都给原图，提示词却说是描述。
    await media.savePersonalVision(alice, { mode: "default" });
    const attachment = { mimeType: "image/png", name: "截图.png", bytes: PNG };
    const text = { mimeType: "text/plain", name: "a.txt", bytes: Buffer.from("hi") };
    mainSees = undefined;
    calls.length = 0;
    expect(await files.channelAttachmentForModel(alice, bot, "att-1", attachment)).toBe(attachment);
    expect(await files.channelAttachmentForModel(alice, bot, "att-1", text)).toBe(text);
    expect(calls.length).toBe(0);

    mainSees = false;
    const described = await files.channelAttachmentForModel(alice, bot, "att-1", attachment);
    expect(described.mimeType).toBe("text/plain");
    expect(described.bytes.toString()).toContain("截图.png");
    expect(described.bytes.toString()).toContain("蓝鲸42");
    expect(described.bytes.toString()).toContain("当前聊天模型不能看图片");
    // 频道附件不在聊天文件表里，image_inspect 认不出它，不叫模型拿它去问。
    expect(described.bytes.toString()).not.toContain("image_inspect");
    await files.channelAttachmentForModel(alice, bot, "att-1", attachment);
    expect(calls.filter((c) => c.url.endsWith("/chat/completions")).length).toBe(1);
    const cached = await database.$client.unsafe<{ file_id: string }[]>("SELECT file_id FROM chisabot_image_descriptions WHERE file_id = 'att:att-1'");
    expect(cached.length).toBe(1);
    await database.$client.unsafe("DELETE FROM chisabot_image_descriptions WHERE file_id = 'att:att-1'");
    expect(await files.channelAttachmentForModel(alice, bot, "att-1", text)).toBe(text);
    mainSees = undefined;
  });

  test("main model can't see images: follow falls back to admin vision, else a note", async () => {
    const up = await files.upload(bob, bobBot, { name: "a.png", bytes: PNG });
    mainSees = false;
    await media.savePersonalVision(bob, { mode: "follow" });
    const viaAdmin = await files.loadForTurn(bob, up.id);
    expect(viaAdmin?.bytes.toString()).toContain("vl-admin");
    await media.saveVisionDefault(admin, { mode: "follow" });
    const none = await files.loadForTurn(bob, up.id);
    expect(none?.mimeType).toBe("text/plain");
    expect(none?.bytes.toString()).toContain("不能看图片");
    mainSees = undefined;
    expect((await files.loadForTurn(bob, up.id))?.mimeType).toBe("image/png");
  });

  test("old images are not batch-described; routes mask keys and gate admin", async () => {
    await media.saveVisionDefault(admin, { mode: "custom", baseUrl: "https://vl.example.com/v1", model: "vl-admin" }); // 密钥留着
    const old = await files.upload(bob, bobBot, { name: "old.png", bytes: PNG });
    await database.$client.unsafe("UPDATE chisabot_chat_files SET created_at = now() - interval '2 days' WHERE id = $1", [old.id]);
    await media.savePersonalVision(bob, { mode: "default" });
    mainSees = false;
    calls.length = 0;
    const note = await files.loadForTurn(bob, old.id);
    expect(note?.bytes.toString()).toContain("image_inspect");
    expect(calls.length).toBe(0);
    mainSees = undefined;

    const app = new Hono();
    let actor = { id: bob, email: "b@x", role: "member" as string };
    app.route(
      "/api/media-models",
      media.routes(async (c, next) => {
        c.set("actor" as never, actor as never);
        await next();
      }),
    );
    expect((await app.request("/api/media-models/default")).status).toBe(403);
    let res = await app.request("/api/media-models/me");
    const me = (await res.json()) as Record<string, unknown>;
    expect(me).toMatchObject({ privateUrlsAllowed: false, defaults: { vision: { mode: "custom", model: "vl-admin" } } });
    res = await app.request("/api/media-models/me/vision", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "custom", baseUrl: "https://bob.example.com/v1", model: "vl-bob", apiKey: "sk-bob-secret-3333" }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-bob-secret");
    expect(text).toContain("3333");
    res = await app.request("/api/media-models/test/vision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "personal", baseUrl: "https://bob.example.com/v1", model: "vl-bob" }) });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    res = await app.request("/api/media-models/test/vision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "default", baseUrl: "https://x/v1", model: "m" }) });
    expect(res.status).toBe(400);
    actor = { id: admin, email: "a@x", role: "admin" };
    res = await app.request("/api/media-models/default");
    const adminView = await res.text();
    expect(res.status).toBe(200);
    expect(adminView).not.toContain("sk-admin-vision");
    expect(adminView).toContain("7777");
    // 管理员个人设置可以填内网
    res = await app.request("/api/media-models/me/vision", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "custom", baseUrl: "http://internal:8080/v1", model: "local-vl", apiKey: "sk-admin-local-4444" }) });
    expect(res.status).toBe(200);
  });
});
