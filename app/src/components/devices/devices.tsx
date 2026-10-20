import {
  IconBrandAndroid,
  IconBrandApple,
  IconBrandWindows,
  IconCheck,
  IconChevronRight,
  IconClipboard,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDots,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconFolderPlus,
  IconKeyboard,
  IconPencil,
  IconPhoto,
  IconPlayerStopFilled,
  IconRobot,
  IconServer,
  IconShieldCheck,
  IconTerminal2,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  CAPABILITY_INFO,
  type CapabilityPolicy,
  DEVICE_CAPABILITIES,
  type DeviceApprovalView,
  type DeviceAuditEntry,
  type DeviceCapabilities,
  type DeviceCapability,
  type DeviceView,
  isMobilePlatform,
  OPERATION_LABEL,
} from "../../../../shared/devices";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { Card, CardHeader, EmptyState, ListRow, SaveBar, SettingRow } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import {
  ACTION_LABEL,
  bytesText,
  decideApproval,
  deleteDevice,
  deviceKeys,
  lastUsedText,
  DEVICE_KIND_LABEL,
  deviceKind,
  linkedText,
  OUTCOME_LABEL,
  type PcDownload,
  patchDevice,
  pcDownloadQueryOptions,
  platformLabel,
  revokeDevice,
  seenText,
} from "@/lib/devices";
import { type PcLocalPatch, type PcLocalState, type PcUpdateState, pcBridge } from "@/lib/pc-bridge";
import { cn } from "@/lib/utils";
import { FullAccessBadge, FullAccessCard } from "./full-access";
import { PairPhoneButton } from "./pair-phone";

const CAP_ICON: Record<DeviceCapability, typeof IconTerminal2> = {
  shell: IconTerminal2,
  files_read: IconFileText,
  files_write: IconPencil,
  screenshot: IconPhoto,
  input: IconKeyboard,
  open: IconExternalLink,
  clipboard: IconClipboard,
};

export function platformIcon(platform: string, kind?: "pc" | "server" | "phone") {
  if (kind === "server") return IconServer;
  if (platform === "win32") return IconBrandWindows;
  if (platform === "android") return IconBrandAndroid;
  if (platform === "darwin") return IconBrandApple;
  if (platform === "ios") return IconDeviceMobile;
  return IconDeviceDesktop;
}

export function DeviceIcon({
  device,
  size = "md",
}: {
  device: Pick<DeviceView, "platform" | "online" | "paused" | "revoked"> & Partial<Pick<DeviceView, "clientVersion">>;
  size?: "md" | "lg";
}) {
  const Icon = platformIcon(device.platform, deviceKind({ platform: device.platform, clientVersion: device.clientVersion ?? null }));
  const status = device.revoked ? "is-revoked" : device.paused ? "is-paused" : device.online ? "is-online" : "is-offline";
  return (
    <span className={cn("device-icon", size === "lg" && "is-lg", status)}>
      <Icon className={size === "lg" ? "size-8" : "size-5"} />
      <span aria-hidden className="device-icon-dot" />
    </span>
  );
}

export function StatusBadge({ device }: { device: Pick<DeviceView, "online" | "paused" | "revoked"> }) {
  if (device.revoked) return <span className="device-badge is-muted"><T>{"已撤销"}</T></span>;
  if (device.paused)
    return (
      <span className="device-badge is-danger">
        <IconPlayerStopFilled className="size-3" />
        <T>{"已紧急停止"}</T>
      </span>
    );
  return device.online ? (
    <span className="device-badge is-ok">
      <span aria-hidden className="device-dot is-ok" />
      <T>{"在线"}</T>
    </span>
  ) : (
    <span className="device-badge">
      <span aria-hidden className="device-dot" />
      <T>{"离线"}</T>
    </span>
  );
}

export function ThisPcBadge() {
  return (
    <span className="device-badge is-accent">
      <IconDeviceDesktop className="size-3" />
      <T>{"这台电脑"}</T>
    </span>
  );
}

/** 「Windows 11 Pro 24H2」：系统版本里已经带了系统名时不再重复「Windows」。 */
function osText(platform: string, osVersion: string | null) {
  const label = platformLabel(platform);
  if (!osVersion) return label;
  return osVersion.toLowerCase().includes(label.toLowerCase()) ? osVersion : `${label} ${osVersion}`;
}

function enabledCaps(capabilities: DeviceCapabilities) {
  return DEVICE_CAPABILITIES.filter((cap) => capabilities[cap] !== "off");
}

