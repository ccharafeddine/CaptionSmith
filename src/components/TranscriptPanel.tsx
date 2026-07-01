import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { formatTime, formatPrecise } from "../format";

export type Word = { start: number; end: number; text: string };
export type Segment = { start: number; end: number; text: string; words?: Word[] };

type ModelInfo = {
  name: string;
  label: string;
  multilingual: boolean;
  is_default: boolean;
};

type Status =
  | "idle"
  | "extracting"
  | "transcribing"
  | "done"
  | "error"
  | "model-missing";

type TranscriptPanelProps = {
  videoPath: string;
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

const NUDGE = 0.1; // seconds per timing nudge
const round = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export default function TranscriptPanel(props: TranscriptPanelProps) {
  const [status, setStatus] = createSignal<Status>("idle");
  const [store, setStore] = createStore<{ list: Segment[] }>({ list: [] });
  const [selected, setSelected] = createSignal<number | null>(null);
  const [percent, setPercent] = createSignal<number | null>(null);
  const [message, setMessage] = createSignal("");
  const [modelDir, setModelDir] = createSignal("");

  const [models, setModels] = createSignal<ModelInfo[]>([]);
  const [modelName, setModelName] = createSignal("");
  const [language, setLanguage] = createSignal("auto");
  const [translate, setTranslate] = createSignal(false);

  let listEl: HTMLUListElement | undefined;

  const currentModel = createMemo(() =>
    models().find((m) => m.name === modelName()),
  );
  const multilingual = createMemo(() => currentModel()?.multilingual ?? false);

  onMount(async () => {
    try {
      const list = await invoke<ModelInfo[]>("list_models");
      setModels(list);
      const def = list.find((m) => m.is_default) ?? list[0];
      if (def) setModelName(def.name);
    } catch {
      /* leave the picker empty; transcribe will surface a clear error */
    }
  });

  // Reset transcript when a different video loads (keep model/lang choices).
  createEffect(() => {
    props.videoPath;
    setStatus("idle");
    setStore("list", []);
    setSelected(null);
    setPercent(null);
    setMessage("");
  });

  const busy = () => status() === "extracting" || status() === "transcribing";

  // Segment under the playhead (for highlight + autoscroll + split anchor).
  const activeIndex = createMemo(() => {
    if (status() !== "done") return -1;
    const t = props.currentTime();
    return store.list.findIndex((s) => t >= s.start && t < s.end);
  });

  createEffect(() => {
    const i = activeIndex();
    if (i < 0 || !listEl) return;
    (listEl.children[i] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  });

  const transcribe = async () => {
    if (busy()) return;
    setStatus("extracting");
    setPercent(null);
    setMessage("");
    setSelected(null);

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

      const result = await invoke<Segment[]>("transcribe", {
        src: props.videoPath,
        language: multilingual() ? language() : null,
        translate: multilingual() && translate(),
        wordTimestamps: false,
        model: modelName() || null,
      });
      setStore("list", result);
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

  // --- editing operations ---------------------------------------------------

  const selectSegment = (i: number) => {
    setSelected(i);
    props.onSeek(store.list[i].start);
  };

  const updateText = (i: number, text: string) => setStore("list", i, "text", text);

  const nudgeStart = (i: number, d: number) => {
    const s = store.list[i];
    setStore("list", i, "start", round(clamp(s.start + d, 0, s.end - 0.05)));
  };
  const nudgeEnd = (i: number, d: number) => {
    const s = store.list[i];
    setStore("list", i, "end", round(Math.max(s.end + d, s.start + 0.05)));
  };
  const startToPlayhead = (i: number) => {
    const s = store.list[i];
    setStore("list", i, "start", round(clamp(props.currentTime(), 0, s.end - 0.05)));
  };
  const endToPlayhead = (i: number) => {
    const s = store.list[i];
    setStore("list", i, "end", round(Math.max(props.currentTime(), s.start + 0.05)));
  };

  const deleteSegment = (i: number) => {
    setStore("list", produce((l) => l.splice(i, 1)));
    setSelected(null);
  };

  const mergeWithNext = (i: number) => {
    if (i >= store.list.length - 1) return;
    const a = store.list[i];
    const b = store.list[i + 1];
    const merged: Segment = {
      start: a.start,
      end: b.end,
      text: `${a.text} ${b.text}`.trim(),
      words:
        a.words && b.words ? [...a.words, ...b.words] : undefined,
    };
    setStore("list", produce((l) => l.splice(i, 2, merged)));
    setSelected(i);
  };

  const splitSegment = (i: number) => {
    const s = store.list[i];
    let t = props.currentTime();
    if (!(t > s.start + 0.05 && t < s.end - 0.05)) t = (s.start + s.end) / 2;
    t = round(t);

    const tokens = s.text.split(/\s+/).filter(Boolean);
    const frac = (t - s.start) / (s.end - s.start);
    const k = clamp(Math.round(tokens.length * frac), 1, Math.max(1, tokens.length - 1));

    const first: Segment = {
      start: s.start,
      end: t,
      text: tokens.slice(0, k).join(" "),
      words: s.words?.filter((w) => w.start < t),
    };
    const second: Segment = {
      start: t,
      end: s.end,
      text: tokens.slice(k).join(" "),
      words: s.words?.filter((w) => w.start >= t),
    };
    setStore("list", produce((l) => l.splice(i, 1, first, second)));
    setSelected(i);
  };

  // Enter edits the segment at the playhead (Step 10 shortcut, wired here).
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    if (e.key === "Escape" && busy()) {
      e.preventDefault();
      void cancel();
      return;
    }
    if (e.key === "Enter" && !typing && status() === "done") {
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
    <aside class="transcript-panel">
      <div class="panel-head">
        <span class="panel-title">Transcript</span>
        <Show when={status() === "done"}>
          <span class="panel-count">{store.list.length} segments</span>
        </Show>
      </div>

      <div class="panel-body">
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

            <label class="control-row">
              <span class="control-label">Language</span>
              <select
                class="select"
                value={multilingual() ? language() : "en"}
                disabled={!multilingual()}
                onChange={(e) => setLanguage(e.currentTarget.value)}
              >
                <Show when={multilingual()} fallback={<option value="en">English</option>}>
                  <For each={LANGUAGES}>
                    {(l) => <option value={l.code}>{l.name}</option>}
                  </For>
                </Show>
              </select>
            </label>

            <label class="control-check" classList={{ disabled: !multilingual() }}>
              <input
                type="checkbox"
                checked={multilingual() && translate()}
                disabled={!multilingual()}
                onChange={(e) => setTranslate(e.currentTarget.checked)}
              />
              <span>Translate to English</span>
            </label>

            <Show when={!multilingual()}>
              <p class="control-note">
                The bundled model is English-only. Drop a multilingual
                <code> ggml </code> model in the models folder to enable other
                languages and translation.
              </p>
            </Show>

            <button class="primary-btn control-go" type="button" onClick={transcribe}>
              {status() === "done" ? "Re-transcribe" : "Transcribe"}
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
            <p class="path-chip" title={modelDir()}>{modelDir()}</p>
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
            when={store.list.length > 0}
            fallback={<p class="panel-hint empty-note">No speech was detected.</p>}
          >
            <ul class="segment-list" ref={listEl}>
              <For each={store.list}>
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
                          ref={(el) => (el.value = seg.text)}
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
                            disabled={i() >= store.list.length - 1}
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
      </div>
    </aside>
  );
}
