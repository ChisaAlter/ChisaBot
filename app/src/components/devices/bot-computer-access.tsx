import { IconChevronRight, IconDeviceDesktop, IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CAPABILITY_INFO, DEVICE_CAPABILITIES, type DeviceView } from "../../../../shared/devices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deviceListQueryOptions, lastUsedText, platformLabel, seenText } from "@/lib/devices";
import { cn } from "@/lib/utils";
import { platformIcon } from "./devices";

/**
 * 机器人这一侧的「电脑操作」（docs/pc-node.md §7）：这个人账号下关联的设备。
 *
 * 设备属于账号，不属于某个机器人：每个机器人都能用在线设备（新电脑能力默认「询问」，每次操作要你批准，可逐台改；审批、审计、紧急停止
 * 照常）。这里只是列出设备和它们开了什么，点进去改能力；以前的「允许这个机器人」开关已经取消。
 */
export function BotComputerAccess({ compact }: { agentId?: string; botName?: string; compact?: boolean }) {
  const list = useQuery(deviceListQueryOptions());
  const devices = (list.data?.devices ?? []).filter((device) => !device.revoked);
  if (list.isPending) return <p className="bca-line">{"正在读取你的设备…"}</p>;
  if (list.isError) return <p className="bca-line is-error">{`设备列表暂时无法读取：${list.error.message}`}</p>;
  if (devices.length === 0)
    return (
      <div className="bca-empty">
        <IconDeviceDesktop className="size-5 shrink-0 opacity-70" />
        <div className="min-w-0 flex-1">
          <div className="bca-t">{"还没有关联设备"}</div>
          <div className="bca-s">{"在电脑上安装 ChisaBot 客户端并用这个账号登录，你的机器人就能在你允许的范围内操作它。"}</div>
        </div>
        <Button nativeButton={false} render={<Link to="/settings/devices" />} size="sm" variant="outline">
          <IconDownload />
          {"添加设备"}
        </Button>
      </div>
    );
  return (
    <div className={cn("bca-list", compact && "is-compact")}>
      {devices.map((device) => (
        <BotDeviceRow device={device} key={device.id} />
      ))}
    </div>
  );
}

function BotDeviceRow({ device }: { device: DeviceView }) {
  const enabled = DEVICE_CAPABILITIES.filter((cap) => device.capabilities[cap] !== "off");
  const Icon = platformIcon(device.platform);
  const status = device.paused ? "已紧急停止" : seenText(device.lastSeenAt, device.online);
  return (
    <Link
      aria-label={`「${device.name}」的能力与权限`}
      className="bca-row bca-row-link"
      params={{ deviceId: device.id }}
      title={"能力、允许的文件夹、操作记录"}
      to="/settings/devices/$deviceId"
    >
      <span className={cn("bca-ico", device.online && !device.paused && "is-online", device.paused && "is-paused")}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="bca-t">
          {device.name}
          <span className="bca-meta">{` ${platformLabel(device.platform)} · ${status}`}</span>
        </div>
        <div className={cn("bca-s", enabled.length === 0 && "is-warn")}>
          {enabled.length
            ? `已开启：${enabled.map((cap) => CAPABILITY_INFO[cap].label).join("、")}`
            : "能力都还关着，机器人暂时什么也做不了。点这里去开启。"}
          {device.lastUsedBy ? ` · 最近使用：${lastUsedText(device.lastUsedBy)}` : ""}
        </div>
      </div>
      <span className="bca-go" aria-hidden>
        <IconChevronRight className="size-4" />
      </span>
    </Link>
  );
}

/** 机器人「⋯ → 电脑操作…」打开的玻璃弹窗。 */
export function BotComputerAccessDialog({
  botName,
  open,
  onOpenChange,
}: {
  agentId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--accent-blue)]/12 text-[var(--accent-blue)]">
              <IconDeviceDesktop className="size-4" />
            </span>
            <span className="min-w-0 break-words">{`电脑操作 ·「${botName}」`}</span>
          </DialogTitle>
          <DialogDescription>
            {`设备属于你的账号，你的所有机器人共用。「${botName}」可以使用在线的设备：只限每台设备开启的能力和允许的文件夹，「询问」的操作会先问你，每一步都有记录，随时可以紧急停止。`}
          </DialogDescription>
        </DialogHeader>
        {open ? <BotComputerAccess /> : null}
        <DialogFooter className="mt-2">
          <Button nativeButton={false} render={<Link to="/settings/devices" />} variant="outline">
            {"全部设备与审批"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{"完成"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
