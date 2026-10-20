import { IconArrowLeft, IconFile, IconFolder, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type CcRef, ccDiffQueryOptions, ccFileQueryOptions, ccFilesQueryOptions } from "@/lib/cloud-cc";
import { cn } from "@/lib/utils";
import { T } from "@/components/ui/button";
import { useSegmentedKeys } from "@/components/ui/segmented";

export type RightTab = "changes" | "files";

/** unified diff 按文件切开（`diff --git a/x b/x` 开头）。 */
function splitPatch(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = patch.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (m) map.set(m[2]!, chunk);
  }
  return map;
}

/** 加行绿、删行红、@@ 灰，带新文件的行号（DESIGN.md §73.3）。 */
function DiffView({ patch }: { patch: string }) {
  const rows = useMemo(() => {
    const out: { cls: string; no: string; text: string }[] = [];
    let newNo = 0;
    for (const line of patch.split("\n").slice(0, 4000)) {
      if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(line)) continue;
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) {
        newNo = Number(hunk[1]);
        out.push({ cls: "is-hunk", no: "", text: line });
      } else if (line.startsWith("+")) out.push({ cls: "is-add", no: String(newNo++), text: line });
      else if (line.startsWith("-")) out.push({ cls: "is-del", no: "", text: line });
      else if (line.startsWith("\\")) continue;
      else if (line || newNo) out.push({ cls: "", no: String(newNo++), text: line });
    }
    return out;
  }, [patch]);
  if (!rows.length) return <div className="cc-rp-empty">{"没有文字改动（可能是二进制文件）。"}</div>;
  return (
    <pre className="cc-diff" data-testid="cc-diff">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: diff 行没有稳定 id
        <span className={cn("cc-diff-row", r.cls)} key={i}>
          <span className="cc-diff-no">{r.no}</span>
          <span className="cc-diff-tx">{r.text || " "}</span>
        </span>
      ))}
    </pre>
  );
}

