import {
  IconCheck,
  IconLoader2,
  IconMicrophone,
  IconPlayerPlay,
  IconPlayerStop,
  IconSearch,
  IconVolume,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorCard, SettingRow } from "@/components/ui/skyglass";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import {
  DEFAULT_SPEECH_TTS_SPEED,
  fetchSpeechVoices,
  SPEECH_TTS_PROVIDER_PRESETS,
  type SpeechKeySource,
  type SpeechSettingsView,
  type SpeechTtsProvider,
  type SpeechVoiceItem,
  saveSpeechSettings,
  speechKeys,
  speechSettingsQueryOptions,
  testSpeechAsr,
  testSpeechTts,
} from "@/lib/audio/speech";
import { deploymentKeys } from "@/lib/deployment/queries";
import { voiceKeys } from "@/lib/voice/call-client";

/**
 * 语音服务（ASR / TTS）管理员配置区：挂载在 `/admin/models` 页面底部。
 * - 支持 ASR 与 TTS 独立开关、厂商/地址/模型/默认音色/语速/加密密钥配置；
 * - 支持不保存草稿直接测试 ASR 连通性与试听 TTS；
 * - 支持按关键字搜索内置 OpenAI 与 Fish Audio 音色列表并一键试听/设为默认。
 */

type ProbeFeedback = { ok: boolean; message: string } | null;

type SpeechDraft = {
  asrEnabled: boolean;
  asrBaseUrl: string;
  asrModel: string;
  asrApiKey: string;
  ttsEnabled: boolean;
  ttsProvider: SpeechTtsProvider;
  ttsBaseUrl: string;
  ttsModel: string;
  ttsVoice: string;
  ttsSpeed: string;
  ttsApiKey: string;
};

function keyHintText(
  typed: string,
  source: SpeechKeySource,
  hint: string,
  fallbackText: string,
): string {
  if (typed.trim()) return "保存后将替换为新填写的加密密钥。";
  if (source === "saved") {
    return `已加密保存${hint ? `（末四位 ${hint}）` : ""}，留空保留原密钥。`;
  }
  if (source === "environment") {
    return `当前沿用部署环境变量中的密钥${hint ? `（末四位 ${hint}）` : ""}，留空不改。`;
  }
  return fallbackText;
}

function isValidHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      !trimmed.includes("?") &&
      !trimmed.includes("#")
    );
  } catch {
    return false;
  }
}

function parseSpeedValue(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0.25 || value > 4) return null;
  return value;
}

function draftFromView(current: SpeechSettingsView): SpeechDraft {
  return {
    asrEnabled: current.asr.enabled,
    asrBaseUrl: current.asr.baseUrl,
    asrModel: current.asr.model,
    asrApiKey: "",
    ttsEnabled: current.tts.enabled,
    ttsProvider: current.tts.provider,
    ttsBaseUrl: current.tts.baseUrl,
    ttsModel: current.tts.model,
    ttsVoice: current.tts.voice,
    ttsSpeed: String(current.tts.speed || DEFAULT_SPEECH_TTS_SPEED),
    ttsApiKey: "",
  };
}

