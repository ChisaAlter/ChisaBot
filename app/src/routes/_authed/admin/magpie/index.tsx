import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
  IconBrain,
  IconClock,
  IconDownload,
  IconExternalLink,
  IconNetwork,
  IconPlugConnected,
  IconServer,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { MagpieOverview } from "../../../../../../shared/model-selection";
import type { SystemUpdateOverview } from "../../../../../../shared/system-update";
import { ProviderMark } from "@/components/agents/model-picker";
import { MagpieInstallSection, MagpieIsolationWarning, MagpieNextSteps } from "@/components/magpie/magpie-install";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Card, CardBody, CardHeader, ErrorCard, ListRow, SettingRow, StatTile } from "@/components/ui/skyglass";
import { MAGPIE_CONSOLE_PATH, agoText, loadMagpieOverview, magpieKeys, magpieOverviewQueryOptions } from "@/lib/magpie";
import { loadModelCatalog } from "@/lib/model-selection/queries";
import { modelSelectionKeys } from "@/lib/model-selection/queries";
import { notifyModelSelectionChanged } from "@/lib/model-selection/sync";
import { durationText, requestSystemUpdate, systemUpdateKeys, systemUpdateQueryOptions, useElapsed } from "@/lib/system-update";

export const Route = createFileRoute("/_authed/admin/magpie/")({
  component: MagpiePage,
});

const SYNC_FEEDBACK = { pending: "同步中…", success: "已同步", error: "同步失败" };

/**
 * 管理后台 → 模型平台 Magpie (template E). Status of the gateway every BOT's model goes through,
 * ChisaBot's connection to it, the model sync, and the entry to the embedded console.
 */
function MagpiePage() {
  const queryClient = useQueryClient();
  const overview = useQuery(magpieOverviewQueryOptions());

  async function refreshStatus() {
    const next = await loadMagpieOverview(true);
    queryClient.setQueryData(magpieKeys.overview, next);
    if (!next.reachable) throw new Error(next.error ?? "Magpie 不可访问");
  }
  async function syncModels() {
    const catalog = await loadModelCatalog(true);
    queryClient.setQueryData(modelSelectionKeys.catalog, catalog);
    void queryClient.invalidateQueries({ queryKey: modelSelectionKeys.agents });
    notifyModelSelectionChanged();
    queryClient.setQueryData(magpieKeys.overview, await loadMagpieOverview(false));
  }

  return (
    <PageShell
      action={
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refreshStatus} size="sm" variant="outline">
            {"刷新状态"}
          </RefreshButton>
          <Button
            disabled={!overview.data?.managementAvailable}
            nativeButton={false}
            render={<Link to="/admin/magpie/console" />}
            size="sm"
          >
            <IconNetwork />
            {"打开 Magpie 管理"}
          </Button>
        </div>
      }
      description="所有机器人的模型都经由自托管的 Magpie 网关调用。这里查看网关状态与模型同步，并直接在后台里管理提供方和模型。"
      title="模型平台 Magpie"
    >
      {overview.isPending ? (
        <PageSkeleton rows={4} tall />
      ) : !overview.data ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void overview.refetch()} size="sm" type="button" variant="outline">
              {"重试"}
            </Button>
          }
          description={overview.error?.message ?? "无法读取 Magpie 状态。"}
          title="Magpie 状态暂时无法读取"
        />
      ) : (
        <Overview data={overview.data} onSync={syncModels} />
      )}
    </PageShell>
  );
}

