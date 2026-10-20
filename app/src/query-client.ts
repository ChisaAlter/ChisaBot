import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // 数据保鲜 30 秒：切页面、开关弹窗导致组件重挂载时不再重复请求服务端。
      // 需要实时性的页面可单独覆盖为 0。
      staleTime: 30_000,
    },
  },
});
