# Docs / screenshots

The project README embeds two screenshots that need to be captured from a
running build (they can't be generated from source — they're pictures of the
real app window). Drop them here with these exact names, then enable the
commented `<img>` block near the top of the root `README.md`:

- `screenshot-dark.png` — the app in the dark theme (the default identity)
- `screenshot-light.png` — the app in the light theme

## How to capture

1. Run the app: `npm run tauri dev`.
2. Load a short video and **Transcribe** it, then pick a caption style so the
   frame shows the whole workflow: the player with the live caption overlay
   (ideally the **Bold social** or **Word highlight** preset so captions are
   prominent), the editable transcript on the right, and the export bar.
3. Capture the window:
   - **macOS:** `Cmd+Shift+4`, then press `Space` and click the window.
   - **Windows:** `Alt+PrintScreen` (active window), or Snipping Tool.
4. Save as `docs/screenshot-dark.png`.
5. Switch your OS appearance to **Light**, relaunch (or let it re-theme), and
   repeat to produce `docs/screenshot-light.png`.

Aim for a similar crop/aspect for both so they sit evenly side by side. PNG,
roughly 1200–1600px wide is plenty.