function Overview({ data, onSync }: { data: MagpieOverview; onSync: () => Promise<void> }) {
  const update = useQuery(systemUpdateQueryOptions());
  const enabled = data.providers.filter((provider) => provider.enabled);
  const ready = enabled.filter((provider) => provider.ready).length;
  const disabled = data.providers.length - enabled.length;
  const catalog = data.catalog;
  /*
   * 这个部署还没接上 Magpie（没配 MAGPIE_ADMIN_URL，也没有一键装好的）：整页换成安装卡片，
   * 只留「ChisaBot 接入」看当前模型接口。网关状态、提供方、版本更新这些此时都没有意义。
   */
  if (!data.configured)
    return (
      <>
        <MagpieInstallSection />
        <ConnectionSection data={data} onSync={onSync} />
      </>
    );
  return (
    <>
      {update.data?.magpie?.managed && data.reachable && !data.connection?.viaMagpie ? (
        <MagpieNextSteps providers={data.providers.length} />
      ) : null}
      {update.data?.magpie?.managed ? (
        <MagpieIsolationWarning isolation={update.data.magpie.isolation} />
      ) : null}
      {!data.reachable ? (
        <ErrorCard
          className="mt-2"
          description={data.error ?? "无法连接 Magpie 管理接口。"}
          title="Magpie 当前不可访问"
        />
      ) : null}
      <div className="magpie-stats">
        <StatTile
          delta={data.gatewayOn === false ? "网关已关闭" : data.reachable ? `检查于 ${agoText(data.checkedAt)}` : undefined}
          icon={<IconActivity className="size-4" />}
          label="网关状态"
          tone={data.reachable ? "ok" : "danger"}
          value={data.reachable ? "运行中" : "不可访问"}
        />
        <StatTile
          delta={[data.version ? `Magpie ${data.version}` : "", disabled ? `另有 ${disabled} 个已停用` : ""].filter(Boolean).join(" · ") || undefined}
          icon={<IconServer className="size-4" />}
          label="就绪的提供方"
          tone={enabled.length && ready < enabled.length ? "warn" : undefined}
          value={data.reachable ? `${ready} / ${enabled.length}` : "—"}
        />
        <StatTile
          delta={catalog.source === "magpie" ? "来自 Magpie /v1/models" : catalog.count !== undefined ? "来自当前模型接口" : undefined}
          icon={<IconBrain className="size-4" />}
          label="可用模型"
          value={catalog.count ?? "—"}
        />
        <StatTile
          delta={catalog.autoRefreshMinutes ? `每 ${catalog.autoRefreshMinutes} 分钟自动同步` : "自动同步已关闭"}
          icon={<IconClock className="size-4" />}
          label="上次同步"
          tone={catalog.lastError ? "warn" : undefined}
          value={agoText(catalog.fetchedAt)}
        />
      </div>

      <GatewayUpdateSection magpieVersion={data.version} />

      <ConnectionSection data={data} onSync={onSync} />

      <PageSection
        description="在 Magpie 里添加的提供方与勾选的模型，会同步到机器人的模型选择器。"
        title="提供方"
      >
        {data.providers.length ? (
          <Card>
            {data.providers.map((provider) => (
              <ListRow
                actions={
                  <span className={!provider.enabled ? "magpie-badge" : provider.ready ? "magpie-badge is-ok" : "magpie-badge is-danger"}>
                    <span aria-hidden className={`model-health-dot ${!provider.enabled ? "is-off" : provider.ready ? "is-ok" : "is-bad"}`} />
                    {!provider.enabled ? "已停用" : provider.ready ? "就绪" : "未就绪"}
                  </span>
                }
                icon={<ProviderMark provider={provider.id} />}
                key={provider.id}
                sub={`${provider.id} · ${provider.models} 个模型开放给网关`}
                title={provider.name}
              />
            ))}
          </Card>
        ) : (
          <Card dashed className="magpie-empty">
            <p>{data.reachable ? "Magpie 里还没有提供方。打开 Magpie 管理添加一个。" : "Magpie 不可访问，暂时无法列出提供方。"}</p>
          </Card>
        )}
      </PageSection>

      <PageSection title="Magpie 管理">
        <Card interactive={data.managementAvailable}>
          <CardHeader
            action={
              data.managementAvailable ? (
                <div className="flex items-center gap-1">
                  <Button nativeButton={false} render={<a href={MAGPIE_CONSOLE_PATH} rel="noopener" target="_blank" />} size="sm" variant="ghost">
                    <IconExternalLink />
                    {"新窗口"}
                  </Button>
                  <Button nativeButton={false} render={<Link to="/admin/magpie/console" />} size="sm">
                    {"打开"}
                    <IconArrowRight />
                  </Button>
                </div>
              ) : undefined
            }
            description={
              data.managementAvailable
                ? "在设置内嵌打开 Magpie 控制台：提供方、模型、调用密钥、用量与路由。仅管理员可见，沿用 ChisaBot 登录，Magpie 密钥不会发送到浏览器。"
                : "此部署没有为 ChisaBot 配置 Magpie 管理密钥（MAGPIE_ADMIN_URL + MAGPIE_WEB_KEY_FILE），暂时无法内嵌。"
            }
            icon={<IconPlugConnected className="size-5" />}
            title="Magpie 控制台"
          />
          <CardBody />
        </Card>
      </PageSection>
    </>
  );
}

