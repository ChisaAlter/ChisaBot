import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/skyglass";
import { MAGPIE_CONSOLE_PATH, magpieOverviewQueryOptions } from "@/lib/magpie";

export const Route = createFileRoute("/_authed/admin/magpie/console")({
  component: MagpieConsolePage,
});

/**
 * The Magpie console embedded in 管理后台. Same origin (ChisaBot's server proxies it under
 * MAGPIE_CONSOLE_PATH, admin-only), so the frame shares the ChisaBot sign-in and never sees the
 * Magpie key. Fills the centre pane under the unified page header; a skeleton covers the load.
 */
function MagpieConsolePage() {
  const overview = useQuery(magpieOverviewQueryOptions());
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => setLoaded(false), [nonce]);
  const available = overview.data?.managementAvailable !== false;

  return (
    <div className="magpie-console flex min-h-0 flex-1 flex-col" data-slot="page-shell">
      <div className="magpie-console-head">
        <PageHeader
          action={
            <div className="flex items-center gap-1">
              <Button
                aria-label="重新载入"
                disabled={!available}
                onClick={() => setNonce((value) => value + 1)}
                size="sm"
                title="重新载入 Magpie 控制台"
                type="button"
                variant="ghost"
              >
                <IconRefresh />
                {"重新载入"}
              </Button>
              <Button nativeButton={false} render={<a href={MAGPIE_CONSOLE_PATH} rel="noopener" target="_blank" />} size="sm" variant="ghost">
                <IconExternalLink />
                {"新窗口打开"}
              </Button>
            </div>
          }
          description={overview.data?.version ? `Magpie ${overview.data.version} · 仅管理员可见 · 沿用 ChisaBot 登录` : "仅管理员可见 · 沿用 ChisaBot 登录"}
          eyebrow={
            <>
              <Link to="/admin/models">{"模型"}</Link>
              <span aria-hidden className="ph-crumb-sep">
                {"/"}
              </span>
              <Link className="ph-crumb-back" to="/admin/magpie">
                {"模型平台 Magpie"}
              </Link>
            </>
          }
          title="Magpie 管理"
        />
      </div>
      {available ? (
        <div className="magpie-frame-wrap sg-card">
          {!loaded ? (
            <div aria-label="正在载入 Magpie 控制台" className="magpie-frame-skeleton" role="status">
              <span className="model-pill-shimmer" />
              <span>{"正在载入 Magpie 控制台…"}</span>
            </div>
          ) : null}
          <iframe
            className="magpie-frame"
            data-loaded={loaded || undefined}
            key={nonce}
            onLoad={() => setLoaded(true)}
            ref={frame}
            referrerPolicy="same-origin"
            src={MAGPIE_CONSOLE_PATH}
            title="Magpie 管理控制台"
          />
        </div>
      ) : (
        <div className="px-6">
          <EmptyState
            action={
              <Button nativeButton={false} render={<Link to="/admin/magpie" />} size="sm" variant="outline">
                {"返回模型平台"}
              </Button>
            }
            description="此部署没有为 ChisaBot 配置 Magpie 管理密钥，暂时无法内嵌控制台。"
            title="Magpie 管理未配置"
          />
        </div>
      )}
    </div>
  );
}
