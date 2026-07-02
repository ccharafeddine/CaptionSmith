<p align="center">
  <img src="src/assets/captionsmith-icon.svg" width="128" alt="CaptionSmith" />
</p>

<h1 align="center">CaptionSmith</h1>

<p align="center">Add captions to any video — transcribed on your own machine.</p>

<p align="center">
  <a href="https://github.com/ccharafeddine/CaptionSmith/actions/workflows/ci.yml">
    <img src="https://github.com/ccharafeddine/CaptionSmith/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
</p>

---

CaptionSmith is a small, fast desktop app for Mac and Windows. Open a local video
(or paste a URL — YouTube and other sites work), and CaptionSmith transcribes the
audio, shows you an editable transcript, lets you style the captions, and exports
either a video with the captions **burned in** or a subtitle **sidecar file**.

The transcription runs **entirely on your machine** with
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) — your audio is never
uploaded anywhere. It's local-first: no accounts, no media library, no telemetry,
no ads. A local video is read in place and never imported or copied. The only
feature that touches the network is URL import (which downloads the video to a
temp file, deleted when you quit) and a one-time model download if you swap in a
larger model.

Built with [Tauri](https://v2.tauri.app) and [SolidJS](https://www.solidjs.com),
with a bundled build of [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
for on-device transcription and a bundled GPL build of
[FFmpeg](https://ffmpeg.org) (including `libx264` and `libass`) for audio
extraction and the caption burn-in.

<p align="center"><b>Load a video</b><br />
  <img src="docs/screenshot-1-load.png" width="90%" alt="A video loaded in CaptionSmith, ready to transcribe" />
</p>

<p align="center"><b>Transcribe on-device, then edit the transcript</b><br />
  <img src="docs/screenshot-2-transcript.png" width="90%" alt="CaptionSmith showing the transcript with a caption previewed over the video" />
</p>

<p align="center"><b>Style the captions over a live preview</b><br />
  <img src="docs/screenshot-3-style.png" width="90%" alt="CaptionSmith's style panel with presets and controls" />
</p>

## How captions work

CaptionSmith extracts the audio, runs it through a local Whisper model, and gives
you back an editable transcript with timestamps. From there you can export two
ways:

- **Burned in.** The captions are rendered onto the video and it's re-encoded to
  an **H.264 / AAC `.mp4`** (`libx264`, CRF 18, visually near-lossless). This is
  what you want for social — the captions are visible everywhere, including the
  muted autoplay feeds where most short-form video is watched. Because it
  re-encodes, it isn't instant and isn't bit-identical to the source; a progress
  bar shows while it works.
- **Sidecar file.** Export a `.srt`, `.vtt`, or `.ass` subtitle file with no
  re-encode. Handy for handing off to a video editor or uploading to platforms
  (like YouTube) that accept subtitle files. Note that most social platforms
  don't render an uploaded subtitle track — for those, use burn-in.

Transcription runs on the CPU and stays on your machine. A longer video takes
longer; a progress bar and a Cancel button show while it runs.

## Features

- Open `mp4`, `mov`, `mkv`, `webm`, `avi`, `m4v` via file picker or drag-and-drop
- **Import from a URL** — paste a YouTube (or other site) link and CaptionSmith
  fetches the video with a bundled [yt-dlp](https://github.com/yt-dlp/yt-dlp),
  with a progress bar and Cancel while it downloads
- **On-device transcription** with whisper.cpp — audio never leaves your machine.
  Ships with an English model, and a built-in **model manager** downloads
  multilingual models (one model covers ~99 languages) for auto language
  detection and **translate-to-English**
- An **editable transcript** synced to the video: fix words, merge/split
  segments, nudge timing, click a line to jump to it, and **insert a caption**
  for non-speech lines like `[laughs]`
- **Caption styles** — a clean bottom bar, a bold social look, and a
  **word-highlight (karaoke)** style where the active word pops, with controls
  for font, size, color, outline, position, and words-per-line, over a live
  preview
- **Burn-in export** to H.264/AAC `.mp4` with a real progress bar, **or** a
  **sidecar** `.srt` / `.vtt` / `.ass`
- Exports default to an **Exports folder** (`<Documents>/CaptionSmith/Exports`),
  created on first export — the save dialog opens there with the name prefilled,
  and you can still save anywhere
- **Clear** the loaded video without opening another
- Dark, minimal interface (follows your system's light/dark setting)
- Native binaries for macOS and Windows

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Enter` | Edit the caption at the playhead |
| `Esc` | Cancel export / close a dialog |

## Install

Download the latest installer from the
[Releases](https://github.com/ccharafeddine/CaptionSmith/releases) page:

- **Windows**: the `.msi`. Windows SmartScreen may warn on an unsigned app;
  choose **More info → Run anyway**.
- **macOS**: the `.dmg` (one universal build runs on both Apple Silicon and
  Intel). The app is unsigned, so the first launch needs the Gatekeeper
  workaround:

  > **Right-click** (or Control-click) the app in Applications → **Open** →
  > **Open** again in the dialog. You only need to do this once.

## Build from source

Prerequisites: [Node.js](https://nodejs.org) 20+ and the
[Rust toolchain](https://rustup.rs).

```bash
npm install

# Provide the bundled FFmpeg/ffprobe sidecars (GPL, with libx264 + libass),
# placed in src-tauri/binaries with the per-target-triple names Tauri expects.
bash scripts/fetch-ffmpeg.sh        # Windows: BtbN GPL static build
bash scripts/build-ffmpeg-macos.sh  # macOS: compile GPL FFmpeg from source
                                    # (needs Xcode CLT + `brew install nasm`)

# Build the whisper.cpp sidecar and download the default model.
bash scripts/fetch-whisper.sh       # builds whisper-cli via CMake, fetches
                                    # ggml-base.en.bin

# Provide the bundled yt-dlp sidecar for URL import (refresh before each release;
# yt-dlp goes stale as sites change their players).
bash scripts/fetch-ytdlp.sh

# Run in development
npm run tauri dev

# Produce a production build for the current platform
npm run tauri build
```

On macOS there's no suitable static GPL FFmpeg, so the sidecars are compiled from
source with `--enable-gpl --enable-libx264`; on a Mac, `bash scripts/fetch-ffmpeg.sh`
delegates to the build script for you. CI builds both platforms on a tag push
(see `.github/workflows/release.yml`).

## Bundled binaries & licensing

CaptionSmith is **GPL-3.0** licensed. The caption burn-in re-encodes with
`libx264`, which is GPL; combining it makes the whole app GPL (the standard
situation for open-source video tools like HandBrake, Shotcut, and OBS). The
transcription side is permissively licensed — the GPL comes only from the burn-in
re-encoder. The binaries are invoked as separate sidecar processes:

- **whisper.cpp** (MIT), on-device transcription. Built from source in CI. Source:
  <https://github.com/ggerganov/whisper.cpp>.
- **Whisper model** `ggml-base.en.bin` (MIT), bundled default; you can supply a
  larger or multilingual model in `<AppData>/CaptionSmith/models`.
- **FFmpeg** (GPL, with `libx264` and `libass`), used for audio extraction and the
  caption burn-in. Windows uses the GPL static build from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds); macOS is compiled
  from the official [FFmpeg](https://ffmpeg.org/download.html) source. Source:
  <https://ffmpeg.org/download.html>.
- **yt-dlp** (Unlicense / public domain), used only for URL import. Refreshed per
  release via `scripts/fetch-ytdlp.sh`. Source:
  <https://github.com/yt-dlp/yt-dlp>.
- **Font**: Syne (SIL Open Font License), bundled in `src/assets/fonts` with its
  license file. No web-font requests are made.

## Roadmap

Possible next steps: more caption styles and per-word emphasis, speaker
labels / diarization, GPU-accelerated transcription (Metal / CUDA), batch
captioning, and an SRT-import path (bring your own transcript, style and burn it).

## License

[GPL-3.0](LICENSE) © Chafic Charafeddine. Bundled FFmpeg is GPL (with `libx264`),
as noted above; whisper.cpp, the ggml models, and libass are permissively
licensed.
