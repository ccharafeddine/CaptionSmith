import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { formatTime } from "../format";

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
};

export default function VideoPlayer(props: VideoPlayerProps) {
  let videoEl!: HTMLVideoElement;

  const [playing, setPlaying] = createSignal(false);
  const [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [scrubbing, setScrubbing] = createSignal(false);

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

  // Space toggles play/pause unless the user is typing in a field.
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);
    if (typing) return;

    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
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
        <video
          ref={videoEl}
          class="player-video"
          src={props.src}
          preload="metadata"
          onLoadedMetadata={() => setDuration(videoEl.duration || 0)}
          onTimeUpdate={() => {
            if (!scrubbing()) setCurrent(videoEl.currentTime);
            props.onTime?.(videoEl.currentTime);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
        />
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
