import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { CHAT_FILES_MARKER, filesFromToolResult, toolResultText } from "../../shared/chat-files";
import { attachmentIdsIn } from "../src/channels/attachment-parts";
import { minimaxEndpoint, openaiBase, probeImageModel, runImageModel } from "../src/chat-files/image-provider";
import { createChatFiles, detectMime, safeName, sniffImage } from "../src/chat-files/service";
import { createDatabase } from "../src/db/client";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** 聊天文件 + 图片生成（DESIGN.md §56）。 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

describe("sniffing and names", () => {
  test("bitmap and pdf by bytes, others by extension, svg never an image", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(detectMime(JPEG, "a.bin")).toBe("image/jpeg");
    expect(detectMime(Buffer.from("%PDF-1.7 ..."), "x.txt")).toBe("application/pdf");
    expect(detectMime(Buffer.from("<svg onload=alert(1)>"), "a.svg")).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<svg>"))).toBeNull();
    expect(detectMime(Buffer.from("a,b"), "t.csv")).toBe("text/csv");
    expect(detectMime(Buffer.from([1, 2, 3]), "blob")).toBe("application/octet-stream");
  });
  test("safe names", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\x\\报告<1>.pdf")).toBe("报告1.pdf");
    expect(safeName("...")).toBe("文件");
  });
  test("chat-file urls become cf: attachment refs", () => {
    const id = randomUUID();
    expect(attachmentIdsIn([{ type: "image", source: { type: "url", value: `/api/chat-files/${id}` } }, { type: "text", text: "hi" }])).toEqual([`cf:${id}`]);
  });
  test("tool result marker round trip", () => {
    const file = { id: randomUUID(), name: "a.png", mimeType: "image/png", size: 3, kind: "generated", url: "/api/chat-files/x", workspacePath: null, createdAt: "" };
    const text = `done\n${CHAT_FILES_MARKER}${JSON.stringify([file, { id: "evil", url: "https://evil" }])}`;
    expect(filesFromToolResult(text).map((f) => f.name)).toEqual(["a.png"]);
    expect(toolResultText(text)).toBe("done");
    expect(filesFromToolResult("no marker")).toEqual([]);
    // AG-UI 把字符串结果再 JSON 编码一次
    expect(filesFromToolResult(JSON.stringify(text)).map((f) => f.name)).toEqual(["a.png"]);
    expect(toolResultText(JSON.stringify(text))).toBe("done");
  });
});

