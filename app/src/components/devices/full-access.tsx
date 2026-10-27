import {
  IconAlertTriangle,
  IconBolt,
  IconCode,
  IconPlayerStopFilled,
  IconServer,
  IconTerminal2,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { DeviceAuditEntry, DeviceView } from "../../../../shared/devices";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import { Card, SettingRow } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  createPairing,
  type DeviceJob,
  deviceActivityQueryOptions,
  deviceKeys,
  fullAccessUntilText,
  killDeviceJob,
  nodeInstallCommand,
  type PairingTicket,
  patchDevice,
} from "@/lib/devices";
import { cn } from "@/lib/utils";

/**
 * 完全访问（DESIGN.md §58，docs/pc-node.md §13）、设备页「运行中」（后台命令 + 最近改动）、
 * 「添加一台服务器」（chisabot-node 一行安装命令）。
 */

type Duration = "1h" | "24h" | "permanent";
const DURATIONS: Array<{ value: Duration; label: string }> = [
  { value: "1h", label: "1 小时" },
  { value: "24h", label: "24 小时" },
  { value: "permanent", label: "永久" },
];

/** 完全访问徽标（红橙色，闪电图标）：列表行和详情页头用。 */
export function FullAccessBadge({ device, size }: { device: Pick<DeviceView, "fullAccess">; size?: "sm" }) {
  if (!device.fullAccess) return null;
  return (
    <span className={cn("device-badge is-full", size === "sm" && "is-sm")}>
      <IconBolt className="size-3" />
      <T>{"完全访问"}</T>
    </span>
  );
}

