import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  DOCX_MIME,
  DOCX_PREVIEW_MAX_BYTES,
  DocxPreviewBody,
  docxTooLarge,
  isDocxFile,
} from "@/components/rich-previews/docx-preview";
import { FileCard } from "@/components/rich-previews/rich-previews";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  }
});

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
});

describe("docx preview helpers (CB-089)", () => {
  test("isDocxFile matches .docx extension or DOCX MIME and rejects legacy .doc / pdf", () => {
    expect(isDocxFile("docx", undefined)).toBe(true);
    expect(isDocxFile("", DOCX_MIME)).toBe(true);
    expect(isDocxFile("doc", "application/msword")).toBe(false);
    expect(isDocxFile("pdf", "application/pdf")).toBe(false);
  });

  test("docxTooLarge enforces 10 MB ceiling", () => {
    expect(docxTooLarge(null)).toBe(false);
    expect(docxTooLarge(undefined)).toBe(false);
    expect(docxTooLarge(DOCX_PREVIEW_MAX_BYTES)).toBe(false);
    expect(docxTooLarge(DOCX_PREVIEW_MAX_BYTES + 1)).toBe(true);
  });
});

describe("FileCard & DocxPreviewBody (CB-089)", () => {
  test("same-origin .docx FileCard exposes preview button and data-preview=docx", () => {
    const { container, getByTestId } = render(
      <FileCard
        mimeType={DOCX_MIME}
        name="季度报告.docx"
        probeSize={false}
        size={128 * 1024}
        url="/api/chat-files/1/report.docx"
      />,
    );
    const card = container.querySelector(".rp-file");
    expect(card?.getAttribute("data-preview")).toBe("docx");
    expect(getByTestId("file-preview")).toBeTruthy();
  });

  test("external .docx FileCard does not offer inline preview", () => {
    const { container, queryByTestId } = render(
      <FileCard
        mimeType={DOCX_MIME}
        name="外部报告.docx"
        probeSize={false}
        size={128 * 1024}
        url="https://example.com/report.docx"
      />,
    );
    const card = container.querySelector(".rp-file");
    expect(card?.getAttribute("data-preview")).toBeNull();
    expect(queryByTestId("file-preview")).toBeNull();
  });

  test("DocxPreviewBody immediately shows too-large hint when knownBytes exceeds 10 MB", () => {
    const { container } = render(
      <DocxPreviewBody
        knownBytes={DOCX_PREVIEW_MAX_BYTES + 1024}
        url="/api/chat-files/1/huge.docx"
      />,
    );
    const root = container.querySelector(".rp-docx");
    expect(root?.getAttribute("data-state")).toBe("too-large");
    expect(root?.textContent).toContain("超过 10 MB");
  });
});
