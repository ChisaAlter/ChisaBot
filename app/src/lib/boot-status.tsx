import { useExternalConnection } from "@/hooks";

/** The classic HTML guard owns reporting; a missing guard must never affect React. */
export function reportBootStage(stage: "entry-executing" | "react-mounted") {
  try {
    window.dispatchEvent(
      new CustomEvent("chisabot-boot-stage", { detail: stage }),
    );
  } catch {}
}

export function BootCommitMarker() {
  useExternalConnection(true, () => {
    reportBootStage("react-mounted");
  });
  return null;
}
