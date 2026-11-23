import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  type BusySendMode,
  setBusySendMode,
  useBusySendMode,
} from "@/lib/conversations/send-mode";

const OPTIONS: readonly { value: BusySendMode; label: string }[] = [
  { value: "steer", label: "立即插话引导" },
  { value: "queue", label: "排到下一轮" },
];

export function BusySendModePreference() {
  const mode = useBusySendMode();

  const onGroupKeyDown = (event: React.KeyboardEvent<HTMLFieldSetElement>) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown"
    ) {
      return;
    }
    event.preventDefault();
    const next: BusySendMode = mode === "steer" ? "queue" : "steer";
    setBusySendMode(next);
    const buttons =
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[next === "steer" ? 0 : 1]?.focus();
  };

  return (
    <Item
      data-setting-item="general.busy-send-mode 回复中途发消息默认方式 回复中途发消息"
      size="sm"
    >
      <ItemContent>
        <ItemTitle>{"回复中途发消息"}</ItemTitle>
        <ItemDescription>
          {
            "AI 正在回复时按 Enter 的默认行为；按 Ctrl/Cmd + Enter 可临时切换为另一种。"
          }
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <fieldset
          aria-label={"回复中途发消息默认方式"}
          className="sg-segmented m-0 min-w-0"
          data-surface="inset"
          onKeyDown={onGroupKeyDown}
        >
          {OPTIONS.map(({ value, label }) => (
            <button
              aria-pressed={mode === value}
              className="sg-segmented-item"
              data-testid={`busy-send-mode-${value}`}
              key={value}
              onClick={() => setBusySendMode(value)}
              tabIndex={mode === value ? 0 : -1}
              type="button"
            >
              {label}
            </button>
          ))}
        </fieldset>
      </ItemActions>
    </Item>
  );
}
