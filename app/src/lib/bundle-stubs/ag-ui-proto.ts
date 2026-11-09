/*
 * 构建时替换 @ag-ui/proto（DESIGN.md §41.4）。
 *
 * @ag-ui/client 只在服务器回 `content-type: application/vnd.ag-ui.event+proto` 时才解 protobuf，
 * 但它自己发请求时只要 `Accept: text/event-stream`，会话客户端 运行时就按 SSE 回，所以浏览器里从不走 protobuf。
 * 真身（@ag-ui/proto + @bufbuild/protobuf，约 190KB 未压缩）一直在首屏包里。万一服务器真回了 protobuf，
 * 这里给出明确的错误而不是悄悄吞掉。
 */
export const AGUI_MEDIA_TYPE = "application/vnd.ag-ui.event+proto";

export class AGUIUnknownEventTypeError extends Error {}

export function decode(): never {
  throw new Error("[ChisaBot] 浏览器端不支持 protobuf 事件流（只接受 SSE）。");
}
export function encode(): never {
  throw new Error("[ChisaBot] 浏览器端不支持 protobuf 事件流（只接受 SSE）。");
}
