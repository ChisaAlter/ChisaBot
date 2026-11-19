import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { toMessageContent } from "@/components/channels/channel-chat";
import { toVisibleChatItems } from "@/components/channels/chat-messages";
import {
  attachmentsConfigFor,
  chatFileRowId,
  FILE_PICKER_ACCEPT_WITH_DOCUMENTS,
  UPLOAD_FAILED_MESSAGE,
  uploadChatDocumentToBot,
} from "@/components/channels/composer/attachments";
import { attachmentUrl, MAX_IMAGE_BYTES } from "@/lib/channels/attachments";
import { deleteChatFile } from "@/lib/chat-files";
import type { Attachment } from "@/lib/chat/attachment-state";
import { attachmentIdsInContent } from "@/lib/chat/ui-memory";
import {
  ACCEPTED_CHAT_DOCUMENT_MIME,
  chatFileUrl,
  isChatDocumentFile,
  MAX_CHAT_FILE_BYTES,
} from "../../shared/chat-files";
import { installFetchBackedXhr } from "./fetch-backed-xhr";

const PDF_MIME = ACCEPTED_CHAT_DOCUMENT_MIME[0];
const DOCX_MIME = ACCEPTED_CHAT_DOCUMENT_MIME[1];

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;

beforeEach(installFetchBackedXhr);

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isChatDocumentFile", () => {
  test("按标准 MIME 识别 PDF 与 DOCX（忽略大小写与参数）", () => {
    expect(isChatDocumentFile("report.pdf", PDF_MIME)).toBe(true);
    expect(
      isChatDocumentFile("report.bin", "APPLICATION/PDF; charset=utf-8"),
    ).toBe(true);
    expect(isChatDocumentFile("spec.docx", DOCX_MIME)).toBe(true);
    expect(
      isChatDocumentFile("spec", `${DOCX_MIME.toUpperCase()}; name=spec.docx`),
    ).toBe(true);
  });

  test("浏览器未声明格式或声明 octet-stream 时按后缀兜底识别 .pdf / .docx", () => {
    expect(isChatDocumentFile("quarterly.PDF", "")).toBe(true);
    expect(
      isChatDocumentFile("contract.DOCX", "application/octet-stream"),
    ).toBe(true);
    expect(isChatDocumentFile("  manual.pdf  ", "binary/octet-stream")).toBe(
      true,
    );
  });

  test("明确声明为非文档格式或其他扩展名时返回 false", () => {
    expect(isChatDocumentFile("fake.pdf", "image/png")).toBe(false);
    expect(isChatDocumentFile("fake.docx", "application/zip")).toBe(false);
    expect(isChatDocumentFile("legacy.doc", "application/msword")).toBe(false);
    expect(isChatDocumentFile("legacy.doc", "")).toBe(false);
    expect(isChatDocumentFile("notes.txt", "")).toBe(false);
    expect(isChatDocumentFile("pdf", "")).toBe(false);
  });
});

describe("toMessageContent（chat-file 文档引用）", () => {
  test("带 metadata.chatFileId 的文档附件产出 /api/chat-files/<id> 而非 /api/attachments/<id>", () => {
    const pdf: Attachment = {
      id: "placeholder-pdf-1",
      type: "document",
      source: {
        type: "url",
        value: "/api/chat-files/cf-doc-1",
        mimeType: PDF_MIME,
      },
      filename: "architecture.pdf",
      status: "ready",
      metadata: {
        chatFileId: "cf-doc-1",
        filename: "architecture.pdf",
      },
    };

    const content = toMessageContent("请总结第三章要点", [pdf]);
    expect(Array.isArray(content)).toBe(true);
    const parts = content as unknown[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "请总结第三章要点" });
    expect(parts[1]).toEqual({
      type: "document",
      source: { type: "url", value: chatFileUrl("cf-doc-1") },
      metadata: {
        chatFileId: "cf-doc-1",
        filename: "architecture.pdf",
      },
    });
    expect(
      (parts[1] as { source: { value: string } }).source.value,
    ).not.toContain("/api/attachments/");
  });

  test("chat-file 与普通频道图片附件混发时各自产出正确路径，且对账与展示投影均可识别", () => {
    const image: Attachment = {
      id: "placeholder-img-1",
      type: "image",
      source: {
        type: "url",
        value: attachmentUrl("att-img-9"),
        mimeType: "image/png",
      },
      status: "ready",
      metadata: {
        attachmentId: "att-img-9",
        filename: "diagram.png",
      },
    };
    const docx: Attachment = {
      id: "placeholder-docx-1",
      type: "document",
      source: {
        type: "url",
        value: chatFileUrl("cf-docx-9"),
        mimeType: DOCX_MIME,
      },
      status: "ready",
      metadata: {
        chatFileId: "cf-docx-9",
        filename: "proposal.docx",
      },
    };

    const content = toMessageContent("", [image, docx]);
    expect(content).toEqual([
      {
        type: "image",
        source: { type: "url", value: "/api/attachments/att-img-9" },
        metadata: { attachmentId: "att-img-9", filename: "diagram.png" },
      },
      {
        type: "document",
        source: { type: "url", value: "/api/chat-files/cf-docx-9" },
        metadata: { chatFileId: "cf-docx-9", filename: "proposal.docx" },
      },
    ]);

    expect(attachmentIdsInContent(content)).toEqual([
      "att-img-9",
      "cf:cf-docx-9",
    ]);

    const visible = toVisibleChatItems([
      { id: "msg-1", role: "user", content } as Message,
    ]);
    expect(visible).toHaveLength(1);
    const first = visible[0];
    expect(first?.kind).toBe("attachments");
    if (first?.kind === "attachments") {
      expect(first.attachments[1]).toEqual({
        id: "msg-1:1",
        attachmentId: "cf-docx-9",
        url: "/api/chat-files/cf-docx-9",
        filename: "proposal.docx",
        modality: "document",
      });
    }
  });
});

