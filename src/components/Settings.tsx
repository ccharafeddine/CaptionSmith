import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";

import ModelManager from "./ModelManager";
import { gpuEnabled, saveGpuPref } from "../transcription";
import {
  checkError,
  checkForUpdate,
  checkOnStartupEnabled,
  checkState,
  openReleasePage,
  setCheckOnStartup,
  updateInfo,
} from "../updater";

type SettingsProps = {
  onClose: () => void;
};

export default function Settings(props: SettingsProps) {
  const [version, setVersion] = createSignal("");
  const [startup, setStartup] = createSignal(checkOnStartupEnabled());
  // True while an embedded model download is running: blocks close so a reflex
  // Esc / backdrop click can't orphan the download.
  const [modelBusy, setModelBusy] = createSignal(false);

  const close = () => {
    if (!modelBusy()) props.onClose();
  };

  onMount(async () => {
    try {
      setVersion(await getVersion());
    } catch {
      // Fall back to whatever the update check reported, if anything.
      setVersion(updateInfo()?.current ?? "");
    }
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  const toggleStartup = (on: boolean) => {
    setStartup(on);
    setCheckOnStartup(on);
  };

  return (
    <div class="modal-overlay" onClick={close}>
      <div class="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="modal-title">Settings</span>
          <button
            class="icon-btn modal-close"
            type="button"
            disabled={modelBusy()}
            onClick={close}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* About */}
        <section class="settings-section">
          <div class="settings-about">
            <span class="settings-version">
              CaptionSmith <span class="settings-ver-num">v{version() || "—"}</span>
            </span>
            <span class="settings-tagline">
              Local-first captions. No accounts, no cloud, no telemetry.
            </span>
          </div>
        </section>

        {/* Updates */}
        <section class="settings-section">
          <h3 class="settings-heading">Updates</h3>

          <div class="update-row">
            <button
              class="ghost-btn"
              type="button"
              disabled={checkState() === "checking"}
              onClick={checkForUpdate}
            >
              {checkState() === "checking" ? "Checking…" : "Check for updates"}
            </button>

            <span class="update-status">
              <Show when={checkState() === "up-to-date"}>
                <span class="update-ok">You're on the latest version.</span>
              </Show>
              <Show when={checkState() === "available"}>
                <span class="update-new">
                  Version {updateInfo()?.latest} is available.
                </span>
              </Show>
              <Show when={checkState() === "error"}>
                <span class="update-err">{checkError()}</span>
              </Show>
            </span>
          </div>

          <Show when={checkState() === "available" && updateInfo()}>
            <div class="update-detail">
              <Show when={updateInfo()!.notes}>
                <pre class="update-notes">{updateInfo()!.notes}</pre>
              </Show>
              <button class="primary-btn" type="button" onClick={openReleasePage}>
                Download from GitHub
              </button>
              <p class="settings-note">
                CaptionSmith never installs updates on its own — this just opens
                the release page in your browser.
              </p>
            </div>
          </Show>

          <label class="control-check settings-toggle">
            <input
              type="checkbox"
              checked={startup()}
              onChange={(e) => toggleStartup(e.currentTarget.checked)}
            />
            <span>Check for updates on startup</span>
          </label>
        </section>

        {/* Transcription */}
        <section class="settings-section">
          <h3 class="settings-heading">Transcription</h3>
          <label class="control-check settings-toggle">
            <input
              type="checkbox"
              checked={gpuEnabled()}
              onChange={(e) => saveGpuPref(e.currentTarget.checked)}
            />
            <span>Use GPU acceleration when available</span>
          </label>
          <p class="settings-note">
            Speeds up transcription on supported hardware (Apple Silicon), and
            falls back to CPU automatically. Turn off to always use the CPU.
          </p>
        </section>

        {/* Models */}
        <section class="settings-section">
          <h3 class="settings-heading">Whisper models</h3>
          <ModelManager embedded onBusyChange={setModelBusy} />
        </section>
      </div>
    </div>
  );
}
