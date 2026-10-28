import { useEffect, useRef, useState } from "react";

/**
 * Word（.docx）文件在线预览（CB-089，DESIGN.md §111）。
 *
 * 在浏览器里用 docx-preview 把文件画成一页一页的 HTML：库只在第一次打开预览时按需下载（动态 import，
 * 不进首屏包，§41.3），服务器上不装 LibreOffice。docx 本身没有分页信息，这里的「页」按纸张尺寸和
 * 分页符近似排出来，和 Word 里不一定一页不差——说明里不承诺真实分页。
 */

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** 超过这么大就不在浏览器里解析（解压 + 排版都在主线程），直接请人下载。 */
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** 只认 .docx（老的 .doc 是二进制格式，docx-preview 读不了）。 */
export function isDocxFile(ext: string, mimeType: string | undefined): boolean {
  return ext === "docx" || mimeType === DOCX_MIME;
}

export function docxTooLarge(bytes: number | null | undefined): boolean {
  return typeof bytes === "number" && bytes > DOCX_PREVIEW_MAX_BYTES;
}

type State = { kind: "loading" } | { kind: "ready" } | { kind: "too-large" } | { kind: "failed" };

/** 弹窗正文：取文件 → 画页面。失败一律落到同一句「无法预览，下载查看」，原因不往界面上抛。 */
export function DocxPreviewBody({ url, knownBytes }: { url: string; knownBytes: number | null }) {
  const pages = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<State>(() =>
    docxTooLarge(knownBytes) ? { kind: "too-large" } : { kind: "loading" },
  );

  useEffect(() => {
    if (docxTooLarge(knownBytes)) return;
    const controller = new AbortController();
    let alive = true;
    (async () => {
      try {
        const response = await fetch(url, { credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (docxTooLarge(blob.size)) {
          if (alive) setState({ kind: "too-large" });
          return;
        }
        const { renderAsync } = await import("docx-preview");
        const target = pages.current;
        if (!alive || !target) return;
        target.replaceChildren();
        await renderAsync(blob, target, target, {
          className: "docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          // 图片写成 data: 地址，不留一串要回收的 blob: 地址。
          useBase64URL: true,
          experimental: false,
        });
        for (const node of target.querySelectorAll("script, iframe, object, embed, form")) {
          node.remove();
        }
        for (const el of target.querySelectorAll("*")) {
          for (const attr of [...el.attributes]) {
            if (attr.name.toLowerCase().startsWith("on")) {
              el.removeAttribute(attr.name);
            }
          }
        }
        // 文档里的超链接一律新标签页打开，不在弹窗里把整个应用导航走。
        for (const link of target.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          if (/^https?:/i.test(link.getAttribute("href") ?? "")) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          } else if (!link.getAttribute("href")?.startsWith("#")) {
            link.removeAttribute("href");
          }
        }
        if (alive) setState({ kind: "ready" });
      } catch {
        if (alive && !controller.signal.aborted) setState({ kind: "failed" });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [url, knownBytes]);

  return (
    <div className="rp-docx" data-state={state.kind}>
      {state.kind === "loading" ? (
        <p className="rp-docx-note" role="status">
          {"正在打开文档…"}
        </p>
      ) : null}
      {state.kind === "too-large" ? (
        <p className="rp-docx-note">{"文件超过 10 MB，无法在这里预览，请点右上角下载查看。"}</p>
      ) : null}
      {state.kind === "failed" ? (
        <p className="rp-docx-note">{"无法预览这个文档，请点右上角下载查看。"}</p>
      ) : null}
      <div className="rp-docx-pages" hidden={state.kind !== "ready" && state.kind !== "loading"} ref={pages} />
    </div>
  );
}
