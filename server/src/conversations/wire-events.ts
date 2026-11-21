import { type BaseEvent, EventType, type Message } from "@ag-ui/client";
import { capConnectMessages } from "../../../shared/connect-snapshot";
import { CHISABOT_WAITING_METADATA } from "../approvals/native-context";

/**
 * Cap mid-run `MESSAGES_SNAPSHOT` events to the browser connect window so long threads
 * never blast multi-megabyte full histories onto `chisabot_local_events` or SSE clients.
 * Full authoritative history remains untouched in `chisabot_local_threads.messages`.
 */
export function capMessagesSnapshotEvent<T extends BaseEvent>(event: T): T {
  if (event.type !== EventType.MESSAGES_SNAPSHOT) return event;
  const messages = (event as BaseEvent & { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return event;
  const capped = capConnectMessages(messages as Message[]);
  if (!capped.truncated) return event;
  return {
    ...event,
    messages: capped.messages,
  };
}

function stripWaitingPayload(waiting: unknown): {
  changed: boolean;
  value: unknown;
} {
  if (!waiting || typeof waiting !== "object" || Array.isArray(waiting)) {
    return { changed: false, value: waiting };
  }
  const record = waiting as Record<string, unknown>;
  const continuation = record.continuation;
  if (
    !continuation ||
    typeof continuation !== "object" ||
    Array.isArray(continuation) ||
    !("messages" in continuation)
  ) {
    return { changed: false, value: waiting };
  }
  const { messages: _omitted, ...restContinuation } = continuation as Record<
    string,
    unknown
  >;
  return {
    changed: true,
    value: {
      ...record,
      continuation: restContinuation,
    },
  };
}

/**
 * Strip megabyte `continuation.messages` arrays from waiting events before persisting to
 * `chisabot_local_events` or transmitting to browser SSE clients. In-process headless callers
 * receive the original unstripped event directly on `entry.stream`.
 */
export function stripWaitingContinuationMessages<T extends BaseEvent>(
  event: T,
): T {
  if (event.type === EventType.CUSTOM) {
    const custom = event as BaseEvent & { name?: unknown; value?: unknown };
    if (custom.name !== "chisabot.headless.waiting") return event;
    const stripped = stripWaitingPayload(custom.value);
    if (!stripped.changed) return event;
    return {
      ...event,
      value: stripped.value,
    };
  }
  if (event.type === EventType.RUN_FINISHED) {
    const finished = event as BaseEvent & { outcome?: unknown };
    const outcome = finished.outcome;
    if (
      !outcome ||
      typeof outcome !== "object" ||
      Array.isArray(outcome) ||
      (outcome as { type?: unknown }).type !== "interrupt"
    ) {
      return event;
    }
    const interrupts = (outcome as { interrupts?: unknown }).interrupts;
    if (!Array.isArray(interrupts)) return event;
    let anyChanged = false;
    const nextInterrupts = interrupts.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const interrupt = entry as Record<string, unknown>;
      const metadata = interrupt.metadata;
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        !(CHISABOT_WAITING_METADATA in metadata)
      ) {
        return entry;
      }
      const metaRecord = metadata as Record<string, unknown>;
      const stripped = stripWaitingPayload(
        metaRecord[CHISABOT_WAITING_METADATA],
      );
      if (!stripped.changed) return entry;
      anyChanged = true;
      return {
        ...interrupt,
        metadata: {
          ...metaRecord,
          [CHISABOT_WAITING_METADATA]: stripped.value,
        },
      };
    });
    if (!anyChanged) return event;
    return {
      ...event,
      outcome: {
        ...(outcome as Record<string, unknown>),
        interrupts: nextInterrupts,
      },
    };
  }
  return event;
}

/** Combined wire sanitization for persisted event logs and browser SSE streams. */
export function sanitizeWireEvent<T extends BaseEvent>(event: T): T {
  return stripWaitingContinuationMessages(capMessagesSnapshotEvent(event));
}
