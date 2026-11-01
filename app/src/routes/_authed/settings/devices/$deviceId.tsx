import {
  IconActivity,
  IconDeviceDesktop,
  IconHistory,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconPlugConnected,
  IconSettings,
  IconShieldLock,
  IconTerminal2,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { isMobilePlatform } from "../../../../../../shared/devices";
import { DeviceActivityPanel, FullAccessBadge } from "@/components/devices/full-access";
import { ApprovalsCard, AuditList, DeviceIcon, DevicePermissions, StatusBadge, ThisPcBadge, ThisPcPanel } from "@/components/devices/devices";
import { DeviceCrumbs, DeviceNotFound, DeviceOfflineNote } from "@/components/devices/device-page-parts";
import { PageShell, PageSkeleton } from "@/components/layout/page-shell";
import { DeviceAgentsPanel, DeviceProfileBadge } from "@/components/local-agents/device-agents-panel";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Card, SettingRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import {
  deleteDevice,
  deviceAuditQueryOptions,
  deviceKeys,
  deviceListQueryOptions,
  deviceQueryOptions,
  lastUsedText,
  patchDevice,
  platformLabel,
  revokeDevice,
  seenText,
  testDevice,
} from "@/lib/devices";
import { pcBridge, usePcLocal } from "@/lib/pc-bridge";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authed/settings/devices/$deviceId")({
  component: DevicePage,
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TAB_IDS.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {},
});

type Tab = "permissions" | "activity" | "agents" | "local" | "audit" | "settings";
const TABS: Array<{ id: Tab; label: string; Icon: typeof IconShieldLock; thisPcOnly?: boolean }> = [
  { id: "permissions", label: "权限", Icon: IconShieldLock },
  { id: "activity", label: "运行中", Icon: IconActivity },
  // 权限档位 + 本地 agent（docs/local-agents.md）。
  { id: "agents", label: "本地 agent", Icon: IconTerminal2 },
  { id: "local", label: "本机", Icon: IconDeviceDesktop, thisPcOnly: true },
  { id: "audit", label: "操作记录", Icon: IconHistory },
  { id: "settings", label: "设备", Icon: IconSettings },
];

const TAB_IDS: Tab[] = ["permissions", "activity", "agents", "local", "audit", "settings"];