describe("image providers", () => {
  test("endpoints", () => {
    expect(minimaxEndpoint("https://api.minimax.cn/v1/")).toBe("https://api.minimax.cn/v1/image_generation");
    expect(openaiBase("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(openaiBase("http://new-api:3000/v1")).toBe("http://new-api:3000/v1");
  });
  test("minimax generate + subject reference edit", async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ data: { image_base64: [PNG.toString("base64")] }, base_resp: { status_code: 0, status_msg: "success" } });
    }) as unknown as typeof fetch;
    const config = { provider: "minimax" as const, baseUrl: "https://api.minimax.cn", model: "image-01", apiKey: "k" };
    const out = await runImageModel(config, { prompt: "boat", aspect: "16:9" }, { fetch: fetchMock, download: async () => Buffer.alloc(0) });
    expect(out.bytes.equals(PNG)).toBe(true);
    expect(seen[0]!.body).toMatchObject({ model: "image-01", prompt: "boat", aspect_ratio: "16:9", response_format: "base64", n: 1 });
    await runImageModel(config, { prompt: "same cat, red hat", aspect: "1:1", input: { bytes: PNG, mimeType: "image/png" } }, { fetch: fetchMock, download: async () => Buffer.alloc(0) });
    const ref = (seen[1]!.body.subject_reference as { image_file: string }[])[0]!;
    expect(ref.image_file.startsWith("data:image/png;base64,")).toBe(true);
  });
  test("minimax error and moderation are reported", async () => {
    const fetchMock = (async () => Response.json({ data: null, base_resp: { status_code: 1026, status_msg: "input new_sensitive" } })) as unknown as typeof fetch;
    await expect(
      runImageModel({ provider: "minimax", baseUrl: "https://x", model: "image-01", apiKey: "k" }, { prompt: "p", aspect: "1:1" }, { fetch: fetchMock, download: async () => Buffer.alloc(0) }),
    ).rejects.toThrow(/1026/);
  });
  test("openai generations (url result) and edits (multipart)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/edits") ? Response.json({ data: [{ b64_json: PNG.toString("base64") }] }) : Response.json({ data: [{ url: "https://cdn.example.com/a.png", revised_prompt: "r" }] });
    }) as unknown as typeof fetch;
    const downloads: string[] = [];
    const deps = { fetch: fetchMock, download: async (u: string) => (downloads.push(u), PNG) };
    const config = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", editModel: "gpt-image-1-edit", apiKey: "k" };
    const gen = await runImageModel(config, { prompt: "p", aspect: "9:16" }, deps);
    expect(gen.revisedPrompt).toBe("r");
    expect(downloads).toEqual(["https://cdn.example.com/a.png"]);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ model: "gpt-image-1", size: "1024x1536" });
    await runImageModel(config, { prompt: "p", aspect: "1:1", input: { bytes: PNG, mimeType: "image/png" } }, deps);
    const form = calls[1]!.init?.body as FormData;
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/images/edits");
    expect(form.get("model")).toBe("gpt-image-1-edit");
    expect(form.get("image")).toBeInstanceOf(Blob);
  });
  test("probe spends nothing", async () => {
    const minimax = (async () => Response.json({ base_resp: { status_code: 2013, status_msg: "invalid params, prompt are required" } })) as unknown as typeof fetch;
    expect((await probeImageModel({ provider: "minimax", baseUrl: "https://x", model: "image-01", apiKey: "k" }, minimax)).ok).toBe(true);
    const badKey = (async () => Response.json({ base_resp: { status_code: 1004, status_msg: "login fail" } })) as unknown as typeof fetch;
    expect((await probeImageModel({ provider: "minimax", baseUrl: "https://x", model: "image-01", apiKey: "k" }, badKey)).ok).toBe(false);
    const models = (async () => Response.json({ data: [{ id: "dall-e-3" }] })) as unknown as typeof fetch;
    const r = await probeImageModel({ provider: "openai", baseUrl: "https://x/v1", model: "gpt-image-1", apiKey: "k" }, models);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("gpt-image-1");
  });
});

