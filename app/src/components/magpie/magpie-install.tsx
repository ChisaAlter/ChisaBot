import {
  IconAlertTriangle,
  IconArrowRight,
  IconCheck,
  IconDownload,
  IconPlugConnected,
  IconRefresh,
  IconShieldCheck,
  IconTool,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Card } from "@/components/ui/skyglass";
import { magpieKeys } from "@/lib/magpie";
import {
  durationText,
  requestSystemUpdate,
  systemUpdateKeys,
  systemUpdateQueryOptions,
  useElapsed,
} from "@/lib/system-update";
import { cn } from "@/lib/utils";
import type { MagpieOverview } from "../../../../shared/model-selection";
import {
  installUpdaterCommand,
  MAGPIE_INSTALL_STEPS,
  type MagpieIsolation,
  type SystemUpdateJob,
  type SystemUpdateOverview,
} from "../../../../shared/system-update";
import "./magpie-install.css";

/**
 * 「一键安装 Magpie」（DESIGN.md §15「一键安装」，docs/magpie.md §一键安装）。
 *
 * 只装了 ChisaBot、服务器上没有 Magpie 的部署，在「模型平台 Magpie」页直接装上它。应用容器没有
 * docker socket，所以按钮只是排队一个 `magpie` 请求；宿主机更新程序的 magpie.sh 看到还没装，就
 * 走安装：官方镜像 → 摘要一致 → 签名校验（有工具时）→ 启动 → 健康检查 → 把管理密钥交给应用。
 * 应用几秒内自己接上（server/src/magpie.ts createAutoMagpieService），不用重启。
 *
 * 已经配好 Magpie 的部署（MAGPIE_ADMIN_URL）根本看不到这块：页面只在 `configured === false` 时渲染它。
 */

export type MagpieInstallView =
  /** 服务器没装宿主机更新程序：页面装不了，给出要在服务器上运行的那一行。 */
  | { kind: "no-updater"; command: string }
  /** 更新程序装了但没在运行（2 分钟没写状态）。 */
  | { kind: "offline" }
  /** 更新程序太旧，或者它的 magpie.sh 还不会装（没报 installable）。 */
  | { kind: "outdated" }
  /** 服务器上已经有一个不是 ChisaBot 装的 Magpie 容器：不去动它，告诉管理员怎么接。 */
  | { kind: "external" }
  /** 系统正在做别的更新（共用一把锁）。 */
  | { kind: "busy" }
  | { kind: "ready" }
  | { kind: "queued" }
  | { kind: "running"; job: SystemUpdateJob }
  | { kind: "failed"; error: string; job?: SystemUpdateJob }
  /** 宿主机装好了、密钥交了，应用还没读到（最多几秒）。 */
  | { kind: "connecting" };

/** 两份状态 → 这块该显示什么。纯函数，测试直接喂数据。 */
export function magpieInstallView(
  overview: Pick<MagpieOverview, "configured">,
  update: SystemUpdateOverview,
): MagpieInstallView | null {
  if (overview.configured) return null;
  if (!update.configured)
    return {
      kind: "no-updater",
      command: installUpdaterCommand(update.sourceDir),
    };
  const gateway = update.magpie;
  const job = update.job?.action === "magpie" ? update.job : null;
  const queued = !job && update.pending.includes("magpie");
  if (queued) return { kind: "queued" };
  if (job && (job.status === "running" || job.status === "queued"))
    return { kind: "running", job };
  if (gateway?.installed && gateway.managed) return { kind: "connecting" };
  if (job?.status === "succeeded" && !gateway?.installed)
    return { kind: "connecting" };
  if (gateway?.installed) return { kind: "external" };
  if (update.updaterOutdated || !gateway?.installable)
    return { kind: "outdated" };
  if (!update.updaterOnline) return { kind: "offline" };
  const otherBusy =
    update.externalBusy ||
    update.pending.some(
      (action) => action !== "check" && action !== "magpie",
    ) ||
    (!!update.job &&
      update.job.action !== "magpie" &&
      (update.job.status === "running" || update.job.status === "queued"));
  if (otherBusy) return { kind: "busy" };
  /*
   * 被宿主机拒掉的请求不进 job，只进历史。只在它比当前 job 还新时算数，免得一次成功旁边挂着旧的拒绝。
   */
  const lastAttempt = update.history.find((entry) => entry.action === "magpie");
  if (
    lastAttempt?.status === "rejected" &&
    (!job ||
      Date.parse(lastAttempt.at) >
        Date.parse(job.finishedAt ?? job.startedAt ?? ""))
  )
    return {
      kind: "failed",
      error: lastAttempt.error ?? "宿主机没有执行这个请求。",
    };
  if (job && (job.status === "failed" || job.status === "rolled_back"))
    return {
      kind: "failed",
      error: job.error ?? "安装没有完成，详细日志见「系统更新」页的历史。",
      job,
    };
  return { kind: "ready" };
}