/** 设备详情（模板 C）：大图标页头 + 测试连接 / 紧急停止 → 标签（权限 / 操作记录 / 设备）。 */
function DevicePage() {
  const { deviceId } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const device = useQuery(deviceQueryOptions(deviceId));
  const list = useQuery(deviceListQueryOptions());
  const audit = useQuery(deviceAuditQueryOptions(deviceId));
  const search = Route.useSearch();
  const [tab, setTab] = useState<Tab>(search.tab ?? "permissions");
  const [local, setLocal] = usePcLocal();
  const offlineNoteId = useId();

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: deviceKeys.all });
  };
  const test = useAsyncAction(
    async () => {
      const result = await testDevice(deviceId);
      toast.success(`连接正常：${String(result.hostname ?? "")} · ${String(result.release ?? "")}`);
      await refresh();
    },
    { errorToast: (error) => `测试失败：${error.message}` },
  );
  const toggleStop = useAsyncAction(async (paused: boolean) => {
    // 在这台电脑自己的 PC 客户端里：先走本机（立即在本机生效、断网也有效；解除要在本机确认，取消就什么也不改），
    // 再同步到服务器。
    const bridge = pcBridge();
    if (bridge && local && local.deviceId === deviceId) {
      const after = await bridge.setLocal({ localPaused: paused });
      setLocal(after);
      if (after.localPaused !== paused) throw new Error("已在这台电脑上取消");
    }
    const next = await patchDevice(deviceId, { paused });
    queryClient.setQueryData(deviceKeys.detail(deviceId), next);
    await refresh();
  }, { errorToast: (error) => (error.message === "已在这台电脑上取消" ? "已取消，紧急停止保持开启。" : `操作失败：${error.message}`) });
  const revoke = useAsyncAction(async () => {
    await revokeDevice(deviceId);
    await refresh();
  });
  const remove = useAsyncAction(async () => {
    await deleteDevice(deviceId);
    await queryClient.invalidateQueries({ queryKey: deviceKeys.all });
    void navigate({ to: "/settings/devices" });
  });

  const back = { linkProps: { to: "/settings/devices" as const }, label: "设备" };
  const crumbs = <DeviceCrumbs />;
  if (device.isPending) {
    return (
      <PageShell backButton={back} eyebrow={crumbs} title="设备">
        <PageSkeleton rows={4} tall />
      </PageShell>
    );
  }
  if (device.isError || !device.data) {
    return (
      <PageShell backButton={back} eyebrow={crumbs} title="设备">
        <DeviceNotFound message={device.error?.message} onRetry={() => void device.refetch()} />
      </PageShell>
    );
  }
  const d = device.data;
  const isThisPc = !!local && local.deviceId === d.id && !d.revoked;
  // 扫码绑定的手机只用来登录聊天：没有能力 / 测试连接 / 紧急停止，只有操作记录和设备（重命名、撤销）。
  const mobile = isMobilePlatform(d.platform);
  const tabs = TABS.filter((item) => (!item.thisPcOnly || isThisPc) && !(mobile && (item.id === "permissions" || item.id === "activity" || item.id === "agents")));
  const activeTab: Tab = mobile
    ? tab === "settings" ? "settings" : "audit"
    : tab === "local" && !isThisPc ? "permissions" : tab;
  // 离线时测试连接 / 紧急停止 / 开启完全访问都到不了电脑（O8）：禁用并用 aria-describedby 指向说明。
  const offline = !d.online && !d.revoked;
  const approvals = (list.data?.approvals ?? []).filter((approval) => approval.deviceId === d.id);
  return (
    <PageShell backButton={back} eyebrow={crumbs} title={d.name}>
      <div className="device-hero">
        <DeviceIcon device={d} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="device-hero-badges">
            {isThisPc ? <ThisPcBadge /> : null}
            <StatusBadge device={d} />
            <FullAccessBadge device={d} />
            <span className="device-badge"><T>{platformLabel(d.platform)}</T></span>
            {d.clientVersion ? <span className="device-badge"><T>{`客户端 ${d.clientVersion}`}</T></span> : null}
            {!mobile && !d.revoked ? <DeviceProfileBadge device={d} /> : null}
          </div>
          <p className="device-hero-s">
            {[d.osVersion, d.hostname, seenText(d.lastSeenAt, d.online), d.lastIp ? `IP ${d.lastIp}` : null, d.lastUsedBy ? `最近使用：${lastUsedText(d.lastUsedBy)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {offline && !mobile ? <DeviceOfflineNote id={offlineNoteId} /> : null}
        </div>
        {!d.revoked && !mobile ? (
          <div className="device-hero-actions">
            <Button aria-describedby={offline ? offlineNoteId : undefined} data-testid="device-test" disabled={offline || d.paused} feedback="test" onClick={() => void test.run()} size="sm" state={test.state} variant="outline">
              <IconPlugConnected />
              {"测试连接"}
            </Button>
            {d.paused ? (
              <Button
                feedback={{ pending: "解除中…", success: "已解除", error: "解除失败" }}
                onClick={() => void toggleStop.run(false)}
                size="sm"
                state={toggleStop.state}
                variant="outline"
              >
                <IconPlayerPlayFilled />
                {"解除紧急停止"}
              </Button>
            ) : (
              <Button
                aria-describedby={offline ? offlineNoteId : undefined}
                data-testid="device-stop"
                disabled={offline}
                feedback={{ pending: "停止中…", success: "已停止", error: "停止失败" }}
                onClick={() => void toggleStop.run(true)}
                size="sm"
                state={toggleStop.state}
                variant="destructive"
              >
                <IconPlayerStopFilled />
                {"紧急停止"}
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {d.paused && !d.revoked && !mobile ? (
        <div className="device-stopbar" role="status">
          <IconPlayerStopFilled className="size-4" />
          {isThisPc
            ? "紧急停止中：这台电脑拒绝一切远程操作，进行中的操作已取消。解除时会在这台电脑上再确认一次。"
            : "紧急停止中：这台电脑拒绝一切远程操作，进行中的操作已取消。可以在这里或 PC 托盘菜单解除。"}
        </div>
      ) : null}

      <ApprovalsCard approvals={approvals} />

      <div aria-label="设备分区" className="device-tabs" role="tablist">
        {tabs.map(({ id, label, Icon }) => (
          <button aria-selected={activeTab === id} className={cn("device-tab", activeTab === id && "is-active")} key={id} onClick={() => setTab(id)} role="tab" type="button">
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "permissions" ? <DevicePermissions device={d} isThisPc={isThisPc} /> : null}
      {activeTab === "activity" ? <DeviceActivityPanel device={d} /> : null}
      {activeTab === "agents" ? <DeviceAgentsPanel device={d} isThisPc={isThisPc} /> : null}
      {activeTab === "local" && local ? <ThisPcPanel local={local} onLocal={setLocal} /> : null}
      {activeTab === "audit" ? (
        <Card className="device-audit-card">
          {audit.isPending ? <PageSkeleton rows={4} /> : <AuditList entries={audit.data ?? []} />}
        </Card>
      ) : null}
      {activeTab === "settings" ? (
        <>
          <Card>
            <SettingRow description="登记时生成，用来区分同名电脑。" title="设备 ID">
              <code className="device-code">{d.id}</code>
            </SettingRow>
            <SettingRow description={new Date(d.createdAt).toLocaleString("zh-CN")} title="关联时间" />
            <SettingRow description={d.clientVersion ?? "未知"} title="客户端版本" />
            <SettingRow
              description={d.lastUsedBy ? `${lastUsedText(d.lastUsedBy)}（${new Date(d.lastUsedBy.at).toLocaleString("zh-CN")}）` : "还没有机器人使用过这台设备。"}
              title="最近使用的机器人"
            />
          </Card>
          <section className="device-section">
            <h2 className="device-section-t is-danger">{"危险区"}</h2>
            <Card className="device-danger">
              {!d.revoked ? (
                <SettingRow description="立即作废这台设备的令牌并断开连接，所有机器人都不能再使用它。之后它需要重新登录才能再次关联。" title="撤销关联">
                  <Button
                    feedback="revoke"
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: `撤销「${d.name}」？`,
                        description: "这台设备会立即断开，所有机器人都不能再使用它。客户端需要重新登录才能再次关联。",
                        confirmLabel: "撤销",
                        destructive: true,
                      });
                      if (ok) void revoke.run();
                    }}
                    size="sm"
                    state={revoke.state}
                    variant="destructive"
                  >
                    {"撤销"}
                  </Button>
                </SettingRow>
              ) : null}
              <SettingRow description="删除这台设备和它的全部操作记录（不可恢复）。" title="删除设备">
                <Button
                  feedback="delete"
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: `删除「${d.name}」？`,
                      description: "会同时删除这台设备的权限设置和全部操作记录，无法恢复。",
                      confirmLabel: "删除",
                      destructive: true,
                    });
                    if (ok) void remove.run();
                  }}
                  size="sm"
                  state={remove.state}
                  variant="destructive"
                >
                  {"删除"}
                </Button>
              </SettingRow>
            </Card>
          </section>
        </>
      ) : null}
    </PageShell>
  );
}