function SpeechSettingsCard({ current }: { current: SpeechSettingsView }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SpeechDraft>(() => draftFromView(current));
  const [asrProbe, setAsrProbe] = useState<ProbeFeedback>(null);
  const [voiceInput, setVoiceInput] = useState("");
  const [voiceQuery, setVoiceQuery] = useState("");

  const preset = SPEECH_TTS_PROVIDER_PRESETS[draft.ttsProvider];
  const parsedSpeed = parseSpeedValue(draft.ttsSpeed);

  const playback = useSpeechPlayback({
    synthesize: (input) =>
      testSpeechTts({
        text: input.text,
        provider: draft.ttsProvider,
        baseUrl: draft.ttsBaseUrl.trim() || preset.baseUrl,
        model: draft.ttsModel.trim(),
        voice: input.voice ?? draft.ttsVoice.trim(),
        ...(parsedSpeed !== null ? { speed: parsedSpeed } : {}),
        ...(draft.ttsApiKey.trim() ? { apiKey: draft.ttsApiKey.trim() } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    onError: (message) => toast.error(message),
  });

  const voicesQuery = useQuery({
    queryKey: speechKeys.voices(voiceQuery),
    queryFn: ({ signal }) => fetchSpeechVoices(voiceQuery, signal),
    staleTime: 30_000,
  });

  function updateDraft(patch: Partial<SpeechDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    if (
      patch.asrBaseUrl !== undefined ||
      patch.asrModel !== undefined ||
      patch.asrApiKey !== undefined
    ) {
      setAsrProbe(null);
    }
  }

  function handleProviderChange(nextProvider: SpeechTtsProvider) {
    if (nextProvider === draft.ttsProvider) return;
    const prevPreset = SPEECH_TTS_PROVIDER_PRESETS[draft.ttsProvider];
    const nextPreset = SPEECH_TTS_PROVIDER_PRESETS[nextProvider];
    const shouldSwapBase =
      !draft.ttsBaseUrl.trim() ||
      draft.ttsBaseUrl.trim() === prevPreset.baseUrl;
    const shouldSwapModel =
      !draft.ttsModel.trim() || draft.ttsModel.trim() === prevPreset.model;
    const shouldSwapVoice =
      !draft.ttsVoice.trim() || draft.ttsVoice.trim() === prevPreset.voice;
    updateDraft({
      ttsProvider: nextProvider,
      ...(shouldSwapBase ? { ttsBaseUrl: nextPreset.baseUrl } : {}),
      ...(shouldSwapModel ? { ttsModel: nextPreset.model } : {}),
      ...(shouldSwapVoice ? { ttsVoice: nextPreset.voice } : {}),
    });
  }

  const asrUrlValid =
    !draft.asrBaseUrl.trim() || isValidHttpUrl(draft.asrBaseUrl);
  const ttsUrlValid =
    !draft.ttsBaseUrl.trim() || isValidHttpUrl(draft.ttsBaseUrl);
  const asrReadyToSave =
    !draft.asrEnabled ||
    (isValidHttpUrl(draft.asrBaseUrl) && Boolean(draft.asrModel.trim()));
  const ttsReadyToSave =
    !draft.ttsEnabled ||
    (isValidHttpUrl(draft.ttsBaseUrl) &&
      (draft.ttsProvider === "fish" || Boolean(draft.ttsModel.trim())));
  const canSave =
    asrUrlValid &&
    ttsUrlValid &&
    parsedSpeed !== null &&
    asrReadyToSave &&
    ttsReadyToSave;

  const canTestAsr =
    isValidHttpUrl(draft.asrBaseUrl) && Boolean(draft.asrModel.trim());
  const canPreviewTts =
    isValidHttpUrl(draft.ttsBaseUrl) &&
    (draft.ttsProvider === "fish" || Boolean(draft.ttsModel.trim())) &&
    parsedSpeed !== null;

  const saveAction = useAsyncAction(
    async () => {
      if (parsedSpeed === null) {
        throw new Error("语速必须在 0.25 到 4.0 之间。");
      }
      const saved = await saveSpeechSettings({
        asr: {
          enabled: draft.asrEnabled,
          baseUrl: draft.asrBaseUrl.trim(),
          model: draft.asrModel.trim(),
          ...(draft.asrApiKey.trim() ? { apiKey: draft.asrApiKey.trim() } : {}),
        },
        tts: {
          enabled: draft.ttsEnabled,
          provider: draft.ttsProvider,
          baseUrl: draft.ttsBaseUrl.trim(),
          model: draft.ttsModel.trim(),
          voice: draft.ttsVoice.trim(),
          speed: parsedSpeed,
          ...(draft.ttsApiKey.trim() ? { apiKey: draft.ttsApiKey.trim() } : {}),
        },
      });
      setDraft(draftFromView(saved));
      toast.success("语音服务设置已保存。");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: speechKeys.all }),
        queryClient.invalidateQueries({ queryKey: voiceKeys.all }),
        queryClient.invalidateQueries({
          queryKey: deploymentKeys.capabilities(),
        }),
      ]);
    },
    { errorToast: (error) => error.message },
  );

  const testAsrAction = useAsyncAction(
    async () => {
      const result = await testSpeechAsr({
        baseUrl: draft.asrBaseUrl.trim(),
        model: draft.asrModel.trim(),
        ...(draft.asrApiKey.trim() ? { apiKey: draft.asrApiKey.trim() } : {}),
      });
      const suffix =
        result.ok && result.latencyMs !== undefined
          ? `（${Math.round(result.latencyMs)} ms）`
          : "";
      setAsrProbe({ ok: result.ok, message: `${result.message}${suffix}` });
      if (!result.ok) throw new Error(result.message);
    },
    { errorToast: false },
  );

  const previewCurrentId = "__speech-preview-current__";
  const isCurrentPreviewActive =
    playback.activeId === previewCurrentId &&
    (playback.status === "loading" || playback.status === "playing");

  function toggleVoicePreview(voice: SpeechVoiceItem) {
    const itemId = `voice:${voice.provider}:${voice.id}`;
    const isThisActive =
      playback.activeId === itemId &&
      (playback.status === "loading" || playback.status === "playing");
    if (isThisActive) {
      playback.stop();
      return;
    }
    void playback.speak({
      id: itemId,
      text:
        voice.previewText?.trim() ||
        `你好，这是音色 ${voice.name} 的语音合成试听。`,
      voice: voice.id,
    });
  }

  return (
    <form
      autoComplete="off"
      className="media-card-stack"
      data-testid="speech-settings-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && saveAction.state !== "pending") {
          void saveAction.run();
        }
      }}
    >
      {/* ASR 语音识别区块 */}
      <div className="media-switch">
        <SettingRow
          description="用于语音输入转文字与 IM 语音消息转写，兼容 OpenAI /audio/transcriptions 接口。"
          title={
            <span className="inline-flex items-center gap-2">
              <IconMicrophone className="size-4" />
              {"启用语音识别（ASR）"}
            </span>
          }
        >
          <Switch
            aria-label="启用语音识别（ASR）"
            checked={draft.asrEnabled}
            data-testid="speech-asr-enabled"
            onCheckedChange={(checked) => updateDraft({ asrEnabled: checked })}
          />
        </SettingRow>
      </div>
      <div className="media-body">
        <div className="im-form">
          <div className="im-grid">
            <label className="im-field" htmlFor="speech-asr-base">
              <span className="im-field-l">{"ASR 接口地址（Base URL）"}</span>
              <Input
                className="font-mono"
                data-testid="speech-asr-base"
                id="speech-asr-base"
                onChange={(event) =>
                  updateDraft({ asrBaseUrl: event.target.value })
                }
                placeholder="https://api.openai.com/v1"
                spellCheck={false}
                value={draft.asrBaseUrl}
              />
              {!asrUrlValid ? (
                <span className="im-field-h text-destructive">
                  {
                    "须为 http:// 或 https:// 地址，且不含查询参数、片段或凭据。"
                  }
                </span>
              ) : null}
            </label>
            <label className="im-field" htmlFor="speech-asr-model">
              <span className="im-field-l">{"ASR 模型名称"}</span>
              <Input
                className="font-mono"
                data-testid="speech-asr-model"
                id="speech-asr-model"
                onChange={(event) =>
                  updateDraft({ asrModel: event.target.value })
                }
                placeholder="whisper-1"
                spellCheck={false}
                value={draft.asrModel}
              />
            </label>
          </div>
          <label className="im-field" htmlFor="speech-asr-key">
            <span className="im-field-l">{"ASR API 密钥"}</span>
            <Input
              autoComplete="new-password"
              className="font-mono"
              data-1p-ignore
              data-testid="speech-asr-key"
              id="speech-asr-key"
              onChange={(event) =>
                updateDraft({ asrApiKey: event.target.value })
              }
              placeholder={
                current.asrKeySource === "none" ? "粘贴 API 密钥" : "留空不改"
              }
              type="password"
              value={draft.asrApiKey}
            />
            <span className="im-field-h" data-private="">
              {keyHintText(
                draft.asrApiKey,
                current.asrKeySource,
                current.asrKeyHint,
                "无鉴权的自建 Whisper 服务可留空；否则请填写密钥或在环境变量中配置 SPEECH_ASR_API_KEY。",
              )}
            </span>
          </label>
        </div>
        {asrProbe ? (
          <p
            className={asrProbe.ok ? "img-probe is-ok" : "img-probe is-bad"}
            data-testid="speech-asr-probe"
            role="status"
          >
            {asrProbe.message}
          </p>
        ) : null}
        <div className="media-actions">
          <Button
            data-testid="speech-asr-test"
            disabled={!canTestAsr}
            feedback="test"
            onClick={() => void testAsrAction.run()}
            state={testAsrAction.state}
            type="button"
            variant="outline"
          >
            {"测试 ASR 连通性"}
          </Button>
        </div>
      </div>

      {/* TTS 语音合成区块 */}
      <div className="media-switch border-t">
        <SettingRow
          description="开启后，聊天助手消息下方会出现「朗读」按钮，机器人也可调用 speech_synthesize 输出音频卡片。"
          title={
            <span className="inline-flex items-center gap-2">
              <IconVolume className="size-4" />
              {"启用语音合成（TTS）"}
            </span>
          }
        >
          <Switch
            aria-label="启用语音合成（TTS）"
            checked={draft.ttsEnabled}
            data-testid="speech-tts-enabled"
            onCheckedChange={(checked) => updateDraft({ ttsEnabled: checked })}
          />
        </SettingRow>
      </div>
      <div className="media-body">
        <div className="im-form">
          <label className="im-field" htmlFor="speech-tts-provider">
            <span className="im-field-l">{"TTS 服务厂商"}</span>
            <Select
              onValueChange={(value) => {
                if (value === "openai" || value === "fish") {
                  handleProviderChange(value);
                }
              }}
              value={draft.ttsProvider}
            >
              <SelectTrigger
                className="w-full"
                data-testid="speech-tts-provider"
                id="speech-tts-provider"
              >
                <SelectValue>{preset.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.keys(
                    SPEECH_TTS_PROVIDER_PRESETS,
                  ) as SpeechTtsProvider[]
                ).map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {SPEECH_TTS_PROVIDER_PRESETS[provider].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="im-field-h">{preset.note}</span>
          </label>

          <div className="im-grid">
            <label className="im-field" htmlFor="speech-tts-base">
              <span className="im-field-l">{"TTS 接口地址（Base URL）"}</span>
              <Input
                className="font-mono"
                data-testid="speech-tts-base"
                id="speech-tts-base"
                onChange={(event) =>
                  updateDraft({ ttsBaseUrl: event.target.value })
                }
                placeholder={preset.baseUrl}
                spellCheck={false}
                value={draft.ttsBaseUrl}
              />
              {!ttsUrlValid ? (
                <span className="im-field-h text-destructive">
                  {
                    "须为 http:// 或 https:// 地址，且不含查询参数、片段或凭据。"
                  }
                </span>
              ) : null}
            </label>
            <label className="im-field" htmlFor="speech-tts-model">
              <span className="im-field-l">{"TTS 模型名称"}</span>
              <Input
                className="font-mono"
                data-testid="speech-tts-model"
                id="speech-tts-model"
                onChange={(event) =>
                  updateDraft({ ttsModel: event.target.value })
                }
                placeholder={preset.model}
                spellCheck={false}
                value={draft.ttsModel}
              />
            </label>
          </div>

          <div className="im-grid">
            <label className="im-field" htmlFor="speech-tts-voice">
              <span className="im-field-l">{"默认发音人 / 音色 ID"}</span>
              <Input
                className="font-mono"
                data-testid="speech-tts-voice"
                id="speech-tts-voice"
                onChange={(event) =>
                  updateDraft({ ttsVoice: event.target.value })
                }
                placeholder={
                  draft.ttsProvider === "fish"
                    ? "填写 Fish Audio 模型 ID（留空用默认）"
                    : "alloy"
                }
                spellCheck={false}
                value={draft.ttsVoice}
              />
            </label>
            <label className="im-field" htmlFor="speech-tts-speed">
              <span className="im-field-l">{"默认语速（0.25 – 4.0）"}</span>
              <Input
                className="font-mono"
                data-testid="speech-tts-speed"
                id="speech-tts-speed"
                inputMode="decimal"
                max={4}
                min={0.25}
                onChange={(event) =>
                  updateDraft({ ttsSpeed: event.target.value })
                }
                step={0.05}
                type="number"
                value={draft.ttsSpeed}
              />
              {parsedSpeed === null ? (
                <span className="im-field-h text-destructive">
                  {"请输入 0.25 到 4.0 之间的数字。"}
                </span>
              ) : null}
            </label>
          </div>

          <label className="im-field" htmlFor="speech-tts-key">
            <span className="im-field-l">{"TTS API 密钥"}</span>
            <Input
              autoComplete="new-password"
              className="font-mono"
              data-1p-ignore
              data-testid="speech-tts-key"
              id="speech-tts-key"
              onChange={(event) =>
                updateDraft({ ttsApiKey: event.target.value })
              }
              placeholder={
                current.ttsKeySource === "none" ? "粘贴 API 密钥" : "留空不改"
              }
              type="password"
              value={draft.ttsApiKey}
            />
            <span className="im-field-h" data-private="">
              {keyHintText(
                draft.ttsApiKey,
                current.ttsKeySource,
                current.ttsKeyHint,
                "填写密钥或在环境变量中配置 SPEECH_TTS_API_KEY；无鉴权本地服务可留空。",
              )}
            </span>
          </label>
        </div>

        <div className="media-actions">
          <Button
            data-testid="speech-tts-preview"
            disabled={!canPreviewTts}
            onClick={() => {
              if (isCurrentPreviewActive) {
                playback.stop();
              } else {
                void playback.speak({
                  id: previewCurrentId,
                  text: "你好，这是 ChisaBot 语音合成配置试听。",
                  ...(draft.ttsVoice.trim()
                    ? { voice: draft.ttsVoice.trim() }
                    : {}),
                });
              }
            }}
            type="button"
            variant="outline"
          >
            {isCurrentPreviewActive && playback.status === "loading" ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : isCurrentPreviewActive ? (
              <IconPlayerStop className="size-4" />
            ) : (
              <IconPlayerPlay className="size-4" />
            )}
            {isCurrentPreviewActive && playback.status === "loading"
              ? "合成中…"
              : isCurrentPreviewActive
                ? "停止试听"
                : "试听当前配置"}
          </Button>
          <Button
            data-testid="speech-settings-save"
            disabled={!canSave}
            feedback="save"
            state={saveAction.state}
            type="submit"
          >
            {"保存语音设置"}
          </Button>
        </div>
      </div>

      {/* 音色搜索与试听区块 */}
      <div className="media-body border-t">
        <div className="im-form">
          <label className="im-field" htmlFor="speech-voice-search">
            <span className="im-field-l">{"音色搜索与试听"}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[200px] flex-1"
                data-testid="speech-voice-search"
                id="speech-voice-search"
                onChange={(event) => setVoiceInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setVoiceQuery(voiceInput.trim());
                  }
                }}
                placeholder="输入音色名、ID、语种或风格关键字搜索…"
                value={voiceInput}
              />
              <Button
                data-testid="speech-voice-search-btn"
                onClick={() => setVoiceQuery(voiceInput.trim())}
                size="sm"
                type="button"
                variant="outline"
              >
                <IconSearch className="size-4" />
                {"搜索"}
              </Button>
            </div>
            <span className="im-field-h">
              {
                "内置 11 款 OpenAI 常用音色；保存并启用 Fish Audio 后会自动融合搜索其公共音色库。"
              }
            </span>
          </label>

          {voicesQuery.isPending ? (
            <p className="text-muted-foreground text-sm" role="status">
              {"正在加载音色列表…"}
            </p>
          ) : voicesQuery.error ? (
            <p className="text-destructive text-sm" role="alert">
              {voicesQuery.error.message}
            </p>
          ) : (voicesQuery.data?.length ?? 0) === 0 ? (
            <p className="text-muted-foreground text-sm">
              {"没有找到匹配的音色，换个关键字试试。"}
            </p>
          ) : (
            <div
              className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2"
              data-testid="speech-voice-list"
            >
              {(voicesQuery.data ?? []).map((voice) => {
                const itemId = `voice:${voice.provider}:${voice.id}`;
                const isSelected = draft.ttsVoice.trim() === voice.id;
                const isThisLoading =
                  playback.activeId === itemId && playback.status === "loading";
                const isThisPlaying =
                  playback.activeId === itemId && playback.status === "playing";
                const metaParts = [
                  voice.provider === "fish" ? "Fish Audio" : "OpenAI",
                  voice.language,
                  voice.gender,
                ].filter(Boolean);
                return (
                  <div
                    className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                    key={`${voice.provider}:${voice.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{voice.name}</div>
                      <div className="truncate font-mono text-muted-foreground text-xs">
                        {`${voice.id} · ${metaParts.join(" / ")}`}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        disabled={!canPreviewTts}
                        onClick={() => toggleVoicePreview(voice)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {isThisLoading ? (
                          <IconLoader2 className="size-3.5 animate-spin" />
                        ) : isThisPlaying ? (
                          <IconPlayerStop className="size-3.5" />
                        ) : (
                          <IconPlayerPlay className="size-3.5" />
                        )}
                        {isThisLoading
                          ? "合成中"
                          : isThisPlaying
                            ? "停止"
                            : "试听"}
                      </Button>
                      <Button
                        disabled={isSelected}
                        onClick={() => {
                          if (voice.provider !== draft.ttsProvider) {
                            handleProviderChange(voice.provider);
                          }
                          updateDraft({ ttsVoice: voice.id });
                        }}
                        size="sm"
                        type="button"
                        variant={isSelected ? "secondary" : "outline"}
                      >
                        {isSelected ? <IconCheck className="size-3.5" /> : null}
                        {isSelected ? "已选" : "设为默认"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

/** 挂载在 `/admin/models` 页面底部的「语音服务（ASR / TTS）」管理台区块。 */
export function SpeechSettingsSection() {
  const settings = useQuery(speechSettingsQueryOptions());
  return (
    <div className="media-anchor" id="speech-service">
      <PageSection
        description="统一配置语音识别（ASR）与语音合成（TTS）。支持 OpenAI 兼容与 Fish Audio，保存后实时生效，无需重启。"
        settingItem="models.speech-service"
        title="语音服务（ASR / TTS）"
      >
        {settings.isPending ? (
          <PageSkeleton rows={4} />
        ) : settings.error || !settings.data ? (
          <ErrorCard
            action={
              <Button onClick={() => settings.refetch()} variant="outline">
                {"重试"}
              </Button>
            }
            title={settings.error?.message ?? "无法加载语音服务设置"}
          />
        ) : (
          <SpeechSettingsCard
            current={settings.data}
            key={settings.data.updatedAt ?? "initial"}
          />
        )}
      </PageSection>
    </div>
  );
}
