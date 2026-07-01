import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { unwrap } from "solid-js/store";

import { style } from "../style";
import { transcript } from "../transcription";

type ExportBarProps = {
  /** Loaded video's filename, used to prefill the export name. */
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
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal("");
  const [error, setError] = createSignal("");

  const exportSidecar = async () => {
    if (saving()) return;
    setError("");
    setSaved("");
    const ext = format();

    try {
      const dir = await invoke<string>("ensure_export_dir");
      const path = await save({
        defaultPath: `${dir}/${stemOf(props.videoName)}.${ext}`,
        filters: [{ name: `${ext.toUpperCase()} subtitle`, extensions: [ext] }],
      });
      if (!path) return; // user cancelled

      setSaving(true);
      await invoke("export_sidecar", {
        segments: unwrap(transcript).segments,
        style: { ...style },
        format: ext,
        path,
      });
      setSaved(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <footer class="export-bar">
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
          class="primary-btn"
          type="button"
          disabled={saving()}
          onClick={exportSidecar}
        >
          {saving() ? "Exporting…" : "Export file"}
        </button>
      </div>

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
    </footer>
  );
}
