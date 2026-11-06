import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedGuard } from "@/components/ui/unsaved-guard";
import { taskCenterApi, taskCenterKeys } from "@/lib/task-center-api";
import type { TaskContext } from "../../../../shared/task-center";

type ContextDraft = Omit<TaskContext, "updatedAt" | "learned" | "learnedAt">;
const FIELDS: {
  key: keyof ContextDraft;
  title: string;
  hint: string;
  limit: number;
}[] = [
  {
    key: "responsibilities",
    title: "工作职责",
    hint: "你负责哪些事情，哪些结果由你判断。",
    limit: 8000,
  },
  {
    key: "projects",
    title: "正在推进的项目",
    hint: "项目目标、当前进展、近期截止时间和相关资料位置。",
    limit: 12000,
  },
  {
    key: "goals",
    title: "长期目标",
    hint: "未来一段时间最想实现什么，以及优先顺序。",
    limit: 8000,
  },
  {
    key: "interests",
    title: "技术兴趣",
    hint: "希望持续关注的技术、研究或行业方向。",
    limit: 4000,
  },
  {
    key: "habits",
    title: "日常习惯",
    hint: "工作时段、时区、希望集中处理消息的时间。",
    limit: 4000,
  },
  {
    key: "preferences",
    title: "个人偏好",
    hint: "交付格式、沟通方式，以及需要保留的例外和条件。",
    limit: 8000,
  },
];

function draftOf(context: TaskContext): ContextDraft {
  const {
    updatedAt: _updatedAt,
    learned: _learned,
    learnedAt: _learnedAt,
    ...draft
  } = context;
  return draft;
}

export function ContextSettings() {
  const id = useId();
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: taskCenterKeys.context,
    queryFn: ({ signal }) => taskCenterApi.getContext(signal),
  });
  const [draft, setDraft] = useState<ContextDraft | null>(null);
  const value = draft ?? (stored.data ? draftOf(stored.data.context) : null);
  const dirty = Boolean(
    value &&
      stored.data &&
      FIELDS.some(({ key }) => value[key] !== stored.data.context[key]),
  );
  const save = useMutation({
    mutationFn: taskCenterApi.setContext,
    onSuccess: (data) => {
      queryClient.setQueryData(taskCenterKeys.context, data);
      setDraft(null);
    },
  });
  useUnsavedGuard(dirty && !save.isPending);

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-6">
      <div className="max-w-2xl space-y-2">
        <h2 className="text-lg font-semibold" id={`${id}-title`}>
          让任务围绕你的目标推进
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          这些信息用于任务规划和优先级判断。写清当前目标与条件，变化时可以直接更新。
        </p>
      </div>
      {stored.isPending ? (
        <PageSkeleton rows={3} tall />
      ) : stored.error && !value ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {stored.error.message}
          </p>
          <Button variant="outline" onClick={() => void stored.refetch()}>
            重新加载
          </Button>
        </div>
      ) : value ? (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(value);
          }}
        >
          <div className="grid gap-x-6 gap-y-6 md:grid-cols-2">
            {FIELDS.map(({ key, title, hint, limit }) => (
              <div className="min-w-0 space-y-2" key={key}>
                <label
                  className="block text-sm font-medium"
                  htmlFor={`${id}-${key}`}
                >
                  {title}
                </label>
                <p
                  className="text-sm leading-relaxed text-muted-foreground"
                  id={`${id}-${key}-hint`}
                >
                  {hint}
                </p>
                <Textarea
                  aria-describedby={`${id}-${key}-hint`}
                  className="min-h-28 resize-y leading-relaxed"
                  disabled={save.isPending}
                  id={`${id}-${key}`}
                  maxLength={limit}
                  onChange={(event) => {
                    setDraft({ ...value, [key]: event.target.value });
                    save.reset();
                  }}
                  rows={4}
                  value={value[key]}
                />
              </div>
            ))}
          </div>
          {save.error ? (
            <p className="text-sm text-destructive" role="alert">
              {save.error.message}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <p className="text-sm text-muted-foreground" role="status">
              {dirty
                ? "有尚未保存的修改"
                : stored.data?.context.updatedAt
                  ? `上次更新：${new Date(stored.data.context.updatedAt).toLocaleString("zh-CN")}`
                  : "尚未填写个人上下文"}
            </p>
            <div className="flex items-center gap-2">
              {dirty ? (
                <Button
                  disabled={save.isPending}
                  onClick={() => {
                    setDraft(null);
                    save.reset();
                  }}
                  type="button"
                  variant="ghost"
                >
                  放弃修改
                </Button>
              ) : null}
              <Button
                disabled={!dirty}
                feedback="save"
                mutation={save}
                type="submit"
              >
                保存上下文
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}
