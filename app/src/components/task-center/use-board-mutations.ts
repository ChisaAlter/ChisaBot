import { type QueryClient, useMutation } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { ClientError } from "@/lib/client";
import { taskCenterApi, taskCenterKeys } from "@/lib/task-center-api";
import {
  type MarkdownBoardSummary,
  TASK_HORIZON_LABELS,
} from "../../../../shared/task-board-core";
import type { TaskHorizonLane } from "../../../../shared/task-center";

export type DocDraftState = {
  baseRevision: string;
  content: string;
};

export function useBoardMutations({
  queryClient,
  onBoardInitialized,
  onDocSaved,
}: {
  queryClient: QueryClient;
  onBoardInitialized: (board: MarkdownBoardSummary) => void;
  onDocSaved: (cacheKey: string) => void;
}) {
  function handleBoardConflictOrError(
    error: unknown,
    fallback: string,
    boardId?: string,
    includeTaskCenterAll = false,
  ) {
    if (error instanceof ClientError && error.status === 409) {
      toast.info(error.message);
      if (boardId) {
        void queryClient.invalidateQueries({
          queryKey: taskCenterKeys.boardView(boardId),
        });
      }
      if (includeTaskCenterAll) {
        void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
      }
      return;
    }
    toast.error(error instanceof Error ? error.message : fallback);
  }

  const schedulePersonal = useMutation({
    mutationFn: (input: {
      id: string;
      lane: TaskHorizonLane;
      priority: number;
      start?: boolean;
    }) =>
      taskCenterApi.scheduleTask(input.id, {
        lane: input.lane,
        priority: input.priority,
        ...(input.start ? { start: true } : {}),
      }),
    onSuccess: (_res, input) => {
      void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
      toast.success(
        input.start
          ? "已移入「现在」并启动任务"
          : `已安排到「${TASK_HORIZON_LABELS[input.lane]}」`,
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "调整任务泳道失败。");
    },
  });

  const initBoard = useMutation({
    mutationFn: (rootPath: string) => taskCenterApi.initBoard(rootPath),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: taskCenterKeys.boards });
      onBoardInitialized(res.board);
      toast.success(`已初始化本地看板：${res.board.label}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "初始化本地看板失败。");
    },
  });

  const moveMarkdownCard = useMutation({
    mutationFn: (input: {
      boardId: string;
      baseRevision: string;
      cardId: string;
      targetLane: TaskHorizonLane;
      beforeCardId?: string | null;
    }) => taskCenterApi.moveBoardCard(input),
    onSuccess: (res, input) => {
      queryClient.setQueryData(taskCenterKeys.boardView(input.boardId), res);
      toast.success(
        `已移动 ${input.cardId} → ${TASK_HORIZON_LABELS[input.targetLane]}`,
      );
    },
    onError: (err, input) =>
      handleBoardConflictOrError(err, "移动卡片失败。", input.boardId),
  });

  const dispatchCardQuick = useMutation({
    mutationFn: (input: { boardId: string; cardId: string }) =>
      taskCenterApi.dispatchBoardCard({
        boardId: input.boardId,
        cardId: input.cardId,
        executor: "bot",
        level: 3,
        risk: "internal",
        start: true,
      }),
    onSuccess: (res, input) => {
      queryClient.setQueryData(taskCenterKeys.boardView(input.boardId), {
        board: res.board,
      });
      void queryClient.invalidateQueries({ queryKey: taskCenterKeys.all });
      toast.success(`已交给机器人推进 ${input.cardId}`);
    },
    onError: (err, input) =>
      handleBoardConflictOrError(err, "派发卡片失败。", input.boardId, true),
  });

  const saveDoc = useMutation({
    mutationFn: (input: {
      boardId: string;
      baseRevision: string;
      relFile: string;
      content: string;
    }) => taskCenterApi.writeBoardDoc(input),
    onSuccess: (res, input) => {
      onDocSaved(`${input.boardId}:${input.relFile}`);
      queryClient.setQueryData(
        taskCenterKeys.boardDoc(input.boardId, input.relFile),
        res,
      );
      void queryClient.invalidateQueries({
        queryKey: taskCenterKeys.boardView(input.boardId),
      });
      toast.success(`已保存 ${res.doc.name}`);
    },
    onError: (err, input) => {
      if (err instanceof ClientError && err.status === 409) {
        toast.info(err.message);
        void queryClient.invalidateQueries({
          queryKey: taskCenterKeys.boardDoc(input.boardId, input.relFile),
        });
        return;
      }
      toast.error(err instanceof Error ? err.message : "保存文档失败。");
    },
  });

  return {
    schedulePersonal,
    initBoard,
    moveMarkdownCard,
    dispatchCardQuick,
    saveDoc,
  };
}
