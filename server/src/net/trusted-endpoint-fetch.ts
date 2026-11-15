export type TrustedEndpointPurpose =
  | "model-provider"
  | "agent-computer"
  | "picked-harness"
  | "ag-ui-stream";

/**
 * 面向已配置可信后端（模型提供商、本机/内网计算机控制服务、Picked/AG-UI 运行时）的统一出网入口。
 * 与访问外部不可信 URL 的 `guardedFetch` 明确分流，禁止在业务模块中散落裸 `fetch(` 调用。
 */
export function trustedEndpointFetch(
  _purpose: TrustedEndpointPurpose,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}
