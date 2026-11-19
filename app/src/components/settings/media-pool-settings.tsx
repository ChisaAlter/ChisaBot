import {
  IconMovie,
  IconPencil,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  createMediaPoolEntry,
  deleteMediaPoolEntry,
  mediaPoolKeys,
  mediaPoolQueryOptions,
  updateMediaPoolEntry,
} from "@/lib/media-pool";
import {
  EMPTY_MEDIA_PARAM_SCHEMA,
  MAX_MEDIA_REFERENCE_IMAGES,
  MEDIA_CAPABILITIES,
  MEDIA_CAPABILITY_LABELS,
  MEDIA_POOL_PROVIDERS,
  MEDIA_PROVIDER_LABELS,
  type MediaCapability,
  type MediaParamSchema,
  type MediaPoolModelEntry,
  type MediaPoolProvider,
  normalizeMediaParamSchema,
} from "../../../../shared/media-pool";

type DraftForm = {
  id: string | null;
  label: string;
  capability: MediaCapability;
  provider: MediaPoolProvider;
  baseUrl: string;
  model: string;
  costHint: string;
  styleTagsText: string;
  maxReferenceImages: number;
  paramSchemaText: string;
  enabled: boolean;
  apiKey: string;
  keySource: "saved" | "none";
  keyHint: string;
};

const DEFAULT_SCHEMA_JSON = JSON.stringify(EMPTY_MEDIA_PARAM_SCHEMA, null, 2);

function emptyDraft(): DraftForm {
  return {
    id: null,
    label: "",
    capability: "image-generate",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-1",
    costHint: "",
    styleTagsText: "",
    maxReferenceImages: 4,
    paramSchemaText: DEFAULT_SCHEMA_JSON,
    enabled: true,
    apiKey: "",
    keySource: "none",
    keyHint: "",
  };
}

function draftFromEntry(entry: MediaPoolModelEntry): DraftForm {
  return {
    id: entry.id,
    label: entry.label,
    capability: entry.capability,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    model: entry.model,
    costHint: entry.costHint,
    styleTagsText: entry.styleTags.join(", "),
    maxReferenceImages: entry.maxReferenceImages,
    paramSchemaText: JSON.stringify(entry.paramSchema, null, 2),
    enabled: entry.enabled,
    apiKey: "",
    keySource: entry.keySource ?? "none",
    keyHint: entry.keyHint ?? "",
  };
}

function parseSchemaDraft(
  text: string,
): { ok: true; schema: MediaParamSchema } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, schema: EMPTY_MEDIA_PARAM_SCHEMA };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "paramSchema 必须是 JSON 对象。" };
    }
    return { ok: true, schema: normalizeMediaParamSchema(parsed) };
  } catch {
    return {
      ok: false,
      message: "paramSchema JSON 格式有误，请检查括号与引号。",
    };
  }
}

/**
 * 多模态创作模型池管理（设置 → 模型 → 多模态创作模型池）。
 * 支持配置多个生图、多参考图编辑、视频生成与视频理解模型及其 paramSchema 白名单，
 * 让 AI 通过 media_pool_list 按画风、成本与参考图能力自主选型。
 */
