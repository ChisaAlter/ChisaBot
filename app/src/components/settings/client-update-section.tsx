import {
  IconCloudDownload,
  IconDeviceDesktop,
  IconInfoCircle,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { type PcUpdateState, pcBridge, usePcLocal } from "@/lib/pc-bridge";
import { fetchServedVersion } from "@/lib/version";
import {
  formatAccountVersionLabel,
  serverSkewBehindBundled,
} from "@/lib/version-skew";

const PC_UPDATE_TEXT: Record<PcUpdateState["status"], string> = {
  idle: "",
  checking: "正在检查…",
  available: "发现新版本，准备下载",
  downloading: "正在后台下载",
  verifying: "正在校验更新包签名",
  downloaded: "已下载，重启后安装",
  none: "已是最新版本",
  error: "检查更新失败",
};

/**
 * 统一「版本与更新」中的客户端与版本区块（全员可见）。
 *
 * - 展示当前桌面端 / 网页端与服务端版本，取代左下角账号卡和账号菜单里的版本号与升级提示；
 * - 在 PC 桌面端里直接提供「自动更新」开关、「检查更新」与「立即重启以安装」入口，不再藏在设备三级页面里。
 */
export function ClientUpdateSection() {
  const [local, setLocal] = usePcLocal();
  const bridge = pcBridge();
  const [toggling, setToggling] = useState(false);

  const served = useQuery({
    queryKey: ["app-version"],
    queryFn: () => fetchServedVersion(),
    staleTime: 60_000,
  });

  const check = useAsyncAction(
    async () => {
      const next = await bridge?.checkUpdate?.();
      if (next?.status === "error") {
        throw new Error(next.error || "检查更新失败");
      }
      if (bridge) setLocal(await bridge.state());
    },
    { errorToast: (error) => error.message },
  );

  const install = useAsyncAction(async () => {
    await bridge?.installUpdate?.();
  });

  const serverVersion = served.data?.version?.trim() || "";
  const versionSummary = formatAccountVersionLabel(serverVersion);
  const skew = serverSkewBehindBundled(serverVersion);
  const update = local?.update;

  const pcStatusText = update
    ? update.feedStale
      ? `更新源已失效（源上最高 ${update.feedStale.version}）${update.feedUrl && update.feedUrl !== update.feedStale.url ? "，已改用内置更新源" : ""}`
      : update.status === "downloading" && typeof update.percent === "number"
        ? `正在后台下载 ${Math.round(update.percent)}%`
        : PC_UPDATE_TEXT[update.status]
    : "";

  const pcDetail = local && update
    ? [
        `当前 v${local.version}`,
        update.version && update.status !== "none"
          ? `新版本 v${update.version}`
          : "",
        pcStatusText,
        update.status === "error" && update.error ? update.error : "",
        update.supported && update.signing === false
          ? "此版本未启用更新验签"
          : "",
        update.checkedAt
          ? `上次检查 ${new Date(update.checkedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const webUiModeText =
    local?.webUi?.mode === "local"
      ? "本地内置前端"
      : local?.webUi?.mode === "remote"
        ? "服务端前端"
        : "";

  return (
    <PageSection
      description="查看当前桌面端与服务端版本，检查并安装桌面端新版本。"
      settingItem="updates.desktop-client"
      title="客户端与版本"
    >
      <PageRows>
        <Item data-setting-item="updates.versions" size="sm">
          <ItemMedia variant="icon">
            <IconInfoCircle className="size-4" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{"当前版本"}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {[
                local
                  ? `桌面端 v${local.version}`
                  : versionSummary || "正在读取版本…",
                local && serverVersion ? `服务端 v${serverVersion}` : "",
                webUiModeText,
                skew
                  ? "服务端版本低于桌面端，管理员可在下方升级服务端"
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <span className="font-mono text-xs text-muted-foreground">
              {local
                ? `v${local.version}`
                : serverVersion
                  ? `v${serverVersion}`
                  : "—"}
            </span>
          </ItemActions>
        </Item>

        <Separator />

        {local && update ? (
          <>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconCloudDownload className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{"桌面端更新"}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {pcDetail || `当前 v${local.version}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {update.status === "downloaded" ? (
                  <Button
                    feedback={{
                      pending: "等待确认…",
                      success: "正在重启",
                      error: "失败",
                    }}
                    onClick={() => void install.run()}
                    size="sm"
                    state={install.state}
                  >
                    {"立即重启以安装"}
                  </Button>
                ) : (
                  <Button
                    disabled={
                      !update.supported ||
                      update.status === "checking" ||
                      update.status === "downloading" ||
                      update.status === "verifying"
                    }
                    feedback={{
                      pending: "检查中…",
                      success: "已检查",
                      error: "检查失败",
                    }}
                    onClick={() => void check.run()}
                    size="sm"
                    state={check.state}
                    variant="outline"
                  >
                    <IconRefresh className="size-3.5" />
                    {"检查更新"}
                  </Button>
                )}
              </ItemActions>
            </Item>

            <Separator />

            <Item size="sm">
              <ItemMedia variant="icon">
                <IconDeviceDesktop className="size-4" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{"自动更新桌面端"}</ItemTitle>
                <ItemDescription>
                  {update.supported
                    ? "开启后实时接收服务端发版推送并定期检查，有新版本自动后台下载并在验签后提示重启安装。"
                    : "仅安装版支持自动更新；免安装压缩包请前往「设备」下载最新安装包。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label="自动更新桌面端"
                  checked={!!local.autoUpdate && update.supported}
                  disabled={toggling || !update.supported}
                  onCheckedChange={async (value) => {
                    if (!bridge) return;
                    setToggling(true);
                    try {
                      setLocal(await bridge.setLocal({ autoUpdate: value }));
                    } catch (error) {
                      toast.error(
                        error instanceof Error ? error.message : "修改失败",
                      );
                    } finally {
                      setToggling(false);
                    }
                  }}
                />
              </ItemActions>
            </Item>
          </>
        ) : (
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconDeviceDesktop className="size-4" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{"桌面端更新"}</ItemTitle>
              <ItemDescription>
                {"当前正在浏览器中访问，网页会随服务端升级自动刷新；在 Windows / macOS 桌面端中可直接在此页检查与自动更新。"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                nativeButton={false}
                render={<Link to="/settings/devices" />}
                size="sm"
                variant="outline"
              >
                {"前往设备"}
              </Button>
            </ItemActions>
          </Item>
        )}
      </PageRows>
    </PageSection>
  );
}