/** 进度条上第几步：`done` 停在最后一步；未知的步骤（旧脚本的 key）当作第一步，不让进度倒退成全灰。 */
export function installStepIndex(step?: string) {
  if (step === "done") return MAGPIE_INSTALL_STEPS.length - 1;
  return Math.max(
    0,
    MAGPIE_INSTALL_STEPS.findIndex((item) => item.key === step),
  );
}

const SOURCE_FACTS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "来源",
    body: "官方镜像 ghcr.io/yetone/magpie，由 github.com/yetone/magpie 的官方 CI 构建。不从其他地方下载。",
  },
  {
    title: "校验",
    body: "拉下来的镜像摘要必须和镜像仓库公布的一致；服务器上有 gh 或 cosign 时，还会校验官方签名，不通过就不启动。",
  },
  {
    title: "影响",
    body: "只新增一个 Magpie 容器，端口只开在本机。ChisaBot 不重启，正在进行的对话不受影响。",
  },
];

/** 「模型平台 Magpie」页在 Magpie 还没接上时显示的整块。 */
export function MagpieInstallSection() {
  const queryClient = useQueryClient();
  const update = useQuery(systemUpdateQueryOptions());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = update.data
    ? magpieInstallView({ configured: false }, update.data)
    : null;

  // 宿主机装好、应用还没读到密钥的那几秒：每 2 秒重读一次 Magpie 状态，读到就整页切成正常视图。
  const connecting = view?.kind === "connecting";
  useEffect(() => {
    if (!connecting) return;
    void queryClient.invalidateQueries({ queryKey: magpieKeys.overview });
    const timer = window.setInterval(
      () =>
        void queryClient.invalidateQueries({ queryKey: magpieKeys.overview }),
      2_000,
    );
    return () => window.clearInterval(timer);
  }, [connecting, queryClient]);

  async function install() {
    setBusy(true);
    setError(null);
    try {
      await requestSystemUpdate("magpie");
      await queryClient.invalidateQueries({
        queryKey: systemUpdateKeys.overview,
      });
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "请求没有发出去，请重试。",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!update.data)
    return (
      <PageSection title="安装 Magpie">
        <Card className="magpie-install">
          <p className="magpie-install-lead">
            {update.isError
              ? "读不到服务器的更新程序状态，暂时不能安装。刷新页面重试。"
              : "正在检查这台服务器…"}
          </p>
        </Card>
      </PageSection>
    );

  return (
    <MagpieInstallCard
      busy={busy}
      onInstall={() => void install()}
      requestError={error}
      view={view ?? { kind: "connecting" }}
    />
  );
}

/** 只管画，状态从外面给：页面用 `MagpieInstallSection`，测试和截图直接用它。 */
export function MagpieInstallCard({
  view,
  busy = false,
  requestError,
  onInstall,
}: {
  view: MagpieInstallView;
  busy?: boolean;
  requestError?: string | null;
  onInstall?: () => void;
}) {
  const running = view.kind === "running" || view.kind === "queued";
  const job =
    view.kind === "running"
      ? view.job
      : view.kind === "failed"
        ? view.job
        : undefined;
  const elapsed = useElapsed(job?.startedAt, view.kind === "running");
  const canInstall = view.kind === "ready" || view.kind === "failed";
  const title =
    view.kind === "running" || view.kind === "queued"
      ? "正在安装 Magpie"
      : view.kind === "failed"
        ? "Magpie 没有装好"
        : view.kind === "connecting"
          ? "Magpie 已安装，正在接入"
          : view.kind === "external"
            ? "服务器上已经有 Magpie，还没接入 ChisaBot"
            : "这台服务器还没有 Magpie";

  return (
    <PageSection title="安装 Magpie">
      <Card
        aria-busy={running || view.kind === "connecting"}
        className="magpie-install"
        data-state={view.kind}
      >
        <div className="magpie-install-head">
          <span aria-hidden className="magpie-install-ic">
            {view.kind === "failed" ? (
              <IconAlertTriangle className="size-5" />
            ) : view.kind === "connecting" ? (
              <IconPlugConnected className="size-5" />
            ) : (
              <IconDownload className="size-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="magpie-install-title">{title}</h3>
            <p className="magpie-install-lead">{leadText(view)}</p>
          </div>
          {canInstall ? (
            <Button
              className="magpie-install-cta"
              disabled={busy || !onInstall}
              onClick={onInstall}
              type="button"
            >
              {view.kind === "failed" ? <IconRefresh /> : <IconDownload />}
              {busy
                ? "正在提交…"
                : view.kind === "failed"
                  ? "重试安装"
                  : "一键安装"}
            </Button>
          ) : null}
        </div>

        {requestError ? (
          <p className="sysupd-error magpie-install-error" role="alert">
            {requestError}
          </p>
        ) : null}

        {view.kind === "ready" ? (
          <dl className="magpie-install-facts">
            {SOURCE_FACTS.map((fact) => (
              <div key={fact.title}>
                <dt>
                  {fact.title === "校验" ? (
                    <IconShieldCheck aria-hidden className="size-4" />
                  ) : null}
                  {fact.title}
                </dt>
                <dd>{fact.body}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {running ||
        (view.kind === "failed" && view.job) ||
        view.kind === "connecting" ? (
          <InstallSteps view={view} />
        ) : null}

        {view.kind === "running" ? (
          <p className="magpie-install-meta" role="status">
            {[
              view.job.log.at(-1) ?? "正在准备。",
              elapsed !== undefined ? `已用 ${durationText(elapsed)}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : view.kind === "queued" ? (
          <p className="magpie-install-meta" role="status">
            {"已提交，等服务器上的更新程序接手（几秒内）。"}
          </p>
        ) : null}

        {view.kind === "failed" ? (
          <div className="magpie-install-fail">
            <p className="sysupd-error" role="alert">
              {view.error}
            </p>
            <p className="magpie-install-meta">
              {"已经下载的镜像和安装目录会保留，重试会从断掉的地方接着装。"}
              <Link className="magpie-install-link" to="/admin/system-update">
                {"查看完整日志"}
                <IconArrowRight className="size-3.5" />
              </Link>
            </p>
          </div>
        ) : null}

        {view.kind === "no-updater" ? (
          <div className="sysupd-cmd">
            <code className="sysupd-mono">{view.command}</code>
            <CopyButton size="sm" value={view.command} variant="outline" />
          </div>
        ) : null}

        {view.kind === "outdated" ? (
          <div className="magpie-install-actions">
            <Button
              nativeButton={false}
              render={<Link to="/admin/system-update" />}
              size="sm"
              variant="outline"
            >
              <IconTool />
              {"前往系统更新"}
            </Button>
          </div>
        ) : null}
      </Card>
    </PageSection>
  );
}

function leadText(view: MagpieInstallView) {
  switch (view.kind) {
    case "ready":
      return "Magpie 是自托管的模型网关，统一管理模型服务、账户和调用密钥。装好后这一页和内嵌控制台会自动启用，不用重启 ChisaBot。一般 1–3 分钟，主要看拉取镜像的速度。";
    case "queued":
    case "running":
      return "可以离开这一页，安装在服务器上继续进行。装好后会自动接入。";
    case "failed":
      return "下面是没装好的原因。处理之后点「重试安装」。";
    case "connecting":
      return "服务器已经启动了 Magpie，ChisaBot 正在读取它的管理密钥，几秒内这一页就会切换成网关状态。";
    case "external":
      return "这个 Magpie 不是在这里一键安装的，ChisaBot 不会去改它。按 docs/magpie.md「部署配置」给 ChisaBot 配上 MAGPIE_ADMIN_URL 和管理密钥文件即可接入。";
    case "outdated":
      return "服务器上的更新程序还是旧版本，不会安装 Magpie。先在「系统更新」里更新一次，更新程序会跟着升级，再回来点「一键安装」。";
    case "offline":
      return "服务器上的更新程序现在没有运行，页面发不出安装请求。在服务器上运行 systemctl status chisabot-updater 查看原因。";
    case "busy":
      return "系统正在更新，Magpie 安装和系统更新共用一把锁。等这次更新结束后再来安装。";
    case "no-updater":
      return "页面上安装 Magpie 需要服务器上的更新程序（应用本身没有权限启动容器）。在服务器上运行一次下面这行，装好后回到这里点「一键安装」。";
  }
}

function InstallSteps({ view }: { view: MagpieInstallView }) {
  const job =
    view.kind === "running" || view.kind === "failed" ? view.job : undefined;
  const current =
    view.kind === "connecting"
      ? MAGPIE_INSTALL_STEPS.length - 1
      : installStepIndex(job?.step);
  return (
    <ol aria-label="安装进度" className="sysupd-steps magpie-install-steps">
      {MAGPIE_INSTALL_STEPS.map((step, index) => {
        const state =
          view.kind === "queued"
            ? "todo"
            : view.kind === "failed"
              ? index < current
                ? "done"
                : index === current && job
                  ? "failed"
                  : "todo"
              : index < current
                ? "done"
                : index === current
                  ? "active"
                  : "todo";
        return (
          <li
            aria-current={state === "active" ? "step" : undefined}
            data-step={state}
            key={step.key}
          >
            <span aria-hidden className="sysupd-step-ic">
              {state === "done" ? (
                <IconCheck className="size-3.5" />
              ) : state === "failed" ? (
                <IconX className="size-3.5" />
              ) : state === "active" ? (
                <i className="sysupd-spin" />
              ) : null}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

/** 隔离没补上时给管理员看的原因。applied 或没有记录就不提示。 */
export function isolationWarning(isolation?: MagpieIsolation) {
  switch (isolation) {
    case "no-iptables":
      return "宿主机上找不到 iptables（PATH、/usr/sbin、/sbin 都没有），没能补上隔离规则：Magpie 现在可能主动连上 ChisaBot。请在宿主机装上 iptables，再按 docs/ops/trust-boundary.md §5.1 运行 isolate-sidecar-app.sh --apply。";
    case "failed":
      return "隔离规则没有补上（见 docs/ops/trust-boundary.md §5.1）。Magpie 本身已经可用，但现在可能主动连上 ChisaBot。";
    case "skipped":
      return "安装时没能补上隔离规则（不是以 root 运行，或更新程序目录里没有隔离脚本）。Magpie 本身已经可用，请按 docs/ops/trust-boundary.md §5.1 补跑 isolate-sidecar-app.sh --apply。";
    default:
      return null;
  }
}

/** 装好后的隔离警告：没补上规则时出现在「模型平台 Magpie」页。 */
export function MagpieIsolationWarning({
  isolation,
}: {
  isolation?: MagpieIsolation;
}) {
  const text = isolationWarning(isolation);
  if (!text) return null;
  return (
    <Card className={cn("sysupd-note magpie-isolation-warn mt-2")} role="alert">
      <span aria-hidden className="sysupd-note-ic">
        <IconAlertTriangle className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h4>{"网络隔离没有补上"}</h4>
        <p>{text}</p>
      </div>
    </Card>
  );
}

/**
 * 一键装好之后、ChisaBot 的模型还没走 Magpie 时，「模型平台 Magpie」页顶上的下一步提示。
 * Magpie 刚装好时里面什么提供方都没有，所以不替管理员切模型接口——先加提供方，再接入。
 */
export function MagpieNextSteps({ providers }: { providers: number }) {
  return (
    <Card className={cn("sysupd-note magpie-next mt-2")} role="note">
      <span aria-hidden className="sysupd-note-ic">
        <IconCheck className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h4>{"Magpie 已经装好，接入还差两步"}</h4>
        <ol className="magpie-next-steps">
          <li data-done={providers > 0 ? "" : undefined}>
            {providers > 0
              ? `已添加 ${providers} 个提供方。`
              : "打开 Magpie 管理，添加一个模型服务或账户（提供方）。"}
          </li>
          <li>
            {
              "在 Magpie 的「网关 → 网关密钥」里为 ChisaBot 创建一个密钥，再到「模型设置」把接口地址改为 http://magpie:3425/v1、填上这个密钥。"
            }
          </li>
        </ol>
      </div>
      <div className="magpie-next-actions">
        <Button
          nativeButton={false}
          render={<Link to="/admin/magpie/console" />}
          size="sm"
        >
          {"打开 Magpie 管理"}
        </Button>
        <Button
          nativeButton={false}
          render={<Link to="/admin/models" />}
          size="sm"
          variant="ghost"
        >
          {"模型设置"}
          <IconArrowRight />
        </Button>
      </div>
    </Card>
  );
}
