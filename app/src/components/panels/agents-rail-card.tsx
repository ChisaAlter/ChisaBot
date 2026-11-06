import {
  IconChevronRight,
  IconDeviceDesktop,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { deviceListQueryOptions, fullAccessUntilText } from "@/lib/devices";
import {
  deviceAgentQueryOptions,
  redetectDeviceAgentsMutationOptions,
  updateDeviceAgentMutationOptions,
} from "@/lib/local-agents";
import {
  readStoredPreference,
  writeStoredPreference,
} from "@/lib/preference-storage";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";
import { type DeviceView, isMobilePlatform } from "../../../../shared/devices";
import {
  AGENT_PROFILES,
  type AgentProfile,
  LOCAL_AGENT_INFO,
  LOCAL_AGENT_KINDS,
  PROFILE_INFO,
} from "../../../../shared/local-agents";

/**
 * 面板栏第一张内置卡片「Agent 管理」（docs/local-agents.md）：账号下每台电脑 / 服务器一行——
 * 在线状态、检测到的本地 agent、权限档位、「重新检测」。
 *
 * 设备归账号不归机器人（docs/pc-node.md §7），所以这张卡不看当前机器人、一直放在实时面板列表前面。
 * 折叠状态存在本机（chisabot-panel-agents-collapsed），默认展开。
 */

const COLLAPSED_KEY = "chisabot-panel-agents-collapsed";

export function AgentsRailCard() {
  const [collapsed, setCollapsed] = useState(
    () => readStoredPreference(COLLAPSED_KEY) === "collapsed",
  );
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeStoredPreference(COLLAPSED_KEY, next ? "collapsed" : "expanded");
  };
  return (
    <article
      className="glass-card live-panel agents-rail-card"
      data-collapsed={collapsed || undefined}
    >
      <header className="live-panel-head">
        <h3 className="live-panel-heading">
          <button
            aria-expanded={!collapsed}
            className="live-panel-collapse"
            onClick={toggle}
            title={collapsed ? "展开 Agent 管理" : "折叠 Agent 管理"}
            type="button"
          >
            <IconChevronRight
              aria-hidden
              className="live-panel-caret size-3.5"
            />
            <span className="live-panel-title">{"Agent 管理"}</span>
          </button>
        </h3>
      </header>
      {collapsed ? null : <AgentsRailBody />}
    </article>
  );
}

