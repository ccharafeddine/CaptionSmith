# CLAUDE.md — CaptionSmith

## Project

CaptionSmith is a standalone desktop app for Mac and Windows that adds captions
to a video. The user opens a local video (or pastes a URL), CaptionSmith
transcribes the audio **locally** with `whisper.cpp`, shows an editable
transcript, lets the user pick a caption style, and exports either a video with
the captions **burned in** or a subtitle **sidecar file** (`.srt` / `.vtt` /
`.ass`).

It is a Smith-family tool: single purpose, clean, native, local-first. It does
one thing — turn spoken audio into on-screen captions — and nothing else. No
accounts, no telemetry, no ads, no media library. If a feature isn't in service
of "load video → transcribe → style → export captions," it doesn't belong in v1.

CaptionSmith shares its design language and engineering conventions with its
sibling apps GifSmith and ClipSmith — same minimal native aesthetic, same
Tauri + SolidJS + FFmpeg stack — but it is a fully independent project and
codebase. This document is self-contained; everything needed to build
CaptionSmith from an empty folder is described here.

### Why this matters (the pitch)

Short-form social video is watched **muted by default**, so captions aren't a
nice-to-have, they're the format. Every existing tool that does this well is a
cloud service that uploads your audio to someone else's server behind an account
and a subscription. CaptionSmith does it **entirely on-device**: your audio
never leaves the machine. That privacy-plus-zero-cost story is the whole reason
this app exists — protect it.

### Hard constraints

- No media library, no cache, no telemetry, no ads, no accounts.
- **Transcription is local.** Audio is transcribed on-device with `whisper.cpp`.
  Audio never leaves the machine. This is the core promise; do not add a cloud
  transcription path in v1.
- Source video is read in place from disk, never copied or imported into the
  app. EXCEPTION (same as the siblings): pasting a remote URL downloads it via
  the bundled `yt-dlp` sidecar to an OS temp file, treated as the local source.
