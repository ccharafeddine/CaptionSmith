import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

import VideoPlayer from "./components/VideoPlayer";
import SidePanel from "./components/SidePanel";
import CaptionOverlay from "./components/CaptionOverlay";
import ExportBar from "./components/ExportBar";
import { loadModels, setSource, transcript } from "./transcription";

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

type LoadedVideo = {
  path: string;
  src: string;
  name: string;
};

type DownloadProgress = {
  percent: number | null;
  line: string;
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function hasVideoExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return VIDEO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

export default function App() {
  const [video, setVideo] = createSignal<LoadedVideo | null>(null);
  const [dragging, setDragging] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [url, setUrl] = createSignal("");
  const [importing, setImporting] = createSignal(false);
  const [percent, setPercent] = createSignal<number | null>(null);
  const [statusLine, setStatusLine] = createSignal("");

  // Imperative seek handle registered by the player, driven by the transcript.
  let playerSeek: ((seconds: number) => void) | undefined;
  const [currentTime, setCurrentTime] = createSignal(0);

  const show = (path: string) => {
    setError(null);
    setVideo({ path, src: convertFileSrc(path), name: basename(path) });
    setSource(path); // reset the shared transcript for the new source
  };

  const openPicked = (path: string) => {
    if (!hasVideoExtension(path)) {
      setError(
        `Unsupported file. CaptionSmith opens ${VIDEO_EXTENSIONS.join(", ")}.`,
      );
      return;
    }
    show(path);
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected === "string") openPicked(selected);
  };

  const importUrl = async () => {
    if (importing()) return;
    const value = url().trim();
    if (!value) {
      setError("Paste a video URL first.");
      return;
    }

    setError(null);
    setImporting(true);
    setPercent(null);
    setStatusLine("Starting download…");

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<DownloadProgress>("download-progress", (event) => {
        setPercent(event.payload.percent);
        if (event.payload.line) setStatusLine(event.payload.line);
      });
      // yt-dlp downloads to an OS temp file; the returned path is the source.
      const path = await invoke<string>("download_url", { url: value });
      show(path);
      setUrl("");
    } catch (e) {
      const message = String(e);
      // Cancel is a user action, not an error to surface loudly.
      if (message !== "cancelled") setError(message);
    } finally {
      unlisten?.();
      setImporting(false);
      setPercent(null);
      setStatusLine("");
    }
  };

  const cancelImport = async () => {
    await invoke("cancel_download");
  };

  const clearVideo = () => {
    setVideo(null);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && importing()) {
      e.preventDefault();
      void cancelImport();
    }
  };

  onMount(async () => {
    window.addEventListener("keydown", onKeyDown);
    void loadModels();

    // Tauri's native drag-drop; HTML5 dnd is suppressed by the webview.
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const { type } = event.payload;
      if (type === "over" || type === "enter") {
        setDragging(true);
      } else if (type === "leave") {
        setDragging(false);
      } else if (type === "drop") {
        setDragging(false);
        const first = event.payload.paths[0];
        if (first) openPicked(first);
      }
    });
    onCleanup(unlisten);
  });

  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  return (
    <div class="app" classList={{ "is-dragging": dragging() }}>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">Caption</span>
          <span class="brand-mark brand-accent">Smith</span>
        </div>
        <Show when={video()}>
          <button class="ghost-btn" type="button" onClick={clearVideo}>
            Clear
          </button>
        </Show>
      </header>

      <main class="main">
        <Show when={video()} fallback={<EmptyState />}>
          {(v) => (
            <div class="workspace">
              <VideoPlayer
                src={v().src}
                path={v().path}
                name={v().name}
                onReady={(c) => (playerSeek = c.seek)}
                onTime={setCurrentTime}
              >
                <CaptionOverlay currentTime={currentTime} />
              </VideoPlayer>
              <SidePanel
                currentTime={currentTime}
                onSeek={(t) => playerSeek?.(t)}
              />
            </div>
          )}
        </Show>
      </main>

      <Show when={video() && transcript.segments.length > 0}>
        <ExportBar videoPath={video()!.path} videoName={video()!.name} />
      </Show>

      <Show when={dragging()}>
        <div class="drag-overlay">
          <p>Release to load</p>
        </div>
      </Show>
    </div>
  );

  function EmptyState() {
    return (
      <div class="empty">
        <Show when={!importing()} fallback={<DownloadingPanel />}>
          <div class="dropzone" onClick={pickFile}>
            <div class="dropzone-inner">
              <CaptionGlyph />
              <p class="dropzone-title">Drop a video here</p>
              <p class="dropzone-sub">
                or <span class="link">browse</span> to open a file
              </p>
              <p class="dropzone-formats">
                {VIDEO_EXTENSIONS.map((e) => `.${e}`).join("  ")}
              </p>
            </div>
          </div>

          <div class="url-bar">
            <input
              class="url-input"
              type="text"
              placeholder="or paste a video URL (YouTube and other sites)"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void importUrl();
              }}
            />
            <button class="primary-btn" type="button" onClick={importUrl}>
              Import
            </button>
          </div>

          <Show when={error()}>
            <p class="dropzone-error">{error()}</p>
          </Show>
        </Show>
      </div>
    );
  }

  function DownloadingPanel() {
    return (
      <div class="downloading">
        <p class="downloading-title">Downloading…</p>
        <div class="progress-track">
          <div
            class="progress-fill"
            classList={{ indeterminate: percent() === null }}
            style={
              percent() !== null ? { width: `${percent()}%` } : undefined
            }
          />
        </div>
        <p class="downloading-meta">
          <Show when={percent() !== null} fallback={<span>Working…</span>}>
            <span>{percent()!.toFixed(1)}%</span>
          </Show>
          <span class="downloading-line" title={statusLine()}>
            {statusLine()}
          </span>
        </p>
        <button class="ghost-btn" type="button" onClick={cancelImport}>
          Cancel (Esc)
        </button>
      </div>
    );
  }
}

function CaptionGlyph() {
  return (
    <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">
      <rect
        x="6"
        y="14"
        width="52"
        height="36"
        rx="6"
        fill="none"
        stroke="var(--fg-3)"
        stroke-width="2.5"
      />
      <rect x="16" y="28" width="24" height="4" rx="2" fill="var(--accent-2)" />
      <rect x="16" y="37" width="16" height="4" rx="2" fill="var(--accent-2)" />
    </svg>
  );
}
