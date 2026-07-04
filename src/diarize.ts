// Frontend diarization state + actions (item 6a, increment 4). Drives the
// "Detect speakers" flow: run the backend `diarize` command over the current
// transcript, offer the one-time model download when they're missing, and hold
// editable speaker names. Speaker assignments live on the segments themselves
// (Segment.speaker); this module owns the UI state around them.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { unwrap } from "solid-js/store";

import {
  currentSource,
  type Segment,
  setTranscript,
  transcript,
} from "./transcription";

export type DiarizeStatus =
  | "idle"
  | "running"
  | "need-models"
  | "downloading"
  | "error";

const DIARIZE_MODELS_MISSING = "DIARIZE_MODELS_MISSING|";

export const [diarizeStatus, setDiarizeStatus] =
  createSignal<DiarizeStatus>("idle");
export const [diarizeError, setDiarizeError] = createSignal("");
export const [diarizeModelsDir, setDiarizeModelsDir] = createSignal("");
export const [downloadInfo, setDownloadInfo] = createSignal<{
  label: string;
  percent: number | null;
  step: number;
  steps: number;
} | null>(null);

// Custom speaker names, keyed by speaker index. Falls back to "Speaker N".
export const [speakerNames, setSpeakerNames] = createSignal<
  Record<number, string>
>({});

export function speakerLabel(idx: number): string {
  return speakerNames()[idx]?.trim() || `Speaker ${idx + 1}`;
}

export function renameSpeaker(idx: number, name: string) {
  setSpeakerNames((prev) => ({ ...prev, [idx]: name }));
}

/** Distinct speaker indices present in the current transcript, ascending. */
export function speakers(): number[] {
  const set = new Set<number>();
  for (const s of transcript.segments) {
    if (s.speaker != null) set.add(s.speaker);
  }
  return [...set].sort((a, b) => a - b);
}

export function hasSpeakers(): boolean {
  return speakers().length > 0;
}

// Stable per-speaker palette. MUST stay in sync with SPEAKER_PALETTE in
// src-tauri/src/subtitles.rs so the live preview and the ASS burn-in agree on
// each speaker's color. Speaker 1/2 are the Smith cyan/violet accents.
const SPEAKER_PALETTE = [
  "#45f2f2",
  "#a974ff",
  "#ffd24d",
  "#6ee27a",
  "#ff7a7a",
  "#7ab8ff",
  "#ff9de0",
  "#ffa94d",
];

/** A stable hex color per speaker index (chips, preview, and — matched in Rust —
 *  the ASS burn-in). */
export function speakerColor(idx: number): string {
  return SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length];
}

/** Move a segment to a different speaker. */
export function reassignSpeaker(segIndex: number, speaker: number) {
  setTranscript("segments", segIndex, "speaker", speaker);
}

/** Called when a new video loads: clear speaker state (segments are cleared
 *  separately by setSource). */
export function resetDiarization() {
  setDiarizeStatus("idle");
  setDiarizeError("");
  setDownloadInfo(null);
  setSpeakerNames({});
}

export async function runDetectSpeakers() {
  const src = currentSource();
  if (!src || diarizeStatus() === "running") return;
  setDiarizeStatus("running");
  setDiarizeError("");
  try {
    // Diarization aligns onto the current (edited) segments and returns them
    // with `speaker` set; word timings etc. are preserved.
    const segments = unwrap(transcript).segments;
    const result = await invoke<Segment[]>("diarize", { src, segments });
    setTranscript("segments", result);
    setDiarizeStatus("idle");
  } catch (e) {
    const msg = String(e);
    if (msg.startsWith(DIARIZE_MODELS_MISSING)) {
      setDiarizeModelsDir(msg.slice(DIARIZE_MODELS_MISSING.length));
      setDiarizeStatus("need-models");
    } else if (msg === "cancelled") {
      setDiarizeStatus("idle");
    } else {
      setDiarizeError(msg);
      setDiarizeStatus("error");
    }
  }
}

export async function downloadDiarizationModels() {
  if (diarizeStatus() === "downloading") return;
  setDiarizeStatus("downloading");
  setDiarizeError("");
  setDownloadInfo({ label: "Preparing…", percent: null, step: 0, steps: 2 });

  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<{
      file: string;
      percent: number | null;
      step: number;
      steps: number;
    }>("diarization-download-progress", (e) => {
      setDownloadInfo({
        label: e.payload.file,
        percent: e.payload.percent,
        step: e.payload.step,
        steps: e.payload.steps,
      });
    });
    await invoke("download_diarization_models");
    setDownloadInfo(null);
    setDiarizeStatus("idle");
    // Models are ready — run detection straight away.
    await runDetectSpeakers();
  } catch (e) {
    const msg = String(e);
    setDownloadInfo(null);
    if (msg === "cancelled") {
      setDiarizeStatus("need-models");
    } else {
      setDiarizeError(msg);
      setDiarizeStatus("error");
    }
  } finally {
    unlisten?.();
  }
}

export async function cancelDetect() {
  await invoke("cancel_diarize");
}

export async function cancelDiarizationDownload() {
  await invoke("cancel_diarization_download");
}
