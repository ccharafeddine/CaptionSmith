import { For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import {
  addBatchFiles,
  batch,
  batchDir,
  batchFormat,
  batchRunning,
  cancelBatch,
  clearBatch,
  doneCount,
  type BatchFormat,
  type FileStatus,
  isWorking,
  removeBatchFile,
  runBatch,
  setBatchDir,
  setBatchFormat,
} from "../batch";
import { applyPreset, PRESET_LABELS, style } from "../style";
import {
  language,
  LANGUAGES,
  loadModels,
  models,
  modelName,
  multilingualSelected,
  setLanguage,
  setModelName,
  setTranslate,
  translate,
} from "../transcription";

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

const STATUS_TEXT: Record<FileStatus, string> = {
  queued: "Queued",
  extracting: "Extracting audio…",
  transcribing: "Transcribing…",
  exporting: "Exporting…",
  burning: "Burning in…",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

type BatchPanelProps = {
  onClose: () => void;
};

export default function BatchPanel(props: BatchPanelProps) {
  const close = () => {
    if (!batchRunning()) props.onClose();
  };

  onMount(async () => {
    if (!batchDir()) {
      try {
        setBatchDir(await invoke<string>("ensure_export_dir"));
      } catch {
        /* leave empty; Start is disabled until a folder is set */
      }
    }
    void loadModels();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const pickFiles = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (Array.isArray(selected)) addBatchFiles(selected);
    else if (typeof selected === "string") addBatchFiles([selected]);
  };

  const pickDir = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setBatchDir(dir);
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal batch-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="modal-title">Batch captioning</span>
          <button
            class="icon-btn modal-close"
            type="button"
            disabled={batchRunning()}
            onClick={close}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p class="modal-intro">
          Caption several files in one pass with your current style — each is
          transcribed on-device, then exported. No per-file editing; use the main
          window when a transcript needs hand-tuning.
        </p>

        {/* Files */}
        <div class="batch-files-head">
          <button
            class="ghost-btn tiny-btn"
            type="button"
            disabled={batchRunning()}
            onClick={pickFiles}
          >
            Add files
          </button>
          <span class="batch-count">
            {batch.files.length} {batch.files.length === 1 ? "file" : "files"}
          </span>
          <Show when={batch.files.length > 0 && !batchRunning()}>
            <button
              class="ghost-btn tiny-btn"
              type="button"
              onClick={clearBatch}
            >
              Clear
            </button>
          </Show>
        </div>

        <Show
          when={batch.files.length > 0}
          fallback={
            <p class="batch-empty">
              No files queued. “Add files” to pick videos to caption.
            </p>
          }
        >
          <ul class="batch-list">
            <For each={batch.files}>
              {(f, i) => (
                <li class="batch-row" data-status={f.status}>
                  <div class="batch-info">
                    <span class="batch-name" title={f.path}>
                      {f.name}
                    </span>
                    <Show
                      when={f.error}
                      fallback={
                        <span class="batch-status">
                          {STATUS_TEXT[f.status]}
                          <Show when={f.output}>
                            {" · "}
                            <span class="batch-output" title={f.output}>
                              {f.output}
                            </span>
                          </Show>
                        </span>
                      }
                    >
                      <span class="batch-status batch-err">{f.error}</span>
                    </Show>
                  </div>

                  <div class="batch-row-right">
                    <Show when={isWorking(f.status)}>
                      <div class="progress-track model-track">
                        <div
                          class="progress-fill"
                          classList={{ indeterminate: f.percent === null }}
                          style={
                            f.percent !== null
                              ? { width: `${f.percent}%` }
                              : undefined
                          }
                        />
                      </div>
                    </Show>
                    <Show when={!batchRunning()}>
                      <button
                        class="icon-btn tiny-x"
                        type="button"
                        onClick={() => removeBatchFile(i())}
                        aria-label="Remove"
                      >
                        ✕
                      </button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* Options */}
        <div class="batch-options">
          <label class="control-row">
            <span class="control-label">Output</span>
            <select
              class="select"
              value={batchFormat()}
              disabled={batchRunning()}
              onChange={(e) =>
                setBatchFormat(e.currentTarget.value as BatchFormat)
              }
            >
              <option value="srt">SRT sidecar</option>
              <option value="vtt">VTT sidecar</option>
              <option value="ass">ASS sidecar</option>
              <option value="mp4">Burn-in MP4</option>
            </select>
          </label>

          <label class="control-row">
            <span class="control-label">Model</span>
            <select
              class="select"
              value={modelName()}
              disabled={batchRunning()}
              onChange={(e) => setModelName(e.currentTarget.value)}
            >
              <For each={models()}>
                {(m) => <option value={m.name}>{m.label}</option>}
              </For>
            </select>
          </label>

          <Show when={multilingualSelected()}>
            <label class="control-row">
              <span class="control-label">Language</span>
              <select
                class="select"
                value={language()}
                disabled={batchRunning()}
                onChange={(e) => setLanguage(e.currentTarget.value)}
              >
                <For each={LANGUAGES}>
                  {(l) => <option value={l.code}>{l.name}</option>}
                </For>
              </select>
            </label>
            <label class="control-check">
              <input
                type="checkbox"
                checked={translate()}
                disabled={batchRunning()}
                onChange={(e) => setTranslate(e.currentTarget.checked)}
              />
              <span>Translate to English</span>
            </label>
          </Show>

          <div class="control-row">
            <span class="control-label">Folder</span>
            <span class="path-chip batch-dir" title={batchDir()}>
              {batchDir() || "Choose an output folder"}
            </span>
            <button
              class="ghost-btn tiny-btn"
              type="button"
              disabled={batchRunning()}
              onClick={pickDir}
            >
              Change
            </button>
          </div>

          <div class="batch-preset">
            <span class="control-label">Style</span>
            <div class="preset-grid">
              <For each={PRESET_LABELS}>
                {(p) => (
                  <button
                    type="button"
                    class="preset-btn"
                    classList={{ active: style.preset === p.key }}
                    disabled={batchRunning()}
                    onClick={() => applyPreset(p.key)}
                  >
                    {p.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div class="batch-footer">
          <span class="batch-progress-text">
            {doneCount()} / {batch.files.length} done
          </span>
          <Show
            when={batchRunning()}
            fallback={
              <button
                class="primary-btn"
                type="button"
                disabled={batch.files.length === 0 || !batchDir()}
                onClick={runBatch}
              >
                Start
              </button>
            }
          >
            <button class="ghost-btn" type="button" onClick={cancelBatch}>
              Cancel
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
