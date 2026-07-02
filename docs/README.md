# Docs / screenshots

The project README embeds three screenshots that walk through the workflow:

- `screenshot-1-load.png` — a video loaded, before transcription
- `screenshot-2-transcript.png` — after transcription, with the editable
  transcript and a caption previewed over the video
- `screenshot-3-style.png` — the Style tab with presets and controls

They're captured from the running app (they're pictures of the real window, so
they can't be generated from source).

## Refreshing them

1. Run the app: `npm run tauri dev`.
2. Load a short video and reproduce each state (load → transcribe → Style tab).
3. Capture the window (**Windows:** `Win+Shift+S` or `Alt+PrtScn`; **macOS:**
   `Cmd+Shift+4` then `Space` and click the window).
4. Save over the files above with the same names and a similar crop, then
   commit. The README references them by path, so no markup changes are needed.
