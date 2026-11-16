import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { deflateRawSync, deflateSync } from "node:zlib";
import {
  chunkDocumentText,
  createChatFiles,
  extractDocxText,
  extractPdfText,
} from "../src/chat-files/service";
import {
  createSessionSearchTools,
  type SessionThreadRow,
} from "../src/conversations/session-search";
import type { Database } from "../src/db/client";
import { REFUSAL_MARKER } from "../src/plugins/tools";

type ZipInputEntry = {
  name: string;
  content: Buffer;
  method: 0 | 8;
  useDataDescriptor?: boolean;
};

/** 构造符合 PKZIP 规范的测试用压缩包（支持 method 0 与 method 8，以及可选 Data Descriptor）。 */
function buildZip(
  entries: readonly ZipInputEntry[],
  options: { includeCentralDirectory?: boolean } = {},
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const payload =
      entry.method === 8 ? deflateRawSync(entry.content) : entry.content;
    const flags = entry.useDataDescriptor ? 0x08 : 0;

    const lfh = Buffer.alloc(30 + nameBytes.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(entry.method, 8);
    lfh.writeUInt32LE(entry.useDataDescriptor ? 0 : payload.length, 18);
    lfh.writeUInt32LE(entry.useDataDescriptor ? 0 : entry.content.length, 22);
    lfh.writeUInt16LE(nameBytes.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBytes.copy(lfh, 30);

    const dd = entry.useDataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (entry.useDataDescriptor) {
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(0, 4);
      dd.writeUInt32LE(payload.length, 8);
      dd.writeUInt32LE(entry.content.length, 12);
    }

    localChunks.push(lfh, payload, dd);

    const cdh = Buffer.alloc(46 + nameBytes.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(flags, 8);
    cdh.writeUInt16LE(entry.method, 10);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(entry.content.length, 24);
    cdh.writeUInt16LE(nameBytes.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBytes.copy(cdh, 46);
    centralChunks.push(cdh);

    offset += lfh.length + payload.length + dd.length;
  }

  if (options.includeCentralDirectory === false) {
    return Buffer.concat(localChunks);
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function encodeUtf16BeHex(text: string): string {
  const bytes: string[] = ["FE", "FF"];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes.push(((code >> 8) & 0xff).toString(16).padStart(2, "0"));
    bytes.push((code & 0xff).toString(16).padStart(2, "0"));
  }
  return `<${bytes.join("")}>`;
}

function buildPdfWithStreams(
  streams: readonly {
    dictExtra?: string;
    body: Buffer;
    compress?: boolean;
  }[],
): Buffer {
  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  streams.forEach((stream, index) => {
    const raw = stream.compress ? deflateSync(stream.body) : stream.body;
    const filter = stream.compress ? "/Filter /FlateDecode " : "";
    const extra = stream.dictExtra ? `${stream.dictExtra} ` : "";
    chunks.push(
      Buffer.from(
        `${index + 1} 0 obj\n<< /Length ${raw.length} ${filter}${extra}>>\nstream\n`,
        "latin1",
      ),
      raw,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    );
  });
  chunks.push(Buffer.from("%%EOF\n", "latin1"));
  return Buffer.concat(chunks);
}

type StoredFileRow = {
  id: string;
  owner_user_id: string;
  agent_id: string;
  kind: "upload" | "generated" | "edited" | "shared";
  name: string;
  mime_type: string;
  size_bytes: number;
  bytes: Uint8Array;
  workspace_path: string | null;
  prompt: string | null;
  model: string | null;
  source_id: string | null;
  created_at: Date;
};

type StoredChunkRow = {
  file_id: string;
  owner_user_id: string;
  chunk_index: number;
  content: string;
  created_at: Date;
};

function createStubDatabase(
  options: {
    withChunksTable?: boolean;
    withThreadsTable?: boolean;
    threads?: SessionThreadRow[];
  } = {},
) {
  const withChunksTable = options.withChunksTable ?? true;
  const withThreadsTable = options.withThreadsTable ?? true;
  const files: StoredFileRow[] = [];
  const chunks: StoredChunkRow[] = [];
  const threads: SessionThreadRow[] = [...(options.threads ?? [])];
  const queries: { sql: string; params: unknown[] }[] = [];

  const unsafe = async <T = unknown>(
    query: string,
    params: unknown[] = [],
  ): Promise<T> => {
    queries.push({ sql: query, params });
    const normalized = query.replace(/\s+/g, " ").trim();

    if (/^(CREATE TABLE|CREATE INDEX)/i.test(normalized)) {
      return [] as T;
    }

    if (
      normalized.includes("FROM chisabot_image_settings") ||
      normalized.includes("FROM chisabot_media_models")
    ) {
      return [] as T;
    }

    if (
      normalized.startsWith(
        "SELECT id FROM chisabot_chat_files WHERE owner_user_id = $1 AND agent_id = $2 AND workspace_path = $3",
      )
    ) {
      const [owner, agentId, path] = params as [string, string, string];
      return files
        .filter(
          (row) =>
            row.owner_user_id === owner &&
            row.agent_id === agentId &&
            row.workspace_path === path,
        )
        .map((row) => ({ id: row.id })) as T;
    }

    if (normalized.startsWith("INSERT INTO chisabot_chat_files")) {
      const [
        id,
        owner,
        agentId,
        kind,
        name,
        mimeType,
        sizeBytes,
        bytes,
        workspacePath,
        prompt,
        model,
        sourceId,
      ] = params as [
        string,
        string,
        string,
        StoredFileRow["kind"],
        string,
        string,
        number,
        Uint8Array,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      const row: StoredFileRow = {
        id,
        owner_user_id: owner,
        agent_id: agentId,
        kind,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        bytes,
        workspace_path: workspacePath,
        prompt,
        model,
        source_id: sourceId,
        created_at: new Date(),
      };
      files.push(row);
      return [row] as T;
    }

    if (
      normalized.includes(
        "FROM chisabot_chat_files WHERE id = $1 AND owner_user_id = $2",
      )
    ) {
      const [id, owner] = params as [string, string];
      return files.filter(
        (row) => row.id === id && row.owner_user_id === owner,
      ) as T;
    }

    if (normalized.includes("chisabot_chat_file_chunks")) {
      if (!withChunksTable) {
        const err = new Error(
          'relation "chisabot_chat_file_chunks" does not exist',
        );
        Object.assign(err, { code: "42P01" });
        throw err;
      }
      if (normalized.startsWith("INSERT INTO chisabot_chat_file_chunks")) {
        const [fileId, owner, chunkIndex, content] = params as [
          string,
          string,
          number,
          string,
        ];
        const existing = chunks.findIndex(
          (item) => item.file_id === fileId && item.chunk_index === chunkIndex,
        );
        const row: StoredChunkRow = {
          file_id: fileId,
          owner_user_id: owner,
          chunk_index: chunkIndex,
          content,
          created_at: new Date(),
        };
        if (existing >= 0) chunks[existing] = row;
        else chunks.push(row);
        return [] as T;
      }
      if (
        normalized.startsWith(
          "SELECT 1 AS ok FROM chisabot_chat_file_chunks WHERE owner_user_id = $1",
        )
      ) {
        const [owner] = params as [string];
        return chunks.some((item) => item.owner_user_id === owner)
          ? ([{ ok: 1 }] as T)
          : ([] as T);
      }
      if (
        normalized.includes(
          "FROM chisabot_chat_file_chunks WHERE file_id = $1 AND owner_user_id = $2",
        )
      ) {
        const [fileId, owner] = params as [string, string];
        return chunks
          .filter(
            (item) => item.file_id === fileId && item.owner_user_id === owner,
          )
          .sort((a, b) => a.chunk_index - b.chunk_index) as T;
      }
      if (normalized.includes("FROM chisabot_chat_file_chunks c")) {
        const owner = params[0] as string;
        const targetFileId = params[1] as string | undefined;
        return chunks
          .filter(
            (item) =>
              item.owner_user_id === owner &&
              (!targetFileId || item.file_id === targetFileId),
          )
          .map((item) => ({
            file_id: item.file_id,
            owner_user_id: item.owner_user_id,
            chunk_index: item.chunk_index,
            content: item.content,
            file_name:
              files.find(
                (f) => f.id === item.file_id && f.owner_user_id === owner,
              )?.name ?? null,
          })) as T;
      }
      if (normalized.startsWith("DELETE FROM chisabot_chat_file_chunks")) {
        const [fileId, owner] = params as [string, string];
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          if (
            chunks[i]?.file_id === fileId &&
            chunks[i]?.owner_user_id === owner
          ) {
            chunks.splice(i, 1);
          }
        }
        return [] as T;
      }
    }

    if (normalized.includes("chisabot_local_threads")) {
      if (!withThreadsTable) {
        const err = new Error(
          'relation "chisabot_local_threads" does not exist',
        );
        Object.assign(err, { code: "42P01" });
        throw err;
      }
      const owner = params[0] as string;
      const excludedId = params[1] as string | undefined;
      return threads.filter((row) => {
        if (row.owner_user_id !== owner) return false;
        if ((row.thread_kind ?? "primary") !== "primary") return false;
        if (row.id.startsWith("worker-")) return false;
        if (excludedId && row.id === excludedId) return false;
        return true;
      }) as T;
    }

    return [] as T;
  };

  const database = {
    $client: { unsafe },
  } as unknown as Database;

  return { database, files, chunks, threads, queries };
}

describe("zero-dependency DOCX / PDF extraction and chunking", () => {
  test("extractDocxText supports stored (method 0) and deflate (method 8) ZIP entries with XML entities", () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>季度预算报告 &amp; 审批说明</w:t></w:r></w:p>
          <w:p><w:r><w:t>范围：&lt;100万&gt; &quot;重点项目&quot; &#20013;&#x6587; &apos;OK&apos;</w:t></w:r></w:p>
          <w:p><w:r><w:t>列1</w:t><w:tab/><w:t>列2</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const headerXml = `<w:hdr><w:p><w:r><w:t>机密页眉内容</w:t></w:r></w:p></w:hdr>`;
    const stylesXml = `<w:styles><w:style><w:name w:val="NormalStyleDoNotLeak"/></w:style></w:styles>`;

    // 1) 未压缩 method 0 + 仅 Local File Headers（无 Central Directory）
    const method0Zip = buildZip(
      [
        {
          name: "word/styles.xml",
          content: Buffer.from(stylesXml, "utf8"),
          method: 0,
        },
        {
          name: "word/document.xml",
          content: Buffer.from(documentXml, "utf8"),
          method: 0,
        },
      ],
      { includeCentralDirectory: false },
    );
    const extracted0 = extractDocxText(method0Zip);
    expect(extracted0).toContain("季度预算报告 & 审批说明");
    expect(extracted0).toContain("范围：<100万> \"重点项目\" 中文 'OK'");
    expect(extracted0).toContain("列1\t列2");
    expect(extracted0).not.toContain("NormalStyleDoNotLeak");

    // 2) method 8 deflate + Data Descriptor（依赖 Central Directory 获取真实偏移和大小）
    const method8Zip = buildZip([
      {
        name: "word/header1.xml",
        content: Buffer.from(headerXml, "utf8"),
        method: 8,
        useDataDescriptor: true,
      },
      {
        name: "word/document.xml",
        content: Buffer.from(documentXml, "utf8"),
        method: 8,
        useDataDescriptor: true,
      },
    ]);
    const extracted8 = extractDocxText(method8Zip);
    expect(extracted8).toContain("季度预算报告 & 审批说明");
    expect(extracted8).toContain("机密页眉内容");
  });

  test("extractDocxText safely returns empty string on corrupted or non-DOCX input", () => {
    expect(extractDocxText(new Uint8Array(0))).toBe("");
    expect(extractDocxText(Buffer.from("plain text not a zip"))).toBe("");

    const brokenDeflateZip = buildZip([
      {
        name: "word/document.xml",
        content: Buffer.from("<w:document/>", "utf8"),
        method: 8,
      },
    ]);
    // 破坏 deflate 压缩流尾部字节
    brokenDeflateZip.fill(0xff, 50, 70);
    expect(() => extractDocxText(brokenDeflateZip)).not.toThrow();
    expect(extractDocxText(brokenDeflateZip)).toBe("");
  });

  test("extractPdfText extracts uncompressed and FlateDecode BT/ET streams with escapes and UTF-16BE hex", () => {
    const stream1 = Buffer.from(
      `BT
/F1 12 Tf
1 0 0 1 72 720 Tm
(Line1\\nLine2\\tTabbed \\(nested\\) \\\\ backslash) Tj
0 -20 Td
(BT inside literal string ET) Tj
ET`,
      "utf8",
    );
    const chineseHex = encodeUtf16BeHex("中文财务报表与架构评审");
    const stream2 = Buffer.from(
      `BT
/F2 12 Tf
[(Quarterly) -250 (Revenue)] TJ
0 -18 Td
${chineseHex} Tj
ET`,
      "utf8",
    );
    const corruptedStream = Buffer.from([0x78, 0x9c, 0xff, 0xee, 0xdd, 0x01]);

    const pdf = buildPdfWithStreams([
      { body: stream1, compress: false },
      {
        body: corruptedStream,
        dictExtra: "/Filter /FlateDecode",
        compress: false,
      },
      { body: stream2, compress: true },
    ]);

    const text = extractPdfText(pdf);
    expect(text).toContain("Line1\nLine2\tTabbed (nested) \\ backslash");
    expect(text).toContain("BT inside literal string ET");
    expect(text).toContain("Quarterly Revenue");
    expect(text).toContain("中文财务报表与架构评审");

    expect(extractPdfText(Buffer.from("not a pdf"))).toBe("");
    expect(() =>
      extractPdfText(
        Buffer.from(
          "%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n\x78\x9c\x00\xff\nendstream",
        ),
      ),
    ).not.toThrow();
  });

  test("chunkDocumentText splits long text with overlap and surrogate safety", () => {
    expect(chunkDocumentText("   \n  ")).toEqual([]);
    const paragraphA = `第一部分：云原生架构与容灾演练方案。${"架构细节与指标监控。".repeat(90)}`;
    const paragraphB = `第二部分：预算审批与跨团队协同 🚀 里程碑。${"交付验收清单。".repeat(90)}`;
    const combined = `${paragraphA}\n\n${paragraphB}`;

    const chunks = chunkDocumentText(combined, 1500, 150);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const piece of chunks) {
      expect(piece.length).toBeLessThanOrEqual(1500);
    }
    const tailOfFirst = chunks[0]?.slice(-60) ?? "";
    expect(chunks[1]).toContain(tailOfFirst.slice(-30));
  });
});

describe("chat-files document chunking, loadForTurn optimization, and chat_file_search", () => {
  test("uploads DOCX & PDF into chunks, summarizes loadForTurn, and enforces owner isolation in chat_file_search", async () => {
    const { database, chunks, queries } = createStubDatabase();
    const ownerA = `user-a-${randomUUID().slice(0, 6)}`;
    const ownerB = `user-b-${randomUUID().slice(0, 6)}`;
    const bot = `agent_${randomUUID().slice(0, 8)}`;

    const files = createChatFiles(database, {
      encryptionKey: Buffer.alloc(32, 7).toString("base64"),
      env: {},
      ownsBot: async (owner, agentId) =>
        (owner === ownerA || owner === ownerB) && agentId === bot,
      workspace: {
        write: async () => true,
        read: async () => ({ name: "noop.txt", bytes: Buffer.from("ok") }),
      },
    });
    await files.ensure();

    // 没上传任何可检索文档前，不额外暴露 chat_file_search，保持原有工具面兼容
    const initialTools = (await files.tools(ownerA, bot))
      .map((t) => t.name)
      .sort();
    expect(initialTools).toEqual(["chat_files_recent", "file_share"]);

    // 构造多段落长 DOCX (> 4000 字)
    const section1 = `第一章 项目背景与架构选型。\n${"采用 Bun 与 PostgreSQL 搭建高可用网关。".repeat(60)}`;
    const section2 = `第二章 核心风控规则：单笔付款超过人民币五万元必须经过双人审批确认。\n${"审计日志保留至少一百八十天。".repeat(60)}`;
    const section3 = `第三章 灾备演练记录与 RTO 目标：核心服务恢复时间不超过十五分钟。\n${"演练验证全链路可观测性。".repeat(50)}`;
    const docxXml = `<w:document><w:body><w:p><w:t>${section1}</w:t></w:p><w:p><w:t>${section2}</w:t></w:p><w:p><w:t>${section3}</w:t></w:p></w:body></w:document>`;
    const docxBytes = buildZip([
      {
        name: "word/document.xml",
        content: Buffer.from(docxXml, "utf8"),
        method: 8,
      },
    ]);

    const uploadedDocx = await files.upload(ownerA, bot, {
      name: "架构规范.docx",
      bytes: docxBytes,
    });
    const docxChunks = chunks.filter((c) => c.file_id === uploadedDocx.id);
    expect(docxChunks.length).toBeGreaterThan(1);

    // 验证 loadForTurn 返回受控摘要而不是全量数千字正文
    const turnAttachment = await files.loadForTurn(ownerA, uploadedDocx.id);
    expect(turnAttachment?.mimeType).toBe("text/plain");
    const summaryText = turnAttachment?.bytes.toString("utf8") ?? "";
    expect(summaryText.length).toBeLessThan(900);
    expect(summaryText).toContain("架构规范.docx");
    expect(summaryText).toContain(`${docxChunks.length} 块`);
    expect(summaryText).toContain("首段预览");
    expect(summaryText).toContain("chat_file_search");
    expect(summaryText).not.toContain("恢复时间不超过十五分钟");

    // 小文件保持紧凑直接内联，兼容既有行为
    const smallCsv = await files.upload(ownerA, bot, {
      name: "small.csv",
      bytes: Buffer.from("a,b\n1,2", "utf8"),
    });
    const smallLoaded = await files.loadForTurn(ownerA, smallCsv.id);
    expect(smallLoaded?.bytes.toString("utf8")).toContain("1,2");

    // 另一用户上传自己的 PDF 文档
    const pdfHex = encodeUtf16BeHex(
      `机密合同：乙方的违约金比例为百分之三十，且独家密钥为 SECRET_OWNER_B_9981。${"保密条款细节。".repeat(80)}`,
    );
    const pdfBytes = buildPdfWithStreams([
      {
        body: Buffer.from(`BT\n/F1 12 Tf\n${pdfHex} Tj\nET`, "utf8"),
        compress: true,
      },
    ]);
    const uploadedPdfB = await files.upload(ownerB, bot, {
      name: "机密合同.pdf",
      bytes: pdfBytes,
    });
    expect(chunks.some((c) => c.file_id === uploadedPdfB.id)).toBe(true);

    // ownerA 现在拥有已分块文档，chat_file_search 出现并精准召回分块
    const toolsA = await files.tools(ownerA, bot);
    const searchToolA = toolsA.find((t) => t.name === "chat_file_search");
    expect(searchToolA).toBeDefined();
    expect(searchToolA?.ref).toBe("chat-files/chat_file_search");
    expect(searchToolA?.effect).toBe("read");

    const hitRaw = await searchToolA?.execute({
      query: "双人审批",
      fileId: uploadedDocx.id,
      limit: 3,
    });
    const hitParsed = JSON.parse(hitRaw ?? "{}") as {
      total: number;
      results: {
        fileId: string;
        fileName: string;
        chunkIndex: number;
        excerpt: string;
      }[];
    };
    expect(hitParsed.total).toBeGreaterThanOrEqual(1);
    expect(hitParsed.results[0]?.fileId).toBe(uploadedDocx.id);
    expect(hitParsed.results[0]?.fileName).toBe("架构规范.docx");
    expect(typeof hitParsed.results[0]?.chunkIndex).toBe("number");
    expect(hitParsed.results[0]?.excerpt).toContain("双人审批");

    // 跨用户隔离：ownerA 即使传入 ownerB 的 fileId 或搜 ownerB 的关键词也绝无结果
    const crossUserRaw = await searchToolA?.execute({
      query: "SECRET_OWNER_B_9981",
      fileId: uploadedPdfB.id,
    });
    expect(crossUserRaw).not.toContain("SECRET_OWNER_B_9981");
    expect(crossUserRaw).not.toContain("百分之三十");
    expect(
      queries.some(
        (q) =>
          q.sql.includes("chisabot_chat_file_chunks") &&
          q.sql.includes("owner_user_id = $1"),
      ),
    ).toBe(true);
  });

  test("upload and loadForTurn stay resilient when stub DB lacks chisabot_chat_file_chunks", async () => {
    const { database } = createStubDatabase({ withChunksTable: false });
    const owner = "stub-owner";
    const bot = "stub-bot";
    const files = createChatFiles(database, {
      encryptionKey: Buffer.alloc(32, 3).toString("base64"),
      env: {},
      ownsBot: async () => true,
    });

    const docx = await files.upload(owner, bot, {
      name: "notes.docx",
      bytes: buildZip([
        {
          name: "word/document.xml",
          content: Buffer.from(
            `<w:document><w:body><w:p><w:t>${"测试段落。".repeat(700)}</w:t></w:p></w:body></w:document>`,
            "utf8",
          ),
          method: 8,
        },
      ]),
    });
    expect(docx.name).toBe("notes.docx");
    const loaded = await files.loadForTurn(owner, docx.id);
    expect(loaded?.bytes.toString("utf8")).toContain("chat_file_search");
    const toolNames = (await files.tools(owner, bot)).map((t) => t.name);
    expect(toolNames).not.toContain("chat_file_search");
  });
});

describe("session_search tool", () => {
  test("recalls owner primary threads, strips base64/internal objects, and isolates side/worker/other-user threads", async () => {
    const ownerA = "user-alpha";
    const ownerB = "user-beta";
    const currentId = "thread-current";
    const hugePadding = "无关历史背景填充文本。".repeat(80);
    const fakeBase64 = "A".repeat(220);

    const threads: SessionThreadRow[] = [
      {
        id: "thread-pg-migration",
        owner_user_id: ownerA,
        name: "PostgreSQL 数据库迁移与索引优化",
        thread_kind: "primary",
        updated_at: "2026-10-15T10:00:00.000Z",
        messages: [
          {
            id: "m1",
            role: "user",
            content: [
              {
                type: "text",
                text: `${hugePadding} 我们上次定下的 PostgreSQL 数据库迁移方案里，要求零停机切换并保留 pgvector 索引。`,
              },
              {
                type: "image",
                source: {
                  type: "data",
                  value: `data:image/png;base64,${fakeBase64}`,
                },
              },
            ],
          },
          {
            id: "m2",
            role: "assistant",
            content: `确认，已记录数据库迁移窗口为周日凌晨两点。data:image/png;base64,${fakeBase64} ${fakeBase64}`,
          },
        ],
      },
      {
        id: "thread-expense",
        owner_user_id: ownerA,
        name: null,
        thread_kind: "primary",
        updated_at: "2026-10-14T09:00:00.000Z",
        messages: [
          {
            id: "m3",
            role: "user",
            content: "差旅报销审批需要附上电子发票 PDF 吗？",
          },
          {
            id: "m4",
            role: "assistant",
            content: "是的，差旅报销审批超过两千元需要财务总监复核。",
          },
        ],
      },
      {
        id: currentId,
        owner_user_id: ownerA,
        name: "当前正在讨论数据库迁移",
        thread_kind: "primary",
        updated_at: "2026-10-16T12:00:00.000Z",
        messages: [
          {
            id: "m5",
            role: "user",
            content: "PostgreSQL 数据库迁移 CURRENT_THREAD_SENTINEL",
          },
        ],
      },
      {
        id: "side_1234",
        owner_user_id: ownerA,
        name: "侧边问答数据库迁移",
        thread_kind: "side",
        updated_at: "2026-10-16T11:00:00.000Z",
        messages: [
          {
            id: "m6",
            role: "user",
            content: "PostgreSQL 数据库迁移 SIDE_THREAD_SENTINEL",
          },
        ],
      },
      {
        id: "worker-bg-99",
        owner_user_id: ownerA,
        name: "后台任务数据库迁移",
        thread_kind: null,
        updated_at: "2026-10-16T11:30:00.000Z",
        messages: [
          {
            id: "m7",
            role: "assistant",
            content: "PostgreSQL 数据库迁移 WORKER_THREAD_SENTINEL",
          },
        ],
      },
      {
        id: "thread-other-user",
        owner_user_id: ownerB,
        name: "别人的数据库迁移秘密",
        thread_kind: "primary",
        updated_at: "2026-10-16T11:45:00.000Z",
        messages: [
          {
            id: "m8",
            role: "user",
            content: "PostgreSQL 数据库迁移 OTHER_USER_SECRET_SENTINEL",
          },
        ],
      },
    ];

    const { database, queries } = createStubDatabase({ threads });
    const tools = createSessionSearchTools({
      database,
      ownerUserId: ownerA,
      currentThreadId: currentId,
    });
    expect(tools).toHaveLength(1);
    const sessionSearch = tools[0];
    expect(sessionSearch?.name).toBe("session_search");
    expect(sessionSearch?.ref).toBe("conversations/session_search");
    expect(sessionSearch?.effect).toBe("read");

    const raw = await sessionSearch?.execute({
      query: "PostgreSQL 数据库迁移",
      limit: 5,
    });
    const parsed = JSON.parse(raw ?? "{}") as {
      total: number;
      results: {
        threadId: string;
        title: string;
        updatedAt: string;
        matchedExcerpt: string;
      }[];
    };

    expect(parsed.total).toBe(1);
    expect(parsed.results[0]).toMatchObject({
      threadId: "thread-pg-migration",
      title: "PostgreSQL 数据库迁移与索引优化",
      updatedAt: "2026-10-15T10:00:00.000Z",
    });
    expect(parsed.results[0]?.matchedExcerpt).toContain("数据库迁移");
    expect(parsed.results[0]?.matchedExcerpt.length).toBeLessThan(350);
    expect(raw).not.toContain(fakeBase64);
    expect(raw).not.toContain("data:image/png;base64");
    expect(raw).not.toContain("CURRENT_THREAD_SENTINEL");
    expect(raw).not.toContain("SIDE_THREAD_SENTINEL");
    expect(raw).not.toContain("WORKER_THREAD_SENTINEL");
    expect(raw).not.toContain("OTHER_USER_SECRET_SENTINEL");

    const sqlLog = queries[0]?.sql ?? "";
    expect(sqlLog).toContain("owner_user_id = $1");
    expect(sqlLog).toContain("COALESCE(thread_kind, 'primary') = 'primary'");
    expect(sqlLog).toContain("id NOT LIKE 'worker-%'");

    // 测试无名称线程用首条用户消息兜底标题，以及中文关键词召回
    const expenseRaw = await sessionSearch?.execute({ query: "报销审批" });
    const expenseParsed = JSON.parse(expenseRaw ?? "{}") as {
      results: { threadId: string; title: string; matchedExcerpt: string }[];
    };
    expect(expenseParsed.results[0]?.threadId).toBe("thread-expense");
    expect(expenseParsed.results[0]?.title).toContain("差旅报销审批");
    expect(expenseParsed.results[0]?.matchedExcerpt).toContain("财务总监复核");

    // 检索 base64 内容本身不应命中
    const base64Raw = await sessionSearch?.execute({
      query: fakeBase64.slice(0, 60),
    });
    const base64Parsed = JSON.parse(base64Raw ?? "{}") as { total: number };
    expect(base64Parsed.total).toBe(0);

    // 参数校验
    const badArgs = await sessionSearch?.execute({ query: "   " });
    expect(badArgs).toContain(REFUSAL_MARKER);
  });

  test("enforces limit bounds (default 5, max 20) and handles missing table cleanly", async () => {
    const manyThreads: SessionThreadRow[] = Array.from(
      { length: 25 },
      (_, index) => ({
        id: `thread-${index}`,
        owner_user_id: "user-limit",
        name: `周会记录 #${index}`,
        thread_kind: "primary",
        updated_at: new Date(1_760_000_000_000 + index * 1000).toISOString(),
        messages: [
          {
            id: `u-${index}`,
            role: "user",
            content: `讨论周会记录第 ${index} 期安排`,
          },
        ],
      }),
    );
    const { database } = createStubDatabase({ threads: manyThreads });
    const [tool] = createSessionSearchTools({
      database,
      ownerUserId: "user-limit",
    });

    const defaultRes = JSON.parse(
      (await tool?.execute({ query: "周会记录" })) ?? "{}",
    ) as { results: unknown[] };
    expect(defaultRes.results).toHaveLength(5);

    const cappedRes = JSON.parse(
      (await tool?.execute({ query: "周会记录", limit: 50 })) ?? "{}",
    ) as { results: unknown[] };
    expect(cappedRes.results).toHaveLength(20);

    const missingDb = createStubDatabase({ withThreadsTable: false });
    const [missingTool] = createSessionSearchTools({
      database: missingDb.database,
      ownerUserId: "user-limit",
    });
    const emptyRes = JSON.parse(
      (await missingTool?.execute({ query: "周会记录" })) ?? "{}",
    ) as { total: number; results: unknown[] };
    expect(emptyRes.total).toBe(0);
    expect(emptyRes.results).toEqual([]);
  });
});