/** 「ChisaBot 接入」：当前模型接口、默认模型和模型同步。装没装 Magpie 都显示。 */
function ConnectionSection({ data, onSync }: { data: MagpieOverview; onSync: () => Promise<void> }) {
  const catalog = data.catalog;
  return (
    <PageSection
      action={
        <RefreshButton feedback={SYNC_FEEDBACK} onRefresh={onSync} size="sm" variant="outline">
          {"立即同步模型"}
        </RefreshButton>
      }
      description="ChisaBot 通过这个接口调用模型，并从它同步机器人可选的模型列表。"
      title="ChisaBot 接入"
    >
      <Card>
        <SettingRow
          description={data.connection?.viaMagpie ? "聊天、长期任务和面板的模型请求都经由 Magpie 转发。" : "当前模型接口不是 Magpie，可在模型设置中改为 http://magpie:3425/v1。"}
          title="模型网关"
        >
          <span className={data.connection?.viaMagpie ? "magpie-badge is-ok" : "magpie-badge is-warn"}>
            {data.connection?.viaMagpie ? "经由 Magpie" : "其他接口"}
          </span>
        </SettingRow>
        <SettingRow description={data.connection ? `${data.connection.protocol === "anthropic" ? "Anthropic 协议" : "OpenAI 兼容协议"} · ${data.connection.source === "saved" ? "设置中保存" : "环境变量"}` : undefined} title="接口地址">
          <code className="magpie-code">{data.connection?.baseUrl ?? "—"}</code>
        </SettingRow>
        <SettingRow description="没有单独选择模型的机器人使用它；每个机器人也可以在聊天输入框里切换。" title="部署默认模型">
          <code className="magpie-code">{data.connection?.defaultModel ?? "—"}</code>
        </SettingRow>
        <SettingRow
          description={catalog.lastError ? `上次同步失败：${catalog.lastError}` : "启动时、点「刷新」时和定时任务都会重新读取模型列表；网关暂时不可用时继续使用上次的列表。"}
          title="模型同步"
        >
          <span className={catalog.lastError ? "magpie-badge is-warn" : "magpie-badge is-ok"}>
            {catalog.lastError ? "同步异常" : `${agoText(catalog.fetchedAt)}同步`}
          </span>
        </SettingRow>
        <SettingRow description="更换协议、接口地址、默认模型或调用密钥（密钥只保存在服务器）。" title="模型设置">
          <Button nativeButton={false} render={<Link to="/admin/models" />} size="sm" variant="ghost">
            {"前往"}
            <IconArrowRight />
          </Button>
        </SettingRow>
      </Card>
    </PageSection>
  );
}

const MAGPIE_UPDATE_STEPS: Record<string, string> = {
  prepare: "准备",
  pull: "拉取镜像",
  swap: "重建容器",
  health: "健康检查",
  done: "完成",
};

function stepLabel(step?: string) {
  return (step && MAGPIE_UPDATE_STEPS[step]) || "进行中";
}

function shortDigest(digest: string) {
  return digest.replace(/^sha256:/u, "").slice(0, 12);
}

/**
 * 网关版本与更新（宿主机 deploy/updater/magpie.sh）。
 *
 * 「有没有新版」比的是**镜像摘要**，不是版本号：Magpie 的镜像只有标签，版本号要问它自己的接口
 * （上面那张卡里的 Magpie 版本）。宿主机每 30 分钟查一次 registry 的 manifest —— 只读，不拉镜像、
 * 不碰容器，所以不占更新锁；点「更新到最新版」才排队重建容器，健康检查不过会自动回退到上一版。
 *
 * 应用容器没有 docker socket，所以这两个按钮只是往 spool 里放一个请求，真正干活的是宿主机上的
 * chisabot-updater（docs/online-update.md）。它和 ChisaBot 自己的更新共用一把锁。
 */