function AgentsRailBody() {
  // 设备列表自带 5 秒轮询（lib/devices.ts），在线状态不用另开销路。
  const list = useQuery(deviceListQueryOptions());
  if (list.isPending) return null;
  if (list.isError) {
    return (
      <p className="live-panel-error" role="alert">
        {list.error.message || "无法加载设备列表。"}
      </p>
    );
  }
  // 手机只用来登录聊天，不能跑本地 agent；已撤销的设备也不在列。
  const devices = (list.data?.devices ?? []).filter(
    (device) => !device.revoked && !isMobilePlatform(device.platform),
  );
  if (devices.length === 0) {
    return (
      <p className="live-panel-note">
        {"还没有配对的电脑。到 "}
        <Link
          className="font-medium text-primary underline-offset-2 hover:underline"
          to="/settings/devices"
        >
          {"设置 → 设备"}
        </Link>
        {" 安装 PC 客户端或服务器节点，配对后在这里管理它上面的本地 agent。"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {devices.map((device) => (
        <DeviceAgentBlock device={device} key={device.id} />
      ))}
    </div>
  );
}

function DeviceAgentBlock({ device }: { device: DeviceView }) {
  const navigate = useNavigate();
  const state = useQuery({
    ...deviceAgentQueryOptions(device.id),
    // 检测结果 / 档位不是推送的，轮询跟上（和设备列表的 5 秒错开频率）。
    refetchInterval: 30_000,
  });
  const save = useMutation({
    ...updateDeviceAgentMutationOptions(queryClient),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "保存档位失败"),
  });
  const detect = useMutation({
    ...redetectDeviceAgentsMutationOptions(queryClient),
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "检测失败"),
  });

  const settings = state.data?.settings;
  /*
   * 完全访问 = 设备的「完全访问」开关（ADR-0009，有时限），服务端 PUT 只收 只读 / 工作区
   * （存过的 full 是旧数据，按工作区算）。选「完全访问」= 去设备页开，那里要挑时限——
   * 与 设置 → 设备 → 本地 agent 里同一个做法（那里是滚到 FullAccessCard）。
   */
  const fullOn = !!device.fullAccess;
  const storedProfile: AgentProfile =
    !settings || settings.profile === "full" ? "workspace" : settings.profile;
  const activeProfile: AgentProfile = fullOn ? "full" : storedProfile;
  const chooseProfile = (profile: AgentProfile) => {
    if (profile === "full") {
      void navigate({
        to: "/settings/devices/$deviceId",
        params: { deviceId: device.id },
        search: { tab: "permissions" },
      });
      return;
    }
    if (profile !== storedProfile)
      save.mutate({ deviceId: device.id, patch: { profile } });
  };
  const profileKeys = useSegmentedKeys<AgentProfile>({
    value: activeProfile,
    values: AGENT_PROFILES,
    onChange: chooseProfile,
  });
  const detected = settings?.detected ?? null;
  const installed = new Map(
    (detected?.agents ?? []).map((agent) => [agent.kind, agent]),
  );

  return (
    <section
      aria-label={`「${device.name}」的本地 agent`}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <IconDeviceDesktop
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Link
          className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground hover:underline"
          params={{ deviceId: device.id }}
          to="/settings/devices/$deviceId"
        >
          {device.name}
        </Link>
        {fullOn ? (
          <span className="device-badge is-sm is-full">{"完全访问"}</span>
        ) : null}
        <span
          className={cn(
            "device-badge is-sm",
            device.online ? "is-ok" : "is-muted",
          )}
        >
          {device.online ? "在线" : "离线"}
        </span>
      </div>

      {state.isPending ? null : state.isError || !settings ? (
        <p className="live-panel-error" role="alert">
          {state.error?.message ?? "读取失败。"}
        </p>
      ) : (
        <>
          <div
            aria-label={`「${device.name}」的权限档位`}
            className="sg-segmented device-seg self-start"
            {...profileKeys.groupProps}
            ref={profileKeys.groupRef}
            role="radiogroup"
          >
            {AGENT_PROFILES.map((profile) => (
              // biome-ignore lint/a11y/useSemanticElements: 自绘 ARIA 控件（分段 / 分组 / 列表），样式与 roving-tabindex 键盘约定见 ui/segmented.tsx，原生元素换不了
              <button
                aria-checked={activeProfile === profile}
                className="sg-segmented-item"
                data-testid={`agents-rail-profile-${profile}`}
                disabled={save.isPending}
                key={profile}
                onClick={() => chooseProfile(profile)}
                role="radio"
                tabIndex={profileKeys.itemTabIndex(profile)}
                title={
                  profile === "full"
                    ? "有时限的总开关，在 设置 → 设备 → 权限 里打开。"
                    : PROFILE_INFO[profile].description
                }
                type="button"
              >
                {PROFILE_INFO[profile].label}
              </button>
            ))}
          </div>
          {fullOn ? (
            <p className="live-panel-note">
              {`完全访问开启中${device.fullAccessUntil ? `（${fullAccessUntilText(device.fullAccessUntil)}）` : ""}，到期或关闭后回到「${PROFILE_INFO[storedProfile].label}」。`}
            </p>
          ) : null}

          {detected ? (
            <ul className="flex flex-col gap-1.5">
              {LOCAL_AGENT_KINDS.map((kind) => {
                const found = installed.get(kind);
                const info = LOCAL_AGENT_INFO[kind];
                return (
                  <li className="flex flex-col gap-0.5" key={kind}>
                    <span className="flex items-center gap-1.5 text-[12.5px] text-foreground/90">
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          found ? "bg-emerald-500" : "bg-muted-foreground/35",
                        )}
                      />
                      <span className="min-w-0 truncate">{info.label}</span>
                      {found ? (
                        <>
                          {found.version ? (
                            <span className="device-badge is-sm is-muted">
                              {found.version}
                            </span>
                          ) : null}
                          {settings.defaultAgent === kind ? (
                            <span className="device-badge is-sm is-accent">
                              {"默认"}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="device-badge is-sm is-muted">
                          {"未安装"}
                        </span>
                      )}
                    </span>
                    {found ? null : (
                      <span className="live-panel-note pl-3">{info.hint}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="live-panel-note">
              {device.online
                ? "还没有检测过这台电脑，点「重新检测」看它上面装了哪些 agent。"
                : "电脑离线，还没有检测结果。"}
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="live-panel-note">
              {detected
                ? `检测于 ${new Date(detected.checkedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}${device.online ? "" : "（离线，上次结果）"}`
                : ""}
            </span>
            <Button
              disabled={!device.online}
              feedback={{
                pending: "检测中…",
                success: "已更新",
                error: "检测失败",
              }}
              mutation={detect}
              onClick={() => detect.mutate(device.id)}
              size="xs"
              variant="outline"
            >
              <IconRefresh />
              {"重新检测"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
