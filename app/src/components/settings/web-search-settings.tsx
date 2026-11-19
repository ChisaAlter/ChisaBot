import {
  IconExternalLink,
  IconPlus,
  IconSearch,
  IconTrash,
  IconWorld,
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
import { modelCatalogQueryOptions } from "@/lib/model-selection/queries";
import {
  DEFAULT_WEB_SEARCH_MAX_RESULTS,
  DEFAULT_WEB_SEARCH_TIMEOUT_MS,
  MAX_WEB_SEARCH_TIMEOUT_MS,
  MIN_WEB_SEARCH_TIMEOUT_MS,
  saveWebSearchSettings,
  testWebSearch,
  WEB_SEARCH_EXTERNAL_PROVIDERS,
  WEB_SEARCH_PROVIDER_KINDS,
  WEB_SEARCH_PROVIDER_PRESETS,
  type WebSearchExternalProviderKind,
  type WebSearchModelOverride,
  type WebSearchOverrideMode,
  type WebSearchProviderKind,
  type WebSearchProviderSlotInput,
  type WebSearchSettingsView,
  type WebSearchTestResult,
  webSearchKeys,
  webSearchSettingsQueryOptions,
} from "@/lib/web-search";

/**
 * 可插拔多供应商联网搜索管理员配置区（挂载于 `/admin/models`）。
 *
 * - 支持切换默认搜索源（内建 / Tavily / Brave / Serper / Bocha / Exa / Custom）与独立密钥隔离；
 * - 支持按模型 ID 覆写搜索供应商，或设为 `native` 关闭内置 `web_search` 改走模型原生搜索；
 * - 支持输入任意关键词对当前草稿一键在线试搜，不保存即可验证结果与延迟。
 */

type ProviderSlotDraft = {
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
};

type WebSearchDraft = {
  defaultProvider: WebSearchProviderKind;
  fallbackToBuiltin: boolean;
  timeoutMs: string;
  maxResults: string;
  providers: Record<WebSearchExternalProviderKind, ProviderSlotDraft>;
  modelOverrides: WebSearchModelOverride[];
};

function draftFromView(current: WebSearchSettingsView): WebSearchDraft {
  const providers = {} as Record<
    WebSearchExternalProviderKind,
    ProviderSlotDraft
  >;
  for (const kind of WEB_SEARCH_EXTERNAL_PROVIDERS) {
    providers[kind] = {
      baseUrl: current.providers[kind].baseUrl,
      apiKey: "",
      clearApiKey: false,
    };
  }
  return {
    defaultProvider: current.defaultProvider,
    fallbackToBuiltin: current.fallbackToBuiltin,
    timeoutMs: String(current.timeoutMs || DEFAULT_WEB_SEARCH_TIMEOUT_MS),
    maxResults: String(current.maxResults || DEFAULT_WEB_SEARCH_MAX_RESULTS),
    providers,
    modelOverrides: current.modelOverrides.map((item) => ({ ...item })),
  };
}

function isValidHttpEndpoint(raw: string): boolean {
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

function WebSearchSettingsCard({
  current,
}: {
  current: WebSearchSettingsView;
}) {
  const queryClient = useQueryClient();
  const catalog = useQuery(modelCatalogQueryOptions());
  const [draft, setDraft] = useState<WebSearchDraft>(() =>
    draftFromView(current),
  );
  const [editingProvider, setEditingProvider] =
    useState<WebSearchExternalProviderKind>(() =>
      current.defaultProvider === "builtin"
        ? "tavily"
        : current.defaultProvider,
    );
  const [newModelId, setNewModelId] = useState("");
  const [newMode, setNewMode] = useState<WebSearchOverrideMode>("provider");
  const [newOverrideProvider, setNewOverrideProvider] =
    useState<WebSearchProviderKind>("tavily");
  const [testQuery, setTestQuery] = useState("ChisaBot");
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(
    null,
  );

  const activePreset = WEB_SEARCH_PROVIDER_PRESETS[draft.defaultProvider];
  const slotPreset = WEB_SEARCH_PROVIDER_PRESETS[editingProvider];
  const activeSlot = draft.providers[editingProvider];
  const savedSlot = current.providers[editingProvider];

  const parsedTimeout = Number(draft.timeoutMs.trim());
  const timeoutValid =
    Number.isFinite(parsedTimeout) &&
    parsedTimeout >= MIN_WEB_SEARCH_TIMEOUT_MS &&
    parsedTimeout <= MAX_WEB_SEARCH_TIMEOUT_MS;
  const parsedMaxResults = Number(draft.maxResults.trim());
  const maxResultsValid =
    Number.isInteger(parsedMaxResults) &&
    parsedMaxResults >= 1 &&
    parsedMaxResults <= 10;

  const slotBaseUrlValid =
    !activeSlot.baseUrl.trim() || isValidHttpEndpoint(activeSlot.baseUrl);
  const customNeedsUrl =
    draft.defaultProvider === "custom" &&
    !isValidHttpEndpoint(draft.providers.custom.baseUrl);
  const canSave =
    timeoutValid && maxResultsValid && slotBaseUrlValid && !customNeedsUrl;

  function updateSlot(
    kind: WebSearchExternalProviderKind,
    patch: Partial<ProviderSlotDraft>,
  ) {
    setDraft((prev) => ({
      ...prev,
      providers: {
        ...prev.providers,
        [kind]: {
          ...prev.providers[kind],
          ...patch,
        },
      },
    }));
    setTestResult(null);
  }

  function handleDefaultProviderChange(next: WebSearchProviderKind) {
    setDraft((prev) => ({ ...prev, defaultProvider: next }));
    if (next !== "builtin") {
      setEditingProvider(next);
    }
    setTestResult(null);
  }

  function addOverride() {
    const trimmed = newModelId.trim();
    if (!trimmed) {
      toast.error("请填写或选择模型 ID。");
      return;
    }
    if (/\s/u.test(trimmed)) {
      toast.error("模型 ID 不能包含空格。");
      return;
    }
    if (
      draft.modelOverrides.some(
        (entry) => entry.modelId.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      toast.error(`模型「${trimmed}」已在覆写列表中。`);
      return;
    }
    const nextEntry: WebSearchModelOverride =
      newMode === "native"
        ? { modelId: trimmed, mode: "native" }
        : { modelId: trimmed, mode: "provider", provider: newOverrideProvider };
    setDraft((prev) => ({
      ...prev,
      modelOverrides: [...prev.modelOverrides, nextEntry],
    }));
    setNewModelId("");
  }

  function removeOverride(modelId: string) {
    setDraft((prev) => ({
      ...prev,
      modelOverrides: prev.modelOverrides.filter(
        (entry) => entry.modelId !== modelId,
      ),
    }));
  }

  const saveAction = useAsyncAction(
    async () => {
      const providersPayload: Partial<
        Record<WebSearchExternalProviderKind, WebSearchProviderSlotInput>
      > = {};
      for (const kind of WEB_SEARCH_EXTERNAL_PROVIDERS) {
        const slot = draft.providers[kind];
        providersPayload[kind] = {
          baseUrl: slot.baseUrl.trim(),
          ...(slot.clearApiKey
            ? { clearApiKey: true }
            : slot.apiKey.trim()
              ? { apiKey: slot.apiKey.trim() }
              : {}),
        };
      }
      const saved = await saveWebSearchSettings({
        defaultProvider: draft.defaultProvider,
        fallbackToBuiltin: draft.fallbackToBuiltin,
        timeoutMs: Math.round(parsedTimeout),
        maxResults: Math.round(parsedMaxResults),
        providers: providersPayload,
        modelOverrides: draft.modelOverrides,
      });
      setDraft(draftFromView(saved));
      toast.success("联网搜索配置已保存。");
      await queryClient.invalidateQueries({ queryKey: webSearchKeys.all });
    },
    { errorToast: (error) => error.message },
  );

  const testAction = useAsyncAction(
    async () => {
      const targetProvider = draft.defaultProvider;
      const targetSlot =
        targetProvider === "builtin" ? null : draft.providers[targetProvider];
      const result = await testWebSearch({
        query: testQuery.trim() || "ChisaBot",
        count: maxResultsValid
          ? Math.round(parsedMaxResults)
          : DEFAULT_WEB_SEARCH_MAX_RESULTS,
        provider: targetProvider,
        ...(targetSlot ? { baseUrl: targetSlot.baseUrl.trim() } : {}),
        ...(targetSlot?.apiKey.trim()
          ? { apiKey: targetSlot.apiKey.trim() }
          : {}),
        fallbackToBuiltin: draft.fallbackToBuiltin,
        ...(timeoutValid ? { timeoutMs: Math.round(parsedTimeout) } : {}),
      });
      setTestResult(result);
      if (!result.ok) {
        throw new Error(result.message);
      }
    },
    { errorToast: false },
  );

  const catalogModels = catalog.data?.models ?? [];

  return (
    <form
      autoComplete="off"
      className="media-card-stack"
      data-testid="web-search-settings-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && saveAction.state !== "pending") {
          void saveAction.run();
        }
      }}
    >
      <div className="media-body">
        <div className="im-form">
          <div className="im-grid">
            <label className="im-field" htmlFor="web-search-default-provider">
              <span className="im-field-l">{"默认搜索供应商"}</span>
              <Select
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    (WEB_SEARCH_PROVIDER_KINDS as readonly string[]).includes(
                      value,
                    )
                  ) {
                    handleDefaultProviderChange(value as WebSearchProviderKind);
                  }
                }}
                value={draft.defaultProvider}
              >
                <SelectTrigger
                  className="w-full"
                  data-testid="web-search-default-provider"
                  id="web-search-default-provider"
                >
                  <SelectValue>{activePreset.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WEB_SEARCH_PROVIDER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {WEB_SEARCH_PROVIDER_PRESETS[kind].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="im-field-h">{activePreset.note}</span>
            </label>

            <div className="im-grid">
              <label className="im-field" htmlFor="web-search-timeout">
                <span className="im-field-l">{"单次超时（ms）"}</span>
                <Input
                  className="font-mono"
                  id="web-search-timeout"
                  inputMode="numeric"
                  max={MAX_WEB_SEARCH_TIMEOUT_MS}
                  min={MIN_WEB_SEARCH_TIMEOUT_MS}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      timeoutMs: event.target.value,
                    }))
                  }
                  type="number"
                  value={draft.timeoutMs}
                />
              </label>
              <label className="im-field" htmlFor="web-search-max-results">
                <span className="im-field-l">{"默认返回条数"}</span>
                <Input
                  className="font-mono"
                  id="web-search-max-results"
                  inputMode="numeric"
                  max={10}
                  min={1}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      maxResults: event.target.value,
                    }))
                  }
                  type="number"
                  value={draft.maxResults}
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="media-switch border-t">
        <SettingRow
          description="外部搜索接口超时、限流或出错时，自动优雅回退到内建 DuckDuckGo / Bing 搜索源。"
          title={
            <span className="inline-flex items-center gap-2">
              <IconWorld className="size-4" />
              {"外部源失败时自动回退内建源"}
            </span>
          }
        >
          <Switch
            aria-label="外部源失败时自动回退内建源"
            checked={draft.fallbackToBuiltin}
            data-testid="web-search-fallback-switch"
            onCheckedChange={(checked) =>
              setDraft((prev) => ({ ...prev, fallbackToBuiltin: checked }))
            }
          />
        </SettingRow>
      </div>

      {/* 供应商密钥与端点配置（按厂商独立隔离） */}
      <div className="media-body border-t">
        <div className="im-form">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-sm">
              {"外部供应商凭据配置（跨厂商与跨源严格隔离）"}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {WEB_SEARCH_EXTERNAL_PROVIDERS.map((kind) => {
                const selected = editingProvider === kind;
                const hasKey = current.providers[kind].keySource === "saved";
                return (
                  <Button
                    key={kind}
                    onClick={() => setEditingProvider(kind)}
                    size="sm"
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                  >
                    {kind.toUpperCase()}
                    {hasKey ? " · 已配" : ""}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="im-grid">
            <label className="im-field" htmlFor="web-search-provider-base">
              <span className="im-field-l">
                {`${slotPreset.label} 接口地址`}
              </span>
              <Input
                className="font-mono"
                data-testid="web-search-provider-base"
                id="web-search-provider-base"
                onChange={(event) =>
                  updateSlot(editingProvider, { baseUrl: event.target.value })
                }
                placeholder={
                  slotPreset.defaultBaseUrl || "https://search.example.com/api"
                }
                spellCheck={false}
                value={activeSlot.baseUrl}
              />
              {!slotBaseUrlValid ? (
                <span className="im-field-h text-destructive">
                  {
                    "须为合法的 http:// 或 https:// 地址，且不含查询参数或凭据。"
                  }
                </span>
              ) : null}
            </label>

            <label className="im-field" htmlFor="web-search-provider-key">
              <span className="im-field-l">
                {`${slotPreset.label} API Key`}
              </span>
              <div className="flex items-center gap-2">
                <Input
                  autoComplete="new-password"
                  className="flex-1 font-mono"
                  data-1p-ignore
                  data-testid="web-search-provider-key"
                  disabled={activeSlot.clearApiKey}
                  id="web-search-provider-key"
                  onChange={(event) =>
                    updateSlot(editingProvider, {
                      apiKey: event.target.value,
                      clearApiKey: false,
                    })
                  }
                  placeholder={
                    savedSlot.keySource === "saved"
                      ? "留空保留当前加密密钥"
                      : "粘贴 API Key"
                  }
                  type="password"
                  value={activeSlot.apiKey}
                />
                {savedSlot.keySource === "saved" ? (
                  <Button
                    onClick={() =>
                      updateSlot(editingProvider, {
                        apiKey: "",
                        clearApiKey: !activeSlot.clearApiKey,
                      })
                    }
                    size="sm"
                    type="button"
                    variant={activeSlot.clearApiKey ? "destructive" : "outline"}
                  >
                    {activeSlot.clearApiKey ? "撤销清空" : "清空密钥"}
                  </Button>
                ) : null}
              </div>
              <span className="im-field-h" data-private="">
                {activeSlot.clearApiKey
                  ? "保存后将清除该供应商已存密钥。"
                  : activeSlot.apiKey.trim()
                    ? "保存后将使用 AES-256-GCM 加密覆盖该供应商密钥。"
                    : savedSlot.keySource === "saved"
                      ? `已加密保存${savedSlot.keyHint ? `（末四位 ${savedSlot.keyHint}）` : ""}；跨源修改端点地址时会自动失效以防外泄。`
                      : "尚未保存密钥；该槽位密钥仅发往当前供应商的同源地址。"}
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* 按模型覆写表 */}
      <div className="media-body border-t">
        <div className="im-form">
          <div className="space-y-1">
            <span className="font-medium text-sm">{"按模型覆写联网策略"}</span>
            <p className="text-muted-foreground text-xs">
              {
                "可为特定模型指定独立搜索引擎，或设为「模型原生搜索」以关闭内置 web_search 工具。"
              }
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
            <div>
              <Input
                aria-label="模型 ID"
                className="font-mono"
                data-testid="web-search-override-model"
                list="web-search-catalog-models"
                onChange={(event) => setNewModelId(event.target.value)}
                placeholder="输入或选择模型 ID（如 gpt-4o）"
                spellCheck={false}
                value={newModelId}
              />
              <datalist id="web-search-catalog-models">
                {catalogModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </datalist>
            </div>

            <Select
              onValueChange={(value) => {
                if (value === "provider" || value === "native") {
                  setNewMode(value);
                }
              }}
              value={newMode}
            >
              <SelectTrigger aria-label="覆写模式" className="w-full">
                <SelectValue>
                  {newMode === "native"
                    ? "模型原生搜索（关闭内置）"
                    : "指定搜索供应商"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="provider">{"指定搜索供应商"}</SelectItem>
                <SelectItem value="native">
                  {"模型原生搜索（关闭内置）"}
                </SelectItem>
              </SelectContent>
            </Select>

            {newMode === "provider" ? (
              <Select
                onValueChange={(value) => {
                  if (
                    typeof value === "string" &&
                    (WEB_SEARCH_PROVIDER_KINDS as readonly string[]).includes(
                      value,
                    )
                  ) {
                    setNewOverrideProvider(value as WebSearchProviderKind);
                  }
                }}
                value={newOverrideProvider}
              >
                <SelectTrigger aria-label="覆写供应商" className="w-full">
                  <SelectValue>
                    {WEB_SEARCH_PROVIDER_PRESETS[newOverrideProvider].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WEB_SEARCH_PROVIDER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {WEB_SEARCH_PROVIDER_PRESETS[kind].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center rounded-md border border-dashed px-3 text-muted-foreground text-xs">
                {"不注入内置 web_search"}
              </div>
            )}

            <Button
              data-testid="web-search-override-add"
              onClick={addOverride}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconPlus className="size-4" />
              {"添加"}
            </Button>
          </div>

          {draft.modelOverrides.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {"暂无按模型覆写规则，所有模型均使用上方默认搜索供应商。"}
            </p>
          ) : (
            <div className="space-y-2" data-testid="web-search-override-list">
              {draft.modelOverrides.map((entry) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                  key={entry.modelId}
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono font-medium">
                      {entry.modelId}
                    </span>
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                      {entry.mode === "native"
                        ? "模型原生搜索（关闭内置 web_search）"
                        : WEB_SEARCH_PROVIDER_PRESETS[
                            entry.provider ?? "builtin"
                          ].label}
                    </span>
                  </div>
                  <Button
                    aria-label={`移除模型 ${entry.modelId} 的联网覆写`}
                    onClick={() => removeOverride(entry.modelId)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <IconTrash className="size-4" />
                    {"移除"}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 在线试搜 + 保存 */}
      <div className="media-body border-t">
        <div className="im-form">
          <label className="im-field" htmlFor="web-search-test-query">
            <span className="im-field-l">{"在线试搜（按当前草稿测试）"}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-[200px] flex-1"
                data-testid="web-search-test-query"
                id="web-search-test-query"
                onChange={(event) => setTestQuery(event.target.value)}
                placeholder="输入试搜关键词，例如：今日人工智能新闻"
                value={testQuery}
              />
              <Button
                data-testid="web-search-test-btn"
                disabled={!testQuery.trim()}
                feedback="test"
                onClick={() => void testAction.run()}
                state={testAction.state}
                type="button"
                variant="outline"
              >
                <IconSearch className="size-4" />
                {"在线试搜"}
              </Button>
              <Button
                data-testid="web-search-save-btn"
                disabled={!canSave}
                feedback="save"
                state={saveAction.state}
                type="submit"
              >
                {"保存联网设置"}
              </Button>
            </div>
          </label>

          {testResult ? (
            <div
              className="space-y-2 rounded-lg border p-3 text-sm"
              data-testid="web-search-test-result"
              role="status"
            >
              <div
                className={
                  testResult.ok
                    ? "font-medium text-foreground"
                    : "font-medium text-destructive"
                }
              >
                {`${testResult.message}（${Math.round(testResult.latencyMs)} ms${testResult.usedFallback ? " · 已触发内建回退" : ""}）`}
              </div>
              {testResult.hits.length > 0 ? (
                <ul className="space-y-2">
                  {testResult.hits.map((hit) => (
                    <li
                      className="rounded-md bg-muted/40 px-2.5 py-2 text-xs"
                      key={hit.url}
                    >
                      <a
                        className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                        href={hit.url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <span>{hit.title}</span>
                        <IconExternalLink className="size-3 shrink-0" />
                      </a>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {hit.url}
                      </div>
                      {hit.snippet ? (
                        <p className="mt-1 line-clamp-2 text-muted-foreground">
                          {hit.snippet}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/** 挂载于 `/admin/models` 的「联网搜索」管理员配置区。 */
export function WebSearchSettingsSection() {
  const settings = useQuery(webSearchSettingsQueryOptions());
  return (
    <div className="media-anchor" id="web-search">
      <PageSection
        description="为内置 web_search 配置多供应商引擎（Tavily / Brave / Serper / 博查 / Exa / 自定义），并支持按模型覆写或改走模型原生搜索。"
        settingItem="models.web-search"
        title="联网搜索"
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
            title={settings.error?.message ?? "无法加载联网搜索配置"}
          />
        ) : (
          <WebSearchSettingsCard
            current={settings.data}
            key={settings.data.updatedAt ?? "initial"}
          />
        )}
      </PageSection>
    </div>
  );
}
