import { describe, expect, test } from "bun:test";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "@/lib/channels/attachments";
import {
  ACCEPTED_CHAT_DOCUMENT_MIME,
  MAX_CHAT_FILE_BYTES,
} from "../../../../../shared/chat-files";
import { screenPickedFiles } from "./picked-files";

const DOCX_MIME = ACCEPTED_CHAT_DOCUMENT_MIME[1];

function file(name: string, type: string, size = 3): File {
  return new File(["x".repeat(size)], name, { type });
}

function sizedFile(name: string, type: string, size: number): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("screenPickedFiles", () => {
  test("accepts a PNG under the ceiling", () => {
    const png = file("photo.png", "image/png");
    const result = screenPickedFiles([png], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([png]);
    expect(result.rejected).toEqual([]);
  });

  test("rejects an SVG with a reason naming the script risk", () => {
    const svg = file("logo.svg", "image/svg+xml");
    const result = screenPickedFiles([svg], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/SVG/);
    expect(result.rejected[0].name).toBe("logo.svg");
  });

  /**
   * The wording used to compare `file.type` raw while `classifyAttachment` — and the server, and
   * the SDK's accept check — all normalise first. An SVG off a clipboard arrives as
   * `image/svg+xml;charset=utf-8`, so it was still refused, but with the generic "an image format
   * that is not supported" instead of the one sentence that says WHY this one in particular:
   * an SVG can carry script. The person is left thinking their editor exported the wrong format.
   */
  test("keeps the script-risk wording for an SVG whose type carries a charset", () => {
    const svg = file("logo.svg", "image/svg+xml;charset=utf-8");
    const result = screenPickedFiles([svg], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/SVG/);
  });

  test("keeps the script-risk wording for an SVG whose type differs only in case", () => {
    const svg = file("logo.svg", "image/png");
    Object.defineProperty(svg, "type", { value: "IMAGE/SVG+XML" });
    const result = screenPickedFiles([svg], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/SVG/);
  });

  test("rejects an oversized text file with a reason naming the size problem", () => {
    const big = file("notes.md", "text/plain", MAX_FILE_BYTES + 1);
    const result = screenPickedFiles([big], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/文本附件太大/);
  });

  test("rejects an oversized image", () => {
    const big = file("huge.png", "image/png", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([big], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/图片太大/);
  });

  /**
   * THE CLIENT MUST NOT REFUSE WHAT THE SERVER ACCEPTS, AND IT DID.
   *
   * A browser reports `""` or `application/octet-stream` for a file it has no mapping for — a
   * `.txt` dragged out of an editor, anything with an unfamiliar extension. `sniffMimeType`
   * discards exactly those claims and reads the bytes instead, so the server takes such a file and
   * stores it as `text/plain`. Screening on the claim alone refused it here first, and the person
   * was told their plain text file "is not a file type this chat accepts" by the half of the
   * system that had not looked at it.
   */
  test("lets a file the browser could not name through for the server to sniff", () => {
    const unnamed = file("notes.txt", "");
    const generic = file("notes.txt", "application/octet-stream");

    const result = screenPickedFiles([unnamed, generic], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([unnamed, generic]);
    expect(result.rejected).toEqual([]);
  });

  /**
   * The loose ceiling, not the tight one, for the same reason: the client does not yet know which
   * of the two limits applies, and guessing the tight one would put back a refusal the server would
   * not have made. The server has the bytes and applies the right limit on arrival.
   */
  test("still holds a file the browser could not name to the larger ceiling", () => {
    const huge = file("notes.txt", "", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([huge], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/超过附件上限/);
  });

  test("a claim that names a format it does not accept is still refused here", () => {
    // The fall-through is only for claims that name NOTHING. `application/zip` names a format, and
    // `sniffMimeType` hands that name straight back for the server to refuse by name, so refusing
    // it at pick time is the two halves agreeing rather than disagreeing.
    const zip = file("archive.zip", "application/zip");
    const result = screenPickedFiles([zip], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
  });

  test("rejects an unsupported file type with a reason distinct from the SVG one", () => {
    const zip = file("archive.zip", "application/zip");
    const result = screenPickedFiles([zip], { alreadyStaged: 0 });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).not.toMatch(/SVG/);
  });

  test("reports one rejection per bad file, each naming its own file", () => {
    const svg = file("a.svg", "image/svg+xml");
    const zip = file("b.zip", "application/zip");
    const result = screenPickedFiles([svg, zip], { alreadyStaged: 0 });

    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0].name).toBe("a.svg");
    expect(result.rejected[1].name).toBe("b.zip");
  });

  test("counts the cap after kind and size, against already-staged files", () => {
    const first = file("one.png", "image/png");
    const second = file("two.png", "image/png");
    const result = screenPickedFiles([first, second], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE - 1,
    });

    expect(result.accepted).toEqual([first]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("two.png");
    expect(result.rejected[0].reason).toMatch(
      new RegExp(String(MAX_ATTACHMENTS_PER_MESSAGE)),
    );
  });

  /**
   * THE ORDERING THE DOCSTRING NAMES, WHICH THE TEST ABOVE CANNOT SEE.
   *
   * "Counts the cap after kind and size" was pinned with two acceptable PNGs, so no file in it ever
   * failed kind or size AND the cap — the two orderings produce identical output for that input, and
   * hoisting the cap check to the top of the loop left the whole suite green.
   *
   * The observable difference is WHICH SENTENCE the person is given, and it only appears for a file
   * that would fail both. A full composer and one SVG: judged in the documented order it is refused
   * for being an SVG, which tells somebody what to do about it. Judged cap-first it is refused for a
   * limit that had nothing to do with why it was never going to be accepted — and re-sending with
   * fewer files would not help, because the SVG is still an SVG.
   *
   * The other half of the docstring — that a refused file must never eat a slot — is true under
   * either ordering, because the cap counts `accepted.length`. That is exactly why the reason half
   * is the one that needs a test.
   */
  test("a file that fails kind is refused for its kind, not for the cap", () => {
    const svg = file("logo.svg", "image/svg+xml");
    const result = screenPickedFiles([svg], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/SVG/);
    expect(result.rejected[0].reason).not.toMatch(/at most/);
  });

  /** The same, for the size ceiling: an oversized image is too large, not one file too many. */
  test("a file that fails size is refused for its size, not for the cap", () => {
    const huge = file("huge.png", "image/png", MAX_IMAGE_BYTES + 1);
    const result = screenPickedFiles([huge], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/图片太大/);
    expect(result.rejected[0].reason).not.toMatch(/at most/);
  });

  test("keeps accepted files in input order when good and bad are interleaved", () => {
    const good1 = file("good1.png", "image/png");
    const bad = file("bad.svg", "image/svg+xml");
    const good2 = file("good2.md", "text/plain");

    const result = screenPickedFiles([good1, bad, good2], {
      alreadyStaged: 0,
    });

    expect(result.accepted).toEqual([good1, good2]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe("bad.svg");
  });
  /*
   * 审查 M9-2：Windows 上的 Chrome 给 .heic 的 `file.type` 是空字符串，原来这里放它过去，
   * 上传完才收到服务器一句英文 415。扩展名已经说明了格式，就在这里用中文拒绝并说怎么办。
   */
  test("rejects a HEIC/HEIF/AVIF photo by extension when the browser gives no type", () => {
    for (const name of ["IMG_0001.HEIC", "photo.heif", "cover.avif"]) {
      const result = screenPickedFiles([file(name, "")], { alreadyStaged: 0 });
      expect(result.accepted).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].name).toBe(name);
      expect(result.rejected[0].reason).toContain("JPG 或 PNG");
    }
  });

  test("rejects a HEIC photo the browser did name, with the same next step", () => {
    const result = screenPickedFiles([file("a.heic", "image/heic")], {
      alreadyStaged: 0,
    });
    expect(result.rejected[0].reason).toContain("HEIC");
    expect(result.rejected[0].reason).toContain("JPG 或 PNG");
  });

  test("an untyped file with another extension still goes to the server to be sniffed", () => {
    const notes = file("notes", "");
    const result = screenPickedFiles([notes], { alreadyStaged: 0 });
    expect(result.accepted).toEqual([notes]);
  });

  test("allowDocuments 为 true 时放行 ≤20MB 的 PDF 与 DOCX", () => {
    const pdf = sizedFile("report.pdf", "application/pdf", MAX_CHAT_FILE_BYTES);
    const docx = sizedFile("spec.docx", DOCX_MIME, 12 * 1024 * 1024);

    const result = screenPickedFiles([pdf, docx], {
      alreadyStaged: 0,
      allowDocuments: true,
    });

    expect(result.accepted).toEqual([pdf, docx]);
    expect(result.rejected).toEqual([]);
  });

  test("allowDocuments 为 true 时拒绝超过 20MB 的文档", () => {
    const hugePdf = sizedFile(
      "huge.pdf",
      "application/pdf",
      MAX_CHAT_FILE_BYTES + 1,
    );
    const hugeDocx = sizedFile(
      "huge.docx",
      DOCX_MIME,
      MAX_CHAT_FILE_BYTES + 1024,
    );

    const result = screenPickedFiles([hugePdf, hugeDocx], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
      allowDocuments: true,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.reason).toBe("文档太大（上限 20MB）。");
    expect(result.rejected[1]?.reason).toBe("文档太大（上限 20MB）。");
  });

  test("浏览器给出空 MIME 或 octet-stream 的 .pdf / .docx 在允许文档时按 20MB 放行", () => {
    const emptyMimePdf = sizedFile("scan.PDF", "", 15 * 1024 * 1024);
    const genericDocx = sizedFile(
      "draft.DOCX",
      "application/octet-stream",
      MAX_CHAT_FILE_BYTES,
    );

    const result = screenPickedFiles([emptyMimePdf, genericDocx], {
      alreadyStaged: 0,
      allowDocuments: true,
    });

    expect(result.accepted).toEqual([emptyMimePdf, genericDocx]);
    expect(result.rejected).toEqual([]);
  });

  test("allowDocuments 为 false 或省略时拒绝 PDF 与 DOCX（含空 MIME 后缀）", () => {
    const pdf = file("report.pdf", "application/pdf");
    const docx = file("spec.docx", DOCX_MIME);
    const untypedPdf = file("scan.pdf", "");

    const defaultResult = screenPickedFiles([pdf, docx, untypedPdf], {
      alreadyStaged: 0,
    });
    expect(defaultResult.accepted).toEqual([]);
    expect(defaultResult.rejected).toHaveLength(3);
    for (const entry of defaultResult.rejected) {
      expect(entry.reason).toBe("当前对话暂不支持上传 PDF / DOCX 文档。");
    }

    const explicitFalse = screenPickedFiles([pdf], {
      alreadyStaged: 0,
      allowDocuments: false,
    });
    expect(explicitFalse.accepted).toEqual([]);
    expect(explicitFalse.rejected[0]?.reason).toBe(
      "当前对话暂不支持上传 PDF / DOCX 文档。",
    );
  });

  test("允许的 PDF 同样受单条消息附件数量上限约束", () => {
    const pdf = sizedFile("extra.pdf", "application/pdf", 1024);
    const result = screenPickedFiles([pdf], {
      alreadyStaged: MAX_ATTACHMENTS_PER_MESSAGE,
      allowDocuments: true,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(
      new RegExp(String(MAX_ATTACHMENTS_PER_MESSAGE)),
    );
  });
});
