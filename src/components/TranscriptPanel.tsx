import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { formatTime } from "../format";

export type Word = { start: number; end: number; text: string };
export type Segment = { start: number; end: number; text: string; words?: Word[] };

type Status =
  | "idle"
  | "extracting"
  | "transcribing"
  | "done"
  | "error"
  | "model-missing";

type TranscriptPanelProps = {
  /** On-disk path of the loaded video (local file or downloaded temp). */
  videoPath: string;
  /** Seek the player to a segment's start. */
  onSeek: (seconds: number) => void;
};

export default function TranscriptPanel(props: TranscriptPanelProps) {
  const [status, setStatus] = createSignal<Status>("idle");
  const [segments, setSegments] = createSignal<Segment[]>([]);
  const [percent, setPercent] = createSignal<number | null>(null);
  const [message, setMessage] = createSignal("");
  const [modelDir, setModelDir] = createSignal("");

  // Reset when a different video is loaded.
  createEffect(() => {
    props.videoPath;
    setStatus("idle");
    setSegments([]);
    setPercent(null);
    setMessage("");
  });

  const busy = () => status() === "extracting" || status() === "transcribing";

  const transcribe = async () => {
    if (busy()) return;
    setStatus("extracting");
    setPercent(null);
    setMessage("");

    const unlisten: UnlistenFn[] = [];
    try {
      unlisten.push(
        await listen<{ percent: number | null }>("extract-progress", (e) => {
          if (status() === "extracting") setPercent(e.payload.percent);
        }),
      );
      unlisten.push(
        await listen<{ percent: number }>("transcribe-progress", (e) => {
          // First transcribe tick means the extract phase is done.
          setStatus("transcribing");
          setPercent(e.payload.percent);
        }),
      );

      const result = await invoke<Segment[]>("transcribe", {
        src: props.videoPath,
        language: null,
        translate: false,
        wordTimestamps: false,
        model: null,
      });
      setSegments(result);
      setStatus("done");
    } catch (e) {
      const msg = String(e);
      if (msg === "cancelled") {
        setStatus("idle");
      } else if (msg.startsWith("MODEL_NOT_FOUND|")) {
        setModelDir(msg.slice("MODEL_NOT_FOUND|".length));
        setStatus("model-missing");
      } else {
        setMessage(msg);
        setStatus("error");
      }
    } finally {
      unlisten.forEach((u) => u());
      setPercent(null);
    }
  };

  const cancel = async () => {
    await invoke("cancel_transcribe");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && busy()) {
      e.preventDefault();
      void cancel();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const phaseLabel = () =>
    status() === "extracting" ? "Extracting audio…" : "Transcribing…";

  return (
    <aside class="transcript-panel">
      <div class="panel-head">
        <span class="panel-title">Transcript</span>
        <Show when={status() === "done"}>
          <span class="panel-count">{segments().length} segments</span>
        </Show>
      </div>

      <div class="panel-body">
        <Show when={status() === "idle"}>
          <div class="panel-cta">
            <p class="panel-hint">
              Transcribe the audio on-device with Whisper. Nothing leaves your
              machine.
            </p>
            <button class="primary-btn" type="button" onClick={transcribe}>
              Transcribe
            </button>
          </div>
        </Show>

        <Show when={busy()}>
          <div class="panel-progress">
            <p class="panel-phase">{phaseLabel()}</p>
            <div class="progress-track">
              <div
                class="progress-fill"
                classList={{ indeterminate: percent() === null }}
                style={percent() !== null ? { width: `${percent()}%` } : undefined}
              />
            </div>
            <p class="panel-percent">
              {percent() !== null ? `${percent()!.toFixed(0)}%` : "Working…"}
            </p>
            <button class="ghost-btn" type="button" onClick={cancel}>
              Cancel (Esc)
            </button>
          </div>
        </Show>

        <Show when={status() === "model-missing"}>
          <div class="panel-notice">
            <p class="notice-title">Whisper model not found</p>
            <p class="panel-hint">
              CaptionSmith couldn't find a transcription model. Put a
              <code> ggml-*.bin </code> model here and try again:
            </p>
            <p class="path-chip" title={modelDir()}>
              {modelDir()}
            </p>
            <button class="ghost-btn" type="button" onClick={() => setStatus("idle")}>
              Back
            </button>
          </div>
        </Show>

        <Show when={status() === "error"}>
          <div class="panel-notice">
            <p class="notice-title notice-danger">Transcription failed</p>
            <p class="panel-error">{message()}</p>
            <button class="ghost-btn" type="button" onClick={transcribe}>
              Try again
            </button>
          </div>
        </Show>

        <Show when={status() === "done"}>
          <Show
            when={segments().length > 0}
            fallback={<p class="panel-hint">No speech was detected.</p>}
          >
            <ul class="segment-list">
              <For each={segments()}>
                {(seg) => (
                  <li class="segment" onClick={() => props.onSeek(seg.start)}>
                    <span class="segment-time">{formatTime(seg.start)}</span>
                    <span class="segment-text">{seg.text}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
