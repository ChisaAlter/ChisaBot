import { IconCheck, IconFolder, IconFolderPlus, IconLock, IconLockOpen, IconRefresh, IconShieldHalf, IconTerminal2, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { DeviceView } from "../../../../shared/devices";
import {
  AGENT_PROFILES,
  type AgentProfile,
  type BuiltinModel,
  type DeviceAgentSettings,
  ISOLATION_INFO,
  ISOLATIONS,
  type Isolation,
  LOCAL_AGENT_INFO,
  LOCAL_TASK_STATUS_ZH,
  type LocalAgentKind,
  PROFILE_INFO,
  profileLine,
} from "../../../../shared/local-agents";
import { FullAccessCard } from "@/components/devices/full-access";
import { PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow, SaveBar, SettingRow } from "@/components/ui/skyglass";
import { useSegmentedKeys } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { deviceAgentQueryOptions, localAgentKeys, redetectDeviceAgents, saveDeviceAgent } from "@/lib/local-agents";
import { pcBridge } from "@/lib/pc-bridge";
import { cn } from "@/lib/utils";

type Draft = Pick<DeviceAgentSettings, "profile" | "workspaceRoots" | "network" | "isolation" | "defaultAgent" | "builtinModel" | "containerImage">;

const pick = (s: DeviceAgentSettings): Draft => ({
  profile: s.profile,
  workspaceRoots: s.workspaceRoots,
  network: s.network,
  isolation: s.isolation,
  defaultAgent: s.defaultAgent,
  builtinModel: s.builtinModel,
  containerImage: s.containerImage,
});

const PROFILE_ICON: Record<AgentProfile, typeof IconLock> = { readonly: IconLock, workspace: IconShieldHalf, full: IconLockOpen };

/** 档位徽标（设备页页头用）。 */
export function DeviceProfileBadge({ device }: { device: Pick<DeviceView, "id" | "fullAccess"> }) {
  const state = useQuery(deviceAgentQueryOptions(device.id));
  // 完全访问开着时页头已有「完全访问」徽标（ADR-0009），这里不重复。
  if (!state.data || device.fullAccess) return null;
  const profile = state.data.settings.profile === "full" ? "workspace" : state.data.settings.profile;
  return (
    <span className="device-badge is-accent" data-testid="device-profile-badge" title={PROFILE_INFO[profile].description}>
      <T>{`档位：${PROFILE_INFO[profile].label}`}</T>
    </span>
  );
}

/**
 * 设置 → 设备 → 某台电脑 → 本地 agent（docs/local-agents.md）：权限档位、工作区文件夹、沙盒与网络、
 * 已检测到的本地 agent 和默认选择、内置 agent 用哪个模型、最近的任务。只有用户能改；机器人没有改档位的工具。
 */
export function DeviceAgentsPanel({ device, isThisPc }: { device: DeviceView; isThisPc: boolean }) {
  const queryClient = useQueryClient();
  const state = useQuery({ ...deviceAgentQueryOptions(device.id), refetchInterval: (query) => (query.state.data?.tasks.some((t) => ["pending_approval", "starting", "running"].includes(t.status)) ? 2000 : false) });
  const base = useMemo(() => (state.data ? pick(state.data.settings) : null), [state.data]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newRoot, setNewRoot] = useState("");
  useEffect(() => {
    if (base && !draft) setDraft(base);
  }, [base, draft]);
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  const save = useAsyncAction(
    async () => {
      if (!draft) return;
      const settings = await saveDeviceAgent(device.id, draft);
      queryClient.setQueryData(localAgentKeys.device(device.id), (old: typeof state.data) => (old ? { ...old, settings } : old));
      await queryClient.invalidateQueries({ queryKey: localAgentKeys.device(device.id) });
      setDraft(pick(settings));
    },
    { errorToast: (error) => `保存失败：${error.message}` },
  );
  const detect = useAsyncAction(
    async () => {
      const result = await redetectDeviceAgents(device.id);
      if (!result.sent) throw new Error("电脑离线");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await queryClient.invalidateQueries({ queryKey: localAgentKeys.device(device.id) });
    },
    { errorToast: (error) => `检测失败：${error.message}` },
  );
  const pickRoots = useAsyncAction(async () => {
    const bridge = pcBridge();
    if (!bridge) return;
    const roots = await bridge.pickFolders();
    if (roots.length) update((d) => ({ ...d, workspaceRoots: [...new Set([...d.workspaceRoots, ...roots])] }));
  });

  if (state.isPending || (!draft && !state.isError)) return <PageSkeleton rows={4} />;
  if (state.isError || !state.data || !draft) return <ErrorCard description={state.error?.message ?? "读取失败"} title="无法读取本地 agent 设置" />;
  const data = state.data;
  const detected = data.settings.detected;
  const sandboxes = detected?.sandboxes ?? {};
  const agents = detected?.agents ?? [{ kind: "builtin" as LocalAgentKind, version: null, path: null }];
  function update(fn: (d: Draft) => Draft) {
    setDraft((d) => (d ? fn(d) : d));
  }
  const available = (iso: Isolation) => iso === "none" || iso === "copy" || sandboxes[iso] === true;
  // 完全访问 = 设备的「完全访问」开关（ADR-0009，有时限）；这里存的只有 只读 / 工作区，完全访问到期后回到它。
  const fullOn = !!device.fullAccess;
  const storedProfile: AgentProfile = draft.profile === "full" ? "workspace" : draft.profile;
  const activeProfile: AgentProfile = fullOn ? "full" : storedProfile;
  const chooseProfile = (profile: AgentProfile) => {
    if (profile === "full") {
      document.getElementById("la-full-access")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    update((d) => ({ ...d, profile }));
  };
  const rootPlaceholder = device.platform === "win32" ? "C:\\Users\\你\\code\\项目" : "/home/你/code/项目";
  const builtin = draft.builtinModel;
  // 分段选择的键盘约定（2026-10-20）：roving tabindex + 方向键换档；「完全访问」那档按下去是滚到下面，和点它一致。
  const profileKeys = useSegmentedKeys<AgentProfile>({
    value: activeProfile,
    values: AGENT_PROFILES,
    onChange: chooseProfile,
  });
  /*
   * 隔离方式这几行以前是「能点、但既不在 Tab 顺序里、也没有分组」的 div（`ListRow` 渲染的是 div，
   * 上面挂着 role="radio"）：鼠标能选，键盘完全到不了。现在整组是 radiogroup，行按 roving tabindex 走。
   */
  const isolationOptions = ISOLATIONS.filter((iso) => iso !== "wsl" || device.platform === "win32")
    .filter((iso) => iso !== "sandbox-exec" || device.platform === "darwin")
    .filter((iso) => iso !== "bwrap" || device.platform === "linux");
  const isolationKeys = useSegmentedKeys<Isolation>({
    value: draft.isolation,
    values: isolationOptions,
    onChange: (iso) => {
      if (available(iso)) update((d) => ({ ...d, isolation: iso }));
    },
  });

  return (
    <>
      <section className="device-section">
        <h2 className="device-section-t">{"权限档位"}</h2>
        <p className="device-section-s">
          {fullOn
            ? `完全访问开启中，到期或关闭后回到「${PROFILE_INFO[storedProfile].label}」。`
            : "对这台电脑上的所有机器人操作和本地 agent 任务都有效。档位只会收紧：档位之外的操作，能力是「允许」也会先问你；「关闭」的能力仍然关闭。任务可以要求更严的档位，不能更宽。"}
        </p>
        <div className="la-profiles" {...profileKeys.groupProps} ref={profileKeys.groupRef} role="radiogroup" aria-label="权限档位">
          {AGENT_PROFILES.map((profile) => {
            const Icon = PROFILE_ICON[profile];
            return (
              <button
                aria-checked={activeProfile === profile}
                className={cn("la-profile-opt", activeProfile === profile && "is-active", profile === "full" && "is-full", fullOn && profile !== "full" && storedProfile === profile && "is-standby")}
                data-testid={`profile-${profile}`}
                key={profile}
                onClick={() => void chooseProfile(profile)}
                role="radio"
                tabIndex={profileKeys.itemTabIndex(profile)}
                type="button"
              >
                <span className="la-profile-opt-t">
                  <Icon className="size-4" />
                  {PROFILE_INFO[profile].label}
                  {activeProfile === profile ? <IconCheck className="ml-auto size-4" /> : null}
                </span>
                <span>{profile === "full" ? (fullOn ? "开启中。在下面「完全访问」里随时关闭。" : "有时限的总开关，在下面「完全访问」里打开（1 小时 / 24 小时 / 永久）。") : PROFILE_INFO[profile].description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div id="la-full-access">
        <FullAccessCard device={device} />
      </div>

      <section className="device-section">
        <h2 className="device-section-t">{"工作区文件夹"}</h2>
        <p className="device-section-s">
          {draft.workspaceRoots.length
            ? "「工作区」档位下可以读写、运行命令的文件夹；本地 agent 默认在第一个文件夹里做。"
            : `没有单独设置时沿用「允许的文件夹」${data.effectiveRoots.length ? `（${data.effectiveRoots.join("、")}）` : "（还没有）"}。`}
        </p>
        <Card>
          {draft.workspaceRoots.map((root) => (
            <ListRow
              actions={
                <Button aria-label={`移除 ${root}`} onClick={() => update((d) => ({ ...d, workspaceRoots: d.workspaceRoots.filter((r) => r !== root) }))} size="icon" variant="ghost">
                  <IconTrash />
                </Button>
              }
              icon={<IconFolder className="size-5" />}
              key={root}
              title={<code className="device-path">{root}</code>}
            />
          ))}
          <form
            className="device-root-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = newRoot.trim();
              if (!value) return;
              update((d) => ({ ...d, workspaceRoots: [...new Set([...d.workspaceRoots, value])] }));
              setNewRoot("");
            }}
          >
            <Input onChange={(event) => setNewRoot(event.target.value)} placeholder={rootPlaceholder} value={newRoot} />
            <Button disabled={!newRoot.trim()} size="sm" type="submit" variant="outline">
              <IconFolderPlus />
              {"添加"}
            </Button>
            {isThisPc && pcBridge() ? (
              <Button feedback={{ pending: "选择中…", success: "已添加", error: "失败" }} onClick={() => void pickRoots.run()} size="sm" state={pickRoots.state} type="button">
                <IconFolder />
                {"选择文件夹…"}
              </Button>
            ) : null}
          </form>
        </Card>
      </section>

      <section className="device-section">
        <h2 className="device-section-t">{"沙盒与网络"}</h2>
        <p className="device-section-s">{"本地 agent 任务默认怎么隔离。一次性副本里的改动要你在任务卡片上点「应用改动」才回到原文件夹。灰色的是这台电脑上没检测到的。"}</p>
        <Card {...isolationKeys.groupProps} aria-label="隔离方式" ref={isolationKeys.groupRef} role="radiogroup">
          {isolationOptions.map((iso) => {
              const ok = available(iso);
              return (
                <ListRow
                  actions={draft.isolation === iso ? <IconCheck className="size-4 text-[var(--accent-blue)]" /> : !ok ? <span className="la-chip is-off">{"未检测到"}</span> : null}
                  aria-checked={draft.isolation === iso}
                  aria-disabled={!ok}
                  className={cn("cursor-pointer", !ok && "opacity-55")}
                  data-testid={`isolation-${iso}`}
                  key={iso}
                  onClick={() => ok && update((d) => ({ ...d, isolation: iso }))}
                  role="radio"
                  sub={ISOLATION_INFO[iso].description}
                  tabIndex={isolationKeys.itemTabIndex(iso)}
                  title={ISOLATION_INFO[iso].label}
                />
              );
            })}
          {sandboxes["windows-sandbox"] ? (
            <div className="device-empty-line">{"检测到 Windows 沙盒（Windows Sandbox）：这一版不自动使用，需要的话可以用 WSL 或临时副本。"}</div>
          ) : null}
          <SettingRow description="关闭后内置 agent 的命令不能联网（要靠 bubblewrap / macOS 沙盒 / 容器才做得到）。命令行 agent 要联网访问它自己的模型服务，断网时不能用。" title="允许联网">
            <Switch checked={draft.network} onCheckedChange={(network: boolean) => update((d) => ({ ...d, network }))} />
          </SettingRow>
          {draft.isolation === "docker" || draft.isolation === "podman" ? (
            <SettingRow description="内置 agent 的命令在这个镜像的一次性容器里跑（只挂载工作文件夹）。" title="容器镜像">
              <Input className="device-name-input" maxLength={200} onChange={(event) => update((d) => ({ ...d, containerImage: event.target.value }))} value={draft.containerImage} />
            </SettingRow>
          ) : null}
        </Card>
      </section>

      <section className="device-section">
        <h2 className="device-section-t">{"本地 agent"}</h2>
        <p className="device-section-s">
          {data.online
            ? `在聊天里可以说「用 Claude Code 在我电脑上修这个 bug」；没说用哪个时用默认的。${detected ? `上次检测：${new Date(detected.checkedAt).toLocaleString("zh-CN")}` : "还没检测过。"}`
            : "电脑离线，显示的是上次检测的结果。"}
        </p>
        <Card>
          {agents.map((agent) => (
            <ListRow
              actions={
                draft.defaultAgent === agent.kind ? (
                  <span className="device-badge is-accent"><T>{"默认"}</T></span>
                ) : (
                  <Button onClick={() => update((d) => ({ ...d, defaultAgent: agent.kind }))} size="sm" variant="ghost">
                    {"设为默认"}
                  </Button>
                )
              }
              data-testid={`agent-${agent.kind}`}
              icon={<IconTerminal2 className="size-5" />}
              key={agent.kind}
              sub={LOCAL_AGENT_INFO[agent.kind]?.hint}
              title={
                <span className="la-agent-row">
                  <span className="la-agent-name">{LOCAL_AGENT_INFO[agent.kind]?.label ?? agent.kind}</span>
                  {agent.version ? <span className="la-agent-ver">{agent.version}</span> : null}
                </span>
              }
            />
          ))}
          {!agents.some((a) => a.kind === draft.defaultAgent) ? (
            <div className="device-field-error">{`默认 agent「${LOCAL_AGENT_INFO[draft.defaultAgent].label}」在这台电脑上没检测到。`}</div>
          ) : null}
          <SettingRow description="服务器：用你给机器人配置的模型（密钥不离开服务器）。本地：直接调这台电脑上的 OpenAI 兼容模型（Ollama、LM Studio），对话不出这台电脑。" title="内置 agent 的模型">
            <div className="la-chips">
              {(["server", "local"] as const).map((kind) => (
                <button
                  className={cn("la-chip", builtin.kind === kind && "is-on")}
                  key={kind}
                  onClick={() =>
                    update((d) => ({ ...d, builtinModel: kind === "server" ? { kind: "server" } : ({ kind: "local", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder" } as BuiltinModel) }))
                  }
                  type="button"
                >
                  {kind === "server" ? "服务器" : "本地模型"}
                </button>
              ))}
            </div>
          </SettingRow>
          {builtin.kind === "local" ? (
            <SettingRow description="OpenAI 兼容地址（…/v1）和模型名。" title="本地模型">
              <div className="flex flex-col gap-2">
                <Input onChange={(event) => update((d) => ({ ...d, builtinModel: { kind: "local", baseUrl: event.target.value, model: builtin.model } }))} value={builtin.baseUrl} />
                <Input onChange={(event) => update((d) => ({ ...d, builtinModel: { kind: "local", baseUrl: builtin.baseUrl, model: event.target.value } }))} value={builtin.model} />
              </div>
            </SettingRow>
          ) : null}
          <SettingRow description="装了新的命令行 agent 或沙盒工具后，点一下重新检测。" title="检测">
            <Button disabled={!data.online} feedback={{ pending: "检测中…", success: "已更新", error: "检测失败" }} onClick={() => void detect.run()} size="sm" state={detect.state} variant="outline">
              <IconRefresh />
              {"重新检测"}
            </Button>
          </SettingRow>
        </Card>
      </section>

      {data.tasks.length ? (
        <section className="device-section">
          <h2 className="device-section-t">{"最近的任务"}</h2>
          <Card>
            {data.tasks.slice(0, 8).map((task) => (
              <ListRow
                actions={<span className="device-badge"><T>{LOCAL_TASK_STATUS_ZH[task.status]}</T></span>}
                icon={<IconTerminal2 className="size-5" />}
                key={task.id}
                sub={`${LOCAL_AGENT_INFO[task.agent]?.label ?? task.agent} · ${profileLine(task)} · ${new Date(task.createdAt).toLocaleString("zh-CN")}${task.diff?.files.length ? ` · ${task.diff.files.length} 个文件` : ""}`}
                title={task.title}
              />
            ))}
          </Card>
        </section>
      ) : null}

      <SaveBar show={dirty || save.state !== "idle"}>
        <Button disabled={save.state === "pending"} onClick={() => setDraft(base)} size="sm" variant="ghost">
          {"放弃"}
        </Button>
        <Button feedback="save" onClick={() => void save.run()} size="sm" state={save.state}>
          {"保存"}
        </Button>
      </SaveBar>
    </>
  );
}
