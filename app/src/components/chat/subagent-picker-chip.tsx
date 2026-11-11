import { Popover } from "@base-ui/react/popover";
import {
  IconCheck,
  IconDeviceDesktop,
  IconRobot,
  IconServer,
  IconX,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";
import {
  AGENT_DRIVER_SPECS,
  type AgentInstanceView,
  SERVER_ENVIRONMENT_ID,
  useAgentInstances,
} from "@/lib/local-agents";
import { cn } from "@/lib/utils";

function SubagentPickerChipImpl({
  selectedId,
  onSelect,
  disabled = false,
}: {
  selectedId: string | null;
  onSelect: (instanceId: string | null) => void;
  disabled?: boolean;
}) {
  const instancesQuery = useAgentInstances();
  const [open, setOpen] = useState(false);

  const enabledInstances: AgentInstanceView[] = (
    instancesQuery.data ?? []
  ).filter((inst) => inst.enabled);

  if (enabledInstances.length === 0 && !selectedId) {
    return null;
  }

  const activeInstance = selectedId
    ? ((instancesQuery.data ?? []).find((inst) => inst.id === selectedId) ??
      null)
    : null;

  return (
    <span className="inline-flex items-center gap-0.5">
      <Popover.Root onOpenChange={setOpen} open={open}>
        <Popover.Trigger
          aria-label={
            activeInstance
              ? `当前直连子代理：${activeInstance.name}`
              : "选择直连子代理"
          }
          className={cn("perm-chip", activeInstance ? "is-full" : "is-ask")}
          data-testid="subagent-picker-chip"
          disabled={disabled}
          title={
            activeInstance
              ? `当前消息将直接交给子代理「${activeInstance.name}」（${activeInstance.environmentName}）执行`
              : "选择子代理直连执行（也可在输入框键入 @智能体名 点名调用）"
          }
          type="button"
        >
          <IconRobot className="perm-chip-icon" />
          <span className="perm-chip-label">
            {activeInstance ? `@${activeInstance.name}` : "子代理"}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            align="start"
            className="isolate z-50"
            side="top"
            sideOffset={8}
          >
            <Popover.Popup
              aria-label="选择子代理"
              className="perm-popover min-w-[260px]"
              data-testid="subagent-picker-popover"
            >
              <div className="perm-popover-head">
                <span className="perm-popover-title">{"直连子代理调用"}</span>
                <Link
                  className="perm-popover-more"
                  onClick={() => setOpen(false)}
                  to="/settings/agent-providers"
                >
                  {"管理提供方"}
                </Link>
              </div>
              <div className="perm-popover-list" role="menu">
                <button
                  aria-checked={!selectedId}
                  className={cn("perm-option is-ask", !selectedId && "is-on")}
                  onClick={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                  role="menuitemradio"
                  type="button"
                >
                  <IconRobot className="perm-option-icon" />
                  <span className="flex min-w-0 flex-1 flex-col text-left">
                    <span className="text-xs font-medium">
                      {"由主机器人回答（默认）"}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {"正常对话，主机器人可按需自动把子代理当工具派发任务"}
                    </span>
                  </span>
                  {!selectedId ? (
                    <IconCheck className="size-3.5 shrink-0" />
                  ) : null}
                </button>

                {enabledInstances.map((inst) => {
                  const on = inst.id === selectedId;
                  const spec = AGENT_DRIVER_SPECS[inst.driver];
                  return (
                    <button
                      aria-checked={on}
                      className={cn("perm-option is-ask", on && "is-on")}
                      key={inst.id}
                      onClick={() => {
                        onSelect(inst.id);
                        setOpen(false);
                      }}
                      role="menuitemradio"
                      type="button"
                    >
                      {inst.environmentId === SERVER_ENVIRONMENT_ID ? (
                        <IconServer className="perm-option-icon" />
                      ) : (
                        <IconDeviceDesktop className="perm-option-icon" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col text-left">
                        <span className="flex items-center gap-1.5 text-xs font-medium">
                          <span className="truncate">{inst.name}</span>
                          <span className="rounded bg-muted px-1 py-0.2 text-[10px] text-muted-foreground">
                            {spec.label}
                          </span>
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {`${inst.environmentName} · ${inst.environmentOnline ? "在线" : "离线"}`}
                        </span>
                      </span>
                      {on ? <IconCheck className="size-3.5 shrink-0" /> : null}
                    </button>
                  );
                })}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {activeInstance ? (
        <button
          aria-label="取消子代理直连"
          className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onSelect(null)}
          title="切回主机器人回答"
          type="button"
        >
          <IconX className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export const SubagentPickerChip = memo(SubagentPickerChipImpl);
