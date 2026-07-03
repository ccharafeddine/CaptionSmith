// Shared transcription state + actions. Single source of truth so the
// transcript editor, the caption overlay, and the style panel all read the same
// segments. (Single-window app, so a module-level store is appropriate.)

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Word = { start: number; end: number; text: string };
export type Segment = { start: number; end: number; text: string; words?: Word[] };
export type ModelInfo = {
  name: string;
  label: string;
  multilingual: boolean;
  is_default: boolean;
};
export type Status =
  | "idle"
  | "extracting"
  | "transcribing"
  | "done"
  | "error"
  | "model-missing";

const MODEL_NOT_FOUND = "MODEL_NOT_FOUND|";

// The transcript: segments are edited in place by the transcript panel and read
// by the caption overlay.
export const [transcript, setTranscript] = createStore<{ segments: Segment[] }>({
  segments: [],
});

export const [status, setStatus] = createSignal<Status>("idle");
export const [percent, setPercent] = createSignal<number | null>(null);
export const [errorMsg, setErrorMsg] = createSignal("");
export const [modelDir, setModelDir] = createSignal("");
// Whether the current transcript carries word-level timings (for karaoke).
export const [hasWords, setHasWords] = createSignal(false);

export const [models, setModels] = createSignal<ModelInfo[]>([]);
export const [modelName, setModelName] = createSignal("");
export const [language, setLanguage] = createSignal("auto");
export const [translate, setTranslate] = createSignal(false);

let currentSrc = "";

export function isBusy(): boolean {
  return status() === "extracting" || status() === "transcribing";
}

export function multilingualSelected(): boolean {
  return models().find((m) => m.name === modelName())?.multilingual ?? false;
}

/** Called when a new video loads: clear the transcript, keep model/lang choices. */
export function setSource(src: string) {
  currentSrc = src;
  setTranscript("segments", []);
  setStatus("idle");
  setPercent(null);
  setErrorMsg("");
  setHasWords(false);
}

export async function loadModels() {
  try {
    const list = await invoke<ModelInfo[]>("list_models");
    setModels(list);
    if (!modelName()) {
      const def = list.find((m) => m.is_default) ?? list[0];
      if (def) setModelName(def.name);
    }
  } catch {
    /* leave empty; a transcribe attempt will surface a clear error */
  }
}

export async function runTranscribe(wordTimestamps: boolean) {
  if (isBusy() || !currentSrc) return;
  const hadSegments = transcript.segments.length > 0;
  setStatus("extracting");
  setPercent(null);
  setErrorMsg("");

  const unlisten: UnlistenFn[] = [];
  try {
    unlisten.push(
      await listen<{ percent: number | null }>("extract-progress", (e) => {
        if (status() === "extracting") setPercent(e.payload.percent);
      }),
    );
    unlisten.push(
      await listen<{ percent: number }>("transcribe-progress", (e) => {
        setStatus("transcribing");
        setPercent(e.payload.percent);
      }),
    );

    const multi = multilingualSelected();
    const result = await invoke<Segment[]>("transcribe", {
      src: currentSrc,
      language: multi ? language() : null,
      translate: multi && translate(),
      wordTimestamps,
      model: modelName() || null,
    });
    setTranscript("segments", result);
    setHasWords(wordTimestamps);
    setStatus("done");
  } catch (e) {
    const msg = String(e);
    if (msg === "cancelled") {
      // Keep any prior transcript on a cancelled re-run.
      setStatus(hadSegments ? "done" : "idle");
    } else if (msg.startsWith(MODEL_NOT_FOUND)) {
      setModelDir(msg.slice(MODEL_NOT_FOUND.length));
      setStatus("model-missing");
    } else {
      setErrorMsg(msg);
      setStatus("error");
    }
  } finally {
    unlisten.forEach((u) => u());
    setPercent(null);
  }
}

export async function cancelTranscribe() {
  await invoke("cancel_transcribe");
}

/** Replace the transcript with cues imported from an .srt/.vtt file. No whisper
 *  run, so there are no word-level timings (word-highlight falls back to plain).
 *  Marks the transcript "done" so the editor + export appear immediately. */
export async function runImport(path: string): Promise<void> {
  const segments = await invoke<Segment[]>("import_subtitles", { path });
  setTranscript("segments", segments);
  setHasWords(false);
  setErrorMsg("");
  setStatus("done");
}
