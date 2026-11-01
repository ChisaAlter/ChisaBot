import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { SaveBar } from "@/components/ui/skyglass";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useUnsavedGuard } from "@/components/ui/unsaved-guard";
import { saveInstructionsMutationOptions } from "@/lib/settings/mutations";
import {
  INSTRUCTIONS_LIMIT,
  instructionsQueryOptions,
} from "@/lib/settings/queries";
import { queryClient } from "@/query-client";

/**
 * One box, applied to every coworker in every channel.
 *
 * WHAT IT IS FOR, said on the screen rather than left to be guessed. A coworker's role and this are
 * both durable instructions and a person meeting them for the first time has no reason to know which
 * belongs where, so the description draws the line the prompt draws: the role says what a coworker
 * is for, this says how the person wants things done. Without that sentence the obvious mistake is
 * to write a job description here and get it applied to every coworker at once.
 */
export function StandingInstructions() {
  const stored = useQuery(instructionsQueryOptions());
  const save = useMutation(saveInstructionsMutationOptions(queryClient));

  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /*
   * The box holds the stored text until somebody types, and their typing after that.
   *
   * Null is "has not been edited", which is not the same as "is empty": seeding the state with ""
   * and then filling it in when the read lands would overwrite whatever they had already started
   * typing into a box that was ready before the network was.
   */
  useEffect(() => {
    if (stored.data !== undefined && draft === null) setDraft(stored.data);
  }, [stored.data, draft]);

  const text = draft ?? stored.data ?? "";
  const over = text.trim().length > INSTRUCTIONS_LIMIT;
  const unchanged = stored.data !== undefined && text === stored.data;
  const dirty = stored.data !== undefined && !unchanged;
  /* 有未保存的更改时，切左栏、后退先确认；刷新、关标签走浏览器的 beforeunload（审查模块 12 第 3 条）。 */
  useUnsavedGuard(dirty && !save.isPending);
  /* Keep the bar up for the ✓ (≈1.5s) after a save, then let it slide away. */
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!saved) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const submit = () => {
    setProblem(null);
    setSaved(false);
    const sent = text;
    save.mutate(sent, {
      onError: (thrown: Error) => {
        setProblem(thrown.message);
        toast.error(`保存失败：${thrown.message}`);
      },
      /* The server trims, so the box settles to what was actually stored rather than what was sent. */
      onSuccess: (asStored) => {
        /* 保存中框还能接着打：只有没再改过时才换成服务器存下的值，免得吞掉刚打的字。 */
        setDraft((current) => (current === sent ? asStored : current));
        setSaved(true);
      },
    });
  };

  return (
    <PageSection
      description={
        "对你所有的机器人、所有对话都生效。机器人自己的说明决定它做什么；这里写你希望它们怎么做事，比如语气、写作风格、称呼。"
      }
      title={"常驻指令"}
    >
      {stored.isPending ? <PageSkeleton rows={1} tall /> : stored.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {stored.error.message}
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <Textarea
            aria-label={"常驻指令"}
            className="min-h-40"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            placeholder={
              "回答简洁，先说结论；中文回复，代码注释用英文。"
            }
            value={text}
          />
          <div className="flex flex-row items-center justify-between gap-4">
            <p
              className={
                over
                  ? "text-destructive text-xs"
                  : "text-muted-foreground text-xs"
              }
            >
              {`${text.trim().length} / ${INSTRUCTIONS_LIMIT} 字`}
            </p>
            {problem ? (
              <span className="text-destructive text-xs" role="alert">
                {problem}
              </span>
            ) : null}
          </div>
          {/* DESIGN.md §11 未保存栏: appears on the first edit, stays through 保存中… → 已保存. */}
          <SaveBar show={dirty || save.isPending || flash}>
            <Button
              disabled={save.isPending}
              onClick={() => {
                setDraft(stored.data ?? "");
                setProblem(null);
              }}
              size="sm"
              variant="ghost"
            >
              {"放弃"}
            </Button>
            <Button mutation={save}
              feedback="save"
              disabled={over || (unchanged && !save.isPending)}
              onClick={submit}
              size="sm"
            >
              {"保存"}
            </Button>
          </SaveBar>
        </div>
      )}
    </PageSection>
  );
}