/** 权限页顶部的「完全访问」卡片。开着时整张卡片是警示色，带到期时间和「立即关闭」。 */
export function FullAccessCard({ device }: { device: DeviceView }) {
  const queryClient = useQueryClient();
  const [duration, setDuration] = useState<Duration>("1h");
  const on = !!device.fullAccess;
  const apply = useAsyncAction(
    async (value: Duration | "off") => {
      const next = await patchDevice(device.id, { fullAccess: value });
      queryClient.setQueryData(deviceKeys.detail(device.id), next);
      void queryClient.invalidateQueries({ queryKey: deviceKeys.all });
    },
    { errorToast: (error) => `操作失败：${error.message}` },
  );
  const turnOn = async () => {
    const ok = await confirmDialog({
      title: `允许机器人完全访问「${device.name}」？`,
      description:
        "开启后，你的机器人可以不经询问运行任何命令、读写这台设备上的任何文件（整台电脑、所有磁盘）、长时间运行程序，也可以用管理员身份运行命令。所有操作仍会记录在「操作记录」里，紧急停止随时可以立即关闭它。只在你信任这些机器人、并且清楚它们要做什么时开启。",
      confirmLabel: `开启（${DURATIONS.find((d) => d.value === duration)?.label}）`,
      destructive: true,
    });
    if (ok) void apply.run(duration);
  };
  const disabled = device.revoked || device.paused;
  // 分段选择的键盘约定（2026-10-20）：Tab 停在当前时长，方向键换时长、焦点跟随。
  const durationKeys = useSegmentedKeys<Duration>({
    value: duration,
    values: DURATIONS.map((item) => item.value),
    onChange: setDuration,
    disabled,
  });
  return (
    <section className="device-section">
      <h2 className="device-section-t">{"完全访问"}</h2>
      <Card className={cn("full-access-card", on && "is-on")}>
        <div className="full-access-head">
          <span aria-hidden className="full-access-ic">
            {on ? <IconBolt className="size-5" /> : <IconAlertTriangle className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="full-access-t">
              {on ? `完全访问已开启 · ${fullAccessUntilText(device.fullAccessUntil)}` : "像本机安装的智能体一样使用这台设备"}
            </div>
            <p className="full-access-s">
              {on
                ? "机器人现在可以直接执行一切操作：不弹窗询问、不限文件夹、命令不限 10 分钟、可以用管理员身份运行。所有操作照常记录；按「紧急停止」也会立即关闭完全访问。"
                : "所有能力按「允许」执行，不再逐次询问（也跳过这台电脑上的本机确认）；不限「允许的文件夹」，可以访问整台电脑；后台命令不限时长；可以申请管理员 / root 权限。只能由你在这里打开，机器人不能自己开启。开启后 PC 客户端还会在本机再确认一次。"}
            </p>
            {device.online && device.features && !device.features.includes("edit_file") ? (
              <p className="full-access-s is-warn">{"这台设备上的客户端版本较旧，完全访问和编码工具需要 ChisaBot PC 0.1.8+（服务器节点重新运行安装命令即可升级）。"}</p>
            ) : null}
          </div>
        </div>
        <div className="full-access-actions">
          {on ? (
            <Button
              feedback={{ pending: "关闭中…", success: "已关闭", error: "关闭失败" }}
              onClick={() => void apply.run("off")}
              size="sm"
              state={apply.state}
              variant="destructive"
            >
              <IconPlayerStopFilled />
              {"立即关闭"}
            </Button>
          ) : (
            <>
              <div aria-label="完全访问时长" className="sg-segmented" {...durationKeys.groupProps} ref={durationKeys.groupRef} role="radiogroup">
                {DURATIONS.map((item) => (
                  // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
                  <button
                    aria-checked={duration === item.value}
                    className="sg-segmented-item"
                    disabled={disabled}
                    key={item.value}
                    onClick={() => setDuration(item.value)}
                    role="radio"
                    tabIndex={durationKeys.itemTabIndex(item.value)}
                    type="button"
                  >
                    <T>{item.label}</T>
                  </button>
                ))}
              </div>
              <Button
                disabled={disabled}
                feedback={{ pending: "开启中…", success: "已开启", error: "开启失败" }}
                onClick={() => void turnOn()}
                size="sm"
                state={apply.state}
                variant="destructive"
              >
                <IconBolt />
                {"开启完全访问…"}
              </Button>
            </>
          )}
        </div>
        {device.paused && !on ? <p className="full-access-s full-access-note">{"紧急停止中，先解除紧急停止才能开启。"}</p> : null}
      </Card>
    </section>
  );
}

function jobStatusText(job: DeviceJob) {
  if (job.status === "running") return `运行中 · ${durationText(job.runningSec)}`;
  if (job.status === "killed") return "已结束";
  if (job.status === "timeout") return "超时结束";
  return `已退出（${job.exitCode ?? "?"}）`;
}

function durationText(sec: number) {
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分`;
}

function JobRow({ deviceId, job }: { deviceId: string; job: DeviceJob }) {
  const queryClient = useQueryClient();
  const kill = useAsyncAction(
    async () => {
      await killDeviceJob(deviceId, job.jobId);
      await queryClient.invalidateQueries({ queryKey: deviceKeys.activity(deviceId) });
    },
    { errorToast: (error) => `结束失败：${error.message}` },
  );
  const running = job.status === "running";
  return (
    <div className={cn("device-job list-enter", !running && "is-done")}>
      <span aria-hidden className={cn("device-job-dot", running && "is-running")} />
      <div className="min-w-0 flex-1">
        <code className="device-job-cmd" title={job.command}>
          {job.command}
        </code>
        <div className="device-job-meta">
          {[jobStatusText(job), job.botName, job.cwd, job.elevated ? "管理员" : null].filter(Boolean).join(" · ")}
        </div>
        {job.lastLine ? <code className="device-job-last">{job.lastLine}</code> : null}
      </div>
      {running ? (
        <Button feedback={{ pending: "结束中…", success: "已结束", error: "失败" }} onClick={() => void kill.run()} size="sm" state={kill.state} variant="outline">
          <IconPlayerStopFilled />
          {"结束"}
        </Button>
      ) : null}
    </div>
  );
}

function EditRow({ entry }: { entry: DeviceAuditEntry }) {
  const [open, setOpen] = useState(false);
  const diff = entry.detail?.split("\n").filter((line) => line !== "完全访问" && !line.startsWith("已在")) ?? [];
  const hasDiff = diff.some((line) => line.startsWith("@@") || line.startsWith("+") || line.startsWith("-"));
  return (
    <div className="device-edit">
      <button className="device-edit-head" disabled={!hasDiff} onClick={() => setOpen((v) => !v)} type="button">
        <IconCode aria-hidden className="size-4 shrink-0" />
        <span className="device-edit-t">{entry.summary ?? entry.action}</span>
        <span className="device-edit-m">
          {[entry.actorName, new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })].filter(Boolean).join(" · ")}
        </span>
      </button>
      {open && hasDiff ? (
        <pre className="device-diff">
          {diff.map((line, index) => (
            <span
              className={cn(
                line.startsWith("+") && !line.startsWith("+++") && "is-add",
                line.startsWith("-") && !line.startsWith("---") && "is-del",
                line.startsWith("@@") && "is-hunk",
              )}
              // biome-ignore lint/suspicious/noArrayIndexKey: diff 文本按行渲染：只读、不重排、行没有稳定 id
              key={index}
            >
              {`${line}\n`}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

/** 设备页「运行中」：后台命令（3 秒刷新，可结束）+ 持久会话 + 最近的文件改动（可展开看 diff）。 */
export function DeviceActivityPanel({ device }: { device: DeviceView }) {
  const activity = useQuery(deviceActivityQueryOptions(device.id, !device.revoked));
  const live = activity.data?.live;
  const jobs = live?.jobs ?? [];
  const running = jobs.filter((job) => job.status === "running");
  const done = jobs.filter((job) => job.status !== "running").slice(0, 8);
  const edits = activity.data?.edits ?? [];
  return (
    <>
      <section className="device-section">
        <h2 className="device-section-t">{`正在运行${running.length ? `（${running.length}）` : ""}`}</h2>
        <Card>
          {activity.isPending ? (
            <div className="device-job-empty">{"读取中…"}</div>
          ) : !live ? (
            <div className="device-job-empty">{activity.data?.liveError ?? "暂时读不到。"}</div>
          ) : jobs.length ? (
            [...running, ...done].map((job) => <JobRow deviceId={device.id} job={job} key={job.jobId} />)
          ) : (
            <div className="device-job-empty">{"没有后台命令。机器人运行构建、测试、开发服务器等长时间命令时会出现在这里，可以随时结束。"}</div>
          )}
          {live?.sessions.length ? (
            <SettingRow
              description={live.sessions.map((s) => `${s.name}：${s.cwd}（${s.commands} 条命令）`).join("；")}
              title={
                <span className="device-cap-t">
                  <IconTerminal2 className="size-4" />
                  {`命令行会话（${live.sessions.length}）`}
                </span>
              }
            />
          ) : null}
          {live?.elevatedHelper ? (
            <SettingRow description={`启动于 ${new Date(live.elevatedHelper.startedAt).toLocaleTimeString("zh-CN", { hour12: false })}，空闲 30 分钟自动退出`} title="管理员助手运行中" />
          ) : null}
        </Card>
      </section>
      <section className="device-section">
        <h2 className="device-section-t">{"最近的改动"}</h2>
        <Card>
          {edits.length ? (
            edits.map((entry) => <EditRow entry={entry} key={entry.id} />)
          ) : (
            <div className="device-job-empty">{"还没有机器人改过这台设备上的文件。"}</div>
          )}
        </Card>
      </section>
    </>
  );
}

/** 「添加一台服务器」：生成一次性安装码（30 分钟），拼成一行命令，复制到服务器上运行。 */
export function AddServerCard() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const [ticket, setTicket] = useState<PairingTicket | null>(null);
  const [fullAccess, setFullAccess] = useState(true);
  const issue = useAsyncAction(async () => setTicket(await createPairing("node")), { errorToast: (error) => error.message });
  const command = ticket ? nodeInstallCommand(origin, ticket.code, { fullAccess }) : "";
  return (
    <Card className="device-steps pair-card">
      <div className="pair-card-row">
        <span aria-hidden className="pair-card-ic">
          <IconServer className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <b>{"Linux / macOS 服务器"}</b>
          <span>
            {"在服务器上运行一行命令安装 chisabot-node：自动准备 Node.js、用一次性安装码登记到这个账号、注册成系统服务（systemd / launchd），开机自启、断线自动重连。机器人就能在这台服务器上搜索、修改代码、跑测试和命令。"}
          </span>
        </div>
        {!ticket ? (
          <Button feedback={{ pending: "生成中…", success: "已生成", error: "失败" }} onClick={() => void issue.run()} size="sm" state={issue.state}>
            {"生成安装命令"}
          </Button>
        ) : null}
      </div>
      {ticket ? (
        <div className="node-install">
          <div className="node-install-cmd">
            <code className="device-code">{command}</code>
            <CopyButton size="sm" value={command} variant="ghost" />
          </div>
          <SettingRow
            description="允许以后在网页上为这台服务器打开「完全访问」。关掉时，即使网页上打开，服务器也会立刻拒绝。"
            title="允许完全访问"
          >
            <Switch checked={fullAccess} onCheckedChange={(value) => setFullAccess(value)} />
          </SettingRow>
          <p className="node-install-s">
            {`安装码 ${Math.round(ticket.ttlSeconds / 60)} 分钟内有效、只能用一次。用 root 运行 = 系统服务（/opt/chisabot-node），普通用户 = 用户服务（~/.chisabot-node）。只想试试不装服务：命令末尾加 --no-service。`}
          </p>
          <Button onClick={() => void issue.run()} size="sm" state={issue.state} variant="ghost">
            {"换一个安装码"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