export function MediaPoolSettingsSection() {
  const queryClient = useQueryClient();
  const poolQuery = useQuery(mediaPoolQueryOptions());
  const [editing, setEditing] = useState<DraftForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const saveAction = useAsyncAction(
    async () => {
      if (!editing) return;
      setFormError(null);
      const schemaResult = parseSchemaDraft(editing.paramSchemaText);
      if (!schemaResult.ok) {
        setFormError(schemaResult.message);
        throw new Error(schemaResult.message);
      }
      const styleTags = editing.styleTagsText
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
      const payload = {
        label: editing.label.trim(),
        capability: editing.capability,
        provider: editing.provider,
        baseUrl: editing.baseUrl.trim(),
        model: editing.model.trim(),
        costHint: editing.costHint.trim(),
        styleTags,
        maxReferenceImages: Math.min(
          MAX_MEDIA_REFERENCE_IMAGES,
          Math.max(0, Math.trunc(editing.maxReferenceImages || 0)),
        ),
        paramSchema: schemaResult.schema,
        enabled: editing.enabled,
        ...(editing.apiKey.trim() ? { apiKey: editing.apiKey.trim() } : {}),
      };

      try {
        if (editing.id) {
          await updateMediaPoolEntry(editing.id, payload);
        } else {
          await createMediaPoolEntry(payload);
        }
        await queryClient.invalidateQueries({ queryKey: mediaPoolKeys.all });
        setEditing(null);
      } catch (failure) {
        setFormError(
          failure instanceof Error ? failure.message : "保存模型池条目失败。",
        );
        throw failure;
      }
    },
    { errorToast: false },
  );

  const deleteAction = useAsyncAction(
    async (id: string) => {
      await deleteMediaPoolEntry(id);
      await queryClient.invalidateQueries({ queryKey: mediaPoolKeys.all });
      if (editing?.id === id) setEditing(null);
    },
    { errorToast: (error) => error.message },
  );

  const toggleEnabledAction = useAsyncAction(
    async (entry: MediaPoolModelEntry, nextEnabled: boolean) => {
      await updateMediaPoolEntry(entry.id, {
        label: entry.label,
        capability: entry.capability,
        provider: entry.provider,
        baseUrl: entry.baseUrl,
        model: entry.model,
        costHint: entry.costHint,
        styleTags: entry.styleTags,
        maxReferenceImages: entry.maxReferenceImages,
        paramSchema: entry.paramSchema,
        enabled: nextEnabled,
      });
      await queryClient.invalidateQueries({ queryKey: mediaPoolKeys.all });
    },
    { errorToast: (error) => error.message },
  );

  const entries = poolQuery.data ?? [];
  const schemaCheck = editing
    ? parseSchemaDraft(editing.paramSchemaText)
    : null;
  const canSubmit = Boolean(
    editing?.label.trim() &&
      /^https?:\/\/\S+/.test(editing.baseUrl.trim()) &&
      editing.model.trim() &&
      schemaCheck?.ok,
  );

  return (
    <div className="media-anchor" id="media-pool">
      <PageSection
        action={
          <Button
            data-testid="media-pool-add"
            onClick={() => {
              setFormError(null);
              setEditing(emptyDraft());
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <IconPlus className="size-4" />
            {"添加模型"}
          </Button>
        }
        description="配置多个生图、多参考图编辑（最多 10 张）、视频生成与视频理解模型。密钥按条目加密存储，跨源更改接口地址会自动清除旧密钥；AI 可按画风、成本与 paramSchema 白名单自主选型。"
        settingItem="models.media-pool"
        title="多模态创作模型池"
      >
        {poolQuery.isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            {"正在加载多模态模型池…"}
          </p>
        ) : poolQuery.error ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-destructive">
              {poolQuery.error.message || "无法加载多模态模型池。"}
            </span>
            <Button
              onClick={() => void poolQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试"}
            </Button>
          </div>
        ) : entries.length === 0 && !editing ? (
          <div
            className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-border/70 p-4 text-sm text-muted-foreground"
            data-testid="media-pool-empty"
          >
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <IconSparkles className="size-4" />
              {"还没有配置多模态模型池条目"}
            </span>
            <p>
              {
                "添加多个生图、视频生成或视频理解模型后，机器人可通过 media_pool_list 自主选型并支持多参考图与安全参数透传。"
              }
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="media-pool-list">
            {entries.map((entry) => {
              const paramCount = Object.keys(
                entry.paramSchema.properties ?? {},
              ).length;
              return (
                <div
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/70 bg-background/50 p-3.5"
                  data-testid={`media-pool-item-${entry.id}`}
                  key={entry.id}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 font-medium text-sm">
                        <IconMovie className="size-4 text-muted-foreground" />
                        {entry.label}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {MEDIA_CAPABILITY_LABELS[entry.capability]}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {MEDIA_PROVIDER_LABELS[entry.provider]}
                      </span>
                      {entry.costHint ? (
                        <span className="text-xs text-muted-foreground">
                          {entry.costHint}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {`${entry.model} · ${entry.baseUrl}`}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>{`参考图上限：${entry.maxReferenceImages}`}</span>
                      <span>{`白名单参数：${paramCount} 项`}</span>
                      <span>
                        {entry.keySource === "saved"
                          ? `密钥已加密保存${entry.keyHint ? `（末四位 ${entry.keyHint}）` : ""}`
                          : "未配置独立密钥"}
                      </span>
                      {entry.styleTags.length > 0 ? (
                        <span>{`标签：${entry.styleTags.join(" / ")}`}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      aria-label={`启用 ${entry.label}`}
                      checked={entry.enabled}
                      onCheckedChange={(checked) =>
                        void toggleEnabledAction.run(entry, checked)
                      }
                    />
                    <Button
                      aria-label={`编辑 ${entry.label}`}
                      onClick={() => {
                        setFormError(null);
                        setEditing(draftFromEntry(entry));
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconPencil className="size-4" />
                    </Button>
                    <Button
                      aria-label={`删除 ${entry.label}`}
                      onClick={() => void deleteAction.run(entry.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {editing ? (
          <form
            autoComplete="off"
            className="mt-4 space-y-3 rounded-xl border border-border bg-background/70 p-4"
            data-testid="media-pool-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit && saveAction.state !== "pending") {
                void saveAction.run();
              }
            }}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-sm">
                {editing.id ? "编辑模型池条目" : "新增模型池条目"}
              </h3>
              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <span>{"启用"}</span>
                <Switch
                  checked={editing.enabled}
                  onCheckedChange={(checked) =>
                    setEditing({ ...editing, enabled: checked })
                  }
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="im-field" htmlFor="mp-label">
                <span className="im-field-l">{"显示名称"}</span>
                <Input
                  id="mp-label"
                  onChange={(e) =>
                    setEditing({ ...editing, label: e.target.value })
                  }
                  placeholder="例如：写实高精生图 / Gemini 视频理解"
                  value={editing.label}
                />
              </label>
              <label className="im-field" htmlFor="mp-capability">
                <span className="im-field-l">{"能力类型"}</span>
                <Select
                  onValueChange={(value) =>
                    setEditing({
                      ...editing,
                      capability: value as MediaCapability,
                    })
                  }
                  value={editing.capability}
                >
                  <SelectTrigger className="w-full" id="mp-capability">
                    <SelectValue>
                      {MEDIA_CAPABILITY_LABELS[editing.capability]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MEDIA_CAPABILITIES.map((cap) => (
                      <SelectItem key={cap} value={cap}>
                        {MEDIA_CAPABILITY_LABELS[cap]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="im-field" htmlFor="mp-provider">
                <span className="im-field-l">{"接口协议"}</span>
                <Select
                  onValueChange={(value) =>
                    setEditing({
                      ...editing,
                      provider: value as MediaPoolProvider,
                    })
                  }
                  value={editing.provider}
                >
                  <SelectTrigger className="w-full" id="mp-provider">
                    <SelectValue>
                      {MEDIA_PROVIDER_LABELS[editing.provider]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MEDIA_POOL_PROVIDERS.map((prov) => (
                      <SelectItem key={prov} value={prov}>
                        {MEDIA_PROVIDER_LABELS[prov]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="im-field" htmlFor="mp-model">
                <span className="im-field-l">{"模型 ID"}</span>
                <Input
                  className="font-mono"
                  id="mp-model"
                  onChange={(e) =>
                    setEditing({ ...editing, model: e.target.value })
                  }
                  placeholder="例如：gpt-image-1 / gemini-2.5-flash"
                  value={editing.model}
                />
              </label>
            </div>

            <label className="im-field" htmlFor="mp-base-url">
              <span className="im-field-l">{"接口地址（Base URL）"}</span>
              <Input
                className="font-mono"
                id="mp-base-url"
                onChange={(e) =>
                  setEditing({ ...editing, baseUrl: e.target.value })
                }
                placeholder="https://api.openai.com/v1"
                value={editing.baseUrl}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="im-field" htmlFor="mp-cost">
                <span className="im-field-l">{"成本提示"}</span>
                <Input
                  id="mp-cost"
                  onChange={(e) =>
                    setEditing({ ...editing, costHint: e.target.value })
                  }
                  placeholder="约 ¥0.15/张"
                  value={editing.costHint}
                />
              </label>
              <label className="im-field" htmlFor="mp-refs">
                <span className="im-field-l">{`最大参考图（0–${MAX_MEDIA_REFERENCE_IMAGES}）`}</span>
                <Input
                  id="mp-refs"
                  max={MAX_MEDIA_REFERENCE_IMAGES}
                  min={0}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      maxReferenceImages: Number(e.target.value) || 0,
                    })
                  }
                  type="number"
                  value={editing.maxReferenceImages}
                />
              </label>
              <label className="im-field" htmlFor="mp-tags">
                <span className="im-field-l">{"画风/场景标签"}</span>
                <Input
                  id="mp-tags"
                  onChange={(e) =>
                    setEditing({ ...editing, styleTagsText: e.target.value })
                  }
                  placeholder="写实, 动漫, 海报"
                  value={editing.styleTagsText}
                />
              </label>
            </div>

            <label className="im-field" htmlFor="mp-api-key">
              <span className="im-field-l">
                {"API 密钥（AES-256-GCM 加密）"}
              </span>
              <Input
                autoComplete="new-password"
                className="font-mono"
                data-1p-ignore
                id="mp-api-key"
                onChange={(e) =>
                  setEditing({ ...editing, apiKey: e.target.value })
                }
                placeholder={
                  editing.keySource === "saved"
                    ? `已保存（末四位 ${editing.keyHint || "****"}），留空不改`
                    : "粘贴此模型条目的密钥"
                }
                type="password"
                value={editing.apiKey}
              />
              <span className="im-field-h">
                {"更换接口域名或协议时，系统将自动丢弃旧密钥以防跨源泄露。"}
              </span>
            </label>

            <label className="im-field" htmlFor="mp-schema">
              <span className="im-field-l">
                {"参数透传白名单（paramSchema JSON）"}
              </span>
              <Textarea
                className="min-h-28 font-mono text-xs"
                id="mp-schema"
                onChange={(e) =>
                  setEditing({ ...editing, paramSchemaText: e.target.value })
                }
                rows={5}
                value={editing.paramSchemaText}
              />
              <span className="im-field-h">
                {schemaCheck && !schemaCheck.ok
                  ? schemaCheck.message
                  : "仅允许在 properties 中声明的字段（type/enum/minimum/maximum）透传至上游接口。"}
              </span>
            </label>

            {formError ? (
              <p className="text-destructive text-sm" role="alert">
                {formError}
              </p>
            ) : null}

            <div className="flex items-center justify-end gap-2">
              <Button
                onClick={() => {
                  setFormError(null);
                  setEditing(null);
                }}
                type="button"
                variant="outline"
              >
                {"取消"}
              </Button>
              <Button
                data-testid="media-pool-save"
                disabled={!canSubmit}
                feedback="save"
                state={saveAction.state}
                type="submit"
              >
                {"保存条目"}
              </Button>
            </div>
          </form>
        ) : null}
      </PageSection>
    </div>
  );
}