const url = process.env.TEST_DATABASE_URL ? testDatabaseUrl() : null;
describe.skipIf(!url)("chat files service", () => {
  const database = url ? createDatabase(url, TEST_POOL) : (null as never);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const owner = `cftest-${randomUUID().slice(0, 8)}`;
  const other = `cftest-${randomUUID().slice(0, 8)}`;
  const bot = `agent_${randomUUID()}`;
  const written = new Map<string, Buffer>();
  const imageCalls: Record<string, unknown>[] = [];
  const fakeFetch = (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    imageCalls.push(body);
    if (body.prompt === "") return Response.json({ base_resp: { status_code: 2013, status_msg: "invalid params, prompt are required" } });
    return Response.json({ data: { image_base64: [PNG.toString("base64")] }, base_resp: { status_code: 0 } });
  }) as unknown as typeof fetch;
  const files = url
    ? createChatFiles(database, {
        encryptionKey: key,
        fetch: fakeFetch,
        env: { OPENAI_BASE_URL: "https://api.minimax.cn/v1", OPENAI_API_KEY: "sk-env-key-1234" },
        ownsBot: async (o, b) => o === owner && b === bot,
        workspace: {
          write: async (_o, _b, path, bytes) => (written.set(path, bytes), true),
          read: async (_o, _b, path) => {
            const found = written.get(path);
            if (!found) throw new Error(`There is no file at ${path}.`);
            return { bytes: found, name: path.split("/").pop()! };
          },
        },
      })
    : (null as never);
  const toolsByName = async () => Object.fromEntries((await files.tools(owner, bot)).map((t) => [t.name, t]));

  beforeAll(async () => {
    await files.ensure();
    await database.$client.unsafe("DELETE FROM chisabot_image_settings WHERE id = 'default'");
  });
  afterAll(async () => {
    await database.$client.unsafe("DELETE FROM chisabot_chat_files WHERE owner_user_id IN ($1, $2)", [owner, other]);
    await database.$client.unsafe("DELETE FROM chisabot_image_settings WHERE id = 'default'");
  });

  test("image tools only when enabled; env key fallback for minimax", async () => {
    let view = await files.settingsView();
    expect(view).toMatchObject({ enabled: false, provider: "minimax", keySource: "environment", keyHint: "1234", ready: false });
    expect(Object.keys(await toolsByName()).sort()).toEqual(["chat_files_recent", "file_share"]);
    expect(await files.guidance()).toContain("还没打开图片生成");
    view = await files.saveSettings(owner, { enabled: true, provider: "minimax", baseUrl: "https://api.minimax.cn", model: "image-01" });
    expect(view.ready).toBe(true);
    expect(Object.keys(await toolsByName())).toContain("image_generate");
    expect((await files.testSettings({})).ok).toBe(true);
    // 存的密钥加密、只露末四位；清空后回到环境变量。
    view = await files.saveSettings(owner, { enabled: true, provider: "minimax", baseUrl: "https://api.minimax.cn", model: "image-01", apiKey: "saved-key-abcd" });
    expect(view).toMatchObject({ keySource: "saved", keyHint: "abcd" });
    const [row] = await database.$client.unsafe<{ api_key: string }[]>("SELECT api_key FROM chisabot_image_settings WHERE id = 'default'");
    expect(row!.api_key).not.toContain("saved-key");
    view = await files.saveSettings(owner, { enabled: true, provider: "minimax", baseUrl: "https://api.minimax.cn", model: "image-01", apiKey: "" });
    expect(view.keySource).toBe("environment");
  });

  test("upload lands in workspace uploads/, collision gets a suffix, others cannot read", async () => {
    await expect(files.upload(owner, "agent_other", { name: "a.png", bytes: PNG })).rejects.toThrow("找不到这个机器人");
    const a = await files.upload(owner, bot, { name: "../照片.png", bytes: PNG });
    const b = await files.upload(owner, bot, { name: "照片.png", bytes: PNG });
    expect(a).toMatchObject({ name: "照片.png", mimeType: "image/png", kind: "upload", workspacePath: "uploads/照片.png" });
    expect(b.workspacePath).toBe("uploads/照片-2.png");
    expect(written.has("uploads/照片.png")).toBe(true);
    expect(await files.row(other, a.id)).toBeNull();
    const asImage = await files.loadForTurn(owner, a.id);
    expect(asImage?.mimeType).toBe("image/png");
    expect(await files.loadForTurn(other, a.id)).toBeNull();
    const pdf = await files.upload(owner, bot, { name: "r.pdf", bytes: Buffer.from("%PDF-1.4 hello") });
    const note = await files.loadForTurn(owner, pdf.id);
    expect(note?.mimeType).toBe("text/plain");
    expect(note?.bytes.toString()).toContain("uploads/r.pdf");
    const csv = await files.upload(owner, bot, { name: "t.csv", bytes: Buffer.from("a,b\n1,2") });
    expect((await files.loadForTurn(owner, csv.id))?.bytes.toString()).toContain("1,2");
  });

  test("generate, edit (defaults to latest image), share, recent", async () => {
    const tools = await toolsByName();
    imageCalls.length = 0;
    const gen = String(await tools.image_generate!.execute({ prompt: "a blue paper boat", aspect_ratio: "16:9" }));
    const [genFile] = filesFromToolResult(gen);
    expect(genFile).toMatchObject({ kind: "generated", mimeType: "image/png" });
    expect(genFile!.workspacePath).toMatch(/^images\/\d{8}-\d{6}-a-blue-paper-boat\.png$/);
    expect(imageCalls[0]).toMatchObject({ prompt: "a blue paper boat", aspect_ratio: "16:9" });
    const edit = String(await tools.image_edit!.execute({ prompt: "make it red" }));
    expect(filesFromToolResult(edit)[0]?.kind).toBe("edited");
    expect(imageCalls[1]!.subject_reference).toBeDefined();
    const bad = String(await tools.image_edit!.execute({ prompt: "x", source: "uploads/r.pdf" }));
    expect(bad).toContain("不是 PNG");
    written.set("report.md", Buffer.from("# hi"));
    const shared = String(await tools.file_share!.execute({ path: "report.md", title: "周报" }));
    expect(filesFromToolResult(shared)[0]).toMatchObject({ name: "周报.md", kind: "shared", workspacePath: "report.md" });
    expect(String(await tools.file_share!.execute({ path: "missing.txt" }))).toContain("There is no file");
    const recent = String(await tools.chat_files_recent!.execute({ images_only: true }));
    expect(recent).toContain("你修改");
    expect(recent).not.toContain("r.pdf");
  });

  test("routes: owner-only fetch with safe headers, admin-only settings", async () => {
    const app = new Hono();
    let actor = { id: owner, email: "o@x", role: "member" as string };
    app.route(
      "/api/chat-files",
      files.routes(async (c, next) => {
        c.set("actor" as never, actor as never);
        await next();
      }),
    );
    const [first] = await files.list(owner, bot, { imagesOnly: true, limit: 1 });
    let res = await app.request(`/api/chat-files/${first!.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    res = await app.request(`/api/chat-files/${first!.id}?download=1`);
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
    const svg = await files.store(owner, bot, { kind: "upload", name: "x.svg", mimeType: "image/svg+xml", bytes: Buffer.from("<svg/>") });
    res = await app.request(`/api/chat-files/${svg.id}`);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect((await app.request("/api/chat-files/settings/image")).status).toBe(403);
    const form = new FormData();
    form.set("agentId", bot);
    form.set("file", new File([PNG], "up.png", { type: "image/png" }));
    res = await app.request("/api/chat-files", { method: "POST", body: form });
    expect(res.status).toBe(201);
    actor = { id: other, email: "x@x", role: "admin" };
    expect((await app.request(`/api/chat-files/${first!.id}`)).status).toBe(404);
    expect((await app.request("/api/chat-files/settings/image")).status).toBe(200);
  });

  test("list and GET /api/chat-files support before cursor pagination (CB-092)", async () => {
    const app = new Hono();
    app.route(
      "/api/chat-files",
      files.routes(async (c, next) => {
        c.set("actor" as never, { id: owner, email: "o@x", role: "member" } as never);
        await next();
      }),
    );
    const all = await files.list(owner, bot, { limit: 10 });
    expect(all.length).toBeGreaterThanOrEqual(2);
    // Ensure distinct timestamps so `before` strictly filters out the newest record
    const newest = all[0]!;
    const olderIso = new Date(Date.parse(newest.createdAt) - 60_000).toISOString();
    await database.$client.unsafe("UPDATE chisabot_chat_files SET created_at = $1 WHERE id = $2", [olderIso, all[1]!.id]);

    const refreshed = await files.list(owner, bot, { limit: 10 });
    const cursor = refreshed[0]!.createdAt;
    const page2 = await files.list(owner, bot, { limit: 10, before: cursor });
    expect(page2.some((f) => f.id === refreshed[0]!.id)).toBe(false);
    expect(page2.some((f) => f.id === all[1]!.id)).toBe(true);

    const res = await app.request(`/api/chat-files?agentId=${encodeURIComponent(bot)}&before=${encodeURIComponent(cursor)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { id: string }[] };
    expect(body.files.some((f) => f.id === refreshed[0]!.id)).toBe(false);
    expect(body.files.some((f) => f.id === all[1]!.id)).toBe(true);
  });
});
