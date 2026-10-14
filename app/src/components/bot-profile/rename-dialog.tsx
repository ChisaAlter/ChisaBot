import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { agentFormSchema, agentInputFrom } from "@/lib/agents/form";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import { agentQueryOptions } from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

/**
 * Rename from the roster menu. The update endpoint takes the whole profile, so the other fields
 * ride along from the loaded Bot and only the name changes.
 */
export function RenameBotDialog({
  agentId,
  name,
  onOpenChange,
  open,
}: {
  agentId: string;
  name: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const agent = useQuery({ ...agentQueryOptions(agentId), enabled: open });
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(open);
  if (open !== seen) {
    setSeen(open);
    if (open) {
      setDraft(name);
      setError(null);
    }
  }

  const save = async () => {
    const profile = agent.data;
    if (!profile) return;
    const parsed = agentFormSchema.shape.name.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "请填写名称。");
      return;
    }
    try {
      await update.mutateAsync({
        agentId,
        input: agentInputFrom({
          name: parsed.data,
          title: profile.title,
          roleDescription: profile.roleDescription,
          visibility: profile.visibility,
          endpoint: profile.builtIn ? "" : (profile.endpoint ?? ""),
          authValue: "",
        }),
      });
      toast.success("已重命名");
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法重命名。");
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{"重命名"}</DialogTitle>
          <DialogDescription>
            {"只改显示名称。职责和角色说明保持不变。"}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Input
            aria-label={"名称"}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
          {error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {"取消"}
          </Button>
          <Button
            disabled={!agent.data || update.isPending || !agent.data.canManage}
            onClick={() => void save()}
            size="sm"
          >
            {update.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
