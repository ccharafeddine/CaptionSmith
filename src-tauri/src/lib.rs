// CaptionSmith — Tauri entry point.
//
// Steps 1–2: scaffold + load/play a local video.
// Step 3: URL import via the bundled yt-dlp sidecar.
// Step 4: audio extraction (ffmpeg -> 16 kHz mono WAV) via the FFmpeg sidecar.
// Transcription, styling, and export commands land in later steps (see
// CLAUDE.md build plan).

mod ffmpeg;
mod sidecar;
mod url_import;

use url_import::DownloadState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(DownloadState::default())
        .invoke_handler(tauri::generate_handler![
            url_import::download_url,
            url_import::cancel_download,
            ffmpeg::extract_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CaptionSmith");
}
