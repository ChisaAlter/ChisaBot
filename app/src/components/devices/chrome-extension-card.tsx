import {
  IconBrandChrome,
  IconDownload,
  IconKey,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Card, CardHeader, SettingRow } from "@/components/ui/skyglass";
import { useAbortScope } from "@/hooks";
import {
  type BrowserExtensionDownloadMeta,
  browserExtensionDownloadQueryOptions,
  bytesText,
  cancelPairing,
  createPairing,
  downloadBrowserExtensionZip,
  type PairingTicket,
  pairingErrorMessage,
} from "@/lib/devices";

/**
 * 「设置 → 设备」中的 Chrome / Edge 浏览器扩展卡片：
 * - 一键下载打包好的 chisabot-chrome-extension.zip（完整异步 Button 状态机）；
 * - 复用配对逻辑生成一次性扩展绑定码（kind = "extension"）；
 * - 提供打开 chrome://extensions → 开启开发者模式 → 解压并加载的三步安装说明。
 */
export function ChromeExtensionCard({
  meta: metaProp,
  onDownload,
}: {
  /** 可选外部传入元信息（测试或服务端预取场景）；未传时自动查询 GET /api/devices/extension/meta。 */
  meta?: Partial<BrowserExtensionDownloadMeta> | null;
  /** 可选覆盖下载动作（测试注入）。 */
  onDownload?: (url: string, filename: string) => Promise<void>;
}) {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const query = useQuery({
    ...browserExtensionDownloadQueryOptions(),
    enabled: metaProp === undefined,
  });
  const meta = metaProp !== undefined ? metaProp : query.data;
  const available = Boolean(meta?.available);
  const downloadUrl = meta?.downloadUrl || "/api/devices/extension/download";
  const filename = meta?.filename || "chisabot-chrome-extension.zip";

  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const issueAbort = useRef<AbortController | null>(null);
  const issueScope = useAbortScope();

  const downloadAction = useAsyncAction(
    async () => {
      if (onDownload) {
        await onDownload(downloadUrl, filename);
        return;
      }
      await downloadBrowserExtensionZip(downloadUrl, filename);
    },
    { errorToast: (error) => `下载失败：${error.message}` },
  );

  const issuePairing = useAsyncAction(
    async () => {
      const controller = issueScope.fork(issueAbort.current);
      issueAbort.current = controller;
      try {
        const created = await createPairing("extension", {
          signal: controller.signal,
        });
        if (controller.signal.aborted || issueAbort.current !== controller) {
          void cancelPairing(created.id);
          return;
        }
        setTicket(created);
      } catch (error) {
        if (
          controller.signal.aborted ||
          ((error instanceof DOMException || error instanceof Error) &&
            error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      } finally {
        if (issueAbort.current === controller) {
          issueAbort.current = null;
        }
      }
    },
    { errorToast: (error) => pairingErrorMessage(error, "extension") },
  );

  const metaDescription = query.isPending && metaProp === undefined
    ? "正在检查服务器上的浏览器扩展安装包…"
    : available
      ? [
          meta?.version ? `版本 ${meta.version}` : null,
          "Chrome / Edge（Manifest V3）",
          meta?.bytes ? bytesText(meta.bytes) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "扩展安装包尚未发布到这台服务器。请联系管理员或先构建扩展分发包。";

  return (
    <div data-testid="chrome-extension-card">
      <Card>
        <CardHeader
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-testid="chrome-extension-pair-btn"
                feedback={{
                  pending: "生成中…",
                  success: "已生成",
                  error: "生成失败",
                }}
                onClick={() => void issuePairing.run()}
                size="sm"
                state={issuePairing.state}
                type="button"
                variant="outline"
              >
                <IconKey />
                {ticket ? "换一个绑定码" : "生成扩展绑定码"}
              </Button>
              <Button
                data-testid="chrome-extension-download-btn"
                disabled={!available}
                feedback={{
                  pending: "下载中…",
                  success: "已开始下载",
                  error: "下载失败",
                }}
                onClick={() => void downloadAction.run()}
                size="sm"
                state={downloadAction.state}
                type="button"
              >
                <IconDownload />
                {"下载扩展包（ZIP）"}
              </Button>
            </div>
          }
          description={metaDescription}
          icon={<IconBrandChrome className="size-5" />}
          title="Chrome / Edge 浏览器扩展"
        />
        {meta?.sha256 ? (
          <SettingRow
            description={
              <code className="device-code device-sha">{meta.sha256}</code>
            }
            title="SHA-256"
          />
        ) : null}
        {ticket ? (
          <div className="ext-pair-box" data-testid="chrome-extension-pair-box">
            <div className="ext-pair-code-row">
              <span className="text-xs text-muted-foreground">
                {"一次性绑定码："}
              </span>
              <code
                className="ext-pair-code"
                data-testid="chrome-extension-pair-code"
              >
                {ticket.code}
              </code>
              <CopyButton size="sm" value={ticket.code} variant="ghost" />
              <Button
                onClick={() => void issuePairing.run()}
                size="sm"
                state={issuePairing.state}
                type="button"
                variant="ghost"
              >
                <IconRefresh className="size-3.5" />
                {"刷新"}
              </Button>
            </div>
            <p className="ext-pair-hint">
              {`该绑定码 ${Math.max(1, Math.round(ticket.ttlSeconds / 60))} 分钟内有效、只能用一次。在扩展侧栏选择「配对码登录」，填入上方绑定码与服务器地址 `}
              <code className="device-code">{origin}</code>
              {" 即可完成绑定。"}
            </p>
          </div>
        ) : (
          <SettingRow
            description="在已登录当前网页的同一浏览器里打开扩展侧栏，可直接一键免密登录；在其他 Chrome / Edge 配置文件中可使用上方「生成扩展绑定码」。"
            title="免密认领与配对码"
          />
        )}
      </Card>
      <Card className="device-steps">
        <ol data-testid="chrome-extension-install-steps">
          <li>
            <b>{"打开浏览器扩展管理页"}</b>
            <span className="device-step-inline">
              {"在 Chrome 地址栏打开"}
              <code className="device-code">{"chrome://extensions"}</code>
              <CopyButton
                size="sm"
                value="chrome://extensions"
                variant="ghost"
              />
              {"（Edge 打开 "}
              <code className="device-code">{"edge://extensions"}</code>
              {"）"}
            </span>
          </li>
          <li>
            <b>{"开启「开发者模式」"}</b>
            <span>
              {"打开扩展管理页面右上角的「开发者模式」开关，启用本地加载扩展。"}
            </span>
          </li>
          <li>
            <b>{"解压并加载已解压的扩展程序"}</b>
            <span>
              {`将下载的 ${filename} 解压到本机固定目录，点击左上角「加载已解压的扩展程序」选中解压后的文件夹，再点击浏览器工具栏中的 ChisaBot 图标即可打开侧边栏并连接当前账号。`}
            </span>
          </li>
        </ol>
      </Card>
    </div>
  );
}
