// In-app Whisper model downloader. Fetches multilingual ggml models from the
// whisper.cpp model host into <AppData>/CaptionSmith/models, with streamed
// progress and cancellation. One multilingual model covers ~99 languages, so
// this is what unlocks the Language picker + Translate-to-English in the UI.
//
// This is the only feature besides URL import that touches the network, and
// it's a one-time per-model fetch (README-sanctioned). Downloads are restricted
// to an allowlist of known ggml filenames — never arbitrary URLs.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

const HF_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// Downloadable ggml model files. Restricting to this list keeps `download_model`
/// from being a general-purpose fetch-any-URL primitive.
const ALLOWED: &[&str] = &[
    "ggml-base.bin",
    "ggml-small.bin",
    "ggml-medium.bin",
    "ggml-large-v3-turbo.bin",
];

#[derive(Default)]
pub struct ModelDownloadState {
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct ModelProgress {
    file: String,
    percent: Option<f64>,
    received: u64,
    total: Option<u64>,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .data_dir()
        .map_err(|e| format!("no data directory: {e}"))?
        .join("CaptionSmith")
        .join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create models folder: {e}"))?;
    Ok(dir)
}

/// The models folder path (created if missing), for showing/opening in the UI.
#[tauri::command]
pub fn models_folder(app: AppHandle) -> Result<String, String> {
    Ok(models_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_model(app: AppHandle, file: String) -> Result<(), String> {
    if !ALLOWED.contains(&file.as_str()) {
        return Err("Unknown model file.".into());
    }
    let path = models_dir(&app)?.join(&file);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("could not delete model: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_model_download(state: State<'_, ModelDownloadState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Stream-download an allowlisted ggml model to the models folder, emitting
/// "model-download-progress" and honouring cancellation. Writes to `<file>.part`
/// then renames on success so a partial download is never seen as a real model.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, ModelDownloadState>,
    file: String,
) -> Result<(), String> {
    if !ALLOWED.contains(&file.as_str()) {
        return Err("Unknown model file.".into());
    }
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::SeqCst);

    let dir = models_dir(&app)?;
    let final_path = dir.join(&file);
    let part_path = dir.join(format!("{file}.part"));
    let url = format!("{HF_BASE}{file}");

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    let mut out = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("could not create file: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("download error: {e}"))?;
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("write error: {e}"))?;
        received += chunk.len() as u64;

        // Throttle events to ~every 2 MB to avoid flooding the frontend.
        if received - last_emit >= 2_000_000 {
            last_emit = received;
            let percent = total.map(|t| {
                if t > 0 {
                    received as f64 / t as f64 * 100.0
                } else {
                    0.0
                }
            });
            let _ = app.emit(
                "model-download-progress",
                ModelProgress {
                    file: file.clone(),
                    percent,
                    received,
                    total,
                },
            );
        }
    }

    out.flush().await.map_err(|e| format!("flush error: {e}"))?;
    drop(out);
    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| format!("could not finalize download: {e}"))?;

    let _ = app.emit(
        "model-download-progress",
        ModelProgress {
            file: file.clone(),
            percent: Some(100.0),
            received,
            total,
        },
    );
    Ok(())
}
