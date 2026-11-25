import { useQuery } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import { useExternalConnection } from "@/hooks";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  recordingSupported,
  startRecording,
  transcribeRecording,
} from "@/lib/dictation/recording";
import {
  type DictationIntent,
  DictationSession,
} from "@/lib/dictation/session";
import { queryClient } from "@/query-client";

export function useDictation(
  onTranscript: (text: string, intent: DictationIntent) => void,
  disabled: boolean,
) {
  const { data } = useQuery(
    { ...deploymentCapabilitiesQueryOptions(), enabled: !disabled },
    queryClient,
  );
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const [session] = useState(
    () =>
      new DictationSession({
        record: (onError) => startRecording(onError),
        transcribe: transcribeRecording,
        onTranscript: (text, intent) => onTranscriptRef.current(text, intent),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const available = data?.transcription === true;
  useExternalConnection(!disabled && available, () => () => session.cancel());
  return {
    session,
    state,
    available,
    supported: recordingSupported(),
    busy: state.phase !== "idle",
  };
}
