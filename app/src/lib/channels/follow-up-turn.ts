/**
 * The follow-up wake message's reader, re-exported from the one place it is declared.
 *
 * See `routine-firing.ts` beside this file: the server builds the message from `shared/`, and the
 * browser keeps importing through `@/`.
 */

export type { WakeUpTurn } from "../../../../shared/follow-up-turn";
export { readWakeUpTurn } from "../../../../shared/follow-up-turn";
