import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AvatarField } from "@/components/agents/avatar-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { type AvatarDraft, colorFor, saveAvatarDraft } from "@/lib/agents/avatars";
import {
  DEFAULT_BOT_TITLE,
  DEFAULT_PURPOSE,
  agentInputFrom,
  profileFormSchema,
  titleFromPurpose,
  withProfileDefaults,
} from "@/lib/agents/form";
import { createAgentMutationOptions, updateAgentMutationOptions } from "@/lib/agents/mutations";
import type { AgentProfile } from "@/lib/agents/queries";
import { isComposing } from "@/lib/composing";
import { cn } from "@/lib/utils";

type Fields = { name: string; title: string; roleDescription: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

/**
 * 机器人资料表单——新建和编辑是同一张（DESIGN.md §81，2026-10-16 用户：「创建的时候没有职责，修改信息里就有了。
 * 而且任何地方都没有创建头像和上传头像的地方。」）。
 *
 * 字段和顺序固定：头像 · 名称（必填）· 职责（可不填，按「它做什么」自动写，看得见、能改）· 它做什么（就是提示词）。
 * 编辑不比新建多任何一格；模型、暂停、通知这些不属于「它是谁」，在资料页的「运行」里。
 * 「创建 / 保存」一次写完：先存名称这三格，再存头像（头像改动只是草稿，取消就丢）。
 */
export function BotProfileForm({
  agent,
  onSaved,
  onCancel,
  autoFocus = false,
  variant = "dialog",
  firstFieldRef,
}: {
  /** 有 = 编辑这个机器人；没有 = 新建。 */
  agent?: AgentProfile;
  onSaved: (agentId: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  /** dialog：新建弹窗（底部按钮在弹窗页脚样式）；card：资料卡里原地编辑。 */
  variant?: "dialog" | "card";
  firstFieldRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const client = useQueryClient();
  const create = useMutation(createAgentMutationOptions(client));
  const update = useMutation(updateAgentMutationOptions(client));
  const editing = Boolean(agent);
  const [fields, setFields] = useState<Fields>({
    name: agent?.name ?? "",
    title: agent?.title ?? "",
    roleDescription: agent?.roleDescription ?? "",
  });
  /** 职责跟着「它做什么」自动写：新建且没手动改过，或者被清空了。 */
  const [titleAuto, setTitleAuto] = useState(!editing);
  /** 新建默认是名字首字 + 底色（一打开就看得到，建好后一样）；编辑默认不动。 */
  const [avatar, setAvatar] = useState<AvatarDraft>(editing ? { kind: "keep" } : { kind: "monogram", color: "sky" });
  const avatarTouched = useRef(false);
  const [tried, setTried] = useState(false);

  // 新建：首字头像的底色按名字挑（改名就换色，直到用户自己选了头像）。
  useEffect(() => {
    if (editing || avatarTouched.current) return;
    setAvatar({ kind: "monogram", color: colorFor(fields.name.trim() || "新") });
  }, [editing, fields.name]);
  // 本地预览图用完就释放。
  useEffect(() => () => {
    if (avatar.kind === "image") URL.revokeObjectURL(avatar.previewUrl);
  }, [avatar]);

  const suggestion = fields.roleDescription.trim() ? titleFromPurpose(fields.roleDescription) : "";
  const shownTitle = titleAuto ? suggestion : fields.title;

  const issues = (): FieldErrors => {
    const parsed = profileFormSchema.safeParse({ ...fields, title: shownTitle });
    if (parsed.success) return {};
    const out: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Fields;
      if (!out[key]) out[key] = issue.message;
    }
    return out;
  };
  const errors = tried ? issues() : {};

  const save = useMutation({
    mutationFn: async (): Promise<string> => {
      const values = withProfileDefaults({
        ...fields,
        title: shownTitle,
        visibility: "private",
        // 一律私有、内置机器人不发端点（存着的那个不是用户填的，DESIGN.md §46）。
        endpoint: agent && !agent.builtIn ? (agent.endpoint ?? "") : "",
        authValue: "",
      });
      const unchanged =
        agent &&
        values.name === agent.name &&
        values.title === agent.title &&
        values.roleDescription === agent.roleDescription;
      const saved = agent
        ? unchanged
          ? agent
          : await update.mutateAsync({ agentId: agent.id, input: agentInputFrom(values) })
        : await create.mutateAsync(agentInputFrom(values));
      try {
        await saveAvatarDraft(client, saved.id, avatar);
      } catch (failure) {
        // 机器人已经建好 / 改好了：只是头像没存上。新建时照样进去，提示在资料里再换。
        const reason = failure instanceof Error ? failure.message : "头像没能保存";
        if (!agent) {
          toast.error(`机器人建好了，但${reason.replace(/。$/, "")}——可以在机器人资料里再换。`);
          return saved.id;
        }
        // 编辑：名称这几格可能已经存上了，只差头像。抛给表单显示，并留着草稿让用户「重试」（审查 10-1）。
        throw new AvatarSaveError(reason);
      }
      return saved.id;
    },
    onSuccess: (agentId) => onSaved(agentId),
  });

  const submit = () => {
    if (save.isPending) return;
    if (Object.keys(issues()).length > 0) {
      setTried(true);
      return;
    }
    save.mutate();
  };
  const set = (key: keyof Fields, value: string) => setFields((current) => ({ ...current, [key]: value }));
  const ids = editing ? `bp-${agent?.id}` : "create-agent";
  const failure = save.error ? save.error.message : null;
  const avatarFailed = save.error instanceof AvatarSaveError;
  const noteId = (key: keyof Fields) => `${ids}-${key}-note`;
  const statusText = save.isPending ? "保存中…" : save.isError ? "保存失败" : "";

  return (
    <form
      className={cn("bot-form", variant === "card" && "is-card")}
      data-testid="bot-profile-form"
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape" && variant === "card") {
          event.preventDefault();
          onCancel();
        }
        // 输入框里按 Enter = 提交；「它做什么」（多行）里 Enter 换行；输入法确认字的 Enter 不算。
        if (event.key === "Enter" && !event.shiftKey && !isComposing(event) && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          submit();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="bot-form-fields">
        <div className="bot-form-field">
          <span className="bot-form-label">{"头像"}</span>
          <AvatarField
            agentId={agent?.id}
            allowPattern={editing}
            autoPicked={!editing && !avatarTouched.current}
            draft={avatar}
            name={fields.name}
            onChange={(next) => {
              avatarTouched.current = true;
              setAvatar(next);
            }}
            seed={agent?.avatarSeed}
          />
        </div>
        <label className="bot-form-field" htmlFor={`${ids}-name`}>
          <span className="bot-form-label">{"名称"}</span>
          <Input
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={noteId("name")}
            autoComplete="off"
            autoFocus={autoFocus}
            id={`${ids}-name`}
            onChange={(event) => set("name", event.target.value)}
            placeholder={"给它起个名字"}
            ref={firstFieldRef}
            value={fields.name}
          />
          <FieldNote error={errors.name} id={noteId("name")} />
        </label>
        <label className="bot-form-field" htmlFor={`${ids}-title`}>
          <span className="bot-form-label">
            {"职责"}
            <span className="field-optional">{"显示在名字下面的一句话"}</span>
          </span>
          <Input
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={noteId("title")}
            autoComplete="off"
            id={`${ids}-title`}
            onChange={(event) => {
              const next = event.target.value;
              setTitleAuto(next === "");
              set("title", next);
            }}
            placeholder={DEFAULT_BOT_TITLE}
            value={shownTitle}
          />
          <FieldNote
            error={errors.title}
            id={noteId("title")}
            hint={titleAuto ? (suggestion ? "按「它做什么」自动写的，可以改" : "不填就是「私人助手」") : undefined}
          />
        </label>
        <label className="bot-form-field" htmlFor={`${ids}-purpose`}>
          <span className="bot-form-label">
            {"它做什么"}
            <span className="field-optional">{"这就是它的提示词"}</span>
          </span>
          <Textarea
            aria-invalid={errors.roleDescription ? true : undefined}
            aria-describedby={noteId("roleDescription")}
            className={variant === "card" ? "min-h-36" : "min-h-28"}
            id={`${ids}-purpose`}
            onChange={(event) => set("roleDescription", event.target.value)}
            placeholder={`一两句话说清它负责什么、怎么回答。不写就是：${DEFAULT_PURPOSE}`}
            rows={variant === "card" ? 6 : 4}
            value={fields.roleDescription}
          />
          <FieldNote error={errors.roleDescription} id={noteId("roleDescription")} />
        </label>
      </div>
      {failure ? (
        <div className="bot-form-error" data-testid="bot-profile-error" role="alert">
          <span>{avatarFailed ? `资料已保存，但${failure.replace(/。$/, "")}。` : failure}</span>
          {avatarFailed ? (
            <Button
              data-testid="bot-profile-retry-avatar"
              onClick={() => submit()}
              size="sm"
              type="button"
              variant="outline"
            >
              {"重试保存头像"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {/* 审查 10-15：按钮里三段状态字只靠样式切换；给读屏一个只念当前状态的 live 区。 */}
      <span aria-live="polite" className="sr-only" data-testid="bot-profile-status">
        {statusText}
      </span>
      <div className={variant === "card" ? "bot-form-actions" : "bot-form-actions is-dialog"}>
        <Button onClick={onCancel} size={variant === "card" ? "sm" : "default"} type="button" variant="outline">
          {"取消"}
        </Button>
        <Button
          data-testid="bot-profile-submit"
          feedback={editing ? "save" : "create"}
          mutation={save}
          size={variant === "card" ? "sm" : "default"}
          type="submit"
        >
          {editing ? "保存" : "创建机器人"}
        </Button>
      </div>
    </form>
  );
}

/** 字段下面一行：错误（红）或提示（灰）。总占一行高，出错不顶动下面的格子。 */
function FieldNote({ error, hint, id }: { error?: string; hint?: string; id: string }) {
  // 审查 10-13：字段用 aria-describedby 指到这里，读屏能念出错误或说明。
  return (
    <span className={cn("bot-form-note", error && "is-error")} id={id} role={error ? "alert" : undefined}>
      {error ?? hint ?? "\u00a0"}
    </span>
  );
}

/** 名称这几格已存上、只有头像没存上：表单据此显示「重试保存头像」。 */
export class AvatarSaveError extends Error {
  override name = "AvatarSaveError";
}
