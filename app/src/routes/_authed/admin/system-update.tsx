import {
  IconArrowBackUp,
  IconBrandGithub,
  IconCheck,
  IconCloudDownload,
  IconGitCommit,
  IconHammer,
  IconHistory,
  IconPackage,
  IconRefresh,
  IconServer,
  IconAlertTriangle,
  IconStethoscope,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DEFAULT_UPDATE_ESTIMATE_SEC,
  estimateText,
  FULL_UPDATE_STEPS,
  installUpdaterCommand,
  ROLLBACK_STEPS,
  SYSTEM_UPDATE_UPDATER_VERSION,
  type SystemUpdateWarning,
  type SystemUpdateHistoryEntry,
  type SystemUpdateJob,
  type SystemUpdateOverview,
  UPDATE_STEPS,
} from "../../../../../shared/system-update";
import { PageSection, PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { confirmDialog } from "@/components/ui/confirm";
import { Card, EmptyState, ErrorCard, SettingRow, StatTile } from "@/components/ui/skyglass";
import {
  durationText,
  loadSystemUpdate,
  requestSystemUpdate,
  shortSha,
  systemUpdateKeys,
  systemUpdateQueryOptions,
  timeText,
} from "@/lib/system-update";
import { type AdminSmokeResult, runAdminSmoke } from "@/lib/admin-smoke";
import { runtimeKernelQueryOptions } from "@/lib/runtime-kernel";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { setToolActivityVisible, useToolActivityVisible } from "@/lib/chat/tool-activity";

export const Route = createFileRoute("/_authed/admin/system-update")({
  component: SystemUpdatePage,
});

const STATUS_TEXT: Record<SystemUpdateHistoryEntry["status"], { text: string; tone: "ok" | "warn" | "danger" | "muted" | "accent" }> = {
  queued: { text: "排队中", tone: "muted" },
  running: { text: "进行中", tone: "accent" },
  succeeded: { text: "成功", tone: "ok" },
  failed: { text: "失败", tone: "danger" },
  rolled_back: { text: "已自动回滚", tone: "warn" },
  rejected: { text: "未执行", tone: "muted" },
};

const ACTION_TEXT = { check: "检查更新", update: "更新", rollback: "回滚", magpie: "更新 Magpie" } as const;

function isActive(data?: SystemUpdateOverview) {
  return (
    !!data &&
    (data.externalBusy ||
      data.pending.some((a) => a !== "check") ||
      data.job?.status === "running" ||
      data.job?.status === "queued")
  );
}

/** 这次更新预计多久：最近一次同类更新的实际用时，没有就用默认估计。 */
function estimateFor(data: SystemUpdateOverview, full: boolean) {
  const mode = full ? "full" : "code";
  return data.estimates[mode] ?? DEFAULT_UPDATE_ESTIMATE_SEC[mode];
}

function sourceText(data: SystemUpdateOverview) {
  if (!data.source) return "还没有从 GitHub 拉取过";
  return data.source.kind === "github" ? `GitHub ${data.source.repo || ""} · ${data.source.branch}`.replace("  ", " ") : "本机镜像（不联网）";
}

/**
 * 管理后台 → 系统更新（模板 E，docs/online-update.md）。当前版本、GitHub main 上的新提交、一键更新
 * （宿主机更新程序：备份 → 构建 → 切换 → 健康检查，失败自动回滚）、进度与日志、回滚到上一版、历史。
 */
function SystemUpdatePage() {
  const queryClient = useQueryClient();
  const overview = useQuery(systemUpdateQueryOptions());
  const data = overview.data;

  const check = useAsyncAction(
    async () => {
    const before = data?.source?.fetchedAt ?? data?.updatedAt;
    await requestSystemUpdate("check");
    // 等宿主机取走请求并写回新的状态（通常 2–10 秒）。
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const next = await loadSystemUpdate();
      queryClient.setQueryData(systemUpdateKeys.overview, next);
      if (!next.pending.includes("check") && (next.source?.fetchedAt ?? next.updatedAt) !== before) {
        if (next.source?.error) throw new Error(next.source.error);
        return;
      }
    }
    throw new Error("宿主机更新程序没有回应。");
    },
    { errorToast: (error) => error.message },
  );

  return (
    <PageShell
      action={
        <Button
          disabled={!data?.configured}
          feedback={{ pending: "检查中…", success: "已检查", error: "检查失败" }}
          onClick={() => void check.run()}
          size="sm"
          state={check.state}
          variant="outline"
        >
          <IconCloudDownload />
          {"检查更新"}
        </Button>
      }
      description="查看正在运行的版本和 GitHub main 上的新提交，一键更新或回滚。更新由宿主机上的更新程序执行：先备份数据库，再构建、切换、做健康检查，失败会自动回滚。"
      title="系统更新"
    >
      {overview.isPending ? (
        <PageSkeleton rows={4} tall />
      ) : !data ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void overview.refetch()} size="sm" type="button" variant="outline">
              {"重试"}
            </Button>
          }
          description={overview.error?.message ?? "无法读取系统更新状态。"}
          title="系统更新状态暂时无法读取"
        />
      ) : (
        <Overview data={data} />
      )}
      <DebugSection />
    </PageShell>
  );
}

