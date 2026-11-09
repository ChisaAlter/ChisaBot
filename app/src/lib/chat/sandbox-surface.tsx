import { useEffect, useMemo, useRef, useState } from "react";
import { newId } from "@/lib/new-id";

export type SandboxContent = {
  html?: string[] | string;
  css?: string;
  jsFunctions?: string;
  generating?: boolean;
  htmlComplete?: boolean;
  cssComplete?: boolean;
  jsFunctionsComplete?: boolean;
};

/** Published components run in an opaque origin and can only report their own height. */
export function SandboxSurface({ content }: { content: SandboxContent }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const channel = useMemo(() => newId(), []);
  const document = useMemo(() => {
    const html = Array.isArray(content.html)
      ? content.html.join("")
      : (content.html ?? "");
    // Source is authored HTML/JS by design. Escape closing tags in the separate style/script
    // slots so neither can accidentally terminate its own container.
    const css = (content.css ?? "").replace(/<\/style/gi, "<\\/style");
    const script = (content.jsFunctions ?? "").replace(
      /<\/script/gi,
      "<\\/script",
    );
    const reporter = `const report=()=>parent.postMessage({type:'chisabot:sandbox-height',channel:${JSON.stringify(channel)},height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*');new ResizeObserver(report).observe(document.documentElement);report();`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;padding:0;min-height:0;overflow-wrap:anywhere}body{font:15px/1.5 system-ui,sans-serif}${css}</style></head><body>${html}<script>${script}</script><script>${reporter}</script></body></html>`;
  }, [content.html, content.css, content.jsFunctions, channel]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "chisabot:sandbox-height" ||
        event.data.channel !== channel
      )
        return;
      if (
        typeof event.data.height === "number" &&
        Number.isFinite(event.data.height)
      )
        setHeight(Math.max(32, Math.min(6000, event.data.height)));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel]);
  return (
    <iframe
      ref={frame}
      title="组件预览"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      style={{ width: "100%", height, border: 0, display: "block" }}
    />
  );
}