/** 右栏里的第二层小分段（P3：「这一轮｜相对 main」「会话目录｜工作目录」）。 */
function SubSwitch<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  // 分段选择的键盘约定（2026-10-20）：roving tabindex + 方向键换项。
  const keys = useSegmentedKeys<T>({ value, values: options.map((o) => o.id), onChange });
  return (
    <div aria-label={label} className="cc-subseg" {...keys.groupProps} ref={keys.groupRef} role="radiogroup">
      {options.map((o) => (
        <button aria-checked={value === o.id} data-testid={`cc-sub-${o.id}`} key={o.id} onClick={() => onChange(o.id)} role="radio" tabIndex={keys.itemTabIndex(o.id)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChangesTab({ sessionId, turnId, enabled, base }: { sessionId: string; turnId: string | null; enabled: boolean; base: string | null }) {
  const [mode, setMode] = useState<"turn" | "base">("turn");
  // 从改动卡点「看 diff」进来：回到「这一轮」
  useEffect(() => {
    if (turnId) setMode("turn");
  }, [turnId]);
  const effective = base ? mode : "turn";
  const diff = useQuery(ccDiffQueryOptions(sessionId, turnId, enabled, effective));
  const [selected, setSelected] = useState<string | null>(null);
  const byFile = useMemo(() => splitPatch(diff.data?.patch ?? ""), [diff.data?.patch]);
  const head = (
    <div className="cc-rp-sub">
      {base ? (
        <SubSwitch
          label="看哪些改动"
          onChange={(v) => {
            setMode(v);
            setSelected(null);
          }}
          options={[
            { id: "turn", label: "这一轮" },
            { id: "base", label: `相对 ${base}` },
          ]}
          value={effective}
        />
      ) : (
        <span>{"这一轮"}</span>
      )}
      <button aria-label="刷新" className="cc-icon-btn" onClick={() => void diff.refetch()} type="button">
        <IconRefresh className="size-3.5" />
      </button>
    </div>
  );
  if (diff.isPending)
    return (
      <div className="cc-rp-changes">
        {head}
        <div className="cc-rp-empty">{"读取改动…"}</div>
      </div>
    );
  if (diff.isError)
    return (
      <div className="cc-rp-changes">
        {head}
        <div className="cc-rp-empty is-err">{diff.error.message}</div>
      </div>
    );
  const files = diff.data.files;
  if (!files.length)
    return (
      <div className="cc-rp-changes">
        {head}
        <div className="cc-rp-empty">{effective === "base" ? `和 ${base} 一样，还没有改动。` : "这一轮没有改文件。"}</div>
      </div>
    );
  const current = selected && byFile.has(selected) ? selected : files[0]!.path;
  return (
    <div className="cc-rp-changes">
      {head}
      {effective === "base" ? (
        <div className="cc-rp-note" data-testid="cc-base-note">{`${files.length} 个文件${diff.data.commits ? ` · ${diff.data.commits} 个提交` : ""} · 含还没提交的改动`}</div>
      ) : null}
      <div className="cc-rp-files" role="listbox">
        {files.map((f) => (
          <button aria-selected={f.path === current} className="cc-rp-file" data-testid="cc-rp-file" key={f.path} onClick={() => setSelected(f.path)} role="option" type="button">
            <i aria-hidden className={cn("cc-file-mark", f.status === "A" ? "is-add" : f.status === "D" ? "is-del" : "is-mod")} />
            <span className="cc-rp-file-p">{f.path}</span>
            <span className="cc-plus">{f.add === null ? "" : `+${f.add}`}</span>
            <span className="cc-minus">{f.del === null ? "" : `−${f.del}`}</span>
          </button>
        ))}
      </div>
      <DiffView patch={byFile.get(current) ?? ""} />
    </div>
  );
}

function FilesTab({ sessionId, enabled, base }: { sessionId: string; enabled: boolean; base: string | null }) {
  const [ref, setRef] = useState<CcRef>("session");
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const list = useQuery(ccFilesQueryOptions(sessionId, dir, enabled && !file, ref));
  const content = useQuery(ccFileQueryOptions(sessionId, file ?? "", enabled && !!file, ref));
  if (file)
    return (
      <div className="cc-rp-viewer">
        <div className="cc-rp-sub">
          <button className="cc-crumb" onClick={() => setFile(null)} type="button">
            <IconArrowLeft className="size-3.5" />
            {file}
          </button>
          <span className="cc-ro">{"只读"}</span>
        </div>
        {content.isPending ? (
          <div className="cc-rp-empty">{"读取中…"}</div>
        ) : content.isError ? (
          <div className="cc-rp-empty is-err">{content.error.message}</div>
        ) : content.data.tooLarge ? (
          <div className="cc-rp-empty">{"文件超过 1 MB，不在这里显示。"}</div>
        ) : content.data.binary ? (
          <div className="cc-rp-empty">{"二进制文件。"}</div>
        ) : (
          <pre className="cc-code-view" data-testid="cc-file-view">
            {(content.data.text ?? "").split("\n").map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 行号就是 key
              <span className="cc-diff-row" key={i}>
                <span className="cc-diff-no">{i + 1}</span>
                <span className="cc-diff-tx">{line || " "}</span>
              </span>
            ))}
          </pre>
        )}
      </div>
    );
  return (
    <div className="cc-rp-tree">
      {base ? (
        <div className="cc-rp-sub">
          <SubSwitch
            label="看哪一份"
            onChange={(v) => {
              setRef(v);
              setDir("");
            }}
            options={[
              { id: "session", label: "会话目录" },
              { id: "work", label: "工作目录" },
            ]}
            value={ref}
          />
        </div>
      ) : null}
      <div className="cc-rp-sub">
        {dir ? (
          <button className="cc-crumb" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))} type="button">
            <IconArrowLeft className="size-3.5" />
            {dir}
          </button>
        ) : (
          <span>{ref === "work" ? `工作目录 · ${base ?? ""}` : "会话目录"}</span>
        )}
        <button aria-label="刷新" className="cc-icon-btn" onClick={() => void list.refetch()} type="button">
          <IconRefresh className="size-3.5" />
        </button>
      </div>
      {list.isPending ? (
        <div className="cc-rp-empty">{"读取中…"}</div>
      ) : list.isError ? (
        <div className="cc-rp-empty is-err">{list.error.message}</div>
      ) : list.data.entries.length === 0 ? (
        <div className="cc-rp-empty">{"还是空的。让 Claude 写点东西吧。"}</div>
      ) : (
        list.data.entries.map((e) => (
          <button className="cc-rp-entry" data-testid="cc-rp-entry" key={e.name} onClick={() => (e.dir ? setDir(dir ? `${dir}/${e.name}` : e.name) : setFile(dir ? `${dir}/${e.name}` : e.name))} type="button">
            {e.dir ? <IconFolder className="size-4 flex-none opacity-70" /> : <IconFile className="size-4 flex-none opacity-60" />}
            <span className="cc-rp-entry-n">{e.name}</span>
            {e.size !== null ? <span className="cc-rp-entry-s">{e.size < 1024 ? `${e.size} B` : `${(e.size / 1024).toFixed(1)} KB`}</span> : null}
          </button>
        ))
      )}
    </div>
  );
}

/** 右栏（桌面）/ 底部抽屉（手机）的内容：分段「改动｜文件」，只读（§11 决定 3）。 */
export function CcRightContent({
  sessionId,
  tab,
  onTab,
  turnId,
  enabled,
  base = null,
}: {
  sessionId: string;
  tab: RightTab;
  onTab: (t: RightTab) => void;
  turnId: string | null;
  enabled: boolean;
  /** GitHub 工作区：目标分支（多出「相对 main」「工作目录」两个视图）；草稿工作区是 null。 */
  base?: string | null;
}) {
  // 分段选择的键盘约定（2026-10-20）：roving tabindex + 方向键在「改动｜文件」之间换。
  const tabKeys = useSegmentedKeys<RightTab>({ value: tab, values: ["changes", "files"], onChange: onTab });
  return (
    <div className="cc-rp-body">
      <div aria-label="右栏内容" className="sg-segmented cc-rp-seg" {...tabKeys.groupProps} ref={tabKeys.groupRef} role="radiogroup">
        <button aria-checked={tab === "changes"} className="sg-segmented-item" data-testid="cc-tab-changes" onClick={() => onTab("changes")} role="radio" tabIndex={tabKeys.itemTabIndex("changes")} type="button">
          <T>{"改动"}</T>
        </button>
        <button aria-checked={tab === "files"} className="sg-segmented-item" data-testid="cc-tab-files" onClick={() => onTab("files")} role="radio" tabIndex={tabKeys.itemTabIndex("files")} type="button">
          <T>{"文件"}</T>
        </button>
      </div>
      {tab === "changes" ? <ChangesTab base={base} enabled={enabled} sessionId={sessionId} turnId={turnId} /> : <FilesTab base={base} enabled={enabled} sessionId={sessionId} />}
    </div>
  );
}
