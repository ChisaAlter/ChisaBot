import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useRailTasksSummary } from "@/components/panels/tasks-rail-card";
import { taskCenterKeys } from "@/lib/task-center-api";
import { workflowKeys } from "@/lib/workflows";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  await GlobalRegistrator.unregister();
});
afterEach(cleanup);

describe("tasks-rail-card 空值与缺失字段防护", () => {
  test("task-center 与 workflows 返回空对象 {} 时不抛 TypeError，安全回落 0 计数", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    queryClient.setQueryData(taskCenterKeys.snapshot, {} as never);
    queryClient.setQueryData(workflowKeys.library, {} as never);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useRailTasksSummary(false), {
      wrapper,
    });

    expect(result.current.pendingDecisions).toEqual([]);
    expect(result.current.activeTasks).toEqual([]);
    expect(result.current.activeRuns).toEqual([]);
    expect(result.current.approvalCount).toBe(0);
    expect(result.current.activeCount).toBe(0);
  });
});
