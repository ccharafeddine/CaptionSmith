// CaptionSmith — Tauri entry point.
//
// Steps 1–2: scaffold + load/play a local video. Transcription, styling, and
// export commands land in later steps (see CLAUDE.md build plan).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running CaptionSmith");
}