/** 设备列表的一行：点主体进详情；右侧 ⋯ 菜单 = 查看详情 / 能力与权限 / 重命名… / 撤销… / 删除…。 */
export function DeviceRow({ device, showOwner, isThisPc }: { device: DeviceView; showOwner?: boolean; isThisPc?: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const caps = enabledCaps(device.capabilities);
  const mobile = isMobilePlatform(device.platform);
  const refresh = () => queryClient.invalidateQueries({ queryKey: deviceKeys.all });
  const revoke = useAsyncAction(
    async () => {
      await revokeDevice(device.id);
      await refresh();
    },
    { errorToast: (error) => `撤销失败：${error.message}` },
  );
  const remove = useAsyncAction(
    async () => {
      await deleteDevice(device.id);
      await refresh();
    },
    { errorToast: (error) => `删除失败：${error.message}` },
  );
  const busy =
    revoke.state === "pending" ? "撤销中…" : remove.state === "pending" ? "删除中…" : revoke.state === "success" ? "已撤销" : remove.state === "success" ? "已删除" : null;
  const facts = [
    `${DEVICE_KIND_LABEL[deviceKind(device)]} · ${osText(device.platform, device.osVersion)}`,
    device.clientVersion ? `客户端 ${device.clientVersion}` : null,
    // 在线时右侧徽标已经写了「在线」，这里只在离线时写最后在线时间。
    device.online ? null : seenText(device.lastSeenAt, device.online),
    linkedText(device.createdAt),
    showOwner ? `所有者 ${device.ownerUserId.slice(0, 8)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={cn("device-row", busy && "is-busy")}>
      <Link className="device-row-link" params={{ deviceId: device.id }} to="/settings/devices/$deviceId">
        <ListRow
          actions={
            <span className="device-row-actions">
              {isThisPc ? <ThisPcBadge /> : null}
              {busy ? null : <FullAccessBadge device={device} size="sm" />}
              {busy ? (
                <span aria-live="polite" className={cn("device-badge", busy.startsWith("已") ? "is-muted" : "is-warn")}>
                  <T>{busy}</T>
                </span>
              ) : (
                <StatusBadge device={device} />
              )}
            </span>
          }
          icon={<DeviceIcon device={device} />}
          sub={
            <>
              <span className="device-row-facts">{facts}</span>
              <span className="device-row-meta">
                {device.revoked ? (
                  <span className="device-cap-chip is-off"><T>{"令牌已作废"}</T></span>
                ) : mobile ? (
                  <span className="device-cap-chip is-mobile"><T>{"扫码绑定 · 用于登录聊天"}</T></span>
                ) : caps.length ? (
                  caps.map((cap) => (
                    <span className={cn("device-cap-chip", device.capabilities[cap] === "ask" && "is-ask")} key={cap}>
                      <T>{`${CAPABILITY_INFO[cap].label}${device.capabilities[cap] === "ask" ? "·询问" : ""}`}</T>
                    </span>
                  ))
                ) : (
                  <span className="device-cap-chip is-off"><T>{"能力全部关闭"}</T></span>
                )}
                {device.lastUsedBy ? (
                  <span className="device-row-used">
                    <IconRobot aria-hidden className="size-3.5" />
                    {lastUsedText(device.lastUsedBy)}
                  </span>
                ) : null}
              </span>
            </>
          }
          title={device.name}
        />
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button aria-label={`「${device.name}」的更多操作`} className="device-row-more" title={"更多操作"} type="button" />
          }
        >
          <IconDots className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="glass-pop w-[220px] p-1.5">
          <DropdownMenuItem
            className="glass-mi"
            onClick={() => void navigate({ to: "/settings/devices/$deviceId", params: { deviceId: device.id } })}
          >
            <IconChevronRight className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{"查看详情"}</span>
          </DropdownMenuItem>
          {!device.revoked ? (
            <>
              {mobile ? null : (
                <DropdownMenuItem
                  className="glass-mi"
                  onClick={() =>
                    void navigate({ to: "/settings/devices/$deviceId", params: { deviceId: device.id }, search: { tab: "permissions" } })
                  }
                >
                  <IconShieldCheck className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"能力与权限"}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="glass-mi" onClick={() => setRenaming(true)}>
                <IconPencil className="size-[18px] shrink-0 opacity-80" />
                <span className="min-w-0 flex-1">{"重命名…"}</span>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator className="glass-sep" />
          {!device.revoked ? (
            <DropdownMenuItem
              className="glass-mi is-danger"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: `撤销「${device.name}」？`,
                  description: mobile
                    ? "这台手机会在半分钟内退出登录，回到登录页。需要重新扫码才能再次绑定。"
                    : "这台设备会立即断开，所有机器人都不能再使用它。客户端需要重新登录才能再次关联。",
                  confirmLabel: "撤销",
                  destructive: true,
                });
                if (ok) void revoke.run();
              }}
            >
              <IconPlayerStopFilled className="size-[18px] shrink-0 opacity-80" />
              <span className="min-w-0 flex-1">{"撤销关联…"}</span>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="glass-mi is-danger"
            onClick={async () => {
              const ok = await confirmDialog({
                title: `删除「${device.name}」？`,
                description: "会同时删除这台设备的权限设置和全部操作记录，无法恢复。",
                confirmLabel: "删除",
                destructive: true,
              });
              if (ok) void remove.run();
            }}
          >
            <IconTrash className="size-[18px] shrink-0 opacity-80" />
            <span className="min-w-0 flex-1">{"删除…"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDeviceDialog device={device} onOpenChange={setRenaming} open={renaming} />
    </div>
  );
}

/** 重命名设备的玻璃弹窗（异步保存按钮：保存中… → ✓ 已保存，然后自动关闭）。 */
export function RenameDeviceDialog({
  device,
  open,
  onOpenChange,
}: {
  device: Pick<DeviceView, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(device.name);
  useEffect(() => {
    if (open) setName(device.name);
  }, [open, device.name]);
  const trimmed = name.trim();
  const save = useAsyncAction(async () => {
    const next = await patchDevice(device.id, { name: trimmed });
    queryClient.setQueryData(deviceKeys.detail(device.id), next);
    await queryClient.invalidateQueries({ queryKey: deviceKeys.all });
    setTimeout(() => onOpenChange(false), 600);
  });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{"重命名设备"}</DialogTitle>
          <DialogDescription>{"名字会显示在设备列表、审批弹窗和机器人看到的设备列表里。"}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed && trimmed !== device.name && save.state !== "pending") void save.run();
          }}
        >
          <Input aria-label="设备名称" autoFocus maxLength={64} onChange={(event) => setName(event.target.value)} value={name} />
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              {"取消"}
            </Button>
            <Button disabled={!trimmed || trimmed === device.name} feedback="save" state={save.state} type="submit">
              {"保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 审批剩余时间。expiresAt / createdAt 都是服务器时钟，而这台电脑 / 手机的时钟可能和服务器差几十秒甚至几分钟，
 * 直接拿 expiresAt − Date.now() 会出现一打开就「0 秒」。所以：本机算出的剩余时间落在 (0, 总时长] 内才信它，
 * 否则按「刚收到」处理（剩余 = 总时长），之后用本机的单调时钟倒数。
 */
function useApprovalCountdown(approval: Pick<DeviceApprovalView, "createdAt" | "expiresAt">) {
  const [deadline] = useState(() => {
    const ttl = Math.max(0, Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)) || 120_000;
    const naive = Date.parse(approval.expiresAt) - Date.now();
    return performance.now() + (naive > 0 && naive <= ttl ? naive : ttl);
  });
  const [left, setLeft] = useState(() => Math.max(0, deadline - performance.now()));
  useEffect(() => {
    const timer = setInterval(() => setLeft(Math.max(0, deadline - performance.now())), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return left;
}

function ApprovalRow({ approval }: { approval: DeviceApprovalView }) {
  const queryClient = useQueryClient();
  const decide = useAsyncAction(async (decision: "approve" | "deny") => {
    await decideApproval(approval.id, decision);
    await queryClient.invalidateQueries({ queryKey: deviceKeys.all });
  });
  const left = useApprovalCountdown(approval);
  return (
    <div className="device-approval list-enter">
      <span className="device-approval-ic">
        <IconShieldCheck className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="device-approval-t">
          {`${approval.botName ?? "机器人"} 想在「${approval.deviceName}」上${OPERATION_LABEL[approval.operation]}`}
        </div>
        <code className="device-approval-s">{approval.summary}</code>
        {approval.diff ? <DiffBlock diff={approval.diff} /> : null}
        <div className="device-approval-m">
          {`${left > 0 ? `${Math.ceil(left / 1000)} 秒后自动拒绝` : "即将自动拒绝"} · 也可以在这台电脑的弹窗里处理`}
        </div>
      </div>
      <div className="device-approval-a">
        <Button
          feedback={{ pending: "处理中…", success: "已处理", error: "失败" }}
          onClick={() => void decide.run("deny")}
          size="sm"
          state={decide.state}
          variant="outline"
        >
          <IconX />
          {"拒绝"}
        </Button>
        <Button onClick={() => void decide.run("approve")} disabled={decide.state === "pending"} size="sm">
          <IconCheck />
          {"允许"}
        </Button>
      </div>
    </div>
  );
}

/** 审批卡片里的改动预览：删行红、加行绿，最多 240px 高可滚动。 */
export function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n").slice(0, 400);
  return (
    <pre className="device-diff is-approval">
      {lines.map((line, index) => (
        <span
          className={cn(
            line.startsWith("+") && !line.startsWith("+++") && "is-add",
            line.startsWith("-") && !line.startsWith("---") && "is-del",
            line.startsWith("@@") && "is-hunk",
          )}
          key={index}
        >
          {`${line}\n`}
        </span>
      ))}
    </pre>
  );
}

export function ApprovalsCard({ approvals }: { approvals: DeviceApprovalView[] }) {
  if (!approvals.length) return null;
  return (
    <Card className="device-approvals">
      <CardHeader
        description="机器人请求的操作需要你确认。允许后只执行这一次。"
        icon={<IconShieldCheck className="size-5" />}
        title={`等待你审批（${approvals.length}）`}
      />
      {approvals.map((approval) => (
        <ApprovalRow approval={approval} key={approval.id} />
      ))}
    </Card>
  );
}

export function DownloadCard({ download }: { download: PcDownload | null | undefined }) {
  const installer = download?.files.find((file) => file.kind === "installer");
  const portable = download?.files.find((file) => file.kind === "portable");
  return (
    <Card>
      <CardHeader
        action={
          installer ? (
            <Button nativeButton={false} render={<a download href={installer.url} />} size="sm">
              <IconDownload />
              {"下载安装包"}
            </Button>
          ) : undefined
        }
        description={
          download
            ? `版本 ${download.version} · Windows 10 / 11（64 位）${installer ? ` · 安装包 ${bytesText(installer.bytes)}` : ""}`
            : "安装包还没有发布到这台服务器。"
        }
        icon={<IconBrandWindows className="size-5" />}
        title="ChisaBot PC 客户端"
      />
      {portable ? (
        <SettingRow description={`解压即用，不写注册表 · ${bytesText(portable.bytes)}`} title="免安装版（zip）">
          <Button nativeButton={false} render={<a download href={portable.url} />} size="sm" variant="ghost">
            <IconDownload />
            {"下载"}
          </Button>
        </SettingRow>
      ) : null}
      {installer?.sha256 ? (
        <SettingRow description={<code className="device-code device-sha">{installer.sha256}</code>} title="SHA-256" />
      ) : null}
    </Card>
  );
}

/**
 * 设备页顶部的「连接状态」（2026-10-13，用户：「我安装了 Windows 端，但是 bot 还是识别不到我的电脑」）。
 * 一眼说清三件事：机器人现在能不能用到你的电脑（在线几台 / 都离线时怎么办）、谁能用（你的所有机器人）、
 * 能力是不是全关着。在 PC 客户端里再加一行「这台电脑」：没登记 / 令牌失效时给「登记这台电脑」按钮。
 */
export function ConnectionCard({
  devices,
  local,
  onLocal,
}: {
  devices: DeviceView[];
  local: PcLocalState | null;
  onLocal: (next: PcLocalState) => void;
}) {
  const bridge = pcBridge();
  const enroll = useAsyncAction(async () => {
    if (!bridge?.enroll) return;
    const result = await bridge.enroll();
    onLocal(result.state);
    if (result.status === "enrolled" || result.status === "already") toast.success(result.message);
    else if (result.status !== "cancelled") throw new Error(result.message);
  }, { errorToast: (error) => error.message });
  const reconnect = useAsyncAction(async () => {
    if (!bridge?.reconnect) return;
    const result = await bridge.reconnect();
    onLocal(result.state);
    if (result.status === "failed" || result.status === "login") throw new Error(result.message);
  }, { errorToast: (error) => error.message });
  const online = devices.filter((device) => device.online);
  const thisPc = local ? devices.find((device) => device.id === local.deviceId) : undefined;
  const pcConnected = local ? local.agentState === "online" : false;
  const allOff = online.length > 0 && online.every((device) => enabledCaps(device.capabilities).length === 0);
  // 网页里看不到 PC 就不显示（没有设备时「添加一台电脑」已经说清楚了）。
  if (!devices.length && !local) return null;
  const summary = online.length
    ? `${online.map((device) => `「${device.name}」`).join("、")}在线：你的所有机器人都能使用，范围是每台开启的能力和允许的文件夹。`
    : devices.length
      ? "都不在线，机器人现在用不了你的电脑。在电脑上打开 ChisaBot PC，托盘图标变蓝就是在线；问机器人时它也会如实告诉你。"
      : "这台电脑还没有关联到你的账号。";
  return (
    <Card className="device-connection">
      <SettingRow description={summary} title="机器人能用的设备">
        <span className={cn("device-badge", online.length ? "is-ok" : "is-warn")}>
          <span aria-hidden className={cn("device-dot", online.length && "is-ok")} />
          <T>{online.length ? `${online.length} 台在线` : "没有在线设备"}</T>
        </span>
      </SettingRow>
      {allOff ? (
        <SettingRow
          description="机器人现在只能看到电脑在线、读系统信息。要让它截图、读写文件或操作鼠标键盘，进入设备详情 → 权限，把需要的能力设为「询问」或「允许」。"
          title="能力全部关闭"
        >
          {online[0] ? (
            <Button
              nativeButton={false}
              render={<Link params={{ deviceId: online[0].id }} search={{ tab: "permissions" }} to="/settings/devices/$deviceId" />}
              size="sm"
              variant="outline"
            >
              {"打开权限"}
            </Button>
          ) : null}
        </SettingRow>
      ) : null}
      {local ? (
        <SettingRow
          description={
            pcConnected
              ? `已连接${thisPc ? `为「${thisPc.name}」` : ""} · 客户端 ${local.version}`
              : local.needsEnroll
                ? `${local.statusText}。点「登记这台电脑」用当前登录重新关联，能力默认「询问」（每次要你批准）。`
                : `${local.statusText} · 客户端 ${local.version}${local.networkRoute ? ` · ${local.networkRoute}` : ""}`
          }
          title={
            <span className="device-cap-t">
              <IconDeviceDesktop className="size-4" />
              {"这台电脑"}
            </span>
          }
        >
          {local.needsEnroll && bridge?.enroll ? (
            <Button
              feedback={{ pending: "登记中…", success: "已登记", error: "失败" }}
              onClick={() => void enroll.run()}
              size="sm"
              state={enroll.state}
            >
              {"登记这台电脑"}
            </Button>
          ) : !pcConnected && !local.localPaused && local.agentState !== "revoked" && bridge?.reconnect ? (
            // 客户端离线：原因已经写在说明里（statusText 带真实原因），这里给一个立刻重连的按钮，不用等退避。
            <Button
              feedback={{ pending: "连接中…", success: "已发起", error: "失败" }}
              onClick={() => void reconnect.run()}
              size="sm"
              state={reconnect.state}
              variant="outline"
            >
              {"重新连接"}
            </Button>
          ) : (
            <span className={cn("device-badge", pcConnected ? "is-ok" : local.localPaused ? "is-danger" : "is-warn")}>
              {pcConnected ? <span aria-hidden className="device-dot is-ok" /> : null}
              <T>{pcConnected ? "在线" : local.statusText}</T>
            </span>
          )}
        </SettingRow>
      ) : null}
    </Card>
  );
}

export function AddDeviceCard() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const download = useQuery(pcDownloadQueryOptions());
  return (
    <>
      <DownloadCard download={download.data} />
      <Card className="device-steps">
        <ol>
          <li>
            <b>{"安装并打开 PC 客户端"}</b>
            <span>{"首次打开会出现设置向导。"}</span>
          </li>
          <li>
            <b>{"填写服务器地址"}</b>
            <span className="device-step-inline">
              <code className="device-code">{origin}</code>
              <CopyButton size="sm" value={origin} variant="ghost" />
            </span>
          </li>
          <li>
            <b>{"用 ChisaBot 账号密码登录"}</b>
            <span>{"登录后这台电脑会出现在下方列表里。能力默认「询问」：机器人每次操作都会弹窗请你批准，可以在这里改成「允许」或「关闭」。"}</span>
          </li>
        </ol>
      </Card>
    </>
  );
}

/** 「添加一台手机」：扫码绑定（DESIGN.md §33）。 */
export function AddPhoneCard() {
  return (
    <Card className="device-steps pair-card">
      <div className="pair-card-row">
        <span aria-hidden className="pair-card-ic">
          <IconDeviceMobile className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <b>{"用手机扫码登录"}</b>
          <span>{"在 ChisaBot 安卓 App 的登录页点「扫码绑定」，扫一下就登录到这个账号并直接进入主机器人，不用输入地址和密码。二维码 5 分钟有效、只能用一次；随时可以在这里撤销，手机会自动退出登录。"}</span>
        </div>
        <PairPhoneButton variant="default" />
      </div>
    </Card>
  );
}

export function NoDevices() {
  return (
    <EmptyState
      description="在电脑上安装 ChisaBot PC 客户端并用这个账号登录，或用安卓 App 扫「绑定手机」的二维码，它就会出现在这里。电脑关联后你的每个机器人都能在你开启的能力范围内使用它（能力默认「询问」，每次操作要你批准）；手机只用来登录聊天。"
      icon={<IconDeviceDesktop className="size-6" />}
      title="还没有关联的设备"
    />
  );
}

const POLICIES: Array<{ value: CapabilityPolicy; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "ask", label: "询问" },
  { value: "allow", label: "允许" },
];

function PolicySegmented({
  value,
  onChange,
  label,
  disabled,
}: {
  value: CapabilityPolicy;
  onChange: (value: CapabilityPolicy) => void;
  label: string;
  disabled?: boolean;
}) {
  // 分段选择的键盘约定（2026-10-20）：roving tabindex + 方向键换档。
  const keys = useSegmentedKeys<CapabilityPolicy>({
    value,
    values: POLICIES.map((policy) => policy.value),
    onChange,
    disabled,
  });
  return (
    <div aria-label={label} className="sg-segmented device-seg" {...keys.groupProps} ref={keys.groupRef} role="radiogroup">
      {POLICIES.map((policy) => (
        <button
          aria-checked={value === policy.value}
          className={cn("sg-segmented-item", `is-${policy.value}`)}
          disabled={disabled}
          key={policy.value}
          onClick={() => onChange(policy.value)}
          role="radio"
          tabIndex={keys.itemTabIndex(policy.value)}
          type="button"
        >
          {policy.label}
        </button>
      ))}
    </div>
  );
}

type Draft = {
  capabilities: DeviceCapabilities;
  allowedRoots: string[];
  name: string;
};

function draftOf(device: DeviceView): Draft {
  return {
    capabilities: { ...device.capabilities },
    allowedRoots: [...device.allowedRoots],
    name: device.name,
  };
}

function sameDraft(a: Draft, b: Draft) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 权限页：能力、允许的文件夹、谁可以使用（说明 + 最近使用）、名称；改动后出现未保存栏。 */
export function DevicePermissions({ device, isThisPc = false }: { device: DeviceView; isThisPc?: boolean }) {
  const queryClient = useQueryClient();
  const base = useMemo(() => draftOf(device), [device]);
  const [draft, setDraft] = useState<Draft>(base);
  const [touched, setTouched] = useState(false);
  const [newRoot, setNewRoot] = useState("");
  // 服务器（或 PC 上）改了配置而本页没有未保存的改动时，跟上最新值。
  useEffect(() => {
    if (!touched) setDraft(base);
  }, [base, touched]);
  const dirty = touched && !sameDraft(draft, base);
  const locked = device.revoked;

  const save = useAsyncAction(async () => {
    const next = await patchDevice(device.id, {
      capabilities: draft.capabilities,
      allowedRoots: draft.allowedRoots,
      name: draft.name.trim() || device.name,
    });
    queryClient.setQueryData(deviceKeys.detail(device.id), next);
    void queryClient.invalidateQueries({ queryKey: deviceKeys.all });
    setTouched(false);
  });

  const update = (fn: (current: Draft) => Draft) => {
    setTouched(true);
    setDraft(fn);
  };
  const addRoots = (paths: string[]) =>
    update((current) => {
      const next = [...current.allowedRoots];
      for (const value of paths) if (!next.some((r) => r.toLowerCase() === value.toLowerCase())) next.push(value);
      return { ...current, allowedRoots: next };
    });
  const pick = useAsyncAction(async () => {
    const paths = (await pcBridge()?.pickFolders()) ?? [];
    if (paths.length) addRoots(paths);
  });
  const rootProblem =
    newRoot.trim() && !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(newRoot.trim()) ? "请填写绝对路径，例如 C:\\Users\\你\\Documents" : null;

  return (
    <>
      <FullAccessCard device={device} />
      <section className={cn("device-section", device.fullAccess && "is-overridden")}>
        <h2 className="device-section-t">{device.fullAccess ? "能力（完全访问开启中，以下设置暂不生效）" : "能力"}</h2>
        <p className="device-section-s">{"新电脑默认全部「询问」。「询问」= 每次在这台电脑的弹窗或这里确认；「允许」= 直接执行。所有操作都会记录。"}</p>
        <Card>
          {DEVICE_CAPABILITIES.map((capability) => {
            const info = CAPABILITY_INFO[capability];
            const Icon = CAP_ICON[capability];
            return (
              <SettingRow
                description={info.description}
                key={capability}
                title={
                  <span className="device-cap-t">
                    <Icon className="size-4" />
                    {info.label}
                    {info.dangerous ? <span className="device-badge is-warn is-sm"><T>{"高风险"}</T></span> : null}
                  </span>
                }
              >
                <PolicySegmented
                  disabled={locked}
                  label={info.label}
                  onChange={(value) =>
                    update((current) => ({ ...current, capabilities: { ...current.capabilities, [capability]: value } }))
                  }
                  value={draft.capabilities[capability]}
                />
              </SettingRow>
            );
          })}
        </Card>
      </section>

      <section className="device-section">
        <h2 className="device-section-t">{"允许的文件夹"}</h2>
        <p className="device-section-s">{isThisPc
            ? "「读取文件」「写入文件」只能访问这些文件夹（含子文件夹）。在这台电脑上可以直接用「选择文件夹…」挑选。"
            : "「读取文件」「写入文件」只能访问这些文件夹（含子文件夹）。也可以在那台电脑的 PC 客户端里用文件夹选择器添加。"}</p>
        <Card>
          {draft.allowedRoots.length ? (
            draft.allowedRoots.map((root) => (
              <ListRow
                actions={
                  <Button
                    aria-label={`移除 ${root}`}
                    disabled={locked}
                    onClick={() => update((current) => ({ ...current, allowedRoots: current.allowedRoots.filter((r) => r !== root) }))}
                    size="icon"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                }
                icon={<IconFolder className="size-5" />}
                key={root}
                title={<code className="device-path">{root}</code>}
              />
            ))
          ) : (
            <div className="device-empty-line">{"还没有允许的文件夹，文件类能力暂时用不了。"}</div>
          )}
          <form
            className="device-root-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = newRoot.trim();
              if (!value || rootProblem) return;
              addRoots([value]);
              setNewRoot("");
            }}
          >
            <Input
              aria-invalid={!!rootProblem}
              disabled={locked}
              onChange={(event) => setNewRoot(event.target.value)}
              placeholder={device.platform === "win32" ? "C:\\Users\\你\\Documents" : "/home/你/Documents"}
              value={newRoot}
            />
            <Button disabled={locked || !newRoot.trim() || !!rootProblem} size="sm" type="submit" variant="outline">
              <IconFolderPlus />
              {"添加"}
            </Button>
            {isThisPc && pcBridge() ? (
              <Button
                disabled={locked}
                feedback={{ pending: "选择中…", success: "已添加", error: "失败" }}
                onClick={() => void pick.run()}
                size="sm"
                state={pick.state}
                type="button"
              >
                <IconFolder />
                {"选择文件夹…"}
              </Button>
            ) : null}
          </form>
          {rootProblem ? <div className="device-field-error">{rootProblem}</div> : null}
        </Card>
      </section>

      <section className="device-section">
        <h2 className="device-section-t">{"谁可以使用"}</h2>
        <p className="device-section-s">{"设备属于你的账号，不再按机器人单独授权：你的每个机器人都能在上面开启的能力和允许的文件夹范围内使用它（只在它在线时），「询问」的操作每次先问你，紧急停止对所有机器人立即生效。"}</p>
        <Card>
          <SettingRow
            description={device.lastUsedBy ? `最近使用：${lastUsedText(device.lastUsedBy)}` : "还没有机器人使用过这台设备。"}
            title={
              <span className="device-cap-t">
                <IconRobot className="size-4" />
                {"你的所有机器人"}
              </span>
            }
          >
            <span className="device-badge is-accent"><T>{"共用"}</T></span>
          </SettingRow>
        </Card>
      </section>

      <section className="device-section">
        <h2 className="device-section-t">{"名称"}</h2>
        <Card>
          <SettingRow description="在设备列表、审批弹窗和机器人看到的设备列表里显示的名字。" title="设备名称">
            <Input
              className="device-name-input"
              disabled={locked}
              maxLength={64}
              onChange={(event) => {
                const name = event.target.value;
                update((current) => ({ ...current, name }));
              }}
              value={draft.name}
            />
          </SettingRow>
        </Card>
      </section>

      <SaveBar show={dirty || save.state !== "idle"}>
        <Button
          disabled={save.state === "pending"}
          onClick={() => {
            setDraft(base);
            setTouched(false);
          }}
          size="sm"
          variant="ghost"
        >
          {"放弃"}
        </Button>
        <Button feedback="save" onClick={() => void save.run()} size="sm" state={save.state}>
          {"保存"}
        </Button>
      </SaveBar>
    </>
  );
}

function actorText(entry: DeviceAuditEntry) {
  if (entry.actorType === "bot") return entry.actorName ?? "机器人";
  if (entry.actorType === "device") return "PC 客户端";
  if (entry.actorType === "user") return entry.actorName ? `${entry.actorName}（网页）` : "网页";
  return "系统";
}

export function AuditList({ entries }: { entries: DeviceAuditEntry[] }) {
  if (!entries.length) return <div className="device-empty-line">{"还没有任何操作记录。"}</div>;
  return (
    <div className="device-audit">
      {entries.map((entry) => {
        const outcome = OUTCOME_LABEL[entry.outcome] ?? { text: entry.outcome, tone: "muted" as const };
        const action =
          ACTION_LABEL[entry.action] ?? (entry.action in OPERATION_LABEL ? OPERATION_LABEL[entry.action as keyof typeof OPERATION_LABEL] : entry.action);
        return (
          <div className="device-audit-row" key={entry.id}>
            <time className="device-audit-time" dateTime={entry.at}>
              {new Date(entry.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </time>
            <div className="min-w-0 flex-1">
              <div className="device-audit-t">
                <b>{actorText(entry)}</b>
                <span>{action}</span>
              </div>
              {entry.summary ? <div className="device-audit-s">{entry.summary}</div> : null}
              {entry.detail ? <div className="device-audit-d">{entry.detail}</div> : null}
            </div>
            <div className="device-audit-r">
              <span className={cn("device-badge is-sm", `is-${outcome.tone}`)}><T>{outcome.text}</T></span>
              {entry.durationMs !== null ? <span className="device-audit-ms">{`${entry.durationMs} ms`}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const PC_UPDATE_TEXT: Record<PcUpdateState["status"], string> = {
  idle: "",
  checking: "正在检查…",
  available: "发现新版本，准备下载",
  downloading: "正在后台下载",
  downloaded: "已下载，重启后安装",
  none: "已是最新版本",
  error: "检查更新失败",
};

/** 「本机」标签里的客户端更新（docs/online-update.md）：自动更新开关 + 当前状态 + 检查 / 重启安装。 */
function PcUpdateRows({ local, onLocal }: { local: PcLocalState; onLocal: (next: PcLocalState) => void }) {
  const bridge = pcBridge();
  const update = local.update as PcUpdateState;
  const [busy, setBusy] = useState(false);
  const check = useAsyncAction(
    async () => {
      const next = await bridge?.checkUpdate?.();
      if (next?.status === "error") throw new Error(next.error || "检查更新失败");
      if (bridge) onLocal(await bridge.state());
    },
    { errorToast: (error) => error.message },
  );
  const install = useAsyncAction(async () => {
    await bridge?.installUpdate?.();
  });
  const status =
    update.status === "downloading" && typeof update.percent === "number"
      ? `正在后台下载 ${Math.round(update.percent)}%`
      : PC_UPDATE_TEXT[update.status];
  const detail = [
    `当前 ${local.version}`,
    update.version && update.status !== "none" ? `新版本 ${update.version}` : "",
    status,
    update.status === "error" && update.error ? update.error : "",
    update.checkedAt ? `上次检查 ${new Date(update.checkedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <SettingRow
        description={update.supported ? "启动时和每隔几小时检查一次，有新版本就在后台下载，下载好后提示你重启安装。" : "只有安装版能自动更新；免安装版请到 设置 → 电脑操作 下载新版本。"}
        title="自动更新"
      >
        <Switch
          aria-label="自动更新"
          checked={!!local.autoUpdate && update.supported}
          disabled={busy || !update.supported}
          onCheckedChange={async (value) => {
            if (!bridge) return;
            setBusy(true);
            try {
              onLocal(await bridge.setLocal({ autoUpdate: value }));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "修改失败");
            } finally {
              setBusy(false);
            }
          }}
        />
      </SettingRow>
      <SettingRow description={detail} title="客户端版本">
        {update.status === "downloaded" ? (
          <Button feedback={{ pending: "等待确认…", success: "正在重启", error: "失败" }} onClick={() => void install.run()} size="sm" state={install.state}>
            {"立即重启以安装"}
          </Button>
        ) : (
          <Button
            disabled={!update.supported || update.status === "checking" || update.status === "downloading"}
            feedback={{ pending: "检查中…", success: "已检查", error: "检查失败" }}
            onClick={() => void check.run()}
            size="sm"
            state={check.state}
            variant="outline"
          >
            {"检查更新"}
          </Button>
        )}
      </SettingRow>
    </>
  );
}

/**
 * 「本机」标签：只在 PC 客户端里、而且看的正是这台电脑时出现（DESIGN.md §16.4）。这些设置只存在这台电脑上，
 * 通过 PC 客户端的本机桥读写；放松安全的改动由 PC 弹出本机确认窗，用户在那里取消时这里的开关回到原位。
 */
export function ThisPcPanel({ local, onLocal }: { local: PcLocalState; onLocal: (next: PcLocalState) => void }) {
  const bridge = pcBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const logout = useAsyncAction(async () => {
    await bridge?.logout();
  });
  const set = async (key: keyof PcLocalPatch, value: boolean) => {
    if (!bridge) return;
    setBusy(key);
    try {
      onLocal(await bridge.setLocal({ [key]: value }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改失败");
    } finally {
      setBusy(null);
    }
  };
  const online = local.agentState === "online";
  return (
    <>
      <section className="device-section">
        <h2 className="device-section-t">{"这台电脑"}</h2>
        <p className="device-section-s">{"这些设置只保存在这台电脑上，网页和手机看不到也改不了。放松安全的改动需要在这台电脑上再确认一次。"}</p>
        <Card>
          <SettingRow
            description={`${local.serverUrl} · 客户端 ${local.version} · ${local.hostname}`}
            title="节点连接"
          >
            <span className={cn("device-badge", online ? "is-ok" : local.localPaused ? "is-danger" : local.agentState === "revoked" ? "is-muted" : "is-warn")}>
              {online ? <span aria-hidden className="device-dot is-ok" /> : null}
              <T>{local.statusText}</T>
            </span>
          </SettingRow>
          <SettingRow
            description="立即拒绝一切远程操作、取消进行中的操作和审批；断网时也有效。也可以在托盘菜单里按。"
            title={
              <span className="device-cap-t">
                <IconPlayerStopFilled className="size-4 text-[var(--danger)]" />
                {"本机紧急停止"}
              </span>
            }
          >
            <Switch
              aria-label="本机紧急停止"
              checked={local.localPaused}
              disabled={busy === "localPaused"}
              onCheckedChange={(value) => void set("localPaused", value)}
            />
          </SettingRow>
          <SettingRow
            description="命令行、写入文件、鼠标键盘即使在权限里设为「允许」，也先在这台电脑上弹窗确认。服务器被攻破也无法静默操作这台电脑。"
            title={
              <span className="device-cap-t">
                <IconShieldCheck className="size-4" />
                {"高风险操作始终在本机确认"}
                <span className="device-badge is-ok is-sm"><T>{"推荐"}</T></span>
              </span>
            }
          >
            <Switch
              aria-label="高风险操作始终在本机确认"
              checked={local.forceLocalApproval}
              disabled={busy === "forceLocalApproval"}
              onCheckedChange={(value) => void set("forceLocalApproval", value)}
            />
          </SettingRow>
          <SettingRow description="登录 Windows 后自动启动 ChisaBot PC，保持节点在线。" title="开机自动启动">
            <Switch
              aria-label="开机自动启动"
              checked={local.autoStart}
              disabled={busy === "autoStart"}
              onCheckedChange={(value) => void set("autoStart", value)}
            />
          </SettingRow>
          <SettingRow description="启动时不打开窗口，只在托盘里运行。" title="启动时隐藏到托盘">
            <Switch
              aria-label="启动时隐藏到托盘"
              checked={local.startHidden}
              disabled={busy === "startHidden"}
              onCheckedChange={(value) => void set("startHidden", value)}
            />
          </SettingRow>
          {local.update ? <PcUpdateRows local={local} onLocal={onLocal} /> : null}
          <SettingRow
            description={local.tokenProtected ? "已用 Windows 数据保护（DPAPI）加密，只有当前 Windows 用户能解开。" : "这台电脑不支持系统加密，令牌以普通文件保存。"}
            title="设备令牌"
          >
            <span className={cn("device-badge", local.tokenProtected ? "is-ok" : "is-warn")}><T>{local.tokenProtected ? "已加密" : "未加密"}</T></span>
          </SettingRow>
        </Card>
      </section>
      <section className="device-section">
        <h2 className="device-section-t is-danger">{"账号"}</h2>
        <Card className="device-danger">
          <SettingRow description="作废这台电脑的设备令牌、清除登录状态，回到设置向导。可以换一台服务器或换个账号重新登录。" title="退出登录 / 换服务器">
            <Button feedback={{ pending: "等待确认…", success: "已退出", error: "失败" }} onClick={() => void logout.run()} size="sm" state={logout.state} variant="destructive">
              {"退出登录"}
            </Button>
          </SettingRow>
        </Card>
      </section>
    </>
  );
}
