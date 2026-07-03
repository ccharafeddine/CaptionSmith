// CaptionSmith — Tauri entry point.
//
// Steps 1–2: scaffold + load/play a local video.
// Step 3: URL import via the bundled yt-dlp sidecar.
// Step 4: audio extraction (ffmpeg -> 16 kHz mono WAV) via the FFmpeg sidecar.
// Step 5: on-device transcription via the whisper-cli sidecar + bundled model.
// Step 8: sidecar subtitle export (.srt / .vtt / .ass).
// The burn-in export lands in a later step (see CLAUDE.md build plan).

mod ffmpeg;
mod models;
mod proc;
mod sidecar;
mod subtitles;
mod transcribe;
mod updater;
mod url_import;

use ffmpeg::BurnState;
use models::ModelDownloadState;
use tauri::Manager;
use transcribe::TranscribeState;
use url_import::DownloadState;

/// Ensure <Documents>/CaptionSmith/Exports exists and return it, so export save
/// dialogs can default there (created on first export).
#[tauri::command]
fn ensure_export_dir(app: tauri::AppHandle) -> Result<String, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("no Documents directory: {e}"))?;
    let dir = docs.join("CaptionSmith").join("Exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create Exports folder: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DownloadState::default())
        .manage(TranscribeState::default())
        .manage(BurnState::default())
        .manage(ModelDownloadState::default())
        .invoke_handler(tauri::generate_handler![
            url_import::download_url,
            url_import::cancel_download,
            ffmpeg::extract_audio,
            transcribe::transcribe,
            transcribe::cancel_transcribe,
            transcribe::list_models,
            subtitles::export_sidecar,
            ffmpeg::burn_in,
            ffmpeg::cancel_burn,
            models::download_model,
            models::cancel_model_download,
            models::delete_model,
            models::models_folder,
            updater::check_for_update,
            updater::open_release_page,
            ensure_export_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CaptionSmith");
}
