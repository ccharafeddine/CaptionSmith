import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { open } from "@tauri-apps/plugin-dialog";

import ModelManager from "./ModelManager";
import { formatTime, formatPrecise } from "../format";
import { isFormControl } from "../keys";
import { style } from "../style";
import {
  cancelTranscribe,
  errorMsg,
  isBusy,
  language,
  modelDir,
  modelName,
  models,
  multilingualSelected,
  percent,
  runImport,
  runTranscribe,
  setLanguage,
  setModelName,
  setStatus,
  setTranscript,
  setTranslate,
  status,
  transcribeNote,
  transcript,
  translate,
} from "../transcription";

type TranscriptPanelProps = {
  currentTime: Accessor<number>;
  onSeek: (seconds: number) => void;
};

const LANGUAGES = [
  { code: "auto", name: "Auto-detect" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "hi", name: "Hindi" },
];

const NUDGE = 0.1;
const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export default function TranscriptPanel(props: TranscriptPanelProps) {
  const [selected, setSelected] = createSignal<number | null>(null);
  const [showModels, setShowModels] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [importError, setImportError] = createSignal("");
  let listEl: HTMLUListElement | undefined;
  // Set when a caption is inserted, so its editor grabs focus on mount.
  let focusNext = false;

  // Deselect whenever we leave the finished transcript (new run, error, reset).
  createEffect(() => {
    if (status() !== "done") setSelected(null);
  });

  const activeIndex = createMemo(() => {
    if (status() !== "done") return -1;
    const t = props.currentTime();
    return transcript.segments.findIndex((s) => t >= s.start && t < s.end);
  });

  createEffect(() => {
    const i = activeIndex();
    if (i < 0 || !listEl) return;
    (listEl.children[i] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  });

  const transcribe = () => runTranscribe(style.perWord);

  // Bring-your-own transcript: pick an .srt/.vtt and load its cues as segments,
  // skipping whisper entirely. Replaces the current transcript on success.
  const importSubtitles = async () => {
    if (importing() || isBusy()) return;
    setImportError("");
    const selectedPath = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Subtitles", extensions: ["srt", "vtt"] }],
    });
    if (typeof selectedPath !== "string") return;

    setImporting(true);
    try {
      await runImport(selectedPath);
      setSelected(null);
    } catch (e) {
      setImportError(String(e));
    } finally {
      setImporting(false);
    }
  };

  // --- editing operations ---------------------------------------------------

  const selectSegment = (i: number) => {
    setSelected(i);
    props.onSeek(transcript.segments[i].start);
  };

  // Insert a new (empty) caption — for non-speech lines like "[laughs
  // maniacally]" that transcription won't produce. Goes right after the
  // selected caption (beginning where it ends); with nothing selected, at the
  // playhead. Sized 2s but never overlapping the next caption, then opened for
  // editing.
  const addSegment = () => {
    const list = transcript.segments;
    const sel = selected();

    let idx: number;
    let start: number;
    if (sel !== null && sel < list.length) {
      idx = sel + 1;
      const nextStart = idx < list.length ? list[idx].start : Infinity;
      start = round(Math.min(list[sel].end, nextStart));
    } else {
      start = round(Math.max(0, props.currentTime()));
      idx = list.findIndex((s) => s.start > start);
      if (idx < 0) idx = list.length;
    }

    const nextStart = idx < list.length ? list[idx].start : Infinity;
    let end = Math.min(start + 2, nextStart);
    if (end <= start) end = start + 0.5;

    focusNext = true;
    setTranscript(
      "segments",
      produce((l) => l.splice(idx, 0, { start, end: round(end), text: "" })),
    );
    setSelected(idx);
    props.onSeek(start);
  };

  const updateText = (i: number, text: string) =>
    setTranscript("segments", i, "text", text);

  // Keep the list ordered by start time. Move segment `i` to its sorted spot,
  // preserving object identity (so its open editor and buttons keep focus, and
  // Solid moves the DOM node instead of remounting). Returns the new index.
  const resortByStart = (i: number): number => {
    let newIndex = i;
    setTranscript(
      "segments",
      produce((l) => {
        const [moved] = l.splice(i, 1);
        let idx = l.findIndex((s) => s.start > moved.start);
        if (idx < 0) idx = l.length;
        l.splice(idx, 0, moved);
        newIndex = idx;
      }),
    );
    return newIndex;
  };

  const nudgeStart = (i: number, d: number) => {
    const s = transcript.segments[i];
    setTranscript("segments", i, "start", round(clamp(s.start + d, 0, s.end - 0.05)));
    setSelected(resortByStart(i));
  };
  const nudgeEnd = (i: number, d: number) => {
    const s = transcript.segments[i];
    setTranscript("segments", i, "end", round(Math.max(s.end + d, s.start + 0.05)));
  };
  const startToPlayhead = (i: number) => {
    const s = transcript.segments[i];
    const ns = round(Math.max(0, props.currentTime()));
    // Relocating the start past the current end: carry the end along so the
    // caption keeps its length (otherwise start clamps to a stale end).
    if (ns >= s.end - 0.05) {
      const dur = Math.max(s.end - s.start, 0.5);
      setTranscript("segments", i, "end", round(ns + dur));
      setTranscript("segments", i, "start", ns);
    } else {
      setTranscript("segments", i, "start", round(clamp(ns, 0, s.end - 0.05)));
    }
    setSelected(resortByStart(i));
  };
  const endToPlayhead = (i: number) => {
    const s = transcript.segments[i];
    setTranscript("segments", i, "end", round(Math.max(props.currentTime(), s.start + 0.05)));
  };

  const deleteSegment = (i: number) => {
    setTranscript("segments", produce((l) => l.splice(i, 1)));
    setSelected(null);
  };

  const mergeWithNext = (i: number) => {
    if (i >= transcript.segments.length - 1) return;
    const a = transcript.segments[i];
    const b = transcript.segments[i + 1];
    const merged = {
      start: a.start,
      end: b.end,
      text: `${a.text} ${b.text}`.trim(),
      words: a.words && b.words ? [...a.words, ...b.words] : undefined,
    };
    setTranscript("segments", produce((l) => l.splice(i, 2, merged)));
    setSelected(i);
  };

  const splitSegment = (i: number) => {
    const s = transcript.segments[i];
    let t = props.currentTime();
    if (!(t > s.start + 0.05 && t < s.end - 0.05)) t = (s.start + s.end) / 2;
    t = round(t);

    const tokens = s.text.split(/\s+/).filter(Boolean);
    const frac = (t - s.start) / (s.end - s.start);
    const k = clamp(Math.round(tokens.length * frac), 1, Math.max(1, tokens.length - 1));

    const first = {
      start: s.start,
      end: t,
      text: tokens.slice(0, k).join(" "),
      words: s.words?.filter((w) => w.start < t),
    };
    const second = {
      start: t,
      end: s.end,
      text: tokens.slice(k).join(" "),
      words: s.words?.filter((w) => w.start >= t),
    };
    setTranscript("segments", produce((l) => l.splice(i, 1, first, second)));
    setSelected(i);
  };

  // Enter edits the segment at the playhead; Esc cancels an in-flight run or
  // dismisses a notice panel back to idle.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (isBusy()) {
        e.preventDefault();
        void cancelTranscribe();
      } else if (status() === "model-missing" || status() === "error") {
        e.preventDefault();
        setStatus("idle");
      }
      return;
    }
    if (e.key === "Enter" && status() === "done" && !isFormControl(e.target)) {
      const i = activeIndex();
      if (i >= 0) {
        e.preventDefault();
        setSelected(i);
      }
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const phaseLabel = () =>
    status() === "extracting" ? "Extracting audio…" : "Transcribing…";

  return (
    <div class="panel-content">
      <Show when={status() === "idle" || status() === "done"}>
        <div class="controls">
          <label class="control-row">
            <span class="control-label">Model</span>
            <select
              class="select"
              value={modelName()}
              onChange={(e) => setModelName(e.currentTarget.value)}
            >
              <For each={models()}>
                {(m) => <option value={m.name}>{m.label}</option>}
              </For>
            </select>
          </label>

          <button
            class="link-btn"
            type="button"
            onClick={() => setShowModels(true)}
          >
            + Add languages (download a model)
          </button>

          <label class="control-row">
            <span class="control-label">Language</span>
            <select
              class="select"
              value={multilingualSelected() ? language() : "en"}
              disabled={!multilingualSelected()}
              onChange={(e) => setLanguage(e.currentTarget.value)}
            >
              <Show when={multilingualSelected()} fallback={<option value="en">English</option>}>
                <For each={LANGUAGES}>
                  {(l) => <option value={l.code}>{l.name}</option>}
                </For>
              </Show>
            </select>
          </label>

          <label class="control-check" classList={{ disabled: !multilingualSelected() }}>
            <input
              type="checkbox"
              checked={multilingualSelected() && translate()}
              disabled={!multilingualSelected()}
              onChange={(e) => setTranslate(e.currentTarget.checked)}
            />
            <span>Translate to English</span>
          </label>

          <Show when={!multilingualSelected()}>
            <p class="control-note">
              The bundled model is English-only. Drop a multilingual
              <code> ggml </code> model in the models folder to enable other
              languages and translation.
            </p>
          </Show>

          <button class="primary-btn control-go" type="button" onClick={transcribe}>
            {status() === "done" ? "Re-transcribe" : "Transcribe"}
          </button>

          <div class="import-divider">
            <span>or</span>
          </div>

          <button
            class="ghost-btn control-import"
            type="button"
            disabled={importing()}
            onClick={importSubtitles}
          >
            {importing() ? "Importing…" : "Import .srt / .vtt transcript"}
          </button>
          <p class="control-note">
            Already have subtitles? Load them to style and burn in — no
            transcription needed.
          </p>

          <Show when={importError()}>
            <p class="panel-error">{importError()}</p>
          </Show>
        </div>
      </Show>

      <Show when={isBusy()}>
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
          <button class="ghost-btn" type="button" onClick={cancelTranscribe}>
            Cancel (Esc)
          </button>
        </div>
      </Show>

      <Show when={transcribeNote()}>
        <p class="panel-note-info">{transcribeNote()}</p>
      </Show>

      <Show when={status() === "model-missing"}>
        <div class="panel-notice">
          <p class="notice-title">Whisper model not found</p>
          <p class="panel-hint">
            CaptionSmith couldn't find a transcription model. Put a
            <code> ggml-*.bin </code> model here and try again:
          </p>
          <p class="path-chip" title={modelDir()}>{modelDir()}</p>
          <button class="ghost-btn" type="button" onClick={() => setStatus("idle")}>
            Back
          </button>
        </div>
      </Show>

      <Show when={status() === "error"}>
        <div class="panel-notice">
          <p class="notice-title notice-danger">Transcription failed</p>
          <p class="panel-error">{errorMsg()}</p>
          <button class="ghost-btn" type="button" onClick={transcribe}>
            Try again
          </button>
        </div>
      </Show>

      <Show when={status() === "done"}>
        <div class="transcript-toolbar">
          <span class="toolbar-count">
            {transcript.segments.length}{" "}
            {transcript.segments.length === 1 ? "caption" : "captions"}
          </span>
          <button class="ghost-btn tiny-btn" type="button" onClick={addSegment}>
            Add caption
          </button>
        </div>

        <Show
          when={transcript.segments.length > 0}
          fallback={
            <p class="panel-hint empty-note">
              No speech detected. Use “Add caption” to add one.
            </p>
          }
        >
          <ul class="segment-list" ref={listEl}>
            <For each={transcript.segments}>
              {(seg, i) => (
                <li
                  class="segment"
                  classList={{
                    active: activeIndex() === i(),
                    selected: selected() === i(),
                  }}
                >
                  <div class="segment-main" onClick={() => selectSegment(i())}>
                    <span class="segment-time">{formatTime(seg.start)}</span>
                    <span class="segment-text">{seg.text}</span>
                  </div>

                  <Show when={selected() === i()}>
                    <div class="segment-editor" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        class="edit-text"
                        rows={2}
                        placeholder="e.g. [laughs maniacally]"
                        ref={(el) => {
                          el.value = seg.text;
                          if (focusNext && selected() === i()) {
                            focusNext = false;
                            el.focus();
                          }
                        }}
                        onInput={(e) => updateText(i(), e.currentTarget.value)}
                      />

                      <div class="timing">
                        <div class="timing-row">
                          <span class="timing-label">Start</span>
                          <button class="tiny" onClick={() => nudgeStart(i(), -NUDGE)}>−</button>
                          <span class="timing-val">{formatPrecise(seg.start)}</span>
                          <button class="tiny" onClick={() => nudgeStart(i(), NUDGE)}>+</button>
                          <button class="tiny wide" title="Set to playhead" onClick={() => startToPlayhead(i())}>⌖</button>
                        </div>
                        <div class="timing-row">
                          <span class="timing-label">End</span>
                          <button class="tiny" onClick={() => nudgeEnd(i(), -NUDGE)}>−</button>
                          <span class="timing-val">{formatPrecise(seg.end)}</span>
                          <button class="tiny" onClick={() => nudgeEnd(i(), NUDGE)}>+</button>
                          <button class="tiny wide" title="Set to playhead" onClick={() => endToPlayhead(i())}>⌖</button>
                        </div>
                      </div>

                      <div class="seg-actions">
                        <button class="ghost-btn tiny-btn" onClick={() => splitSegment(i())}>Split</button>
                        <button
                          class="ghost-btn tiny-btn"
                          disabled={i() >= transcript.segments.length - 1}
                          onClick={() => mergeWithNext(i())}
                        >
                          Merge ↓
                        </button>
                        <button class="ghost-btn tiny-btn danger" onClick={() => deleteSegment(i())}>Delete</button>
                      </div>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={showModels()}>
        <ModelManager onClose={() => setShowModels(false)} />
      </Show>
    </div>
  );
}
