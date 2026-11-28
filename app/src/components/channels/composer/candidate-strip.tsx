import type { ComposerCandidate } from "@/lib/composer/queries";

/**
 * 本地输入候选条：快捷短语与高频习惯，按服务器的排序原样渲染。
 *
 * 呈现在编辑器正上方，点击把整句填进输入框（不发送）。候选条是被动的：
 * 不参与键盘焦点以外的任何输入语义，中文输入法组合期间也只是安静待着——
 * 它从不往里写字，只有人点了才写。
 */

const PREVIEW_MAX = 42;

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

export function CandidateStrip({
  candidates,
  onAccept,
}: {
  candidates: readonly ComposerCandidate[];
  onAccept: (text: string) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div
      aria-label="输入候选"
      className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5"
      role="listbox"
    >
      {candidates.map((candidate) => (
        <button
          aria-label={candidate.text}
          className="max-w-full truncate rounded-full border border-border/60 bg-background/70 px-2.5 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          key={candidate.text}
          onClick={() => onAccept(candidate.text)}
          role="option"
          title={candidate.text}
          type="button"
        >
          {preview(candidate.text)}
        </button>
      ))}
    </div>
  );
}