- **Zero persistent intermediate files.** The transcription step extracts a
  temporary 16 kHz mono WAV for whisper, and the burn-in step writes a temporary
  `.ass` subtitle file — both in OS temp, both deleted when done. The only files
  kept on disk are the export the user chose (a `.mp4`, or a sidecar `.srt` /
  `.vtt` / `.ass` at the user's path) and, for URL imports, the downloaded
  source in OS temp (deleted on quit).
- Single codebase, cross-platform via Tauri.
- **GPL-3.0 licensed.** The burn-in export re-encodes with `libx264`, which is
  GPL, so bundling it makes the whole app GPL — the same situation as ClipSmith
  (and HandBrake, Shotcut, OBS). See "Bundled binaries & licensing."

## The licensing decision, stated plainly (read this before building export)

There are two export paths, and they have different license implications:

1. **Sidecar subtitle file** (`.srt` / `.vtt` / `.ass`). No re-encode — just
   serialize the transcript to a text subtitle format. License-clean on its own.
   But **most social platforms (Instagram, TikTok, etc.) do not render an
   uploaded subtitle track**, so for the marketing use case this is a secondary
   output, useful mainly for handing off to a video editor or to YouTube.

2. **Burned-in captions** (hardsub). The captions are rendered onto the pixels,
   which requires a full **re-encode with `libx264`**. This is the output the
   marketing use case actually needs (visible everywhere, muted or not), and it
   is what makes the app **GPL-3.0**.

Because path 2 is the primary feature, CaptionSmith ships GPL-3.0, exactly like
ClipSmith. Do not try to avoid this by making burn-in optional-but-absent; it's
the point of the app. Ship both paths; the app is GPL regardless because it
bundles the GPL FFmpeg build.

## Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2.x | Native binary, ~15 MB shell, system webview |
| Frontend | SolidJS + TypeScript + Vite | Fine-grained reactivity, smooth timeline + transcript editing |
| Styling | Plain CSS with custom properties | Shared Smith tokens, dark-first, no framework overhead |
| Transcription | Bundled `whisper.cpp` (MIT) as a Tauri sidecar | On-device speech-to-text; segment and word-level timestamps |
| Model | ggml Whisper model (MIT), `base.en` default | Good English accuracy, fast on CPU; swappable |
| Audio extract + burn-in | Bundled FFmpeg (GPL, with `libx264`) as a sidecar | 16 kHz WAV for whisper; `ass` filter burn-in re-encode |
| Subtitle styling | libass (ISC), via FFmpeg's `ass` filter | Full styling incl. per-word (karaoke) highlight |
| URL import | Bundled `yt-dlp` (Unlicense) as a sidecar | Same as siblings |
| Build/release | GitHub Actions + `tauri-action` | Auto-builds `.dmg` and `.msi` on tag push |

Rationale for matching the sibling stack: same toolchain, smallest binary,
native file dialogs, and the FFmpeg sidecar plumbing (progress parsing, cancel
races) is already a solved problem in ClipSmith to copy from.

## The whisper model: bundle it (recommended) vs download on first run

**Recommendation: bundle `ggml-base.en.bin` (~148 MB) in the installer.** This
makes CaptionSmith work **fully offline from first launch** with zero setup,
which is the strongest expression of the local-first promise. The cost is a
~150 MB installer instead of ~15 MB. Take that trade; it's worth it.

- Let the user **swap in a larger model** (`small.en` ~488 MB, `medium.en`
  ~1.5 GB, or a multilingual model) by dropping a `ggml-*.bin` into a known
  folder (`<AppData>/CaptionSmith/models`) and picking it in settings. Larger
  models = better accuracy, slower transcribe. Surface that trade in the UI.
- Multilingual models unlock **auto-detect language** and **translate-to-English**
  (whisper's `translate` task) — a one-flag bonus. `base.en` is English-only; if
  the user wants those, they point at a non-`.en` model.
- If binary size becomes a real objection, the fallback is download-on-first-run
  with a progress bar and resume (mirror SceneCraft's weight-download UX). But
  default to bundling.

## Pipeline

```
video ──ffmpeg──▶ 16kHz mono WAV (temp)
                        │
                   whisper.cpp ──▶ segments [+ word timestamps]  (editable)
                        │
                user edits text / timing / picks style
                        │
        ┌───────────────┴───────────────┐
   sidecar export                   burn-in export
   serialize .srt/.vtt/.ass         build .ass (temp) ──ffmpeg ass filter──▶
   at user path (no re-encode)      libx264 CRF 18 re-encode ──▶ .mp4
```

- **Audio extract:** `ffmpeg -i <src> -vn -ac 1 -ar 16000 -c:a pcm_s16le <tmp.wav>`.
  whisper wants 16 kHz mono PCM.
- **Transcribe:** run the `whisper-cli` sidecar against the WAV, request JSON
  output with timestamps. For **word-highlight (karaoke)** styles you need
  **word-level** timestamps — whisper.cpp supports this (split-on-word / token
  timestamps); consult `whisper-cli --help` for the current flag names rather
  than hard-coding them, and only request word-level timing when a word-highlight
  style is selected (it's slower). Parse whisper's progress from stderr and emit
  it to the frontend; make transcription **cancellable** using the same
  `tokio::select!` cancel-flag race ClipSmith uses for yt-dlp.
- **Burn-in:** build an `.ass` file from the segments + chosen style, then
  `ffmpeg -i <src> -vf "ass=<tmp.ass>" -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k <out.mp4>`.
  Parse `time=` from FFmpeg stderr for a real progress bar (same as ClipSmith).
  Output is always `.mp4`.
- **Sidecar:** serialize segments straight to `.srt` / `.vtt` / `.ass`. No
  FFmpeg, no re-encode.

## Build plan (do these in order; log each step in `progress.txt`)

Keep a running `progress.txt` log exactly like the sibling repos: what you did,
what you verified (build/clippy/test), and what still needs live-window testing.

1. **Scaffold.** Tauri 2 + SolidJS + TS + Vite. Wire the shared design tokens
   (see "Design tokens" below) into `src/tokens.css`, imported once globally.
   Bundle the Syne font locally in `src/assets/fonts` (no web-font requests).
2. **Load a video.** File picker + drag-and-drop for
   `mp4, mov, mkv, webm, avi, m4v`; asset-protocol playback in a `<video>`.
   Keep audio. Basic play/pause + seekbar. (Copy the load/asset-protocol setup
   from GifSmith/ClipSmith; the `assetProtocol` scope `["**"]` is fine.)
3. **URL import.** Bundle `yt-dlp`; paste-a-URL downloads to temp with a
   progress bar + Cancel, then loads it as the source. Lift this almost verbatim
   from ClipSmith (`fetch-ytdlp.sh`, the cancel-race download command, the
   `download-progress` event).
4. **Audio extract command.** Rust command that runs the FFmpeg WAV extraction
   above to an OS temp file. **Do not** use the shell plugin for anything you
   stream/parse — it inserts `\n` between stdout chunks (plugins-workspace
   #3090). Spawn FFmpeg via `std::process::Command`, the same finding as GifSmith.
5. **whisper.cpp sidecar + model.** Bundle the `whisper-cli` binary and the
   default `ggml-base.en.bin`. A `transcribe` command runs whisper on the temp
   WAV, emits `transcribe-progress`, is cancellable, and returns parsed segments
   (`{ start, end, text }`, plus optional `words: [{ start, end, text }]`). If
   the model file is missing, surface a clear "model not found" state with a
   pointer — never try to fix the environment from inside the app.
6. **Transcript editor.** Show segments as an editable list synced to the
   timeline: edit text inline, merge/split segments, nudge start/end, delete.
   Clicking a segment seeks the player to it. A language picker
   (auto / English / …) and a **translate-to-English** toggle (only meaningful
   with a multilingual model — disable + explain otherwise).
7. **Caption styles + live preview.** Overlay captions on the player as the user
   scrubs. Ship three presets:
   - **Bottom bar** — clean one/two-line subtitle in a semi-transparent box.
   - **Bold social** — large, lower-centered, heavy weight, thick outline, no
     box (the Reels/TikTok look).
   - **Word highlight** — karaoke; the active word pops. Requires word-level
     timestamps (request them lazily when this style is chosen).
   Controls: font (bundled Syne + a couple of alternates), size, primary color,
   outline/shadow, vertical position, max words (or chars) per line, UPPERCASE
   toggle, safe-margin. The live preview is an **HTML approximation**; the
   burn-in uses libass, so note that the exported look is authoritative and may
   differ slightly. Keep the control set tight — this is not a titling suite.
8. **Sidecar export.** Serialize the (edited) transcript to `.srt`, `.vtt`, and
   `.ass`. Save dialog defaults to `<Documents>/CaptionSmith/Exports` with the
   filename prefilled `<source_stem>.srt` (etc.). No re-encode.
9. **Burn-in export.** Build the `.ass` from segments + style (escape `{`, `}`,
   and newlines properly for ASS!), run the libx264 re-encode from the Pipeline
   section with a real `time=`-parsed progress bar and a Cancel. Output defaults
   to `<Documents>/CaptionSmith/Exports/<source_stem>_captioned.mp4`. Verify the
   captions are visible and in sync in a normal player.
10. **Keyboard shortcuts.** `Space` play/pause; `←`/`→` step one frame;
    `Enter` edit the segment at the playhead; `Esc` cancel export / close dialog.
11. **Theming.** Dark-first via the shared tokens; a light variant via
    `@media (prefers-color-scheme: light)` is fine but dark is the identity.
    Test on Mac and Windows.
12. **Release workflow.** `.github/workflows/release.yml` using
    `tauri-apps/tauri-action`, triggered on `v*` tag push: a **universal** macOS
    `.dmg` on `macos-14` (arm64 native + x86_64 cross, `--target
    universal-apple-darwin`) and a Windows `.msi` on `windows-latest`. Avoid the
    deprecated `macos-13` Intel runner. Before the bundle step, fetch/build all
    sidecars: FFmpeg (GPL + `libx264` — prebuilt on Windows, compiled from source
    with `--enable-gpl --enable-libx264` on macOS), `yt-dlp`, and `whisper.cpp` +
    the default model (`scripts/fetch-whisper.sh` — build whisper from source via
    CMake for portability, then download `ggml-base.en.bin`). Draft release with
    `.dmg` + `.msi` attached.
13. **README + screenshots.** Ship the README (provided). Add light + dark
    screenshots. Document that burn-in is a re-encode (not instant, not
    bit-identical) so it reads as expected behavior, not a bug.

## Design tokens (shared Smith family palette — put in `src/tokens.css`)

Same cyberminimalism as GifSmith and ClipSmith: near-black, monochrome, one
violet accent, one cyan secondary. The caption text in the preview is the main
"color event" alongside the video frame.

```css
:root {
  color-scheme: dark;

  --bg-base: #0a0a0a;      /* app canvas */
  --bg-panel: #141414;     /* panels / modal */
  --bg-control: #1e1e1e;   /* raised controls */

  --fg: #ededed;           /* primary text */
  --fg-2: #9a9a9a;         /* secondary */
  --fg-3: #5e5e5e;         /* tertiary */

  --accent: #a974ff;       /* electric violet — primary accent, trim handles */
  --accent-fg: #ffffff;
  --accent-2: #45f2f2;     /* electric cyan — the "Smith" wordmark, glyphs */
  --accent-2-fg: #062020;

  --grad: linear-gradient(135deg, #c6acff 0%, #a974ff 50%, #8a4dff 100%);

  --border: #262626;
  --danger: #ff5d5d;

  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px;
  --r-control:6px; --r-panel:12px;

  --font-display: "Syne", -apple-system, "Segoe UI", system-ui, sans-serif;
  --font-body: "Syne", -apple-system, "Segoe UI", system-ui, sans-serif;
}
```

## App icon (`src/assets/captionsmith-icon.svg`)

Same family mark: the violet trim-handle frame around a cyan glyph on a
near-black squircle. GifSmith's glyph is a play triangle, ClipSmith's is a
filmstrip; CaptionSmith's is a **caption block** (two stacked rounded bars, a
lower-third). Pure shapes, no fonts.

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="violet" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c6acff"/>
      <stop offset="0.5" stop-color="#a974ff"/>
      <stop offset="1" stop-color="#8a4dff"/>
    </linearGradient>
  </defs>

  <rect width="1024" height="1024" rx="224" fill="#0a0a0a"/>

  <!-- selection rails (top + bottom) -->
  <rect x="250" y="312" width="524" height="30" fill="url(#violet)"/>
  <rect x="250" y="682" width="524" height="30" fill="url(#violet)"/>

  <!-- trim handles (left + right) with grip notches -->
  <rect x="250" y="312" width="84" height="400" rx="18" fill="url(#violet)"/>
  <rect x="690" y="312" width="84" height="400" rx="18" fill="url(#violet)"/>
  <rect x="288" y="462" width="8" height="100" rx="4" fill="#0a0a0a"/>
  <rect x="728" y="462" width="8" height="100" rx="4" fill="#0a0a0a"/>

  <!-- caption block (cyan accent): two stacked rounded bars -->
  <rect x="372" y="452" width="280" height="46" rx="14" fill="#45f2f2"/>
  <rect x="372" y="526" width="188" height="46" rx="14" fill="#45f2f2"/>
</svg>
```

## Gotchas

- **Burn-in is a re-encode.** Same as ClipSmith: not instant, not bit-identical.
  CRF 18 / `preset medium` is visually near-lossless. Show a progress bar; don't
  pretend it's a copy.
- **Shell plugin corrupts binary streams.** `tauri-plugin-shell` inserts `\n`
  between stdout chunks (plugins-workspace #3090). Spawn FFmpeg (and read
  whisper's output) via `std::process::Command`, not the shell plugin, for
  anything you parse byte-exactly. Straight from the GifSmith notes.
- **ASS escaping.** Transcript text can contain `{`, `}`, backslashes, and
  newlines that break `.ass` parsing or inject override tags. Sanitize every
  segment before writing the `.ass`. This is a correctness *and* safety issue
  (don't let transcript text become style overrides).
- **Word-level timestamps cost time.** Only request them when a word-highlight
  style is active. Don't make every transcription pay for them.
- **The app does not own the model.** If `ggml-*.bin` is missing (e.g. user
  deleted the bundled one, or points at a bad path), show a clear pointer to the
  models folder. Never silently re-download or "fix" the environment mid-run.
- **Whisper runs on CPU in v1.** Portable everywhere, no GPU assumptions. GPU
  acceleration (Metal on macOS, CUDA/Vulkan on Windows) is a build-flag nicety
  for later, not a v1 requirement. A long video on CPU can take a while — that's
  what the progress bar and Cancel are for.
- **Solid reactivity.** Don't destructure props (breaks reactivity); access via
  `props.x`. Same pitfall as GifSmith and SceneCraft.
- **Model licensing is clean; encoding isn't.** whisper.cpp (MIT), the ggml
  models (MIT), and libass (ISC) are all permissive. The GPL comes *only* from
  `libx264` in the burn-in path. Keep that mental model straight when documenting.

## Bundled binaries & licensing

CaptionSmith is **GPL-3.0** licensed, because the burn-in export re-encodes with
`libx264` (GPL), and combining it makes the whole app GPL — the standard
situation for open-source video tools (HandBrake, Shotcut, OBS). The bundled
binaries are invoked as separate sidecar processes:

- **whisper.cpp** (MIT), on-device transcription. Built from source via CMake in
  CI (`scripts/fetch-whisper.sh`). Source: <https://github.com/ggerganov/whisper.cpp>.
- **Whisper model** `ggml-base.en.bin` (MIT), bundled default; larger models are
  user-supplied. Source: whisper.cpp model host.
- **FFmpeg** (GPL, with `libx264`), audio extraction + the caption burn-in
  re-encode. Windows uses the GPL static build from BtbN/FFmpeg-Builds; macOS is
  compiled from source with `--enable-gpl --enable-libx264` against a static
  `libx264`. Source: <https://ffmpeg.org/download.html>.
- **libass** (ISC), subtitle rendering, via FFmpeg's `ass` filter (part of the
  FFmpeg build).
- **yt-dlp** (Unlicense / public domain), URL import only. Refreshed per release
  via `scripts/fetch-ytdlp.sh`. Source: <https://github.com/yt-dlp/yt-dlp>.
- **Font**: Syne (SIL Open Font License), bundled in `src/assets/fonts` with its
  license file. No web-font requests.

## Roadmap

Possible next steps: more caption style presets and per-word emphasis effects,
speaker labels / diarization, GPU-accelerated transcription (Metal/CUDA),
batch captioning of multiple files, and an SRT-import path (bring your own
transcript, style + burn it). None of these are v1.

## License

GPL-3.0 © Chafic Charafeddine. Bundled FFmpeg is GPL (with `libx264`), as noted
above; whisper.cpp, the ggml models, and libass are permissively licensed.