function GatewayUpdateSection({ magpieVersion }: { magpieVersion?: string }) {
  const queryClient = useQueryClient();
  const update = useQuery(systemUpdateQueryOptions());
  const [busy, setBusy] = useState<"check" | "magpie" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data: SystemUpdateOverview | undefined = update.data;
  const gateway = data?.magpie;
  const job = data?.job?.action === "magpie" ? data.job : null;
  /*
   * 请求进了 spool、宿主机还没接手的那几秒，state.json 里还没有 job：只有 pending 知道
   * 它在排队。不把这一段也算「进行中」，按钮会提前复活、页面上也像没点一样。
   */
  const queued = !job && (data?.pending.includes("magpie") ?? false);
  const running = queued || job?.status === "running" || job?.status === "queued";
  const blocked = data ? !data.configured || data.updaterOutdated : false;
  const lastLog = job?.log?.length ? job.log[job.log.length - 1] : undefined;
  const elapsed = useElapsed(job?.startedAt, running);
  /*
   * 被宿主机拒掉的请求（已有更新在跑、有人在手动更新、更新程序太旧）不进 job，只进历史——
   * 不读历史，「更新不了」在这页就是一次无声的消失。只在它比当前这个 job 还新时显示，
   * 免得一次成功的更新旁边还挂着去年的拒绝。
   */
  const lastAttempt = data?.history.find((entry) => entry.action === "magpie");
  const rejected =
    lastAttempt?.status === "rejected" &&
    (!job || Date.parse(lastAttempt.at) > Date.parse(job.finishedAt ?? job.startedAt ?? ""));

  async function run(action: "check" | "magpie") {
    setBusy(action);
    setError(null);
    try {
      await requestSystemUpdate(action);
      await queryClient.invalidateQueries({ queryKey: systemUpdateKeys.overview });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "请求失败。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageSection
      action={
        <div className="flex items-center gap-2">
          <Button
            disabled={busy !== null || running}
            onClick={() => void run("check")}
            size="sm"
            type="button"
            variant="outline"
          >
            {"检查更新"}
          </Button>
          <Button disabled={busy !== null || running || blocked} onClick={() => void run("magpie")} size="sm" type="button">
            <IconDownload />
            {gateway?.installed === false ? "安装最新版" : "更新到最新版"}
          </Button>
        </div>
      }
      description="Magpie 是自托管的模型网关，可以就地升到镜像标签的当前版本。升级只重建这一个容器，正在回答的对话不受影响。"
      title="网关版本与更新"
    >
      {error ? <ErrorCard description={error} title="操作没有完成" /> : null}
      {blocked ? (
        <Card className="magpie-empty">
          <p className="flex items-start gap-2">
            <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
            {data?.configured
              ? "宿主机上的更新程序还是旧版本，认不出 Magpie 更新。先在「系统更新」里更新一次，更新程序会跟着升级。"
              : "这个部署没有安装宿主机更新程序，页面不能更新 Magpie。在服务器上装一次更新程序之后就能用了。"}
          </p>
        </Card>
      ) : null}
      <Card>
        <SettingRow description="Magpie 自己报的版本。" title="当前版本">
          <code className="magpie-code">{magpieVersion ?? "—"}</code>
        </SettingRow>
        <SettingRow
          description={
            gateway?.error
              ? `上次检查失败：${gateway.error}`
              : gateway?.checkedAt
                ? `宿主机 ${agoText(Date.parse(gateway.checkedAt))}查过镜像仓库。`
                : "宿主机还没写过检查结果（更新程序每 30 分钟查一次，也可以点「检查更新」）。"
          }
          title="镜像版本"
        >
          <span className={gateway?.updateAvailable ? "magpie-badge is-warn" : "magpie-badge is-ok"}>
            {gateway?.updateAvailable ? "有新版本" : gateway ? "已是最新" : "未知"}
          </span>
        </SettingRow>
        {gateway?.currentDigest ? (
          <SettingRow
            description={
              gateway.latestDigest && gateway.updateAvailable
                ? `镜像仓库上现在是 ${shortDigest(gateway.latestDigest)}。`
                : "与镜像仓库上的摘要一致。"
            }
            title="当前镜像摘要"
          >
            <code className="magpie-code">{shortDigest(gateway.currentDigest)}</code>
          </SettingRow>
        ) : null}
        {queued ? (
          <SettingRow description="已提交，等宿主机更新程序接手（几秒内）。" title="正在更新">
            <span className="magpie-badge is-warn">排队中</span>
          </SettingRow>
        ) : null}
        {job && (job.status === "running" || job.status === "queued") ? (
          <SettingRow
            description={
              [lastLog ?? "正在准备。", elapsed !== undefined ? `已用 ${durationText(elapsed)}` : ""]
                .filter(Boolean)
                .join(" · ")
            }
            title="正在更新"
          >
            <span className="magpie-badge is-warn">{stepLabel(job.step)}</span>
          </SettingRow>
        ) : null}
        {job && job.status === "succeeded" ? (
          <SettingRow
            description={
              [job.durationSec ? `用时 ${durationText(job.durationSec)}` : "", "摘要与镜像仓库一致，上面的「有新版本」会随之消失。"]
                .filter(Boolean)
                .join(" · ")
            }
            title="上次更新"
          >
            <span className="magpie-badge is-ok">成功</span>
          </SettingRow>
        ) : null}
        {job && !running && job.status === "failed" ? (
          <SettingRow description={job.error ?? "详细日志见「系统更新」页的历史。"} title="上次更新失败">
            <span className="magpie-badge is-danger">失败</span>
          </SettingRow>
        ) : null}
        {rejected ? (
          <SettingRow description={lastAttempt?.error ?? "宿主机没有执行这个请求。"} title="上次更新没有执行">
            <span className="magpie-badge is-warn">未执行</span>
          </SettingRow>
        ) : null}
      </Card>
    </PageSection>
  );
}
