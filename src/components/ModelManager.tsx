import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { loadModels, models, modelName, setModelName } from "../transcription";

type ModelManagerProps = {
  onClose: () => void;
};

// All multilingual (no ".en"): one model covers ~99 languages.
const CATALOG = [
  { file: "ggml-base.bin", label: "Base", size: "148 MB", note: "Fastest, lower accuracy" },
  { file: "ggml-small.bin", label: "Small", size: "488 MB", note: "Balanced" },
  { file: "ggml-medium.bin", label: "Medium", size: "1.5 GB", note: "High accuracy, slower" },
  { file: "ggml-large-v3-turbo.bin", label: "Large v3 Turbo", size: "1.6 GB", note: "Best accuracy, still fast" },
];

export default function ModelManager(props: ModelManagerProps) {
  const [downloading, setDownloading] = createSignal<string | null>(null);
  const [percent, setPercent] = createSignal<number | null>(null);
  const [error, setError] = createSignal("");
  const [folder, setFolder] = createSignal("");

  const installed = (file: string) => models().some((m) => m.name === file);

  onMount(async () => {
    try {
      setFolder(await invoke<string>("models_folder"));
    } catch {
      /* non-fatal */
    }
    void loadModels();
  });

  // Esc closes the dialog (unless a download is running — then it's ignored so
  // the user doesn't lose a big download by reflex).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !downloading()) {
      e.preventDefault();
      props.onClose();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const download = async (file: string) => {
    if (downloading()) return;
    setError("");
    setDownloading(file);
    setPercent(null);

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<{ file: string; percent: number | null }>(
        "model-download-progress",
        (e) => {
          if (e.payload.file === file) setPercent(e.payload.percent);
        },
      );
      await invoke("download_model", { file });
      await loadModels();
      setModelName(file); // auto-select the freshly downloaded model
    } catch (e) {
      const msg = String(e);
      if (msg !== "cancelled") setError(msg);
    } finally {
      unlisten?.();
      setDownloading(null);
      setPercent(null);
    }
  };

  const cancel = () => invoke("cancel_model_download");

  const remove = async (file: string) => {
    try {
      await invoke("delete_model", { file });
      await loadModels();
      if (modelName() === file) setModelName(""); // fall back to bundled default
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div class="modal-overlay" onClick={() => !downloading() && props.onClose()}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="modal-title">Whisper models</span>
          <button
            class="icon-btn modal-close"
            type="button"
            disabled={!!downloading()}
            onClick={props.onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p class="modal-intro">
          A multilingual model unlocks other languages and translate-to-English —
          one model covers ~99 languages. Downloads run on your machine and stay
          local. Larger = more accurate but slower.
        </p>

        <ul class="model-list">
          <For each={CATALOG}>
            {(m) => (
              <li class="model-row">
                <div class="model-info">
                  <span class="model-name">{m.label}</span>
                  <span class="model-meta">
                    {m.size} · {m.note}
                  </span>
                </div>

                <div class="model-action">
                  <Show when={downloading() === m.file}>
                    <div class="model-progress">
                      <div class="progress-track model-track">
                        <div
                          class="progress-fill"
                          classList={{ indeterminate: percent() === null }}
                          style={percent() !== null ? { width: `${percent()}%` } : undefined}
                        />
                      </div>
                      <span class="model-pct">
                        {percent() !== null ? `${percent()!.toFixed(0)}%` : "…"}
                      </span>
                      <button class="ghost-btn tiny-btn" type="button" onClick={cancel}>
                        Cancel
                      </button>
                    </div>
                  </Show>

                  <Show when={downloading() !== m.file}>
                    <Show
                      when={installed(m.file)}
                      fallback={
                        <button
                          class="primary-btn tiny-btn"
                          type="button"
                          disabled={!!downloading()}
                          onClick={() => download(m.file)}
                        >
                          Download
                        </button>
                      }
                    >
                      <span class="model-installed">Installed</span>
                      <button
                        class="ghost-btn tiny-btn danger"
                        type="button"
                        disabled={!!downloading()}
                        onClick={() => remove(m.file)}
                      >
                        Delete
                      </button>
                    </Show>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>

        <Show when={error()}>
          <p class="model-error">{error()}</p>
        </Show>

        <Show when={folder()}>
          <p class="model-folder" title={folder()}>
            Saved to {folder()}
          </p>
        </Show>
      </div>
    </div>
  );
}
