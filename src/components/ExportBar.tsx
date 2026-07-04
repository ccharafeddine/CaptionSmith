import { createSignal, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { unwrap } from "solid-js/store";

import { style } from "../style";
import { transcript } from "../transcription";
import { hasSpeakers, speakerLabel } from "../diarize";

type ExportBarProps = {
  videoPath: string;
  videoName: string;
};

const FORMATS = [
  { ext: "srt", label: "SRT" },
  { ext: "vtt", label: "VTT" },
  { ext: "ass", label: "ASS" },
];

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export default function ExportBar(props: ExportBarProps) {
  const [format, setFormat] = createSignal("srt");
  const [busy, setBusy] = createSignal<false | "sidecar" | "burn">(false);
  const [percent, setPercent] = createSignal<number | null>(null);
  const [saved, setSaved] = createSignal("");
  const [error, setError] = createSignal("");
  const [prefixSpeakers, setPrefixSpeakers] = createSignal(false);

  // Segments to export. When "Speaker names" is on, bake the speaker label into
  // each caption's text ("Alice: …") — done here (not in Rust) because the custom
  // names live in the frontend. Note: karaoke styles render from word timings, so
  // the prefix shows in the text-based outputs (SRT/VTT and non-karaoke ASS).
  const exportSegments = () => {
    const segs = unwrap(transcript).segments;
    if (!prefixSpeakers() || !hasSpeakers()) return segs;
    return segs.map((s) =>
      s.speaker != null
        ? { ...s, text: `${speakerLabel(s.speaker)}: ${s.text}` }
        : s,
    );
  };

  const exportSidecar = async () => {
    if (busy()) return;
    setError("");
    setSaved("");
    const ext = format();
    try {
      const dir = await invoke<string>("ensure_export_dir");
      const path = await save({
        defaultPath: `${dir}/${stemOf(props.videoName)}.${ext}`,
        filters: [{ name: `${ext.toUpperCase()} subtitle`, extensions: [ext] }],
      });
      if (!path) return;

      setBusy("sidecar");
      await invoke("export_sidecar", {
        segments: exportSegments(),
        style: { ...style },
        format: ext,
        path,
      });
      setSaved(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const burnIn = async () => {
    if (busy()) return;
    setError("");
    setSaved("");
    try {
      const dir = await invoke<string>("ensure_export_dir");
      const path = await save({
        defaultPath: `${dir}/${stemOf(props.videoName)}_captioned.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      });
      if (!path) return;

      setBusy("burn");
      setPercent(null);
      let unlisten: UnlistenFn | undefined;
      try {
        unlisten = await listen<{ percent: number | null }>("burn-progress", (e) => {
          setPercent(e.payload.percent);
        });
        await invoke("burn_in", {
          src: props.videoPath,
          segments: exportSegments(),
          style: { ...style },
          out: path,
        });
        setSaved(path);
      } finally {
        unlisten?.();
      }
    } catch (e) {
      const msg = String(e);
      if (msg !== "cancelled") setError(msg);
    } finally {
      setBusy(false);
      setPercent(null);
    }
  };

  const cancelBurn = () => invoke("cancel_burn");

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && busy() === "burn") {
      e.preventDefault();
      void cancelBurn();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <footer class="export-bar">
      <Show
        when={busy() !== "burn"}
        fallback={
          <div class="burn-progress">
            <span class="export-label">Burning in captions…</span>
            <div class="progress-track burn-track">
              <div
                class="progress-fill"
                classList={{ indeterminate: percent() === null }}
                style={percent() !== null ? { width: `${percent()}%` } : undefined}
              />
            </div>
            <span class="export-pct">
              {percent() !== null ? `${percent()!.toFixed(0)}%` : "…"}
            </span>
            <button class="ghost-btn" type="button" onClick={cancelBurn}>
              Cancel (Esc)
            </button>
          </div>
        }
      >
        <div class="export-group">
          <span class="export-label">Subtitle file</span>
          <select
            class="select export-format"
            value={format()}
            onChange={(e) => setFormat(e.currentTarget.value)}
          >
            {FORMATS.map((f) => (
              <option value={f.ext}>{f.label}</option>
            ))}
          </select>
          <button
            class="ghost-btn"
            type="button"
            disabled={busy() !== false}
            onClick={exportSidecar}
          >
            {busy() === "sidecar" ? "Exporting…" : "Export file"}
          </button>
        </div>

        <Show when={hasSpeakers()}>
          <label class="control-check export-speakers">
            <input
              type="checkbox"
              checked={prefixSpeakers()}
              onChange={(e) => setPrefixSpeakers(e.currentTarget.checked)}
            />
            <span>Speaker names</span>
          </label>
        </Show>

        <div class="export-divider" />

        <button class="primary-btn" type="button" onClick={burnIn}>
          Burn in → .mp4
        </button>

        <div class="export-status">
          <Show when={saved()}>
            <span class="export-saved" title={saved()}>
              Saved to {saved()}
            </span>
          </Show>
          <Show when={error()}>
            <span class="export-error">{error()}</span>
          </Show>
        </div>
      </Show>
    </footer>
  );
}
