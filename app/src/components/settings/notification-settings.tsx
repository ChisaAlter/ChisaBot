import {
  IconBell,
  IconBellRinging,
  IconCheck,
  IconDeviceMobile,
  IconPlayerPlay,
  IconPlus,
  IconSend,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  PageRows,
  PageSection,
  PageSkeleton,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  deletePushDeviceMutationOptions,
  notificationPreferencesFrom,
  parseBarkInput,
  pushDevicesKeys,
  pushDevicesQueryOptions,
  type RegisterPushDevicePayload,
  registerPushDeviceMutationOptions,
  saveNotificationPreferencesMutationOptions,
  testPushDevice,
} from "@/lib/notifications/api";
import { playNotificationSound } from "@/lib/notifications/sounds";
import { useUserPreferences } from "@/lib/settings/message-list";
import {
  NOTIFICATION_FREQUENCY_OPTIONS,
  NOTIFICATION_SOUND_OPTIONS,
  type NotificationFrequency,
  type NotificationSoundId,
  type PushProvider,
} from "../../../../shared/notifications";

function readBrowserNotificationPermission():
  | NotificationPermission
  | "unsupported" {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  return Notification.permission;
}

function maskKeyPreview(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * 设置 → 通用 → 通知与推送：
 * - 通知频率（每条回复 / 仅任务完成 / 静音）
 * - 5 种跨平台 WebAudio 柔和提示音试听与选择
 * - 移动推送设备管理（Bark curl 一键粘贴 / FCM / APNs 加密登记 + 单设备测试推送）
 */
export function NotificationSettingsSection() {
  const queryClient = useQueryClient();
  const preferences = useUserPreferences();
  const { frequency, sound } = notificationPreferencesFrom(preferences.data);
  const savePreferences = useMutation(
    saveNotificationPreferencesMutationOptions(queryClient, preferences.userId),
  );

  const devicesQuery = useQuery(pushDevicesQueryOptions());
  const registerDevice = useMutation(
    registerPushDeviceMutationOptions(queryClient),
  );
  const deleteDevice = useMutation(
    deletePushDeviceMutationOptions(queryClient),
  );

  const [permission, setPermission] = useState(
    readBrowserNotificationPermission,
  );
  const [testingId, setTestingId] = useState<string | null>(null);
  const [providerTab, setProviderTab] = useState<PushProvider>("bark");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [barkInput, setBarkInput] = useState("");
  const [fcmProjectId, setFcmProjectId] = useState("");
  const [fcmToken, setFcmToken] = useState("");
  const [fcmAccessToken, setFcmAccessToken] = useState("");
  const [apnsTopic, setApnsTopic] = useState("cn.ayase.chisabot");
  const [apnsToken, setApnsToken] = useState("");
  const [apnsBearerToken, setApnsBearerToken] = useState("");
  const [apnsEnv, setApnsEnv] = useState<"production" | "development">(
    "production",
  );

  const labelInputId = useId();
  const barkInputId = useId();
  const fcmProjectInputId = useId();
  const fcmTokenInputId = useId();
  const fcmAccessInputId = useId();
  const apnsTopicInputId = useId();
  const apnsTokenInputId = useId();
  const apnsBearerInputId = useId();

  const parsedBark = barkInput.trim() ? parseBarkInput(barkInput) : null;

  const handleFrequencyChange = (next: NotificationFrequency) => {
    if (next === frequency) return;
    savePreferences.mutate(
      { notificationFrequency: next },
      {
        onSuccess: () => toast.success("通知频率已保存"),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleSoundChange = (next: NotificationSoundId) => {
    if (next !== "none") {
      playNotificationSound(next, { force: true });
    }
    if (next === sound) return;
    savePreferences.mutate(
      { notificationSound: next },
      {
        onSuccess: () => toast.success("提示音已保存"),
        onError: (error: Error) => toast.error(error.message),
      },
    );
  };

  const handleRequestPermission = async () => {
    if (typeof Notification === "undefined") return;
    try {
      const next = await Notification.requestPermission();
      setPermission(next);
      if (next === "granted") {
        toast.success("已开启桌面系统通知");
      } else if (next === "denied") {
        toast.error("浏览器已拦截通知权限，请在浏览器站点设置中重新允许。");
      }
    } catch {
      toast.error("无法请求浏览器通知权限");
    }
  };

  const handleAddDevice = () => {
    const label = deviceLabel.trim() || undefined;
    let payload: RegisterPushDevicePayload;

    if (providerTab === "bark") {
      if (!parsedBark) {
        toast.error("请粘贴完整的 Bark 推送链接或 curl 命令");
        return;
      }
      payload = {
        provider: "bark",
        ...(label ? { label } : {}),
        barkCurl: barkInput.trim(),
      };
    } else if (providerTab === "fcm") {
      if (!fcmProjectId.trim() || !fcmToken.trim() || !fcmAccessToken.trim()) {
        toast.error("请填写完整的 FCM 项目 ID、设备令牌与访问令牌");
        return;
      }
      payload = {
        provider: "fcm",
        ...(label ? { label } : {}),
        fcmProjectId: fcmProjectId.trim(),
        deviceToken: fcmToken.trim(),
        accessToken: fcmAccessToken.trim(),
      };
    } else {
      if (!apnsTopic.trim() || !apnsToken.trim() || !apnsBearerToken.trim()) {
        toast.error("请填写完整的 APNs Topic、设备令牌与鉴权令牌");
        return;
      }
      payload = {
        provider: "apns",
        ...(label ? { label } : {}),
        topic: apnsTopic.trim(),
        deviceToken: apnsToken.trim(),
        environment: apnsEnv,
        bearerToken: apnsBearerToken.trim(),
      };
    }

    registerDevice.mutate(payload, {
      onSuccess: (created) => {
        toast.success(`已添加推送设备：${created.label}`);
        setDeviceLabel("");
        setBarkInput("");
        setFcmToken("");
        setFcmAccessToken("");
        setApnsToken("");
        setApnsBearerToken("");
      },
      onError: (error: Error) => toast.error(error.message),
    });
  };

  const handleTestDevice = async (deviceId: string) => {
    setTestingId(deviceId);
    try {
      const outcome = await testPushDevice(deviceId);
      if (outcome.ok) {
        toast.success("测试推送已发送，请在目标设备上查收。");
      } else {
        toast.error(outcome.error ?? "测试推送未能送达。");
        if (outcome.invalidTokenRemoved) {
          void queryClient.invalidateQueries({ queryKey: pushDevicesKeys.all });
        }
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "测试推送失败，请稍后重试。",
      );
    } finally {
      setTestingId(null);
    }
  };

  const devices = devicesQuery.data ?? [];

  return (
    <PageSection
      description={
        "AI 回复完成或等待审批时自动提醒。正在查看的当前会话会自动抑制重复弹窗，不吞其他机器人的通知；推送凭据在服务端使用 AES-256-GCM 加密保存。"
      }
      settingItem="general.notifications"
      title={"通知与推送"}
    >
      <PageRows>
        {/* 1. 桌面通知权限 */}
        <Item size="sm">
          <ItemContent>
            <ItemTitle>{"系统弹窗通知"}</ItemTitle>
            <ItemDescription>
              {permission === "granted"
                ? "已允许发送浏览器 / 桌面通知，点击通知将直接聚焦并跳转到对应会话。"
                : permission === "denied"
                  ? "浏览器已禁止通知权限，请在浏览器地址栏站点权限中手动开启。"
                  : permission === "unsupported"
                    ? "当前运行环境不支持浏览器 Notification API，将自动回落为站内轻提示。"
                    : "开启后，即使切到其他应用或标签页，AI 回复完成时也会收到系统提醒。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            {permission === "granted" ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <IconCheck
                  aria-hidden="true"
                  className="size-3.5 text-emerald-600 dark:text-emerald-400"
                />
                {"已开启"}
              </span>
            ) : permission === "default" ? (
              <Button
                onClick={() => void handleRequestPermission()}
                size="sm"
                variant="outline"
              >
                <IconBellRinging className="size-3.5" />
                {"开启通知"}
              </Button>
            ) : null}
          </ItemActions>
        </Item>

        <Separator />

        {/* 2. 通知频率 */}
        <Item size="sm">
          <ItemContent>
            <ItemTitle>{"通知频率"}</ItemTitle>
            <ItemDescription>
              {NOTIFICATION_FREQUENCY_OPTIONS.find(
                (item) => item.id === frequency,
              )?.description ?? "选择触发主动提醒的时机。"}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <div className="sg-segmented">
              {NOTIFICATION_FREQUENCY_OPTIONS.map((option) => (
                <button
                  aria-pressed={frequency === option.id}
                  className="sg-segmented-item"
                  data-state={frequency === option.id ? "active" : "inactive"}
                  data-testid={`notify-freq-${option.id}`}
                  disabled={savePreferences.isPending}
                  key={option.id}
                  onClick={() => handleFrequencyChange(option.id)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          </ItemActions>
        </Item>

        <Separator />

        {/* 3. 提示音选择与试听 */}
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">{"回复提示音"}</div>
              <p className="text-xs text-muted-foreground">
                {
                  "纯 WebAudio 本地柔和合成，跨 Windows / macOS / Linux 可用且内置防叠音去抖。"
                }
              </p>
            </div>
            <IconBell
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {NOTIFICATION_SOUND_OPTIONS.map((option) => {
              const selected = sound === option.id;
              return (
                <div
                  className={
                    selected
                      ? "flex items-center justify-between gap-2 rounded-xl border border-primary/40 bg-primary/8 px-3 py-2"
                      : "flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2"
                  }
                  key={option.id}
                >
                  <button
                    aria-pressed={selected}
                    className="min-w-0 flex-1 text-left"
                    data-testid={`notify-sound-${option.id}`}
                    disabled={savePreferences.isPending}
                    onClick={() => handleSoundChange(option.id)}
                    type="button"
                  >
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <span>{option.label}</span>
                      {selected ? (
                        <IconCheck
                          aria-hidden="true"
                          className="size-3.5 text-primary"
                        />
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {option.description}
                    </div>
                  </button>
                  {option.id !== "none" ? (
                    <Button
                      aria-label={`试听${option.label}`}
                      onClick={() =>
                        playNotificationSound(option.id, { force: true })
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <IconPlayerPlay className="size-3.5" />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* 4. 已注册推送设备列表 */}
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">{"移动端推送设备"}</div>
              <p className="text-xs text-muted-foreground">
                {
                  "离开电脑时把 AI 回复、任务完成与审批提醒推送到手机（附 chisabot:// 深链直达会话）。"
                }
              </p>
            </div>
            <IconDeviceMobile
              aria-hidden="true"
              className="size-4 text-muted-foreground"
            />
          </div>

          {devicesQuery.isPending ? (
            <PageSkeleton rows={1} />
          ) : devicesQuery.isError ? (
            <p className="text-xs text-destructive" role="alert">
              {devicesQuery.error.message}
            </p>
          ) : devices.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
              {
                "还没有登记移动推送设备。在下方粘贴 Bark 链接 / curl 命令或填写 FCM / APNs 即可开启。"
              }
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {devices.map((device) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/50 px-3 py-2.5"
                  key={device.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{device.label}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] uppercase text-muted-foreground">
                        {device.provider}
                      </span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {device.host
                        ? `${device.host} · ${device.platform}`
                        : device.platform}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      loading={testingId === device.id}
                      onClick={() => void handleTestDevice(device.id)}
                      size="sm"
                      variant="outline"
                    >
                      <IconSend className="size-3.5" />
                      {"测试推送"}
                    </Button>
                    <Button
                      aria-label={`移除 ${device.label}`}
                      disabled={deleteDevice.isPending}
                      onClick={() =>
                        deleteDevice.mutate(device.id, {
                          onSuccess: () => toast.success("已移除推送设备"),
                          onError: (error: Error) => toast.error(error.message),
                        })
                      }
                      size="icon-sm"
                      variant="ghost"
                    >
                      <IconTrash className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 5. 新增推送设备（Bark curl 一键粘贴 / FCM / APNs） */}
          <div className="mt-1 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-medium text-foreground">
                {"添加新推送设备"}
              </div>
              <div className="sg-segmented">
                {(
                  [
                    { id: "bark", label: "Bark" },
                    { id: "fcm", label: "FCM" },
                    { id: "apns", label: "APNs" },
                  ] as const
                ).map((tab) => (
                  <button
                    aria-pressed={providerTab === tab.id}
                    className="sg-segmented-item"
                    data-state={providerTab === tab.id ? "active" : "inactive"}
                    key={tab.id}
                    onClick={() => setProviderTab(tab.id)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs text-muted-foreground"
                htmlFor={labelInputId}
              >
                {"设备备注名称（可选）"}
              </label>
              <Input
                id={labelInputId}
                onChange={(event) => setDeviceLabel(event.target.value)}
                placeholder={"例如：我的主力手机"}
                value={deviceLabel}
              />
            </div>

            {providerTab === "bark" ? (
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-xs text-muted-foreground"
                  htmlFor={barkInputId}
                >
                  {
                    "Bark 链接或 curl 命令（直接从 Bark App 复制粘贴，自动提取服务器与 Key）"
                  }
                </label>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  id={barkInputId}
                  onChange={(event) => setBarkInput(event.target.value)}
                  placeholder={
                    '例如：curl "https://api.day.app/你的Key/推送标题/推送内容"'
                  }
                  value={barkInput}
                />
                {barkInput.trim() ? (
                  parsedBark ? (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      {`已识别：${parsedBark.serverUrl} · Key ${maskKeyPreview(parsedBark.deviceKey)}`}
                    </p>
                  ) : (
                    <p className="text-xs text-destructive">
                      {
                        "未识别出有效的 Bark 地址与 Key，请检查是否粘贴了完整 URL 或 curl 命令。"
                      }
                    </p>
                  )
                ) : null}
              </div>
            ) : providerTab === "fcm" ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={fcmProjectInputId}
                  >
                    {"Firebase Project ID"}
                  </label>
                  <Input
                    id={fcmProjectInputId}
                    onChange={(event) => setFcmProjectId(event.target.value)}
                    placeholder={"my-firebase-project"}
                    value={fcmProjectId}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={fcmTokenInputId}
                  >
                    {"FCM 设备令牌"}
                  </label>
                  <Input
                    id={fcmTokenInputId}
                    onChange={(event) => setFcmToken(event.target.value)}
                    placeholder={"设备注册的 FCM Registration Token"}
                    value={fcmToken}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={fcmAccessInputId}
                  >
                    {"FCM OAuth2 Access Token"}
                  </label>
                  <Input
                    id={fcmAccessInputId}
                    onChange={(event) => setFcmAccessToken(event.target.value)}
                    placeholder={"服务端将加密保存，绝不明文落盘"}
                    type="password"
                    value={fcmAccessToken}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={apnsTopicInputId}
                  >
                    {"App Bundle ID（apns-topic）"}
                  </label>
                  <Input
                    id={apnsTopicInputId}
                    onChange={(event) => setApnsTopic(event.target.value)}
                    placeholder={"cn.ayase.chisabot"}
                    value={apnsTopic}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={apnsTokenInputId}
                  >
                    {"APNs 十六进制设备令牌"}
                  </label>
                  <Input
                    id={apnsTokenInputId}
                    onChange={(event) => setApnsToken(event.target.value)}
                    placeholder={"64 位十六进制 APNs Device Token"}
                    value={apnsToken}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs text-muted-foreground"
                    htmlFor={apnsBearerInputId}
                  >
                    {"APNs Bearer JWT"}
                  </label>
                  <Input
                    id={apnsBearerInputId}
                    onChange={(event) => setApnsBearerToken(event.target.value)}
                    placeholder={"服务端加密保存"}
                    type="password"
                    value={apnsBearerToken}
                  />
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{"环境："}</span>
                  {(["production", "development"] as const).map((env) => (
                    <button
                      aria-pressed={apnsEnv === env}
                      className={
                        apnsEnv === env
                          ? "rounded-full bg-primary/15 px-2.5 py-0.5 text-primary"
                          : "rounded-full bg-muted px-2.5 py-0.5 text-muted-foreground"
                      }
                      key={env}
                      onClick={() => setApnsEnv(env)}
                      type="button"
                    >
                      {env === "production" ? "生产环境" : "沙盒环境"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                loading={registerDevice.isPending}
                onClick={handleAddDevice}
                size="sm"
              >
                <IconPlus className="size-3.5" />
                {providerTab === "bark"
                  ? "添加 Bark 推送"
                  : providerTab === "fcm"
                    ? "添加 FCM 设备"
                    : "添加 APNs 设备"}
              </Button>
            </div>
          </div>
        </div>
      </PageRows>
    </PageSection>
  );
}
