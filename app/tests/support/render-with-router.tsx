import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";

export interface RenderWithRouterOptions {
  initialEntry?: string;
  queryClient?: QueryClient;
}

export async function renderWithRouter(
  node: ReactNode,
  options: RenderWithRouterOptions = {},
): Promise<RenderResult & { queryClient: QueryClient }> {
  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => node,
    }),
    history: createMemoryHistory({
      initialEntries: [options.initialEntry ?? "/"],
    }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