function Overview({ data }: { data: SystemUpdateOverview }) {
  const queryClient = useQueryClient();
  const active = isActive(data);
  const full = data.depsChanged;
  // 当前镜像没有记录提交（behind 未知）时只能完整构建一次。
  const pendingUpdate = (data.behind ?? 0) > 0 || (data.behind === null && full && !!data.latest);
  const canUpdate = data.configured && data.updaterOnline && !active && pendingUpdate;
  const estimate = estimateText(estimateFor(data, full));

  const update = useAsyncAction(
    async () => {
      const result = await requestSystemUpdate("update", data.latest?.sha, { full });
      queryClient.setQueryData(systemUpdateKeys.overview, result.overview);
    },
    { errorToast: (error) => error.message },
  );
  const rollback = useAsyncAction(
    async () => {
      const result = await requestSystemUpdate("rollback");
      queryClient.setQueryData(systemUpdateKeys.overview, result.overview);
    },
    { errorToast: (error) => error.message },
  );
  async function startUpdate() {
    const back = data.current?.image?.replace(/^.*:/u, "") ?? "当前版本";
    const ok = await confirmDialog(
      full
        ? {
            title: `完整更新到 ${shortSha(data.latest?.sha)}？`,
            description: `会先备份数据库，再从 GitHub 下载最新代码，重新安装依赖、构建前端和镜像（限内存），然后切换，${estimate || "需要几分钟"}；构建期间照常可用，切换时有十几秒连不上。健康检查不通过会自动回到 ${back}。`,
            confirmLabel: "开始完整更新",
          }
        : {
            title: `更新到 ${shortSha(data.latest?.sha)}？`,
            description: `会先备份数据库，然后构建新版本并切换，${estimate || "需要几分钟"}；切换时有十几秒连不上。健康检查不通过会自动回到 ${back}。`,
            confirmLabel: "开始更新",
          },
    );
    if (ok) await update.run();
  }
  async function startRollback() {
    const ok = await confirmDialog({
      title: "回滚到上一版？",
      description: `会切换回 ${data.previous?.image ?? "上一版"}（${shortSha(data.previous?.commit)}），切换时有十几秒连不上。数据库不回退；新版本加的数据会保留。`,
      confirmLabel: "回滚",
      destructive: true,
    });
    if (ok) await rollback.run();
  }

  if (!data.configured) {
    return (
      <UpdaterSetupCard
        command={installUpdaterCommand(data.sourceDir)}
        description="这个部署还没装宿主机更新服务（较早部署的、或部署时跳过了这一步），所以这里收不到新版本。在服务器上运行一次下面的命令：拉取最新代码、安装更新服务、给容器挂上更新目录（用现在的镜像重建一次容器，断开十几秒，不重新构建）。之后回到这一页就能检查和一键更新。"
        title="还没装宿主机更新服务"
      />
    );
  }

  return (
    <>
      {!data.updatedAt ? (
        <UpdaterSetupCard
          command={installUpdaterCommand(data.sourceDir)}
          description="容器已经挂好了更新目录，但宿主机上的更新服务 chisabot-updater 从来没有运行过（没装，或装失败了）。在服务器上运行一次下面的命令安装它，大约一分钟后这一页会自动变成可用。"
          title="宿主机更新服务没有安装"
        />
      ) : !data.updaterOnline ? (
        <UpdaterSetupCard
          command="sudo systemctl restart chisabot-updater && systemctl --no-pager status chisabot-updater"
          description={`宿主机上的 chisabot-updater 服务从 ${timeText(data.updatedAt)} 起没有回应，暂时不能更新或回滚。先在服务器上重启它；还是不行，就用「${installUpdaterCommand(data.sourceDir)}」重新安装。`}
          title="更新程序离线"
          tone="danger"
        />
      ) : data.updaterOutdated ? (
        <UpdaterSetupCard
          command={installUpdaterCommand(data.sourceDir)}
          description={`服务器上的更新程序是 v${data.updaterVersion ?? 1}，这一版页面需要 v${SYSTEM_UPDATE_UPDATER_VERSION}。旧版还能更新，但不会自己升级，也看不到配置问题。在服务器上运行一次下面的命令升级（不重建容器、不中断服务）；以后每次更新成功后它会自动跟着升级。`}
          title="更新程序是旧版本"
        />
      ) : null}
      {data.warnings.map((code) => (
        <WarningNote code={code} key={code} />
      ))}
      <div className="magpie-stats">
        <StatTile
          delta={data.running.builtAt ? `构建于 ${timeText(data.running.builtAt)}` : undefined}
          icon={<IconPackage className="size-4" />}
          label="当前版本"
          value={<span className="sysupd-mono">{shortSha(data.running.commit ?? data.current?.commit)}</span>}
        />
        <StatTile
          delta={data.current?.deployedAt ? `上线于 ${timeText(data.current.deployedAt)}` : undefined}
          icon={<IconServer className="size-4" />}
          label="运行镜像"
          value={<span className="sysupd-image">{(data.current?.image ?? data.running.buildId).replace(/^.*:/u, "")}</span>}
        />
        <StatTile
          delta={data.source?.error ? "上次拉取失败" : sourceText(data)}
          icon={<IconBrandGithub className="size-4" />}
          label="上次检查"
          tone={data.source?.error ? "warn" : undefined}
          value={data.source?.fetchedAt ? timeText(data.source.fetchedAt) : "从未检查"}
        />
        <StatTile
          delta={data.behind === null ? "当前镜像没有记录提交" : data.behind ? `最新 ${shortSha(data.latest?.sha)}` : "已是最新"}
          icon={<IconGitCommit className="size-4" />}
          label="待更新提交"
          tone={data.behind ? "warn" : data.behind === 0 ? "ok" : undefined}
          value={data.behind ?? "—"}
        />
      </div>

      <KernelSection />

      {data.source?.error ? (
        <ErrorCard className="mt-4" description={data.source.error} title="检查更新失败" />
      ) : null}

      {data.externalBusy ? (
        <Card className="sysupd-note is-busy mt-4" role="status">
          <span className="sysupd-note-ic" aria-hidden>
            <i className="sysupd-spin" />
          </span>
          <div className="min-w-0 flex-1">
            <h4>{"宿主机上正在手动更新"}</h4>
            <p>{"有人在服务器上直接运行了更新或回滚脚本。等它结束后这里会自动刷新，再点更新。"}</p>
          </div>
        </Card>
      ) : null}

      <PageSection
        action={
          full ? null : (
            <Button
              disabled={!canUpdate}
              feedback={{ pending: "提交中…", success: "已开始", error: "未开始" }}
              onClick={() => void startUpdate()}
              size="sm"
              state={update.state}
            >
              <IconCloudDownload />
              {"更新"}
            </Button>
          )
        }
        description={
          data.source?.kind === "mirror"
            ? "宿主机设置为不联网（GITHUB_FETCH=off），读取发布时推送到服务器的本机镜像。"
            : `来自 GitHub ${data.source?.repo || "ChisaAlter/ChisaBot"} 的 ${data.source?.branch ?? "main"}，点「检查更新」立即拉取。`
        }
        title="可用更新"
      >
        {full && pendingUpdate ? (
          <Card className="sysupd-note is-full mb-3">
            <span className="sysupd-note-ic" aria-hidden>
              <IconHammer className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <h4>{"这次需要完整构建"}</h4>
              <p>
                {`${data.fullReason ?? "这些提交改动了依赖或镜像底座"}，只替换代码的快速更新做不了。一键完整更新会从 GitHub 下载最新代码，重新安装依赖、构建前端和镜像，然后切换；先备份数据库，健康检查不通过自动回滚。`}
              </p>
              <p className="sysupd-note-meta">
                {[estimate ? `预计${estimate}` : "", "构建期间照常可用", "切换时断开十几秒"].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Button
              className="sysupd-note-btn"
              disabled={!canUpdate}
              feedback={{ pending: "提交中…", success: "已开始", error: "未开始" }}
              onClick={() => void startUpdate()}
              state={update.state}
            >
              <IconHammer />
              {"一键完整更新"}
            </Button>
          </Card>
        ) : null}
        {data.commits.length ? (
          <Card>
            <ul className="sysupd-commits">
              {data.commits.map((item) => (
                <li className="sysupd-commit list-enter" key={item.sha}>
                  <span className="sysupd-sha">{shortSha(item.sha)}</span>
                  <span className="sysupd-subject" title={item.subject}>
                    {item.subject}
                  </span>
                  <span className="sysupd-meta">{[item.author, timeText(item.date)].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card>
            <div className="sysupd-uptodate">
              <span className="sysupd-ok-ic">
                <IconCheck className="size-4" />
              </span>
              {data.behind === null ? "当前镜像没有记录来源提交，更新一次后这里会显示新提交。" : "已经是最新版本。"}
            </div>
          </Card>
        )}
      </PageSection>

      {data.job || data.pending.some((a) => a !== "check") ? (
        <JobCard estimates={data.estimates} job={data.job} pending={data.pending} />
      ) : null}

      <PageSection settingItem="system-update.rollback" title="回滚">
        <Card>
          <SettingRow
            description={
              data.previous
                ? `切换回上一版 ${data.previous.image}${data.previous.commit ? `（${shortSha(data.previous.commit)}）` : ""}。只换镜像，数据库不回退。`
                : "还没有上一版可以回滚（第一次一键更新之后才有）。"
            }
            title="回滚到上一版"
          >
            <Button
              disabled={!data.previous || !data.updaterOnline || active}
              feedback={{ pending: "提交中…", success: "已开始", error: "未开始" }}
              onClick={() => void startRollback()}
              size="sm"
              state={rollback.state}
              variant="destructive"
            >
              <IconArrowBackUp />
              {"回滚"}
            </Button>
          </SettingRow>
        </Card>
      </PageSection>

      <SmokeSection />

      <PageSection title="历史">
        {data.history.length ? (
          <Card>
            <ul className="sysupd-history">
              {data.history.map((entry) => {
                const status = STATUS_TEXT[entry.status];
                return (
                  <li className="sysupd-hrow" key={entry.id}>
                    <time className="sysupd-htime" dateTime={entry.at}>
                      {timeText(entry.at)}
                    </time>
                    <div className="min-w-0 flex-1">
                      <div className="sysupd-ht">
                        <b>{entry.action === "update" && entry.mode === "full" ? "完整更新" : ACTION_TEXT[entry.action]}</b>
                        {entry.fromImage || entry.toImage ? (
                          <span className="sysupd-mono">
                            {[entry.fromImage, entry.toImage].filter(Boolean).map((i) => i?.replace(/^.*:/u, "")).join(" → ")}
                          </span>
                        ) : null}
                      </div>
                      <div className="sysupd-hs">
                        {[entry.actor, entry.durationSec ? `用时 ${durationText(entry.durationSec)}` : "", entry.error].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className={cn("device-badge is-sm", `is-${status.tone}`)}><T>{status.text}</T></span>
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : (
          <EmptyState description="一键更新和回滚都会记在这里，也写进 管理后台 → 审计。" icon={<IconHistory className="size-6" />} title="还没有更新记录" />
        )}
      </PageSection>
    </>
  );
}

/**
 * 执行内核：这一版由什么循环跑机器人的回合。部署级配置，所有内置机器人一样，不按机器人切换。
 *
 * Hermes 在网页之外（服务器上）运行，所以这里读的是桥接自己公开的健康快照，不含 token，也不会
 * 触发生成或工具调用。它只作提示：桥接没起来时聊天会报错，但整体健康、更新和回滚都不受影响。
 */
function KernelSection() {
  const kernel = useQuery(runtimeKernelQueryOptions());
  const data = kernel.data;
  const hermes = data?.hermes;
  const hermesMode = data?.kernel === "hermes";
  const connected = hermesMode && hermes?.ok === true;
  const label = kernel.isError
    ? "状态不可用"
    : !data
      ? "读取中…"
      : !hermesMode
        ? "内置循环"
        : connected
          ? "Hermes 已连接"
          : "Hermes 未连接";
  const tone = kernel.isError || !data || !hermesMode ? "muted" : connected ? "ok" : "warn";
  const details = kernel.isError
    ? "无法读取执行内核状态：需要管理员权限，或服务器暂时没有回应。"
    : !data
      ? "正在读取执行内核…"
      : !hermesMode
        ? "这个部署没有配置 Hermes，机器人使用应用内置的执行循环。"
        : !hermes
          ? "已配置 Hermes，但还没有健康状态。"
          : connected
            ? [
                hermes.hostTools ? "工具回调已注册" : "工具回调未注册",
                hermes.persistentState ? "持久去重账本正常" : "没有持久账本",
                typeof hermes.sessions === "number" ? `${hermes.sessions} 个会话` : "",
                typeof hermes.generation === "number" ? `第 ${hermes.generation} 代` : "",
              ].filter(Boolean).join(" · ")
            : `${hermes.error ?? "Hermes 桥接没有响应。"} 在服务器上运行 systemctl status hermes-acp-bridge 查看。`;
  return (
    <PageSection
      description="部署级设置：所有内置机器人共用同一个执行循环，不在每个机器人上单独切换。"
      settingItem="system-update.runtime-kernel"
      title="执行内核"
    >
      <Card>
        <SettingRow description={details} title="运行循环">
          <div className="flex items-center gap-2">
            <span className={cn("device-badge is-sm", `is-${tone}`)}>
              <T>{label}</T>
            </span>
            <Button
              aria-label="重新检查执行内核"
              disabled={kernel.isFetching}
              onClick={() => void kernel.refetch()}
              size="sm"
              variant="outline"
            >
              <IconRefresh />
              {"检查"}
            </Button>
          </div>
        </SettingRow>
      </Card>
    </PageSection>
  );
}

/**
 * 更新后自检（docs/admin-smoke.md）：用聊天同一套模型配置做一次真实往返，不建对话、不写消息。
 * 结果只留在这一页的内存里。
 */
function SmokeSection() {
  const [result, setResult] = useState<AdminSmokeResult | null>(null);
  const smoke = useAsyncAction(
    async () => {
      const next = await runAdminSmoke();
      setResult(next);
      if (!next.ok) throw new Error(next.message);
    },
    { errorToast: (error) => error.message },
  );
  return (
    <PageSection settingItem="system-update.selftest" title="自检">
      <Card>
        <SettingRow
          description={
            result ? (
              <span className={cn("sysupd-smoke", result.ok ? "is-ok" : "is-bad")} data-smoke-result="">
                {`${result.message} · ${result.model} · ${result.latencyMs} ms · 未保存任何对话`}
              </span>
            ) : (
              "用聊天同一套模型配置跟模型说一句话，确认这台服务器能正常回复。不会建对话，也不写任何消息。"
            )
          }
          title="模型往返自检"
        >
          <Button
            feedback={{ pending: "自检中…", success: "通过", error: "未通过" }}
            onClick={() => void smoke.run()}
            size="sm"
            state={smoke.state}
            variant="outline"
          >
            <IconStethoscope />
            {"自检"}
          </Button>
        </SettingRow>
      </Card>
    </PageSection>
  );
}

/** 进行中的任务每秒走一次的「已用 x 分 y 秒」。 */
function useElapsed(startedAt: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return running && Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : undefined;
}

/** 没装 / 离线 / 旧版本：一句话说明 + 在服务器上要运行的那一行命令（可复制）。 */
function UpdaterSetupCard({
  title,
  description,
  command,
  tone = "warn",
}: {
  title: string;
  description: string;
  command: string;
  tone?: "warn" | "danger";
}) {
  return (
    <Card className={cn("sysupd-note sysupd-setup mt-2", tone === "danger" ? "is-danger" : "is-full")} role="status">
      <span className="sysupd-note-ic" aria-hidden>
        <IconTool className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h4>{title}</h4>
        <p>{description}</p>
        <div className="sysupd-cmd">
          <code className="sysupd-mono">{command}</code>
          <CopyButton size="sm" value={command} variant="outline" />
        </div>
        <p className="sysupd-note-meta">{"需要 root（sudo）、systemd、Docker、python3。详见 docs/online-update.md「老部署怎么升级到可一键更新」。"}</p>
      </div>
    </Card>
  );
}

const WARNING_TEXT: Record<SystemUpdateWarning, { title: string; body: string }> = {
  health_url_example: {
    title: "健康检查地址还是示例域名",
    body: "/opt/chisabot-updater/config.env 的 PUBLIC_HEALTH_URL 还是 chisabot.example.com，公网登录页检查被跳过。改成自己的 https://<域名>:<端口>/login（或在 deploy/.env 填好 CHISABOT_DOMAIN 后运行 sudo sh deploy/install-updater.sh 自动改）。",
  },
  health_url_missing: {
    title: "没有配置健康检查地址",
    body: "PUBLIC_HEALTH_URL 为空，更新后只检查本机，不检查公网登录页。配好 HTTPS 网关后在 deploy/.env 填 CHISABOT_DOMAIN / CHISABOT_HTTPS_PORT，再运行 sudo sh deploy/install-updater.sh。",
  },
  compose_missing: {
    title: "找不到 compose 文件",
    body: "config.env 的 COMPOSE_DIR / COMPOSE_FILE 指向的文件不存在，更新会在切换这一步失败。改成实际部署的目录（deploy/start.sh 部署的就是仓库的 deploy/ 目录）。",
  },
  buildx_missing: {
    title: "宿主机没有 docker buildx",
    body: "完整构建要用 Docker 的 buildx 插件（Debian/Ubuntu：apt install docker-buildx-plugin）。没有它只能做快速更新。",
  },
};

function WarningNote({ code }: { code: SystemUpdateWarning }) {
  const text = WARNING_TEXT[code];
  return (
    <Card className="sysupd-note is-full mt-2" role="note">
      <span className="sysupd-note-ic" aria-hidden>
        <IconAlertTriangle className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h4>{text.title}</h4>
        <p>{text.body}</p>
      </div>
    </Card>
  );
}

function JobCard({
  job,
  pending,
  estimates,
}: {
  job: SystemUpdateJob | null;
  pending: SystemUpdateOverview["pending"];
  estimates: SystemUpdateOverview["estimates"];
}) {
  const queued = !job || (job.status !== "running" && pending.some((a) => a !== "check"));
  const action = queued ? (pending.find((a) => a !== "check") ?? "update") : job.action;
  const full = !queued && job.action === "update" && job.mode === "full";
  const steps = action === "rollback" ? ROLLBACK_STEPS : full ? FULL_UPDATE_STEPS : UPDATE_STEPS;
  const status = queued ? "queued" : job.status;
  const currentIndex = queued ? -1 : steps.findIndex((s) => s.key === job.step);
  const badge = STATUS_TEXT[status];
  const elapsed = useElapsed(job?.startedAt, !queued && status === "running");
  const expected = full ? (estimates.full ?? DEFAULT_UPDATE_ESTIMATE_SEC.full) : (estimates.code ?? DEFAULT_UPDATE_ESTIMATE_SEC.code);
  const timing = queued
    ? ""
    : status === "running" && elapsed !== undefined
      ? `已用 ${durationText(elapsed)}${action === "update" ? ` · 预计${estimateText(expected)}` : ""}`
      : job.durationSec
        ? `用时 ${durationText(job.durationSec)}`
        : "";
  return (
    <PageSection
      action={<span className={cn("device-badge", `is-${badge.tone}`)}><T>{badge.text}</T></span>}
      description={
        queued
          ? "已提交，等待宿主机更新程序开始（几秒内）。"
          : [
              job.actor ? `由 ${job.actor} 发起` : "",
              job.startedAt ? `开始于 ${timeText(job.startedAt)}` : "",
              job.finishedAt ? `结束于 ${timeText(job.finishedAt)}` : "",
              timing,
            ]
              .filter(Boolean)
              .join(" · ")
      }
      title={action === "rollback" ? "回滚进度" : full ? "完整更新进度" : "更新进度"}
    >
      <Card className="sysupd-job">
        <ol className="sysupd-steps">
          {steps.map((step, index) => {
            const failed = !queued && (status === "failed" || status === "rolled_back") && index === currentIndex;
            const state = queued
              ? "todo"
              : failed
                ? "failed"
                : status === "succeeded" || index < currentIndex
                  ? "done"
                  : index === currentIndex && status === "running"
                    ? "active"
                    : "todo";
            return (
              <li data-step={state} key={step.key}>
                <span className="sysupd-step-ic" aria-hidden>
                  {state === "done" ? <IconCheck className="size-3.5" /> : state === "failed" ? <IconX className="size-3.5" /> : state === "active" ? <i className="sysupd-spin" /> : null}
                </span>
                {step.label}
              </li>
            );
          })}
        </ol>
        {!queued && job.error ? <p className="sysupd-error">{job.error}</p> : null}
        {!queued && status === "succeeded" && action === "update" && job.toImage ? (
          <p className="sysupd-done">
            <IconCheck className="size-4" />
            {`已上线 ${job.toImage.replace(/^.*:/u, "")}${job.durationSec ? `，用时 ${durationText(job.durationSec)}` : ""}。打开的页面会提示「有新版本，点此刷新」。`}
          </p>
        ) : null}
        {!queued && job.log.length ? <JobLog lines={job.log} /> : null}
      </Card>
    </PageSection>
  );
}

/** 日志块：新行进来时自动滚到底（用户往上翻看时不打扰）。 */
function JobLog({ lines }: { lines: string[] }) {
  const [node, setNode] = useState<HTMLPreElement | null>(null);
  const last = lines[lines.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些值是有意的重启触发条件
  useEffect(() => {
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (nearBottom || node.dataset.stuck !== "0") node.scrollTop = node.scrollHeight;
  }, [node, last, lines.length]);
  return (
    <pre
      aria-label={"更新日志"}
      role="log"
      aria-live="polite"
      className="sysupd-log"
      onScroll={(event) => {
        const el = event.currentTarget;
        el.dataset.stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 48 ? "1" : "0";
      }}
      ref={setNode}
    >
      {lines.join("\n")}
    </pre>
  );
}

/** 只影响这台浏览器：聊天里默认隐藏工具调用 / 浏览步骤，排查问题时在这里临时打开。 */
function DebugSection() {
  const visible = useToolActivityVisible();
  return (
    <PageSection settingItem="system-update.debug-tools" title="调试">
      <Card>
        <SettingRow
          description="默认关闭：聊天里只显示结果，不显示机器人调用了哪些工具、浏览了哪些页面。打开后仅对当前浏览器生效，审批与授权卡片始终显示。"
          title="调试：显示工具调用"
        >
          <Switch
            aria-label="调试：显示工具调用"
            checked={visible}
            onCheckedChange={(next) => setToolActivityVisible(next === true)}
          />
        </SettingRow>
      </Card>
    </PageSection>
  );
}
