import { IconCheck } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import type { MarkdownBoardDocPayload } from "../../../../shared/task-board-core";
import { MarkdownOverlayEditor } from "./markdown-overlay-editor";
import type { DocDraftState } from "./use-board-mutations";

/** 渲染本地 Markdown 看板的 Companion `.md` 在线查看 / CAS 冲突保护编辑面板。 */
export function TaskBoardDocPanel({
  boardId,
  activeDocRelFile,
  isLoading,
  docPayload,
  activeDraft,
  isSaving,
  onChangeDraft,
  onDiscardDraft,
  onSaveWithRevision,
}: {
  boardId: string;
  activeDocRelFile: string;
  isLoading: boolean;
  docPayload: MarkdownBoardDocPayload | undefined;
  activeDraft: DocDraftState | undefined;
  isSaving: boolean;
  onChangeDraft: (baseRevision: string, nextContent: string) => void;
  onDiscardDraft: () => void;
  onSaveWithRevision: (baseRevision: string, content: string) => void;
}) {
  const editorValue =
    docPayload && activeDraft ? activeDraft.content : (docPayload?.content ?? "");
  const isDocDirty = Boolean(
    docPayload && activeDraft && activeDraft.content !== docPayload.content,
  );
  const hasExternalDocUpdate = Boolean(
    docPayload &&
      activeDraft &&
      activeDraft.baseRevision !== docPayload.revision,
  );
  const normalBaseRevision =
    activeDraft?.baseRevision ?? docPayload?.revision ?? "";

  function submitNormalSave() {
    if (!docPayload?.writable || !isDocDirty) return;
    onSaveWithRevision(normalBaseRevision, editorValue);
  }

  return (
    <section className="tc-board-doc-panel" data-board-id={boardId}>
      {isLoading ? (
        <div className="tc-empty">{`正在读取 ${activeDocRelFile}…`}</div>
      ) : docPayload ? (
        <>
          <div className="tc-board-doc-bar">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{docPayload.relFile}</span>
              <span>{`版本 ${docPayload.revision.slice(0, 8)}`}</span>
              {isDocDirty ? (
                <span className="tc-chip" data-dirty="true">
                  {"未保存"}
                </span>
              ) : null}
              {hasExternalDocUpdate ? (
                <>
                  <Button
                    onClick={onDiscardDraft}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {"外部已更新 · 放弃本地草稿并重载"}
                  </Button>
                  {docPayload.writable ? (
                    <Button
                      disabled={isSaving}
                      onClick={() =>
                        onSaveWithRevision(docPayload.revision, editorValue)
                      }
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {"用当前草稿覆盖外部版本"}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
            {docPayload.writable ? (
              <div className="flex items-center gap-2">
                {isDocDirty ? (
                  <Button
                    onClick={onDiscardDraft}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {"撤销修改"}
                  </Button>
                ) : null}
                <Button
                  disabled={!isDocDirty || isSaving}
                  onClick={submitNormalSave}
                  size="sm"
                  type="button"
                >
                  <IconCheck aria-hidden className="size-3.5" />
                  {"保存文档"}
                </Button>
              </div>
            ) : null}
          </div>
          <MarkdownOverlayEditor
            ariaLabel={`编辑看板文档 ${docPayload.name}`}
            minRows={18}
            onChange={(nextContent) =>
              onChangeDraft(
                activeDraft?.baseRevision ?? docPayload.revision,
                nextContent,
              )
            }
            onSave={submitNormalSave}
            readOnly={!docPayload.writable}
            value={editorValue}
          />
        </>
      ) : (
        <div className="tc-empty">{"无法读取该文档内容。"}</div>
      )}
    </section>
  );
}
