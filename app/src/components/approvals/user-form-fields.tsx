import { useState } from "react";
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
import { toast } from "@/components/ui/toast";
import type { UserFormField } from "../../../../shared/user-form";

/**
 * CB-147 结构化表单渲染：text/textarea/select/multiselect/confirm 五控件。
 *
 * 客户端只做轻校验（必填空值禁提交）——严格校验在服务端（shared/user-form.ts），
 * 这里的拦截只为省一次往返。凭据类字段根本到不了这里：服务端在提问时已拒收。
 */
export function UserFormFields({
  fields,
  busy,
  expired,
  onSubmit,
}: {
  fields: readonly UserFormField[];
  busy: boolean;
  expired: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.defaultValue !== undefined)
        initial[field.id] = field.defaultValue;
    }
    return initial;
  });

  const set = (id: string, value: unknown) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const toggleMulti = (
    field: UserFormField & { type: "multiselect" },
    option: string,
  ) => {
    const current = Array.isArray(answers[field.id])
      ? (answers[field.id] as string[])
      : [];
    set(
      field.id,
      current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option],
    );
  };

  const submit = () => {
    for (const field of fields) {
      if (field.required === false) continue;
      const value = answers[field.id];
      const empty =
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty && field.defaultValue === undefined) {
        toast.error(`「${field.label}」还没填。`);
        return;
      }
    }
    onSubmit(answers);
  };

  return (
    <div className="space-y-3" data-testid="user-form-fields">
      {fields.map((field) => (
        <div className="space-y-1.5" key={field.id}>
          <label
            className="font-medium text-sm"
            htmlFor={`form-field-${field.id}`}
          >
            {field.label}
            {field.required !== false ? (
              <span className="text-destructive">{" *"}</span>
            ) : null}
          </label>
          {field.hint ? (
            <p className="text-muted-foreground text-xs">{field.hint}</p>
          ) : null}

          {field.type === "text" ? (
            <Input
              aria-label={field.label}
              disabled={busy || expired}
              id={`form-field-${field.id}`}
              onChange={(event) => set(field.id, event.target.value)}
              placeholder={field.placeholder ?? ""}
              value={
                typeof answers[field.id] === "string"
                  ? (answers[field.id] as string)
                  : ""
              }
            />
          ) : null}

          {field.type === "textarea" ? (
            <Textarea
              aria-label={field.label}
              disabled={busy || expired}
              id={`form-field-${field.id}`}
              onChange={(event) => set(field.id, event.target.value)}
              placeholder={field.placeholder ?? ""}
              rows={3}
              value={
                typeof answers[field.id] === "string"
                  ? (answers[field.id] as string)
                  : ""
              }
            />
          ) : null}

          {field.type === "select" ? (
            <Select
              disabled={busy || expired}
              onValueChange={(value) => set(field.id, value)}
              value={
                typeof answers[field.id] === "string"
                  ? (answers[field.id] as string)
                  : ""
              }
            >
              <SelectTrigger
                aria-label={field.label}
                id={`form-field-${field.id}`}
              >
                <SelectValue placeholder="请选择…" />
              </SelectTrigger>
              <SelectContent>
                {field.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {field.type === "multiselect" ? (
            // biome-ignore lint/a11y/useSemanticElements: 与快捷选项同一自绘胶囊控件，键盘约定见 ui/segmented.tsx
            <div
              className="chat-question-opts"
              role="group"
              aria-label={field.label}
            >
              {field.options.map((option) => {
                const current = Array.isArray(answers[field.id])
                  ? (answers[field.id] as string[])
                  : [];
                const selected = current.includes(option);
                return (
                  <button
                    aria-pressed={selected}
                    className="chat-question-opt"
                    data-selected={selected ? "true" : undefined}
                    disabled={busy || expired}
                    key={option}
                    onClick={() => toggleMulti(field, option)}
                    type="button"
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          ) : null}

          {field.type === "confirm" ? (
            <div className="flex items-center gap-2">
              <Switch
                aria-label={field.label}
                checked={answers[field.id] === true}
                disabled={busy || expired}
                id={`form-field-${field.id}`}
                onCheckedChange={(checked) => set(field.id, checked)}
              />
              <span className="text-muted-foreground text-sm">
                {answers[field.id] === true ? "是" : "否"}
              </span>
            </div>
          ) : null}
        </div>
      ))}

      <div className="flex justify-end pt-1">
        <Button disabled={busy || expired} onClick={submit} size="sm">
          {busy ? "提交中…" : "提交"}
        </Button>
      </div>
    </div>
  );
}
