import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  recordingSupported,
  speechRecognitionSupported,
  startRecording,
  startSpeechRecognitionRecording,
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
  const serverTranscriptionRef = useRef(false);
  serverTranscriptionRef.current = data?.transcription === true;
  const [session] = useState(
    () =>
      new DictationSession({
        record: (onError) =>
          !serverTranscriptionRef.current && speechRecognitionSupported()
            ? startSpeechRecognitionRecording(onError)
            : startRecording(onError),
        transcribe: transcribeRecording,
        onTranscript: (text, intent) => onTranscriptRef.current(text, intent),
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const browserSpeech = speechRecognitionSupported();
  const available = data?.transcription === true || browserSpeech;
  useEffect(() => {
    if (disabled || !available) session.cancel();
    return () => session.cancel();
  }, [disabled, available, session]);
  return {
    session,
    state,
    available,
    supported: recordingSupported() || browserSpeech,
    busy: state.phase !== "idle",
  };
}
