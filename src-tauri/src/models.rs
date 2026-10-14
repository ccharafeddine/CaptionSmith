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
use sha2::{Digest, Sha256};
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

/// Only exact allowlisted filenames may be downloaded/deleted — this is what
/// keeps `download_model` from being a fetch-any-URL primitive and blocks any
/// path traversal (e.g. "../../foo") from ever reaching a filesystem join.
fn is_allowed(file: &str) -> bool {
    ALLOWED.contains(&file)
}

/// SHA-256 of each allowlisted model, from the Git LFS pointers published at
/// https://huggingface.co/ggerganov/whisper.cpp/raw/main/<file> (fetched
/// 2026-10-14). A download whose digest doesn't match is discarded, so a
/// truncated, corrupted, or swapped file is never installed as a model.
const SHA256: &[(&str, &str)] = &[
    (
        "ggml-base.bin",
        "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    ),
    (
        "ggml-small.bin",
        "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    ),
    (
        "ggml-medium.bin",
        "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    ),
    (
        "ggml-large-v3-turbo.bin",
        "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    ),
];

fn expected_sha256(file: &str) -> Option<&'static str> {
    SHA256.iter().find(|(f, _)| *f == file).map(|(_, h)| *h)
}

/// Lowercase hex encoding of a digest.
fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// Compare a computed digest against the known hash for `file`.
fn verify_digest(file: &str, digest: &[u8]) -> Result<(), String> {
    let expected = expected_sha256(file).ok_or("No checksum is known for this model.")?;
    let actual = to_hex(digest);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "The downloaded model failed its checksum (expected {expected}, got {actual}). It was discarded; try again."
        ))
    }
}

fn model_url(file: &str) -> String {
    format!("{HF_BASE}{file}")
}

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
    if !is_allowed(&file) {
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
    if !is_allowed(&file) {
        return Err("Unknown model file.".into());
    }
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::SeqCst);

    let dir = models_dir(&app)?;
    let final_path = dir.join(&file);
    let part_path = dir.join(format!("{file}.part"));
    let url = model_url(&file);

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
    let mut hasher = Sha256::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("download error: {e}"))?;
        hasher.update(&chunk);
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
    if let Err(e) = verify_digest(&file, &hasher.finalize()) {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(e);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_known_models() {
        assert!(is_allowed("ggml-base.bin"));
        assert!(is_allowed("ggml-large-v3-turbo.bin"));
    }

    #[test]
    fn allowlist_rejects_unknown_and_traversal() {
        assert!(!is_allowed("ggml-huge.bin"));
        assert!(!is_allowed("../../etc/passwd"));
        assert!(!is_allowed("ggml-base.bin/../../x"));
        assert!(!is_allowed(""));
        assert!(!is_allowed("ggml-base.en.bin")); // bundled default isn't downloadable
    }

    #[test]
    fn url_is_the_whisper_cpp_host() {
        assert_eq!(
            model_url("ggml-small.bin"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }

    #[test]
    fn every_allowlisted_model_has_a_sha256() {
        for f in ALLOWED {
            let h = expected_sha256(f).unwrap_or_else(|| panic!("no hash for {f}"));
            assert_eq!(h.len(), 64, "{f}");
            assert!(h
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        }
        assert_eq!(expected_sha256("ggml-evil.bin"), None);
    }

    #[test]
    fn digest_matching_accepts_known_and_rejects_others() {
        // Feed bytes whose hash we know: sha256("") is a fixed vector.
        let empty = Sha256::digest(b"");
        assert_eq!(
            to_hex(&empty),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let err = verify_digest("ggml-base.bin", &empty).unwrap_err();
        assert!(err.contains("checksum"));
        assert!(verify_digest("not-a-model.bin", &empty).is_err());
    }

    #[test]
    fn hex_decoding_round_trips_a_table_entry() {
        let h = expected_sha256("ggml-small.bin").unwrap();
        let bytes: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        assert!(verify_digest("ggml-small.bin", &bytes).is_ok());
    }
}
