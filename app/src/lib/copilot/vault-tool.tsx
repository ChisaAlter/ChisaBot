import { useRenderTool } from "@/lib/chat/renderers";
import { IconCircleCheck, IconCircleX, IconLock } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useState } from "react";
import { z } from "zod";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button } from "@/components/ui/button";
import { cancelVaultRequest, fillVaultRequest, vaultKeys, vaultRequestQueryOptions } from "@/lib/vault";

/**
 * `vault_request_secret` 的安全输入卡片（DESIGN.md §52）。RENDER ONLY：工具在服务器上等结果。
 * 用户填的值直接 POST 到 /api/vault/requests/:id/fill，不经过聊天、不进模型；卡片之后只显示「已存好 · 末四位」。
 */
const parameters = z.object({
  name: z.string().optional(),
  label: z.string().optional(),
  purpose: z.string().optional(),
  domains: z.array(z.string()).optional(),
});

export function VaultTool() {
  useRenderTool({
    name: "vault_request_secret",
    parameters,
    render: ({ parameters: given, status, result }) => (
      <VaultCard
        domains={Array.isArray(given?.domains) ? given.domains.filter((d): d is string => typeof d === "string") : []}
        label={typeof given?.label === "string" ? given.label : ""}
        name={typeof given?.name === "string" ? given.name.toLowerCase() : ""}
        purpose={typeof given?.purpose === "string" ? given.purpose : ""}
        result={typeof result === "string" ? result : undefined}
        running={status !== "complete"}
      />
    ),
  });
  return null;
}

const VaultCard = memo(function VaultCard({
  name,
  label,
  purpose,
  domains,
  running,
  result,
}: {
  name: string;
  label: string;
  purpose: string;
  domains: string[];
  running: boolean;
  result?: string;
}) {
  const queryClient = useQueryClient();
  const request = useQuery(vaultRequestQueryOptions(name, running));
  const [value, setValue] = useState("");
  const pending = request.data?.status === "pending" && running;
  const save = useAsyncAction(
    async () => {
      if (!request.data) throw new Error("请求还没准备好，稍等一下");
      await fillVaultRequest(request.data.id, { value });
      setValue("");
      await queryClient.invalidateQueries({ queryKey: vaultKeys.all });
      await request.refetch();
    },
    { errorToast: (error) => error.message },
  );
  const cancel = useAsyncAction(async () => {
    if (request.data) await cancelVaultRequest(request.data.id);
    await request.refetch();
  });
  const done = request.data?.status === "filled" || (result ? /已把|存进保险箱/.test(result) : false);
  const stopped = !done && (request.data?.status === "cancelled" || request.data?.status === "expired" || (!running && !pending));

  return (
    <div className="vault-card" data-state={done ? "done" : stopped ? "stopped" : "open"}>
      <div className="vault-card-h">
        <span className="vault-card-ico">{done ? <IconCircleCheck className="size-5" /> : stopped ? <IconCircleX className="size-5" /> : <IconLock className="size-5" />}</span>
        <div className="min-w-0 flex-1">
          <div className="vault-card-t">{label || "密钥"}</div>
          <div className="vault-card-s">
            {done
              ? "已加密存进保险箱，机器人看不到值。"
              : stopped
                ? "没有保存。"
                : (purpose ? (/[。.!！?？]$/.test(purpose) ? purpose : `${purpose}。`) : "机器人需要这个密钥才能继续。") + (domains.length ? ` 只会发往 ${domains.join("、")}。` : "")}
          </div>
        </div>
      </div>
      {!done && !stopped ? (
        <form
          className="vault-card-f"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim() && save.state !== "pending") void save.run();
          }}
        >
          <input
            aria-label={label || "密钥"}
            autoComplete="off"
            className="vault-card-in"
            data-1p-ignore
            disabled={!pending}
            onChange={(event) => setValue(event.target.value)}
            placeholder={pending ? "粘贴到这里（不会出现在聊天里）" : "准备中…"}
            spellCheck={false}
            type="password"
            value={value}
          />
          <Button disabled={!pending || !value.trim()} feedback="save" size="sm" state={save.state} type="submit">
            {"保存"}
          </Button>
          <Button disabled={!pending} onClick={() => void cancel.run()} size="sm" type="button" variant="ghost">
            {"取消"}
          </Button>
        </form>
      ) : null}
    </div>
  );
});
