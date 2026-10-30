// 先于路由装好「返回」监听（见 overlay-back-install.ts）。
import "./lib/overlay-back-install";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthLoopNotice } from "./components/auth/auth-loop-notice";
import { installLoginRedirect } from "./lib/auth/login-redirect";
import { BootCommitMarker, reportBootStage } from "./lib/boot-status";
import { installPhoneLayout } from "./lib/device";
import { installHaltProbe } from "./lib/halt";
import { installPerfMode } from "./lib/perf-mode";
import { installPwa } from "./lib/pwa";
import { installPreviewWindowBridge } from "./lib/proto-preview";
import { installStaleChunkReload } from "./lib/stale-chunk";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";
// 性能模式 / 减少透明度：全局关掉 backdrop-filter（DESIGN.md §10.3.1）。放在 styles.css 之后。
import "./perf-noblur.css";

reportBootStage("entry-executing");
installPhoneLayout();
installPerfMode();
installHaltProbe();
installPwa();
installPreviewWindowBridge();
installStaleChunkReload();
// 会话过期（网关的 401）整页去 /login?next=…，见 lib/auth/login-redirect.ts。
installLoginRedirect();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ChisaBot 无法找到应用程序根元素。");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BootCommitMarker />
      <AuthLoopNotice />
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