describe("attachmentsConfigFor & uploadChatDocumentToBot", () => {
  test("传入 chatFileAgentId 时 maxSize 提升为 20MB，并将 PDF/DOCX 路由至 /api/chat-files", async () => {
    const requests: { path: string; method: string; body: FormData }[] = [];
    const uploadedAttachments: string[] = [];
    const uploadedChatFiles: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const form = init?.body as FormData;
      requests.push({
        path,
        method: init?.method ?? "GET",
        body: form,
      });
      if (path === "/api/chat-files") {
        const uploaded = form.get("file") as File;
        const id = uploaded.name.endsWith(".pdf") ? "cf-pdf-1" : "cf-docx-1";
        return jsonResponse(
          {
            file: {
              id,
              name: uploaded.name,
              mimeType: uploaded.type || DOCX_MIME,
              url: chatFileUrl(id),
            },
          },
          201,
        );
      }
      const uploaded = form.get("file") as File;
      return jsonResponse(
        {
          id: "att-png-1",
          name: uploaded.name,
          mimeType: "image/png",
        },
        201,
      );
    }) as unknown as typeof fetch;

    const withoutBot = attachmentsConfigFor(
      "chan-1",
      "group-1",
      () => {},
      () => {},
    );
    expect(withoutBot.maxSize).toBe(MAX_IMAGE_BYTES);

    const withBot = attachmentsConfigFor(
      "chan-1",
      "group-1",
      () => {},
      (id) => uploadedAttachments.push(id),
      undefined,
      undefined,
      "bot-alpha",
      (id) => uploadedChatFiles.push(id),
    );
    expect(withBot.maxSize).toBe(MAX_CHAT_FILE_BYTES);

    const pdfFile = new File(["%PDF-1.7"], "guide.pdf", { type: PDF_MIME });
    const docxNoMime = new File(["PK"], "plan.docx", { type: "" });
    const pngFile = new File(["png"], "shot.png", { type: "image/png" });

    const pdfResult = await withBot.onUpload?.(pdfFile);
    const docxResult = await withBot.onUpload?.(docxNoMime);
    const pngResult = await withBot.onUpload?.(pngFile);

    expect(pdfResult).toEqual({
      type: "url",
      value: "/api/chat-files/cf-pdf-1",
      mimeType: PDF_MIME,
      metadata: { chatFileId: "cf-pdf-1", filename: "guide.pdf" },
    });
    expect(chatFileRowId(pdfResult)).toBe("cf-pdf-1");

    expect(docxResult).toEqual({
      type: "url",
      value: "/api/chat-files/cf-docx-1",
      mimeType: DOCX_MIME,
      metadata: { chatFileId: "cf-docx-1", filename: "plan.docx" },
    });

    expect(pngResult).toEqual({
      type: "url",
      value: "/api/attachments/att-png-1",
      mimeType: "image/png",
      metadata: { attachmentId: "att-png-1", filename: "shot.png" },
    });

    expect(requests.map((entry) => entry.path)).toEqual([
      "/api/chat-files",
      "/api/chat-files",
      "/api/channels/chan-1/attachments",
    ]);
    expect(requests[0]?.body.get("agentId")).toBe("bot-alpha");
    expect(requests[1]?.body.get("agentId")).toBe("bot-alpha");
    expect(requests[2]?.body.get("uploadGroup")).toBe("group-1");

    expect(uploadedChatFiles).toEqual(["cf-pdf-1", "cf-docx-1"]);
    expect(uploadedAttachments).toEqual(["att-png-1"]);
  });

  test("uploadChatDocumentToBot 校验服务端错误与非法响应体", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: "文件超过 20.0 MB。" }, 413)) as unknown as typeof fetch;

    await expect(
      uploadChatDocumentToBot("bot-alpha")(
        new File(["%PDF"], "big.pdf", { type: PDF_MIME }),
      ),
    ).rejects.toThrow("文件超过 20.0 MB。");

    globalThis.fetch = (async () =>
      jsonResponse(
        {
          file: {
            id: "cf-bad",
            name: "evil.pdf",
            mimeType: PDF_MIME,
            url: "https://evil.example/a.pdf",
          },
        },
        201,
      )) as unknown as typeof fetch;

    await expect(
      uploadChatDocumentToBot("bot-alpha")(
        new File(["%PDF"], "evil.pdf", { type: PDF_MIME }),
      ),
    ).rejects.toThrow(UPLOAD_FAILED_MESSAGE);
  });

  test("FILE_PICKER_ACCEPT_WITH_DOCUMENTS 包含 PDF/DOCX MIME 与后缀且不含 SVG", () => {
    const offered = FILE_PICKER_ACCEPT_WITH_DOCUMENTS.split(",");
    expect(offered).toContain(PDF_MIME);
    expect(offered).toContain(DOCX_MIME);
    expect(offered).toContain(".pdf");
    expect(offered).toContain(".docx");
    expect(offered).not.toContain("image/svg+xml");
    expect(offered).not.toContain(".svg");
  });

  test("deleteChatFile 调用 DELETE /api/chat-files/:id 且忽略 404 与网络失败", async () => {
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    await expect(deleteChatFile("cf-gone-1")).resolves.toBeUndefined();
    expect(calls).toEqual([
      { url: "/api/chat-files/cf-gone-1", method: "DELETE" },
    ]);

    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await expect(deleteChatFile("cf-net-err")).resolves.toBeUndefined();
  });
});
