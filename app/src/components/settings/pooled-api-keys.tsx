import { IconArrowBackUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  describePooledKeyHealth,
  type PooledApiKeyProjection,
  type PooledKeyDraft,
  type PooledKeyFieldErrors,
  pooledKeyDraftKey,
} from "@/lib/model-settings/form";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

type PooledApiKeysSectionProps = {
  entries: PooledKeyDraft[];
  projections: readonly PooledApiKeyProjection[];
  errors?: Record<string, PooledKeyFieldErrors>;
  disabled: boolean;
  onAdd: () => void;
  onChangeLabel: (key: string, label: string) => void;
  onChangeSecret: (key: string, value: string) => void;
  onToggleRemove: (id: string, removed: boolean) => void;
  onRemoveNew: (clientKey: string) => void;
};

function PooledKeyHealthBadge({
  projection,
}: {
  projection: PooledApiKeyProjection;
}) {
  const [settledCooldown, setSettledCooldown] = useState<number | null>(null);
  const cooldownTarget = !projection.healthy ? projection.cooldownUntil : null;
  const needsTick =
    cooldownTarget !== null && settledCooldown !== cooldownTarget;
  const now = useNow(needsTick);

  if (needsTick && cooldownTarget !== null && now >= cooldownTarget) {
    setSettledCooldown(cooldownTarget);
  }

  const health = describePooledKeyHealth(
    projection,
    needsTick ? now : Date.now(),
  );

  return (
    <span
      className={cn(
        health.badgeClass,
        "inline-flex items-center gap-1.5 text-xs",
      )}
      title={health.detail}
    >
      <span aria-hidden="true" className={health.dotClass} />
      <span>{health.label}</span>
    </span>
  );
}

/** 模型主连接配置旁的备选 API Key 池（粘性故障转移）管理区域。 */
export function PooledApiKeysSection({
  entries,
  projections,
  errors,
  disabled,
  onAdd,
  onChangeLabel,
  onChangeSecret,
  onToggleRemove,
  onRemoveNew,
}: PooledApiKeysSectionProps) {
  const projectionsById = new Map(
    projections.map((item) => [item.id, item] as const),
  );

  return (
    <div className="rounded-xl border border-border/70 bg-muted/20 p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="font-medium text-sm">
            {"备选 API Key 池（粘性故障转移）"}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {
              "当前密钥触发限流（429）或鉴权/服务异常时自动切换至健康备选 Key，并在冷却期结束后恢复；不添加则仅使用上方主 API Key。"
            }
          </p>
        </div>
        <Button
          disabled={disabled}
          onClick={onAdd}
          size="sm"
          type="button"
          variant="outline"
        >
          <IconPlus />
          {"添加备选 Key"}
        </Button>
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {"暂未配置备选 API Key，需要故障转移时可点击“添加备选 Key”。"}
        </p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const entryKey = pooledKeyDraftKey(entry);
            const entryErrors = errors?.[entryKey];
            const projection =
              entry.kind === "existing"
                ? projectionsById.get(entry.id)
                : undefined;
            const removed = entry.kind === "existing" && entry.removed;
            const labelInputId = `pooled-key-label-${entryKey}`;
            const secretInputId = `pooled-key-secret-${entryKey}`;

            return (
              <div
                className={cn(
                  "rounded-lg border border-border/70 bg-background/70 p-3.5 space-y-3",
                  removed && "opacity-65 bg-muted/30",
                )}
                key={entryKey}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    {entry.kind === "existing" ? (
                      <>
                        <span className="font-medium text-sm truncate">
                          {entry.label.trim() || "未命名备选 Key"}
                        </span>
                        <span
                          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                          data-private=""
                        >
                          {`id: ${entry.id}`}
                        </span>
                        {projection ? (
                          <PooledKeyHealthBadge projection={projection} />
                        ) : null}
                        {removed ? (
                          <span className="magpie-badge is-danger text-xs">
                            {"保存后移除"}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="magpie-badge text-xs">
                          {"新增备选 Key"}
                        </span>
                        <span className="font-medium text-sm truncate">
                          {entry.label.trim() || "待填写"}
                        </span>
                      </>
                    )}
                  </div>

                  {entry.kind === "existing" ? (
                    removed ? (
                      <Button
                        disabled={disabled}
                        onClick={() => onToggleRemove(entry.id, false)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconArrowBackUp />
                        {"撤销移除"}
                      </Button>
                    ) : (
                      <Button
                        aria-label={`移除备选 Key「${entry.label.trim() || entry.id}」`}
                        disabled={disabled}
                        onClick={() => onToggleRemove(entry.id, true)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <IconTrash />
                        {"移除"}
                      </Button>
                    )
                  ) : (
                    <Button
                      aria-label={`删除新增备选 Key「${entry.label.trim() || entry.clientKey}」`}
                      disabled={disabled}
                      onClick={() => onRemoveNew(entry.clientKey)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconTrash />
                      {"删除"}
                    </Button>
                  )}
                </div>

                {removed ? (
                  <p className="text-muted-foreground text-xs">
                    {"将在点击“保存设置”后从密钥池中移除。"}
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field data-invalid={Boolean(entryErrors?.label)}>
                      <FieldLabel htmlFor={labelInputId}>{"别名"}</FieldLabel>
                      <Input
                        aria-invalid={Boolean(entryErrors?.label)}
                        disabled={disabled}
                        id={labelInputId}
                        onChange={(event) =>
                          onChangeLabel(entryKey, event.target.value)
                        }
                        placeholder="例如：备用通道 1"
                        value={entry.label}
                      />
                      <FieldError>{entryErrors?.label}</FieldError>
                    </Field>
                    <Field data-invalid={Boolean(entryErrors?.apiKey)}>
                      <FieldLabel htmlFor={secretInputId}>
                        {entry.kind === "existing"
                          ? "更换密钥"
                          : "API Key（明文）"}
                      </FieldLabel>
                      <Input
                        aria-invalid={Boolean(entryErrors?.apiKey)}
                        autoComplete="off"
                        disabled={disabled}
                        id={secretInputId}
                        onChange={(event) =>
                          onChangeSecret(entryKey, event.target.value)
                        }
                        placeholder={
                          entry.kind === "existing"
                            ? entry.hasApiKey
                              ? "留空保持原密钥"
                              : "尚未保存密钥，请填写 API Key"
                            : "输入此备选 Key 的 API Key"
                        }
                        spellCheck={false}
                        type="text"
                        value={
                          entry.kind === "existing"
                            ? entry.newApiKey
                            : entry.apiKey
                        }
                      />
                      <FieldError>{entryErrors?.apiKey}</FieldError>
                    </Field>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
