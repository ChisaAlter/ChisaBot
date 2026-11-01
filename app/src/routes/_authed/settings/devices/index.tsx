import { IconDownload } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AddDeviceCard,
  AddPhoneCard,
  ApprovalsCard,
  ConnectionCard,
  DeviceRow,
  NoDevices,
} from "@/components/devices/devices";
import {
  PairPhoneButton,
  PairPhoneDialog,
} from "@/components/devices/pair-phone";
import {
  PageSection,
  PageShell,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { AddServerCard } from "@/components/devices/full-access";
import { DEVICE_KIND_LABEL, type DeviceKind, deviceKind, deviceListQueryOptions, pcDownloadQueryOptions } from "@/lib/devices";
import { usePcLocal } from "@/lib/pc-bridge";
import { isMobilePlatform } from "../../../../../../shared/devices";

/** ?pair=1：一进来就弹出「绑定手机」二维码（PC 托盘「绑定手机…」用，DESIGN.md §33）；弹出后从地址里去掉。 */
type DevicesSearch = { pair?: true };

export const Route = createFileRoute("/_authed/settings/devices/")({
  validateSearch: (search: Record<string, unknown>): DevicesSearch =>
    search.pair === 1 || search.pair === "1" || search.pair === true
      ? { pair: true }
      : {},
  component: DevicesPage,
});

/**
 * 设置 → 设备（模板 B）：待审批 → 设备列表（账号下关联的全部设备）→ 添加一台手机（扫码绑定）→ 添加一台电脑 / 下载 PC 客户端。
 * 设备属于账号，所有机器人共用（docs/pc-node.md §7）。机器人「⋯ → 电脑操作…」也指向这里。
 */
function DevicesPage() {
  const { pair } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [pairOpen, setPairOpen] = useState(false);
  useEffect(() => {
    if (!pair) return;
    setPairOpen(true);
    void navigate({ search: {}, replace: true });
  }, [pair, navigate]);
  const list = useQuery(deviceListQueryOptions());
  const [local, setLocal] = usePcLocal();
  const download = useQuery(pcDownloadQueryOptions());
  const installer = download.data?.files.find(
    (file) => file.kind === "installer",
  );
  const devices = list.data?.devices ?? [];
  const active = devices.filter((device) => !device.revoked);
  const revoked = devices.filter((device) => device.revoked);
  const online = active.filter((device) => device.online).length;
  return (
    <>
      <PairPhoneDialog onOpenChange={setPairOpen} open={pairOpen} />
      <PageShell
        action={
          <span className="flex flex-wrap items-center gap-2">
            <PairPhoneButton />
            {installer && !local ? (
              <Button
                nativeButton={false}
                render={<a download href={installer.url} />}
                size="sm"
              >
                <IconDownload />
                {"下载 PC 客户端"}
              </Button>
            ) : null}
          </span>
        }
        description="关联到你账号的全部设备（电脑、服务器、手机），由你的所有机器人共用：机器人只能在每台设备开启的能力和允许的文件夹里操作在线设备，「询问」的操作先问你，每一步都有记录，随时可以紧急停止。需要时可以为某台设备打开「完全访问」。"
        title="设备"
      >
        {list.isPending ? (
          <PageSkeleton rows={3} />
        ) : list.isError ? (
          <ErrorCard
            action={
              <Button
                className="mt-2"
                onClick={() => void list.refetch()}
                size="sm"
                variant="outline"
              >
                {"重试"}
              </Button>
            }
            description={list.error.message}
            title="设备列表暂时无法读取"
          />
        ) : (
          <>
            <ApprovalsCard approvals={list.data.approvals} />
            {/* 「机器人能用的设备」只算电脑和服务器：扫码绑定的手机只用来登录聊天（DESIGN.md §33）。 */}
            <ConnectionCard
              devices={active.filter(
                (device) => !isMobilePlatform(device.platform),
              )}
              local={local}
              onLocal={setLocal}
            />
            <PageSection
              description={
                active.length
                  ? `共 ${active.length} 台，${online ? `${online} 台在线` : "都不在线"}。点一行查看详情、改能力和看操作记录；右侧 ⋯ 可以重命名、撤销或删除。`
                  : undefined
              }
              title="设备列表"
            >
              {active.length ? (
                // 按类型分组：电脑 / 服务器 / 手机（只有一种时不写组名）。
                (["pc", "server", "phone"] as DeviceKind[]).map((kind) => {
                  const group = active.filter((device) => deviceKind(device) === kind);
                  if (!group.length) return null;
                  const kinds = new Set(active.map((device) => deviceKind(device)));
                  return (
                    <div className="device-group" key={kind}>
                      {kinds.size > 1 ? <h3 className="device-group-t">{`${DEVICE_KIND_LABEL[kind]}（${group.length}）`}</h3> : null}
                      <Card>
                        {group.map((device) => (
                          <DeviceRow device={device} isThisPc={local?.deviceId === device.id} key={device.id} />
                        ))}
                      </Card>
                    </div>
                  );
                })
              ) : (
                <NoDevices />
              )}
            </PageSection>
            {revoked.length ? (
              <PageSection
                description="令牌已作废，不能再连接。可以在详情里删除记录。"
                title="已撤销"
              >
                <Card>
                  {revoked.map((device) => (
                    <DeviceRow device={device} key={device.id} />
                  ))}
                </Card>
              </PageSection>
            ) : null}
          </>
        )}
        <PageSection settingItem="devices.add-phone" title="添加一台手机">
          <AddPhoneCard />
        </PageSection>
        <PageSection settingItem="devices.add-pc" title="添加一台电脑">
          <AddDeviceCard />
        </PageSection>
        <PageSection settingItem="devices.add-server" title="添加一台服务器">
          <AddServerCard />
        </PageSection>
      </PageShell>
    </>
  );
}
