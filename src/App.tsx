import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";

import VideoPlayer from "./components/VideoPlayer";

const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "avi", "m4v"];

type LoadedVideo = {
  path: string;
  src: string;
  name: string;
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

  const loadPath = (path: string) => {
    if (!hasVideoExtension(path)) {
      setError(
        `Unsupported file. CaptionSmith opens ${VIDEO_EXTENSIONS.join(", ")}.`,
      );
      return;
    }
    setError(null);
    setVideo({ path, src: convertFileSrc(path), name: basename(path) });
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof selected === "string") loadPath(selected);
  };

  const clearVideo = () => {
    setVideo(null);
    setError(null);
  };

  onMount(async () => {
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
        if (first) loadPath(first);
      }
    });
    onCleanup(unlisten);
  });

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
        <Show
          when={video()}
          fallback={
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
                <Show when={error()}>
                  <p class="dropzone-error">{error()}</p>
                </Show>
              </div>
            </div>
          }
        >
          {(v) => <VideoPlayer src={v().src} path={v().path} name={v().name} />}
        </Show>
      </main>

      <Show when={dragging()}>
        <div class="drag-overlay">
          <p>Release to load</p>
        </div>
      </Show>
    </div>
  );
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
