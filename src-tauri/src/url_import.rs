// URL import: download a remote video to an OS temp file with the bundled
// yt-dlp sidecar, streaming progress to the frontend and staying cancellable.
//
// Mirrors ClipSmith's download-with-cancel: spawn via std::process::Command,
// parse yt-dlp's --newline progress, emit "download-progress", and race a
// cancel flag that also kills the child. The downloaded file lives in OS temp
// and is treated as the local source (deleted on quit / when cleared).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::sidecar;

/// Shared state so `cancel_download` can reach the in-flight child.
#[derive(Default)]
pub struct DownloadState {
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Clone, Serialize)]
struct Progress {
    /// 0.0–100.0 when a percentage was parsed from the line.
    percent: Option<f64>,
    /// The raw yt-dlp status line (e.g. "[download]  12.3% of ~10MiB ...").
    line: String,
}

// Distinguishes temp output dirs across concurrent/successive imports without
// needing a RNG (Math.random()/Date::now() aren't available here anyway).
static DL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Pull a "12.3" out of a "... 12.3% ..." status line.
fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let head = line[..idx].trim_end();
    let digits: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse::<f64>().ok()
}

#[tauri::command]
pub async fn download_url(
    app: AppHandle,
    state: State<'_, DownloadState>,
    url: String,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Enter a URL.".into());
    }

    let yt = sidecar::resolve("yt-dlp")?;

    let cancel = state.cancel.clone();
    let child_slot = state.child.clone();
    cancel.store(false, Ordering::SeqCst);

    let id = DL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut out_dir = std::env::temp_dir();
    out_dir.push(format!("captionsmith-dl-{}-{}", std::process::id(), id));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("temp dir: {e}"))?;
    let out_tmpl = out_dir.join("source.%(ext)s");

    tauri::async_runtime::spawn_blocking(move || {
        run_download(app, cancel, child_slot, yt, url, out_dir, out_tmpl)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
pub fn cancel_download(state: State<'_, DownloadState>) {
    state.cancel.store(true, Ordering::SeqCst);
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[allow(clippy::too_many_arguments)]
fn run_download(
    app: AppHandle,
    cancel: Arc<AtomicBool>,
    child_slot: Arc<Mutex<Option<Child>>>,
    yt: PathBuf,
    url: String,
    out_dir: PathBuf,
    out_tmpl: PathBuf,
) -> Result<String, String> {
    let mut cmd = Command::new(&yt);
    cmd.arg("--newline")
        .arg("--no-playlist")
        .arg("--no-part")
        // Prefer a single pre-muxed mp4 so we don't depend on ffmpeg merging
        // at this stage; fall back to whatever single best stream exists.
        .arg("-f")
        .arg("best[ext=mp4]/best")
        .arg("-o")
        .arg(&out_tmpl)
        // `--` ends option parsing so a URL that starts with "-" (or a crafted
        // "--exec …" string pasted as a link) can't be treated as a yt-dlp flag.
        .arg("--")
        .arg(&url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: don't flash a console window on spawn.
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start yt-dlp: {e}"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    // Hand the child to shared state so cancel_download can kill it.
    *child_slot.lock().unwrap() = Some(child);

    // Drain stderr on a thread: yt-dlp emits both progress and errors here in
    // some builds, so parse it for progress too and keep the text for reporting.
    let app_err = app.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut collected = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(percent) = parse_percent(&line) {
                let _ = app_err.emit(
                    "download-progress",
                    Progress {
                        percent: Some(percent),
                        line: line.clone(),
                    },
                );
            }
            collected.push_str(&line);
            collected.push('\n');
        }
        collected
    });

    // Main thread: stream stdout for progress.
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let _ = app.emit(
            "download-progress",
            Progress {
                percent: parse_percent(&line),
                line,
            },
        );
    }

    // Reap the child (unless cancel_download already took and killed it).
    let status = {
        let taken = child_slot.lock().unwrap().take();
        match taken {
            Some(mut ch) => {
                if cancel.load(Ordering::SeqCst) {
                    let _ = ch.kill();
                }
                ch.wait().map_err(|e| format!("wait: {e}"))?
            }
            None => {
                // cancel_download already killed and removed it.
                let _ = std::fs::remove_dir_all(&out_dir);
                return Err("cancelled".into());
            }
        }
    };

    let stderr_text = stderr_thread.join().unwrap_or_default();

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_dir_all(&out_dir);
        return Err("cancelled".into());
    }

    if !status.success() {
        let _ = std::fs::remove_dir_all(&out_dir);
        let detail = stderr_text
            .lines()
            .rev()
            .find(|l| l.contains("ERROR"))
            .map(|l| l.trim().to_string())
            .unwrap_or_else(|| "yt-dlp could not download that URL.".to_string());
        return Err(detail);
    }

    // Exactly one file should sit in out_dir; return it as the local source.
    let produced = std::fs::read_dir(&out_dir)
        .map_err(|e| format!("read temp: {e}"))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.is_file());

    produced
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Download finished but produced no file.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_download_percent() {
        assert_eq!(parse_percent("[download]  12.3% of ~10.00MiB"), Some(12.3));
        assert_eq!(parse_percent("[download] 100% of 5MiB"), Some(100.0));
        assert_eq!(parse_percent("[download]   0.0% of 1KiB"), Some(0.0));
        assert_eq!(parse_percent("no percent here"), None);
    }
}
