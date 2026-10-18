import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditInitiator } from "../audit";

/**
 * 确认卡片要知道「这是哪段对话里的哪个工具调用」，卡片才能画在那条工具调用下面。
 *
 * - 回合：local-conversations.ts 在跑机器人时包一层（对话 id、这一轮是不是被用户停了）。
 * - 工具调用：copilot.ts 执行内置机器人的工具时包一层（AI SDK 给的 toolCallId）。
 */
export type ConfirmTurn = { threadId: string; runId: string; stopped: () => boolean };
const turns = new AsyncLocalStorage<ConfirmTurn>();
const calls = new AsyncLocalStorage<{ toolCallId: string; toolName: string }>();

export const withConfirmTurn = <T>(turn: ConfirmTurn, run: () => T): T => turns.run(turn, run);
export const currentConfirmTurn = () => turns.getStore();
export const withConfirmToolCall = <T>(toolCallId: string | undefined, toolName: string, run: () => T): T =>
  toolCallId ? calls.run({ toolCallId, toolName }, run) : run();
export const currentConfirmToolCall = () => calls.getStore();

/** 这次工具调用是不是网页聊天里的（设备 hub 据此决定要不要在聊天里也出卡片）。由 confirmations.wrap 包上。 */
const interactiveCalls = new AsyncLocalStorage<boolean>();
export const withConfirmInteractive = <T>(interactive: boolean, run: () => T): T => interactiveCalls.run(interactive, run);
export const currentConfirmInteractive = () => interactiveCalls.getStore() === true;

/**
 * 云端浏览器工具（computer/headless-tools.ts）是谁发起的：网页聊天、定时任务、面板刷新……
 * 网页上点「发送 / 删除」时（confirmations.pageAction）据此决定能不能在聊天里出卡片。
 */
const computerActors = new AsyncLocalStorage<{ initiator?: AuditInitiator }>();
export const withConfirmActor = <T>(initiator: AuditInitiator | undefined, run: () => T): T => computerActors.run({ ...(initiator ? { initiator } : {}) }, run);
export const currentConfirmActor = () => computerActors.getStore();

/**
 * 这一轮工具执行的取消信号（FIX-04）：用户按「停止」时 abort，web_search / 浏览器长操作应立刻停。
 * local-conversations 在跑回合时挂上；copilot 执工具前检查。
 */
const toolAborts = new AsyncLocalStorage<AbortSignal>();
export const withToolAbort = <T>(signal: AbortSignal, run: () => T): T => toolAborts.run(signal, run);
export const currentToolAbort = () => toolAborts.getStore();

export const TOOL_STOPPED_ZH = "用户已停止这一轮，这一步没有执行。";
