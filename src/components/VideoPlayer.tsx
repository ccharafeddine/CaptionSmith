import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { formatTime } from "../format";
import { isFormControl } from "../keys";

// No API exposes a video's real frame rate, so step by a sensible default.
// Fine for reviewing caption timing; exact frame accuracy isn't required.
const FRAME = 1 / 30;

export type PlayerControls = {
  /** Seek the player to `seconds` (used by the transcript panel). */
  seek: (seconds: number) => void;
};

type VideoPlayerProps = {
  /** Asset-protocol URL produced by convertFileSrc(path). */
  src: string;
  /** Original on-disk path, shown in the status strip. */
  path: string;
  /** Human filename for the header. */
  name: string;
  /** Receives an imperative controls handle once the element is mounted. */
  onReady?: (controls: PlayerControls) => void;
  /** Fires on playback time updates (drives transcript playhead sync). */
  onTime?: (seconds: number) => void;
  /** Overlay rendered inside the video stage (the caption preview). */
  children?: JSX.Element;
};

export default function VideoPlayer(props: VideoPlayerProps) {
  let videoEl!: HTMLVideoElement;

  const [playing, setPlaying] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [scrubbing, setScrubbing] = createSignal(false);
  // Intrinsic video size, so the caption overlay can hug the exact video
  // rectangle (matching the burn-in, which sizes captions to the video height).
  const [dims, setDims] = createSignal<{ w: number; h: number } | null>(null);

  const togglePlay = () => {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  };

  const onSeek = (e: Event) => {
    const value = Number((e.currentTarget as HTMLInputElement).value);
    setCurrent(value);
    if (videoEl) videoEl.currentTime = value;
  };

  // Step one frame; stepping implies paused review, so pause first.
  const stepFrame = (dir: number) => {
    if (!videoEl) return;
    videoEl.pause();
    const dur = videoEl.duration || Infinity;
    const next = Math.min(Math.max(videoEl.currentTime + dir * FRAME, 0), dur);
    videoEl.currentTime = next;
    setCurrent(next);
  };

  // Media shortcuts, ignored while a form control is focused.
  const onKeyDown = (e: KeyboardEvent) => {
    if (isFormControl(e.target)) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      stepFrame(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stepFrame(1);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    props.onReady?.({
      seek: (seconds: number) => {
        if (!videoEl) return;
        videoEl.currentTime = seconds;
        setCurrent(seconds);
      },
    });
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div class="player">
      <div class="player-stage">
        <div
          class="video-frame"
          style={{
            "aspect-ratio": dims() ? `${dims()!.w} / ${dims()!.h}` : "16 / 9",
          }}
        >
        <video
          ref={videoEl}
          class="player-video"
          src={props.src}
          preload="metadata"
          onLoadedMetadata={() => {
            setDuration(videoEl.duration || 0);
            if (videoEl.videoWidth && videoEl.videoHeight) {
              setDims({ w: videoEl.videoWidth, h: videoEl.videoHeight });
            }
          }}
          onTimeUpdate={() => {
            if (!scrubbing()) setCurrent(videoEl.currentTime);
            props.onTime?.(videoEl.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
        />
        {props.children}
        </div>
      </div>

      <div class="player-controls">
        <button
          class="icon-btn"
          type="button"
          onClick={togglePlay}
          title={playing() ? "Pause (Space)" : "Play (Space)"}
          aria-label={playing() ? "Pause" : "Play"}
        >
          <Show when={playing()} fallback={<PlayGlyph />}>
            <PauseGlyph />
          </Show>
        </button>

        <span class="time">{formatTime(current())}</span>

        <input
          class="seekbar"
          type="range"
          min={0}
          max={duration() || 0}
          step={0.01}
          value={current()}
          onInput={onSeek}
          onPointerDown={() => setScrubbing(true)}
          onPointerUp={() => setScrubbing(false)}
          aria-label="Seek"
        />

        <span class="time time-total">{formatTime(duration())}</span>
      </div>

      <div class="player-status" title={props.path}>
        {props.name}
      </div>
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function PauseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" />
    </svg>
  );
}
